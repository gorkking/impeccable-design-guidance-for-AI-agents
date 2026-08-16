#!/usr/bin/env node
/**
 * font-match: measure the lettering in a comp's text region and rank candidate
 * faces against it, so the face is chosen by metrics instead of by name.
 *
 *   node font-match.mjs --measure <region-id> [--spec .impeccable/build/spec.json]
 *     Fingerprints the comp crop of a text region: cap height (px), average
 *     glyph advance per cap height (width class), stroke weight (ink fraction
 *     per glyph area), and letter density. Prints them and stores them on the
 *     region in the spec (`type` block), so build code can set font-size from
 *     capHeightPx and the hero gate can name a width/weight miss.
 *
 *   node font-match.mjs --rank <region-id> [--candidates "Barlow Condensed:700,Oswald:600"] [--text "The manuals stop."]
 *     Renders the region's text (or --text) in every candidate face (yours
 *     plus a built-in shortlist for the comp's width class) at the
 *     comp's cap height in a headless browser (Google Fonts CSS, or any
 *     locally installed face), measures the same fingerprint, and ranks the
 *     candidates by distance. Prints the ranking with per-face width and
 *     weight deltas and the CSS to use (family, weight, and the font-size
 *     that reproduces the comp's cap height). Needs a browser: playwright or
 *     puppeteer resolvable from the project or the impeccable CLI; without
 *     one, prints the comp fingerprint and how to read it.
 *
 * Why: models pick faces from memory and never measure. Three of the six
 * misses a human called on a first-round build were the same miss: the
 * headline face wider and lighter than the comp's, the parts list smaller,
 * the footer heavier. All three are ratios a script can read off pixels.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { decodePng, encodePng } from './lib/png.mjs';
import { crop } from './lib/raster.mjs';
import { toGray } from './lib/image-metrics.mjs';
import { loadSpec, SPEC_PATH } from './comp-spec.mjs';

const require = createRequire(import.meta.url);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

// ---- fingerprint ----------------------------------------------------------

/** Otsu threshold on a gray image: ink vs ground, whichever is darker is ink. */
function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.data.length; i++) hist[Math.max(0, Math.min(255, Math.round(gray.data[i])))]++;
  const total = gray.data.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/**
 * Fingerprint the lettering in an RGBA image:
 *  - lines: text lines found by row-projection of ink
 *  - capHeightPx: median line ink height (cap/x-height blend; consistent across comp and render)
 *  - advance: mean glyph width / capHeightPx (width class; condensed < 0.45, normal ~0.55-0.65, wide > 0.7)
 *  - weight: ink pixels / (glyph bbox area) (light ~0.2, regular ~0.3, bold ~0.4+)
 *  - gap: mean inter-glyph gap / capHeightPx (tracking)
 * Returns null when no ink lines are found.
 */
