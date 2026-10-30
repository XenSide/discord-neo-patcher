'use strict';
/*
 * Discord Busiest - "busiest channel" + live speaker action (Node, CommonJS), driven by plugin.js.
 *
 * On key press it connects to the local Discord client over its IPC pipe,
 * counts the voice_states of every voice channel in the chosen server and
 * joins the busiest one. RPC voice control is restricted by Discord to the
 * owner/testers of an application, so every user creates their own app (see
 * README). Its client id + secret go in the key's Property Inspector, or in
 * bin/app.json where the secret is stored DPAPI-encrypted (secret.js).
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const render = require('./render');
const { avatar, composite } = render;

// Stream Deck doesn't persist stdout for this plugin, so also keep a small log next to the code.
const LOG_FILE = path.join(__dirname, 'plugin.log');
try { if (fs.statSync(LOG_FILE).size > 1e6) fs.unlinkSync(LOG_FILE); } catch {}
const log = (...a) => {
	const line = [new Date().toISOString(), ...a].join(' ');
	try { console.log(line); } catch {}
	try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
};
process.on('uncaughtException', (e) => log('uncaught', e && e.stack || e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.stack || e));

const REDIRECT_URI = 'http://localhost';
const SCOPES = ['rpc', 'identify'];
const VOICE = 2; // channel type GUILD_VOICE

// Optional local credentials, so the PI fields aren't needed; never part of the repo.
let APP = {};
try { APP = require('./secret').loadApp(path.join(__dirname, 'app.json')); } catch (e) { log('app.json', e.message); }
const bundled = !!(APP.clientId && APP.clientSecret);
const appCreds = () => bundled ? APP : { clientId: globalSettings.clientId, clientSecret: globalSettings.clientSecret };

/* ------------------------------------------------------------ Discord IPC */
// Frame: int32le opcode, int32le length, JSON. 0 handshake, 1 frame, 2 close, 3 ping, 4 pong.
class DiscordIpc {
	constructor(clientId) {
		this.clientId = clientId;
		this.sock = null;
		this.buf = Buffer.alloc(0);
		this.pending = new Map();
		this.closed = false;
	}

	static async open(clientId) {
		for (let i = 0; i < 10; i++) {
			const ipc = new DiscordIpc(clientId);
			try { await ipc.connect('\\\\?\\pipe\\discord-ipc-' + i); return ipc; }
			catch (e) { ipc.close(); if (e.fatal) throw e; }
		}
		throw new Error('Discord is not running');
	}

