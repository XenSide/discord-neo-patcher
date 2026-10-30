#!/usr/bin/env node
'use strict';
/*
 * Builds and installs Discord NEO: Elgato's Discord plugin with its in-call Voice Channel key
 * sent to Stream Deck as small PNGs. Run it again after Elgato ships a new official plugin:
 *   1. install (or update) the official Discord plugin from the Stream Deck Marketplace
 *   2. node patch-official.js            (or: node patch-official.js <officialPluginDir>)
 *
 * Marketplace plugins are integrity-checked, so the official plugin can't be edited in place.
 * NEO is a copy under its own ID (com.xenside.discordneo) with a patched ESDDiscord.exe. It builds
 * from a freshly installed official plugin if there is one, else from the newest saved copy in
 * backup-*\com.elgato.discord.sdPlugin. The current NEO is saved to backup-<time>\, and the
 * official plugin is moved out of the Plugins folder into backup-official-<version>\ so it
 * doesn't run next to NEO (and can be rebuilt from later).
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const { step, fail } = lib;

const NEO = path.join(lib.PLUGINS, 'com.xenside.discordneo.sdPlugin');
const OUT = path.join(lib.REPO, 'dist', 'com.xenside.discordneo.sdPlugin');
const MANIFEST = path.join(lib.REPO, 'official', 'manifest.json');

// Our manifest is hand-written; make sure it still fits this official build.
function checkCompat(official) {
	const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
	const ours = new Set(manifest.Actions.map((a) => a.UUID));
	const theirs = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(official, 'en.json'), 'utf8'))).filter((k) => k.startsWith('com.elgato.')));
	const added = [...theirs].filter((u) => !ours.has(u));
	const removed = [...ours].filter((u) => !theirs.has(u));
	if (added.length) console.log('  WARNING: new official action(s) missing from official/manifest.json (add them to use them): ' + added.join(', '));
	if (removed.length) console.log('  WARNING: action(s) the official plugin no longer lists: ' + removed.join(', '));
	const exists = (p) => ['.svg', '.png', ''].some((e) => fs.existsSync(path.join(official, p + e)));
	const images = manifest.Actions.flatMap((a) => [a.Icon, ...(a.States || []).map((s) => s.Image)])
		.concat(manifest.Icon, manifest.CategoryIcon).filter(Boolean);
	const missing = [...new Set(images)].filter((p) => !exists(p));
	if (missing.length) fail('the official plugin no longer has these images our manifest uses, so those keys would go blank:\n  '
		+ missing.join('\n  ') + '\nUpdate official/manifest.json first. Nothing was changed.');
	if (!added.length && !removed.length) console.log('  manifest matches the official action list');
}

(async () => {
	step('Finding the official Discord plugin');
	const official = lib.pickOfficial(process.argv[2]);
	const version = lib.exeVersion(path.join(official, 'ESDDiscord.exe'));
	console.log('  ' + official + ' (' + (version || 'unknown version') + ')');

	step('Checking it against official/manifest.json');
	checkCompat(official);

	step('Building Discord NEO');
	const { patched } = lib.buildOfficial(official, OUT);
	console.log(patched
		? '  ESDDiscord.exe patched: the Voice Channel key now carries avatar URLs, not embedded images'
		: '  WARNING: this ESDDiscord.exe build is not the one the patch was made for, so it was left unpatched.\n'
			+ '  The launcher still converts its key images to PNG, but Elgato\'s exe keeps embedding avatars.');

	step('Stopping Stream Deck and installing');
	const streamDeck = lib.runningStreamDeck();
	lib.stopStreamDeck();
	const backup = path.join(lib.REPO, 'backup-' + lib.stamp());
	if (fs.existsSync(NEO)) {
		fs.cpSync(NEO, path.join(backup, path.basename(NEO)), { recursive: true });
		console.log('  previous NEO saved to ' + backup);
	}
	await lib.replaceDir(OUT, NEO);
	if (official === lib.OFFICIAL_INSTALLED) {
		const keep = path.join(lib.REPO, 'backup-official-' + (version || lib.stamp()), lib.OFFICIAL_NAME);
		if (!fs.existsSync(keep)) fs.cpSync(lib.OFFICIAL_INSTALLED, keep, { recursive: true });
		fs.rmSync(lib.OFFICIAL_INSTALLED, { recursive: true, force: true });
		console.log('  official plugin moved out of Plugins to ' + path.dirname(keep));
	}

	step('Starting Stream Deck');
	const started = Date.now();
	lib.startStreamDeck(streamDeck);
	if (await lib.waitForRegistration(path.join(NEO, 'bin', 'plugin.log'), started - 1000)) console.log('\nDone: Discord NEO ' + version + ' is installed and running.');
	else fail('Stream Deck started but Discord NEO did not register within 60 s. See ' + path.join(NEO, 'bin', 'plugin.log')
		+ '. The previous version is saved in ' + backup + '.');
})().catch((e) => fail(e.stack || e.message));
