import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createImage, fillRect, drawText } from '../skill/scripts/lib/raster.mjs';
import { textRegionCheck, chromeStripCheck, inventedInk, ruleRows, inkColor } from '../skill/scripts/lib/hero-checks.mjs';

const paper = [235, 232, 220, 255], ink = [20, 20, 20, 255];
function textCrop({ scale = 4, lines = 2, color = ink, y0 = 20, x0 = 12, w = 460, h = 200 } = {}) {
  const img = createImage(w, h, paper);
  for (let i = 0; i < lines; i++) drawText(img, 'KEEP OLD IRON', x0, y0 + i * (scale * 9), color, scale);
  return img;
}

describe('hero-checks: text regions', () => {
  const region = { id: 'headline', kind: 'text', type: { chosen: { family: 'Six Caps', weight: 400, fontSizePx: 40 } } };
  it('says nothing when the build sets the type as the comp does', () => {
    const { findings } = textRegionCheck(region, textCrop(), textCrop());
    assert.deepEqual(findings, []);
  });
  it('names a cap-height miss with the ranked face and size', () => {
    const { findings } = textRegionCheck(region, textCrop({ scale: 4 }), textCrop({ scale: 6, lines: 2 }));
    assert.ok(findings.some((f) => /cap height .*px in the build, .*px in the comp/.test(f) && /Six Caps 400 at 40px/.test(f)), findings.join('\n'));
  });
  it('names a different line count', () => {
    const { findings } = textRegionCheck(region, textCrop({ lines: 3 }), textCrop({ lines: 2 }));
    assert.ok(findings.some((f) => /2 lines in the build, 3 in the comp/.test(f)), findings.join('\n'));
  });
  it('names a colour change and a vertical shift', () => {
    const { findings } = textRegionCheck(region, textCrop(), textCrop({ color: [180, 40, 30, 255], y0: 80 }));
    assert.ok(findings.some((f) => /ink is #/.test(f)), findings.join('\n'));
    assert.ok(findings.some((f) => /starts 60px lower/.test(f)), findings.join('\n'));
  });
  it('stays quiet on rotated or unmeasurable comp crops', () => {
    const blank = createImage(300, 300, paper);
    assert.deepEqual(textRegionCheck(region, blank, textCrop()).findings, []);
  });
});

describe('hero-checks: chrome strips and invented ink', () => {
  it('reads a strip height off its rule', () => {
    const mk = (ruleY) => { const img = createImage(800, 100, paper); fillRect(img, 0, ruleY, 800, 2, ink); drawText(img, 'THREADS GARAGE', 20, 12, ink, 2); return img; };
    assert.deepEqual(ruleRows(mk(60)), [59]); // the edge row above the rule
    const { findings } = chromeStripCheck({ id: 'masthead', kind: 'chrome' }, mk(44), mk(70));
    assert.ok(findings.some((f) => /43px into the box in the comp and 69px in the build/.test(f)), findings.join('\n'));
    assert.deepEqual(chromeStripCheck({ id: 'masthead', kind: 'chrome' }, mk(44), mk(47)).findings, []);
  });
  it('lists cells where the build carries ink over a calm comp', () => {
    const comp = createImage(1000, 1000, paper);
    const build = createImage(1000, 1000, paper);
    drawText(build, 'SECTION KICKER', 20, 20, ink, 3);
    fillRect(build, 100, 500, 800, 2, ink);
    const r = inventedInk(comp, build);
    assert.ok(r.cells.length >= 3, `cells ${r.cells.length}`);
    assert.ok(r.cells.some((c) => c.row === 0), 'the kicker row');
    assert.deepEqual(inventedInk(comp, comp).cells, []);
  });
  it('inkColor separates ink from ground', () => {
    const c = inkColor(textCrop({ color: [180, 40, 30, 255] }));
    assert.ok(c.ink && /^#[0-9a-f]{6}$/.test(c.ink.hex));
  });
});
