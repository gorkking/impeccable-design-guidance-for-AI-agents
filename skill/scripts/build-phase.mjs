#!/usr/bin/env node
/**
 * build-phase: the comp-led build as a state machine on disk, so the phases
 * new-work.md names are gated by scripts instead of remembered by the model.
 *
 * State lives at .impeccable/build/state.json. Phases, in order:
 *
 *   comps     the comp round: three comps of the chosen direction under
 *             .impeccable/mocks/ with prompt sidecars, one approved by the
 *             user (sidecar "approved": true). Skipped when start names an
 *             approved --comp (a surface round already locked one).
 *   spec      the approved comp is measured (comp-spec.mjs wrote spec.json)
 *   plates    every raster region in the spec has its plate on disk
 *   hero      the first viewport is reproduced: comp-diff of hero-repro.png
 *             against the comp clears the gate
 *   sections  the rest of the surface is built inside the spec's system
 *   motion    interaction, reveals, motion
 *   responsive the other viewports
 *   review    the finish reviewer ran; disposition recorded
 *
 *   node build-phase.mjs start --comp <approved.png> [--breakpoint 1440x900] [--artifact index.html]
 *   node build-phase.mjs start --direction <seed key>      # no comp yet: opens the comps phase first
 *   node build-phase.mjs status                # human-readable, plus NEXT line
 *   node build-phase.mjs status --json
 *   node build-phase.mjs advance               # try to close the current phase; runs its gate
 *   node build-phase.mjs advance --force --reason "<why>"   # skip a gate; recorded, never silent
 *   node build-phase.mjs record hero --build .impeccable/review/hero-repro.png   # run the hero gate explicitly
 *   node build-phase.mjs note "<text>"         # append a note to the current phase
 *   node build-phase.mjs finish --disposition ship|fix|rebuild|recapture
 *
 * Gates:
 *   comps     -> >= 3 comp rasters (png/webp/jpg) directly under
 *                .impeccable/mocks/ (decision/ excluded), each with a .json
 *                sidecar, and exactly one sidecar carrying "approved": true;
 *                closing records that file as the state's comp.
 *   spec      -> spec.json exists and has >= 1 region
 *   plates    -> every region with medium raster has its plate file, decodable,
 *                at least 1.5x the comp region's pixel width (textures
 *                exempt), and reads as the region against the masked comp
 *                crop: structure >= PLATE_STRUCTURE_MIN and comp-diff overall
 *                >= PLATE_MIN (textures: palette + grain only). Structure is
 *                the floor because it is what a wrong-but-busy plate cannot
 *                fake: noise, a mirror, a mosaic, another region all keep
 *                the palette and the energy and lose structure. A missing
 *                or thin plate names itself.
 *   hero      -> every plate is referenced by a source file (the artifact
 *                named at start, else a bounded walk of the project), and
 *                .impeccable/review/hero-repro.png exists and comp-diff overall
 *                >= HERO_MIN (default 0.72) with no region `missing`. The
 *                score, the report path, and the attempt count are recorded.
 *   responsive -> .impeccable/review/desktop.png and mobile.png exist, and
 *                the desktop capture still scores >= RESPONSIVE_MIN against
 *                the comp with no region missing: a first viewport that only
 *                holds at the comp's exact width is not built.
 *   sections / motion -> no mechanical gate; advancing records the moment,
 *                and the finish reviewer reads the timeline.
 *
 * Exit codes: 0 ok / advanced, 2 gate failed (state unchanged, reasons
 * printed), 1 usage.
 *
 * Nothing here needs a browser. Screenshots come from the harness; this
 * script only measures them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { decodePng, loadRaster } from './lib/png.mjs';
const require = createRequire(import.meta.url);
import { crop, createImage, blit } from './lib/raster.mjs';
import { compare, verdictFor } from './comp-diff.mjs';
import { SPEC_PATH, BUILD_DIR, loadSpec, plateReference } from './comp-spec.mjs';
import { choiceStamped } from './font-match.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STATE_PATH = path.join(BUILD_DIR, 'state.json');
export const PHASES = ['comps', 'spec', 'plates', 'hero', 'sections', 'motion', 'responsive', 'review'];
export const MOCKS_DIR = path.join('.impeccable', 'mocks');
export const HERO_MIN = 0.72;
export const RESPONSIVE_MIN = 0.65;
export const PLATE_MIN = 0.4;
export const PLATE_STRUCTURE_MIN = 0.4;
export const HERO_REPRO = path.join('.impeccable', 'review', 'hero-repro.png');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);
const now = () => new Date().toISOString();

/** The recorded build path (config.local.json over config.json), or null. */
export function readBuildPath(cwd = process.cwd()) {
  let value = null;
  for (const name of ['config.json', 'config.local.json']) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(cwd, '.impeccable', name), 'utf8'));
      if (raw?.buildPath === 'comp' || raw?.buildPath === 'code') value = raw.buildPath;
    } catch { /* absent */ }
  }
  return value;
}

/**
 * Whether a direction was dealt and the build never started, or started and
 * stopped before the hero gate: the condition context.mjs and detect.mjs
 * report as COMP_ROUND_OPEN when page code exists. Returns null when the
 * build path is code-led (no round owed) or nothing is pending.
 */
export function compRoundOpen(cwd = process.cwd()) {
  const buildPath = readBuildPath(cwd);
  if (buildPath === 'code') return null;
  const pending = path.join(cwd, BUILD_DIR, 'pending.json');
  const statePath = path.join(cwd, STATE_PATH);
  if (fs.existsSync(pending) && !fs.existsSync(statePath)) return { reason: 'a direction was chosen (concept-seed rolled) but build-phase.mjs start never ran', pending };
  if (fs.existsSync(statePath)) {
    try {
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const idx = PHASES.indexOf(st.phase);
      if (idx !== -1 && idx <= PHASES.indexOf('hero') && st.phases?.comps?.status !== 'skipped' && st.phases?.comps?.status !== 'closed') return { reason: `build-phase is at ${st.phase}; the comps phase never closed`, state: statePath };
      if (idx !== -1 && idx <= PHASES.indexOf('hero')) return { reason: `build-phase is at ${st.phase}; the hero gate has not passed`, state: statePath };
    } catch { /* unreadable: say nothing */ }
  }
  return null;
}

