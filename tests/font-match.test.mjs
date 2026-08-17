import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createImage, drawText } from '../skill/scripts/lib/raster.mjs';
import { fingerprint, distance, FEATURES, STATS } from '../skill/scripts/lib/font-fingerprint.mjs';
import { loadFontIndex, candidatesFromIndex, routeSize, packVector, unpackVector, INDEX_PATH, INDEX_FEATURES, ROUTE_CAP_PX } from '../skill/scripts/lib/font-index.mjs';
import { widthClass, weightClass, selectCandidates, SHORTLIST, renderCandidates } from '../skill/scripts/font-match.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasPlaywright = (() => { try { return !!require('playwright').chromium; } catch { return false; } })();

/** A white raster with a line of the bitmap font drawn on it, cap height 7 * scale px. */
function textSample(text, scale = 6, { x = 20, y = 20 } = {}) {
  const w = text.length * 6 * scale + 40, h = 7 * scale + 40;
  const img = createImage(w, h, [255, 255, 255, 255]);
  drawText(img, text, x, y, [0, 0, 0, 255], scale);
  return img;
}

describe('font-fingerprint', () => {
  it('fingerprints a synthetic rendered-text PNG with the expected fields', () => {
    const fp = fingerprint(textSample('HAMBURGEVONS THE QUICK BROWN FOX', 6));
    assert.ok(fp, 'fingerprint returned null');
    for (const k of ['lines', 'glyphs', 'capHeightPx', 'inkIsDark', 'allCaps', 'weight', ...FEATURES]) assert.ok(k in fp, `missing ${k}`);
    assert.equal(fp.lines, 1);
    assert.ok(fp.glyphs >= 20, `glyphs ${fp.glyphs}`);
    assert.ok(Math.abs(fp.capHeightPx - 42) <= 2, `capHeightPx ${fp.capHeightPx}`);
    assert.equal(fp.inkIsDark, true);
    assert.equal(typeof fp.allCaps, 'boolean');
    assert.ok(fp.advTall > 0.5 && fp.advTall < 0.9, `advTall ${fp.advTall}`);
    assert.ok(fp.densTall > 0.2 && fp.densTall < 0.9, `densTall ${fp.densTall}`);
    assert.ok(fp.stemW > 0, `stemW ${fp.stemW}`);
  });

  it('is size-stable: the same text at 4x and 6x scale lands close, and a bolder sample farther', () => {
    const a = fingerprint(textSample('HAMBURGEVONS THE QUICK BROWN FOX', 6));
    const b = fingerprint(textSample('HAMBURGEVONS THE QUICK BROWN FOX', 4));
    assert.equal(distance(a, a), 0);
    const dSame = distance(a, b);
    assert.ok(dSame > 0 && Number.isFinite(dSame), `dSame ${dSame}`);
    // a different sample: same glyph set but drawn twice offset by one scale step, so every stem doubles (a heavier face)
    const heavy = textSample('HAMBURGEVONS THE QUICK BROWN FOX', 6);
    drawText(heavy, 'HAMBURGEVONS THE QUICK BROWN FOX', 20 + 4, 20, [0, 0, 0, 255], 6);
    const c = fingerprint(heavy);
    const dOther = distance(a, c);
    assert.ok(dOther > dSame, `heavier sample (${dOther}) should be farther than a rescale (${dSame})`);
  });

  it('every weighted feature has a positive std, and distance skips features missing on either side', () => {
    for (const k of FEATURES) { assert.ok(STATS[k], `no STATS for ${k}`); assert.ok(STATS[k].std > 0); }
    const a = { advX: 0.5, densTall: 0.5, contrast: 1 }, b = { advX: 0.5, densTall: 0.5, contrast: null };
    assert.equal(distance(a, b), 0);
    assert.equal(distance({}, {}), Infinity);
  });
});

