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

## 6. Map geometry (Phase 3)

### 6.1 Three polygons with no country code

The 110m Natural Earth topology keys geometries by **UN M49 numeric code**, and
three carry `id: null` because the entity has no M49 code at all. Each needed
an explicit ruling; none could be resolved by a join.

| Natural Earth polygon | Assigned to | Reasoning |
|---|---|---|
| Kosovo | **`XKX`** | Our Kosovo entity. Straightforward. |
| N. Cyprus | **`CYP`** | Not a separate entity for us — no ISO 3166-1 code, and both UN WPP and the World Bank report its territory within Cyprus. Colouring Cyprus while leaving a hole where Northern Cyprus sits would imply we hold a figure for one and not the other, which is false. |
| Somaliland | **`SOM`** | Same reasoning as Northern Cyprus. |

Consequence: Cyprus and Somalia are each drawn by **two** polygons, so their
fill paints multiple paths. Recorded as a manifest warning.

### 6.2 Sixty-four countries too small to draw

Only **175 of 250** entities have a polygon at 110m. The missing ones are
islands and city-states — but that set includes **Singapore, Malta, Bahrain,
Mauritius, Hong Kong, and Macao**: real places with millions of residents that
would otherwise be simply absent from a population map.

**Decision: keep 110m for rendering (per the brief, and because 50m roughly
quadruples the payload for detail invisible at world zoom) and emit a POINT
MARKER for every entity that has population data but no polygon.** 64 markers
result.

A marker is honest — it says "this exists, here, and is too small to draw at
this scale" — where omission silently implies the country does not exist. The
readout states plainly that a marker's size is **not to scale**, so it is never
mistaken for an area encoding. Markers also carry a 24px hit target, which a
sub-pixel polygon never could.

The remaining **11** entities have neither polygon nor population data (the
uninhabited Antarctic and outlying territories); they appear only in the table.

### 6.3 Continent fill uses emphasis, not seven colours

The obvious design — one hue per continent — **fails colour-blind validation**.
Running the seven-slot palette through the validator on the all-pairs list
(which is what a choropleth demands, since any two continents can be compared):

```
[FAIL] CVD separation      worst #008300 ↔ #eb6834  ΔE 3.2 (protan)
[FAIL] Normal-vision floor worst #e87ba4 ↔ #eb6834  ΔE 12.9  (floor 15)
```

Repeating hues across non-adjacent continents (the four-colour-map trick) was
rejected too: it breaks the legend, where Africa and North America sharing a
swatch is unreadable.

**Decision: the emphasis pattern.** Land is neutral; continents are identified
by **direct labels on the map plus position**; a single accent hue marks the
hovered or selected continent and the rest dim. For continents, label and
geography are far more reliable identifiers than hue ever was.

### 6.4 Contested entities are hatched, not just coloured

Contested and special-status entities carry a 45° hatch overlay in addition to
any fill. Status is never conveyed by colour alone — this is what keeps the
distinction legible for colour-blind readers, in print, and under
`forced-colors`.

---

## 7. Flag-derived map colour (Phase 4)

### 7.1 The brief's hue-nudge cannot work, and the reason is geometric

The brief prescribes clamping lightness and chroma to a narrow band, then
"nudging hue within a small tolerance" so no two bordering countries share a
swatch. **That cannot separate neighbours**, and it is not a tuning problem.

Two fills sharing lightness and chroma sit on a circle of radius *C* in the
OKLab a/b plane, so their perceptual separation is the chord:

```
ΔE = 2 · C · sin(Δhue / 2)
```

At the prescribed chroma of 0.055:

| hue nudge | 12° | 18° | 30° | 60° | 180° (max) |
|---|---|---|---|---|---|
| ΔE (OKLab ×100) | **1.15** | **1.72** | 2.8 | 5.5 | **11.0** |

Roughly **ΔE 2–3 is the just-noticeable difference for large adjacent colour
fields**. So a 12–18° nudge is invisible, and the separation is *capped at 2·C*
however far the hue travels. Reaching the dataviz guidance's ΔE 8 target would
need a ~93° hue shift — which is no longer that country's flag colour.