export function loadState(statePath = STATE_PATH) {
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

export function saveState(state, statePath = STATE_PATH) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function newState({ comp = null, breakpoint = null, artifact = null, direction = null }) {
  const first = comp ? 'spec' : 'comps';
  const phases = Object.fromEntries(PHASES.map((p) => [p, { status: p === first ? 'open' : 'pending', openedAt: p === first ? now() : null, closedAt: null, attempts: 0, notes: [], gate: null, forced: null }]));
  if (comp) { phases.comps.status = 'skipped'; phases.comps.notes.push({ at: now(), text: 'started with an approved comp; the comp round happened before this state (surface round or manual)' }); }
  return {
    tool: 'build-phase',
    version: 2,
    startedAt: now(),
    comp,
    direction,
    breakpoint,
    artifact,
    phase: first,
    phases,
    finish: null,
  };
}

// ---- gates -----------------------------------------------------------------

/** Comp rasters directly under the mocks dir, with their sidecars. */
export function listComps(mocksDir = MOCKS_DIR) {
  if (!fs.existsSync(mocksDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(mocksDir)) {
    if (!/\.(png|webp|jpe?g)$/i.test(name)) continue;
    const file = path.join(mocksDir, name);
    if (!fs.statSync(file).isFile()) continue;
    const sidecarPath = `${file}.json`;
    let sidecar = null;
    if (fs.existsSync(sidecarPath)) { try { sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); } catch { sidecar = null; } }
    out.push({ file, sidecarPath, sidecar, approved: !!(sidecar && sidecar.approved === true) });
  }
  return out;
}

export function gateComps(state, { mocksDir = MOCKS_DIR } = {}) {
  const comps = listComps(mocksDir);
  const reasons = [];
  if (comps.length < 3) reasons.push(`${comps.length} comp${comps.length === 1 ? '' : 's'} under ${mocksDir}; the comp round puts three compositional options of the chosen direction in front of the user (reference/visualize.md). Generate the missing ones (harness image tool or generate-image.mjs), each with a .json sidecar holding its prompt.`);
  const noSidecar = comps.filter((c) => !c.sidecar);
  if (noSidecar.length) reasons.push(`no prompt sidecar for: ${noSidecar.map((c) => path.basename(c.file)).join(', ')} (write <file>.json with { "prompt": "..." }; generate-image.mjs does this itself)`);
  const approved = comps.filter((c) => c.approved);
  if (approved.length === 0) reasons.push('no comp is approved: put the three comps in front of the user (decision page via serve-question.mjs, or the structured question tool), then set "approved": true in the chosen comp\'s sidecar. A delegated pick is recorded the same way and disclosed.');
  if (approved.length > 1) reasons.push(`${approved.length} comps carry "approved": true; exactly one is the approved comp: ${approved.map((c) => path.basename(c.file)).join(', ')}`);
  return { ok: reasons.length === 0, reasons, summary: `${comps.length} comps, ${approved.length} approved`, approved: approved.length === 1 ? approved[0].file : null };
}

export function gateSpec(state, { specPath = SPEC_PATH } = {}) {
  const spec = loadSpec(specPath);
  if (!spec) return { ok: false, reasons: [`no spec at ${specPath}: run comp-spec.mjs --comp ${state.comp} --grid, name the regions, then --regions regions.json`] };
  if (!spec.regions || spec.regions.length < 1) return { ok: false, reasons: ['spec has no regions'] };
  if (spec.comp && state.comp && path.resolve(spec.comp) !== path.resolve(state.comp)) {
    return { ok: false, reasons: [`spec measures ${spec.comp}, but this build started on ${state.comp}; re-run comp-spec on the approved comp`] };
  }
  const plates = spec.regions.filter((r) => r.medium === 'raster').length;
  // Type is measured, not guessed: the largest text region must carry a
  // font-match measurement and a ranked choice before page code exists.
  // Three of six misses a human called on a first-round build were the
  // headline face wider and lighter than the comp's, the parts list smaller,
  // the footer heavier: ratios font-match reads off pixels.
  // The lead text region is the display type: the region whose measured cap
  // height is largest (a headline), not the biggest box (a table of rows).
  // Unmeasured regions sort by box height as a proxy until measured.
  const textRegions = spec.regions.filter((r) => r.kind === 'text').sort((a, b) => {
    const ca = a.type && a.type.comp ? a.type.comp.capHeightPx : a.px.h * 0.4;
    const cb = b.type && b.type.comp ? b.type.comp.capHeightPx : b.px.h * 0.4;
    return cb - ca;
  });
  const reasons = [];
  if (textRegions.length) {
    // when nothing is measured yet, ask for all measurements first; the lead
    // is only knowable once cap heights exist
    const anyMeasured = textRegions.some((r) => r.type);
    if (!anyMeasured) {
      reasons.push(`measure the type before closing the spec: node ${HERE}/font-match.mjs --measure <id> for each text region (${textRegions.map((r) => r.id).join(', ')}); the region with the largest cap height is the lead and gets --rank.`);
      return { ok: false, reasons };
    }
    const measurable = textRegions.filter((r) => r.type && r.type.comp);
    const lead = measurable[0] || textRegions[0];
    if (!lead.type) reasons.push(`the lead text region ${lead.id} has no type measurement: run node ${HERE}/font-match.mjs --measure ${lead.id} (and --rank ${lead.id} --text "<its first words>" to choose the face by metrics). Set font-size from the printed cap height; do not pick a face by name.`);
    else if (lead.type.comp && !lead.type.chosen) reasons.push(`the lead text region ${lead.id} is measured (${lead.type.widthClass} ${lead.type.weightClass}, cap ${lead.type.comp.capHeightPx}px) but no face is ranked: run node ${HERE}/font-match.mjs --rank ${lead.id} --text "<its first words>" [--candidates "Family:weight,..."] and use the USE line.`);
    else if (lead.type.comp && lead.type.chosen && !choiceStamped(lead.id, lead.type.chosen)) reasons.push(`the lead text region ${lead.id} carries a "chosen" face that font-match did not write (${lead.type.chosen.family || '?'}). A face typed into spec.json is the guess this gate exists to refuse; run node ${HERE}/font-match.mjs --rank ${lead.id} --text "<its first words>" and let it record the choice (with no browser it records the catalog's nearest face).`);
    const unmeasured = textRegions.slice(1).filter((r) => !r.type).map((r) => r.id);
    if (unmeasured.length && !reasons.length) reasons.push(`measure the other text regions too, each sets its own font-size and weight class: node ${HERE}/font-match.mjs --measure <id> for ${unmeasured.join(', ')}`);
  }
  if (reasons.length) return { ok: false, reasons };
  return { ok: true, reasons: [], summary: `${spec.regions.length} regions, ${plates} plates, ${textRegions.length} text regions measured` };
}

/**
 * The one plate rule, shared by the plates gate and generate-image's
 * PLATE-WARN so they never disagree. `score` is compare().whole against the
 * masked comp crop under cover alignment.
 */
export function plateVerdict(region, score) {
  const isTexture = region.kind === 'texture';
  const reasons = [];
  if (isTexture) {
    const effective = 0.5 * score.color + 0.5 * Math.min(1, score.detail / 0.6);
    if (effective < PLATE_MIN) reasons.push(`scores ${(effective * 100).toFixed(0)}% as the material of region ${region.id} (color ${(score.color * 100).toFixed(0)}%, detail ${(score.detail * 100).toFixed(0)}%); crop a clean patch of the comp region (comp-spec.mjs --crop ${region.id} --raw) and mirror-tile it, generate only when no clean patch exists`);
    return { ok: reasons.length === 0, reasons, effective };
  }
  // Added detail is invented material only when the comp region is calm;
  // a paper sleeve is grainy in the comp too, and its plate is allowed the
  // same grain. Comp energy travels on the region (comp-spec's detail.energy).
  const compCalm = !region.detail || region.detail.energy < 12;
  if (compCalm && score.detailAdded > 0.45) reasons.push(`carries detail the comp region ${region.id} does not have (added-detail ${(score.detailAdded * 100).toFixed(0)}% of cells): noise, grain, or a busier subject where the comp is calm; regenerate from the crop reference without adding texture`);
  if (score.structure < PLATE_STRUCTURE_MIN) reasons.push(`structure ${(score.structure * 100).toFixed(0)}% against the comp region ${region.id}: the composition of the plate is not the region's (different subject, orientation, or crop); regenerate with comp-spec.mjs --crop ${region.id} as the reference image`);
  if (score.overall < PLATE_MIN) reasons.push(`scores ${(score.overall * 100).toFixed(0)}% against the comp region ${region.id} (structure ${(score.structure * 100).toFixed(0)}%, color ${(score.color * 100).toFixed(0)}%, detail ${(score.detail * 100).toFixed(0)}%); regenerate with the crop as --ref and the comp-spec plate prompt`);
  return { ok: reasons.length === 0, reasons, effective: score.overall };
}

export function gatePlates(state, { specPath = SPEC_PATH } = {}) {
  const spec = loadSpec(specPath);
  if (!spec) return { ok: false, reasons: ['no spec'] };
  const rasterRegions = spec.regions.filter((r) => r.medium === 'raster');
  if (!rasterRegions.length) return { ok: true, reasons: [], summary: 'no plates owed', plates: [] };
  let comp = null;
  try { comp = loadRaster(spec.comp).image; } catch { /* scored without the comp crop below */ }
  const reasons = [], plates = [];
  for (const r of rasterRegions) {
    const file = r.plate;
    if (!file || !fs.existsSync(file)) { reasons.push(`plate missing for ${r.id}: expected ${file || '(no path)'}; produce it from comp-spec.mjs --crop ${r.id} with generate-image.mjs --plate`); plates.push({ id: r.id, file, status: 'missing' }); continue; }
    let img;
    try { img = decodePng(fs.readFileSync(file)); } catch (e) { reasons.push(`plate ${file} is not a decodable PNG: ${e.message}`); plates.push({ id: r.id, file, status: 'unreadable' }); continue; }
    // A texture tiles, so it owes no size floor and no structural match:
    // it is judged on palette and grain only. Every other plate must be at
    // least 1.5x the region (capped at 1536px, the largest size the
    // generators emit; past that the region is a full-bleed field the page
    // scales) and read as the region under object-fit: cover.
    const isTexture = r.kind === 'texture';
    const minW = Math.min(1536, r.px.w * 1.5);
    if (!isTexture && img.width < minW) reasons.push(`plate ${file} is ${img.width}px wide; the comp region is ${r.px.w}px and a shipping plate needs at least ${Math.round(minW)}px. Regenerate at asset size, do not crop the comp.`);
    let score = null;
    if (comp) {
      const ref = plateReference(comp, spec, r);
      // a keyed (alpha) plate ships over the page ground: score it composited
      // over the region's sampled ground, the way it will show
      let build = img;
      let transparent = 0; for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 128) transparent++;
      if (transparent > (img.data.length / 4) * 0.05) {
        const g = (r.palette && r.palette[0] && r.palette[0].hex) || '#ffffff';
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(g);
        const ground = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255] : [255, 255, 255, 255];
        const over = createImage(img.width, img.height, ground);
        blit(over, img, 0, 0);
        build = over;
      }
      const res = compare({ comp: ref, build, align: 'cover', spec: null, kind: r.kind });
      score = res.whole;
      const v = plateVerdict(r, score);
      for (const reason of v.reasons) reasons.push(`plate ${file}: ${reason}`);
    }
    plates.push({ id: r.id, file, status: 'ok', size: `${img.width}x${img.height}`, score: score ? score.overall : null });
  }
  return { ok: reasons.length === 0, reasons, summary: `${plates.filter((p) => p.status === 'ok').length}/${rasterRegions.length} plates`, plates };
}

