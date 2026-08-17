import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../skill/scripts/lib/png.mjs';
import { createImage, fillRect, blit, resize, drawText } from '../skill/scripts/lib/raster.mjs';
import { gridToBox, measureRegions, platePrompt } from '../skill/scripts/comp-spec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_SCRIPT = path.join(ROOT, 'skill', 'scripts', 'comp-spec.mjs');
const PHASE_SCRIPT = path.join(ROOT, 'skill', 'scripts', 'build-phase.mjs');
const FONT_SCRIPT = path.join(ROOT, 'skill', 'scripts', 'font-match.mjs');

function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff); }

function makeComp(w = 640, h = 400) {
  const img = createImage(w, h, [240, 237, 226, 255]);
  fillRect(img, 0, 0, w, 40, [19, 33, 48, 255]);
  // two lines of block lettering (raster.mjs bitmap font) so the headline
  // region measures as type: cap ~40px at scale 5
  drawText(img, 'KEEP OLD', 20, 52, [19, 33, 48, 255], 4);
  drawText(img, 'IRON', 20, 88, [19, 33, 48, 255], 4);
  const rnd = lcg(3);
  for (let y = 40; y < 200; y++) for (let x = 320; x < 640; x++) {
    const v = 100 + Math.floor(rnd() * 140);
    const p = (y * w + x) * 4; img.data[p] = v; img.data[p + 1] = v; img.data[p + 2] = v;
  }
  for (let i = 0; i < 3; i++) { fillRect(img, 0, 220 + i * 50, w, 1, [19, 33, 48, 255]); fillRect(img, 20, 232 + i * 50, 300, 12, [19, 33, 48, 255]); }
  return img;
}

