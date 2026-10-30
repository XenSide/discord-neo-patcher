#!/usr/bin/env node
'use strict';
/*
 * Builds com.xenside.discordneo.sdPlugin from your own copy of Elgato's Discord
 * plugin plus this repo's template. Elgato's files are copied, never edited.
 * The manifest Version is taken from ESDDiscord.exe so it follows the official build.
 *
 *   node build.js [officialPluginDir] [outDir] [--app path\to\app.json]
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const OFFICIAL_INSTALLED = path.join(process.env.APPDATA || '', 'Elgato', 'StreamDeck', 'Plugins', 'com.elgato.discord.sdPlugin');
const DEFAULT_OUT = path.join(__dirname, 'dist', 'com.xenside.discordneo.sdPlugin');
const TEMPLATE = path.join(__dirname, 'template');

// File version of a Windows exe ("2.4.0.123"), or '' if it can't be read.
function exeVersion(exe) {
	try {
		return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.FileVersion`], { encoding: 'utf8' }).trim();
	} catch { return ''; }
}

function build(official, out, appJson) {
	if (!fs.existsSync(path.join(official, 'ESDDiscord.exe'))) {
		throw new Error('ESDDiscord.exe not found in ' + official + '. Install the official Discord plugin from the Marketplace first.');
	}
	fs.rmSync(out, { recursive: true, force: true });
	// The official manifest is encrypted and integrity-checked; ours replaces it.
	fs.cpSync(official, out, { recursive: true, filter: (src) => path.relative(official, src) !== 'manifest.json' });
	fs.cpSync(TEMPLATE, out, { recursive: true });

	const appTarget = path.join(out, 'bin', 'app.json');
	if (appJson) fs.copyFileSync(appJson, appTarget);
	else if (!fs.existsSync(appTarget)) fs.writeFileSync(appTarget, '{"clientId": "", "clientSecret": ""}\n');

	execSync('npm install --omit=dev --no-audit --no-fund', { cwd: path.join(out, 'bin'), stdio: 'inherit' });

	const manifestPath = path.join(out, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	manifest.Version = exeVersion(path.join(official, 'ESDDiscord.exe')) || manifest.Version;
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
	return manifest.Version;
}

module.exports = { build, exeVersion, OFFICIAL_INSTALLED, DEFAULT_OUT, TEMPLATE };

if (require.main === module) {
	const argv = process.argv.slice(2);
	const appIdx = argv.indexOf('--app');
	const appJson = appIdx >= 0 ? argv.splice(appIdx, 2)[1] : null;
	const out = argv[1] || DEFAULT_OUT;
	try {
		const version = build(argv[0] || OFFICIAL_INSTALLED, out, appJson);
		console.log('Built ' + out + ' (official ' + version + ')');
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
}