/** Source files that could reference a plate: bounded walk, skipping deps and build output. */
function sourceFiles(root = '.', limit = 400) {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.svelte-kit', '.impeccable', 'assets', 'coverage']);
  const exts = /\.(html?|css|scss|jsx?|tsx?|svelte|vue|astro|mdx?|php|erb|hbs)$/i;
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.isDirectory()) { if (!skip.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1); }
      else if (exts.test(e.name)) out.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

/** Plates the artifact never references: a plate on disk that no source names ships nothing. */
export function unreferencedPlates(spec, artifact = null) {
  const plates = (spec?.regions || []).filter((r) => r.medium === 'raster' && r.plate);
  if (!plates.length) return [];
  const files = artifact && fs.existsSync(artifact) ? [artifact] : sourceFiles();
  let corpus = '';
  for (const f of files) { try { corpus += fs.readFileSync(f, 'utf8') + '\n'; } catch { /* skip */ } }
  const missing = [];
  for (const r of plates) {
    const base = path.basename(r.plate);
    const stem = base.replace(/\.[a-z0-9]+$/i, '');
    // a data URI inline copy counts when the region id or file stem is named beside it
    if (corpus.includes(base) || (corpus.includes('data:image/') && (corpus.includes(stem) || corpus.includes(r.id)))) continue;
    missing.push(r);
  }
  return missing;
}

