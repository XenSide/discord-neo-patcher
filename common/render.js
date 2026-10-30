'use strict';
/*
 * Key image rendering shared by both plugins (copied into each plugin's bin/ at build time).
 *
 * Key images go out as PNGs: Stream Deck rasterizing an SVG with embedded avatars costs it
 * 10-16 ms of CPU per image against ~5 ms for a PNG (measured 2026-10-30), and on the Volume
 * Controller fork it held back the deck's next key event by 180-615 ms. Each layer of a key is
 * drawn by resvg once and cached as pixels, so a redraw (someone starts or stops talking) only
 * stacks cached layers and encodes the PNG: under 1 ms instead of ~4-8 ms for a full render.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

let log = () => {};
let font = '';
// opts.log: the plugin's logger; opts.font: Stream Deck's UI font from -info, which Elgato's keys use for text.
function init(opts) {
	log = opts.log || log;
	font = opts.font || '';
}
const fontName = () => font || 'Segoe UI';

let Resvg = null;
try { ({ Resvg } = require('@resvg/resvg-js')); } catch (e) { setImmediate(() => log('resvg unavailable, sending SVG:', e.message)); }

/* ---------------------------------------------------------------- PNG */
const CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c;
});
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };

// 8-bit, non-interlaced PNG -> RGBA pixels; null for anything else (caller keeps the original).
function pngToRgba(buf) {
	if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
	let w, h, type, depth, interlace, pal, trns;
	const idat = [];
	for (let o = 8; o + 8 <= buf.length;) {
		const len = buf.readUInt32BE(o), kind = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
		if (kind === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
		else if (kind === 'PLTE') pal = d;
		else if (kind === 'tRNS') trns = d;
		else if (kind === 'IDAT') idat.push(d);
		o += 12 + len;
	}
	const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
	if (depth !== 8 || interlace || !ch || (type === 3 && !pal)) return null;
	const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, px = Buffer.alloc(stride * h);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= ch ? px[row + x - ch] : 0, b = y ? px[up + x] : 0, c = x >= ch && y ? px[up + x - ch] : 0;
			let v = raw[src + x];
			if (f === 1) v += a;
			else if (f === 2) v += b;
			else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
			px[row + x] = v & 255;
		}
	}
	const out = Buffer.alloc(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const s = i * ch, o = i * 4;
		if (type === 6) px.copy(out, o, s, s + 4);
		else if (type === 2) { out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; out[o + 3] = 255; }
		else if (type === 3) { const k = px[s]; out[o] = pal[k * 3]; out[o + 1] = pal[k * 3 + 1]; out[o + 2] = pal[k * 3 + 2]; out[o + 3] = trns && k < trns.length ? trns[k] : 255; }
		else { out[o] = out[o + 1] = out[o + 2] = px[s]; out[o + 3] = type === 4 ? px[s + 1] : 255; }
	}
	return { w, h, px: out };
}

function rgbaToPng({ w, h, px }) {
	// "Sub" row filter + fast deflate: ~0.5 ms for a key image, about the size resvg's own encoder gives.
	const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
	for (let y = 0; y < h; y++) {
		const o = y * (stride + 1), r = y * stride;
		raw[o] = 1;
		for (let x = 0; x < stride; x++) raw[o + 1 + x] = px[r + x] - (x >= 4 ? px[r + x - 4] : 0);
	}
	const chunk = (kind, d) => {
		const b = Buffer.alloc(12 + d.length);
		b.writeUInt32BE(d.length, 0); b.write(kind, 4, 'ascii'); d.copy(b, 8);
		b.writeUInt32BE(crc32(b.subarray(4, 8 + d.length)), 8 + d.length);
		return b;
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

/* Stream Deck's renderer ignores clip-path, so the exe cuts avatars round in the pixels
   (FUN_14005b750) before embedding them. Same here: minimal PNG decode -> alpha circle -> encode. */
function roundPng(buf) {
	const img = pngToRgba(buf);
	if (!img) return buf;
	const { w, h, px } = img, r = Math.min(w, h) / 2;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const k = Math.max(0, Math.min(1, r - Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) + 0.5)); // anti-aliased edge
		const i = (y * w + x) * 4 + 3;
		px[i] = Math.round(px[i] * k);
	}
	return rgbaToPng(img);
}

