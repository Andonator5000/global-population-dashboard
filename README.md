# Global Population Dashboard

**Live site: https://andonator5000.github.io/global-population-dashboard/**

World population statistics on an equal-area map, built as a **static site fed
by a versioned ETL pipeline**. The browser never calls an upstream API — it
reads committed artifacts from `/data`, each carrying its own provenance.

> **Status: all 9 build phases complete.** The site is live, the verification
> gates pass, and the monthly refresh is verified end to end on a real runner.
> See [Build phases](#build-phases).

## Layout

```
etl/        ingestion pipeline (Python) — run monthly, emits /data
  reference/  hand-curated editorial rulings (the ONLY human overrides)
  sources/    one module per upstream source
data/       committed, versioned pipeline output + provenance manifest
src/        the app (Vite + React + TypeScript + Tailwind v4)
scripts/    flag colour extraction, biome precomputation
```

## Prerequisites

Node 24+ and Python 3.12+. Both are already installed and the dependencies are
in place; these are the commands to reproduce the environment elsewhere.

```bash
npm install
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # .venv/bin/python on POSIX
```

ETL dependencies are pinned exactly in `requirements.txt`, because `/data` is
committed output reviewed in diffs — an unannounced pandas or geopandas bump
could shift the figures and arrive in a PR looking like an upstream data
change.

## Commands

```bash
# --- data ---
python etl/run.py --refresh              # re-fetch everything, rebuild /data
python etl/run.py                        # rebuild from the raw download cache
python etl/run.py --only crosswalk       # run a single stage
python etl/run.py --check-sources        # probe every upstream, write nothing
python etl/run.py --validate-indicators  # verify World Bank codes still resolve
python etl/run.py --fingerprint          # hash of /data excluding the manifest
python etl/run.py --skip-flags           # skip the Node palette stage

# --- app ---
npm run dev        # dev server (serves /data via middleware)
npm run build      # typecheck + production build, copies /data into dist/
npm run typecheck
```

`/data` is committed; `.cache/` (raw downloads) is not, and is fully
regenerable with `--refresh`. The ETL shells out to `npm run flags && npm run
palette` for the flag colours, so `--refresh` genuinely rebuilds everything
from one command — Node must be on PATH.

## Monthly refresh

`.github/workflows/refresh-data.yml` re-runs the ETL on the 3rd of each month,
and on demand via `workflow_dispatch`.

It opens a pull request **only when the data actually changed**. The manifest
carries `generated_at` and a per-source `fetched_at`, so it differs on every
run; diffing `/data` naively would open a PR every month containing nothing but
timestamps. The ETL therefore stamps a `content_fingerprint` — a hash of every
artifact except the manifest — and the workflow compares that instead.

When nothing changed, `fetched_at` is deliberately **not** advanced: it
describes when the committed bytes were retrieved, not when they were last
checked. The check is recorded in the workflow run summary.

**Verified on a real runner** (2026-08-10): a manual dispatch against live
upstreams reproduced this repository's `/data` byte-identically on Ubuntu —
same 237 WPP series, same 1765 biome intersection pieces, same palette
ΔE 5.32 — and correctly opened **no** pull request, because the fingerprint had
not moved.

## Principles this codebase enforces

**Every figure carries provenance.** Source, indicator code, and the *vintage
year of the observation*. The `Sourced<T>` type in `src/types.ts` makes an
unattributed number awkward to construct on purpose.

**Three dates, never conflated.** `vintage` (what year the observation
describes) ≠ `upstream_release` (when the publisher cut it) ≠ `fetched_at`
(when we downloaded it). The freshness panel shows all three.

**Missing data is a state, not a zero.** `value: null` renders as "not
available from *source*" — never a zero, never a blank chart.

**"Real time" is honest.** No source publishes live population. The ticking
counter is a client-side interpolation between annual UN WPP points, labelled
as a modelled estimate with its method in a tooltip.

**Fail loudly.** The ETL aborts rather than emitting partial data, because the
app cannot distinguish "absent upstream" from "our fetch broke" — and those
must render differently.

**Equal-area only.** `d3.geoEqualEarth()`, swappable to Mollweide or Eckert IV.
Area math happens in EPSG:6933. Mercator is not an option.

## Data sources

| Domain | Source | Notes |
|---|---|---|
| Population, fertility, mortality, projections | UN World Population Prospects 2024 | Bulk CSV. Medium variant headline; low/high for bands. |
| Economy, education, health, urbanisation | World Bank Indicators API v2 | Codes centralised in `etl/config.py`. |
| Government, ethnicity, religion, languages | CIA World Factbook (`factbook.json` mirror) | Public domain. |
| Country metadata, borders, area | `mledoze/countries` | **Substituted for REST Countries v3.1** — see below. |
| Geometry | Natural Earth via TopoJSON | 110m render, 50m for biome math. |
| Biomes | RESOLVE Ecoregions 2017 | Build-time overlay, never runtime. |
| Democracy, human rights, governance, CO₂ per capita | V-Dem / Regimes of the World / Hanson & Sigman / Global Carbon Budget, via Our World in Data | Primary source for the Freedom and governance measures; citations name the underlying producer. |
| World Heritage sites | UNESCO World Heritage List | Official syndication XML — see DATA_DECISIONS.md §16.3 on the WAF workaround. |
| Press freedom | RSF World Press Freedom Index | First-party CSV; the stale OWID mirror was rejected (DATA_DECISIONS.md §19.2). |
| Prisons and prisoners | UNODC bulk xlsx; prison rate/occupancy via OWID (ICPR/World Prison Brief) | Facility counts exist for ~93 countries and render as unavailable elsewhere. |
| Death penalty status | Wikipedia "Capital punishment by country" (CC BY-SA) | Amnesty compiles but ships PDFs only; execution figures kept verbatim. |
| Universities, libraries, top-10 rankings | Hipolabs / Wikidata / CWUR | Three confidence levels, each labelled — see DATA_DECISIONS.md §19.4. |
| Public debt, nominal GDP (incl. projections) | IMF World Economic Outlook (DataMapper) | Build-time only (no CORS); the page interpolates and labels it modelled. |
| Currency images | Wikidata P18 via Wikimedia Commons | Representative specimen with per-file licence/author; overrides file for curation. |
| States/provinces with populations | Wikidata (P150/P1082) | Former-entity filter; populations carry their own vintages. |
| Climate (temperature, warming) | Copernicus ERA5 via Our World in Data | 50-year warming is decade-mean vs decade-mean. |
| Capitals; live weather; live FX | GeoNames; Open-Meteo; open.er-api.com | The two live fetches are the app's only render-time upstream calls — see DATA_DECISIONS.md §19.1. |
| Cross-checks | Our World in Data (population) | Sanity check only — OWID's modern population series is UN WPP re-published, so it validates our parsing, not the estimates. |

Joined on **ISO 3166-1 alpha-3**.

### Two substitutions were required

Both because the brief's specified source now needs an API key, which would
break the acceptance criterion that `--refresh` rebuilds `/data` from a fresh
checkout with no manual steps:

1. **REST Countries v3.1 → `mledoze/countries`.** v3.1 is deprecated (it
   answers HTTP 200 with an error body); v5 requires a bearer token.
   `mledoze/countries` is the dataset REST Countries is built from.
2. **UN WPP Data Portal API → bulk CSV.** The `/data/` endpoints return 401
   without a registered token. The CSVs carry the same figures.

Full reasoning in **[DATA_DECISIONS.md](DATA_DECISIONS.md)**, which also
documents every editorial call about disputed entities and continent
assignment.

## Build phases

| # | Phase | Status |
|---|---|---|
| 1 | Scaffold, deps, ETL skeleton, ISO3 crosswalk, manifest | **done** |
| 2 | UN WPP + World Bank ingestion, hand-verified against source | **done** |
| 3 | Equal-area map, static fill, routing | **done** |
| 4 | Flag colour extraction, OKLCH normalisation, adjacency colouring | **done** |
| 5 | Country detail pages, Factbook ingestion | **done** |
| 6 | Biome precomputation, continent detail pages | **done** |
| 7 | Interpolating counters, time scrubber | **done** |
| 8 | Monthly GitHub Action, freshness panel | **done** |
| 9 | Accessibility, responsive layout, map performance | **done** |

## Verification gates

`npm run check` runs all of these and exits non-zero on any failure. The
monthly refresh workflow will not open a pull request unless they pass.

| Gate | What it proves |
|---|---|
| `check:contrast` | Every theme token clears WCAG AA in **both** light and dark. |
| `check:equal-area` | The Africa:Greenland **ratio** matches reality (13.72:1 vs 14.02 expected). Checking only "Greenland is smaller" would pass on Mercator too. |
| `check:palette` | All 325 bordering country pairs are perceptibly distinct, and the 4-tier graph colouring solved exactly. |
| `check:biome-areas` | Polygon areas match published figures with **no latitude trend** — the signature a non-equal-area CRS would leave. |
| `check:theme-parity` | The two duplicated dark-mode CSS blocks declare identical tokens. This trap silently shipped light-mode chart colours to the dark toggle three times before it was gated. |
| `typecheck` | Strict TS, including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. |

## Accessibility

- **The map is one tab stop.** Arrow keys move between countries by nearest
  centroid; Home/End jump to the westernmost and easternmost; Enter opens a
  country. It previously exposed 241 tab stops.
- **Contrast is verified on rendered elements**, not only on tokens: 1,090 text
  elements audited in-browser, zero failures in light *and* dark.
- Hover and keyboard focus produce identical readouts; nothing is reachable
  only by pointer.
- Contested status is carried by a hatch pattern as well as colour, so it
  survives colour-blindness, print, and `forced-colors`.
- `prefers-reduced-motion` stops the ticking counter and scrubber playback.
- Every chart has a table view; no value is tooltip-only.
