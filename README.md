# Discord NEO

Two independent Stream Deck add-ons for Discord, each with its own installer:

- **Discord NEO** (`patch-official.js`): Elgato's Discord plugin with its in-call **Voice Channel** key made cheap for Stream Deck. During a call Elgato's key re-sends an SVG with every avatar embedded on each speaking change, and Stream Deck spends 2-3× the CPU rasterizing it that it spends on a PNG. NEO patches Elgato's `ESDDiscord.exe` to put avatar URLs in that SVG instead of downloading and embedding each picture, and its launcher sends the key to Stream Deck as a small PNG stacked from cached layers. No Discord app setup needed.
- **Discord Busiest** (`install-busiest.js`): a **Join Busiest Channel** key. Press it to join the voice channel with the most people in your server (it falls back to the next one if the busiest is full); press it while you're in a call to leave. While you're in a call it shows who's in your channel the way Elgato's Voice Channel key does; otherwise it previews the busiest channel, dimmed. Put several on one page for the same server and they rank left to right, top to bottom. Not in a call, they show the busiest, 2nd and 3rd busiest channel, and a press joins that one. In a call, the first shows your call (a press leaves it) and the others the busiest channels you're not in. It works with Elgato's official plugin or with NEO, and needs your own Discord app (see below).

This repository contains **no Elgato code**. Both installers build from *your own* installed copy of the official Discord plugin.

Not affiliated with Elgato or Discord. Windows only.

## Requirements

- Windows 10 or later, Stream Deck software 6.5+
- [Node.js](https://nodejs.org) 20+ (with npm)
- The Discord desktop app
- The official **Discord** plugin from the Stream Deck Marketplace (both installers copy files from it)

## Discord NEO

```
node patch-official.js
```

Stream Deck checks Marketplace plugins for changes, so the official plugin can't be edited in place. NEO is a copy under its own ID (`com.xenside.discordneo`, category **Discord NEO**) with all of Elgato's actions. The installer builds it, restarts Stream Deck, and moves the official plugin out of the Plugins folder (into `backup-official-<version>\`) so the two don't run side by side. Keys you had placed from the official plugin need to be added again from the **Discord NEO** category.

The exe patch is 5 bytes: the function that turns an avatar into an embedded WebP becomes a jump to the string copy, so it returns the avatar's URL. It is found by its exact bytes; any other build of `ESDDiscord.exe` is left unpatched with a warning, and the launcher still sends its key images as PNGs.

### When Elgato updates the Discord plugin

Install the official Discord plugin from the Marketplace again, then run `node patch-official.js`. Before changing anything it checks the new version against `official/manifest.json`:

- a new official action is reported (add it to `official/manifest.json` to use it);
- if an icon our manifest uses was renamed or removed, it stops and nothing is changed.

A new `ESDDiscord.exe` build will most likely not match the patch; the installer says so and installs it unpatched.

Running it without a fresh official plugin rebuilds from the newest official copy saved in a `backup-*\` folder (useful to repair an install).

## Discord Busiest

### Set up your Discord app (once)

Discord only lets an app control voice for its owner and its testers (the `rpc` scopes are [partner-only](https://docs.discord.com/developers/topics/oauth2)), so the Join Busiest Channel key needs **your own** Discord application. It takes a few minutes and is free:

1. Open <https://discord.com/developers/applications> → **New Application**, give it any name.
2. Go to **OAuth2** → **Redirects** → **Add Redirect**: `http://localhost` → **Save Changes**.
3. On the same page copy the **Client ID**, then **Reset Secret** and copy the **Client Secret**.

### Install

```
node install-busiest.js
```

Then drag **Join Busiest Channel** (category **Discord**) onto a key, paste both values into its settings, and press the key. Discord shows an **Authorize** popup once; accept it.

Alternatively put them in a file `{"clientId": "...", "clientSecret": "..."}` and run `node install-busiest.js --app path\to\that.json`. The plugin replaces the secret with a copy encrypted for your Windows account (DPAPI), and later installs carry it over. Never share or commit that file.

Keys made with the earlier all-in-one NEO (which carried the busiest key itself) are moved to this plugin automatically; the profile files it changes are saved to `backup-<date-time>\profiles\` first.

## Rolling back

Every install saves the previous version to `backup-<date-time>\<plugin folder>`. To restore it, quit Stream Deck, copy that folder over the one in `%APPDATA%\Elgato\StreamDeck\Plugins\`, and start Stream Deck again.

## Files

| Path | What |
| --- | --- |
| `patch-official.js` | Builds and installs Discord NEO, as above |
| `install-busiest.js` | Builds and installs Discord Busiest, as above |
| `lib.js` | Shared by both: finding the official plugin, the builds, the exe patch, restarting Stream Deck |
| `official/` | NEO's manifest and launcher |
| `busiest/` | Discord Busiest: manifest, plugin code, icon and settings page |
| `common/render.js` | Key image rendering used by both (PNG from cached layers) |
| `dist/`, `backup-*/` | Build output and backups. They contain Elgato's files (and your encrypted app secret), so they are git-ignored; never publish them |