/** Organic clip-path findings whose selector's element the artifact places (by class/id name) on a raster region. Cheap heuristic: the finding's selector or the surrounding rule mentions the region id or its plate stem. */
export function organicClipRegions(artifactFile, spec) {
  let scan;
  try {
    const mod = require(path.join(HERE, '..', '..', 'cli', 'engine', 'rules', 'checks.mjs'));
    scan = mod.scanCssTextForOrganicClipPath;
  } catch { scan = null; }
  if (!scan) return [];
  let html = '';
  try { html = fs.readFileSync(artifactFile, 'utf8'); } catch { return []; }
  const findings = scan(html);
  if (!findings.length) return [];
  const rasterRegions = (spec.regions || []).filter((r) => r.medium === 'raster');
  const out = [];
  for (const f of findings) {
    const sel = String(f.selector || '').toLowerCase();
    for (const r of rasterRegions) {
      const stem = path.basename(r.plate || '', path.extname(r.plate || '')).toLowerCase();
      if ((sel && (sel.includes(r.id.toLowerCase()) || (stem && sel.includes(stem)))) || rasterRegions.length === 1) { out.push({ id: r.id, snippet: f.snippet }); break; }
    }
  }
  return out;
}

export function gateHero(state, { buildPath = HERO_REPRO, specPath = SPEC_PATH, min = HERO_MIN, outDir = path.join('.impeccable', 'review', 'diff', 'hero'), artifact = null } = {}) {
  if (!fs.existsSync(buildPath)) return { ok: false, reasons: [`no hero capture at ${buildPath}: screenshot the first viewport at the comp's own dimensions (${state.breakpoint || 'comp size'}) into that path`] };
  const specForRefs = loadSpec(specPath);
  const unreferenced = unreferencedPlates(specForRefs, artifact || state.artifact || null);
  if (unreferenced.length) {
    return { ok: false, reasons: unreferenced.map((r) => `plate ${r.plate} (region ${r.id}) is not referenced by any source file: the page draws that region in code while the produced plate sits unused. Place the plate (an <img>, a background-image, or an inlined data URI named for it) and recapture.`) };
  }
  const script = path.join(HERE, 'comp-diff.mjs');
  const args = [script, '--comp', state.comp, '--build', buildPath, '--out-dir', outDir, '--label', 'hero', '--json'];
  const spec = loadSpec(specPath);
  if (spec) args.push('--spec', specPath);
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (res.status !== 0 && res.status !== 3) return { ok: false, reasons: [`comp-diff failed: ${res.stderr || res.stdout}`] };
  let report;
  try { report = JSON.parse(res.stdout); } catch { return { ok: false, reasons: ['comp-diff produced no report'] }; }
  const reasons = [];
  // The capture must be the comp's own frame: a 1440-wide capture of a
  // 1536x1024 comp is a different composition before anything is compared.
  const [cw, ch] = String(report.compSize || '').split('x').map(Number);
  const [bw, bh] = String(report.buildSize || '').split('x').map(Number);
  if (cw && ch && bw && bh) {
    const compAspect = cw / ch, buildAspect = bw / bh;
    if (bw < cw * 0.9 || Math.abs(buildAspect - compAspect) / compAspect > 0.08) reasons.push(`hero capture is ${bw}x${bh}; the comp is ${cw}x${ch}. Capture the first viewport at the comp's own dimensions (viewport ${cw}x${ch}, not full page) into ${buildPath}.`);
  }
  if (report.overall < min) reasons.push(`hero overall ${(report.overall * 100).toFixed(0)}% < ${(min * 100).toFixed(0)}% (structure ${(report.scores.structure * 100).toFixed(0)}%, color ${(report.scores.color * 100).toFixed(0)}%, detail ${(report.scores.detail * 100).toFixed(0)}%)`);
  if (report.scores.colorIntersection != null && report.scores.colorIntersection < 0.2) reasons.push(`the palette is not the comp's (color intersection ${(report.scores.colorIntersection * 100).toFixed(0)}%): comp ${(report.palette.comp || []).slice(0, 3).map((c) => c.hex).join(' ')} vs build ${(report.palette.build || []).slice(0, 3).map((c) => c.hex).join(' ')}. Use the spec's sampled palette values, not a rendition of them.`);
  // A texture band that shares its box with a text/control region carries
  // that region's ink in the comp crop; when the overlapping ink regions are
  // present in the build, a low detail score on the texture is the ink
  // metric measuring the wrong thing, not missing material.
  const specRegions = specForRefs ? specForRefs.regions : [];
  const overlaps = (a, b) => a.box.x < b.box.x + b.box.w && b.box.x < a.box.x + a.box.w && a.box.y < b.box.y + b.box.h && b.box.y < a.box.y + a.box.h;
  const verdictOf = Object.fromEntries(report.regions.map((r) => [r.id, r.verdict]));
  const missing = report.regions.filter((r) => {
    if (r.verdict !== 'missing') return false;
    if (r.kind !== 'texture') return true;
    const me = specRegions.find((x) => x.id === r.id);
    if (!me) return true;
    const inkOver = specRegions.filter((x) => x.id !== r.id && (x.kind === 'text' || x.kind === 'control' || x.kind === 'chrome') && overlaps(me, x));
    const inkPresent = inkOver.length > 0 && inkOver.every((x) => verdictOf[x.id] && verdictOf[x.id] !== 'missing');
    if (inkPresent) { r.verdict = 'drift'; return false; }
    return true;
  });
  for (const r of missing) reasons.push(`region ${r.id} is missing (detail ${(r.score.detail * 100).toFixed(0)}%, structure ${(r.score.structure * 100).toFixed(0)}%): the comp shows material the build does not`);
  const contradicted = report.regions.filter((r) => r.verdict === 'contradicted');
  // A contradicted plate, image, or text region is the wrong page whatever
  // the mean says; chrome and controls get the one-third allowance.
  const directionContradicted = contradicted.filter((r) => r.kind === 'plate' || r.kind === 'image' || r.kind === 'text');
  for (const r of directionContradicted) reasons.push(`region ${r.id} (${r.kind}) is contradicted (structure ${(r.score.structure * 100).toFixed(0)}%, detail added ${(r.score.detailAdded * 100).toFixed(0)}%): ${r.kind === 'text' ? 'the composition of this text region differs from the comp; re-derive it from the spec box' : 'the plate here does not read as the comp region; regenerate it with the crop as reference (generate-image.mjs --plate ' + r.id + ') and place it at its box'}`);
  // Controls: report the ink box in comp vs build so a button in a 63px row
  // built into a 41px row is named as numbers, not as a drift score.
  for (const r of report.regions) {
    // whatever the region's verdict: a small button in a large region scores
    // match on the region mean while being half its comp height
    if (r.kind !== 'control') continue;
    if (r.inkBox && r.inkBox.comp && r.inkBox.build) {
      // Only when the comp's ink is a discrete element inside its region (a
      // button, a tab), not when it fills the region edge to edge (a control
      // drawn over a plate's edge, a full-width bar): then the box says nothing.
      // report regions carry normalized x/y/w/h at the top level
      const rwN = r.w ?? (r.box && r.box.w) ?? 1, rhN = r.h ?? (r.box && r.box.h) ?? 1;
      const rw = rwN * (report.compSize ? parseInt(String(report.compSize).split('x')[0], 10) : 1536);
      const rh = rhN * (report.compSize ? parseInt(String(report.compSize).split('x')[1], 10) : 1024);
      // A bar that spans the region in either axis is not a discrete
      // control: its ink box is the region box clipped, and the build's
      // box is whatever the region clips there. Comparing the two told one
      // session six times that a 1376x87 strip was 1382x102, and no edit it
      // made could move that number.
      if (r.inkBox.comp.w >= rw * 0.85 || r.inkBox.comp.h >= rh * 0.85) continue;
      const dh = r.inkBox.build.h - r.inkBox.comp.h, dw = r.inkBox.build.w - r.inkBox.comp.w;
      // the build's box is only comparable when it is discrete too
      if (r.inkBox.build.w >= rw * 0.98 || r.inkBox.build.h >= rh * 0.98) continue;
      if (Math.abs(dh) > Math.max(6, r.inkBox.comp.h * 0.15) || Math.abs(dw) > Math.max(12, r.inkBox.comp.w * 0.15)) reasons.push(`region ${r.id}: its ink sits in a ${r.inkBox.comp.w}x${r.inkBox.comp.h}px box in the comp and ${r.inkBox.build.w}x${r.inkBox.build.h}px in the build (padding, row height, or size); match the box, not only the position`);
    }
  }
  const otherContradicted = contradicted.filter((r) => !directionContradicted.includes(r));
  if (otherContradicted.length > Math.max(1, Math.floor(report.regions.length / 3))) reasons.push(`${otherContradicted.length} of ${report.regions.length} regions contradicted: ${otherContradicted.map((r) => r.id).join(', ')}`);
  // A CSS-drawn organic contour sitting on a raster region's box is the plate
  // replaced by code, whatever the pixels score.
  const artifactFile = artifact || state.artifact || null;
  if (artifactFile && fs.existsSync(artifactFile) && specForRefs) {
    const organic = organicClipRegions(artifactFile, specForRefs);
    for (const r of organic) reasons.push(`artifact draws an organic clip-path (${r.snippet}) inside raster region ${r.id}'s box; that region ships as its plate, never as a polygon`);
  }
  const worstRegions = [...report.regions].sort((a, b) => a.score.overall - b.score.overall).slice(0, 3);
  const regionDir = path.join(outDir, 'regions');
  return {
    ok: reasons.length === 0,
    reasons,
    summary: `hero ${(report.overall * 100).toFixed(0)}% (${report.verdict})`,
    score: report.overall,
    verdict: report.verdict,
    report: path.join(outDir, 'report.json'),
    sideBySide: report.files ? report.files.sideBySide : null,
    worst: worstRegions.map((r) => `${r.id} ${r.verdict} ${(r.score.overall * 100).toFixed(0)}%`),
    worstIds: worstRegions.map((r) => r.id),
    worstCrops: worstRegions.map((r) => ({ id: r.id, verdict: r.verdict, score: r.score, file: path.join(regionDir, `${r.id}.png`) })),
    regionVerdicts: Object.fromEntries(report.regions.map((r) => [r.id, r.verdict])),
  };
}

