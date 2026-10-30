# Discord NEO

Elgato's Discord plugin for Stream Deck, unmodified, plus a **Join Busiest Channel** key:

- **Press** it to join the voice channel with the most people in your server (falls back to the next one if the busiest is full).
- **While you're in a call** it shows who's in your channel the same way Elgato's own Voice Channel key does: up to three avatars, the most recent speaker on top with a green ring, mute/deafen badges, a member count, and a warning when your connection is bad.

It also makes Elgato's own **Voice Channel** key cheaper for Stream Deck. During a call that key sends an SVG with every avatar embedded, on each speaking change, and Stream Deck spends 2-3× the CPU rasterizing it that it spends on a PNG. The launcher turns those SVGs into small PNGs, drawing each part of the key once and reusing it.

This repository contains **no Elgato code**. `install.js` builds the plugin from *your own* installed copy of the official Discord plugin: Elgato's files are copied unchanged and run behind a small launcher (`template/bin/launcher.js`) that adds the extra key.

Not affiliated with Elgato or Discord. Windows only.

## Requirements

- Windows 10 or later, Stream Deck software 6.5+
- [Node.js](https://nodejs.org) 20+ (with npm)
- The Discord desktop app

## Install

1. In the Stream Deck app, install **Discord** from the Marketplace.
2. In this folder, run:

   ```
   node install.js
   ```

   It builds Discord NEO, installs it, restarts Stream Deck, and moves the official plugin out of the Plugins folder (into `backup-official-<version>\`) so the two don't run side by side. Keys you had placed from the official plugin need to be added again from the **Discord NEO** category; all of Elgato's actions are there.

## Set up your Discord app (once)

Discord only lets an app control voice for its owner and its testers (the `rpc` scopes are [partner-only](https://docs.discord.com/developers/topics/oauth2)), so the Join Busiest Channel key needs **your own** Discord application. It takes a few minutes and is free:

1. Open <https://discord.com/developers/applications> → **New Application**, give it any name.
2. Go to **OAuth2** → **Redirects** → **Add Redirect**: `http://localhost` → **Save Changes**.
3. On the same page copy the **Client ID**, then **Reset Secret** and copy the **Client Secret**.
4. Drag **Join Busiest Channel** onto a key, paste both values into its settings, and press the key. Discord shows an **Authorize** popup once; accept it.

Alternatively put them in `%APPDATA%\Elgato\StreamDeck\Plugins\com.xenside.discordneo.sdPlugin\bin\app.json` as `{"clientId": "...", "clientSecret": "..."}` and restart Stream Deck. The plugin then replaces the secret with a copy encrypted for your Windows account (DPAPI); `install.js` carries it over on reinstalls. Never share or commit that file.

## When Elgato updates the Discord plugin

Install the official Discord plugin from the Marketplace again, then run `node install.js`. Before changing anything it checks the new version against `template/manifest.json`:

- a new official action is reported (add it to `template/manifest.json` to use it);
- if an icon our manifest uses was renamed or removed, it stops and nothing is changed.

Running `node install.js` without a fresh official plugin rebuilds from the newest official copy saved in a `backup-*\` folder (useful to repair an install).

## Rolling back

Every install saves the previous version to `backup-<date-time>\com.xenside.discordneo.sdPlugin`. To restore it, quit Stream Deck, copy that folder over `%APPDATA%\Elgato\StreamDeck\Plugins\com.xenside.discordneo.sdPlugin`, and start Stream Deck again.

## Files

| Path | What |
| --- | --- |
| `install.js` | Build + install + restart, as above |
| `build.js` | Build only: `node build.js [officialPluginDir] [outDir] [--app app.json]` |
| `template/` | Everything this project adds: manifest, launcher, the Join Busiest key, its icon and settings page |
| `dist/`, `backup-*/` | Build output and backups. They contain Elgato's files (and your encrypted app secret), so they are git-ignored; never publish them |