	connect(path) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { const e = new Error('handshake timeout'); reject(e); }, 5000);
			this.onReady = () => { clearTimeout(timer); resolve(); };
			this.onFatal = (msg) => { clearTimeout(timer); const e = new Error(msg); e.fatal = true; reject(e); };
			this.sock = net.createConnection(path, () => this.write(0, { v: 1, client_id: this.clientId }));
			this.sock.on('data', (d) => this.onData(d));
			this.sock.on('error', (e) => { clearTimeout(timer); reject(e); this.close(); });
			this.sock.on('close', () => this.close());
		});
	}

	write(op, obj) {
		const json = Buffer.from(JSON.stringify(obj));
		const head = Buffer.alloc(8);
		head.writeInt32LE(op, 0);
		head.writeInt32LE(json.length, 4);
		this.sock.write(Buffer.concat([head, json]));
	}

	onData(d) {
		this.buf = Buffer.concat([this.buf, d]);
		while (this.buf.length >= 8) {
			const op = this.buf.readInt32LE(0), len = this.buf.readInt32LE(4);
			if (this.buf.length < 8 + len) break;
			let msg; try { msg = JSON.parse(this.buf.subarray(8, 8 + len).toString()); } catch { msg = {}; }
			this.buf = this.buf.subarray(8 + len);
			if (op === 3) { this.write(4, msg); continue; }
			if (op === 2) { if (this.onFatal) this.onFatal(msg.message || 'Discord closed the connection'); this.close(); return; }
			if (msg.evt === 'READY' && this.onReady) { this.onReady(); this.onReady = null; continue; }
			const p = msg.nonce && this.pending.get(msg.nonce);
			if (!p) { if (msg.cmd === 'DISPATCH' && this.onDispatch) this.onDispatch(msg.evt, msg.data); continue; }
			this.pending.delete(msg.nonce);
			if (msg.evt === 'ERROR') p.reject(new Error((msg.data && msg.data.message) || 'RPC error'));
			else p.resolve(msg.data);
		}
	}

	request(cmd, args, timeoutMs = 5000) {
		return this.send({ cmd, args: args || {} }, timeoutMs);
	}

	// SUBSCRIBE/UNSUBSCRIBE carry `evt` at the frame top level, args separately.
	subscribe(cmd, evt, args, timeoutMs = 5000) {
		return this.send({ cmd, evt, args: args || {} }, timeoutMs);
	}

	send(frame, timeoutMs = 5000) {
		return new Promise((resolve, reject) => {
			if (this.closed) return reject(new Error('Discord connection closed'));
			const nonce = Math.random().toString(36).slice(2) + Date.now();
			const timer = setTimeout(() => { this.pending.delete(nonce); reject(new Error(frame.cmd + ' timeout')); }, timeoutMs);
			this.pending.set(nonce, {
				resolve: (v) => { clearTimeout(timer); resolve(v); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});
			this.write(1, { ...frame, nonce });
		});
	}

	close() {
		if (this.closed) return;
		this.closed = true;
		try { this.sock && this.sock.destroy(); } catch {}
		for (const p of this.pending.values()) p.reject(new Error('Discord connection closed'));
		this.pending.clear();
	}
}

/* ----------------------------------------------------------------- OAuth2 */
async function tokenRequest(gs, params) {
	const body = new URLSearchParams({ client_id: gs.clientId, client_secret: gs.clientSecret, ...params });
	const r = await fetch('https://discord.com/api/oauth2/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
	});
	const j = await r.json().catch(() => ({}));
	if (!r.ok || !j.access_token) throw new Error('token exchange failed: ' + (j.error_description || j.error || r.status));
	return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 0) * 1000 };
}

let ipc = null;
let connecting = null;

// Every user brings their own Discord app: Discord only grants rpc scopes to an app's owner and testers.
const ownApp = () => { const a = appCreds(); return !!(a.clientId && a.clientSecret); };
const isCurrent = (c) => c && !c.closed && c.clientId === appCreds().clientId;

// Returns an authenticated IPC connection, running the Discord consent prompt once if needed.
function discord() {
	if (isCurrent(ipc)) return Promise.resolve(ipc);
	if (!ownApp()) return Promise.reject(new Error('Set your Discord app Client ID and Secret in the key settings'));
	if (!connecting) connecting = connectAndAuth().finally(() => { connecting = null; });
	return connecting;
}

async function connectAndAuth() {
	const gs = { ...globalSettings, ...appCreds() };
	if (ipc) ipc.close();
	const c = await DiscordIpc.open(gs.clientId);
	try {
		let tokens = gs.accessToken ? { accessToken: gs.accessToken, refreshToken: gs.refreshToken, expiresAt: gs.expiresAt || 0 } : null;
		if (tokens && tokens.expiresAt < Date.now() + 60000 && tokens.refreshToken) {
			tokens = await tokenRequest(gs, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }).catch(() => null);
		}
		let authed = false;
		if (tokens) authed = await c.request('AUTHENTICATE', { access_token: tokens.accessToken }).then(() => true, () => false);
		if (!authed) {
			// Discord shows an "Authorize" popup; give the user time to click it.
			const { code } = await c.request('AUTHORIZE', { client_id: gs.clientId, scopes: SCOPES }, 120000);
			tokens = await tokenRequest(gs, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
			await c.request('AUTHENTICATE', { access_token: tokens.accessToken });
		}
		if (tokens.accessToken !== gs.accessToken) saveGlobalSettings({ ...globalSettings, ...tokens });
		c.onDispatch = liveOnDispatch;
		ipc = c;
		liveStart(c);
		return c;
	} catch (e) {
		c.close();
		throw e;
	}
}

