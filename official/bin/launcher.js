'use strict';
/*
 * Discord NEO launcher. Stream Deck starts this instead of Elgato's ESDDiscord.exe.
 * It runs the exe against a local websocket that looks like Stream Deck and relays
 * everything both ways, except the exe's SVG key images, which go out as PNGs.
 *
 * During a call the exe sends its Voice Channel key as an SVG on every speaking change,
 * and Stream Deck spends 10-16 ms of CPU rasterizing each one against ~5 ms for a PNG
 * (measured 2026-10-30). patch-official.js patches the exe to put avatar URLs in that SVG
 * instead of embedding each avatar (which also spares the exe its download/WebP work), and
 * render.exeImage turns it into a PNG from cached layers here. Vector-only SVGs (volume
 * sliders) cost Stream Deck about as much as a PNG and pass through.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const render = require('./render');

const ROOT = path.join(__dirname, '..');

// Stream Deck doesn't persist stdout for this plugin, so also keep a small log next to the code.
const LOG_FILE = path.join(__dirname, 'plugin.log');
try { if (fs.statSync(LOG_FILE).size > 1e6) fs.unlinkSync(LOG_FILE); } catch {}
const log = (...a) => {
	const line = [new Date().toISOString(), ...a].join(' ');
	try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
};
process.on('uncaughtException', (e) => log('uncaught', e && e.stack || e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.stack || e));

function parseArgs(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '-port') o.port = argv[++i];
		else if (argv[i] === '-pluginUUID') o.uuid = argv[++i];
		else if (argv[i] === '-registerEvent') o.registerEvent = argv[++i];
		else if (argv[i] === '-info') o.info = argv[++i];
	}
	return o;
}

const args = parseArgs(process.argv);
if (!args.port) { log('No -port argument; not launched by Stream Deck. Exiting.'); process.exit(1); }
render.init({ log, font: (() => { try { return JSON.parse(args.info).application.font || ''; } catch { return ''; } })() });

let sd = null;          // real Stream Deck
let exe = null;         // ESDDiscord.exe's socket to our fake server
let exeProc = null;
const toSd = [];        // queued until Stream Deck is open
const toExe = [];       // queued until the exe has connected

function sendSd(s) {
	if (sd && sd.readyState === WebSocket.OPEN) sd.send(s); else toSd.push(s);
}
function sendExe(s) {
	if (exe && exe.readyState === WebSocket.OPEN) exe.send(s); else toExe.push(s);
}

/* ------------------------------------------------------------ exe images */
const pngCache = new Map(); // exe image -> PNG data URI, or null to send it unchanged
const imageSeq = new Map(); // context -> number of its latest setImage, so a slow conversion can't overwrite a newer image

async function smallImage(img) {
	if (pngCache.has(img)) return pngCache.get(img);
	let png = null, complete = true;
	try {
		const comma = img.indexOf(',');
		const svg = img.slice(0, comma).endsWith(';base64') ? Buffer.from(img.slice(comma + 1), 'base64').toString() : decodeURIComponent(img.slice(comma + 1));
		const r = svg.includes('<image') ? await render.exeImage(svg) : null;
		if (r) ({ image: png, complete } = r);
	} catch (e) { log('exe image to PNG failed, sending SVG:', e.message); }
	if (complete) {
		pngCache.set(img, png);
		if (pngCache.size > 32) pngCache.delete(pngCache.keys().next().value); // speaking changes cycle through a few pictures
	}
	return png;
}

function forwardImage(raw, m) {
	const img = m.payload && m.payload.image;
	const seq = (imageSeq.get(m.context) || 0) + 1;
	imageSeq.set(m.context, seq);
	if (typeof img !== 'string' || !img.startsWith('data:image/svg+xml')) { sendSd(raw); return; }
	smallImage(img).then((png) => {
		if (imageSeq.get(m.context) !== seq) return; // a newer image was sent meanwhile
		sendSd(png ? JSON.stringify({ ...m, payload: { ...m.payload, image: png } }) : raw);
	});
}

/* ------------------------------------------------------------ relay */
function fromExe(raw) {
	let m; try { m = JSON.parse(raw); } catch { sendSd(raw); return; }
	if (m.event === args.registerEvent) return; // we already registered
	if (m.event === 'setImage') { forwardImage(raw, m); return; }
	sendSd(raw);
}

const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 }, startExe);
server.on('connection', (ws) => {
	if (exe) exe.terminate();
	exe = ws;
	ws.on('message', (d) => fromExe(d.toString()));
	ws.on('close', () => { if (exe === ws) exe = null; });
	while (toExe.length) ws.send(toExe.shift());
});

function startExe() {
	const port = String(server.address().port);
	const a = ['-port', port, '-pluginUUID', args.uuid, '-registerEvent', args.registerEvent, '-info', args.info];
	exeProc = spawn(path.join(ROOT, 'ESDDiscord.exe'), a, { cwd: ROOT, windowsHide: true, stdio: 'ignore' });
	exeProc.on('exit', (code) => {
		log('ESDDiscord.exe exited', code);
		exeProc = null;
		if (sd && sd.readyState === WebSocket.OPEN) setTimeout(startExe, 2000); // keep the keys alive
	});
}

function sdConnect() {
	sd = new WebSocket('ws://127.0.0.1:' + args.port);
	sd.on('open', () => {
		sd.send(JSON.stringify({ event: args.registerEvent, uuid: args.uuid }));
		while (toSd.length) sd.send(toSd.shift());
		log('Registered with Stream Deck');
	});
	sd.on('message', (d) => sendExe(d.toString()));
	sd.on('close', () => {
		log('Stream Deck socket closed; exiting');
		try { exeProc && exeProc.kill(); } catch {}
		process.exit(0);
	});
	sd.on('error', (e) => log('Stream Deck socket error', e && e.message));
}

sdConnect();
