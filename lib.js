'use strict';
/*
 * Shared by patch-official.js and install-busiest.js: finding your official Discord plugin,
 * building each plugin from it, patching ESDDiscord.exe, and restarting Stream Deck.
 * Elgato's files are copied from your own install, never stored in this repo.
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const REPO = __dirname;
const PLUGINS = path.join(process.env.APPDATA || '', 'Elgato', 'StreamDeck', 'Plugins');
const OFFICIAL_INSTALLED = path.join(PLUGINS, 'com.elgato.discord.sdPlugin');
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

// File version of a Windows exe ("2.4.0.123"), or '' if it can't be read.
function exeVersion(exe) {
	try {
		return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.FileVersion`], { encoding: 'utf8' }).trim();
	} catch { return ''; }
}

// The unmodified official plugin: the Marketplace install, else the newest copy saved in backup-*\.
function pickOfficial(explicit) {
	if (explicit) return explicit;
	if (fs.existsSync(path.join(OFFICIAL_INSTALLED, 'ESDDiscord.exe'))) return OFFICIAL_INSTALLED;
	const saved = fs.readdirSync(REPO)
		.filter((d) => d.startsWith('backup-'))
		.map((d) => path.join(REPO, d, OFFICIAL_NAME))
		.filter((d) => fs.existsSync(path.join(d, 'ESDDiscord.exe')))
		.map((d) => ({ d, v: exeVersion(path.join(d, 'ESDDiscord.exe')) }))
		.sort((a, b) => cmpVer(b.v, a.v));
	if (!saved.length) fail('No official Discord plugin found. Install it from the Stream Deck Marketplace, then run this again.');
	return saved[0].d;
}

const npmInstall = (dir) => execSync('npm install --omit=dev --no-audit --no-fund', { cwd: dir, stdio: 'inherit' });

/* ------------------------------------------------------------ exe patch */
/* ESDDiscord.exe 2.4.0.123: FUN_14005b150 downloads an avatar, rounds it and returns it as a WebP
   data URI to embed in the Voice Channel key's SVG. Its only caller is that key's per-user code.
   The patch makes it a tail jump to the std::string copy constructor (FUN_14000db80, same
   (dest, src) arguments, returns dest), so it returns the avatar URL itself and the SVG stays a
   few KB. The launcher swaps the URLs for cached avatars. Both are found by their exact bytes:
   another build of the exe won't match and is left unpatched. */
const AVATAR_FN = Buffer.from('48895c24185556574154415541564157488d6c24904881ec70010000488b058de214004833c44889', 'hex');
const STRING_COPY = Buffer.from('48895c2408488974241048897c241841564883ec2033c00f57c00f1101488941104c8bf248894118', 'hex');

function only(buf, sig) {
	const i = buf.indexOf(sig);
	return i >= 0 && buf.indexOf(sig, i + 1) < 0 ? i : -1;
}

// File offset range of the PE's .text section.
function textSection(buf) {
	const pe = buf.readUInt32LE(0x3c), count = buf.readUInt16LE(pe + 6), opt = buf.readUInt16LE(pe + 20);
	for (let i = 0; i < count; i++) {
		const o = pe + 24 + opt + i * 40;
		if (buf.toString('ascii', o, o + 8).replace(/\0+$/, '') === '.text') {
			const raw = buf.readUInt32LE(o + 20);
			return [raw, raw + buf.readUInt32LE(o + 16)];
		}
	}
	return [0, 0];
}

// Returns true if patched; false (and the exe untouched) if this build isn't the one the patch was made for.
function patchExe(file) {
	const buf = fs.readFileSync(file);
	const site = only(buf, AVATAR_FN), target = only(buf, STRING_COPY);
	const [lo, hi] = textSection(buf);
	// Inside one section, file offsets and addresses differ by the same constant, so the jump distance is the offset distance.
	if (site < lo || target < lo || site >= hi || target >= hi) return false;
	const jmp = Buffer.alloc(5);
	jmp[0] = 0xe9;
	jmp.writeInt32LE(target - (site + 5), 1);
	jmp.copy(buf, site);
	fs.writeFileSync(file, buf);
	return true;
}