/* ---------------------------------------------------------------- Busiest */
// The server's voice channels that have people in them, busiest first: { id, name, list (members), total }.
async function rankChannels(c, guildId) {
	const { channels } = await c.request('GET_CHANNELS', { guild_id: guildId });
	const voice = (channels || []).filter((ch) => ch.type === VOICE);
	const full = await Promise.all(voice.map((ch) => c.request('GET_CHANNEL', { channel_id: ch.id }).catch(() => null)));
	return full.filter((ch) => ch && (ch.voice_states || []).length)
		.map((ch) => ({ id: ch.id, name: ch.name, list: ch.voice_states.filter((vs) => vs.user).map((vs) => toMember(vs)), total: ch.voice_states.length }))
		.sort((a, b) => b.total - a.total);
}

async function joinFor(ctx) {
	const c = await discord();
	const current = await c.request('GET_SELECTED_VOICE_CHANNEL').catch(() => null);
	const inCall = !!(current && current.id), i = slotOf(ctx), guildId = guildFor(contexts.get(ctx).settings);
	// The first key, and any key sharing your call with it, hangs up (channel_id null leaves voice).
	if (inCall && (i === 0 || spanOf(ctx))) {
		await c.request('SELECT_VOICE_CHANNEL', { channel_id: null }, 10000);
		return { left: current };
	}
	if (!guildId) throw new Error('Pick a server in the key settings, or join a call once');
	// Ranked fresh: the keys' picture can be 20 s old, and a channel that emptied since mustn't be joined.
	const ranked = await rankChannels(c, guildId);
	preview.set(guildId, ranked);
	renderLive();
	const others = ranked.filter((ch) => !inCall || ch.id !== current.id);
	const candidates = others.slice(inCall ? i - 1 : i);
	if (!candidates.length) return null;
	// It can be full or locked; fall back to the less busy ones after it.
	for (const ch of candidates) {
		try {
			await c.request('SELECT_VOICE_CHANNEL', { channel_id: ch.id, force: true }, 10000);
			return { joined: ch };
		} catch (e) { log('join failed', ch.name, e.message); }
	}
	throw new Error('Could not join any busier channel');
}

/* ----------------------------------------------- Live voice-channel key */
// Draws the key the way ESDDiscord.exe draws its own Voice Channel key (layout
// FUN_14004d6e0, per-user FUN_140053890, pill FUN_140057320): up to three round
// avatars over the blurple tile, a usersTalking count pill and connection bars.
// Uses rpc subscriptions (no polling); re-subscribes on channel change.
let liveChannelId = null;
let speakSeq = 0;                // monotonic "last spoke" order
let quality = -1;                // connection bars 0..3, -1 hides them
const members = new Map();       // user_id -> { name, avatarUrl, lastSpoke, speaking, mutedByUs, mutedByThem, deafened }

// Elgato's own artwork, copied from your official Discord plugin by install-busiest.js.
const IMAGES = path.join(__dirname, '..', 'images');
// Stream Deck's renderer drops nested <svg> elements, so keep only each file's inner markup.
const asset = (f) => {
	try { return fs.readFileSync(path.join(IMAGES, f), 'utf8').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim(); }
	catch { return ''; }
};
const ART = {
	background: asset('backgroundInactive.svg'),
	usersTalking: asset('badges/usersTalking.svg'),
	deafened: asset('badges/deafened.svg'),
	mutedByUs: asset('badges/mutedByUs.svg'),
	mutedByThem: asset('badges/mutedByThem.svg'),
};

