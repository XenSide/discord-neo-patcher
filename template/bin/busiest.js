'use strict';
/*
 * Discord NEO - "busiest channel" + live speaker action (Node, CommonJS), driven by launcher.js.
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
const zlib = require('zlib');
const { execFileSync } = require('child_process');

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
// Ranks voice channels by people in them, not counting yourself in your current channel.
async function rankChannels(c, guildId, currentId) {
	const { channels } = await c.request('GET_CHANNELS', { guild_id: guildId });
	const voice = (channels || []).filter((ch) => ch.type === VOICE);
	const full = await Promise.all(voice.map((ch) => c.request('GET_CHANNEL', { channel_id: ch.id }).catch(() => null)));
	return full.filter(Boolean)
		.map((ch) => ({ id: ch.id, name: ch.name, states: ch.voice_states || [], count: (ch.voice_states || []).length - (ch.id === currentId ? 1 : 0) }))
		.sort((a, b) => b.count - a.count);
}

async function joinBusiest(settings) {
	const c = await discord();
	const current = await c.request('GET_SELECTED_VOICE_CHANNEL').catch(() => null);
	const guildId = settings.guildId || (current && current.guild_id) || globalSettings.lastGuildId;
	if (!guildId) throw new Error('Pick a server in the key settings, or join a call once');
	const currentId = current && current.guild_id === guildId ? current.id : null;
	const ranked = await rankChannels(c, guildId, currentId);
	const here = ranked.find((ch) => ch.id === currentId);
	const candidates = ranked.filter((ch) => ch.id !== currentId && ch.count > 0 && (!here || ch.count > here.count));
	if (!candidates.length) return here ? { stayed: here } : null;
	// The busiest channel can be full or locked; fall back to the next ones.
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
const avatarCache = new Map();   // url -> dataURI (or null while fetching)

// Elgato's own artwork, read from the official plugin files this plugin is built from.
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

/* Stream Deck's renderer ignores clip-path, so the exe cuts avatars round in the pixels
   (FUN_14005b750) before embedding them. Same here: minimal PNG decode -> alpha circle -> encode. */
const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

// 8-bit, non-interlaced PNG -> RGBA pixels; null for anything else (caller keeps the original).
function pngToRgba(buf) {
	if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
	let w, h, type, depth, interlace, pal, trns;
	const idat = [];
	for (let o = 8; o + 8 <= buf.length;) {
		const len = buf.readUInt32BE(o), kind = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
		if (kind === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
		else if (kind === 'PLTE') pal = d;
		else if (kind === 'tRNS') trns = d;
		else if (kind === 'IDAT') idat.push(d);
		o += 12 + len;
	}
	const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
	if (depth !== 8 || interlace || !ch || (type === 3 && !pal)) return null;
	const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, px = Buffer.alloc(stride * h);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= ch ? px[row + x - ch] : 0, b = y ? px[up + x] : 0, c = x >= ch && y ? px[up + x - ch] : 0;
			let v = raw[src + x];
			if (f === 1) v += a;
			else if (f === 2) v += b;
			else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
			px[row + x] = v & 255;
		}
	}
	const out = Buffer.alloc(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const s = i * ch, o = i * 4;
		if (type === 6) px.copy(out, o, s, s + 4);
		else if (type === 2) { out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; out[o + 3] = 255; }
		else if (type === 3) { const k = px[s]; out[o] = pal[k * 3]; out[o + 1] = pal[k * 3 + 1]; out[o + 2] = pal[k * 3 + 2]; out[o + 3] = trns && k < trns.length ? trns[k] : 255; }
		else { out[o] = out[o + 1] = out[o + 2] = px[s]; out[o + 3] = type === 4 ? px[s + 1] : 255; }
	}
	return { w, h, px: out };
}