/**
 * The hero attempt loop: after two failed advances where the same region is
 * still missing/contradicted and the artifact changed only in CSS values,
 * refuse a third of the same kind. Missing material is not a layout
 * tolerance problem; the fix is a plate, a placed plate, or a rebuilt region.
 */
export function heroLoopVerdict(state, gate, artifactPath) {
  const p = state.phases.hero;
  const history = p.history || [];
  const entry = { at: now(), score: gate.score ?? null, worstIds: gate.worstIds || [], regionVerdicts: gate.regionVerdicts || {}, artifactHash: hashFile(artifactPath) };
  history.push(entry);
  p.history = history.slice(-6);
  if (history.length < 3) return null;
  const last3 = history.slice(-3);
  const stuck = last3[0].worstIds[0] && last3.every((h) => h.worstIds[0] === last3[0].worstIds[0]);
  const scores = last3.map((h) => h.score ?? 0);
  const noProgress = Math.max(...scores) - Math.min(...scores) < 0.03;
  if (stuck && noProgress) {
    return `region ${last3[0].worstIds[0]} has been the worst region for three attempts and the score moved less than 3 points: value edits are not reaching it. Open ${path.join('.impeccable', 'review', 'diff', 'hero', 'regions', `${last3[0].worstIds[0]}.png`)} and rebuild that region from the comp crop (place its plate, or produce one with generate-image.mjs --plate, or re-derive its structure from the spec box), then recapture.`;
  }
  return null;
}

function hashFile(file) {
  try {
    const crypto = require('node:crypto');
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  } catch { return null; }
}