function toMember(vs, prev) {
	const u = vs.user;
	const s = vs.voice_state || {};
	const url = u.avatar
		? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
		: `https://cdn.discordapp.com/embed/avatars/${(Number(BigInt(u.id) >> 22n) % 6)}.png`;
	return {
		name: vs.nick || u.global_name || u.username || '',
		avatarUrl: url,
		lastSpoke: prev ? prev.lastSpoke : 0,
		speaking: prev ? prev.speaking : false,
		mutedByUs: !!vs.mute,
		mutedByThem: !!(s.mute || s.self_mute),
		deafened: !!(s.deaf || s.self_deaf),
	};
}

function memberFromState(vs) {
	if (!vs || !vs.user) return;
	members.set(vs.user.id, toMember(vs, members.get(vs.user.id)));
}

function orderedMembers() {
	return [...members.values()].sort((a, b) =>
		(Number(b.speaking) - Number(a.speaking)) || (b.lastSpoke - a.lastSpoke) || a.name.localeCompare(b.name));
}

const num = (n) => String(Math.round(n * 1000) / 1000);

// One user in slot i of an n-avatar layout, as layers bottom to top: round avatar, speaking ring,
// mute/deafen badges. Each layer is [cache key, () => svg markup, x, y, root <svg> tag (default ours)].
function userLayers(m, uri, n, i) {
	// Drawn once per size (and sub-pixel offset), then placed at the slot's whole-pixel position,
	// so someone moving to another slot as the speaking order changes reuses the same pixels.
	const L = LAYOUT[n], dx = Math.floor(L.x[i]), dy = Math.floor(L.y), fx = num(L.x[i] - dx), fy = num(L.y - dy);
	const slot = `${n} ${fx} ${fy}`;
	const at = (s) => () => `<g transform="translate(${fx} ${fy}) scale(${L.s} ${L.s})">${s()}</g>`;
	const layer = (key, s) => [key, at(s), dx, dy];
	const layers = [layer(`avatar ${slot} ${uri ? m.avatarUrl : '-'}`, () => uri
		? `<clipPath id="u${i}"><circle cx="72" cy="72" r="72"/></clipPath>`
			+ `<image x="0" y="0" width="144" height="144" preserveAspectRatio="none" clip-path="url(#u${i})" xlink:href="${uri}"/>`
		: '<circle cx="72" cy="72" r="72" style="fill:#4e5058"/>')];
	if (m.speaking) {
		layers.push(layer(`ring ${slot}`, () => '<circle cx="72" cy="72" r="64" style="fill:none;stroke-width:8;stroke:#111111;stroke-opacity:1"/>'
			+ '<circle cx="72" cy="72" r="68" style="fill:none;stroke-width:8;stroke:#24a459;stroke-opacity:1"/>'));
	}
	if (m.deafened) layers.push(layer(`deafened ${slot}`, () => `<g transform="translate(106 106) scale(1.2 1.2)">${ART.deafened}</g>`));
	if (m.mutedByUs || m.mutedByThem) {
		const x = m.deafened ? 64 : 106, art = m.mutedByUs ? 'mutedByUs' : 'mutedByThem';
		layers.push(layer(`${art} ${slot} ${x}`, () => `<g transform="translate(${x} 106) scale(1.2 1.2)">${ART[art]}</g>`));
	}
	return layers;
}

// Gray count pill, icon on the left, pinned 13px from the top-right corner.
function pillSvg(n, icon) {
	const w = n < 10 ? 64 : n < 100 ? 67.6 : 82;
	return `<g transform="translate(${num(144 - w - 13)} 13)"><g>`
		+ `<rect x="0" y="0" width="${w}" height="32" rx="16" style="fill:#4d4f5b;fill-opacity:1;stroke:none"/>`
		// No textLength (the exe sets w - 35): renderers that honour it stretch "12" into "1 2".
		+ `<text x="36" y="24" style="font-size:24px;font-weight:bold;line-height:1;font-family:${render.fontName()};text-anchor:start;text-align:center;fill:#FFFFFF;fill-opacity:1;stroke:none">${n}</text>`
		+ `</g><g transform="translate(4 0)">${icon}</g></g>`;
}

