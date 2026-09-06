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
- Map palette: two gated directions (atlas default, paper), chroma <= 0.045;
  continent view = cohesive regions + labels, no internal borders.
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
  uppercase nav from the SECTIONS registry (src/config.ts) — five
  top-level items (Global Data, Human History, Taxonomy, Evolution,
  Space); active state = 2px underline in the section's THEMED --nav-*
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
  frozen-black-globe bug (§42.1); the satellite/terrain quad mesh
  overdraws its DESTINATION ~1.5% and never pads the SOURCE rect past
  the tile edge (§42.2 — source padding smears tile borders into
  meridian streaks); six palette directions all gated by
  build-map-palette.mjs (lightness is the data channel in every one);
  base views political/satellite/terrain, choices persisted; the country
  popover's corner thumb is the country's own fitted shape, not a flag.
- Timeline (round 2, §38, §42.4–5): full-width MEASURED era banners,
  each tinted by its era's own oklch hue (light-dark pairs in
  Timeline.tsx — text contrast never depends on the hue); era
  descriptions are UI copy in Timeline.tsx; events carry an optional
  civilization tag from the controlled list in etl/sources/history.py —
  when adding events, check the per-civilization spread, not just the
  regional one (§42.5).
- Taxonomy (§31, §42.6–7): the tree is NEVER hand-typed — it comes from
  Catalogue of Life; which families get species depth is editorial
  (etl/reference/taxonomy_focus.json), and contested placements carry
  notes from etl/reference/taxonomy_notes.json. Every node has wiki or an
  explicit null (check:taxonomy gates it). rankDefinition() must cover
  EVERY rank string in the data (composed prefix definitions — no chip
  is a dead end); borrowed photos always carry img.rep and render as
  "Representative: <name>", never passed off as the taxon's own.
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
  against out-of-order completions; 8k textures exist ONLY for
  Sun/Earth/Jupiter/Saturn and load only in the globe modal (§42.9);
  gazetteer features ship origin/approval/culture/link — keep the
  feature card sourced from those columns, never hand-typed.
- Type: Newsreader (serif) for h1/h2 only, Public Sans for everything else
  incl. every number; both self-hosted under public/fonts, never loaded
  from Google at render time (§25).
- Globe drag sensitivity is 0.5625°/px by explicit request (two ×1.5
  raises). Space outside the projection is black on every view.
