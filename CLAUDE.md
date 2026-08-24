# Operating guide (for Claude Code sessions)

Read this before changing anything. `README.md` explains the project;
`DATA_DECISIONS.md` records every editorial and sourcing ruling (§18–21 are
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
- Set `LEADERS_CACHED_ONLY=1` for local full runs — otherwise the leaders
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
- Entity table: dark-blue/light-blue rows in BOTH themes; home page washes
  verdant green in both themes; country pages tint from flag colours.
- Inventions exclude food/drink (three-net filter); cuisine and inventions
  coverage limits are stated in the UI, not padded.
- Globe drag sensitivity is 0.5625°/px by explicit request (two ×1.5
  raises). Space outside the projection is black on every view.