// Three bottom-right bars: lit ones filled, the rest outlined, coloured by level.
function barsSvg(q) {
	const c = q === 3 ? '#62c244' : q === 2 ? '#f9b50a' : '#FF0000';
	const bars = [15, 25, 35].map((h, i) => {
		const style = i < q ? `fill:${c};fill-opacity:1;stroke:none` : `fill:none;stroke-width:2;stroke:${c};stroke-opacity:1`;
		return `<rect x="${i * 15 + 86}" y="${131 - h}" width="10" height="${h}" rx="3" style="${style}"/>`;
	});
	return `<g>${bars.join('')}</g>`;
}

// Slot geometry per avatar count: scale, x of each slot, shared y. Slot 0 is drawn last (on top).
const LAYOUT = {
	1: { s: 0.833333, x: [12], y: 12 },
	2: { s: 0.6, x: [0, 57.6], y: 28.8 },
	3: { s: 0.5, x: [0, 36, 72], y: 36 },
};

// The key's own glyph (ui/key.svg), drawn on Elgato's tile when there is nobody to show.
const GLYPH = '<g style="fill:#FFFFFF" transform="translate(30 30) scale(3.5 3.5)">'
	+ '<circle cx="5.6" cy="9" r="2.3"/><path d="M1 18.1c0-2.55 1.95-4.6 4.6-4.6.9 0 1.72.26 2.42.72-1.12 1.13-1.82 2.64-1.82 4.32v.46H1z"/>'
	+ '<circle cx="18.4" cy="9" r="2.3"/><path d="M23 18.1c0-2.55-1.95-4.6-4.6-4.6-.9 0-1.72.26-2.42.72 1.12 1.13 1.82 2.64 1.82 4.32v.46H23z"/>'
	+ '<circle cx="12" cy="7.2" r="3.1"/><path d="M5.1 19c0-3.72 3.03-6.3 6.9-6.3s6.9 2.58 6.9 6.3v.5H5.1z"/></g>';

// list: members to draw (first is on top); total: count for the pill; joined: false dims the key
// like the exe does for a channel you're not in (black at 50% over everything); first: false for
// the 2nd/3rd key of a joined row, which leave the count and connection warning to the first.
async function buildVoiceKey(list, total, joined, first = true) {
	const shown = list.slice(0, 3);
	const uris = await Promise.all(shown.map((m) => avatar(m.avatarUrl)));
	const layers = [['background', () => ART.background]];
	if (shown.length) {
		for (let i = shown.length - 1; i >= 0; i--) layers.push(...userLayers(shown[i], uris[i], shown.length, i));
		if (first) layers.push([`pill ${total}`, () => pillSvg(total, ART.usersTalking)]);
	} else {
		layers.push(['glyph', () => GLYPH]);
	}
	if (joined && first && quality >= 0 && quality <= 1) layers.push([`bars ${quality}`, () => barsSvg(quality)]); // only warn on a bad (red) connection
	if (!joined && shown.length) layers.push(['dim', () => '<rect x="0" y="0" width="144" height="144" style="fill:#000000;fill-opacity:.5;stroke:none"/>']);
	return composite(layers);
}

let renderTimer = null;
function renderLive() {
	clearTimeout(renderTimer);
	renderTimer = setTimeout(() => renderNow().catch((e) => log('renderLive', e.message)), 60);
}

async function renderNow() {
	const images = new Map(); // one picture per distinct view
	for (const ctx of contexts.keys()) {
		const v = viewOf(ctx);
		const id = v === 'live' ? (members.size ? 'live' : '') : v && v.tile !== undefined ? 'live ' + v.tile + '/' + v.tiles : v ? v.id : '';
		if (!images.has(id)) {
			images.set(id, await (id === 'live' ? buildVoiceKey(orderedMembers(), members.size, true)
				: v && v.tile !== undefined ? buildVoiceKey(tileMembers(v.tile, v.tiles), members.size, true, v.tile === 0)
					: id ? buildVoiceKey(v.list, v.total, false) // a channel you're not in, dimmed
						: buildVoiceKey([], 0, true)));
		}
		setImage(ctx, images.get(id));
	}
}

