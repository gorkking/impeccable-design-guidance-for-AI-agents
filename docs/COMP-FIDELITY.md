# Comp fidelity: measuring the build against the comp

Status: shipped on `feat/comp-fidelity` (2026-08). Owner: skill (`skill/scripts/comp-*.mjs`, `build-phase.mjs`) plus two detector rules.

## The problem

v4's direction round and comp round produce beautiful comps. The build that follows is a lossy translation of them: invented chrome the comp never showed, materials flattened to CSS, illustrations approximated as SVG or `clip-path`, produced textures buried under opaque washes, and a first viewport that has the comp's section order and none of its craft. The finish reviewer catches this and orders a rebuild; the rebuild has the same problem; runs hit the turn cap.

Two recent factory runs (07-vintage-moto-forum and 05-experimental-album, gpt-5.6-sol, 2026-08) show the shape:

- 183 KB of skill prose read before the first write; the page written in one 1,500-line write at turn 30; no reproduction phase, no `hero-repro.png`, no side-by-side; turns 31-61 spent on servers, screenshots, and reviewer plumbing until the cap.
- A torn-paper arch shipped as a 17-vertex `clip-path: polygon`; a vellum slip as a flat gray rectangle; both produced paper textures unused on disk.

The root: every fidelity check in the build phase was the model judging its own reproduction from memory of an image, and the prose kept growing to argue it into behavior it cannot perform. Code-led builds "look better" only because they have no target to fail against.

## The change

Stop asking the model to reproduce pixels it can see but not render, and stop asking it to grade a reproduction it cannot see clearly. Make the translation mechanical wherever pixels are involved; keep the model's job to what it is good at (structure, semantics, controls, motion, responsive logic).

### 1. `comp-diff.mjs`: numbers and crops instead of conviction

Dependency-free (own PNG codec in `lib/png.mjs`). Given the comp and a build capture:

