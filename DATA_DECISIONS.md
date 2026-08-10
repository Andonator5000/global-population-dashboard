# Data decisions

Every editorial call this project makes, with its reasoning. If a figure or a
map polygon looks surprising, the explanation should be in here. If it isn't,
that's a bug in this document.

Machine-readable counterparts live in `etl/reference/editorial_overrides.json`;
this file is the prose that justifies them. They are kept in sync by hand, and
the crosswalk validator fails the build if the JSON references an entity that
no longer exists.

Last updated: 2026-08-09 (Phase 1).

---

## 1. Source substitutions

### 1.1 REST Countries v3.1 → mledoze/countries

**The brief specified REST Countries v3.1. It is deprecated and could not be
used.**

As of 2026-08-09 every `restcountries.com/v3.1/*` endpoint returns **HTTP 200**
with an error body:

```json
{"success": false, "data": null,
 "errors": [{"message": "This API version has been deprecated. ...migrate to our new version (v5)."}]}
```

The successor, v5, requires an account and an `Authorization: Bearer <key>`
header.

**Decision: switched to [`mledoze/countries`](https://github.com/mledoze/countries).**

Reasoning:

- A mandatory API key breaks the acceptance criterion that
  `python etl/run.py --refresh` reproduces `/data` from scratch with no manual
  steps. A fresh checkout, and the monthly GitHub Action, would both need a
  secret provisioned before they could build.
- `mledoze/countries` is the upstream dataset REST Countries is *built from*,
  so the field shape is effectively identical (`name.common`, `name.official`,
  `cca2`/`cca3`/`ccn3`, `region`, `subregion`, `borders`, `area`, `capital`,
  `currencies`, `languages`, `unMember`, `independent`). The migration cost was
  one function.
- ODbL-1.0, static JSON on GitHub raw, no key, no rate limit. 250 entities
  verified on 2026-08-09.

**What we lost:** the dataset carries only the flag *emoji*, not flag image
URLs. No practical impact — flag SVGs are fetched from flagcdn keyed by
`cca2`, which we already hold, and that was the plan regardless.

**Lesson applied to the pipeline:** because the dead API answered with HTTP 200,
a status-code liveness probe was fooled by it. Every ingest now asserts on
*response shape and row count*, not the status code.

### 1.2 UN WPP: bulk CSV, not the Data Portal API

The brief offered both. The Data Portal's `/data/...` endpoints return **HTTP
401** without a registered token (`/indicators/` and `/locations/` are open,
which makes the restriction easy to miss).

**Decision: bulk CSV only**, for the same no-manual-steps reason as above. The
CSVs carry the same WPP 2024 figures. If a future need genuinely requires an
API-only indicator, the token becomes an *optional* enrichment path — never a
requirement for a clean build.

### 1.3 WPP revision: discovered, not assumed

The brief said the underlying revision changes "roughly annually". **It does
not, currently.** WPP 2024 is still the current revision as of 2026-08 because
the next revision was postponed to 2027 (probes for `WPP2025_*` and
`WPP2026_*` both 404).

`discover_wpp_revision()` therefore probes newest-first for a published
revision rather than extrapolating a cadence. **A monthly job that keeps
reporting 2024 is behaving correctly, not stalling** — an important thing to
know before someone "fixes" it.

---

## 2. Continent model

**Decision: the conventional seven-continent model** — Africa, Antarctica,
Asia, Europe, North America, Oceania, South America.

Chosen over UN M49's five-region scheme because `/continent/:id` pages are
aimed at general readers, and merging North and South America into one
"Americas" page makes that page far less informative. Cost: our continent
aggregates do **not** match UN WPP's published regional totals exactly, so we
compute them ourselves from country rows rather than quoting UN regional
figures.

Base assignment derives from the metadata source's `region`/`subregion`, with
`Americas` split on `subregion == "South America"`. Central America and the
Caribbean fold into North America.

### 2.1 Transcontinental and contested assignments

| Entity | Assigned | Why |
|---|---|---|
| Russia | **Europe** | ~3/4 of population west of the Urals; conventional atlas placement. Inflates Europe's land area — flagged on the Europe page. |
| Türkiye | **Asia** | Matches M49 (Western Asia); ~95% of land area in Anatolia. |
| Kazakhstan | **Asia** | M49 Central Asia. |
| Azerbaijan, Georgia, Armenia | **Asia** | M49 Western Asia. Often placed in Europe elsewhere. |
| **Cyprus** | **Europe** | **Departs from M49**, which says Western Asia. EU member and conventionally European. The clearest deliberate override. |
| Egypt | **Africa** | Sinai is in Asia; the overwhelming bulk is not. |
| Greenland | **North America** | Danish territory, geographically North American. |
| Indonesia | **Asia** | Papua provinces are in Oceania; bulk is not. |
| Timor-Leste | **Asia** | M49 South-Eastern Asia. |
| Papua New Guinea | **Oceania** | M49 Melanesia. |
| Mexico, Panama | **North America** | Darién Gap as the conventional divide. |
| Trinidad and Tobago | **North America** | Caribbean → NA, despite sitting on the South American shelf. |
| US Minor Outlying Islands | **Oceania** | Scattered across Pacific and Caribbean; least-wrong single bucket. Explicitly an approximation. |

### 2.2 The Antarctica bucket

Five entities land in Antarctica: **ATA** plus four uninhabited sub-Antarctic
island territories — **ATF** (French Southern and Antarctic Lands), **BVT**
(Bouvet Island), **HMD** (Heard and McDonald Islands), **SGS** (South Georgia
and the South Sandwich Islands).

All five are uninhabited apart from research staff. They are **excluded from
every per-capita, density, and population ranking** so they cannot distort
them, and the Antarctica continent page shows only land area and biome data,
stating plainly that there is no permanent population.

**SGS is the weakest of these calls** — it is commonly grouped with South
America. Assigned to Antarctica for consistency with the other uninhabited
sub-Antarctic territories. Worth revisiting.

---

## 3. Disputed and partially-recognised entities

**Decision: each renders as its own polygon with its own data row and country
page, labelled by common name, carrying an explicit contested-status marker.**

The alternative — restricting the map to the 193 UN members — would deny
country pages to Taiwan and Palestine, both of which have good demographic
data. Showing an entity is a statement that data exists for it, not a
statement about sovereignty. Status labels describe *recognition status* and
name who disputes what; they do not adjudicate.

| Entity | ISO3 | Status shown | Notes |
|---|---|---|---|
| Kosovo | `XKX` | Partially recognised | No ISO 3166-1 code. `XKX` is user-assigned; the World Bank and IMF use it. The metadata source ships it as `UNK`/`XK`, aliased on ingest. **UN WPP publishes Kosovo as its own series** (`ISO3_code = XKX`, "Kosovo (under UNSC res. 1244)") — see §4.3. |
| Taiwan | `TWN` | Disputed status | ISO assigns `TWN`. UN WPP publishes it as "China, Taiwan Province of China"; we use that series but label it **Taiwan**, the common English name. The World Bank publishes few indicators for it, so many Economy/Education fields will legitimately read "not available from World Bank". |
| Palestine | `PSE` | UN non-member observer State | Natural Earth splits West Bank and Gaza; we dissolve them into one `PSE` entity so geometry matches the single data row, and note the discontiguity. |
| Western Sahara | `ESH` | Non-self-governing territory | Sovereignty unresolved. Own polygon with a distinct hatch, **not** merged into Morocco. |
| Hong Kong | `HKG` | SAR of China | Not sovereign, but UN WPP and the World Bank both publish full separate series and its demographics differ sharply from the mainland. **Not double-counted** into China or Asia totals. |
| Macao | `MAC` | SAR of China | As Hong Kong. Too small to see at 110m; appears in tables and search with a minimum-size map marker. |
| Antarctica | `ATA` | No permanent population | Rendered for geographic completeness; carries no population, economy, or people data. |

---

## 4. Corrections applied to upstream data

Corrections are for **demonstrable upstream errors**, not editorial taste. Each
asserts the upstream value it expects to find, and the build **fails loudly if
upstream changes it** — a silently stale correction could reintroduce the very
error it was written to fix.

### 4.1 Vatican City UN membership

`mledoze/countries` flags Vatican City (`VAT`) as `unMember: true`. **This is
wrong.** The Holy See is a UN **non-member observer state**, the same status as
Palestine. There are exactly 193 UN member states.

Left uncorrected it inflates our UN member count to 194 and puts a false "UN
member" badge on the Vatican City page.

*Found by the crosswalk validator's hard assertion that the UN member count is
exactly 193 — the check earned its keep on its first run.*

### 4.2 Sri Lanka → India border asymmetry

`LKA` lists `IND` as a neighbour; `IND` does not reciprocate. Sri Lanka is an
island with **no land border**, so the edge is spurious.

**Not hand-deleted.** The border graph is symmetrised by **union**, because the
two failure directions are not equally bad for the Phase 4 map colouring:

- a **missing** edge lets two real neighbours take the same fill → violates an
  acceptance criterion
- an **extra** edge merely over-constrains the colouring → visually harmless

Union guarantees we never miss a real edge. The spurious `LKA–IND` constraint
costs one hue nudge. The asymmetry is recorded as a manifest warning and
surfaces in the app's data-freshness panel rather than being silently
swallowed.

### 4.3 Correction to a Phase 1 claim: Kosovo in UN WPP

Phase 1 recorded that "UN WPP publishes Kosovo within Serbia". **That was
wrong**, and Phase 2 disproved it against the source file.

WPP 2024 publishes Kosovo as its **own Country/Area series** under
`ISO3_code = XKX`, named "Kosovo (under UNSC res. 1244)", with 152 rows
covering the full 1950–2100 range. The two series are **disjoint**: Serbia is
6,773k for 2023 and Kosovo 1,700k, so Serbia's WPP figure *excludes* Kosovo and
there is no double-counting to correct for.

No subtraction, estimation, or apportionment is needed anywhere.

---

## 5. Cross-check findings (Phase 2)

### 5.1 What the OWID cross-check does and does not prove

Our World in Data's population series cites "HYDE (2023); Gapminder (2022);
**UN WPP (2024)**". For modern years it *is* the same data we ingest, so
agreement does **not** independently corroborate the UN's estimates.

What it validates is **our own parsing** — the thousands→persons conversion,
the ISO3 join, and the Country/Area filter. A disagreement means we broke
something. The report states this limitation explicitly rather than implying
broader verification than it delivers.

### 5.2 Togo: an OWID-side source substitution, not our bug

Of 1,180 compared country-years, Togo is the **only** material disagreement —
9,304,338 (ours) vs 8,223,853 (OWID) for 2023, a 13.1% gap that persists across
the whole 1990–2023 range.

Evidence that our figure is right:

- It equals the raw `WPP2024_Demographic_Indicators_Medium.csv` value
  (9304.338 thousand) exactly.
- Every neighbouring country matches OWID to **0.00%** — Ghana, Benin, Burkina
  Faso, Côte d'Ivoire, Niger all agree to within 2 people in 33 million.
- Our 237 country rows sum to **8,091,734,931**, matching WPP's own published
  World aggregate exactly.

A pipeline bug cannot be Togo-specific while every neighbour agrees to
floating-point precision. OWID has substituted a non-WPP source for Togo.
Recorded as a manifest warning; no change to our figures.

### 5.3 Channel Islands: excluded, not apportioned

The World Bank publishes `CHI` ("Channel Islands") and does **not** publish
Jersey or Guernsey separately. ISO 3166-1 assigns them separate codes (`JEY`,
`GGY`) and both appear on our map.

**Decision: exclude `CHI` entirely.** Splitting a combined figure between two
jurisdictions would be fabrication, and there is no published basis for a
split. The honest consequence, stated plainly: **Jersey and Guernsey render
"not available from World Bank" for every economic indicator.**

### 5.4 Microstate rounding is not a discrepancy

25 comparisons exceeded the 0.5% relative tolerance while differing by **fewer
than 1,000 people** — Tokelau (≈1,600 residents), Vatican City (≈500), Niue,
the Falklands, Montserrat. WPP publishes counts in thousands, so for an entity
of 2,000 people the published precision *is* roughly ±1 person and sub-2%
relative agreement is unattainable in principle.

The cross-check therefore requires a discrepancy to exceed **both** a relative
tolerance and a 1,000-person absolute floor. Without the floor, 25 rounding
artifacts buried the one finding that mattered.

---

## 6. Provenance model

Three dates are tracked **separately** and must never be conflated, because
collapsing them is the most common way a dashboard implies its data is fresher
than it is:

- **`vintage`** — the year the *observation* describes. This is what appears
  next to a figure.
- **`upstream_release`** — when the publisher cut the release (ETag /
  Last-Modified where offered; `null` when not, recorded honestly rather than
  substituted).
- **`fetched_at`** — when *we* downloaded it. This is **not** a data date.

The "data freshness" panel shows all three. A figure is never labelled with
`fetched_at` alone.

---

## 7. Composition data (ethnicity, religion, language)

Per the brief, and restated here because it is the easiest rule to erode:

- Census/estimate **year is attached prominently** to every figure.
- Where a state does not collect or publish a category, render **"not
  collected / not published"** — never a zero, never an omission, never an
  inferred value.
- **Never interpolated, never projected.** These are not time series.
- **Never blended across sources** in a single chart. If two sources disagree,
  they are shown as two sources.
- Figures that are politically contested are marked as such.

---

## 8. Equal-area requirement

All area math is done in **EPSG:6933** (NSIDC EASE-Grid 2.0 Global, cylindrical
equal-area). Computing area from EPSG:4326 degrees is wrong — a degree of
longitude is ~111 km at the equator and ~0 at the poles — and would badly
distort every biome share.

The map uses **`d3.geoEqualEarth()`**, swappable via config to Mollweide or
Eckert IV. Mercator is not an option: Greenland must read visibly smaller than
Africa.

---

## Open questions

- **SGS continent assignment** (§2.2) — Antarctica vs South America.
- Whether to surface UN WPP's own regional aggregates alongside our computed
  seven-continent ones, given they will not match (§2).
