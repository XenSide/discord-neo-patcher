#!/usr/bin/env node
'use strict';
/*
 * Builds and installs Discord Busiest, the Join Busiest Channel key, as its own plugin
 * (com.xenside.discordbusiest). It works with the official Discord plugin or with Discord NEO.
 *   node install-busiest.js [--app path\to\app.json]
 *
 * It needs a few of Elgato's images and the settings-page CSS, copied from your official Discord
 * plugin (or NEO, or a saved copy in backup-*\). Your Discord app credentials are carried over
 * from the last install. Keys made with the older all-in-one NEO ("com.xenside.discordneo.busiest")
 * are moved to this plugin; every profile file changed is saved to backup-<time>\profiles\ first.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');
const { step, fail } = lib;

const PLUGIN = 'com.xenside.discordbusiest';
const ACTION = 'com.xenside.discordbusiest.join';
const OLD_ACTION = 'com.xenside.discordneo.busiest';
const INSTALLED = path.join(lib.PLUGINS, PLUGIN + '.sdPlugin');
const NEO = path.join(lib.PLUGINS, 'com.xenside.discordneo.sdPlugin');
const OUT = path.join(lib.REPO, 'dist', PLUGIN + '.sdPlugin');
const PROFILES = path.join(path.dirname(lib.PLUGINS), 'ProfilesV3');

// Newest first: backup-<time>\<name> folders saved by earlier installs.
const backups = (name) => fs.readdirSync(lib.REPO).filter((d) => d.startsWith('backup-')).sort().reverse().map((d) => path.join(lib.REPO, d, name));

function assetSource() {
	const all = [lib.OFFICIAL_INSTALLED, NEO, ...backups(lib.OFFICIAL_NAME), ...backups(path.basename(NEO))];
	const src = all.find((d) => lib.BUSIEST_ASSETS.every((f) => fs.existsSync(path.join(d, f))));
	if (!src) fail('No official Discord plugin found to copy its images from. Install it from the Stream Deck Marketplace, then run this again.');
	return src;
}

// Discord app credentials: --app, else this plugin's, else the old NEO's. Never stored in the repo.
function credentials(explicit) {
	const has = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return !!(j.clientId && (j.secretDpapi || j.clientSecret)); } catch { return false; } };
	const app = (dir) => path.join(dir, 'bin', 'app.json');
	const src = [explicit, app(INSTALLED), app(NEO), ...backups(path.basename(INSTALLED)).map(app), ...backups(path.basename(NEO)).map(app)].find((f) => f && has(f));
	if (!src) { console.log('  no Discord app credentials found; the key will ask for them in its settings'); return null; }
	const tmp = path.join(os.tmpdir(), 'discordbusiest-app-' + process.pid + '.json');
	fs.copyFileSync(src, tmp);
	console.log('  credentials from ' + src);
	return tmp;
}

function profileFiles(dir) {
	let out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out = out.concat(profileFiles(p));
		else if (e.name === 'manifest.json') out.push(p);
	}
	return out;
}

// Points keys of the old all-in-one NEO's busiest action at this plugin. Stream Deck must be stopped.
function migrateKeys(version, backup) {
	if (!fs.existsSync(PROFILES)) return 0;
	let moved = 0;
	for (const file of profileFiles(PROFILES)) {
		const text = fs.readFileSync(file, 'utf8');
		if (!text.includes('"' + OLD_ACTION + '"')) continue;
		const json = JSON.parse(text);
		const walk = (o) => {
			if (!o || typeof o !== 'object') return;
			if (o.UUID === OLD_ACTION) {
				o.UUID = ACTION;
				o.Plugin = { Name: 'Discord Busiest', UUID: PLUGIN, Version: version };
				moved++;
			}
			for (const k in o) walk(o[k]);
		};
		walk(json);
		const saved = path.join(backup, 'profiles', path.relative(PROFILES, file));
		fs.mkdirSync(path.dirname(saved), { recursive: true });
		fs.copyFileSync(file, saved);
		fs.writeFileSync(file, JSON.stringify(json));
	}
	return moved;
}

(async () => {
	const argv = process.argv.slice(2);
	const appIdx = argv.indexOf('--app');
	const appArg = appIdx >= 0 ? argv[appIdx + 1] : null;

	step('Building Discord Busiest');
	const assets = assetSource();
	console.log('  Elgato images from ' + assets);
	const app = credentials(appArg);
	let version;
	try { version = lib.buildBusiest(assets, OUT, app); } finally { if (app) fs.rmSync(app, { force: true }); }

	step('Stopping Stream Deck and installing');
	const streamDeck = lib.runningStreamDeck();
	lib.stopStreamDeck();
	const backup = path.join(lib.REPO, 'backup-' + lib.stamp());
	if (fs.existsSync(INSTALLED)) {
		fs.cpSync(INSTALLED, path.join(backup, path.basename(INSTALLED)), { recursive: true });
		console.log('  previous version saved to ' + backup);
	}
	await lib.replaceDir(OUT, INSTALLED);
	const moved = migrateKeys(version, backup);
	if (moved) console.log('  ' + moved + ' key(s) moved from the old all-in-one NEO to this plugin; the old profile files are in ' + path.join(backup, 'profiles'));

	step('Starting Stream Deck');
	const started = Date.now();
	lib.startStreamDeck(streamDeck);
	if (await lib.waitForRegistration(path.join(INSTALLED, 'bin', 'plugin.log'), started - 1000)) console.log('\nDone: Discord Busiest ' + version + ' is installed and running.');
	else fail('Stream Deck started but Discord Busiest did not register within 60 s. See ' + path.join(INSTALLED, 'bin', 'plugin.log') + '.');
})().catch((e) => fail(e.stack || e.message));