/* -------------------------------------------------- ranked keys */
// Keys for the same server on the same deck rank in reading order. Not in a call, they show the
// busiest, 2nd, 3rd... busiest channel. In a call, the first shows your call live (and leaves on
// tap) and the others the busiest channels you're not in. A single key is just the first one.
function slotOf(ctx) {
	const k = contexts.get(ctx), guild = guildFor(k.settings);
	return [...contexts].filter(([, o]) => o.device === k.device && guildFor(o.settings) === guild)
		.sort(([, a], [, b]) => a.row - b.row || a.col - b.col)
		.findIndex(([c]) => c === ctx);
}

// 'live' (your call), { tile, tiles } (part of your call spread over a row), a ranked channel,
// or null when there is nothing to show at this rank.
function viewOf(ctx) {
	const span = spanOf(ctx);
	if (span) return span;
	const i = slotOf(ctx), ranked = preview.get(guildFor(contexts.get(ctx).settings)) || [];
	if (!liveChannelId) return ranked[i] || null;
	if (i === 0) return 'live';
	return ranked.filter((ch) => ch.id !== liveChannelId)[i - 1] || null;
}

// In a call with nobody in the server's other channels, the first key and up to two keys right
// after it in the same row have nothing else to show, so they share your call: { tile, tiles }.
// One key per person at most, so no key of the row is left empty.
function spanOf(ctx) {
	if (!liveChannelId || members.size < 2) return null;
	const k = contexts.get(ctx), guild = guildFor(k.settings);
	if (!preview.has(guild) || preview.get(guild).some((ch) => ch.id !== liveChannelId)) return null;
	const group = [...contexts].filter(([, o]) => o.device === k.device && guildFor(o.settings) === guild)
		.sort(([, a], [, b]) => a.row - b.row || a.col - b.col);
	const [, head] = group[0];
	const row = [group[0][0]];
	for (const [c, o] of group.slice(1)) {
		if (row.length >= Math.min(3, members.size)) break;
		if (o.row === head.row && o.col === head.col + row.length) row.push(c);
	}
	const tile = row.indexOf(ctx);
	return row.length > 1 && tile >= 0 ? { tile, tiles: row.length } : null;
}

// The people on one tile of a joined row: split in speaking order, up to 3 per key, e.g. 7 on 3 keys -> 3/2/2.
function tileMembers(tile, tiles) {
	const list = orderedMembers(), shown = Math.min(list.length, 3 * tiles);
	const size = (t) => Math.floor(shown / tiles) + (t < shown % tiles ? 1 : 0);
	let start = 0;
	for (let t = 0; t < tile; t++) start += size(t);
	return list.slice(start, start + size(tile));
}

// RPC has no server-wide voice event (subscriptions are per channel), so the ranking is polled.
// It isn't needed while you're in a call with only first keys showing.
const preview = new Map();       // guildId -> rankChannels() result
const guildFor = (settings) => settings.guildId || globalSettings.lastGuildId || '';
let previewBusy = null;  // the refresh in progress
let previewAgain = null; // one follow-up shared by every request made during it

// A request during a refresh runs once more after it, so a key's new server isn't left for the next poll.
async function refreshPreview() {
	if (previewBusy) return (previewAgain = previewAgain || previewBusy.then(() => { previewAgain = null; return refreshPreview(); }));
	if (!isCurrent(ipc) || contexts.size === 0) return;
	if (liveChannelId && ![...contexts.keys()].some((c) => slotOf(c) > 0)) return;
	previewBusy = (async () => {
		for (const guild of new Set([...contexts.values()].map((o) => guildFor(o.settings)).filter(Boolean))) {
			const ranked = await rankChannels(ipc, guild).catch(() => null);
			if (ranked) preview.set(guild, ranked);
		}
	})().finally(() => { previewBusy = null; });
	await previewBusy;
	renderLive();
}