function rgbaToPng({ w, h, px }) {
	// "Sub" row filter + fast deflate: ~0.5 ms for a key image, about the size resvg's own encoder gives.
	const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
	for (let y = 0; y < h; y++) {
		const o = y * (stride + 1), r = y * stride;
		raw[o] = 1;
		for (let x = 0; x < stride; x++) raw[o + 1 + x] = px[r + x] - (x >= 4 ? px[r + x - 4] : 0);
	}
	const chunk = (kind, d) => {
		const b = Buffer.alloc(12 + d.length);
		b.writeUInt32BE(d.length, 0); b.write(kind, 4, 'ascii'); d.copy(b, 8);
		b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length);
		return b;
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

function roundPng(buf) {
	const img = pngToRgba(buf);
	if (!img) return buf;
	const { w, h, px } = img, r = Math.min(w, h) / 2;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const k = Math.max(0, Math.min(1, r - Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) + 0.5)); // anti-aliased edge
		const i = (y * w + x) * 4 + 3;
		px[i] = Math.round(px[i] * k);
	}
	return rgbaToPng(img);
}

async function avatar(url) {
	if (avatarCache.has(url)) return avatarCache.get(url);
	avatarCache.set(url, null);
	try {
		const r = await fetch(url);
		const b = roundPng(Buffer.from(await r.arrayBuffer()));
		const uri = 'data:image/png;base64,' + b.toString('base64');
		avatarCache.set(url, uri);
		return uri;
	} catch { avatarCache.delete(url); return null; }
}

function orderedMembers() {
	return [...members.values()].sort((a, b) =>
		(Number(b.speaking) - Number(a.speaking)) || (b.lastSpoke - a.lastSpoke) || a.name.localeCompare(b.name));
}

const num = (n) => String(Math.round(n * 1000) / 1000);

// One user in slot i of an n-avatar layout, as layers bottom to top: round avatar, speaking ring,
// mute/deafen badges. Each layer is [cache key, () => svg markup, x, y].
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
		+ `<text x="36" y="24" style="font-size:24px;font-weight:bold;line-height:1;font-family:${fontName()};text-anchor:start;text-align:center;fill:#FFFFFF;fill-opacity:1;stroke:none">${n}</text>`
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

// The key's own glyph (neo/key.svg), drawn on Elgato's tile when there is nobody to show.
const GLYPH = '<g style="fill:#FFFFFF" transform="translate(30 30) scale(3.5 3.5)">'
	+ '<circle cx="5.6" cy="9" r="2.3"/><path d="M1 18.1c0-2.55 1.95-4.6 4.6-4.6.9 0 1.72.26 2.42.72-1.12 1.13-1.82 2.64-1.82 4.32v.46H1z"/>'
	+ '<circle cx="18.4" cy="9" r="2.3"/><path d="M23 18.1c0-2.55-1.95-4.6-4.6-4.6-.9 0-1.72.26-2.42.72 1.12 1.13 1.82 2.64 1.82 4.32v.46H23z"/>'
	+ '<circle cx="12" cy="7.2" r="3.1"/><path d="M5.1 19c0-3.72 3.03-6.3 6.9-6.3s6.9 2.58 6.9 6.3v.5H5.1z"/></g>';

// list: members to draw (first is on top); total: count for the pill; joined: false dims the key
// like the exe does for a channel you're not in (black at 50% over everything).
async function buildVoiceKey(list, total, joined) {
	const shown = list.slice(0, 3);
	const uris = await Promise.all(shown.map((m) => avatar(m.avatarUrl)));
	const layers = [['background', () => ART.background]];
	if (shown.length) {
		for (let i = shown.length - 1; i >= 0; i--) layers.push(...userLayers(shown[i], uris[i], shown.length, i));
		layers.push([`pill ${total}`, () => pillSvg(total, ART.usersTalking)]);
	} else {
		layers.push(['glyph', () => GLYPH]);
	}
	if (joined && quality >= 0 && quality <= 1) layers.push([`bars ${quality}`, () => barsSvg(quality)]); // only warn on a bad (red) connection
	if (!joined && shown.length) layers.push(['dim', () => '<rect x="0" y="0" width="144" height="144" style="fill:#000000;fill-opacity:.5;stroke:none"/>']);
	return composite(layers);
}

