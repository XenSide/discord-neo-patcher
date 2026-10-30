'use strict';
/*
 * Discord NEO launcher. Stream Deck starts this instead of Elgato's ESDDiscord.exe.
 * It runs the unmodified exe against a local websocket that looks like Stream Deck,
 * relays everything both ways, and handles our own actions (busiest.js) itself.
 *
 * Global settings are shared by every action of one plugin, so ours live under
 * the OWN_KEY sub-object: the exe never sees it, and it is merged back whenever
 * the exe rewrites its own settings.
 */

const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const busiest = require('./busiest');

const OWN_KEY = 'xensideNeo';
const ROOT = path.join(__dirname, '..');

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
const log = busiest.log;
if (!args.port) { log('No -port argument; not launched by Stream Deck. Exiting.'); process.exit(1); }

let sd = null;          // real Stream Deck
let exe = null;         // ESDDiscord.exe's socket to our fake server
let exeProc = null;
const toSd = [];        // queued until Stream Deck is open
const toExe = [];       // queued until the exe has connected
let exeGlobal = {};     // the exe's view of global settings
let ownGlobal = {};     // ours

function sendSd(o) {
	const s = JSON.stringify(o);
	if (sd && sd.readyState === WebSocket.OPEN) sd.send(s); else toSd.push(s);
}
function sendExe(o) {
	const s = JSON.stringify(o);
	if (exe && exe.readyState === WebSocket.OPEN) exe.send(s); else toExe.push(s);
}
function pushGlobal() {
	sendSd({ event: 'setGlobalSettings', context: args.uuid, payload: { ...exeGlobal, [OWN_KEY]: ownGlobal } });
}

/* ------------------------------------------------------------------ Stream Deck -> */
function fromSd(raw) {
	let m; try { m = JSON.parse(raw); } catch { return; }
	if (m.event === 'didReceiveGlobalSettings') {
		const all = (m.payload && m.payload.settings) || {};
		const { [OWN_KEY]: own, ...rest } = all;
		exeGlobal = rest;
		ownGlobal = own || {};
		sendExe({ ...m, payload: { ...m.payload, settings: exeGlobal } });
		busiest.onEvent({ ...m, payload: { ...m.payload, settings: ownGlobal } });
		return;
	}
	if (m.action && busiest.ACTIONS.has(m.action)) { busiest.onEvent(m); return; }
	if (!m.action) busiest.onEvent(m); // device / system / application events go to both
	sendExe(m);
}

/* ------------------------------------------------------------------ exe -> */
function fromExe(raw) {
	let m; try { m = JSON.parse(raw); } catch { sendSd(raw); return; }
	if (m.event === 'setGlobalSettings') { exeGlobal = m.payload || {}; pushGlobal(); return; }
	if (m.event === args.registerEvent) return; // we already registered
	sd && sd.readyState === WebSocket.OPEN ? sd.send(raw) : toSd.push(raw);
}

/* ------------------------------------------------------------------ wiring */
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
		if (sd && sd.readyState === WebSocket.OPEN) setTimeout(startExe, 2000); // keep the official actions alive
	});
}

function sdConnect() {
	sd = new WebSocket('ws://127.0.0.1:' + args.port);
	sd.on('open', () => {
		sd.send(JSON.stringify({ event: args.registerEvent, uuid: args.uuid }));
		sd.send(JSON.stringify({ event: 'getGlobalSettings', context: args.uuid }));
		while (toSd.length) sd.send(toSd.shift());
		log('Registered with Stream Deck');
	});
	sd.on('message', (d) => fromSd(d.toString()));
	sd.on('close', () => {
		log('Stream Deck socket closed; exiting');
		try { exeProc && exeProc.kill(); } catch {}
		process.exit(0);
	});
	sd.on('error', (e) => log('Stream Deck socket error', e && e.message));
}

busiest.init({
	send: sendSd,
	pluginUUID: args.uuid,
	saveGlobal: (gs) => { ownGlobal = gs; pushGlobal(); },
});
sdConnect();