describe('font-index', () => {
  it('packs and unpacks a vector to three decimals, nulls preserved', () => {
    const fp = { advX: 0.3649, densTall: 0.6719, contrast: null, serif: 12.3456 };
    const back = unpackVector(packVector(fp));
    assert.equal(back.advX, 0.365);
    assert.equal(back.densTall, 0.672);
    assert.equal(back.contrast, null);
    assert.equal(back.serif, 12.346);
    assert.equal(back.gap, null, 'absent feature reads as null');
  });

  it('stores only the features the fitted distance weights', () => {
    assert.ok(INDEX_FEATURES.length >= 30);
    for (const k of INDEX_FEATURES) assert.ok(STATS[k].w > 0);
    for (const k of FEATURES) if (STATS[k].w === 0) assert.ok(!INDEX_FEATURES.includes(k), `${k} has zero weight and should not be indexed`);
  });

  it('ships a two-size catalog index under 1 MB with > 2500 entries and the expected keys', () => {
    assert.ok(fs.existsSync(INDEX_PATH), `missing ${INDEX_PATH}`);
    assert.ok(fs.statSync(INDEX_PATH).size < 1024 * 1024, 'index over 1 MB');
    const index = loadFontIndex();
    assert.ok(index.entries.length > 2500, `entries ${index.entries.length}`);
    assert.deepEqual([...index.sizes].sort((a, b) => a - b), [14, 48]);
    assert.deepEqual(index.features, INDEX_FEATURES);
    for (const e of index.entries.slice(0, 50)) {
      for (const k of ['family', 'weight', 'category', 'variable', 'fp']) assert.ok(k in e, `entry missing ${k}`);
      assert.ok(['sans', 'serif', 'display', 'handwriting', 'mono'].includes(e.category), e.category);
      assert.ok(e.fp[48], 'no 48px vector');
      for (const k of INDEX_FEATURES) assert.ok(k in e.fp[48]);
    }
    const lg = index.entries.find((e) => e.family === 'League Gothic');
    assert.ok(lg && lg.fp[48] && lg.fp[14], 'League Gothic at both sizes');
    assert.ok(lg.fp[48].advX < 0.45, `League Gothic reads condensed: advX ${lg.fp[48].advX}`);
    const with14 = index.entries.filter((e) => e.fp[14]).length;
    assert.ok(with14 > 2500, `14px vectors ${with14}`);
  });

  it('routes candidate selection by cap height and returns 25 entries', () => {
    const index = loadFontIndex();
    const lg = index.entries.find((e) => e.family === 'League Gothic');
    assert.equal(routeSize(72), 48);
    assert.equal(routeSize(ROUTE_CAP_PX - 1), 14);
    const big = candidatesFromIndex({ ...lg.fp[48], capHeightPx: 72 }, index, { n: 25 });
    assert.equal(big.length, 25);
    assert.equal(big[0].family, 'League Gothic');
    assert.equal(big[0].size, 48);
    const small = candidatesFromIndex({ ...lg.fp[14], capHeightPx: 14 }, index, { n: 25 });
    assert.equal(small.length, 25);
    assert.equal(small[0].family, 'League Gothic');
    assert.equal(small[0].size, 14);
    for (const c of big) for (const k of ['family', 'weight', 'category', 'variable', 'd', 'size']) assert.ok(k in c);
    const sans = candidatesFromIndex({ ...lg.fp[48], capHeightPx: 72 }, index, { n: 10, category: 'serif' });
    assert.equal(sans.length, 10);
    assert.ok(sans.every((c) => c.category === 'serif'));
  });
});

describe('font-match', () => {
  it('reads width and weight classes off the v2 features with catalog-anchored thresholds', () => {
    const index = loadFontIndex();
    const at = (family, weight) => index.entries.find((e) => e.family === family && e.weight === weight).fp[48];
    assert.equal(widthClass(at('League Gothic', 400)), 'compressed');
    assert.equal(widthClass(at('Oswald', 700)), 'condensed');
    assert.equal(widthClass(at('Inter', 400)), 'normal');
    assert.equal(widthClass(at('Archivo Black', 400)), 'wide');
    assert.equal(weightClass(at('Lato', 300)), 'light');
    assert.equal(weightClass(at('Inter', 400)), 'regular');
    assert.equal(weightClass(at('Roboto', 700)), 'bold');
    assert.equal(weightClass(at('Anton', 400)), 'black');
    // all-caps crop: falls through to advTall
    assert.equal(widthClass({ advX: null, advTall: 0.48 }), 'condensed');
    assert.equal(weightClass({ densTall: null, densX: null, stemW: 0.09 }), 'light');
  });

  it('selects candidates from the index, keeps the caller names first, and uses the shortlist only without an index', () => {
    const index = loadFontIndex();
    const lg = { ...index.entries.find((e) => e.family === 'League Gothic').fp[48], capHeightPx: 72 };
    const own = [{ family: 'Bebas Neue', weight: 400 }];
    const r = selectCandidates(lg, { own, index, n: 25 });
    assert.equal(r.source, 'index');
    assert.equal(r.candidates[0].family, 'Bebas Neue');
    assert.equal(r.catalog.length, 25);
    assert.ok(r.candidates.length >= 25 && r.candidates.length <= 26);
    assert.ok(!r.candidates.some((c) => SHORTLIST.wide.includes(`${c.family}:${c.weight}`)), 'shortlist must not leak in when the index is present');
    const noIdx = selectCandidates(lg, { own, index: null });
    assert.equal(noIdx.source, 'shortlist');
    assert.ok(noIdx.candidates.some((c) => c.family === 'Six Caps'), 'compressed shortlist used');
  });

  it('renders and ranks candidates against a League Gothic sample (browser)', { skip: !hasPlaywright && 'playwright not resolvable' }, async () => {
    const results = await renderCandidates([{ family: 'League Gothic', weight: 400 }, { family: 'Inter', weight: 400 }], 'The manuals stop.', 48);
    assert.ok(results, 'no browser');
    const ok = results.filter((r) => r.loaded && r.fp);
    if (ok.length < 2) return; // offline: Google Fonts unreachable
    const index = loadFontIndex();
    const lg = index.entries.find((e) => e.family === 'League Gothic').fp[48];
    const inter = index.entries.find((e) => e.family === 'Inter' && e.weight === 400).fp[48];
    const rLg = ok.find((r) => r.family === 'League Gothic'), rIn = ok.find((r) => r.family === 'Inter');
    assert.ok(distance(rLg.fp, lg) < distance(rLg.fp, inter), 'rendered League Gothic is nearer its own index entry');
    assert.ok(distance(rIn.fp, inter) < distance(rIn.fp, lg), 'rendered Inter is nearer its own index entry');
  });
});