/* Key images go out as PNGs: Stream Deck rasterizing an SVG with embedded avatars holds back the
   deck's next key event (180-615 ms measured on the Volume Controller fork). Each layer is drawn by
   resvg once and cached as pixels, so a redraw (someone starts or stops talking) only stacks cached
   layers and encodes the PNG: ~0.5 ms instead of ~4 ms for a full resvg render. */
let Resvg = null;
try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) { log('resvg unavailable, sending SVG:', e.message); }
const fontName = () => (host && host.font) || 'Segoe UI';
let fontFiles = null;

// Font files of one family, from the Windows font registry (machine and per-user installs).
function fontFilesFor(family) {
	if (fontFiles) return fontFiles;
	const files = [];
	for (const hive of ['HKLM', 'HKCU']) {
		let out = '';
		try {
			out = execFileSync('reg', ['query', hive + '\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'],
				{ encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
		} catch {}
		for (const line of out.split(/\r?\n/)) {
			const m = /^\s+(.+?)\s+REG_SZ\s+(.+?)\s*$/.exec(line);
			const name = m ? m[1].replace(/\s*\((TrueType|OpenType)\)$/i, '') : '';
			// "Segoe UI Bold" is the family, "Segoe UI Emoji" is another family that only shares the prefix.
			if (name.toLowerCase().startsWith(family.toLowerCase())
				&& /^(\s+(bold|italic|light|semibold|semilight|black|regular|thin|medium|oblique))*$/i.test(name.slice(family.length))) {
				files.push(path.isAbsolute(m[2]) ? m[2] : path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', m[2]));
			}
		}
	}
	return (fontFiles = files.filter((f) => fs.existsSync(f)));
}

const svgDoc = (body) => `<svg width="144px" height="144px" viewBox="0 0 144 144" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
const layerCache = new Map(); // key -> { x, y, w, h, px }: premultiplied RGBA cropped to the pixels it covers

function layerPixels(key, markup) {
	let l = layerCache.get(key);
	if (l) { layerCache.delete(key); layerCache.set(key, l); return l; } // keep recently used ones last
	const svg = svgDoc(markup());
	// Loading fonts costs ~1.5 ms, so only layers with text (the pill) get them.
	const files = svg.includes('<text') ? fontFilesFor(fontName()) : null;
	const font = !files ? { loadSystemFonts: false } : files.length ? { loadSystemFonts: false, fontFiles: files, defaultFontFamily: fontName() } : { loadSystemFonts: true };
	const full = new Resvg(svg, { font }).render().pixels;
	let x0 = 144, y0 = 144, x1 = -1, y1 = -1;
	for (let p = 0; p < 144 * 144; p++) {
		if (!full[p * 4 + 3]) continue;
		const x = p % 144, y = (p / 144) | 0;
		if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
	}
	const w = Math.max(0, x1 - x0 + 1), h = Math.max(0, y1 - y0 + 1), px = Buffer.alloc(w * h * 4);
	for (let r = 0; r < h; r++) full.copy(px, r * w * 4, ((y0 + r) * 144 + x0) * 4, ((y0 + r) * 144 + x0 + w) * 4);
	l = { x: x0, y: y0, w, h, px };
	layerCache.set(key, l);
	if (layerCache.size > 150) layerCache.delete(layerCache.keys().next().value); // under 9 MB even if all were avatars
	return l;
}

function composite(layers) {
	if (Resvg) {
		try {
			const out = Buffer.alloc(144 * 144 * 4);
			for (const [key, markup, dx = 0, dy = 0] of layers) {
				const l = layerPixels(key, markup), { w, h, px } = l, x = l.x + dx, y = l.y + dy;
				// A slot's box can reach past the key's edge; clip so it doesn't wrap into the next row.
				for (let r = 0; r < Math.min(h, 144 - y); r++) {
					for (let c = 0, s = r * w * 4, d = ((y + r) * 144 + x) * 4; c < Math.min(w, 144 - x); c++, s += 4, d += 4) {
						const a = px[s + 3];
						if (!a) continue;
						const k = 255 - a; // premultiplied "over"
						for (let j = 0; j < 4; j++) out[d + j] = px[s + j] + ((out[d + j] * k + 127) / 255 | 0);
					}
				}
			}
			for (let d = 0; d < out.length; d += 4) { // PNG wants straight alpha
				const a = out[d + 3];
				if (a && a < 255) for (let j = 0; j < 3; j++) out[d + j] = Math.min(255, Math.round(out[d + j] * 255 / a));
			}
			return 'data:image/png;base64,' + rgbaToPng({ w: 144, h: 144, px: out }).toString('base64');
		} catch (e) { log('PNG render failed, sending SVG:', e.message); }
	}
	return 'data:image/svg+xml;base64,' + Buffer.from(svgDoc(layers.map(([, markup, dx = 0, dy = 0]) => `<g transform="translate(${dx} ${dy})">${markup()}</g>`).join(''))).toString('base64');
}

let renderTimer = null;
function renderLive() {
	clearTimeout(renderTimer);
	renderTimer = setTimeout(() => renderNow().catch((e) => log('renderLive', e.message)), 60);
}

async function renderNow() {
	if (contexts.size === 0) return;
	if (liveChannelId && members.size) {
		const img = await buildVoiceKey(orderedMembers(), members.size, true);
		for (const ctx of contexts.keys()) setImage(ctx, img);
		return;
	}
	// Not in a call: each key previews the busiest channel of its server, dimmed.
	const images = new Map();
	for (const [ctx, settings] of contexts) {
		const guild = guildFor(settings);
		const p = preview.get(guild);
		const id = p ? guild : '';
		if (!images.has(id)) images.set(id, await (p ? buildVoiceKey(p.list, p.total, false) : buildVoiceKey([], 0, true)));
		setImage(ctx, images.get(id));
	}
}

/* ------------------------------------------- Busiest-channel preview */
// RPC has no server-wide voice event (subscriptions are per channel), so while you're not in a
// call the busiest channel is polled with the same ranking the key press uses.
const preview = new Map();       // guildId -> { list, total } of its busiest channel, or null if all empty
const guildFor = (settings) => settings.guildId || globalSettings.lastGuildId || '';
let previewBusy = false;

async function refreshPreview() {
	if (previewBusy || liveChannelId || !isCurrent(ipc) || contexts.size === 0) return;
	previewBusy = true;
	try {
		for (const guild of new Set([...contexts.values()].map(guildFor).filter(Boolean))) {
			const ranked = await rankChannels(ipc, guild, null).catch(() => null);
			if (!ranked) continue;
			const top = ranked[0];
			preview.set(guild, top && top.count > 0 ? { list: top.states.filter((vs) => vs.user).map((vs) => toMember(vs)), total: top.count } : null);
		}
	} finally { previewBusy = false; }
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
	if (!channelId) { refreshPreview(); return; }
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
// Runs inside launcher.js, which owns the Stream Deck socket and routes our actions here.
const ACTIONS = new Set(['com.xenside.discordneo.busiest']);
let host = null; // { send, saveGlobal, font }
let globalSettings = {};
const contexts = new Map(); // context -> settings

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
		// Joining needs no confirmation: the key switches to the live view of the new call by itself.
		const res = await joinBusiest(contexts.get(ctx) || {});
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
			contexts.set(context, settings);
			shownImage.delete(context); // a reappearing key has lost its image
			renderLive();
			refreshPreview();
			break;
		case 'didReceiveSettings':
			contexts.set(context, settings);
			refreshPreview(); // the server may have changed
			break;
		case 'willDisappear':
			contexts.delete(context);
			shownImage.delete(context);
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
	setInterval(ensureLive, 15000); // reconnect the live view if Discord/IPC drops
	setInterval(refreshPreview, 20000);
}

module.exports = { ACTIONS, init, onEvent, log };
