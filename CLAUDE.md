# Operating guide (for Claude Code sessions)

Read this before changing anything. `README.md` explains the project;
`DATA_DECISIONS.md` records every editorial and sourcing ruling (§18–27 are
the 2026-08 maintainer batches) — check it before re-litigating a source
choice.

## Workflow (settled with the maintainer, Andy)

- Build on a feature branch → open a PR → **wait for Andy to say "merge"**.
  Never merge or push to main unprompted. Pushes to main auto-deploy Pages.
- Batch PRs are the norm: ETL commit, App commit, Data commit (regenerated
  artifacts), one PR.
- After merging, confirm the live site actually serves the change
  (https://andonator5000.github.io/global-population-dashboard/).

## Commands

```
.venv\Scripts\python etl\run.py            # full cached pipeline (rebuilds /data)
.venv\Scripts\python etl\run.py --only X   # one stage — see WARNING below
npm run check                              # all gates (typecheck, contrast, equal-area, …)
npm run build                              # production build
npm run dev                                # dev server on :5173
```

## Hard rules that have bitten before

- **Always finish with a FULL cached `etl\run.py` before committing data.**
  `--only` writes a partial manifest; CI verifies `content_fingerprint`
  against /data and rejects mismatches.
- Set `LEADERS_CACHED_ONLY=1 CURRENCY_CACHED_ONLY=1` for local full runs —
  the banknote category walk (~1,500 Commons listings, rate-limited) takes
  hours cold and the monthly refresh completes it; otherwise the leaders
  stage grinds against Commons rate limits re-downloading portraits. The
  monthly refresh (.github/workflows/refresh-data.yml) retries them.
- The biomes stage takes ~10 min per full run. That's normal.
- **Cache keys**: `etl/fetch.py` caches by filename when given one. If you
  change a QUERY whose cache filename is fixed, delete its `.cache/...`
  file first — and never name batch caches positionally (stale-reuse bug,
  see DATA_DECISIONS §21).
- **User agents**: imf.org rejects custom UAs but accepts stock
  `python-requests/x`; RSF, UNODC and UNESCO need `WHC_BROWSER_UA`.
- PowerShell 5.1 mangles double quotes inside `git commit -m` here-strings
  — write the message to a file and use `git commit -F`.
- The 6 leaders without portraits (AFG-hos, BDI/GNB/JEY/MOZ/PCN-hog) have
  **no free-licensed image anywhere** — don't chase them.
- **`etl/logs/` is committed and reviewable**: plausibility suppressions
  (`etl/validate.py`), breakdown reconciliation (`etl/breakdown.py`),
  inventions class-gate rejections, flora/fauna image rejections, banknote
  verdicts, icon coverage. A stage regenerates its own log; a `--only` run
  leaves the others untouched.
- **Icons are one set** (OpenMoji COLOUR variant since 2026-08-30, vendored
  under `public/icons/openmoji`). Add a hexcode to `src/data/product-icons.json`
  or `src/lib/icons.ts`, then `npm run icons` to vendor it; `npm run
  check:icons` gates coverage at 95% of mentions. No emoji, no gear.
  Icon-led breakdowns reserve the slot (a dash) so labels stay flush.
- Public libraries come from IFLA via `fetch_via_curl` (Cloudflare blocks
  Python's TLS fingerprint); electricity mix from OWID; nuclear plants from
  Wikidata with a status filter (§27). Inventions also pass an
  adult-content keyword net.

## Architecture in one paragraph

Static React/Vite site on GitHub Pages; ALL data is committed artifacts in
`/data`, produced by the keyless Python ETL (`etl/`, config centralised in
`etl/config.py`, one module per source in `etl/sources/`). The only
render-time fetches are live FX (open.er-api.com) and live weather
(Open-Meteo) in `src/lib/live.ts` — a deliberate, contained exception.
Every figure carries source + vintage; absence renders as an explicit
"not available", never a blank. Images are hotlinked (Commons /
iNaturalist open-data / TheMealDB) with per-image attribution rendered.

## Editorial invariants (don't undo silently)

- Somaliland/N. Cyprus polygons keep their own labels but key to SOM/CYP.
- Home page: three raised cards on the neutral page tint (no green wash
  since 2026-08-30); entity table dense, neutral, sticky header, hover
  highlight, signed growth-rate colour only; country pages tint from flag
  colours.
- ONE breakdown pattern: ranked horizontal bars (`Breakdown.tsx`); the
  stacked bar is gone. Flag is the hero of the country page with attributed
  Wikipedia symbolism text (CC BY-SA, verbatim, linked).
- Map palette: six gated directions (atlas default; paper, antique,
  pastel, nautical, mono), lightness is the data channel in all; the
  antique direction is the measured Blaeu 1635 sheet (§48: parchment sea,
  umber lines, coastline gate instead of the water floor, ANTIQUE
  constants in WorldMap.tsx mirror DIRECTIONS.antique in
  build-map-palette.mjs; the surround is BLACK space since §51.4);
  every direction also tones the satellite/terrain imagery through an
  ImageryGrade in src/lib/mapgrade.ts (§51.1) — presentation only, never
  applied to political fills, outside the gates; continent view =
  cohesive regions + labels, no internal borders.
- `/history` is EDITORIAL: edit `etl/reference/history_events.json` (bump
  `version`), never `data/history/events.json`; the `history` stage
  validates it and resolves free images. Keep regional balance in mind.
- Inventions pass a Wikidata class gate (allow/deny roots in
  `etl/config.py`; food/drink still denied); cuisine and inventions
  coverage limits are stated in the UI, not padded.
- Every percentage breakdown accounts for 100% with an explicit "Other"
  (neutral token, visible explanation); >2 points over 100 suppresses the
  chart; a >40-point gap ships without an Other and is logged for review.
- Mythical/heraldic national animals live in `emblems`, never in the
  species grid; no flora/fauna image ships unverified against its taxon.
- Currency images: a single flat obverse banknote or the designed fallback
  card — criteria in `etl/sources/currencyimages.py`, never bypassed. The
  Commons category walk is ON by default (§27.9): walk finds need a face
  value and a named obverse and no pre-1990 date; curated P18/override
  picks win; `etl/reference/currency_image_rejects.json` is the
  person-reviewed deny list. Review new picks on a contact sheet before
  shipping.
- Header (round 2, §34): centred publication nameplate + editorial
  uppercase nav from the SECTIONS registry (src/config.ts) — six
  top-level items (Global Data, Human History, Taxonomy, Evolution,
  Space, Chemistry since round 3 §47, Anatomy since round 6 §55); active state = 2px underline in the section's THEMED --nav-*
  hue plus a text-colour step. A new section = one registry entry + a
  --nav-* pair in both themes, mirrored into check-contrast AND declared
  in both dark blocks (theme parity). /biology/* redirects; don't remove.
- Sources are COLLAPSED by default site-wide (CollapsibleSources, §34.3);
  method prose lives once on /methodology (§36.4) — figures carry a
  compact source label + MethodInfoLink, never paragraphs of methodology.
- Map (round 2, §35–37, §42): drag frames render to canvas with rotation
  in a ref (React sees ONE commit per gesture — do not reintroduce
  per-frame setState); every escape hatch (pointer leave/cancel/lost
  capture, zoom with no pointers, view/mode/projection switch) must END
  a live drag session — a session that outlives its pointer is the
  frozen-black-globe bug (§42.1); satellite/terrain imagery is a WebGL2
  per-pixel inverse projection (`src/lib/globegl.ts`, §43) — one
  renderer per map lifetime, textures resident across view switches,
  outlines drawn in the SAME GL pass during drags from the SAME rotation
  ref; the 2-D quad warp in terrain.ts is only the no-WebGL2 fallback
  (never re-promote it: its affine quads ARE the meridian streaks);
  verify globe visuals with `HEADED=1 [PALETTE=x] node
  scripts/globe-spin-capture.mjs <view> <tag> [wheelSteps]` (Playwright,
  headed Chrome; it prints per-frame main-thread ms) before claiming a
  fix; six palette directions all gated by build-map-palette.mjs
  (lightness is the data channel in every one); base views
  political/satellite/terrain, choices persisted; the country popover's
  corner thumb is the country's own fitted shape, not a flag.
  Round 4 (§51): the POLITICAL globe's drag frames are a baked world
  raster (src/lib/politicalraster.ts → GlobeGL.setRaster) drawn by the
  same GL pass as the imagery below 6× zoom, and CULLED vector frames
  above it — never reintroduce the 250-path-per-frame canvas loop
  outside the no-WebGL2 fallback; strokes are non-scaling (CSS px,
  converted through the viewBox scale — do not put `/ transform.k`
  back); zoom events coalesce to one commit per frame; device tier in
  src/lib/device.ts governs dpr caps, tile budgets/decode size and
  anisotropy — no user-agent sniffing; resolve CSS colours through
  resolveCssColor (cached probe), never a fresh canvas per call.
  Round 5 (§53, the phone layout): the viewBox is per-render
  (`viewW`/`viewH` — 1000×1000 for the globe on a compact stage, never
  the VIEW_* constants directly); touch selection opens the in-flow
  bottom sheet (`renderSheet`), never a pinned popover; the svg is
  touch-pan-y embedded and touch-none in explore mode; `frameRef` is
  what goes full screen (with the CSS pseudo-fullscreen fallback for
  iOS), `containerRef` the measured stage; the search box drives
  `WorldMapHandle.flyTo`; label growth is capped at LABEL_GROWTH_CAP;
  Tailwind's source scan is restricted to src/ + index.html (§53.7) —
  never let it walk /data again.
- Timeline (round 2, §38, §42.4–5): full-width MEASURED era banners,
  each tinted by its era's own oklch hue (light-dark pairs in
  Timeline.tsx — text contrast never depends on the hue); era
  descriptions are UI copy in Timeline.tsx; events carry an optional
  civilization tag from the controlled list in etl/sources/history.py —
  when adding events, check the per-civilization spread, not just the
  regional one (§42.5).
- Chemistry (§47): elements come from the `chemistry` ETL stage (PubChem,
  NIST, IUPAC/CIAAW, IAEA, Wikidata/Wikipedia); a figure a source does not
  give is null WITH a reason (never zero); photos are licence-gated Commons
  files served locally, 20 no-sample elements show the discovering
  facility; the property key list in src/data/chemistry-properties.json is
  what both the panel and check:chemistry read — add a property there,
  its glossary entry in etl/reference/chemistry_glossary.json, or the
  gate fails. Editorial sample-photo overrides live in
  etl/reference/chemistry_samples.json. The ten element categories have
  glossary entries keyed category.<key> (§52.2) — extra glossary entries
  are allowed, property keys are required. Table layout (§52.1): panel
  beside the table only from xl; the grid fits its column from lg
  (container-query cell type, no min-width) — do not put the 54rem floor
  back above lg, that was the desktop sideways scroll.
- Anatomy (§55, §57.6): EDITORIAL — run `python etl/reference/build_anatomy.py`
  to write etl/reference/anatomy.json (never hand-edit the JSON, never
  data/anatomy/); every system and organ cites its OpenStax A&P 2e
  chapter; an organ's FIRST system is where it is listed and that system
  must list it back; the whole-body LAYERS are panels of OpenStax Figure
  1.4 (`panel: {commons, col, row}`, cut by the stage — one pose, one
  scale, so the layers register); other figures are Commons originals
  through the free-licence gate (SVG stays SVG, LF); all credited per
  image; the `anatomy` stage and check:anatomy gate all of it. Timeline (§54.1): era banners
  sit above the axis line (z-index) — keep the line drawn behind them.
- Cosmic Phenomena (§46): EDITORIAL — edit etl/reference/cosmic_phenomena
  .json, never data/space/phenomena*; the `phenomena` stage downloads
  every image through the licence gate (no hotlinks) and check:phenomena
  gates presence, decodability and attribution; status flags
  observed/theoretical/hypothesis are required.
- Taxonomy (§31, §42.6–7, §44): the tree is NEVER hand-typed — it comes from
  Catalogue of Life; which families get species depth is editorial
  (etl/reference/taxonomy_focus.json), and contested placements carry
  notes from etl/reference/taxonomy_notes.json. Every node has wiki or an
  explicit null (check:taxonomy gates it). rankDefinition() must cover
  EVERY rank string in the data (composed prefix definitions — no chip
  is a dead end); borrowed photos always carry img.rep and render as
  "Representative: <name>", never passed off as the taxon's own. Depth
  below family (§44): one genera file per family in data/biology/taxonomy/
  genera (37 MB, ~14k files), species live from ChecklistBank on expand
  (documented exception), descSrc on every node with generated summaries
  flagged; genus Wikipedia enrichment is incremental
  (TAXONOMY_GENUS_ENRICH_CAP, default 20k per run).
- Evolution (§32): events are EDITORIAL — edit
  etl/reference/evolution_events.json (bump version), never
  data/biology/evolution/. Summaries state their own uncertainty.
  PhyloPic licences: CC0 preferred, BY/BY-SA accepted, NC/ND never.
- Space (§33, §41–42): NSSDC sheets come from PINNED archive snapshots
  cross-checked against live JPL Horizons on every run; moon counts are
  COUNTED from the JPL catalogue; a figure a source does not publish is
  null and renders as "not available", never zero. Scale modes are
  labelled; nothing is silently out of scale. Trek tiles stream at
  runtime (§41.2, documented exception); globe texture upgrades guard
  against out-of-order completions; hi-res textures (§45: earth-8k,
  4k for sun/jupiter/saturn/mars/mercury/moon — the round-2 "8k" files
  were natively 4096px and are now named honestly) load only in the
  globe modal; Moon renders at 1.8x exposure, stated in its credit line;
  gazetteer features ship origin/approval/culture/link — keep the
  feature card sourced from those columns, never hand-typed.
- Type: Newsreader (serif) for h1/h2 only, Public Sans for everything else
  incl. every number; both self-hosted under public/fonts, never loaded
  from Google at render time (§25).
- Globe drag sensitivity is 0.375°/px (DRAG_SENSITIVITY) with a flick
  cap of 40 px/frame (INERTIA_MAX_PX_PER_FRAME) — settled in §59.1 after
  0.25/18 proved too slow; change only on Andy's word. The compass is
  NORTH UP (§59.3): recentre the globe on the place under the screen
  centre and reset the pan, keep the zoom — never a jump to the default
  view. Embedded touch-action is pan-y at zoom 1 and none above 1.05
  (§59.2). Drag/animation frames read the zoom from transformRef. The
  settle (§60) projects only features whose geoBounds touch the visible
  window (detailBounds WeakMap + boundsTouch) — never reintroduce a
  whole-collection path()/centroid() per settle; measure with a
  PerformanceObserver('longtask') after a zoomed drag (.scratch/
  longtask.mjs pattern) before claiming a phone fix. Rotation lambda
  is WRAPPED to [-180, 180) at every write (§54.2). In the imagery
  views the OUTLINES ARE DRAWN BY THE GL PASS AT REST TOO (§57.1) and
  the SVG shapes have no stroke there — never reintroduce SVG strokes
  over GL imagery, two renderers cannot be kept in step on a phone; the
  border mesh drops antimeridian/pole cut edges; the EOX tiles get
  their edge pixel extended (WMS antialiases against transparency).
  The antique direction has NO view-fixed overlay at all — no grain
  (§57.3), no vignette (§58.2). `startInertia` is idempotent and
  `drawDragFrame` paints only inside a live session (§58.1: a release
  fires pointerup + lostpointercapture + pointerleave — never start a
  second loop). Reset view is the compass icon. Space outside the
  projection is black on EVERY view and direction (the §48.3 parchment
  surround was reversed by Andy in §51.4). Satellite imagery is EOX
  Sentinel-2 cloudless 2025 (§56, Andy's ruling): CC BY-NC-SA 4.0,
  attribution sentence VERBATIM on the map credit line, 41 WMS windows
  fetched by the mapdetail stage (per-call fetch timeout 900 s; cached
  under .cache/terrain/eox-*); Blue Marble 2004 only via
  SATELLITE_SOURCE=bluemarble. Never switch the imagery to a runtime
  tile server.