/**
 * Responsive gate: the desktop capture (whatever common width the build
 * used, 1440 typically) must still read as the comp. A first viewport that
 * only holds at the comp's exact width and collapses to one column 96px
 * narrower passed every earlier gate in the first simulated round.
 */
export function gateResponsive(state, { specPath = SPEC_PATH, min = RESPONSIVE_MIN, outDir = path.join('.impeccable', 'review', 'diff', 'desktop') } = {}) {
  const desktop = path.join('.impeccable', 'review', 'desktop.png');
  const mobile = path.join('.impeccable', 'review', 'mobile.png');
  const reasons = [];
  if (!fs.existsSync(desktop)) reasons.push(`no ${desktop}: capture the page at a common desktop width (1440 wide, full page) into that path`);
  if (!fs.existsSync(mobile)) reasons.push(`no ${mobile}: capture the page at 390 wide, full page, into that path`);
  if (reasons.length) return { ok: false, reasons };
  const script = path.join(HERE, 'comp-diff.mjs');
  const args = [script, '--comp', state.comp, '--build', desktop, '--out-dir', outDir, '--label', 'desktop', '--json'];
  if (loadSpec(specPath)) args.push('--spec', specPath);
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  let report;
  try { report = JSON.parse(res.stdout); } catch { return { ok: false, reasons: [`comp-diff failed on ${desktop}: ${res.stderr || res.stdout}`] }; }
  // A texture read at 1440 differs from itself at 1536 by resampling alone;
  // it passed at the hero and cannot block responsive on its own.
  const missing = report.regions.filter((r) => r.verdict === 'missing' && r.kind !== 'texture');
  // A plate placed and passed at the hero is not re-litigated at 1440: the
  // rescale alone drops SSIM on a busy region. Text can still contradict
  // (a wrapped headline is a different composition).
  const contradictedDirection = report.regions.filter((r) => r.verdict === 'contradicted' && r.kind === 'text');
  if (report.overall < min) reasons.push(`the desktop capture (${report.buildSize}; the top ${report.compSize} rows scaled to the comp's width are compared, a full-page capture is fine) scores ${(report.overall * 100).toFixed(0)}% against the comp, under ${(min * 100).toFixed(0)}%: the first viewport does not survive a common desktop width. The hero passed at ${state.breakpoint || 'the comp size'}; the layout must hold from ~1280 up, not only at the comp's exact width (grid columns in fr / minmax, not fixed px that overflow and wrap).`);
  for (const r of missing) reasons.push(`at desktop width, region ${r.id} is missing`);
  for (const r of contradictedDirection) reasons.push(`at desktop width, region ${r.id} (${r.kind}) is contradicted (structure ${(r.score.structure * 100).toFixed(0)}%)`);
  return { ok: reasons.length === 0, reasons, summary: `desktop ${(report.overall * 100).toFixed(0)}% (${report.verdict})`, score: report.overall, sideBySide: report.files ? report.files.sideBySide : null };
}

const GATES = { comps: gateComps, spec: gateSpec, plates: gatePlates, hero: gateHero, responsive: gateResponsive };

// ---- transitions -----------------------------------------------------------

export function runGate(state, phase, opts = {}) {
  const gate = GATES[phase];
  if (!gate) return { ok: true, reasons: [], summary: 'no mechanical gate' };
  // A gate that throws is a bug in the gate, never a verdict on the build:
  // return it as a refusal that names itself, so the model sees one line
  // and the state stays consistent instead of a stack trace and a half-run.
  try { return gate(state, opts); }
  catch (e) { return { ok: false, reasons: [`gate ${phase} errored (${e.message}); this is a tool bug, not a finding about the page. Re-run with the same inputs; if it repeats, note it and continue with build-phase.mjs advance --force --reason "user: gate ${phase} errored, proceeding" so the run is not lost.`], error: String(e && e.stack || e) }; }
}

/** Reasons a gate may be forced past. The user downgrading the comp's authority
 *  in words is the only one; the parent quotes it. A reason that does not name
 *  the user is a model talking itself past its own gate, and it is refused. */
