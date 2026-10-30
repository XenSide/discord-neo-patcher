#!/usr/bin/env node
'use strict';
/*
 * Rebuilds and installs Discord NEO, e.g. after Elgato ships a new official Discord plugin:
 *   1. install (or update) the official Discord plugin from the Stream Deck Marketplace
 *   2. node install.js                 (or: node install.js <officialPluginDir> [--app app.json])
 *
 * It builds from a freshly installed official plugin if there is one, else from the newest
 * saved copy in backup-*\com.elgato.discord.sdPlugin. Your Discord app credentials are carried
 * over from the installed NEO. The current NEO is saved to backup-<time>\, Stream Deck is
 * restarted, and the official plugin is moved out of the Plugins folder into
 * backup-official-<version>\ so it doesn't run next to NEO (and can be rebuilt from later).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { build, exeVersion, OFFICIAL_INSTALLED, DEFAULT_OUT, TEMPLATE } = require('./build');

const PLUGINS = path.dirname(OFFICIAL_INSTALLED);
const NEO = path.join(PLUGINS, 'com.xenside.discordneo.sdPlugin');
const OFFICIAL_NAME = path.basename(OFFICIAL_INSTALLED);
const STREAMDECK_DEFAULT = 'C:\\Program Files\\Elgato\\StreamDeck\\StreamDeck.exe';

const step = (s) => console.log('\n> ' + s);
const fail = (s) => { console.error('\nERROR: ' + s); process.exit(1); };
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const cmpVer = (a, b) => {
	const x = a.split('.').map(Number), y = b.split('.').map(Number);
	for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
	return 0;
};

function pickOfficial(explicit) {
	if (explicit) return explicit;
	if (fs.existsSync(path.join(OFFICIAL_INSTALLED, 'ESDDiscord.exe'))) return OFFICIAL_INSTALLED;
	const saved = fs.readdirSync(__dirname)
		.filter((d) => d.startsWith('backup-'))
		.map((d) => path.join(__dirname, d, OFFICIAL_NAME))
		.filter((d) => fs.existsSync(path.join(d, 'ESDDiscord.exe')))
		.map((d) => ({ d, v: exeVersion(path.join(d, 'ESDDiscord.exe')) }))
		.sort((a, b) => cmpVer(b.v, a.v));
	if (!saved.length) fail('No official Discord plugin found. Install it from the Stream Deck Marketplace, then run this again.');
	return saved[0].d;
}

// Our manifest is hand-written; make sure it still fits this official build.
function checkCompat(official) {
	const manifest = JSON.parse(fs.readFileSync(path.join(TEMPLATE, 'manifest.json'), 'utf8'));
	const ours = new Set(manifest.Actions.map((a) => a.UUID).filter((u) => u.startsWith('com.elgato.')));
	const theirs = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(official, 'en.json'), 'utf8'))).filter((k) => k.startsWith('com.elgato.')));
	const added = [...theirs].filter((u) => !ours.has(u));
	const removed = [...ours].filter((u) => !theirs.has(u));
	if (added.length) console.log('  WARNING: new official action(s) missing from template/manifest.json (add them to use them): ' + added.join(', '));
	if (removed.length) console.log('  WARNING: action(s) the official plugin no longer lists: ' + removed.join(', '));
	const exists = (p) => ['.svg', '.png', ''].some((e) => fs.existsSync(path.join(official, p + e)) || fs.existsSync(path.join(TEMPLATE, p + e)));
	const images = manifest.Actions.flatMap((a) => [a.Icon, ...(a.States || []).map((s) => s.Image)])
		.concat(manifest.Icon, manifest.CategoryIcon).filter(Boolean);
	const missing = [...new Set(images)].filter((p) => !exists(p));
	if (missing.length) fail('the official plugin no longer has these images our manifest uses, so those keys would go blank:\n  '
		+ missing.join('\n  ') + '\nUpdate template/manifest.json first. Nothing was changed.');
	if (!added.length && !removed.length) console.log('  manifest matches the official action list');
}

// Discord app credentials: --app, else the installed NEO, else the last build. Never stored in the repo.
function credentials(explicit) {
	const has = (f) => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return !!(j.clientId && (j.secretDpapi || j.clientSecret)); } catch { return false; } };
	const src = [explicit, path.join(NEO, 'bin', 'app.json'), path.join(DEFAULT_OUT, 'bin', 'app.json')].find((f) => f && has(f));
	if (!src) { console.log('  WARNING: no Discord app credentials found; the Join Busiest key will ask for them'); return null; }
	const tmp = path.join(os.tmpdir(), 'discordneo-app-' + process.pid + '.json');
	fs.copyFileSync(src, tmp);
	console.log('  credentials from ' + src);
	return tmp;
}

function stopStreamDeck() {
	ps('try { Stop-Process -Name StreamDeck -Force -ErrorAction Stop } catch {}');
	// Plugin processes normally exit with Stream Deck; make sure nothing keeps the plugin files locked.
	// Only the plugins' own processes: anything else that merely mentions the path (a shell, an editor) is left alone.
	ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ESDDiscord.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'Plugins\\\\com\\.(xenside\\.discordneo|elgato\\.discord)\\.sdPlugin') } | "
		+ 'ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }');
}

async function replaceDir(from, to) {
	for (let i = 0; ; i++) {
		try { fs.rmSync(to, { recursive: true, force: true }); break; }
		catch (e) { if (i >= 10) throw e; await sleep(500); } // files can stay locked for a moment after their process exits
	}
	fs.cpSync(from, to, { recursive: true });
}

async function waitForRegistration(since) {
	const logFile = path.join(NEO, 'bin', 'plugin.log');
	for (let i = 0; i < 60; i++) {
		await sleep(1000);
		let lines = [];
		try { lines = fs.readFileSync(logFile, 'utf8').split('\n'); } catch {}
		if (lines.some((l) => l.includes('Registered with Stream Deck') && Date.parse(l.slice(0, 24)) >= since)) return true;
	}
	return false;
}

(async () => {
	const argv = process.argv.slice(2);
	const appIdx = argv.indexOf('--app');
	const appArg = appIdx >= 0 ? argv.splice(appIdx, 2)[1] : null;

	step('Finding the official Discord plugin');
	const official = pickOfficial(argv[0]);
	const version = exeVersion(path.join(official, 'ESDDiscord.exe'));
	console.log('  ' + official + ' (' + (version || 'unknown version') + ')');

	step('Checking it against template/manifest.json');
	checkCompat(official);

	step('Building Discord NEO');
	const app = credentials(appArg);
	try { build(official, DEFAULT_OUT, app); } finally { if (app) fs.rmSync(app, { force: true }); }

	step('Stopping Stream Deck and installing');
	const streamDeck = ps('(Get-Process StreamDeck -ErrorAction SilentlyContinue | Select-Object -First 1).Path') || STREAMDECK_DEFAULT;
	stopStreamDeck();
	const backup = path.join(__dirname, 'backup-' + stamp());
	if (fs.existsSync(NEO)) {
		fs.cpSync(NEO, path.join(backup, path.basename(NEO)), { recursive: true });
		console.log('  previous NEO saved to ' + backup);
	}
	await replaceDir(DEFAULT_OUT, NEO);
	if (official === OFFICIAL_INSTALLED) {
		const keep = path.join(__dirname, 'backup-official-' + (version || stamp()), OFFICIAL_NAME);
		if (!fs.existsSync(keep)) fs.cpSync(OFFICIAL_INSTALLED, keep, { recursive: true });
		fs.rmSync(OFFICIAL_INSTALLED, { recursive: true, force: true });
		console.log('  official plugin moved out of Plugins to ' + path.dirname(keep));
	}

	step('Starting Stream Deck');
	const started = Date.now();
	spawn(streamDeck, [], { detached: true, stdio: 'ignore' }).unref();
	if (await waitForRegistration(started - 1000)) console.log('\nDone: Discord NEO ' + version + ' is installed and running.');
	else fail('Stream Deck started but Discord NEO did not register within 60 s. See ' + path.join(NEO, 'bin', 'plugin.log')
		+ '. The previous version is saved in ' + backup + '.');
})().catch((e) => fail(e.stack || e.message));