function run(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

describe('comp-spec', () => {
  it('parses grid spans into normalized boxes', () => {
    assert.deepEqual(gridToBox('A0:A0'), { x: 0, y: 0, w: 0.1, h: 0.1 });
    assert.deepEqual(gridToBox('E0:J4'), { x: 0.4, y: 0, w: 0.6, h: 0.5 });
    assert.deepEqual(gridToBox('j4:e0'), { x: 0.4, y: 0, w: 0.6, h: 0.5 });
    assert.throws(() => gridToBox('K0:A1'));
  });

  it('measures regions with palette, pixel box, medium, and plate path', () => {
    const comp = makeComp();
    const spec = measureRegions(comp, { allowUncovered: true, regions: [
      { id: 'masthead', kind: 'chrome', grid: 'A0:J0' },
      { id: 'art', kind: 'plate', grid: 'F1:J4', note: 'noise plate' },
    ] }, 'comp.png');
    assert.equal(spec.regions.length, 2);
    const art = spec.regions.find((r) => r.id === 'art');
    assert.equal(art.medium, 'raster');
    assert.equal(art.plate, path.join('assets', 'plates', 'art.png'));
    assert.equal(art.px.x, 320);
    assert.ok(art.palette.length > 0);
    assert.equal(spec.regions[0].medium, 'semantic');
    assert.equal(spec.orientation, 'landscape');
    assert.match(platePrompt(spec, art), /noise plate/);
  });

  it('refuses a code kind whose note describes painted material, unless codeDrawn', () => {
    const comp = makeComp();
    const painted = { id: 'rack', kind: 'chrome', grid: 'F1:J4', note: 'countable four-carburetor technical geometry with blue leaders, an exploded diagram' };
    assert.throws(() => measureRegions(comp, { allowUncovered: true, regions: [painted] }, 'c.png'), /describes painted material/);
    const ok = measureRegions(comp, { allowUncovered: true, regions: [{ ...painted, codeDrawn: true }] }, 'c.png');
    assert.equal(ok.regions[0].kind, 'chrome');
    const table = measureRegions(comp, { allowUncovered: true, regions: [{ id: 'index', kind: 'chrome', grid: 'F1:J4', note: 'ruled discussion table with thread, author, replies columns' }] }, 'c.png');
    assert.equal(table.regions[0].kind, 'chrome');
    const plate = measureRegions(comp, { allowUncovered: true, regions: [{ ...painted, kind: 'plate' }] }, 'c.png');
    assert.equal(plate.regions[0].medium, 'raster');
  });

  it('refuses a regions file that leaves comp ink unnamed, unless allowUncovered', () => {
    const comp = makeComp();
    // only the masthead named: the headline, plate, and list are ink no region covers
    assert.throws(() => measureRegions(comp, { regions: [{ id: 'masthead', kind: 'chrome', grid: 'A0:J0' }] }, 'c.png'), /carry ink no region names/);
    const spec = measureRegions(comp, { allowUncovered: true, regions: [{ id: 'masthead', kind: 'chrome', grid: 'A0:J0' }] }, 'c.png');
    assert.ok(spec.uncoveredInkCells.length > 3);
  });

  it('rejects duplicate ids and missing ids', () => {
    const comp = makeComp();
    assert.throws(() => measureRegions(comp, { regions: [{ id: 'a', grid: 'A0:A0' }, { id: 'a', grid: 'B0:B0' }] }, 'c.png'), /duplicate/);
    assert.throws(() => measureRegions(comp, { regions: [{ grid: 'A0:A0' }] }, 'c.png'), /id/);
  });
});

describe('build-phase comps phase (start --direction)', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-phase-comps-'));
    fs.mkdirSync(path.join(dir, '.impeccable', 'mocks', 'decision'), { recursive: true });
  });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('opens at comps, refuses with fewer than three sidecar\'d comps or no approval, then records the approved comp', () => {
    let res = run(PHASE_SCRIPT, ['start', '--direction', 'abcd1234'], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /BUILD-PHASE COMPS/);
    assert.match(res.stdout, /direction abcd1234/);
    assert.match(res.stdout, /NEXT Comp round/);
    res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /0 comps under/);
    // three comps, one without sidecar, none approved
    const comp = makeComp();
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, '.impeccable', 'mocks', `comp-${n}.png`), encodePng(comp));
    // a decision-round comp must not count
    fs.writeFileSync(path.join(dir, '.impeccable', 'mocks', 'decision', 'card.png'), encodePng(comp));
    fs.writeFileSync(path.join(dir, '.impeccable', 'mocks', 'comp-a.png.json'), JSON.stringify({ prompt: 'a' }));
    fs.writeFileSync(path.join(dir, '.impeccable', 'mocks', 'comp-b.png.json'), JSON.stringify({ prompt: 'b' }));
    res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /no prompt sidecar for: comp-c.png/);
    assert.match(res.stdout, /no comp is approved/);
    fs.writeFileSync(path.join(dir, '.impeccable', 'mocks', 'comp-c.png.json'), JSON.stringify({ prompt: 'c' }));
    fs.writeFileSync(path.join(dir, '.impeccable', 'mocks', 'comp-b.png.json'), JSON.stringify({ prompt: 'b', approved: true }));
    res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 0, res.stdout);
    assert.match(res.stdout, /ADVANCED comps -> spec/);
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.impeccable', 'build', 'state.json'), 'utf8'));
    assert.equal(state.comp, path.join('.impeccable', 'mocks', 'comp-b.png'));
    assert.equal(state.breakpoint, '640x400');
    assert.equal(state.phases.comps.status, 'closed');
  });

  it('start --comp skips the comps phase and records why', () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-phase-comps2-'));
    fs.writeFileSync(path.join(d2, 'comp.png'), encodePng(makeComp()));
    const res = run(PHASE_SCRIPT, ['start', '--comp', 'comp.png'], d2);
    assert.equal(res.status, 0, res.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(d2, '.impeccable', 'build', 'state.json'), 'utf8'));
    assert.equal(state.phase, 'spec');
    assert.equal(state.phases.comps.status, 'skipped');
    fs.rmSync(d2, { recursive: true, force: true });
  });
});