export function fingerprint(img) {
  const g = toGray(img);
  const thr = otsu(g);
  // ink is the minority side of the threshold
  let dark = 0; for (let i = 0; i < g.data.length; i++) if (g.data[i] < thr) dark++;
  const inkIsDark = dark <= g.data.length / 2;
  const isInk = (v) => (inkIsDark ? v < thr : v >= thr);
  const W = g.width, H = g.height;
  const rowInk = new Uint32Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isInk(g.data[y * W + x])) rowInk[y]++;
  // lines: runs of rows with ink above a small floor, then split each run at
  // interior valleys (descender/ascender bridges keep adjacent lines joined
  // at a trickle of ink; a valley under 15% of the run's peak is a line break)
  const floor = Math.max(1, W * 0.004);
  const runs = [];
  let y = 0;
  while (y < H) {
    if (rowInk[y] > floor) {
      let y0 = y; while (y < H && (rowInk[y] > floor || (y + 1 < H && rowInk[y + 1] > floor))) y++;
      if (y - y0 >= 4) runs.push({ y0, y1: y });
    } else y++;
  }
  const lines = [];
  for (const run of runs) {
    let peak = 0; for (let yy = run.y0; yy < run.y1; yy++) peak = Math.max(peak, rowInk[yy]);
    const valley = peak * 0.15;
    let start = run.y0, inValley = false, valleyStart = 0;
    for (let yy = run.y0; yy < run.y1; yy++) {
      const low = rowInk[yy] < valley;
      if (low && !inValley) { inValley = true; valleyStart = yy; }
      if (!low && inValley) {
        inValley = false;
        // a valley at least 3 rows deep splits; shorter ones are letter gaps
        if (yy - valleyStart >= 3 && valleyStart - start >= 4) { lines.push({ y0: start, y1: valleyStart }); start = yy; }
      }
    }
    if (run.y1 - start >= 4) lines.push({ y0: start, y1: run.y1 });
  }
  if (!lines.length) return null;
  const glyphs = [];
  const gapsAll = [];
  for (const ln of lines) {
    // column projection inside the line -> glyph runs
    const colInk = new Uint32Array(W);
    for (let yy = ln.y0; yy < ln.y1; yy++) for (let x = 0; x < W; x++) if (isInk(g.data[yy * W + x])) colInk[x]++;
    let x = 0; const runs = [];
    while (x < W) {
      if (colInk[x] > 0) { const x0 = x; while (x < W && colInk[x] > 0) x++; runs.push({ x0, x1: x }); } else x++;
    }
    // ink height per line: rows in the line whose ink is above 20% of the line's max (drops ascender/descender tails)
    let maxRow = 0; for (let yy = ln.y0; yy < ln.y1; yy++) maxRow = Math.max(maxRow, rowInk[yy]);
    let hy0 = ln.y0, hy1 = ln.y1;
    while (hy0 < ln.y1 && rowInk[hy0] < maxRow * 0.2) hy0++;
    while (hy1 > hy0 && rowInk[hy1 - 1] < maxRow * 0.2) hy1--;
    const lineH = Math.max(1, hy1 - hy0);
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const w = r.x1 - r.x0;
      if (w < lineH * 0.15) continue; // dots, punctuation, thin rules
      let ink = 0; for (let yy = hy0; yy < hy1; yy++) for (let xx = r.x0; xx < r.x1; xx++) if (isInk(g.data[yy * W + xx])) ink++;
      glyphs.push({ w, h: lineH, ink });
      if (i + 1 < runs.length) { const gap = runs[i + 1].x0 - r.x1; if (gap < lineH * 0.6) gapsAll.push(gap / lineH); }
    }
  }
  if (!glyphs.length) return null;
  const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  const capHeightPx = med(glyphs.map((x) => x.h));
  const advance = med(glyphs.map((x) => x.w / x.h));
  const weight = med(glyphs.map((x) => x.ink / (x.w * x.h)));
  const gap = gapsAll.length ? med(gapsAll) : 0;
  return { lines: lines.length, glyphs: glyphs.length, capHeightPx: +capHeightPx.toFixed(1), advance: +advance.toFixed(3), weight: +weight.toFixed(3), gap: +gap.toFixed(3), inkIsDark };
}

export function widthClass(advance) {
  if (advance < 0.42) return 'compressed';
  if (advance < 0.52) return 'condensed';
  if (advance < 0.66) return 'normal';
  return 'wide';
}
export function weightClass(weight) {
  if (weight < 0.22) return 'light';
  if (weight < 0.3) return 'regular';
  if (weight < 0.38) return 'medium';
  if (weight < 0.46) return 'bold';
  return 'black';
}

export function distance(a, b) {
  // width and weight both decide whether a face reads as the same face;
  // tracking is a CSS knob (letter-spacing) so it counts least.
  return Math.abs(a.advance - b.advance) * 2.5 + Math.abs(a.weight - b.weight) * 2.5 + Math.abs(a.gap - b.gap) * 0.5;
}