- aligns the build (scale to comp width, take the first-viewport rows; `--align stretch|cover` for other uses),
- scores structure (SSIM over blurred grayscale with a small translation search), color (quantized histogram intersection + Lab dominant-palette match), detail (high-frequency energy ratio per cell: did the material survive?), and bands (horizontal section boundaries line up?),
- per region (from the spec, or from the comp's own bands), with region-kind weights: a `plate` region is judged mostly on detail, a `text` region on structure,
- writes `side-by-side.png`, `heatmap.png`, `regions/<id>.png` paired crops at legible scale, and `report.json` with a verdict per region in the reviewer's vocabulary: `match` / `drift` / `missing` / `contradicted`,
- `--threshold` exits 3 below the bar.

Calibration on the moto run: comp vs itself 100%; comp shifted 12px 87% (match); comp with the illustration erased 90% overall but the plate region `missing` at 30%; comp recolored to navy 34% (`missing`); the real build 59% (`contradicted`, plate `missing`, index `contradicted`). Sibling comps of the same world score 55-59% against each other, so the metric separates "same design" from "same world, different composition." Runs in ~0.3-0.8 s.

### 2. `comp-spec.mjs`: the comp becomes a measured spec

`--grid` writes the comp with a labeled 10x10 grid; the model names regions by grid span (`E0:J4`) with a kind (`plate` / `image` / `texture` / `text` / `control` / `chrome`) in a small JSON file; `--regions` measures each region (normalized and pixel box, sampled palette, detail energy, aspect) and writes `.impeccable/build/spec.json`. Raster kinds get a `plate` path under `assets/plates/`. `--crop <id>` extracts the reference crop; `--plate-prompt <id>` prints the regeneration prompt; `--print` is the compact spec the build codes against. The spec is what "anything not in this list does not exist on the page" refers to.

### 3. `build-phase.mjs`: phases as a state machine on disk

`.impeccable/build/state.json`, phases `spec → plates → hero → sections → motion → responsive → review`, advanced only by the script:

- `spec` gate: spec.json exists, measures this comp, has regions.
- `plates` gate: every raster region's plate exists, decodes, is at least 1.5x the region's pixel width, and scores against the comp crop (`cover` alignment, kind-weighted, min 0.5).
- `hero` gate: `.impeccable/review/hero-repro.png` exists and comp-diff scores at least 0.72 with no region `missing` and at most a third `contradicted`. Writes `.impeccable/review/diff/hero/`. Attempts and scores are recorded.
- later phases record the moment; `--force --reason` is allowed and recorded, never silent.

`status` prints a NEXT line for the current phase, so the prose does not have to.

### 4. Plates: `generate-image.mjs --plate <id>`

One raster region end to end: crop the comp region, send the crop as the edits-endpoint reference with the spec's plate prompt (remove UI text and chrome, keep everything else), pick the closest supported size to the region's aspect, write to the plate path, embed the prompt, score against the crop, warn under 50%, refuse under `--min`. `IMPECCABLE_IMAGE_GEN_FAKE=1` yields the crop at 2x so offline pipelines walk the plate gate. Harness-native image tools use the crop and prompt the same way.

The asset producer agent's job shrinks to: produce the spec's plates, one line per plate, `blockers`, `assumptions`. No inventory of its own (the spec is the inventory), no strategy taxonomy.

### 4b. Type: `font-match.mjs` and the catalog fingerprint index

Faces used to be chosen by name, and the first-round misses said so: headline wider and lighter than the comp, footer heavier. `font-match.mjs --measure <region>` fingerprints the comp crop with `lib/font-fingerprint.mjs`: per-line, size-invariant shape features (glyph width and x-height against the reference height, stem width, stroke contrast, serif ratio, ink density, vertical ink profile, run-length quantiles), all normalized so the same face gives the same numbers at any point size and on different text. The MEASURE line prints cap height, width class, weight class, and tracking, and the spec keeps the summary on the region.

`--rank <region>` no longer starts from a hand-written shortlist. `skill/scripts/data/font-index.json` holds the same fingerprint for ~3,100 Google Fonts faces (every latin family at 300 / 400 / 700 where shipped) rendered at two cap heights, 48px and 14px, because the features hold within a factor of two in size but not across that span; a crop under 22px cap queries the 14px index. The 25 nearest faces by a noise-normalized weighted distance (fitted on 299 held-out probes with different text; 42% top-1 and 72% top-5 family recall at ~30px cap, 52 / 71 at 14px) become the candidates, together with whatever names the model passes in. Those are then rendered with the region's own text at the comp's cap height, fingerprinted again, and ranked by the same distance, so the CATALOG line is the index's guess and the RANK lines are measured on the actual words. Below 10px cap the script says to size by the box and stops. The index is ~700 KB, packed base-36, rebuilt at release time by `scripts/build-font-index.mjs` (network + Playwright); the per-width-class shortlist stays only as the fallback when the index file is missing.

On the moto comp: headline (72px cap, condensed heavy mixed case) ranks League Gothic first with Karantina and Medula One behind it, where the old width/weight formula gave Anton SC and BBH Bogle; for the subhead the index puts Akshar 300 and Reddit Sans Condensed 300 on top, credible condensed light faces where before the class was wrong altogether.

### 5. Two detector rules

- `organic-clip-path`: `clip-path: polygon()` with 10+ off-grid vertices, or `clip-path: path()` with 3+ curve segments. Geometric clips (cut corners, diagonals, hexagons, arrows) pass; `circle()`/`inset()` pass.
- `buried-raster`: a `url()` layer under a gradient wash whose stops are all >= 0.9 alpha (or opaque), no blend mode; or a raster background / `<img>` at opacity < 0.15. Tints under 0.9, blends, and visible opacities pass.

Both in both engines (static jsdom + browser bundle), fixtures under `tests/fixtures/antipatterns/`.

### 6. Prose

`new-work.md` section 6 is now the phase list with its gates; the reproduction paragraph, the hero checkpoint paragraph, and visualize.md's inventory / medium-gate / produce sections are gone in favor of the scripts that enforce them. `visualize.md` dropped from 55 to 44 lines and new-work.md's section 6 from ~1,900 to ~1,300 words while gaining the actual mechanism. The finish reviewer reads the state file and the diff report first and starts its matrix from the measured verdicts.

## What this does not do

- It does not judge lettering character, ornament, or motion. The reviewer still owns those.
- It does not decide plates for the model: the model still names regions on the grid. The gate only refuses to proceed when a named raster region has no plate.
- The hero threshold (0.72) and plate threshold (0.5) are calibrated on two runs and synthetic perturbations; they will move with evidence. Both are constants at the top of `build-phase.mjs`.
- Operate surfaces (dashboards, editors) have few or no plates; the spec/diff still apply, the plates gate is trivially satisfied.

## Evaluating it: first sweep (2026-08-16, gpt-5.6-sol, openai lane)

Same niche (07-vintage-moto-forum), same approved comp C, main skill vs this branch, scored with `comp-diff.mjs` against the approved comp. Small numbers, one sample each; read as a smoke, not a verdict.

| Run | Skill | Turns / cost | comp-diff overall | Notes |
|---|---|---|---|---|
| exec cut, packet C, "Continue." | main | 9 / $0.88 | **55%** (contradicted; plate + index `missing`) | one 45 KB write, no plates, generic split hero |
| exec cut, packet C, "Continue." | branch | 17 / $0.95 | **54%** (contradicted; plate `missing`) | the packet's prefix predates the phase machinery; the model never re-read new-work.md and behaved like main |
| exec cut, packet C, ask names the phased build | branch | 96 / $5.24 (cost cap) | **66%** (drift; plate region 43%) | walked spec → grid → regions → plates → hero gate (72% fail, fix, 77% pass) → sections → motion → responsive; 12 turns lost hunting a screenshot the harness wrote host-side only (fixed in impeccable-evals); the exploded plate was produced (62% vs crop) but the page drew the region in SVG anyway (fixed: hero gate now refuses unreferenced plates) |
| full journey, comp-led | main | 49 / $3.23 | **56%** (contradicted; two bands `missing`) | dark comp with paper fiche rail; build keeps the section order and flattens the material |
| full journey, comp-led | branch (before the force/reference fixes) | 61 / $3.04 (turn cap) | **65-66%** (drift) | forced past the plates gate with "single-file delivery" (now refused); hero 44% structure but 83% color, plate placed |
| full journey, comp-led (after fixes), sample 2 | branch | 60 / $3.00 (30-min wall clock) | **59%** (contradicted; hero gate 61 → 63 → 62%) | three plates produced (paper 52%, carburetor 61%, photo), hero gate failed three times, model asked the simulated user, got "truthful translation", forced with the user's words (recorded), wall clock ended it in sections |
| full journey, sample 1 | branch | 37 / $2.5 | n/a | direction round, then wrote code with no comp round at all: a routing gap in the direction round that predates this branch (also seen on main in cf-full-branch-07b) |
| full journey, comp-led | main (2nd sample) | 24 / $1.38 | n/a (no comps: model went code-led) | same routing gap |
| exec cut, 01-observability composed checkpoint | main / branch | 9 / $0.68 vs 10 / $0.84 | 52% vs 48% | composed checkpoint quotes the OLD visualize.md verbatim into the prefix, so the branch text never reaches the model; not a test of this change |

Sweep totals: 12 runs, about $32 of OpenAI spend (gpt-5.6-sol + gpt-image-2).

What it says so far:

- When the phase machinery actually runs, fidelity moves from the mid-50s to the mid-60s on this comp, and the region rows say why the rest is missing (the exploded plate, the parts table, the CTA treatment). Same model, same comp.
- Execution-cut packets and composed checkpoints carry the old skill's text in their prefix; a resumed session follows the conversation it is in, not the mounted files. Comparisons of Setup-adjacent skill changes need full journeys or a fresh packet cut on the new skill.
- Two of the three run-time defects the sweep found were harness (screenshot not visible in the sandbox; packet workspace path) and are fixed in impeccable-evals `paul/packet-niche-execution-preflight`. The third (model forcing a gate, model ignoring its plate) is now refused by the script.
- Cost: the phased build spends more turns before the first write and more image calls (plates). The 96-turn run is dominated by the screenshot hunt and a font-inlining tangent, not by the gates. The 30-minute wall clock and 60-turn cap in the harness are tuned for the old one-write build; a phased build with three plates and a hero loop needs the execution cut kind's 100-turn budget or a longer wall clock.
- The hero gate at 72% is reachable (77% on the ask run) but the model's second and third attempts moved the score by one point each: it edits CSS values when the diff says a region is missing. The gate's message now names the region and the failure mode; the next lever is making the region crops the thing the model looks at (it opened the side-by-side once and the crops never).
- Whether a greenfield session enters comp-led at all is decided in the direction round, before any of this. Two of five full-journey samples (one per skill) skipped the comp round and wrote code; the config default is comp-led and image generation was on. That routing gap is separate from this change and worth its own fix.

## Second sweep (2026-08-16, sol + opus-5, three niches, n=2-3): the packets, not the skill

37 execution-cut runs on 05-experimental-album, 07-vintage-moto-forum, 11-analytics-dashboard, main vs branch, about $210. Result: 33 of 37 samples never entered the phase machine (`nostate`: no `.impeccable/build/state.json` at the end), so main and branch scored the same (50-60% overall, mostly `contradicted`) and the sweep measured nothing about the change. The four samples that did run the phases (11-opus-branch, 11-opus-branch-b) reached hero 69-72% and 63-66% overall, the highest opus scores in the sweep, at 80-100 turns and $9-12.

Why the machinery was skipped, in order of blame:

1. **The packets carried no state.** The 07 packet was cut on 2026-08-12, before `build-phase.mjs start` existed; the 05 and 11 packets were cut on the branch, but the session generated its comps before running `start`, so `pending.json` was written and `state.json` never was. Every gate reads `state.json`; a resume with none has nothing to follow. Two fixes: `generate-image.mjs` refuses to write a comp under `.impeccable/mocks/` while `pending.json` is set and no state exists (the direction pick must be recorded first), and impeccable-evals `factory-validation` fails a `composition-approved` candidate whose workspace lacks a closed comps phase.
2. **Prefix inertia.** A resumed model follows the conversation it is in. When the prefix ends on "translating comp C into HTML now", the mounted skill files are not re-read whatever they say. The procedure has to be on disk at the resume point (state.json + the `NEXT` line), which is what (1) restores.
3. **WebP comps.** gpt-image returned WebP for some cuts; `comp-spec` demanded PNG, so the session rewrote the `.webp` in place with PNG bytes, which broke replay ("a later step rewrites this path beyond the cut"). `loadRaster()` now converts through a sibling `<file>.png` cache and never touches the source.

Read the earlier "exec cut, packet C, ask names the phased build" row and this sweep's four phased samples together: same model, same comp, and the phased build lands 10-15 points above the one-write build every time it actually runs. The open question is not whether the phases help but whether a resumed session enters them; that is a packet property, and it is now validated at cut time.

## Third sweep (2026-08-17, gpt-5.6-sol, re-cut packets carrying state.json, n=2-3): the phases run, and they win

Packets re-cut with the phase state reconstructed at the pick (replay now re-executes `build-phase.mjs` verbs and the OpenAI worker pulls the sandbox's `.impeccable/build/` before close). Baseline = main skill via `IMPECCABLE_SKILL_DIR`, branch = this branch's dist. About $60.

| Niche | main (n=3) | branch (n=2) | branch hero |
|---|---|---|---|
| 05-experimental-album | 53%, 53%, 56% (all contradicted) | **66%, 77%** (drift) | 77%, 78% |
| 07-vintage-moto-forum | 46%, 47% (contradicted) | **62%, 64%** (drift; hero open at 63/68%) | 63%, 68% |
| 11-analytics-dashboard | 66%, 61%, 66% (drift) | **72%, 71%** (drift) | 76%, 80% |

Every branch sample ran the phase machine (`state.json` at hero or later); every main sample resumed at `comps` and wrote the page in one pass. Mean delta on comp-diff overall: 05 +18, 07 +17, 11 +7. Branch runs cost 2-4x (turn cap at 100-110 on four of six; wall clock 60 min).

What the traces said, and what changed from them:

- **Font ranking without a browser was a dead end.** Sessions spent 6-10 turns installing Playwright or hand-typed a `chosen` face into spec.json. Now: the catalog index has an all-caps render (`48c`), non-text faces are excluded, the distance carries a gross width/weight gap, and with no browser `--rank` records the catalog's nearest face; the gate refuses a `chosen` it did not stamp. The eval worker lends its Playwright to the sandbox.
- **Painted material filed as chrome.** 07's exploded carburetor and rack drawing were `chrome` regions "drawn in code", then scored missing at the hero with no fix available. `comp-spec` now refuses a code kind whose note names painted material.
- **A passed plate is placed material.** With the plates referenced and passing the plates gate, comp-diff at the region box still called them `missing` on detail (the plate's carburetor is not the comp's carburetor at pixel level). The hero now scores a passed plate on placement (present in the box, at the box) and says the box as numbers.
- **The control ink-box veto blocked a full-width bar six times** ("1376x87 vs 1382x102"), unmovable by any edit. It now applies only to discrete controls.
- **Plate generation polled turn by turn** (8 `write_stdin` empty polls per plate); the NEXT line now says to wait long.

Not yet measured: the last three fixes landed after this sweep. Next: rerun sol at n=3 on the same packets to confirm the delta holds with fewer turns, then opus.