async function liveSetupChannel(c, channelId) {
	if (channelId === liveChannelId) return;
	const sub = (evt, args) => c.subscribe('SUBSCRIBE', evt, args).catch(() => {});
	const unsub = (evt, args) => c.subscribe('UNSUBSCRIBE', evt, args).catch(() => {});
	const ev = ['SPEAKING_START', 'SPEAKING_STOP', 'VOICE_STATE_CREATE', 'VOICE_STATE_UPDATE', 'VOICE_STATE_DELETE'];
	if (liveChannelId) for (const e of ev) unsub(e, { channel_id: liveChannelId });
	liveChannelId = channelId;
	members.clear(); speakSeq = 0;
	if (!channelId) quality = -1;
	renderLive();
	refreshPreview(); // the other keys rank the channels you're not in
	if (!channelId) return;
	const ch = await c.request('GET_CHANNEL', { channel_id: channelId }).catch(() => null);
	// Remember the server of your last call: the preview and the key press fall back to it.
	if (ch && ch.guild_id && ch.guild_id !== globalSettings.lastGuildId) saveGlobalSettings({ ...globalSettings, lastGuildId: ch.guild_id });
	for (const vs of (ch && ch.voice_states) || []) memberFromState(vs);
	renderLive();
	for (const e of ev) sub(e, { channel_id: channelId });
}

function liveOnDispatch(evt, data) {
	if (evt === 'VOICE_CHANNEL_SELECT') { if (ipc) liveSetupChannel(ipc, data && data.channel_id); return; }
	if (evt === 'SPEAKING_START') { const m = data && members.get(data.user_id); if (m) { m.speaking = true; m.lastSpoke = ++speakSeq; renderLive(); } return; }
	if (evt === 'SPEAKING_STOP') { const m = data && members.get(data.user_id); if (m) { m.speaking = false; renderLive(); } return; }
	if (evt === 'VOICE_STATE_CREATE' || evt === 'VOICE_STATE_UPDATE') { memberFromState(data); renderLive(); return; }
	if (evt === 'VOICE_STATE_DELETE') { if (data && data.user) members.delete(data.user.id); renderLive(); return; }
	if (evt === 'VOICE_CONNECTION_STATUS') {
		// shortcut: the exe's ping->bars mapping sits behind an untraced handler; these are Discord's good/ok/bad ping bands. Trace the VOICE_CONNECTION_STATUS (event 11) handler to match exactly.
		const p = data && data.average_ping;
		const q = data && data.state === 'VOICE_CONNECTED' && typeof p === 'number' ? (p < 100 ? 3 : p < 250 ? 2 : 1) : -1;
		if (q !== quality) { quality = q; renderLive(); }
	}
}

// Subscribe to channel changes and sync to the channel we're in right now.
async function liveStart(c) {
	await c.subscribe('SUBSCRIBE', 'VOICE_CHANNEL_SELECT').catch(() => {});
	await c.subscribe('SUBSCRIBE', 'VOICE_CONNECTION_STATUS').catch(() => {});
	const cur = await c.request('GET_SELECTED_VOICE_CHANNEL').catch(() => null);
	liveChannelId = null;
	await liveSetupChannel(c, cur && cur.id);
}

// Keep a live connection alive when we already have tokens (no surprise popup).
function ensureLive() {
	const gs = globalSettings;
	if (isCurrent(ipc)) return;
	if (!ownApp() || !gs.accessToken) return; // wait for the user to authorize once via a press / Load servers
	discord().catch((e) => log('ensureLive', e.message));
}

