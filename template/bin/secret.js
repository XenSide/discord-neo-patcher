'use strict';
/*
 * Keeps the Discord app secret out of cleartext: app.json stores it encrypted with Windows
 * DPAPI (CurrentUser scope), so only this Windows account can read it. A plaintext
 * "clientSecret" (older installs, or a freshly pasted one) is encrypted in place on first load.
 * The secret goes to PowerShell over stdin, never on a command line.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

function dpapi(op, text) {
	const script = 'Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd();'
		+ (op === 'Protect'
			? '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, "CurrentUser"))'
			: '[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, "CurrentUser"))');
	return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { input: text, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).replace(/\r?\n$/, '');
}

// Returns { clientId, clientSecret } (secret decrypted), migrating a plaintext secret on disk first.
function loadApp(file) {
	let app;
	try { app = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
	if (app.clientSecret) {
		const plain = app.clientSecret;
		const stored = { clientId: app.clientId || '', secretDpapi: dpapi('Protect', plain) };
		if (dpapi('Unprotect', stored.secretDpapi) !== plain) throw new Error('DPAPI round-trip failed; app.json left unchanged');
		fs.writeFileSync(file, JSON.stringify(stored) + '\n');
		return { clientId: stored.clientId, clientSecret: plain };
	}
	if (app.secretDpapi) return { clientId: app.clientId || '', clientSecret: dpapi('Unprotect', app.secretDpapi) };
	return { clientId: app.clientId || '', clientSecret: '' };
}

module.exports = { loadApp };