Raising chroma until hue differences read was rejected separately: the dataviz
anti-patterns rule out saturated fills on large marks ("thick saturated blocks
… reads loud"), and country polygons are the largest marks on the page.

### 7.2 What we do instead

**Lightness is the efficient channel** — ΔE equals ΔL×100 directly, so a single
0.055 step buys ΔE 5.5, more than opposite hues can buy at low chroma.

```
hue        ← the flag's dominant hue, UNMODIFIED   (carries identity)
chroma     ← constant and low                       (one coherent system)
lightness  ← one of four tiers, graph-coloured      (guarantees separation)
```

Four tiers is not arbitrary. The **four-colour theorem** guarantees any planar
map is 4-colourable, so "no country renders the same fill as a country it
borders" becomes a **property of the construction**, not something we hope the
data allows.

**The cost, stated plainly:** lightness now varies for reasons unrelated to any
value. A reader could infer that darker means more populous. The legend says
outright that fill encodes identity and that lightness carries no magnitude.
If you would rather have literal hue-only fills and accept indistinguishable
neighbours, that is a one-line change to the tier count.

### 7.3 Greedy colouring was not good enough

Welsh-Powell (order by descending degree, take the lowest free tier) **failed
on the real border graph** — Czechia, Georgia and Nigeria came out uncoloured
and collided with neighbours at ΔE 0.14. The four-colour theorem promises a
solution *exists*; it does not promise a greedy pass will find it.

Replaced with **DSATUR ordering plus backtracking**, which is exact. On ~250
vertices and 325 edges it solves in milliseconds.

Verified over all 325 bordering pairs:

| theme | min ΔE | median ΔE | pairs below floor | min fill/water contrast |
|---|---|---|---|---|
| light | 5.32 | 11.09 | **0** | 1.48 |
| dark | 4.71 | 11.42 | **0** | 1.43 |

Gated by `npm run check:palette`, which exits non-zero on any violation.

### 7.4 The flag hue distribution justifies the whole exercise

Dominant hues across 250 flags:

| band | blue | green | red | orange | yellow | cyan | purple | magenta |
|---|---|---|---|---|---|---|---|---|
| count | 76 | 52 | 51 | 46 | 19 | 6 | **0** | **0** |

90% of the world's flags fall in four bands and two bands are empty — exactly
the clustering that makes naive flag colouring produce an unreadable map.

### 7.5 Raw flag colour is accent-only where it fails contrast

**91 of 250 raw flag colours fail WCAG AA as text on the light surface** —
yellows and light blues especially. Each entity therefore stores both the raw
colour *and* a guaranteed-AA text step. The country page uses the raw colour
for rules and swatches only; text always uses the safe step. Colour that cannot
carry text never carries text.

Continent accents are the **circular mean** of member flag hues. An arithmetic
mean would place a continent straddling 350° and 10° at 180° — cyan, which is
nobody's flag.

---

## 8. Factbook ingestion (Phase 5)

### 8.1 The GEC code trap, and a name-matching bug it exposed

Factbook files are named by **GEC code**, which is *not* ISO 3166-1 alpha-2:
`ch` is China (Switzerland is `sz`), `ja` is Japan (Jamaica is `jm`), `gm` is
Germany (the Gambia is `ga`). We therefore join on each file's own
`Government > Country name` rather than any code table.

That join initially produced **three silent mis-assignments**, all caused by
`normalise_name()` stripping constitutional boilerplate:

| collapsed to | entities merged | consequence |
|---|---|---|
| `united` | United **States** / United **Kingdom** | **the US got no Factbook data at all** |
| `congo` | DR Congo / Republic of the Congo | Republic of the Congo got none |
| `virgin islands` | US / British Virgin Islands | US Virgin Islands got none |

The aggressive fold is now **fallback-only and collision-aware**: matching
tries a strict normaliser (accents, case, punctuation — no word dropping)
first, and the loose index deliberately excludes any key that more than one
entity folds onto, so an ambiguous name is a **miss rather than a wrong
answer**. Coverage went from 236 to 242 entities.

Svalbard and Jan Mayen are two Factbook files for one ISO entity (`SJM`);
Svalbard wins because it holds essentially the whole population, and Jan Mayen
is reported unmatched rather than overwriting it. West Bank and Gaza Strip are
likewise two files for `PSE`.

**8 entities have no Factbook entry** (Åland, Caribbean Netherlands, the French
overseas departments, US Minor Outlying Islands) — the Factbook covers them
inside their parent state. Their People and Government sections say so.

### 8.2 Two parsing bugs that silently deleted the largest category

**Bug 1 — trailing qualifiers.** The percentage matcher anchored `%` to
end-of-segment, so any category with an annotation lost its number entirely:

```
"Muslim 97.1% (official; predominantly Sunni)"  ->  percent = null
```

This hit the **largest** group every time, because that is the one editors
annotate. Jordan's religions summed to 0.9%, Mozambique's ethnic groups to
1.0%, Comoros' religions to 2.0%. Parentheticals are now lifted off each
segment before matching (and preserved as a qualifier). The same fix stops
nested breakdowns — `"Protestant 5% (Evangelical 4.6%, Adventist 0.2%)"` —
being double-counted as extra top-level categories.

After the fix, fields summing to ~100% rose from **310 to 423**.

**Bug 2 — two surveys concatenated in the source.** Uruguay's religions field
runs two separate surveys together with no separator:

```
"... none 47.3%, unspecified 3.4% Roman Catholic 42%, Protestant 15%, ..."
```

Parsing that yields nonsense (`"unspecified 3.4% Roman Catholic" = 42%`). Any
segment containing more than one percentage is now flagged as malformed, and
such a field is **never charted** — the published wording is shown with an
explanation instead. This is §0's "never blend categories from different
sources" rule, tripped inside the source itself.

### 8.3 Sums above 100% are not always errors

Sri Lanka's languages total 139.3% (Sinhala 87, Tamil 28.5, English 23.8) and
Cook Islands' 170.9%. **This is correct** — respondents speak more than one
language. Language fields carry `sharesMayOverlap`, and the app explains the
overlap rather than reporting an error. Ethnicity and religion totals away
from 100% are surfaced as unreconciled, still never rescaled.

### 8.4 Vintage spread is the norm, not the exception

Across 242 entities:

- **170** have two or more dated People fields
- **52** span 5+ years within one country
- **26** span 10+ years
- Jersey spans **20 years** (ethnicity 2021, languages 2001)
- **India's ethnic composition is from 2000** — 26 years old

A single "as of" date for the People section would misrepresent most countries,
so each figure carries its own year in a prominent badge, and anything 15+
years old is additionally flagged **dated**.

Fields published as prose without percentages are never charted:
**35** ethnic-group, **22** religion and **55** language fields are prose-only,
and **143 entities have no language data at all**.

---

## 9. Biome computation (Phase 6)

RESOLVE Ecoregions 2017 (847 polygons) intersected with Natural Earth 50m
country polygons, both reprojected to **EPSG:6933** before any area
arithmetic, summed by (country, biome), normalised to each country's land area,
then aggregated to continents by **summing areas before dividing** — averaging
member percentages would let Vatican City count as much as Russia.

### 9.1 The equal-area step, validated independently

Country land area is measured from the projected polygon, so it can be checked
against a completely separate published figure (`npm run check:biome-areas`):

```
183 countries over 1,000 km²
  median absolute error : 1.14%
  within 5%             : 79%
  mean signed error by latitude band:
    equatorial  |lat| < 23   -2.78%
    temperate  23-50         -1.94%
    high latitude  >= 50     -4.31%
```

**The absence of a latitude trend is the point.** An unprojected, degree-based
area collapses toward the poles, so high-latitude countries would show a huge
negative error while equatorial ones stayed near zero. A flat profile across
all three bands is direct evidence the CRS is doing its job. Greenland comes
out at 2,171,413 km² against a published 2,166,086 km² — 0.25% apart.

### 9.2 Shares do not sum to 100, and that is reported rather than hidden

`share` is a percentage of the country's **own** land area, not of its
ecoregion coverage. That makes the ±1% validation mean something: a sum of 94%
says 6% of the polygon carries no terrestrial ecoregion. **114 of 235 entities**
fall outside tolerance, with two distinct causes:

- **Large countries with inland water or ice** — Tanzania 94.6% (Lakes Victoria
  and Tanganyika), Canada 98.5% (Great Lakes), Greenland 97.7% (ice sheet).
  Terrestrial ecoregions correctly exclude open water.
- **Small island territories the source does not resolve** — Maldives 1.3%,
  Marshall Islands 6.2%, Kiribati 8.2%. 78 of the 114 are under 50,000 km².

The bar renders the shortfall as a visible gap, labelled "no ecoregion
assigned", instead of stretching to full width. Stretching would erase real
information.

### 9.3 Simplification was tested, not assumed

Small-island under-coverage looks like simplification damage. **It is not.**
Re-running at a 4× finer tolerance (1000 m → 250 m) moved the failure count
from 114 to 117 and the Maldives from 1.3% to 4.9% — i.e. nothing, for roughly
five minutes of extra compute. RESOLVE Ecoregions simply does not resolve small
oceanic islands. The coarser tolerance is kept and the gap reported honestly.

### 9.4 A resolution inconsistency the area check caught

The 50m layer initially dropped Northern Cyprus and Somaliland, because their
`ADM0_A3` codes are not in our registry. Cyprus measured **38% below** and
Somalia **26% below** their published areas.

This mattered beyond the numbers: at 110m the map assigns both polygons to
their parent state (§6.1), so the map and the biome maths would have disagreed
about what those countries *are*. The 50m resolver now applies the **same**
editorial rulings by name. Only Siachen Glacier remains unresolved, which is
correct — it is disputed territory belonging to no entity in our registry.

### 9.5 Western Sahara: the map and the biome maths disagree, by construction

At 50m, **Natural Earth attributes most of Western Sahara to Morocco.**
Measured against published figures: Morocco **+30.3%**, Western Sahara
**−65.9%**.

We do not re-cut that boundary — doing so would be taking a sovereignty
position in geometry rather than in prose. The consequence is stated instead,
in the manifest and on the page: **Morocco's biome shares include territory the
map renders as Western Sahara, and Western Sahara's shares cover only the
remainder.** Any entity whose measured area differs from its published area by
more than 25% is flagged the same way.

---

## 10. The "live" counter (Phase 7)

### 10.1 It is a model, and it says so

No source publishes live population. UN WPP publishes one figure per year,
dated **1 July**. The counter interpolates between the two nearest annual
points and advances continuously. Every figure it shows is a modelled
estimate, labelled in the UI as **"Modelled estimate, interpolated from UN WPP
2024"**, with an expandable explanation of the method.

### 10.2 We anchor on the annual figures rather than tick on births and deaths

The brief specifies advancing the count using "that country's implied
births/deaths/net-migration per second". Implemented literally, that drifts
away from the UN's own numbers, because **the components do not reconcile with
the published year-on-year change**:

| | published Δ population | births − deaths + migration | gap |
|---|---|---|---|
| India 2026 | 12,539,098 | 12,659,731 | +1.0% |
| China 2026 | −3,234,683 | −3,088,918 | −4.5% |
| **Germany 2023** | **4,011** | **294,662** | **×73** |

Median gap ≈1.4% of the annual change. The cause is structural: population is
a **1 July snapshot** while births and deaths are **calendar-year totals**, so
the two are measured over different intervals.

**Decision:** interpolate between the published anchors — exact at both ends by
construction — and derive the per-second rate from that same interpolation. The
component flows are still shown, because they are the demographic explanation
of the movement, but they are labelled as annual totals and the UI states
plainly that the two rates differ and which one drives the counter.

At world level the two agree closely (components +2.18/s vs anchors +2.17/s),
and world net migration sums to **+0.00/s** — a useful internal check, since
migration must net to zero globally.

### 10.3 Today's counter is inside a projection

WPP 2024 carries estimates only through **2023**. A counter running in 2026
therefore interpolates between two *projected* figures. The label says so
explicitly: *"because UN WPP 2024 carries estimates only through 2023, both
ends of that interpolation are projections, not measurements."*

### 10.4 Scrubbing pins the year and stops the ticking

A running count only means anything for the present, so selecting a year with
the scrubber freezes the counter and shows that year's published figure,
badged **estimate** or **projection**, with the boundary drawn on the slider
track.

When a historical year is selected, **only population changes**. Growth rate
and density are blanked rather than carried over, because showing a 2023 growth
rate beside a 1960 population would mix vintages — the exact failure this
project avoids everywhere else. The table says so in words.

### 10.5 Motion is opt-out

A figure changing ten times a second is precisely what
`prefers-reduced-motion` exists to suppress. Under that setting the counter
holds a static interpolated value and scrubber playback refuses to start. The
ticking figure is also `aria-hidden`, with a stable screen-reader description
alongside it — an `aria-live` region updating ten times a second is unusable.

---

## 11. Monthly refresh (Phase 8)

### 11.1 The manifest churns, so the diff cannot be naive

`.github/workflows/refresh-data.yml` re-runs the full ETL on the 3rd of each
month (and on demand). The obvious implementation — diff `/data`, open a PR if
anything changed — **does not work**, and this was flagged as a risk back in
Phase 2.

The manifest embeds `generated_at` and a `fetched_at` per source, so it differs
on **every** run. Verified by running the ETL twice back to back:

```
content fingerprint  run 1: b2229dab2614b8c7…   run 2: b2229dab2614b8c7…   identical
manifest.json sha256 run 1: 73983C3D2361…       run 2: 097B375289A0…       DIFFERENT
```

A naive diff would therefore open a pull request every month containing nothing
but new timestamps, and a real data change would be invisible inside that
noise.

**Fix:** the ETL stamps a `content_fingerprint` — SHA-256 over every artifact
*except* the manifest. The workflow compares that, opens a PR only when it
moves, and otherwise discards the timestamp-only manifest change so the tree
stays clean. `python etl/run.py --fingerprint` prints it.

**Consequence, stated honestly:** when nothing changes upstream, `fetched_at`
is not advanced. That is correct — it describes when the *committed bytes* were
retrieved, not when we last checked. The check itself is recorded in the
workflow run summary, and the manifest carries a `refresh_policy` string that
the freshness panel displays.

### 11.2 `--refresh` really does reproduce everything now

Flag extraction and the palette build are Node scripts (SVG rasterising needs a
real renderer; `sharp` has one). Leaving them as separate `npm run` steps made
the acceptance criterion — *"`python etl/run.py --refresh` reproduces `/data`
from scratch with no manual steps"* — **false**: a fresh checkout would have
built a map with no country colours.

`etl/sources/flags.py` now bridges to them, resolving `npm` across platforms
and failing with an actionable message if Node is absent (`--skip-flags` opts
out). The stage also re-reads the palette verification and **refuses to
publish** if any bordering pair shares a fill.

### 11.3 What the workflow gates before opening a PR

1. every upstream reachable (`--check-sources`)
2. every World Bank indicator code still resolves (`--validate-indicators`)
3. full ETL against live sources (`--refresh`)
4. `npm run check` — WCAG AA contrast in both themes, the equal-area
   projection ratio, the adjacency colouring, the polygon-area sanity check
5. `npm run build`

A separate `ci.yml` runs the same verification on every push and PR without
touching the network, plus a fingerprint check that catches `/data` being
edited by hand without re-running the ETL.

### 11.4 The freshness panel shows opaque version tags as such

Several servers offer an ETag rather than a `Last-Modified` date. Rendering
`W/"1a4f1-8dtjGzlGpmC8r8Twr0B+StMP8nE"` in a reader-facing column looks like a
bug and communicates nothing, so those render as *"version tag only, no date"*
with the raw value in the title attribute. Real dates render as dates.

---

## 12. Accessibility and performance (Phase 9)

### 12.1 The map had 241 tab stops

Measured, not estimated. Every country polygon and marker carried
`tabindex=0`, so a keyboard user had to press Tab **241 times** to get past the
map — 763 tab stops on the page in total. Technically not a keyboard trap;
practically unusable.

Replaced with a **roving tabindex**: the map is one tab stop, and the arrow
keys move between countries by nearest centroid in the pressed direction, with
Home/End for the westernmost and easternmost and Enter to open. Verified —
pressing Right repeatedly walks Wallis and Futuna → Samoa → American Samoa →
Niue → Cook Islands → French Polynesia, a genuine west-to-east traverse of the
South Pacific.

Map tab stops: **241 → 1**. Page total: **763 → 524**.

The remaining 524 are mostly the 250-row entity table (two links per row). That
is inherent to a table of links, and the mitigations are the standard ones: a
skip link past the map, proper landmarks, and the table's own search filter.

**A note on focus timing:** focusing the newly-active country from the key
handler — even inside `requestAnimationFrame` — races React's commit. The
tabindex moved but the browser kept focus on the old element. Focus is now
applied in an effect, after the DOM is committed.

### 12.2 Contrast verified on rendered elements, not just tokens

`check-contrast.mjs` gates the token values, but tokens are not what a reader
sees. An in-browser audit sampled **1,090 rendered text elements** and computed
each one's contrast against its true effective background:

```
light: 1090 checked, 0 failures
dark:  1090 checked, 0 failures
```

That audit caught one real defect the token check could not: the active
**Country** toggle sat at **3.3:1** in dark mode, because it reused
`--map-accent-fill` as a button background. That token is tuned for large map
polygons carrying no text. Selected controls now have their own
`--control-selected-bg` / `--control-selected-text` pair (11.19:1 light,
8.89:1 dark), and the pair is gated by the contrast script.

*(The first version of the audit reported 1090/1090 failures — the script, not
the page. Chrome serialises these colours as `oklch(...)`, and the naive regex
parsed those numbers as RGB. Fixed by converting through a canvas.)*

### 12.3 The duplicated dark block bit three times, so it is now gated

The dark palette must be declared twice — once under
`@media (prefers-color-scheme: dark)`, once under `:root[data-theme="dark"]` —
because CSS cannot OR a media query with a selector. The two blocks are
indented differently, so a replace-across-"the dark block" updates only one.

That happened **three separate times**, and the last instance was not cosmetic:
the `--series-*` chart colours were missing from the explicit-toggle block, so
every composition bar and pyramid would have rendered **light-mode hues on a
dark surface** for anyone using the theme toggle rather than an OS setting.

`npm run check:theme-parity` now parses `src/index.css` and fails the build
unless both dark blocks declare identical tokens and every themed token in
`:root` has a dark counterpart.

### 12.4 Performance: SVG is comfortably sufficient

The brief allowed a canvas fallback "if the country count hurts interaction
latency". Measured on the real map — 183 paths, transform mutation plus forced
layout, 30 iterations:

```
median 0 ms · max 0.5 ms
```

No canvas fallback. It would also have cost every per-country accessibility
affordance (focus, labels, roving tabindex), which is a steep price for a
problem that does not exist.

### 12.5 Responsive

Wide content scrolls inside its own container and the page body never scrolls
sideways: `overflow-x: hidden` on `body`, `overflow-x: auto` wrappers on every
table (two were missing — the composition and biome detail tables), and
`overflow-wrap: break-word` on cells so long ecoregion names cannot force a
table wider than a phone screen. Grids collapse to one column below `sm`.

---

## 13. Provenance model

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

## 14. Composition data (ethnicity, religion, language)

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

## 15. Equal-area requirement

All area math is done in **EPSG:6933** (NSIDC EASE-Grid 2.0 Global, cylindrical
equal-area). Computing area from EPSG:4326 degrees is wrong — a degree of
longitude is ~111 km at the equator and ~0 at the poles — and would badly
distort every biome share.

The map uses **`d3.geoEqualEarth()`**, swappable via config to Mollweide or
Eckert IV. Mercator is not an option: Greenland must read visibly smaller than
Africa.

This is **measured, not asserted**. `npm run check:equal-area` computes the
projected planar area of Greenland and of all African polygons and compares
their ratio to the true surface-area ratio:

```
Expected Africa:Greenland ratio 14.02:1 (±15%)
  PASS  Equal Earth   ratio 13.72:1  (off by 2.2%)
  PASS  Mollweide     ratio 13.72:1  (off by 2.2%)
  PASS  Eckert IV     ratio 13.72:1  (off by 2.2%)
```

All three agree to the same figure, which is what equal-area means. The
residual 2.2% is 110m coastline generalisation. The test deliberately checks
the *ratio*, not merely "Greenland is smaller" — the latter is true on Mercator
too at world zoom, so it would not catch a projection regression.

Theme contrast is likewise gated by `npm run check:contrast`, which fails the
build on any WCAG AA violation in either theme.

---

## Open questions

- **SGS continent assignment** (§2.2) — Antarctica vs South America.
- Whether to surface UN WPP's own regional aggregates alongside our computed
  seven-continent ones, given they will not match (§2).