describe('build-phase state machine (CLI)', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-phase-'));
    fs.writeFileSync(path.join(dir, 'comp.png'), encodePng(makeComp()));
    fs.writeFileSync(path.join(dir, 'regions.json'), JSON.stringify({ regions: [
      { id: 'masthead', kind: 'chrome', grid: 'A0:J0' },
      { id: 'headline', kind: 'text', grid: 'A1:D2' },
      { id: 'art', kind: 'plate', grid: 'F1:J4', note: 'noise plate' },
      { id: 'list', kind: 'control', grid: 'A5:J9' },
    ] }));
  });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('start writes state at spec and prints NEXT', () => {
    const res = run(PHASE_SCRIPT, ['start', '--comp', 'comp.png'], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /BUILD-PHASE SPEC/);
    assert.match(res.stdout, /NEXT Measure the comp/);
    assert.ok(fs.existsSync(path.join(dir, '.impeccable', 'build', 'state.json')));
  });

  it('spec gate fails without a spec, passes once comp-spec wrote one', () => {
    let res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /GATE SPEC FAILED/);
    res = run(SPEC_SCRIPT, ['--comp', 'comp.png', '--grid'], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(fs.existsSync(path.join(dir, '.impeccable', 'build', 'comp-grid.png')));
    res = run(SPEC_SCRIPT, ['--comp', 'comp.png', '--regions', 'regions.json'], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /PLATES 1 to produce: art/);
    // type must be measured before spec closes
    res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 2, res.stdout);
    assert.match(res.stdout, /measure the type before closing the spec/);
    res = run(FONT_SCRIPT, ['--measure', 'headline'], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /MEASURE headline/);
    // a face typed straight into spec.json is refused: only font-match's own
    // stamped choice closes the spec
    const specFile = path.join(dir, '.impeccable', 'build', 'spec.json');
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    const head = spec.regions.find((r) => r.id === 'headline');
    assert.ok(head.type && head.type.comp, 'the test comp headline measures as type');
    {
      head.type.chosen = { family: 'Arial Narrow', weight: 700, fontSizePx: 40, source: 'system-fallback' };
      fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
      res = run(PHASE_SCRIPT, ['advance'], dir);
      assert.equal(res.status, 2, res.stdout);
      assert.match(res.stdout, /font-match did not write/);
      // no browser in the test env either way: --rank records the catalog's nearest face, stamped
      res = run(FONT_SCRIPT, ['--rank', 'headline', '--text', 'HEADLINE'], dir);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /USE font-family/);
      const after = JSON.parse(fs.readFileSync(specFile, 'utf8')).regions.find((r) => r.id === 'headline');
      assert.ok(after.type.chosen && after.type.chosen.stamp, 'font-match stamps its choice');
    }
    res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /ADVANCED spec -> plates/);
  });

  it('plates gate names the missing plate, rejects a comp-size crop, accepts a 2x plate', () => {
    let res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /plate missing for art/);
    // force without the user's words is refused; with them it is recorded
    res = run(PHASE_SCRIPT, ['advance', '--force', '--reason', 'single-file HTML delivery requires embedded CSS'], dir);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /--force refused/);
    // comp-size crop: too small
    res = run(SPEC_SCRIPT, ['--crop', 'art', '--out', 'assets/plates/art.png'], dir);
    assert.equal(res.status, 0, res.stderr);
    res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /needs at least 480px/);
    // 2x crop passes size and similarity
    res = run(SPEC_SCRIPT, ['--crop', 'art', '--scale', '2', '--out', 'assets/plates/art.png'], dir);
    assert.equal(res.status, 0, res.stderr);
    res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 0, res.stdout);
    assert.match(res.stdout, /ADVANCED plates -> hero/);
  });

  it('hero gate fails on a flat build and passes on a faithful one, recording attempts', () => {
    const comp = makeComp();
    const flat = createImage(comp.width, comp.height, [240, 237, 226, 255]);
    fillRect(flat, 0, 0, comp.width, 40, [19, 33, 48, 255]);
    fs.mkdirSync(path.join(dir, '.impeccable', 'review'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.impeccable', 'review', 'hero-repro.png'), encodePng(flat));
    // no source references the plate yet: refused before any diff runs
    let res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 2, res.stdout);
    assert.match(res.stdout, /not referenced by any source file/);
    fs.writeFileSync(path.join(dir, 'index.html'), '<img src="assets/plates/art.png" alt="">');
    res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 2, res.stdout);
    assert.match(res.stdout, /GATE HERO FAILED/);
    assert.match(res.stdout, /region art is missing/);
    assert.ok(fs.existsSync(path.join(dir, '.impeccable', 'review', 'diff', 'hero', 'side-by-side.png')));
    // the plates gate recorded the plate on the state
    let st = JSON.parse(fs.readFileSync(path.join(dir, '.impeccable', 'build', 'state.json'), 'utf8'));
    assert.ok(st.plates && st.plates.art && st.plates.art.status === 'ok', 'plate row travels on the state');
    // a passed plate that IS drawn in the box (a different noise field, so its
    // content re-scores low) is placed material: the hero says placement,
    // never 'missing', and only when the box is off
    const placed = createImage(comp.width, comp.height, [240, 237, 226, 255]);
    fillRect(placed, 0, 0, comp.width, 40, [19, 33, 48, 255]);
    const rnd2 = lcg(11);
    for (let y = 40; y < 200; y++) for (let x = 320; x < 640; x++) { const v = 100 + Math.floor(rnd2() * 140); const q = (y * comp.width + x) * 4; placed.data[q] = v; placed.data[q + 1] = v; placed.data[q + 2] = v; }
    fs.writeFileSync(path.join(dir, '.impeccable', 'review', 'hero-repro.png'), encodePng(placed));
    res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.doesNotMatch(res.stdout, /region art is missing/);
    // faithful: the comp shifted by a few px, captured at 1.5x width
    const shifted = createImage(comp.width, comp.height, [240, 237, 226, 255]);
    blit(shifted, comp, 3, 2);
    fs.writeFileSync(path.join(dir, '.impeccable', 'review', 'hero-repro.png'), encodePng(resize(shifted, comp.width * 1.5, comp.height * 1.5)));
    res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 0, res.stdout);
    assert.match(res.stdout, /ADVANCED hero -> sections/);
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.impeccable', 'build', 'state.json'), 'utf8'));
    assert.equal(state.phases.hero.attempts, 4);
    assert.ok(state.phases.hero.gate.score >= 0.72);
  });

  it('hero gate reports a control whose ink box differs from the comp, and never throws on the report shape', () => {
    const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-phase-ctrl-'));
    // a discrete CTA (a 160x40 button at 40,300) inside a larger control region;
    // the build renders it half-height. Rules that span the region are erased so
    // the comp's ink box is the button, not the region clipped.
    const comp = makeComp();
    fillRect(comp, 0, 200, 320, 200, [240, 237, 226, 255]);
    fillRect(comp, 40, 300, 160, 40, [19, 33, 48, 255]);
    fs.writeFileSync(path.join(d4, 'comp.png'), encodePng(comp));
    fs.writeFileSync(path.join(d4, 'regions.json'), JSON.stringify({ allowUncovered: true, regions: [
      { id: 'masthead', kind: 'chrome', grid: 'A0:J0' },
      { id: 'cta', kind: 'control', box: { x: 0, y: 0.5, w: 0.5, h: 0.5 } },
    ] }));
    run(PHASE_SCRIPT, ['start', '--comp', 'comp.png', '--artifact', 'index.html'], d4);
    run(SPEC_SCRIPT, ['--comp', 'comp.png', '--regions', 'regions.json'], d4);
    run(PHASE_SCRIPT, ['advance'], d4);
    run(PHASE_SCRIPT, ['advance'], d4); // no plates
    // makeComp is 640x400; the region is its bottom-left quarter (0..320, 200..400) holding
    // three table rows and the CTA. Shrink the ink there: erase and redraw the rows half-height.
    const build = { ...comp, data: new Uint8Array(comp.data) };
    fillRect(build, 0, 200, 320, 200, [240, 237, 226, 255]);
    fillRect(build, 40, 300, 160, 18, [19, 33, 48, 255]);
    fs.mkdirSync(path.join(d4, '.impeccable', 'review'), { recursive: true });
    fs.writeFileSync(path.join(d4, '.impeccable', 'review', 'hero-repro.png'), encodePng(build));
    fs.writeFileSync(path.join(d4, 'index.html'), '<button>x</button>');
    const res = run(PHASE_SCRIPT, ['advance'], d4);
    assert.doesNotMatch(res.stdout + res.stderr, /TypeError|errored/);
    assert.match(res.stdout, /region cta: its ink sits in a/);
    fs.rmSync(d4, { recursive: true, force: true });
  });

  it('hero gate lists region crops first on failure and refuses a third value-only attempt on the same region', () => {
    // fresh project at hero with a stuck build
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'build-phase-hero-'));
    const comp = makeComp();
    fs.writeFileSync(path.join(d3, 'comp.png'), encodePng(comp));
    fs.writeFileSync(path.join(d3, 'regions.json'), JSON.stringify({ allowUncovered: true, regions: [
      { id: 'masthead', kind: 'chrome', grid: 'A0:J0' },
      { id: 'art', kind: 'plate', grid: 'F1:J4' },
      { id: 'list', kind: 'control', grid: 'A5:J9' },
    ] }));
    run(PHASE_SCRIPT, ['start', '--comp', 'comp.png', '--artifact', 'index.html'], d3);
    run(SPEC_SCRIPT, ['--comp', 'comp.png', '--regions', 'regions.json'], d3);
    run(PHASE_SCRIPT, ['advance'], d3);
    run(SPEC_SCRIPT, ['--crop', 'art', '--scale', '2', '--out', 'assets/plates/art.png'], d3);
    run(PHASE_SCRIPT, ['advance'], d3);
    fs.writeFileSync(path.join(d3, 'index.html'), '<img src="assets/plates/art.png"><style>.a{padding:1px}</style>');
    const flat = createImage(comp.width, comp.height, [240, 237, 226, 255]);
    fillRect(flat, 0, 0, comp.width, 40, [19, 33, 48, 255]);
    fs.mkdirSync(path.join(d3, '.impeccable', 'review'), { recursive: true });
    fs.writeFileSync(path.join(d3, '.impeccable', 'review', 'hero-repro.png'), encodePng(flat));
    let res;
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(d3, 'index.html'), `<img src="assets/plates/art.png"><style>.a{padding:${i + 1}px}</style>`);
      res = run(PHASE_SCRIPT, ['advance'], d3);
      assert.equal(res.status, 2);
    }
    assert.match(res.stdout, /LOOK FIRST/);
    assert.match(res.stdout, /regions\/art\.png/);
    assert.match(res.stdout, /three attempts/);
    fs.rmSync(d3, { recursive: true, force: true });
  });

  it('later phases advance without a gate; force is recorded; finish records the disposition', () => {
    for (const from of ['sections', 'motion']) {
      const res = run(PHASE_SCRIPT, ['advance'], dir);
      assert.equal(res.status, 0, res.stdout);
      assert.match(res.stdout, new RegExp(`ADVANCED ${from}`));
    }
    // responsive gate: needs desktop.png + mobile.png, and desktop must read as the comp
    let res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /no \.impeccable\/review\/desktop\.png/);
    const comp = makeComp();
    const wide = createImage(1440, 900, [240, 237, 226, 255]);
    blit(wide, resize(comp, 1440, 900), 0, 0);
    fs.writeFileSync(path.join(dir, '.impeccable', 'review', 'desktop.png'), encodePng(wide));
    fs.writeFileSync(path.join(dir, '.impeccable', 'review', 'mobile.png'), encodePng(resize(comp, 390, 600)));
    res = run(PHASE_SCRIPT, ['advance'], dir);
    assert.equal(res.status, 0, res.stdout);
    assert.match(res.stdout, /ADVANCED responsive -> review/);
    res = run(PHASE_SCRIPT, ['finish', '--disposition', 'fix'], dir);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /finish      fix/);
    res = run(PHASE_SCRIPT, ['status', '--json'], dir);
    const state = JSON.parse(res.stdout);
    assert.equal(state.phase, 'review');
    assert.equal(state.finish.disposition, 'fix');
  });

  it('refuses a bad disposition and an unknown command', () => {
    assert.equal(run(PHASE_SCRIPT, ['finish', '--disposition', 'great'], dir).status, 1);
    assert.equal(run(PHASE_SCRIPT, ['dance'], dir).status, 1);
  });
});