/* ------------------------------------------------------------- Stream Deck */
// plugin.js owns the Stream Deck socket and hands every event to onEvent.
let host = null; // { send, saveGlobal, font }
let globalSettings = {};
const contexts = new Map(); // context -> { settings, device, row, col }
// Keys inside a multi-action have no position; they rank after the ones on the deck.
const keyOf = (ev, settings) => { const c = ev.payload && ev.payload.coordinates; return { settings, device: ev.device, row: c ? c.row : 99, col: c ? c.column : 99 }; };

function sdSend(o) { try { host.send(o); } catch (e) { log('sdSend', e.message); } }
const setTitle = (ctx, title) => sdSend({ event: 'setTitle', context: ctx, payload: { title: String(title), target: 0 } });
// Stream Deck rasterizes every image it is sent, so only send one when the picture changed.
const shownImage = new Map(); // context -> last image sent
const setImage = (ctx, image) => {
	if (shownImage.get(ctx) === (image || '')) return;
	shownImage.set(ctx, image || '');
	sdSend({ event: 'setImage', context: ctx, payload: { image: image || '', target: 0 } });
};
const showAlert = (ctx) => sdSend({ event: 'showAlert', context: ctx });
const toPI = (ctx, action, payload) => sdSend({ event: 'sendToPropertyInspector', context: ctx, action, payload });
const flashTitle = (ctx, title) => { setTitle(ctx, title); setTimeout(() => setTitle(ctx, ''), 3000); };

function saveGlobalSettings(gs) {
	globalSettings = gs;
	host.saveGlobal(gs);
}

let lastError = '';
async function press(ctx) {
	try {
		// Joining needs no confirmation: the keys switch to the new call by themselves.
		const res = await joinFor(ctx);
		lastError = '';
		if (!res) flashTitle(ctx, 'Empty');
	} catch (e) {
		lastError = e.message;
		log('press', e.message);
		showAlert(ctx);
	}
}

async function onPIMessage(ctx, action, msg) {
	if (msg.cmd === 'creds') {
		if (bundled) return;
		const changed = msg.clientId !== globalSettings.clientId || msg.clientSecret !== globalSettings.clientSecret;
		if (!changed) return;
		// New app means old tokens are useless.
		if (ipc) { ipc.close(); ipc = null; }
		saveGlobalSettings({ clientId: msg.clientId, clientSecret: msg.clientSecret });
	} else if (msg.cmd === 'guilds') {
		try {
			const c = await discord();
			const { guilds } = await c.request('GET_GUILDS');
			toPI(ctx, action, { guilds: (guilds || []).map((g) => ({ id: g.id, name: g.name })), status: 'Connected' });
		} catch (e) {
			toPI(ctx, action, { status: e.message });
		}
	} else if (msg.cmd === 'status') {
		toPI(ctx, action, { status: lastError, bundled, clientId: globalSettings.clientId || '', hasSecret: !!globalSettings.clientSecret });
	}
}

function onEvent(ev) {
	const { event, context, action } = ev;
	const settings = (ev.payload && ev.payload.settings) || {};
	switch (event) {
		case 'didReceiveGlobalSettings':
			globalSettings = settings;
			ensureLive();
			break;
		case 'willAppear':
			contexts.set(context, keyOf(ev, settings));
			shownImage.delete(context); // a reappearing key has lost its image
			renderLive();
			refreshPreview();
			break;
		case 'didReceiveSettings':
			contexts.set(context, keyOf(ev, settings));
			renderLive(); // the server may have changed, and with it every key's rank
			refreshPreview();
			break;
		case 'willDisappear':
			contexts.delete(context);
			shownImage.delete(context);
			renderLive(); // the keys after it move up a rank
			break;
		case 'keyDown':
			press(context);
			break;
		case 'sendToPlugin':
			onPIMessage(context, action, ev.payload || {});
			break;
		default:
			break;
	}
}

function init(h) {
	host = h;
	render.init({ log, font: h.font });
	setInterval(ensureLive, 15000); // reconnect the live view if Discord/IPC drops
	setInterval(refreshPreview, 20000);
}

module.exports = { init, onEvent, log };