export function forceAllowed(reason) {
  if (typeof reason !== 'string' || reason.trim().length < 20) return false;
  if (/gate \w+ errored/i.test(reason)) return true;
  const namesUser = /\buser\b|\bthey (said|asked|told|chose|picked)\b|\bpaul\b/i.test(reason);
  // The user must be downgrading the comp itself, not "approving" a
  // translation the model proposed. A reason that keeps the comp's
  // topology/palette while dropping "pixel-level" is a translation, and
  // translation is what the gate measures; it is not a downgrade.
  const aboutComp = /\b(comp|mock|mockup|composition|fidelity|plate|region)\b/i.test(reason);
  const isTranslationDodge = /truthful|semantic|pixel-level|prioriti[sz]e (facts|semantics|accessibility)/i.test(reason) && !/(drop|skip|remove|without|not needed|don't need|do not need|ignore) (the )?(comp|plate|region|fidelity)/i.test(reason);
  return namesUser && aboutComp && !isTranslationDodge;
}

export function advance(state, { force = false, reason = null, gateOpts = {} } = {}) {
  const phase = state.phase;
  const idx = PHASES.indexOf(phase);
  if (idx === -1 || phase === 'review') return { ok: false, reasons: [`phase ${phase} cannot advance; use finish`] };
  const p = state.phases[phase];
  p.attempts += 1;
  const gate = runGate(state, phase, gateOpts);
  const { plates: _p, ...gateRecord } = gate;
  p.gate = { ...gateRecord, at: now() };
  if (!gate.ok && force && !forceAllowed(reason)) {
    p.status = 'open';
    return { ok: false, phase, reasons: [...gate.reasons, `--force refused: "${reason || ''}" does not quote the user downgrading the comp. A single-file deliverable, a missing tool, or difficulty is not a reason; embed the plate as a data URI, produce it with the harness image tool, or ask the user.`], gate };
  }
  if (phase === 'hero' && (gate.score != null)) {
    const stuck = heroLoopVerdict(state, gate, gateOpts.artifact || state.artifact || 'index.html');
    if (stuck && !gate.ok) gate.reasons = [stuck, ...gate.reasons];
  }
  if (!gate.ok && !force) { p.status = 'open'; return { ok: false, phase, reasons: gate.reasons, gate }; }
  if (!gate.ok && force) p.forced = { at: now(), reason, reasons: gate.reasons };
  p.status = 'closed'; p.closedAt = now();
  if (phase === 'comps' && gate.approved) {
    state.comp = gate.approved;
    if (!state.breakpoint) { try { const i = loadRaster(gate.approved).image; state.breakpoint = `${i.width}x${i.height}`; } catch { /* non-png comp: breakpoint stays unset */ } }
  }
  const next = PHASES[idx + 1];
  state.phase = next;
  state.phases[next].status = 'open'; state.phases[next].openedAt = now();
  return { ok: true, phase, next, gate, forced: !!p.forced };
}

export function nextInstruction(state) {
  switch (state.phase) {
    case 'comps': return `Comp round for the chosen direction${state.direction ? ` (seed ${state.direction})` : ''}: read reference/visualize.md, generate three compositional comps of the requested surface at its own viewport into ${MOCKS_DIR}/ (each with a prompt sidecar), put them in front of the user, and set "approved": true in the chosen comp's sidecar. Then build-phase.mjs advance. No page code before this closes.`;
    case 'spec': return `Measure the comp: node comp-spec.mjs --comp ${state.comp} --grid, open ${path.join(BUILD_DIR, 'comp-grid.png')}, write regions.json (every illustration, photo, texture as its own plate region; every text block its own text region), run comp-spec.mjs --comp ${state.comp} --regions regions.json. Then measure the type: node font-match.mjs --measure <id> for each text region (cap height, width class, weight class) and font-match.mjs --rank <lead text region> --text "<its first words>" to choose the headline face by metrics (the USE line is the CSS; with no browser it records the catalog's nearest face, which is the choice; do not install one, and do not write a chosen face into the spec by hand). Then build-phase.mjs advance.`;
    case 'plates': return 'Produce every plate in the spec (comp-spec.mjs --print lists them). Illustrations, photos, figures: comp-spec.mjs --crop <id>, then generate-image.mjs --plate <id> (or the harness image tool with the crop as reference and the comp-spec plate prompt). A line drawing or figure on flat ground is keyed to alpha automatically (PLATE-CHROMA): place it with a plain <img> over the page\'s own ground, never on a second paper. An opaque plate whose ground differs from the page goes in with mix-blend-mode: multiply. Textures (paper, cloth, grain): do not generate first; crop a clean patch of the comp region (comp-spec.mjs --crop <id> --raw, then cut a patch free of ink), mirror-tile it to the plate size, and save it as the plate; generate only when no clean patch exists. The gate scores a texture against its whole region box, so a texture region should be drawn around clean ground (a sample cell), not around the ink it sits under; the page tiles it wherever the material goes. Then build-phase.mjs advance. Write no page code before this passes.';
    case 'hero': return `Build only the first viewport at ${state.breakpoint || 'the comp size'}. Copy the comp's words verbatim in this phase (headline, labels, table cells, footer): the user approved that comp with those words, and rewriting is a later, stated decision, never a silent one here. Set every text region's font-size from its measured cap height and its face from the ranking. Plates first: place every plate at its spec box (comp-spec.mjs --print lists boxes as percentages of the viewport) with object-fit: cover before writing a line of text or a control, capture into ${HERO_REPRO}, and run build-phase.mjs record hero (not advance) once so you see the plate regions read as match before text exists; then lay the semantic layer (text, controls, rules) over the plates from the spec's palette and boxes, capture, advance. When it fails, open the region crops it lists first, in order, then fix; do not build past the hero until it passes.`;
    case 'sections': return 'Build the remaining sections inside the spec system (same corner language, rules, and palette; nothing the comp does not show). The hero passed with the comp\'s words verbatim; from here, content beyond the comp is yours to author at full fidelity, and any change to words the comp showed is a stated decision in your report, never silent. Then build-phase.mjs advance.';
    case 'motion': return 'Add the signature interaction, reveals, and motion. Then build-phase.mjs advance.';
    case 'responsive': return 'Build the other viewports (mobile first if the surface is mobile). The first viewport must hold at common desktop widths (1280 to 1600), not only at the comp\'s exact size: fluid columns, no fixed-px grid that wraps 96px narrower. Settle or disable entrance motion before capturing (an element mid-animation reads as missing). Capture desktop.png (1440 wide, full page) and mobile.png (390 wide, full page) into .impeccable/review/; the gate diffs the top of desktop.png (scaled to the comp\'s width) against the comp. Then build-phase.mjs advance.';
    case 'review': return 'Spawn the finish reviewer with the state file, the hero diff report, and the captures; record its disposition with build-phase.mjs finish --disposition <word>.';
    default: return '';
  }
}

export function renderStatus(state) {
  const lines = [`BUILD-PHASE ${state.phase.toUpperCase()}  comp ${state.comp || '(pending comp round)'}${state.direction ? `  direction ${state.direction}` : ''}${state.breakpoint ? `  breakpoint ${state.breakpoint}` : ''}`];
  for (const p of PHASES) {
    const s = state.phases[p];
    let line = `  ${p.padEnd(11)} ${s.status.padEnd(8)}`;
    if (s.gate && s.gate.summary) line += ` ${s.gate.summary}`;
    if (s.attempts > 1) line += ` (${s.attempts} attempts)`;
    if (s.forced) line += `  FORCED: ${s.forced.reason}`;
    lines.push(line);
  }
  if (state.finish) lines.push(`  finish      ${state.finish.disposition} at ${state.finish.at}`);
  lines.push(`NEXT ${nextInstruction(state)}`);
  return lines.join('\n');
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || flag('help')) {
    console.error('usage: build-phase.mjs start --comp <png> [--breakpoint WxH] | status [--json] | advance [--force --reason "..."] | record hero --build <png> | note "<text>" | finish --disposition <word>');
    process.exit(1);
  }
  if (cmd === 'start') {
    const comp = arg('comp');
    const direction = arg('direction');
    if (!comp && !direction) { console.error('build-phase: start needs --comp <approved comp png> (comp already approved) or --direction <seed key> (comp round still to run)'); process.exit(1); }
    if (comp && !fs.existsSync(comp)) { console.error(`build-phase: comp ${comp} does not exist`); process.exit(1); }
    // The direction choice ping rides on start (see concept-seed.mjs): one
    // command records the choice and opens the phases. Never fatal.
    if (direction && arg('kind')) {
      try {
        const { pingChosen } = await import('./concept-seed.mjs');
        const sent = await pingChosen({ chosenId: arg('chosen') || undefined, key: direction, scope: 'direction', mode: arg('mode') || undefined, kind: arg('kind'), register: arg('register') || undefined });
        console.log(sent ? 'choice recorded' : 'choice ping skipped');
      } catch { console.log('choice ping skipped'); }
    }
    // Clear the roll's pending marker: the build has started.
    try { fs.rmSync(path.join(BUILD_DIR, 'pending.json'), { force: true }); } catch { /* absent */ }
    // Code-led: no phase machine to run; say what comes next and stop.
    const buildPath = readBuildPath();
    if (direction && !comp && buildPath === 'code') {
      console.log('CODE-LED (from .impeccable config): no comp round and no phase gates. Write the direction contract (reference/new-work.md section 5), build, and finish per section 7. The chosen decision comp, if any, rides to the finish review as the critique reference.');
      return;
    }
    let breakpoint = arg('breakpoint');
    if (!breakpoint && comp) { try { const i = loadRaster(comp).image; breakpoint = `${i.width}x${i.height}`; } catch { /* leave null */ } }
    const existing = loadState();
    if (existing && !flag('reset')) {
      console.log(`build-phase: state exists (phase ${existing.phase}); pass --reset to start over`);
      console.log(renderStatus(existing));
      return;
    }
    const state = newState({ comp, breakpoint, artifact: arg('artifact'), direction });
    saveState(state);
    console.log(renderStatus(state));
    return;
  }
  const state = loadState();
  if (!state) { console.error(`build-phase: no state at ${STATE_PATH}; run build-phase.mjs start --comp <approved comp>`); process.exit(1); }
  if (cmd === 'status') {
    if (flag('json')) console.log(JSON.stringify(state, null, 2)); else console.log(renderStatus(state));
    return;
  }
  if (cmd === 'note') {
    const text = process.argv.slice(3).filter((a) => !a.startsWith('--')).join(' ');
    state.phases[state.phase].notes.push({ at: now(), text });
    saveState(state);
    console.log(`noted on ${state.phase}`);
    return;
  }
  if (cmd === 'record') {
    const which = process.argv[3];
    if (which !== 'hero') { console.error('build-phase: record hero --build <png>'); process.exit(1); }
    const gate = gateHero(state, { buildPath: arg('build', HERO_REPRO), min: arg('min') ? parseFloat(arg('min')) : HERO_MIN });
    // record is a look, not an attempt: the plates-only capture is expected
    // to fail on every text region, and counting it muddied the tally.
    state.phases.hero.records = (state.phases.hero.records || 0) + 1;
    state.phases.hero.gate = { ...gate, at: now() };
    saveState(state);
    // record is the look, advance is the gate: on the plates-only capture,
    // every text region reads missing by design, so say what the plates did.
    const plateRows = Object.entries(gate.regionVerdicts || {}).filter(([id]) => { const spec = loadSpec(); const r = spec && spec.regions.find((x) => x.id === id); return r && r.medium === 'raster'; });
    if (plateRows.length) console.log(`PLATES ${plateRows.map(([id, v]) => `${id}:${v}`).join(' ')}`);
    console.log(`${gate.ok ? 'PASS' : 'FAIL'} ${gate.summary || ''} (record: nothing advanced)`);
    for (const r of gate.reasons) console.log(`  - ${r}`);
    if (gate.worst) console.log(`  worst: ${gate.worst.join('; ')}`);
    if (gate.sideBySide) console.log(`  open ${gate.sideBySide}`);
    process.exit(gate.ok ? 0 : 2);
  }
  if (cmd === 'advance') {
    const gateOpts = {};
    if (arg('build')) gateOpts.buildPath = arg('build');
    if (arg('min')) gateOpts.min = parseFloat(arg('min'));
    if (arg('artifact')) gateOpts.artifact = arg('artifact');
    const res = advance(state, { force: flag('force'), reason: arg('reason'), gateOpts });
    saveState(state);
    if (!res.ok) {
      console.log(`GATE ${res.phase ? res.phase.toUpperCase() : ''} FAILED (state unchanged)`);
      if (res.gate && res.gate.worstCrops && res.gate.worstCrops.length) {
        console.log('  LOOK FIRST, in this order, before editing anything (comp on the left, your build on the right):');
        for (const c of res.gate.worstCrops) console.log(`    ${c.file}   ${c.id}: ${c.verdict} ${(c.score.overall * 100).toFixed(0)}% (structure ${(c.score.structure * 100).toFixed(0)}%, color ${(c.score.color * 100).toFixed(0)}%, detail ${(c.score.detail * 100).toFixed(0)}%)`);
        console.log('  A region scored missing needs its material (a plate placed, or produced), not a value change; contradicted needs its structure re-derived from the spec box; drift is where padding and size edits belong. When a thin chrome strip (masthead, breadcrumb, table header) is the worst region, check its box height in the spec against the comp first: a strip one grid row tall in the spec but 53px in the comp compares your build against ground it never had.');
      }
      for (const r of res.reasons) console.log(`  - ${r}`);
      if (res.gate && res.gate.sideBySide) console.log(`  then ${res.gate.sideBySide} for the whole viewport`);
      process.exit(2);
    }
    console.log(`ADVANCED ${res.phase} -> ${res.next}${res.forced ? ' (FORCED; recorded)' : ''}${res.gate.summary ? `  ${res.gate.summary}` : ''}`);
    console.log(`NEXT ${nextInstruction(state)}`);
    return;
  }
  if (cmd === 'finish') {
    const disposition = arg('disposition');
    if (!['ship', 'fix', 'rebuild', 'recapture'].includes(disposition)) { console.error('build-phase: finish --disposition ship|fix|rebuild|recapture'); process.exit(1); }
    state.finish = { disposition, at: now(), phaseAtFinish: state.phase };
    if (state.phase === 'review') { state.phases.review.status = 'closed'; state.phases.review.closedAt = now(); }
    saveState(state);
    console.log(renderStatus(state));
    return;
  }
  console.error(`build-phase: unknown command ${cmd}`);
  process.exit(1);
}

// realpath on both sides: a skill mounted through a symlink (Cursor, a
// worktree, an eval stage) must still run as a CLI.
const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname); }
})();
if (isMain) main();