/**
 * A starter shortlist per width class, Google Fonts only, chosen to span
 * weight and character inside the class. The model adds its own names on
 * top; the point is that a ranking never runs against one guessed family.
 */
export const SHORTLIST = {
  compressed: ['League Gothic:400', 'Bebas Neue:400', 'Anton:400', 'Six Caps:400', 'Big Shoulders Display:900', 'Antonio:700', 'Saira Extra Condensed:800', 'Oswald:700'],
  condensed: ['League Gothic:400', 'Fjalla One:400', 'Anton:400', 'Bebas Neue:400', 'Oswald:600', 'Barlow Condensed:700', 'Roboto Condensed:800', 'Archivo Narrow:700', 'Pathway Gothic One:400', 'Big Shoulders Display:800', 'Teko:600', 'Sofia Sans Condensed:800'],
  normal: ['Inter:700', 'Work Sans:700', 'IBM Plex Sans:700', 'Archivo:800', 'Public Sans:700', 'Source Sans 3:700', 'Roboto:900', 'Barlow:800', 'Manrope:800', 'Rubik:800'],
  wide: ['Archivo Black:400', 'Syne:800', 'Space Grotesk:700', 'Unbounded:700', 'Bricolage Grotesque:800', 'Sora:800', 'Outfit:800', 'Lexend:800'],
};

/** Weight-shifted variants of a candidate list toward the comp's weight class. */
export function withWeightVariants(list, targetWeight) {
  const out = [];
  for (const c of list) {
    out.push(c);
    const m = /^(.*?):(\d{3})$/.exec(c);
    if (!m) continue;
    const w = parseInt(m[2], 10);
    // always offer one step lighter and one heavier; the ranking decides
    for (const d of [-200, 200]) { const nw = w + d; if (nw >= 100 && nw <= 900) out.push(`${m[1]}:${nw}`); }
  }
  return [...new Set(out)];
}

// ---- browser --------------------------------------------------------------