const avatarCache = new Map(); // url -> Promise of a round PNG data URI (null if it couldn't be fetched)

// Discord avatar URL -> round PNG data URI, fetched once. The CDN serves any avatar as PNG, which roundPng can read.
function avatar(url) {
	url = url.replace(/\.webp(?=\?|$)/, '.png');
	if (!avatarCache.has(url)) {
		avatarCache.set(url, fetch(url)
			.then(async (r) => 'data:image/png;base64,' + roundPng(Buffer.from(await r.arrayBuffer())).toString('base64'))
			.catch(() => { avatarCache.delete(url); return null; }));
	}
	return avatarCache.get(url);
}

/* -------------------------------------------------------------- fonts */
let fontFiles = null;

// Font files of one family, from the Windows font registry (machine and per-user installs).
function fontFilesFor(family) {
	if (fontFiles) return fontFiles;
	const files = [];
	for (const hive of ['HKLM', 'HKCU']) {
		let out = '';
		try {
			out = execFileSync('reg', ['query', hive + '\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'],
				{ encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
		} catch {}
		for (const line of out.split(/\r?\n/)) {
			const m = /^\s+(.+?)\s+REG_SZ\s+(.+?)\s*$/.exec(line);
			const name = m ? m[1].replace(/\s*\((TrueType|OpenType)\)$/i, '') : '';
			// "Segoe UI Bold" is the family, "Segoe UI Emoji" is another family that only shares the prefix.
			if (name.toLowerCase().startsWith(family.toLowerCase())
				&& /^(\s+(bold|italic|light|semibold|semilight|black|regular|thin|medium|oblique))*$/i.test(name.slice(family.length))) {
				files.push(path.isAbsolute(m[2]) ? m[2] : path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', m[2]));
			}
		}
	}
	return (fontFiles = files.filter((f) => fs.existsSync(f)));
}

// Loading fonts costs ~1.5 ms, so only SVGs with text get them.
function fontOptions(svg) {
	if (!svg.includes('<text')) return { loadSystemFonts: false };
	const files = fontFilesFor(fontName());
	return files.length ? { loadSystemFonts: false, fontFiles: files, defaultFontFamily: fontName() } : { loadSystemFonts: true };
}

/* ------------------------------------------------------------- layers */
const SVG_OPEN = '<svg width="144px" height="144px" viewBox="0 0 144 144" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg">';
const svgDoc = (body, root = SVG_OPEN) => root + body + '</svg>';
const layerCache = new Map(); // key -> { x, y, w, h, px }: premultiplied RGBA cropped to the pixels it covers

function layerPixels(key, markup, root) {
	let l = layerCache.get(key);
	if (l) { layerCache.delete(key); layerCache.set(key, l); return l; } // keep recently used ones last
	const svg = svgDoc(markup(), root);
	const full = new Resvg(svg, { font: fontOptions(svg) }).render().pixels;
	let x0 = 144, y0 = 144, x1 = -1, y1 = -1;
	for (let p = 0; p < 144 * 144; p++) {
		if (!full[p * 4 + 3]) continue;
		const x = p % 144, y = (p / 144) | 0;
		if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
	}
	const w = Math.max(0, x1 - x0 + 1), h = Math.max(0, y1 - y0 + 1), px = Buffer.alloc(w * h * 4);
	for (let r = 0; r < h; r++) full.copy(px, r * w * 4, ((y0 + r) * 144 + x0) * 4, ((y0 + r) * 144 + x0 + w) * 4);
	l = { x: x0, y: y0, w, h, px };
	layerCache.set(key, l);
	if (layerCache.size > 150) layerCache.delete(layerCache.keys().next().value); // under 9 MB even if all were avatars
	return l;
}

// layers: [cache key, () => svg markup, x, y, root <svg> tag (default ours)], bottom to top. Returns a data URI.
function composite(layers) {
	if (Resvg) {
		try {
			const out = Buffer.alloc(144 * 144 * 4);
			for (const [key, markup, dx = 0, dy = 0, root] of layers) {
				const l = layerPixels(key, markup, root), { w, h, px } = l, x = l.x + dx, y = l.y + dy;
				// A slot's box can reach past the key's edge; clip so it doesn't wrap into the next row.
				for (let r = 0; r < Math.min(h, 144 - y); r++) {
					for (let c = 0, s = r * w * 4, d = ((y + r) * 144 + x) * 4; c < Math.min(w, 144 - x); c++, s += 4, d += 4) {
						const a = px[s + 3];
						if (!a) continue;
						const k = 255 - a; // premultiplied "over"
						for (let j = 0; j < 4; j++) out[d + j] = px[s + j] + ((out[d + j] * k + 127) / 255 | 0);
					}
				}
			}
			for (let d = 0; d < out.length; d += 4) { // PNG wants straight alpha
				const a = out[d + 3];
				if (a && a < 255) for (let j = 0; j < 3; j++) out[d + j] = Math.min(255, Math.round(out[d + j] * 255 / a));
			}
			return 'data:image/png;base64,' + rgbaToPng({ w: 144, h: 144, px: out }).toString('base64');
		} catch (e) { log('PNG render failed, sending SVG:', e.message); }
	}
	return 'data:image/svg+xml;base64,' + Buffer.from(svgDoc(layers.map(([, markup, dx = 0, dy = 0]) => `<g transform="translate(${dx} ${dy})">${markup()}</g>`).join(''), layers[0] && layers[0][4])).toString('base64');
}

/* ------------------------------------------------- Elgato's own SVGs */
// Top-level elements of an SVG document: { root: '<svg ...>', kids: [...] }, or null if it doesn't close.
function splitSvg(svg) {
	const open = /<svg\b[^>]*>/.exec(svg);
	if (!open) return null;
	const kids = [], tag = /<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
	let depth = 0, start = 0;
	tag.lastIndex = open.index + open[0].length;
	for (let m; (m = tag.exec(svg));) {
		if (!m[2]) continue; // comment or CDATA
		if (m[1]) {
			if (!depth) return m[2] === 'svg' ? { root: open[0], kids } : null;
			if (!--depth) kids.push(svg.slice(start, tag.lastIndex));
		} else if (m[3]) {
			if (!depth) kids.push(m[0]);
		} else if (!depth++) start = m.index;
	}
	return null;
}

const AVATAR_URL = /https:\/\/cdn\.discordapp\.com\/[^"'\s<>)]+/g;

/* An SVG sent by ESDDiscord.exe -> { image: PNG data URI, complete: false if an avatar couldn't be
   fetched yet }, or null to send it unchanged. The patched exe
   (patch-official.js) writes each avatar's URL where it used to embed the picture; the URLs are
   swapped for our cached round copies here. Each top-level element (background, one group per
   user, pill) is a cached layer, so a speaking change only redraws the group that changed. */
async function exeImage(svg) {
	if (!Resvg) return null;
	const urls = [...new Set(svg.match(AVATAR_URL) || [])];
	const uris = new Map(await Promise.all(urls.map(async (u) => [u, (await avatar(u)) || ''])));
	const fill = (s) => (urls.length ? s.replace(AVATAR_URL, (u) => uris.get(u)) : s);
	// A missing avatar is retried on the next image, so it mustn't be cached under the same key.
	const missing = urls.filter((u) => !uris.get(u)).join(' ');
	const parts = splitSvg(svg);
	const root = parts ? parts.root : '';
	// Layers are drawn on our 144x144 canvas, so anything else (or unsplittable) is rendered whole.
	if (!parts || !/\bwidth=["']144(px)?["']/.test(root) || !/\bheight=["']144(px)?["']/.test(root)
		|| (/viewBox/.test(root) && !/viewBox=["']0[ ,]+0[ ,]+144[ ,]+144["']/.test(root))) {
		const whole = fill(svg);
		return { image: 'data:image/png;base64,' + new Resvg(whole, { font: fontOptions(whole) }).render().asPng().toString('base64'), complete: !missing };
	}
	const isDef = (k) => /^<(defs|clipPath|mask|linearGradient|radialGradient|pattern|filter|symbol|style)\b/.test(k);
	const defs = parts.kids.filter(isDef).join('');
	return { image: composite(parts.kids.filter((k) => !isDef(k)).map((k) => [defs + k + missing, () => fill(defs + k), 0, 0, root])), complete: !missing };
}

module.exports = { init, fontName, avatar, composite, exeImage, splitSvg, pngToRgba, rgbaToPng, roundPng, layerCache, avatarCache };
