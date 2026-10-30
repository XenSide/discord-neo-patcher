'use strict';
/*
 * Discord Busiest: Stream Deck starts this. It owns the Stream Deck socket and hands every
 * event to busiest.js, which talks to Discord itself (no Elgato code involved).
 */

const WebSocket = require('ws');
const busiest = require('./busiest');

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

const sd = new WebSocket('ws://127.0.0.1:' + args.port);
const send = (o) => { if (sd.readyState === WebSocket.OPEN) sd.send(JSON.stringify(o)); };

sd.on('open', () => {
	sd.send(JSON.stringify({ event: args.registerEvent, uuid: args.uuid }));
	sd.send(JSON.stringify({ event: 'getGlobalSettings', context: args.uuid }));
	log('Registered with Stream Deck');
});
sd.on('message', (d) => {
	let m; try { m = JSON.parse(d.toString()); } catch { return; }
	busiest.onEvent(m);
});
sd.on('close', () => { log('Stream Deck socket closed; exiting'); process.exit(0); });
sd.on('error', (e) => log('Stream Deck socket error', e && e.message));

busiest.init({
	send,
	saveGlobal: (gs) => send({ event: 'setGlobalSettings', context: args.uuid, payload: gs }),
	// Stream Deck's UI font, which the official keys use for their text.
	font: (() => { try { return JSON.parse(args.info).application.font || ''; } catch { return ''; } })(),
});