async function loadBrowser() {
  const tries = [
    () => require('playwright'),
    () => require(require.resolve('playwright', { paths: [process.cwd()] })),
    () => require(require.resolve('playwright', { paths: [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')] })),
  ];
  for (const t of tries) { try { const pw = t(); if (pw?.chromium) return { kind: 'playwright', mod: pw }; } catch { /* next */ } }
  const tries2 = [
    () => require('puppeteer'),
    () => require(require.resolve('puppeteer', { paths: [process.cwd()] })),
    () => require(require.resolve('puppeteer', { paths: [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')] })),
  ];
  for (const t of tries2) { try { const pp = t(); if (pp?.launch) return { kind: 'puppeteer', mod: pp }; } catch { /* next */ } }
  return null;
}

function parseCandidates(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^(.*?)(?::(\d{3}))?$/.exec(x);
    return { family: m[1].trim(), weight: m[2] ? parseInt(m[2], 10) : 400 };
  });
}

/** Render `text` in each candidate at a font-size whose measured cap height ~= targetCapPx; return fingerprints. */
export async function renderCandidates(candidates, text, targetCapPx, { transform = 'none' } = {}) {
  const b = await loadBrowser();
  if (!b) return null;
  // One stylesheet per family+weight: a combined request 400s when any one
  // family lacks the requested axis (Anton has no wght range), and a static
  // family answers only for the weights it ships.
  const links = candidates.map((c) => `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(c.family).replace(/%20/g, '+')}:wght@${c.weight}&display=block">`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8">${links}<style>body{margin:0;background:#fff}div.s{position:absolute;left:0;top:0;white-space:nowrap;color:#000;line-height:1;padding:8px;text-transform:${transform}}</style></head><body></body></html>`;
  const results = [];
  const size0 = Math.max(12, Math.round(targetCapPx * 1.4));
  if (b.kind === 'playwright') {
    const browser = await b.mod.chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 400 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    for (const c of candidates) {
      // two passes: measure at size0, then rescale so the fingerprint's cap height matches the comp
      let size = size0, fp = null, ok = true;
      for (let pass = 0; pass < 2; pass++) {
        await page.evaluate(({ family, weight, size, text }) => {
          document.body.innerHTML = `<div class="s" style="font-family:'${family}',sans-serif;font-weight:${weight};font-size:${size}px">${text}</div>`;
        }, { family: c.family, weight: c.weight, size, text });
        let loaded = false;
        // Loaded means a real face of this family covers the requested weight;
        // fonts.check() answers true for a synthetic bold of a lighter file.
        try {
          loaded = await page.evaluate(async (f) => {
            const faces = await document.fonts.load(`${f.weight} 32px '${f.family}'`);
            await document.fonts.ready;
            const covers = (face) => { const w = String(face.weight || '400').split(/\s+/).map(Number); const lo = w[0], hi = w[1] ?? w[0]; return f.weight >= lo - 50 && f.weight <= hi + 50; };
            return faces.some((face) => face.family.replace(/["']/g, '') === f.family && face.status === 'loaded' && covers(face));
          }, c);
        } catch { loaded = false; }
        await page.waitForTimeout(100);
        if (!loaded) ok = false;
        const box = await page.evaluate(() => { const r = document.querySelector('div.s').getBoundingClientRect(); return { w: Math.ceil(r.width) + 8, h: Math.ceil(r.height) + 8 }; });
        const buf = await page.screenshot({ clip: { x: 0, y: 0, width: Math.min(1600, box.w), height: Math.min(400, box.h) } });
        fp = fingerprint(decodePng(buf));
        if (!fp || pass === 1) break;
        size = Math.max(8, Math.round(size * (targetCapPx / fp.capHeightPx)));
      }
      results.push({ ...c, loaded: ok, fontSizePx: size, fp });
    }
    await browser.close();
  } else {
    const browser = await b.mod.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 400 });
    await page.setContent(html, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 800));
    for (const c of candidates) {
      let size = size0, fp = null, ok = true;
      for (let pass = 0; pass < 2; pass++) {
        await page.evaluate(({ family, weight, size, text }) => {
          document.body.innerHTML = `<div class="s" style="font-family:'${family}',sans-serif;font-weight:${weight};font-size:${size}px">${text}</div>`;
        }, { family: c.family, weight: c.weight, size, text });
        let loaded = false;
        // Loaded means a real face of this family covers the requested weight;
        // fonts.check() answers true for a synthetic bold of a lighter file.
        try {
          loaded = await page.evaluate(async (f) => {
            const faces = await document.fonts.load(`${f.weight} 32px '${f.family}'`);
            await document.fonts.ready;
            const covers = (face) => { const w = String(face.weight || '400').split(/\s+/).map(Number); const lo = w[0], hi = w[1] ?? w[0]; return f.weight >= lo - 50 && f.weight <= hi + 50; };
            return faces.some((face) => face.family.replace(/["']/g, '') === f.family && face.status === 'loaded' && covers(face));
          }, c);
        } catch { loaded = false; }
        await new Promise((r) => setTimeout(r, 100));
        if (!loaded) ok = false;
        const box = await page.evaluate(() => { const r = document.querySelector('div.s').getBoundingClientRect(); return { w: Math.ceil(r.width) + 8, h: Math.ceil(r.height) + 8 }; });
        const buf = await page.screenshot({ clip: { x: 0, y: 0, width: Math.min(1600, box.w), height: Math.min(400, box.h) } });
        fp = fingerprint(decodePng(buf));
        if (!fp || pass === 1) break;
        size = Math.max(8, Math.round(size * (targetCapPx / fp.capHeightPx)));
      }
      results.push({ ...c, loaded: ok, fontSizePx: size, fp });
    }
    await browser.close();
  }
  return results;
}

/** Comp crop over the top candidates, rendered at the comp's cap height, as one PNG. */
export async function renderProofSheet(compCrop, top, text, capPx, transform = 'none') {
  const b = await loadBrowser();
  if (!b || b.kind !== 'playwright') return null;
  const compB64 = Buffer.from(encodePng(compCrop)).toString('base64');
  const links = top.map((c) => `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(c.family).replace(/%20/g, '+')}:wght@${c.weight}&display=block">`).join('');
  const rowsHtml = top.map((c) => `<div class="row"><div class="lab">${c.family} ${c.weight} · ${c.fontSizePx}px</div><div class="s" style="font-family:'${c.family}';font-weight:${c.weight};font-size:${c.fontSizePx}px;text-transform:${transform}">${text}</div></div>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8">${links}<style>body{margin:0;background:#fff;padding:12px;font-family:system-ui}img{display:block;max-width:100%}.lab{font:12px system-ui;color:#666;margin:10px 0 2px}.s{white-space:nowrap;line-height:1.05;color:#111}</style></head><body><div class="lab">COMP</div><img src="data:image/png;base64,${compB64}">${rowsHtml}</body></html>`;
  const browser = await b.mod.chromium.launch();
  const page = await browser.newPage({ viewport: { width: Math.min(1600, Math.max(600, compCrop.width + 24)), height: 200 } });
  await page.setContent(html, { waitUntil: 'load' });
  try { await page.evaluate(async () => { await document.fonts.ready; }); } catch { /* ignore */ }
  await page.waitForTimeout(600);
  const buf = await page.screenshot({ fullPage: true });
  await browser.close();
  return buf;
}

// ---- CLI ------------------------------------------------------------------

function describe(fp) {
  return `capHeight ${fp.capHeightPx}px, width ${widthClass(fp.advance)} (advance ${fp.advance}), weight ${weightClass(fp.weight)} (ink ${fp.weight}), tracking ${fp.gap}`;
}

async function main() {
  const specPath = arg('spec', SPEC_PATH);
  const spec = loadSpec(specPath);
  const measureId = arg('measure'), rankId = arg('rank');
  const id = measureId || rankId;
  if (!id) {
    console.error('usage: font-match.mjs --measure <text-region-id> | --rank <text-region-id> --candidates "Family:700,Family2:400,..." [--text "..."] [--transform uppercase]');
    process.exit(1);
  }
  if (!spec) { console.error(`font-match: no spec at ${specPath}; run comp-spec.mjs first`); process.exit(1); }
  const region = spec.regions.find((r) => r.id === id);
  if (!region) { console.error(`font-match: no region ${id}; ids: ${spec.regions.map((r) => r.id).join(', ')}`); process.exit(1); }
  const comp = decodePng(fs.readFileSync(spec.comp));
  const c = crop(comp, region.px.x, region.px.y, region.px.w, region.px.h);
  const fp = fingerprint(c);
  if (!fp) {
    // Record the attempt so the spec gate does not ask again; a region with
    // no separable glyphs (a rule, a bar of solid ink, a very small label at
    // comp resolution) is measured as "no lettering" and the model sizes it
    // by its box.
    region.type = { ...(region.type || {}), comp: null, measuredAt: new Date().toISOString(), note: 'no separable lettering in the crop; size by the region box' };
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
    console.log(`MEASURE ${id}: no separable lettering in the region crop at comp resolution; size this text by its box (${region.px.w}x${region.px.h}px) and inherit face and weight from the nearest measured region.`);
    process.exit(0);
  }
  region.type = { ...(region.type || {}), comp: fp, widthClass: widthClass(fp.advance), weightClass: weightClass(fp.weight) };
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  console.log(`MEASURE ${id}: ${describe(fp)} over ${fp.lines} line${fp.lines === 1 ? '' : 's'}, ${fp.glyphs} glyphs. Set this region's font-size so its cap height renders at ${fp.capHeightPx}px; choose a ${widthClass(fp.advance)} ${weightClass(fp.weight)} face.`);
  if (!rankId) return;
  const own = parseCandidates(arg('candidates'));
  const wc = widthClass(fp.advance);
  const short = withWeightVariants(SHORTLIST[wc] || SHORTLIST.normal, fp.weight).map((x) => parseCandidates(x)[0]);
  const seen = new Set();
  const candidates = [...own, ...short].filter((c) => { const k = `${c.family}:${c.weight}`; if (seen.has(k)) return false; seen.add(k); return true; });
  console.log(`CANDIDATES ${candidates.length}: ${own.length} yours + ${candidates.length - own.length} from the ${wc} shortlist`);
  const text = arg('text') || region.text || 'The manuals stop. The forum keeps going.';
  const transform = arg('transform', 'none');
  const results = await renderCandidates(candidates, text, fp.capHeightPx, { transform });
  if (!results) {
    console.log('RANK unavailable: no browser (playwright or puppeteer) resolvable from this project or the impeccable CLI. Choose by the MEASURE line: match the width class first, then the weight class; render one headline word against the comp before building on it.');
    return;
  }
  // Drop faces that never loaded (a weight the family does not ship falls
  // back to a system face and would rank as that face), then collapse
  // duplicate renders (two requested weights that resolved to one file).
  const seenFp = new Set();
  const rows = results
    .filter((r) => r.fp && r.loaded)
    .map((r) => ({ ...r, d: distance(fp, r.fp) }))
    .sort((a, b) => a.d - b.d)
    .filter((r) => { const k = `${r.family}|${r.fp.advance}|${r.fp.weight}|${r.fp.gap}`; if (seenFp.has(k)) return false; seenFp.add(k); return true; });
  const dropped = results.filter((r) => !r.loaded).map((r) => `${r.family}:${r.weight}`);
  if (dropped.length) console.log(`SKIPPED (not available at that weight on Google Fonts): ${dropped.join(', ')}`);
  for (const r of rows) {
    const dw = r.fp.advance - fp.advance, dwt = r.fp.weight - fp.weight;
    console.log(`RANK ${r.family}:${r.weight}${r.loaded ? '' : ' (NOT LOADED, fallback measured)'} distance ${r.d.toFixed(3)}  width ${widthClass(r.fp.advance)} (${dw >= 0 ? '+' : ''}${(dw * 100).toFixed(0)}% advance)  weight ${weightClass(r.fp.weight)} (${dwt >= 0 ? '+' : ''}${(dwt * 100).toFixed(0)}% ink)  font-size ${r.fontSizePx}px for cap ${fp.capHeightPx}px`);
  }
  // proof sheet: comp crop over the top three renders, so the choice is seen, not only scored
  try {
    const top = rows.slice(0, 3);
    const sheet = await renderProofSheet(c, top, text, fp.capHeightPx, transform);
    if (sheet) {
      const out = path.join(path.dirname(specPath), 'font-match', `${id}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, sheet);
      console.log(`PROOF ${out} (comp crop, then the top ${top.length} candidates at the comp's cap height; open it before choosing)`);
    }
  } catch { /* proof sheet is best-effort */ }
  const best = rows[0];
  if (best) {
    const advice = [];
    if (Math.abs(best.fp.advance - fp.advance) > 0.06) advice.push(best.fp.advance > fp.advance ? 'still too wide: try a more condensed face or a variable font with a wdth axis' : 'still too narrow: try a wider face');
    if (Math.abs(best.fp.weight - fp.weight) > 0.06) advice.push(best.fp.weight > fp.weight ? `too heavy: drop to weight ${Math.max(100, best.weight - 200)}` : `too light: raise to weight ${Math.min(900, best.weight + 200)}`);
    console.log(`USE font-family: '${best.family}'; font-weight: ${best.weight}; font-size: ${best.fontSizePx}px;${advice.length ? ' NOTE ' + advice.join('; ') : ''}`);
    region.type.chosen = { family: best.family, weight: best.weight, fontSizePx: best.fontSizePx, fp: best.fp };
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) main().catch((e) => { console.error(`font-match: ${e.message}`); process.exit(1); });