/* ------------------------------------------------------------ builds */
// Discord NEO: the official plugin with our manifest, launcher and the patched exe.
function buildOfficial(official, out) {
	if (!fs.existsSync(path.join(official, 'ESDDiscord.exe'))) {
		throw new Error('ESDDiscord.exe not found in ' + official + '. Install the official Discord plugin from the Marketplace first.');
	}
	fs.rmSync(out, { recursive: true, force: true });
	// The official manifest is encrypted and integrity-checked; ours replaces it.
	fs.cpSync(official, out, { recursive: true, filter: (src) => path.relative(official, src) !== 'manifest.json' });
	fs.cpSync(path.join(REPO, 'official'), out, { recursive: true });
	fs.copyFileSync(path.join(REPO, 'common', 'render.js'), path.join(out, 'bin', 'render.js'));
	npmInstall(path.join(out, 'bin'));
	const version = exeVersion(path.join(official, 'ESDDiscord.exe'));
	const manifestPath = path.join(out, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	manifest.Version = version || manifest.Version;
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
	return { version: manifest.Version, patched: patchExe(path.join(out, 'ESDDiscord.exe')) };
}

// Elgato artwork and settings-page CSS the busiest key uses, taken from the official plugin.
const BUSIEST_ASSETS = ['images/backgroundInactive.svg', 'images/badges/usersTalking.svg', 'images/badges/deafened.svg',
	'images/badges/mutedByUs.svg', 'images/badges/mutedByThem.svg', 'images/category.svg', 'images/category.png',
	'images/category@2x.png', 'inspectors/css/sdpi.css', 'inspectors/css/stylesheet.css'];

// Discord Busiest: our own plugin, plus BUSIEST_ASSETS copied from any folder that has them.
function buildBusiest(assets, out, appJson) {
	const missing = BUSIEST_ASSETS.filter((f) => !fs.existsSync(path.join(assets, f)));
	if (missing.length) throw new Error(assets + ' is missing ' + missing.join(', '));
	fs.rmSync(out, { recursive: true, force: true });
	fs.cpSync(path.join(REPO, 'busiest'), out, { recursive: true });
	fs.copyFileSync(path.join(REPO, 'common', 'render.js'), path.join(out, 'bin', 'render.js'));
	for (const f of BUSIEST_ASSETS) {
		fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
		fs.copyFileSync(path.join(assets, f), path.join(out, f));
	}
	const appTarget = path.join(out, 'bin', 'app.json');
	if (appJson) fs.copyFileSync(appJson, appTarget);
	else fs.writeFileSync(appTarget, '{"clientId": "", "clientSecret": ""}\n');
	npmInstall(path.join(out, 'bin'));
	return JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).Version;
}

/* ------------------------------------------------------------ Stream Deck */
const runningStreamDeck = () => ps('(Get-Process StreamDeck -ErrorAction SilentlyContinue | Select-Object -First 1).Path') || STREAMDECK_DEFAULT;

function stopStreamDeck() {
	ps('try { Stop-Process -Name StreamDeck -Force -ErrorAction Stop } catch {}');
	// Plugin processes normally exit with Stream Deck; make sure nothing keeps the plugin files locked.
	// Only the plugins' own processes: anything else that merely mentions the path (a shell, an editor) is left alone.
	ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'ESDDiscord.exe' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'Plugins\\\\com\\.(xenside\\.discord(neo|busiest)|elgato\\.discord)\\.sdPlugin') } | "
		+ 'ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }');
}

function startStreamDeck(exe) {
	require('child_process').spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
}

async function replaceDir(from, to) {
	for (let i = 0; ; i++) {
		try { fs.rmSync(to, { recursive: true, force: true }); break; }
		catch (e) { if (i >= 10) throw e; await sleep(500); } // files can stay locked for a moment after their process exits
	}
	fs.cpSync(from, to, { recursive: true });
}

// Waits for a plugin's "Registered with Stream Deck" log line written after `since`.
async function waitForRegistration(logFile, since) {
	for (let i = 0; i < 60; i++) {
		await sleep(1000);
		let lines = [];
		try { lines = fs.readFileSync(logFile, 'utf8').split('\n'); } catch {}
		if (lines.some((l) => l.includes('Registered with Stream Deck') && Date.parse(l.slice(0, 24)) >= since)) return true;
	}
	return false;
}

module.exports = {
	REPO, PLUGINS, OFFICIAL_INSTALLED, OFFICIAL_NAME, BUSIEST_ASSETS,
	step, fail, stamp, exeVersion, pickOfficial, patchExe, buildOfficial, buildBusiest,
	runningStreamDeck, stopStreamDeck, startStreamDeck, replaceDir, waitForRegistration,
};
