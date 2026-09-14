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

Four entities land in Antarctica: **ATA** plus three uninhabited sub-Antarctic
island territories — **ATF** (French Southern and Antarctic Lands), **BVT**
(Bouvet Island), **HMD** (Heard and McDonald Islands).

All four are uninhabited apart from research staff. They are **excluded from
every per-capita, density, and population ranking** so they cannot distort
them, and the Antarctica continent page shows only land area and biome data,
stating plainly that there is no permanent population.

### 2.3 South Georgia moved to South America (resolved 2026-08-10)

South Georgia and the South Sandwich Islands (`SGS`) was originally assigned to
Antarctica alongside the other uninhabited sub-Antarctic territories, and
flagged here as the weakest call. **Reversed on evidence.**

| authority | says |
|---|---|
| **UN M49** | World → Americas → Latin America and the Caribbean → **South America** (code 239) |
| nearest neighbour | Falkland Islands, **1,493 km**, itself South America |
| **RESOLVE ecoregions** | realm **Antarctica**, ecoregion "Scotia Sea Islands tundra" |

M49 is the authority this project follows for every other transcontinental
case, with Cyprus (§2.1) the single documented override, so consistency decides
it: **SGS is South America.**

**The tension is real and is recorded rather than hidden.** Biogeographically
SGS is *not* South American — its ecoregion sits in the Antarctica realm, while
the neighbouring Falklands' "Patagonian steppe" is Neotropic, which shows the
realm boundary is a genuine feature and not an artefact. We follow the
political classification because these are groupings of *countries*, not of
biomes.

Effect: SGS is uninhabited, so **no population figure changes**. It adds
3,684 km² of land and 3,361 km² of Antarctic-realm tundra to South America —
a **0.019%** share of that continent's biome mix, correctly attributed to land
that really is inside it.

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

### 9.5 Western Sahara: correcting a claim this document got wrong

An earlier version of this section stated that *"Morocco's biome shares include
territory the map renders as Western Sahara"* — implying the 50m biome layer
and the 110m map disagreed. **That was wrong.** Measured directly:

| entity | 110m (map) | 50m (biomes) | published |
|---|---|---|---|
| Morocco | 592,381 km² | 581,713 km² | 446,550 km² |
| Western Sahara | 96,452 km² | 90,593 km² | 266,000 km² |

Natural Earth draws the **de facto administered boundary at both
resolutions**, so the map and the biome maths **agree with each other**. There
is no internal inconsistency to fix.

What is true, and what the pages now say, is this: **both** give Western Sahara
roughly a third of its internationally recognised extent, with the remainder
drawn inside Morocco.

**Decision: keep Natural Earth's geometry.** Sourcing and asserting an
alternative boundary line would be a *larger* sovereignty statement than
adopting a widely used public-domain cartographic standard and disclosing its
convention. Re-cutting the polygon would embed the claim in geometry, where a
reader cannot see it; disclosing it puts the claim in prose, where they can.

Any entity whose drawn polygon differs from its published land area by more
than 25% is flagged the same way, and now renders a **boundary note on its own
page** rather than only in the manifest. Five qualify: `ESH` −66%, `ALA` −52%,
`PYF` −38%, `MAR` +30%, `FRO` −25%. The last three are small-island coastline
definitions, not disputed territory.

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

#### The first version was not portable, and CI caught it immediately

Phase 8 claimed the fingerprint was "verified stable". It was verified on **one
platform**, where stability is trivially true — which is not the property that
matters. The first push to GitHub failed CI in 25 seconds, on identical
committed content. **Two independent causes**, found in that order:

**Cause 1 — line endings.** Python's text-mode write turns `\n` into `\r\n` on
Windows, while `.gitattributes` stores LF and the Linux runner checks LF out.
Hashing raw working-tree bytes measured the newline convention alongside the
content.

**Cause 2 — sort order.** This was the actual blocker, and it survived the
first fix. `sorted()` on `Path` objects compares via `_str_normcase`, which is
**case-folded on Windows and case-sensitive on POSIX**. Our tree mixes
lowercase names with UPPERCASE ISO3 filenames, so the orders genuinely diverge:

```
        windows order            posix order
  ...   factbook/COM.json        factbook/COM.json
  →     factbook/coverage.json   factbook/CPV.json
        factbook/CPV.json        factbook/CRI.json

  194 of 977 positions differed
```

Because the digest folds in each path followed by its content, a different
traversal order yields a different hash for byte-identical data.

Fixed on three fronts:

1. `content_fingerprint()` sorts by the **POSIX relative-path string**, which
   Python compares case-sensitively on every platform.
2. It normalises CRLF→LF for known text suffixes, so the hash describes content
   rather than encoding. Other suffixes are hashed byte-for-byte, so a future
   `.parquet` is never corrupted by newline substitution.
3. All 16 ETL `write_text` calls pass `newline="\n"`, so the working tree stops
   diverging from the repository at source.

Verified the right way this time: after the fix, this Windows machine computes
`ff4de861…`, **the exact hash the Linux runner had reported** — confirmed
before pushing rather than by another round trip.

The lesson, recorded because it was learned the hard way: **a value whose whole
purpose is to be compared across machines must be verified across machines.**
Verifying it twice on one machine proves nothing at all.

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

#### Verified end to end on a real runner (2026-08-10)

Not "written and plausible" — executed. A `workflow_dispatch` run against live
upstreams reproduced this machine's output **exactly**:

| stage | Ubuntu runner | local (Windows) |
|---|---|---|
| WPP series / pyramids | 237 / 237 | 237 / 237 |
| World Bank indicator files | 250 | 250 |
| Palette bordering pairs | 325, min ΔE 5.32 | 325, min ΔE 5.32 |
| Factbook | 242 matched, 16 unmatched, 8 absent | identical |
| Biome overlay | 1765 intersection pieces, 235 entities | identical |
| OWID cross-check | 1180 compared, 4 material | identical |

All eight upstreams reachable, all 26 World Bank indicator codes resolving,
every verification gate passing, and — the point of the whole design — the
fingerprint came out **unchanged**, so the "Discard timestamp-only manifest
churn" step ran and **no pull request was opened**. That is the spurious-PR
problem of §11.1 demonstrably solved rather than merely argued.

This also settles the reproducibility criterion: `python etl/run.py --refresh`
rebuilds `/data` byte-identically on a different operating system.

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

## 16. The 2026-08-15 overhaul (maintainer-requested)

### 16.1 Our World in Data promoted to a primary source

The brief-era rule was "OWID is a cross-check, never primary" (§5). That rule
was written about OWID's *population* series, which is UN WPP re-published and
therefore cannot corroborate itself. It still holds for population.

The new **Freedom** and governance measures are a different situation: V-Dem
publishes no stable keyless API, and OWID redistributes its indices under
CC BY with clean ISO3 keys. There, OWID is the distribution channel and the
citation names the producer — pulled from each grapher's own metadata endpoint
so a producer change upstream lands in our manifest rather than going stale.
Series ingested: electoral/liberal democracy, human rights, political
corruption, rule of law (all V-Dem), Regimes of the World classification,
state capacity (Hanson & Sigman), CO₂ per capita (Global Carbon Budget).
Democracy series are trimmed to 1900+ (`OWID_START_YEAR`).

**Direction trap, recorded:** V-Dem's political corruption index runs HIGHER =
MORE corrupt — the opposite sense to WGI's "control of corruption". The tile
note says so explicitly.

### 16.2 World Bank WGI codes are archived

PV.EST / GE.EST / RL.EST / CC.EST resolve in the v2 `/indicator` catalogue but
their data endpoints answer "deleted or archived", and the WGI database
(`source=3`) hangs outright. `--validate-indicators` alone would NOT have
caught this — it checks the catalogue, not the data envelope. Governance
measures moved to V-Dem via OWID (§16.1).

### 16.3 UNESCO World Heritage and the WAF

whc.unesco.org fronts its own syndication feed with bot mitigation that 403s
any non-browser user agent, including our honest ETL UA. The feed exists
explicitly for reuse, so the heritage stage identifies as a browser for this
one source (`WHC_BROWSER_UA`). If UNESCO gates the feed properly, the stage
fails loudly rather than shipping a stale list.

### 16.4 Exchange rates are annual, on purpose

"Show how each currency relates to the US Dollar" is served by World Bank
PA.NUS.FCRF (official rate, period average) with its year on the tile. No
keyless source publishes live FX; showing a dated official rate honestly beats
scraping one covertly.

### 16.5 The globe view and the equal-area rule

§15 declares equal-area only. The orthographic globe added at the maintainer's
request is a PERSPECTIVE view: it foreshortens toward the horizon exactly as a
physical globe does, and it never produces Mercator's systematic
latitude-dependent inflation, which is what §15 exists to prevent. It is
opt-in; every flat projection remains equal-area and the `check:equal-area`
gate still runs against the flat math.

### 16.6 Map palette brightened

The original band (chroma 0.055/0.06) was a deliberate restraint choice
(§7). The maintainer overrode it: chroma is now 0.10 light / 0.11 dark with
the dark tiers lifted to 0.34–0.52. Two facts made this safe: hue-chord
separation scales linearly with chroma, so neighbour ΔE improved (min 5.28
light / 5.79 dark against the 4.0 floor), and fills are clamped into sRGB
gamut per hue with `clampChroma`, so no channel-clipping can silently break
the tier guarantee.

### 16.7 Factbook ALL-CAPS surnames

The Factbook renders surnames in ALL CAPS ("President Emmanuel MACRON"). This
is normalised at the DISPLAY layer only, with a Roman-numeral guard
(ABDULLAH II keeps its II); the committed artifact preserves the Factbook's
own text. Applied only to the chief-of-state and head-of-government fields,
where the convention is systematic.

---

## 17. The 2026-08-16 batch (maintainer-requested)

### 17.1 One map colour system

The globe's palette (dark blue ocean, sunlit light land in both themes,
black space behind the sphere) now applies to every projection. The old
per-theme land tiers still exist in the palette artifact but the map renders
the light set everywhere; the land-vs-ocean floor (contrast ≥ 2.0, actual
minimum 4.36) is what makes "blue country vs blue sea" confusion impossible
without banning blue land.

### 17.2 Leader portraits (Wikidata + Commons)

The Factbook names office-holders but has no photographs. Portraits come
from Wikidata's truthy P35/P6 with P18 images, committed at build time like
every other artifact. Two guardrails: a portrait ships ONLY when the office
has exactly one truthy holder (Bosnia's presidency, San Marino's captains
regent and the Swiss federal council get none rather than one misleading
face), and every image links its Commons file page for author and licence
attribution. The Factbook prose remains the authoritative text; the Wikidata
name rides with the photo as a caption so a disagreement is visible.

### 17.3 GDP summary artifact

The entity table needed one GDP figure per entity; fetching 250 per-country
indicator files for it would have blown the home page's load. The worldbank
stage now also emits `indicators/gdp-summary.json` — latest NY.GDP.MKTP.CD
per entity, each value carrying its own year.

### 17.4 "Smaller categories", not "other"

The composition fold bucket collided with sources' own "other" categories
(two "other" rows on the US religions). The bar keeps the fold at 8 hues;
icon-led legends now list every tail category individually.

---

## 18. The 2026-08-23 batch (maintainer-requested)

### 18.1 Somaliland and Northern Cyprus get their own labels

Keying the Somaliland polygon to SOM and the Northern Cyprus polygon to CYP
remains the DATA ruling (their people are counted in the parent's series and
neither has an ISO 3166-1 code — §see geometry notes). But re-labelling those
polygons with the parent's name was a bug, not a ruling: the map drew two
shapes called "Somalia" and two called "Cyprus". Each polygon now keeps its
own name (`POLYGON_LABEL_OVERRIDES` in `etl/sources/geometry.py`) and is
hatched as contested; clicking either still opens the parent entity's page,
which is where its data genuinely lives.

### 18.2 Map label identity, zoom ceiling, and marker labels

The label layer keyed labels by iso3, which is NOT unique per drawn shape
(SOM and CYP each paint two polygons). Duplicate React keys left stale label
nodes behind while panning zoomed-in — the reported "Somalia multiplies" bug.
Labels and paths now key on identity + feature index, never on the path
string (a d-derived key remounted every path node on every rotation frame).

Zoom ceiling raised 12 → 48 so island microstates are reachable, and point
markers carry their name without hover once zoom ≥ 3 — before this, an
island nation's name existed only on hover, which on touch meant only after
tapping the dot.

### 18.3 Globe drag batched to animation frames

Touch screens deliver pointermove at 120–240 Hz; each event forced a full
reprojection render, most thrown away between paints. Drag deltas now
accumulate and apply once per requestAnimationFrame, TopoJSON decoding is
hoisted out of the per-rotation memo, and the pointer is captured once a
drag starts so the spin survives leaving the svg.

### 18.4 Entity table zebra: white / highlighter yellow in BOTH themes

Maintainer ruling. The table body deliberately abandons the theme tokens:
rows alternate #ffffff and #fdff54 with dark text in light AND dark mode.
The muted token is re-scoped inside the tbody so per-cell muted styles
resolve against the light rows. This is a conscious exception to the
theme-parity discipline, contained to the tbody.

### 18.5 Sections: Education and Crime & Incarceration split out

Education (literacy, spending, enrollment) moves out of Demographics and
People into its own section; intentional homicides moves out of Security and
Defense into a new Crime and Incarceration section. Indicator `section` keys
in `etl/config.py` follow, so the by-country artifacts state the same layout
the page renders.

### 18.6 Currency tile presentation

The Currency tile flips its hierarchy on request: "Currency" is the display
line, the unit name(s) sit beneath. Exchange-rate wording says "per US
Dollar" in full.

## 19. New data sections (2026-08-23 batch, maintainer-requested)

### 19.1 The live-fetch exception

Until now the app never talked to an upstream at render time. Live exchange
rates and live weather cannot exist in a committed artifact by definition,
so `src/lib/live.ts` opens a CONTAINED exception: keyless, CORS-verified
sources only (open.er-api.com for FX — attribution link required and
rendered; Open-Meteo for weather — CC BY 4.0, non-commercial API), every
failure resolving to the standard explicit-unavailable state, and no
committed figure ever depending on a live fetch. Everything else in this
batch remains build-time artifacts.

### 19.2 Press freedom: RSF first-party CSV, OWID mirror rejected

RSF publishes the full index at a stable year-keyed CSV URL (windows-1252,
semicolons, decimal commas — all real, all handled). OWID's mirror froze in
2021 on the OLD inverted 0-is-best methodology; mixing the two across years
would corrupt every comparison, so the mirror was rejected outright.

### 19.3 Crime & Incarceration sources

Prison population rate and occupancy come via OWID (producer: ICPR/World
Prison Brief). Absolute prisoner totals and facility counts come from
UNODC's bulk xlsx, whose release-dated URL is re-discovered from the stable
landing page each run. Facility counts exist for only ~93 countries and
render as honest unavailability elsewhere — scraping World Prison Brief's
~220 HTML pages to fill the gap was considered and rejected (no bulk
endpoint, fragile, discourteous to a small academic site).

Death-penalty status: Amnesty compiles it but ships PDFs only; OWID and
Wikidata have nothing current (verified). Wikipedia's "Capital punishment
by country" tables are the one keyless machine-readable source (CC BY-SA,
attributed). Execution figures are kept VERBATIM ("1,000s", "972+") —
parsing a floor estimate into a number would launder its uncertainty.

### 19.4 Education extras: three confidence levels, labelled

University counts (Hipolabs domains list) UNDERCOUNT and say so. Public
library counts come from Wikidata because IFLA's Library Map sits behind
Cloudflare with no keyless endpoint — the label says "recorded in
Wikidata", because Czechia outscoring Germany is a cataloguing artefact,
not a fact about libraries. Top-10 universities come from CWUR's national
ranks (~2,000 institutions, ~90 countries), © CWUR with attribution;
QS/THE are proprietary and were not scraped.

### 19.5 Public debt: interpolated IMF WEO, projections included

IMF DataMapper (keyless, ISO3-keyed, NOT CORS-enabled — build-time only)
provides debt %GDP and nominal GDP including ~5 projection years. The page
interpolates both to the current instant and ticks, extending the
population counter's modelled-estimate discipline; the derived US$ figure
and the projection boundary are labelled as such. Quirk: imf.org's WAF
allows stock client user agents and rejects custom ones, so this one
source fetches as plain `python-requests/x`.

### 19.6 Currency images: representative, never promised as "the smallest bill"

The request was the smallest banknote per country in high resolution. No
structured source orders denominations, banknote copyright varies by
jurisdiction (many modern notes cannot legally be on Commons), and
Wikidata's P18 is whatever an editor chose. So: P18 image per ISO 4217
code, editorial overrides file for curation, per-file licence and author
recorded from the Commons API and rendered, hotlinked at a Commons-bucketed
width — captioned "representative specimen", because that is what it is.

### 19.7 Subdivisions: Wikidata P150 with the former-entity filter

One SPARQL query covers all countries. Items typed as former
administrative entities are excluded (the filter that stops India listing
Daman and Diu), rows dedupe by label, and populations are truthy P1082
whose reference year varies by division — the page says "latest Wikidata
figure" rather than inventing a vintage. GeoNames lost on staleness and a
400 MB dump.

### 19.8 Climate: decade means, not single years

Country temperature series are Copernicus ERA5 via OWID (1940 onward). The
"50-year warming" figure compares 1971–1980 vs 2016–2025 DECADE MEANS;
single-year deltas would swing by degrees on year choice. Precipitation is
the World Bank's climatological average (AG.LND.PRCP.MM) — last updated
2022, which is fine for a climatological normal and labelled with its
vintage. Capitals for the live weather panel come from GeoNames PPLC rows.

## 20. The 2026-08-24 batch (maintainer-requested)

### 20.1 UI rulings

Globe drag sensitivity 0.25 → 0.375 deg/px (the spin still felt ~50% too
slow under a finger after the rAF fix). The fullscreen button's exit glyph
was U+1F87C, which most system fonts have no glyph for — the button
appeared empty exactly while fullscreen; both states are inline SVG now.
The area outside the projected sphere is black space on EVERY projection,
not just the globe. The entity table's zebra becomes dark blue / light
blue (replacing white/yellow), with per-row text polarity. Public debt
presents as "Public Debt: $X" over "Public Debt as a % of GDP: Y%". The
home page washes verdant green in both themes (light-dark pair holding AA
against each theme's text tokens); country pages keep their flag tints.

### 20.2 Leader portraits: the honest floor is six

Backfill run with a refreshed Wikidata query recovered 12 more portraits
(409 → 421). The remaining six single-holder offices (AFG hos, BDI hog,
GNB hog, JEY hog, MOZ hog, PCN hog) have NO P18 image on Wikidata at all —
no free-licensed portrait exists to fetch. Searching Commons by name was
rejected: a wrong-person hit is worse than an empty slot. Twelve
collective offices continue to carry a count and no photo, by design.

### 20.3 Notable inventions and national cuisine: Wikidata, ranked by sitelinks

Both sections use origin-tagged Wikidata items (P495) ranked by
sitelink count — a notability proxy, labelled as such. Coverage is the
data's, not the world's: ~53 countries have tagged inventions, ~101 have
tagged dishes, and the rest render explicit unavailability rather than a
padded editorial list this project has no basis to rank. The cuisine
query runs one class at a time because the combined query answers 504
under load, and 504 is not a retryable status in fetch().

### 20.4 Airports: OurAirports roster, Wikidata traffic

OurAirports (public domain) has every airport but no traffic; Wikidata has
annual passengers (P3872) for ~4,500 IATA codes. Joined on IATA: "top 20
by flight volume" is approximated by best-available passenger figures,
airports without one following largest-class-first — the note says exactly
that.

### 20.5 Flora and fauna: Wikipedia lists, three different shapes

No Wikidata property reliably links a country to its national symbols.
The English Wikipedia lists are the maintained compilations: animals and
trees are rowspan wikitables; the flowers article is prose sections per
country (its only wikitable is SUBNATIONAL emblems and is ignored).
Flower images come from each species article's lead image. Every image
resolves to the original Commons file for licence and author; a file the
Commons API does not know is dropped, never hotlinked blind.

## 21. The 2026-08-24 refinement batch (maintainer-requested)

### 21.1 Inventions: non-edible, and Wikipedia lists join Wikidata

Food and drink are excluded by ruling. Class ancestry alone missed brands
(Coca-Cola is a "drink brand", which does not subclass food) and generic
foods (hot dog has no P31 at all — it IS a class), so exclusion is a
three-net test: item/class ancestry to food or drink, class-label
keywords, and (for Wikipedia entries) summary-description keywords.
Exclusion thinned Wikidata to ~39 countries, so ~50 CURATED English
Wikipedia per-country invention list articles now top countries up
(title→ISO3 mapping is explicit, never demonym-parsed; England, Scotland
and Wales fold into GBR). The list parse is heuristic and honestly lossy:
first wiki link names the invention; year, era and inventor are regexed
from prose; every candidate is vetted through its article's REST summary
(missing page = parse noise = dropped).

### 21.2 Photos: iNaturalist for wildlife, TheMealDB for dishes

Commons species images are a lottery (the centre-crop was decapitating
animals). Flora/fauna photos now come from iNaturalist's research-grade
observations — community-vote-ordered, server-side filtered to CC0/CC-BY,
hosted on the open-data bucket iNat publishes for third-party use — with
Commons as fallback. Cuisine photos come from TheMealDB (guaranteed
uniform 700×700 with size variants) for the ~60 countries it covers, with
Wikidata+Commons fallback elsewhere; per-country artifacts name their
source. Clicking any photo now opens an in-page lightbox; the attribution
link still points to the hosting page, because CC attribution must keep
pointing home.

### 21.3 Smaller rulings

Globe drag sensitivity 0.375 → 0.5625 °/px (a second +50%). Public-debt
and precipitation presentation reshaped (multi-unit cm/in/m/ft for large
precipitation readings; mm/in where centimetres would round to noise).
The live-weather panel becomes a weather-app-style condition card:
theme-invariant gradient keyed to the WMO code group, white text at AA,
explicit capital-local update time (Open-Meteo now queried with
timezone=auto). Subdivisions carry the country's own term for its
divisions (most common specific P31 class label — "canton of
Switzerland", "U.S. state"); cuisine entries carry the Wikidata English
description or TheMealDB category as a descriptor.

## 22. The 2026-08-29 accuracy batch (maintainer-requested, Phase 1)

### 22.1 Inventions: a class gate, not a keyword net

Brazil listed Schistosomiasis as a notable invention. The diseases came
from the Wikipedia LIST parse (§21.1 — "inventions and discoveries" by
title), and the Wikidata side had its own noise (a diamond named "Sergio",
P495-tagged): P495 "country of origin" is also set on species, minerals,
diseases first described somewhere, and theorems.

Ruling: every candidate from EITHER source must pass a Wikidata class
gate. The item's P31 classes (and the item itself, for class-like items
such as "hot dog") are walked up P279* in a batched query; the item is an
invention only if that ancestry reaches an ALLOW root (artificial physical
object, device, tool, vehicle, technology, technique, method, process,
product, product model, software, programming language, video game,
medication, chemical compound, material, brand) and none of the DENY roots
(disease, disorder, syndrome, pathogen, biological process, organism,
taxon, anatomical structure, gene, protein, chemical element, mineral,
astronomical object, geographical feature, location, theorem, mathematical
concept, discovery, academic discipline, field of study, occurrence, human,
organization, work of art, literary/musical work, film, written work, ethnic
group, language, religion, sport, award, and — still — food and drink).
Deny wins. Wikipedia list candidates are resolved to their Wikidata item
via the REST summary's `wikibase_item`; no item, no entry. The lists'
sampling window widened (16 → 40) because the gate rejects a large share.

Every rejection is written to `etl/logs/inventions-rejected.json` with the
reason and matched roots — "no allowed class ancestry" is the bucket to
review for a missing root. Countries with two solid entries show two; there
is no padding.

### 22.2 The plausibility layer, and the library count is gone

Russia showed 9 public libraries. The figure was a Wikidata `COUNT` of
items typed "public library", i.e. cataloguing activity, not libraries
(§19.4 already said so; the number still rendered with a number's
authority). IFLA's Library Map holds the official counts behind Cloudflare
with no feed. No reliable source → the field is DROPPED, not relabelled.

Audit of every other count-style field on the country page: universities
(Hipolabs roster, labelled undercount), heritage sites (UNESCO's own list),
airports (OurAirports roster), prisoners/facilities (UNODC), subdivision
populations (Wikidata P1082, per item) are real-source figures, not item
counts. None has the libraries failure mode; all now pass through the
plausibility layer.

`etl/validate.py` is that layer: per-metric absolute bounds (unit defaults
plus overrides) and ratio checks against WPP population (per-capita rules
skipped below 100k people — one university in Niue is real). A failing
figure ships as the standard explicit-unavailable state and is logged to
`etl/logs/plausibility-<stage>.json`. Bounds are deliberately wide — the
layer is a tripwire for order-of-magnitude nonsense (Saint-Martin's 3,700
prisoners per 100k, Fiji's 574 mobile subscriptions per 100) and was
widened twice during calibration when it caught REAL history (Rwanda's
1994 life expectancy, Angola's 1e-7 pre-redenomination exchange rate,
Kuwait's 117%-of-GDP 1991 military spend).

`etl/logs/` is committed so every suppression and rejection is reviewable
on the PR diff, and lives outside `/data` so the logs neither ship with the
site nor enter the content fingerprint.

### 22.3 Every breakdown accounts for 100%

`etl/breakdown.py` (mirrored in `src/lib/breakdown.ts` for the pairs the
app assembles from World Bank series): components under 100 get an explicit
"Other" for the EXACT difference, in the neutral series token, with a
per-metric explanation rendered visibly (land use: built-up, barren, inland
water, unclassified; biomes: rounding, water/ice, unassigned area; ethnic
groups / religions: unenumerated groups, non-response, rounding; trade
partners: all other partners). Sums over 100 are never clamped: within two
points the chart renders with a note that the source's categories overlap
or round; beyond that the breakdown is SUPPRESSED and the prose renders
(agroforestry land use — Wallis and Futuna 117% — and several religion
fields). A field whose own note says respondents could pick several
categories (New Zealand's census ethnicity, 115%) is multi-response by
design and renders with that note instead. A gap over 40 points is a
missing-data smell rather than an "Other"; those ship WITHOUT an Other,
with a note, and are logged for review (South Sudan ethnic groups 55%,
Andorra / DR Congo / Russia religions). Top-5 partner lists are partial by
construction and always get their Other.

Land use now comes from the Factbook's own `Geography > Land use` block,
which publishes agricultural, forest AND its residual "other" with a common
vintage — shipping the source's residual beats subtracting two World Bank
series of different vintages from 100. GDP sectors gain an Other for net
taxes on products. Urban/rural is one breakdown, both shares from their own
series (§22.5).

### 22.4 Flora and fauna: emblems apart, images verified

Fourteen national "animals" were mythical or heraldic (Unicorn, Druk,
Bundesadler, Phoenix, Qianlima...). The lists tag them "Mythical" in the
scientific-name column; a second net catches an untagged legendary name
with no binomial (the Komodo dragon keeps its binomial and stays real).
They ship in their own `emblems` list and render in a separate "Heraldic
and mythical emblems" sub-section, never in the species grid.

Images: the iNaturalist photo is accepted only when the taxon iNaturalist
resolves is the queried one (scientific name equal, or its species part
for a subspecies; common name equal when no binomial exists) — the search
is fuzzy and an unverified first hit is how a wrong animal gets on a card.
The Commons fallback is accepted only when the file's own name,
description, object name or categories mention the taxon (genus at
least). Anything else renders the typographic species card (common name,
scientific name in italics). Rejections: `etl/logs/florafauna-rejected-images.json`.
iNaturalist stays the primary source (§21.2) rather than Wikidata P18 —
it is verified by taxon identity, which is stronger than an editor's pick.

### 22.5 Rural population from its own series

`SP.RUR.TOTL.ZS` is ingested alongside `SP.URB.TOTL.IN.ZS`; rural is never
computed as 100 − urban. The World Bank stage compares the pair for the
latest common year and warns in the manifest if they differ from 100 by
more than 0.11 points. Headcounts apply each share to the WPP population
estimate for the same year and say so.

### 22.6 Borders are names

Land borders render the neighbour's common name from the registry, sorted,
each a link to its page; the ISO3 code stays as the tooltip and inside the
accessible name.

### 22.7 Banknotes: one treatment, criteria in code

The P18-per-currency approach (§19.6) produced coin stacks, symbol SVGs and
composites, and the numeric-code bug let "203" through as a currency.
Rewritten: the stage walks Wikimedia Commons' "Banknotes of ..." categories
(from the currency's P373 category and the conventional titles), and judges
EVERY candidate — category files, the P18 image, and any editorial override
— by criteria that live in `etl/sources/currencyimages.py`: raster/SVG at
least 600 px wide; landscape aspect between 1.45 and 2.6 (one flat note,
head-on); no reject-list term in the file's name, description or
categories (reverse, back, coin, stack, bundle, hand, wallet, set,
collection, both sides, specimen sheet, …); banknote category or
description. Ranking prefers an explicit obverse mention, then the
smallest denomination the filename states, then width. Overrides cannot
bypass the criteria. Every verdict is in `etl/logs/currency-images.json`;
currencies with no compliant free image render a designed card (name, ISO
code, symbol) — never a mismatched photo. Coverage is what Commons holds:
many modern notes are copyrighted and absent by law.

**Status at ship (2026-08-29): the category walk is OFF.** Two full walks
(about 1,500 rate-limited Commons listings each, hours apiece) showed the
candidate selection is not yet trustworthy: a currency Wikidata lists for
several countries (yen → Zimbabwe, euro → Croatia and Monaco) pulls in
those countries' banknote trees, and a name stem such as "Brazilian"
admits the historic cruzado. Rather than delay the batch, the maintainer
chose to hold the walk for another day. The stage therefore judges only
the Wikidata P18 image and editorial overrides against the criteria
(`CURRENCY_WALK=1` re-enables the walk; `CURRENCY_CACHED_ONLY=1` limits
it to cached listings). The visible result is honest: a compliant single
note where P18 supplies one, the designed card everywhere else. Open
items for the walk: restrict country-named roots to single-country
currencies; whole-word stem matching; rank by series year, not by any
year in a photo's filename.

### 22.8 One icon set

Industry, agriculture and export items used platform emoji through 104
regex rules; ⚙️ was the mapped icon for the metals and machinery rules and
read as a catch-all. Replaced by OpenMoji's black-outline variant (CC BY-SA
4.0, attribution in the footer), vendored as SVG under
`public/icons/openmoji` by `scripts/fetch-icons.mjs` (which fails on an
unknown hexcode) and painted in currentColor through a CSS mask so one file
serves both themes. The mapping (`src/data/product-icons.json`) was built
from the full list of 994 distinct item strings across all countries
(5,148 mentions): 884 exact, 110 category-tier (an unmatched crop gets a
plant, a mineral an ore pick, an industry a factory), 0 unmatched — 158
glyphs. `npm run check:icons` regenerates `etl/logs/icon-coverage.json` and
gates at 95% of mentions; the mapping is ordered, so specific rules precede
general ones ("pig iron" is steel, "lime processing" is rock, "mineral
water" is a drink, "non-alcoholic" is not alcohol). Biome, sector and
religion icons moved to the same set.

## 23. The 2026-08-29 presentation batch (maintainer-requested, Phase 2)

### 23.1 One breakdown pattern: ranked horizontal bars

The stacked/segmented bar (Biomes, compositions, trade partners, and since
Phase 1 land use, urban/rural and GDP sectors) was hard to read: a 3%
sliver needed a hover to be named, eight segments cannot carry labels, and
identity rode on colour alone. Three alternatives were weighed -- ranked
horizontal bars, a small-multiples grid, a donut with a legend table --
and ranked bars won on every requirement: labels readable without hover,
the percentage printed as text on each row, no meaning in colour (every
bar is the same accent; the "Other" row is the neutral token and says so
in words), and a one-column layout that is mobile as-is. `Breakdown.tsx`
is the single implementation; `CompositionBar` and `BiomeBar` survive only
as adapters so no call site had to change. Bars scale to the largest
share (the printed value is the truth); the rows are a real `<table>`, so
the old "show as table" toggle is gone. The 8-hue categorical series
tokens remain for genuinely multi-series charts (population trend, age
pyramid).

### 23.2 The flag is the hero

The country page's flag grows from 56 px to 144-176 px and leads the
page. Beneath it, a facts block: adoption date (Wikidata P571 on the
flag item, rendered at its STATED precision -- a year never becomes
"1 January"), designer (P287), and the lead of the English Wikipedia flag
article, trimmed to four sentences and shipped VERBATIM with the article
link, title, licence and retrieval date. CC BY-SA 4.0 makes attribution
and a link conditions of reuse; a paraphrase would be a derived work with
the same obligations and none of the traceability, so the text is quoted,
not rewritten. Wikidata has no "date designed" property; only adoption is
recorded and the line is omitted where it is missing. New stage
`flagmeta`; artifact `flags/meta.json`.

### 23.3 Entity table: neutral, sticky, numeric

The dark-blue/light-blue zebra (§20.1) is replaced at the maintainer's
request by neutral rows on the theme surface with hairline dividers, a
sticky raised header with muted uppercase labels (the active sort column
in full text colour), right-aligned tabular figures, and colour only
where it carries meaning: the growth-rate sign, printed as +/- as well.
Two new tokens, `--positive` and `--negative`, are AA text on both
surfaces in both themes and gated in `check-contrast.mjs`. Sorting and
keyboard access are unchanged (real buttons in real `<th>` cells with
`aria-sort`).

### 23.4 Map palette: restrained, in two directions

Chroma drops from 0.10 (§16.6) to 0.045; the four graph-coloured
lightness tiers (§7) still guarantee that no two bordering countries
share a fill, and because the separation now rides almost entirely on
lightness it holds under every common colour-vision deficiency. Two
directions are built and gated (neighbour dE >= 4.0 both themes, fill/
water >= 1.35, globe-ocean >= 2.0): **Atlas** (the flag hue, restrained;
default) and **Paper** (chroma 0.022, hues pulled a third of the way to a
warm paper base). Both are switchable live from the "Map colours"
control so the choice can be made on the real map. The continent view is
its own treatment: each continent is one cohesive region (seven hues >= 50
degrees apart at chroma 0.07, Antarctica near-white), internal borders
drop away (strokes match the fill), country labels are off and continent
labels carry identity -- §6.3's finding that seven hues cannot clear every
CVD pair still stands, which is why the label is never optional. Region
pairs are gated at the same dE floor.

## 24. The Human History timeline (2026-08-29, Phase 3)

### 24.1 Editorial, versioned, resolved at build time

The timeline is the one section whose content is written rather than
fetched. `etl/reference/history_events.json` is the versioned source of
truth: id, title, start/end year, a stated precision (exact / decade /
century / millennium / approximate), one of seven categories, a 60-100
word summary, source URLs, regions, and the English Wikipedia article
that anchors the event. The `history` stage validates all of that (a
malformed file fails the run) and resolves each event's IMAGE at build
time from the anchor article's lead image, keeping it only when Commons
records a public-domain or Creative Commons licence, with author and
licence rendered. Nothing is scraped at runtime; `data/history/events.json`
is an ordinary committed artifact inside the content fingerprint.

### 24.2 Dates say how sure they are

Every event carries a precision and the summary says in words when a date
is contested (Sahelanthropus, the peopling of the Americas, the Buddha's
death, Zoroaster, the Great Law of Peace). Prehistoric years render as
"N years ago"; a decade-precision date never renders as a specific year.
Astronomical year numbering is used internally (negative = BCE), which is
adequate at the precisions involved.

### 24.3 Coverage is deliberately global

The full set (v2) has 195 events. Regional tags: Africa 43, West Asia 40,
Europe 79, East Asia 27, South Asia 21, Central Asia 12, Southeast Asia
11, the Americas 48 across North America / Mesoamerica / South America,
Oceania 7, and 24 tagged Global -- many events carry several tags. Europe
still leads because the categories asked for (scientific discovery,
rights documents) are unevenly distributed in the historical record; the
balance was pushed by adding events (Aksum, Great Zimbabwe, Benin, the
Swahili coast, Songhai, Chavín, Tiwanaku, Cahokia, the Haudenosaunee,
Lapita, Rapa Nui, Mabo, Bandung, the African Charter) rather than by
removing European ones. Category counts: invention 39, other discovery
37, war 35, science 29, rights documents 29, religion 18, evolution 9.

### 24.4 The axis is piecewise, and says so

Seven million years cannot share a linear axis with the last five
centuries. The timeline uses eight era bands, each with its own pixel
length and a linear scale inside it; every band states its scale ("1 px
≈ N years") and bands alternate tint, so the change of scale is visible
rather than implied. A sticky era rail tracks the reader's position.
Interaction is tap-to-open on touch (labels are real buttons with
`aria-expanded`), hover-to-open on mouse, Escape to close, and the cards
are reachable and dismissible from the keyboard.

## 25. Type (2026-08-29, UI UX Pro Max exploration)

The maintainer asked for the UI UX Pro Max style database to be explored.
Its design-system generator, keyword-driven, proposed a data-dense
dashboard style (Fira Sans / Fira Code) and, on other queries, an OLED
dark theme -- neither fits a reference atlas read for its prose and its
figures alike. Its "News Editorial" pairing does: a text serif for titles,
a clean sans for the interface. Ruling: **Newsreader** (optical-size axis,
so it holds at both 44 px page titles and 18 px section headings) for `h1`
and `h2` only; **Public Sans** (tabular figures) for body, labels, controls
and every number. Both are OFL and self-hosted in `public/fonts` (Latin
subsets, ~240 KB total) because the site makes no third-party requests at
render time; the system stack remains the fallback and nothing in the
layout depends on the webfonts loading. Colour tokens, spacing and
component patterns are unchanged -- the database's "Minimalism & Swiss"
entry described what the site already does.

## 26. Navigation and timeline layout (2026-08-30, maintainer-requested)

Two section buttons in the header: "Global Data" (renamed from "Global
Population Dashboard" because the atlas covers far more than population)
in the brand green, and "Human History" in a clay red chosen to sit
opposite green on the hue wheel; the two are matched in lightness and
told apart by hue and spacing, so no luminance ratio between them is
gated -- only each label's AA contrast. The timeline moves to two columns:
boxed era labels (name, span, "1 px ≈ N years") on the left, sticky within
their own band; events on the right. Event rows are measured after render
so wrapped labels on phones can never overlap. Category icons now come
from the same OpenMoji set as the rest of the site (DNA, hammer and
wrench, light bulb, compass, crossed swords, place of worship, scroll);
no open icon set draws a sword crossed with a gun, so crossed swords, the
conventional conflict mark, stand for wars. Category names are Title Case.

## 27. The 2026-08-30 polish batch (maintainer-requested)

### 27.1 Capitalisation

Data-derived names render through `capitalizeFirst` wherever they head a
card or block: flag names from Wikidata ("flag of Japan" → "Flag of
Japan"), invention and dish names, flora and fauna names, subdivision
names. Category names on the timeline are Title Case. The committed
artifacts keep the source spelling; the change is display-only.

### 27.2 Sexual content is out of the inventions list

The Sybian appeared as a notable American invention. Its Wikidata item is
typed plainly "invention", so the class gate could not catch it. Two nets
now do: deny roots for sex toy and pornography, and a keyword check on
the item's own English description (and the Wikipedia summary description
for list candidates) — sex toy, vibrator, erotic, pornograph, masturbat,
sexual, BDSM, fetish, condom. Rejections are logged as "adult content
keyword".

### 27.3 Icons: colour, and a reserved slot

The OpenMoji COLOUR variant replaces the monochrome outlines (maintainer
request); the same hexcodes, the same vendoring script, rendered as inline
images instead of currentColor masks. In icon-led breakdowns (religions,
GDP sectors) every row reserves the icon slot — a muted dash where no icon
exists — so "Jehovah's Witness" sits flush with "Roman Catholic".

### 27.4 Public libraries, from IFLA

The public library count is back, from the IFLA Library Map of the World:
national library associations and statistics offices report public
library SERVICE POINTS per country with a year and a collection method.
Russia: 37,138 (2018) — against the nine the Wikidata item count gave.
The map's data is a static JSON its own page loads; Cloudflare rejects
Python's TLS fingerprint with any headers but serves curl with a browser
user agent, so this one source is fetched through `fetch_via_curl`, which
writes the same cache payload and sidecar `fetch` would. A sentinel −1
(Cambodia) is suppressed by the plausibility layer; the per-capita
ceiling was set at 1,500 per million after Czechia's real 558 tripped a
first guess of 400.

### 27.5 Electricity mix and nuclear plants

Technology & Infrastructure gains the electricity generation mix (coal,
gas, oil, nuclear, hydro, wind, solar, bioenergy) as a ranked breakdown
with an "Other" for geothermal and other renewables the source does not
break out (Kenya's 46%, Iceland's 29% — so this kind is partial by design
and always gets its Other), plus renewable and nuclear share tiles. Source:
Our World in Data's grapher series, producers Ember and the Energy
Institute, latest year per entity; zero-share sources are not listed.
Nuclear power PLANTS come from Wikidata — items typed nuclear power plant
(Q134447) with state of use "in use" or unset, no retirement or
dissolution date, and a recorded capacity (which excludes proposed sites)
— giving USA 55, France 18, Japan 17, China 15. The IAEA's PRIS is the
authority; it redirects to an analytics app with no keyless table, so the
tile says "as catalogued in Wikidata".

### 27.6 Descriptions and more images for inventions and dishes

Every invention and dish now carries the opening sentence of its English
Wikipedia article (REST summary, trimmed to ~220 characters) as a brief
description; where Wikidata records no P18 image the article's lead image
is used instead, subject to the same Commons licence/attribution check.
TheMealDB dishes look up an article under the dish name and fall back to
"<category> dish".

### 27.7 Home page, with the UI UX Pro Max database

The database's closest matches — a "Knowledge Base / Documentation"
palette (slate, blue accent, near-white ground), the "Minimalism & Swiss"
style, and the "Data-Dense Dashboard" table cues (36 px rows, 13 px type,
sticky header, hover highlight) — replace the verdant-green wash of §20.1.
The page is three raised cards on the neutral page tint: hero (title,
live counter, time scrubber), map (toolbar, map, readout) and the entity
table. No new colour token was introduced; every surface is a gated
theme token. The nav's two buttons carry the only saturated colour.

### 27.8 Bars, not pies (maintainer question)

Asked whether pie charts would be better: no, for this site. Every
breakdown here has three to fourteen categories, often with several under
3%, and the reader needs to compare and rank them; a pie encodes value as
angle and area, which people read far less accurately than length, and it
cannot label small slices. A donut earns its place only for one or two
categories where the part-to-whole gestalt is the point — the urban/rural
pair is the single candidate and it already reads at a glance as two
bars. The dataviz guidance and UI UX Pro Max's chart table both say the
same. Ranked bars stay.

### 27.9 Banknotes: the category walk, made trustworthy

The Commons category walk parked in §22.7 was rerun on 2026-08-30 with the
fixes from that section (country-named roots only for single-country
currencies; whole-word stems) and reviewed on a contact sheet of every
pick. It still chose wrongly for a quarter of the currencies: historic
series with no year in the text (the 1944 "Victory" peso, Qatar Monetary
Agency riyals, old-złoty notes for PLN), predecessor units sharing a
country's tree (cruzados, intis, tomans), reverses named in other
languages (реверс, belakang, hátlap, arka), and photographs OF money — a
"Banco do Café" sign, a pile of euros, a person holding rupiah, "British
Museum – Room 68". It also displaced good Wikidata picks (Azerbaijan's
2020 manat for a 1919 rouble).

Rulings, all in `etl/sources/currencyimages.py`:

- **Curated wins.** The Wikidata P18 image or an editorial override, when
  compliant, is chosen over any walk find; the walk only fills gaps.
- **Criterion 5 — no historic series.** A walk find dated before 1990
  anywhere in its name, description or categories is out. Curated picks
  are exempt (Australia's 1966 original-series dollar stays).
- **Criterion 6 — a catalogued obverse.** A walk find must carry a face
  value AND name its side (obverse/front/avers/anverso/recto/аверс/…) in
  its filename or object name. Precision over recall: a tree's stray
  photographs never name a side.
- **Reject terms** grew: the reverse in the languages met; predecessor
  units (cruzado, cruzeiro, inti, austral, sucre, toman, qiran, shahi);
  demonetised series names (Bagong Lipunan, "English series"); overprint,
  specimen, örnektir, old, historical, moneda/Münze/pièce, lenders,
  market, presentación, ceremony. "Museum" and "display" were tried and
  dropped — they cost South Sudan's curated 2011 pound.
- **A person-reviewed reject list**, `etl/reference/currency_image_rejects.json`
  (filename → reason), for what no rule can see: the coffee-exchange sign,
  the glare on a sleeve, the tilted photo of a 10,000 yen note.
- **Ranking**: obverse mention, then the currency named in the filename,
  then the newest year mentioned, then width.

Result: 51 of 158 currencies show a verified single obverse note (28
before the walk); every one of the 26 walk-found additions was looked at.
Currencies whose trees hold only historic scans (Iran, the Philippines,
Brazil, Japan) show the fallback card rather than an ancestor's note. The
walk is now ON by default (`CURRENCY_WALK=0` opts out) so the monthly
refresh keeps these images; `CURRENCY_CACHED_ONLY=1` still keeps local
runs to cached listings.

## 28. Site name: Encyclopedia Andranika (2026-09-05, maintainer-requested)

The site is named **Encyclopedia Andranika**, reflecting its expansion from
a population dashboard into a general-knowledge reference site. The name
appears as a serif masthead (`.font-display`, per the §25 type ruling —
the masthead is a title, not data) at the left of the header on every
page, ahead of the §26 section buttons, and in the document title, meta
description and Open Graph tags.

What deliberately does **not** change: the GitHub repository slug, the
local folder, the Pages base path (`/global-population-dashboard/` in
`vite.config.ts`), and the ETL User-Agent in `etl/config.py`. The UA
exists so upstream operators can trace our traffic to the repository; it
matches the repo slug and URL, both of which are unchanged, so renaming
it would only decouple the string from the place it points to.

## 29. The 2026-09-05 design pass (UI UX Pro Max, maintainer-requested)

The maintainer asked for a whole-site audit with the UI UX Pro Max design
database before the site grows new sections (Biology, Space). Its
design-system generator, queried for "encyclopedia reference atlas
editorial authoritative", again matched **Minimalism & Swiss Style** — the
same verdict §25 recorded — so the existing direction stands. Two of its
suggestions were declined deliberately: its "knowledge blue" palette would
override the gated flag-derived map hues and section colours, and its
EB Garamond/Crimson pairing would re-litigate the settled §25 type ruling
(Newsreader / Public Sans).

What the audit did change:

- **Section registry.** The header's section buttons now render from
  `SECTIONS` in `src/config.ts`; a new section is one registry entry plus
  a contrast-gated token pair in `index.css`, not header surgery. Needed
  because the section list is about to grow.
- **Favicon.** The site had none. `public/favicon.svg`: a serif "A"
  monogram on the exact `--brand-bg` green. System serif, because SVG
  favicons cannot load webfonts.
- **Pointer and hover affordances.** Tailwind v4's preflight leaves
  buttons on `cursor: default`; real controls get the pointer back, and
  section buttons answer hover with a 150 ms brightness lift (a filter,
  so gated token colours are untouched; `prefers-reduced-motion` zeroes
  the transition).

Verified against the audit checklist already in place from Phase 9:
global `:focus-visible`, map focus strokes, forced-colors support,
reduced-motion, table overflow handling, skip link, heading hierarchy.

## 30. Geographic detail and the satellite base view (2026-09-05, Phase 4)

The maintainer asked for map detail closer to a general-purpose web map:
a satellite/terrain base view, lakes and rivers, first-level
administrative boundaries, and zoom-progressive labels down to towns.
Roads were explicitly excluded.

### 30.1 Imagery: baked NASA Blue Marble, not runtime tiles, not WebGL

Three options were put to the maintainer with trade-offs; the ruling was
**ETL-baked NASA imagery** — the only option that keeps both repo
principles intact (keyless ETL; the browser never calls an upstream API).
NASA GIBS runtime tiles were declined (a third and much heavier
render-time upstream), as was a WebGL rearchitecture (would reimplement
every settled map behaviour, and the best terrain sources need API keys a
static site cannot hide).

The image is **Blue Marble Next Generation, August 2004, WITH topography
and bathymetry** (public domain; NASA requests credit, shown in the
on-map attribution): the shaded relief is baked into the imagery, which
satisfies the hillshade requirement without a separate elevation layer,
and August snow cover hides the least terrain. The 21600×10800 source
(~1.85 km/px) is cut by the `mapdetail` stage into three tiers of 2700 px
JPEG tiles (~17 MB committed): one world image, 8 mid-zoom tiles, 32
high-zoom tiles fetched only for the visible window. **Open question:**
NASA's 500 m set (86400×43200) exists in the same family; adopting it is
a config change plus ~100 MB of committed tiles.

### 30.2 Rendering: forward mesh warp onto a canvas beneath the SVG

The map stays d3/SVG. The satellite view draws imagery on a canvas
UNDER the svg by forward mesh warping (45/2^n-degree quads aligned to
the tile grid, one affine drawImage per quad), so every interactive
surface — hover, click, keyboard, the French Guiana detachment — is the
same SVG it always was, with fills turned transparent (`transparent`,
never `none`, so hit-testing survives). Continent mode ignores the
satellite toggle: region fills are that mode's identity.

### 30.3 Vector detail: Natural Earth, simplified GeoJSON, zoom-lazy

Admin-1 boundary lines and label points (10m), lakes and rivers (50m and
10m, the 10m sets filtered by Natural Earth's own scalerank), and
populated places (10m simple) are fetched and processed in the ETL —
nothing hand-typed. They are emitted as simplified, 3-decimal-rounded
GeoJSON rather than TopoJSON: these layers share no edges, so shared-arc
encoding buys nothing, and ~110 m rounding is invisible at the map's
maximum zoom. Each layer is fetched by the app only when the zoom
crosses its threshold; labels are collision-culled with country names
taking priority, then capitals, admin-1 names, towns by scalerank, and
water names. During an active globe drag the vector layers hide and
reproject 160 ms after the rotation settles — regenerating ~13k
projected features per drag frame would kill the spin.

River and lake names are placed at feature centroids, which for long
rivers can sit noticeably off the channel; acceptable for now, recorded
here rather than hidden.

### 30.4 Refresh policy

Natural Earth layers join the monthly refresh (they change rarely; a
release shows up as an ordinary data PR). The Blue Marble URL is a
pinned, dated NASA asset that will never change content — effectively
pinned by construction.

## 31. Taxonomy: the tree of life (2026-09-05, Phase 5)

### 31.1 Backbone: Catalogue of Life

Four machine-readable backbones were compared for the Biology section's
Taxonomy page:

- **Catalogue of Life (ChecklistBank, dataset alias 3LR) — CHOSEN.** The
  curated consensus checklist; its 2026 releases root the tree in the
  three domains (Archaea, Bacteria, Eukaryota — Woese) with viruses as an
  unranked fourth lineage, which is exactly the structure the page needs;
  every node carries a descendant-name count; the API is keyless with
  stable tree/children endpoints. CC BY 4.0.
- **GBIF Backbone** — an aggregation machine-built for occurrence
  matching; known artifacts at higher ranks and duplicate lineages.
  Declined as primary; not needed as secondary.
- **NCBI Taxonomy** — public domain and a single small download, but only
  covers taxa with sequence data and states itself that it is "not an
  authority" for nomenclature.
- **Open Tree of Life** — the best phylogenetic synthesis, but rankless,
  and its synthetic-tree identifiers shift between versions; a rank-based
  browsable tree cannot be built from it directly.

Wikipedia links, English common names (P1843) and one-line descriptions
come from **Wikidata via P10585 (Catalogue of Life ID)**, batched through
the same SPARQL endpoint the leaders stage uses, with batch cache keys
derived from batch CONTENT (the §21 lesson). No per-taxon Wikipedia
scraping. A node with no article records `"wiki": null` — explicit,
gated — and the page says "No English Wikipedia article recorded" rather
than showing a dead link.

### 31.2 Depth and the focus list

The tree ships from the synthetic "Life" root down to **family** rank
(~14k nodes) in one lazily-rendered artifact. Genus and species depth is
fetched per family, and only for the families in
`etl/reference/taxonomy_focus.json` — an EDITORIAL list of ~30 instantly
recognisable groups spread across mammals, birds, reptiles, amphibians,
fish, arthropods, molluscs, plants and fungi. The tree itself is never
hand-typed; which groups get full depth is curation, and it is recorded
there. Child lists are capped (300 children, 100 species per genus);
a capped node carries `"truncated": true` and the page says so.

### 31.3 Contested placements

`etl/reference/taxonomy_notes.json` annotates nodes whose placement is
genuinely disputed — Chromista and Protozoa (kingdoms in COL, not
recovered as clades in molecular phylogenies), Viruses (not cellular
life), Archaea (the two- vs three-domain question). The tree follows its
source and marks the argument; it does not adjudicate.

### 31.4 Refresh

COL cuts monthly releases under the same 3LR alias; the taxonomy stage
joins the monthly refresh (a new release arrives as an ordinary data PR
whose diff shows exactly what moved). The `check:taxonomy` gate refuses
a stump traversal, a node missing its explicit wiki-or-null flag, or a
focus family whose depth artifact is missing.

## 32. Evolution: the history of life (2026-09-05, Phase 6)

### 32.1 The chart is data; the event list is editorial

The timeline's skeleton is the **ICS International Chronostratigraphic
Chart**, taken from the commission's own linked-data publication
(i-c-stratigraphy/chart, CC BY 4.0) — every interval with its rank,
parent, boundary ages in Ma, the stated margins of error, and the CGMW
colours, which the page uses as band colours. The TTL is machine-generated
and regular; it is parsed with a strict block parser that aborts if the
shape shifts, rather than adding an RDF dependency for one file.

The ~50 **events** follow the §24 history-timeline precedent exactly:
which moments of 4.54 billion years make the cut is CURATION, so the list
lives versioned in `etl/reference/evolution_events.json`, validated by the
`evolution` stage (unique ids, sane Ma ranges, 40–130-word summaries,
anchor article, at least one source). Every summary states its own
uncertainty — the origin-of-life window spans 600 million years and says
so; Lomekwi, Purgatorius, Rhyniognatha and the snowball/slushball and
human/climate megafauna debates are carried as open questions in the text.

### 32.2 Time axis

The §26 ruling for the history timeline applies with more force here: a
linear axis for 4.54 Ga would crush the Phanerozoic into a sliver. The
page bands events by ICS interval at a reader-chosen rank (eons, eras,
periods; the Precambrian falls back to eons where the chart has no finer
interval), each band labels its own span, and every event prints its
dates with uncertainty. Nothing implies a uniform scale.

### 32.3 Illustrations

Organism entries carry **PhyloPic silhouettes**, following the brief's
"prefer CC0" ruling as a ranking: CC0/public-domain marks first, then
CC BY, then CC BY-SA — NC and ND licences never (several classic taxa,
Dimetrodon among them, exist on PhyloPic only as CC BY, and dropping
them entirely served no one). Attribution and the licence link render
with every image regardless. Other entries — and organisms whose
PhyloPic matches are all unusable — fall back to their anchor
Wikipedia article's lead image through the same Commons licence gate the
history stage uses. An event with no verifiably free image ships without
one, and `etl/logs/evolution.log` lists them. Silhouettes render on a
fixed light chip so they survive dark mode.

### 32.4 Refresh

The ICS chart and PhyloPic joins the monthly refresh (the chart changes
about once a year; a new version arrives as an ordinary data PR). The
events file changes only by editing the reference file and bumping its
version.

## 33. Space: the Solar System (2026-09-05, Phase 7)

### 33.1 NSSDC via pinned archive snapshots — a forced substitution

The brief named the NSSDC Planetary Fact Sheets as the planetary source.
During implementation, **nssdc.gsfc.nasa.gov was found to 307-redirect
wholesale to a nasa.gov landing page** (checked 2026-09-05) — the classic
fact sheets are not reachable live. Following the REST-Countries
substitution precedent, the sheets are fetched from **pinned Internet
Archive snapshots** (exact timestamps in `etl/config.py`, the `id_`
variant that serves original bytes). Each body's panel shows its snapshot
date as the figure's vintage. Planetary constants do not move month to
month, so a pin is honest; if NSSDC returns, the swap back is one config
edit. The 307 is nominally "temporary", which is exactly why the pin —
not the moving redirect — is the reproducible choice.

**The archive is trusted only as far as live NASA agrees with it**
(maintainer ruling, 2026-09): on every run, each planet's mass,
volumetric mean radius and density from the archived sheet are compared
against live **JPL Horizons** physical-properties blocks (1% tolerance on
mass and radius, 3% on density — Horizons and the sheets legitimately
differ in rounding and reference epochs at the sub-percent level). A
disagreement beyond tolerance aborts the run. The full comparison table
lands in `etl/logs/space.log`; Horizons is recorded as its own manifest
source. Radius compares volumetric-vs-volumetric, because Horizons does
not report the equatorial figure the panels display.

### 33.2 Live JPL SSD for everything the sheets cannot give

- **Moons**: the full satellite catalogue is parsed from JPL SSD's
  server-rendered tables — orbital elements for every known moon,
  physical parameters for the ~46 with measured values, and discovery
  year/discoverer. **Moon counts are counted from this catalogue**, never
  copied from a fact sheet (the archived sheets are stale on counts —
  Saturn's especially). A "major" moon is one with a measured radius in
  the physical-parameters table: a JPL-derived criterion, not editorial.
- **Dwarf planets** (Ceres, Eris, Haumea, Makemake): the JPL Small-Body
  Database API. Fields SBDB does not publish (mean temperature, axial
  tilt, surface gravity for most TNOs) are emitted as null and render as
  "not available from JPL SBDB" — the missing-is-a-state rule applies in
  space too. Pluto keeps its full NSSDC sheet.
- Discovery of Uranus/Neptune/Pluto: three editorial constants of the
  "capital of France" kind, recorded in `etl/sources/space.py`.

### 33.3 Scale honesty

Real distances and real sizes cannot share one drawing: at true scale
across 70 AU, even the Sun is under a pixel. The map therefore has two
labelled modes — compressed (log distances, enlarged bodies, marked "not
to scale") and true-distance (linear to ~70 AU, bodies as minimum-size
dots, with the caveat printed on the page). Nothing is silently out of
scale; the true mode's emptiness is presented as the point, not a bug.

### 33.4 Portraits

One portrait per major body from the NASA Image and Video Library
(keyless, NASA media), resolved from a curated search query per body;
the chosen asset ids are logged in `etl/logs/space.log` for review, and
credit plus a link to the library page render in the panel. Distant dwarf
planets resolve to artist's impressions — labelled by their library
titles as such.

### 33.5 Refresh

JPL SSD tables and SBDB join the monthly refresh (new moon discoveries
arrive as ordinary data PRs — satellite counts move every year or two).
The NSSDC snapshots and NASA portrait picks are pinned by construction.

## 34. The round-2 design pass (2026-09, maintainer-requested)

The maintainer reviewed the live site and asked for a professional
design system, a real masthead, a flatter IA, and less permanent screen
spent on provenance. UI UX Pro Max was consulted again; its style
verdict (Minimalism & Swiss) and its nav guidance (active state = colour
plus underline) were followed; its blue palette and Garamond pairing
remain declined for the §25/§29 reasons.

### 34.1 Masthead and navigation

The header is now a centred publication nameplate — serif title,
small-caps tagline ("A reference atlas with a source on every figure"),
double hairline — REVERSING the earlier left-edge ruling, on maintainer
request. The coloured section pills are gone; the primary nav is an
editorial row of uppercase links whose active state is a 2 px underline
in the section's own hue plus a text-colour step (never hue alone). The
underline hues are new THEMED tokens (`--nav-*`), stepped lighter in
dark mode to clear 3:1 as non-text indicators, and gated in both themes.
The legacy pill tokens remain (they still colour in-page elements).

### 34.2 IA: Biology dissolves

Top-level sections are now Global Data, Human History, **Taxonomy**,
**Evolution**, Space. `/biology/*` paths redirect to the new top-level
routes so bookmarks survive.

### 34.3 Sources collapse

The data-freshness panel — previously always open on principle
("burying warnings would leave readers to discover them by surprise") —
is now COLLAPSED by default behind a "Sources & data freshness (N)" row
on every page, by maintainer ruling: the principle bends to the screen
cost, and discoverability survives via the count, the fixed position,
and one keyboard-native click (<details>/<summary>). Nothing about the
three-dates discipline or the warnings changed; they are one toggle
away instead of permanently unrolled.

## 35. Map rendering: drag frames on canvas (2026-09, round 2)

The globe's drag sluggishness was architectural: every pointer-move
re-projected and reconciled ~250 SVG paths through React. Now, while a
drag or its inertia is live, rotation lives in a ref and each frame is
painted to a canvas with d3's context renderer (fills resolved from the
gated CSS variables once per gesture); the interactive SVG is hidden for
the duration and returns with ONE React commit on release. Hover, click,
keyboard navigation and the screen-reader surface are untouched — the
SVG they live on sits out the animation rather than being replaced.
Inertia (7%-per-frame decay) is skipped under prefers-reduced-motion;
button zoom eases over 200 ms through the same d3-zoom behaviour
(d3-transition added); wheel and pinch stay direct and cursor-anchored.

The "graticule" artifact the maintainer saw in the satellite view was
seams between the terrain mesh quads: adjacent quads' affine transforms
disagree by sub-pixel amounts along shared edges, and the dark ocean
leaked through as a faint lon/lat grid. Quads now overdraw ~1.5% so
neighbours overlap; imagery over imagery is invisible. There is no
actual graticule layer on the map.

## 36. Round-2 Global Data page rulings (2026-09)

- **Country popover.** Hovering a country (mouse) shows a card at the
  cursor — name, flag, population, GDP, growth, each with vintage, and a
  client-side "More info" link; on touch, tapping PINS the card above
  the finger with a close control, and navigation happens only through
  the link (a bare tap no longer navigates on touch). Works identically
  in full screen (the card lives inside the fullscreen element) and on
  every projection; flips away from viewport edges.
- **Control tooltips + zoom slider.** The zoom and fullscreen buttons
  grew hover/focus tooltips; the zoom tooltips carry a Show/Hide-slider
  link revealing a vertical, logarithmic zoom slider (Google-Maps
  style). The choice persists for the session (sessionStorage).
  Tooltips hide with `visibility`, so the link inside is only focusable
  while revealed.
- **§36.4 Methodology page.** The maintainer ruled that method prose
  (the live-counter interpolation paragraphs, projection explainers,
  IMF modelling notes) exposed internals on every page. It moved to a
  single /methodology page; figures keep a compact source label plus an
  ⓘ anchor link. The honesty principle ("real time is honest") is
  unchanged — the label still says "modelled"/"projected", the
  screen-reader description still says it in words, and the full
  explanation is one click away. The reasoning record stays here in
  DATA_DECISIONS.md.
- **§36.5 Entity table zebra.** Alternating raised/sunken surface
  stripes (both AA-gated), hover/focus in the page tint as a third
  state, sticky header unchanged.

## 37. Terrain view and the palette family (2026-09, round 2)

### 37.1 Terrain view

A third base view alongside Political and Satellite: **Natural Earth's
Cross Blended Hypso with Shaded Relief and Water** (50m, public domain)
— hypsometric tints from green lowlands through tan and brown uplands to
white peaks, hillshade and light-blue water baked in. This matches the
requested "Google Maps terrain" look from an open source; we match the
look, not the tiles. The raster is cut by the ETL into the same
tier/tile scheme as Blue Marble (two tiers, ~3 MB committed) and drawn
by the same mesh-warp renderer, now parameterised by imagery directory.
Borders and labels switch to dark warm strokes and dark-on-light halos,
since the ground is light. Attribution renders on-map.

### 37.2 Six palette directions, one meaning

The political palette family grows from two directions to six — atlas,
paper, **antique** (hues pulled 60% toward ochre over the parchment
mood), **pastel** (flag hue, soft chroma), **nautical** (hues pulled
toward chart-blue), and **mono** (chroma zero). Every direction goes
through the identical gates: 4-tier lightness assignment by the same
graph colouring, neighbour dE ≥ 4.0 in both themes, fill/water and
globe-ocean contrast floors. **The lightness tiers are the data channel
in every direction; hue is identity only** — so no palette changes what
the map means, and mono is the colour-blind-safe option by construction
(lightness is the one channel CVD never removes; it also happens to be
how every direction stays CVD-legible). The ocean stays the standard
dark blue in all directions — a period-correct parchment ocean would
need its own contrast-floor rework and is recorded as an open question,
not smuggled in ungated. Palette and base-view choices persist in
localStorage.

## 38. Human History round 2: banners and civilizations (2026-09)

The era boxes move from the left column to **full-width banners** heading
each era's span — reversing the §26 two-column ruling on maintainer
request. Each banner carries the era's name, dates, a one-sentence
editorial description of what defined it, and the honest "1 px ≈ N
years" scale note. Banner heights are measured at render (they wrap on
phones) and the year scale starts below each banner in one sequential
layout pass, so no text can overlap at any width. Era descriptions live
in the Timeline component beside the era definitions themselves — they
are UI copy, like the category labels.

Events grow 195 → 249. Seventy-two civilization-specific additions were
researched and written (55–110-word summaries, dated with stated
precision, each with a cited source); eighteen of them turned out to
duplicate existing curated entries under different ids and were dropped
in favour of the established versions, with their civilization tags
transferred. A controlled 31-tag civilization list joins the ETL
validator (folksonomy resisted deliberately); 111 events carry a tag,
surfaced as a filter beside categories and search. Existing events were
auto-tagged only where the title made the attribution unambiguous, and
the mapping was reviewed by eye.

## 39. Taxonomy round 2: photos, prose, and two views (2026-09)

The maintainer asked for a page that is neither dull nor thin; the
ETL-built tree stays the backbone.

- **Photos.** Each taxon's Wikidata P18 image — falling back to its
  article's lead image — is licence-checked against the Commons
  metadata in the ETL (same PD/CC gate as the history and evolution
  stages) and shipped with author, licence, and file-page link. Every
  node carries `img` explicitly: an object or null, and null renders as
  a neutral placeholder silhouette. The `check:taxonomy` gate enforces
  the key and the recorded licence.
- **Prose.** Wikipedia intro extracts are fetched at BUILD time through
  the batched Action API (the §27 lesson — per-title REST tripped rate
  limits) for every article-bearing taxon, sharded into 32 files keyed
  by node-id hash and fetched per shard on selection, because inlining
  ~14k intros would balloon tree.json. The retrieval date shows with
  the text. Rank definitions and rank-name etymologies are editorial
  UI copy; per-taxon etymology was NOT attempted at scale — no
  machine-readable source covers it honestly.
- **Rank colours.** One hue per canonical rank (chips, panel header,
  breadcrumbs, persistent legend); intermediate ranks inherit their
  base rank. Chips are tinted grounds under the ordinary text token,
  so hue never carries contrast or meaning.
- **New sources.** OneZoom (per-taxon deep link by scientific name) and
  Lifemap (deep link via the NCBI taxid from Wikidata P685) join the
  panel links. Both are LINKS, not data sources: their trees are not
  merged into ours — cross-checking backbones was judged §31's
  already-documented job, and neither publishes a stable bulk API this
  static site could gate. Wikidata additionally supplies P9157 (OTT id)
  and P523 (temporal range start, shown as "first appearance").
- **Views.** Tree view (unchanged machinery) plus a card explorer —
  children as image cards with rank badges, breadcrumb drill-down —
  and quick-start chips, an autocomplete-style search, and a random
  taxon button.

## 40. Evolution round 2: the chart made habitable (2026-09)

- **Nested banners.** Eon > Era > Period banners span the page, each
  with the chart's dates (stated uncertainties included — including the
  chart's own "uncertain" boundary notes), a plain-language description
  and the name's etymology with a cited source, from the new editorial
  reference `etl/reference/ics_unit_notes.json` (36 units; the stage
  fails loudly if a key stops matching the chart).
- **Tinted spans.** Each unit's section is washed with a light
  `color-mix` of its own CGMW colour, one step stronger per nesting
  level; event cards sit on the raised surface so every tint stays
  legible.
- **The system explained.** A collapsed intro panel covers why deep
  time is divided, how GSSPs ("golden spikes") define boundaries, why
  Precambrian boundaries are round numbers, and who maintains the
  chart — citing ICS and Wikipedia's GSSP article.
- **Coverage.** The Tonian gap is filled with sourced entries (Rodinia,
  Ourasphaira fungi, vase-shaped microfossils with predation borings,
  the Bitter Springs anomaly, molecular-clock animal origins), plus
  Vredefort, Columbia/Nuna and the Boring Billion for the other empty
  Proterozoic periods — 50 → 58 events. The new `check:evolution` gate
  enforces that EVERY period is covered by at least one event
  (overlap-based), every event is dated and sourced, and every banner
  unit carries its annotation.

## 41. Space round 2: the 3D Solar System (2026-09)

### 41.1 Scene and sources

The static diagram gives way to a three.js scene (code-split so the
~600 KB library loads only on the Space pages): animated orbits with
play/pause and a time-scale control, the labelled compressed/true scale
toggle, click-to-fly, belts as particle fields, and the selected
planet's major moons in orbit with the full catalogue listed beside.
Planetary textures are Solar System Scope's pack (CC BY 4.0, committed
byte-for-byte); Ceres uses the pack's clearly-labelled "fictional"
texture and the icy dwarfs get plain materials rather than invented
surfaces. All figures stay NSSDC/JPL-sourced with per-body vintages;
new per-body prose (naming and etymology, atmosphere per the fact
sheets, notable features, missions) is editorial in
`etl/reference/space_body_notes.json`, each body citing its reference.
Pre-telescopic planets say "known since antiquity" rather than faking a
discovery row.

### 41.2 Deep zoom: a documented runtime exception

The navigable per-body globes stream **NASA Solar System Treks** WMTS
tiles (LRO WAC for the Moon, Viking MDIM for Mars, Magellan SAR for
Venus, MESSENGER MDIS for Mercury — layer names and CORS verified) as
the camera closes in, upgrading the globe texture through tile levels.
This is the repo's third render-time upstream exception, after live FX
and weather (§19.1), and the first sizeable one: a global tile pyramid
cannot be committed to a static repository, and the maintainer's brief
explicitly directed lazy tile loading from Treks. Credits render on
screen. Named surface features come from the **IAU Gazetteer of
Planetary Nomenclature** (USGS, public domain), fetched in the ETL,
capped to the most prominent per body, and drawn on the globe with a
zoom threshold.

### 41.3 Cosmic Phenomena

A new /space/phenomena page: 13 editorial entries (stellar life cycles
through gravitational waves), each with a 55–130-word description
(validated), key facts, NASA/Wikipedia links, and a NASA Image Library
illustration credited per item. Wormholes are labelled theoretical in
their own text — the page never presents speculation as observation.

### 41.4 Refresh

Treks and the gazetteer join the monthly refresh (features get named
yearly); Solar System Scope textures are pinned by construction
(byte-copies of a versioned pack).

## 42. Round-2 review fixes (2026-09-06)

Andy's hands-on review of the round-2 build, and the rulings that came
out of it.

**42.1 The frozen black globe.** A drag session could outlive its
pointer: `pointerleave` removed the pointer from the tracking set, and
if capture had not held, the `pointerup` fired outside the SVG and was
never seen — leaving the SVG hidden behind the drag canvas's last frame
forever ("map frozen, black, outlines stuck while zooming"). The fix is
layered: pointer-leave with an empty set now starts inertia (which ends
the session), `lostpointercapture` routes to the same end handler, zoom
events with no pointers down force-end, and switching base view, fill
mode or projection force-ends unconditionally. Force-end restores
visibility synchronously — a one-frame orientation flash beats a dead
map.

**42.2 Longitudinal streaks (seam fix, second pass).** §35's overdraw
padded the SOURCE rectangle by a pixel; at every 45° tile boundary that
read past the tile bitmap's edge, and the browser's edge handling
smeared border pixels into visible meridian streaks. The rule is now:
overdraw the DESTINATION only (transform scale ~1.5% plus half a source
pixel on each side); never sample outside the tile.

**42.3 Popover thumbnail.** The flag SVG in the country popover renders
as a broken box under the dev server's MIME quirk, and a 20px flag was
weak identification anyway. Replaced with the country's own shape —
equal-area, fitted, muted-ink fill — reusing the MapReadout thumbnail
approach.

**42.4 Era banner hues.** Every era banner was the same grey. Each era
now carries an oklch hue (Deep Past 30 through Contemporary 250),
applied as a light-dark() tint pair on the banner background and its
top border; text stays on the ordinary tokens, so contrast never
depends on the hue.

**42.5 Civilization audit.** Filtering by civilization exposed thin
coverage (Armenian had two events; the Armenian Genocide was missing).
A per-civilization audit added 24 events — Armenia gets Urartu,
Tigranes the Great, the Genocide, and 1991 independence; the rest fill
the worst gaps (Peloponnesian War, the ancient Olympics, Boudica, the
Edict of Milan, the Sasanian foundation, Gilgamesh, Chichén Itzá, the
Althing, Sundiata, the 1054 Schism, Joan of Arc, the fall of Angkor,
the Triple Alliance, Machu Picchu, the Armada, the Imjin War, the
Ottoman dissolution, Israel 1948, Tutankhamun's tomb, the Soviet
dissolution) — and 36 existing events gained tags they plainly
deserved (Holocaust → Hebrew, Hiroshima → Japanese, Opium War →
Chinese, …). 273 events, 171 tagged.

**42.6 Ranks, all of them.** The data carries 37 rank strings (realm,
gigaclass, megaclass, subterclass, "section zoology", …). The rank
system now defines every one: realm and tribe join the hue table as
first-class ranks (realm is the ICTV's virus rank), zoological
section/series alias to the genus group, and prefix-derived ranks get
composed definitions from a prefix glossary (sub-, super-, infra-,
parv-, nano-, mega-, giga-, grand-, mir-, subter-). Legend chips are
buttons that show definitions; a collapsible glossary lists every rank
present with its definition; the panel shows the exact rank's text.

**42.7 Representative photos.** 19% of tree nodes had their own free
photo. A post-pass now bubbles the first photographed descendant's
image onto ancestors that lack one (focus subtrees feed their family
nodes in the main tree), labelled "Representative: <name>" wherever it
shows — a photographed member IS a correct illustration of the group
(standard taxobox practice); only taxa with no photographed member at
all keep the placeholder. The alternative — fetching iNaturalist
default photos for ~22k uncovered nodes — was rejected as a new
rate-limited fetch surface for marginal gain.

**42.8 Solar System polish.** Scene: zoom in/out buttons and a
fullscreen toggle overlay the viewport (OrbitControls has no UI of its
own); moon meshes joined the raycast set, so clicking a moon opens its
panel like clicking a planet. Globe view: Trek levels 2 and 3 are
requested on OPEN (sharp immediately; level 4 still streams on close
zoom, with an out-of-order completion guard so a slow low level can
never overwrite a sharp one); Sun/Earth/Jupiter/Saturn get committed
8k textures (§42.9); Saturn keeps its rings in globe view; feature
labels anchor bottom-edge to the terrain point instead of floating
above it; clicking a feature opens a card with the feature type
glossed in plain language (Mons — mountain), diameter, naming origin,
IAU approval year, the name's cultural origin, and the USGS Gazetteer
link — all of which ride from the gazetteer's own columns (origin,
approvaldt, ethnicity, link). Below the scene, a card grid lists every
body with portrait, headline figures, and links, as a non-3D way in.

**42.9 8k textures.** The 2k Solar System Scope maps look soft on a
fullscreen globe. 8k variants (3-4.5 MB each) are committed for the
Sun, Earth, Jupiter and Saturn only — bodies whose detail benefits and
that Trek does not already deep-zoom. Uranus and Neptune's 8k files
are upscales of featureless discs and are not shipped. The globe loads
2k first (never a blank sphere), then swaps in the 8k.

**42.10 Phenomena images, completed.** The wormhole entry (and any
future entry whose NASA query is null or dry) now falls back to its
Wikipedia article's lead image through the standard Commons licence
gate — for wormholes that is a CC BY-SA Einstein–Rosen bridge diagram,
the honest illustration of a theoretical object. 13 of 13 entries are
illustrated, credited per item.

## 43. Round 3, Phase 1: the globe imagery moves to WebGL (2026-09-07)

Andy reported that the round-2 seam fix (§42.2) did not work: meridian
streaks in both Satellite and Terrain views that thicken while
spinning, outlines that detach from the imagery during fast spins,
sluggish drags, and a slow Satellite -> Terrain switch. Reproduced
with Playwright (`scripts/globe-spin-capture.mjs`, headed Chrome,
scripted drag + flick, frames captured mid-gesture) before anything
was changed.

**43.1 Diagnosis.** The imagery was drawn as affine-warped 2-D-canvas
quads (§30). An affine image of a lon/lat quad only approximates the
orthographic projection near the centre of the disc; towards the limb
and the poles neighbouring quads diverge and the ocean underlay shows
through as wedge-shaped streaks along meridians — the Terrain view,
whose 45-degree tiles are lighter, showed them worst — and any quad
with a corner past the horizon was culled outright, cutting a hole
around the visible pole. Rotation moves the limb across different
quads every frame, hence "thicken while spinning". Overdraw (§42.2)
could not fix a model error. Separately, a fine tile landing mid-drag
re-rendered the imagery canvas from React's `rotation` STATE (stale
until the gesture commits) while the outlines kept following the
rotation ref — the imagery snapped back for a frame, which is the
detached-outlines report.

**43.2 The fix: per-pixel inverse projection on the GPU.**
`src/lib/globegl.ts` renders the imagery with WebGL2. On the globe a
full-screen fragment shader inverts d3's orthographic projection and
rotation for EVERY device pixel — the same maths as `geoOrthographic`
`.rotate([lambda, phi, 0])`, run forward for the SVG and backward
here — and samples an equirectangular texture with mipmaps and
anisotropic filtering. No quads, so no seams; the horizon is an exact
circle, feathered over one pixel. The antimeridian mip seam (the usual
blurry column where `u` wraps) is avoided by taking the smaller of two
derivative estimates and `textureGrad`. Flat projections (Equal Earth,
Mollweide, Eckert IV) draw a 1-degree mesh whose vertices were
projected once by the same d3 projection the SVG uses. Finer tiers are
still the ETL's 45-degree tiles, drawn as extra passes limited to their
window, nearest-the-centre first, capped at an LRU budget of 8 (4 on
devices reporting <= 4 GB) so wanting more than the cache holds can
never evict-and-refetch every frame. Browsers without WebGL2 fall back
to the round-2 renderer (`Canvas2DImagery`), streaks included; the
imagery artifacts are unchanged (§30, §37).

**43.3 One scene, one rotation.** During a drag the country outlines
are drawn by the same renderer, in the same frame, from the same
rotation ref, as `gl.LINES` on the sphere: the topology's shared-border
mesh (595 arcs, 8.2k points at 110m) subdivided along great circles to
<= 1 degree so the GL segments land where d3's resampled SVG strokes
will when the gesture ends. The renderer keeps its own last view and
repaints from THAT when a tile lands — React state is never consulted
mid-gesture. The 2-D drag canvas still fills countries in the
Political view (no imagery there).

**43.4 Measured.** rAF callback time during a scripted drag at
1200x900, headed Chrome on the maintainer's machine:

| View | Before (median / p90) | After |
| --- | --- | --- |
| Satellite, world zoom | 10.0 / 10.6 ms | < 0.5 ms (GPU-bound) |
| Terrain, world zoom | 9.9 / 10.6 ms | < 0.5 ms |
| Satellite, zoom 3x | 13.4 / 26.8 ms | 0.6 / 0.9 ms |
| Political, world zoom | 8.8 / 9.6 ms | 8.8 / 9.6 ms (unchanged, d3 canvas fills) |

Screenshots at rest, mid-drag and mid-flick, both views, world and 3x
zoom, show no streaks and no polar hole after; before-frames show
both.

**43.5 Switching views.** One renderer lives for the map component's
lifetime; textures stay resident across Political / Satellite /
Terrain switches, and both imagery sets' world bases (tier 0, ~0.3 MB
each) are fetched, decoded and uploaded during idle time after first
paint. A "Loading ... imagery" pill shows only while a base is
genuinely absent. Measured switch-to-painted: 100-180 ms for every
transition, including the second Satellite and Terrain switches.
GPU-compressed (KTX2/Basis) textures were considered and not adopted:
the bases are 0.3 MB JPEGs that decode off-thread in ~40 ms, and Basis
transcoding would add a WASM transcoder to the bundle for no visible
gain at this size.

**43.6 Not changed.** Drag sensitivity (0.5625°/px), inertia, the
escape-hatch rules of §42.1, the SVG as the interactive layer, and the
palette gates. The Political-view drag frame remains d3 canvas fills
at ~9 ms/frame; moving fills to triangulated GL geometry is the next
step if that view is ever reported as sluggish.

## 44. Round 3, Phase 3: every rank, honest descriptions, depth on demand, and a mobile detail sheet (2026-09-12)

Andy asked for the taxonomy page to go further on five fronts: the full
rank system (not just the ones already met), a legend that stays aligned
at every width, a description with its source on every node, a usable
mobile experience, and real depth below family — genus and species,
searchable, on demand. This section documents what shipped; it was
largely built already (WIP commit b245f1b) and is audited, verified, and
completed here.

**44.1 The complete rank system.**

The rank table (`RANK_SEEDS` in `src/lib/taxonomy.ts`) now carries **117
rank entries** covering every rank asked for: the principal ranks; the
upper/intermediate tiers (superkingdom through infrakingdom, superphylum
through microphylum/nanophylum, gigaclass through parvclass, legion and
cohort with their super-/sub-/infra- forms, gigaorder through
falanx/phalanx, gigafamily through infratribe, supergenus through
infragenus and the botanical section/subsection/series ladder, species
aggregate); and the lower ranks (subspecies, variety/subvariety,
form/subform, cultivar, cultivar group, grex, plus the bacteriological
infrasubspecific set — pathovar, biovar, serovar, etc.). Botanical vs.
zoological vs. bacteriological vs. viral differences are stated explicitly
in `RANK_CODE_NOTE` and per-rank (division vs. phylum; ICN Art. 3/4 vs.
ICZN Art. 35/42/45/10.4 vs. the 2021-added ICNP phylum rank vs. ICTV's own
15-rung realm-to-species ladder with no infraspecific ranks).

**Sources**, listed in `RANK_SOURCES` and rendered under the legend: the
codes themselves (ICZN 4th ed., ICN Shenzhen Code, ICNP 2022 revision +
Oren & Garrity 2021 for the phylum addition, ICTV Code Rule 3.22, ICNCP
9th ed.) plus two textbook/synthesis references for the ranks no code
governs — Ruggiero et al. 2015 (*A Higher Level Classification of All
Living Organisms*, PLOS ONE, the superkingdom-to-order backbone Catalogue
of Life itself follows) and McKenna & Bell 1997 (*Classification of
Mammals Above the Species Level*, Columbia University Press, source of
legion/cohort/grandorder/mirorder/parvorder) — and the ChecklistBank rank
vocabulary as the definitive list of strings COL can attach to a node.

Every rank has a colour (`hue` in `RANKS`, one anchor hue per tier —
domain, kingdom, phylum, class, cohort, order, family, genus, species,
root — with intermediate ranks shading the same hue lighter for
super-/mega-/giga- and darker for sub-/infra-/parv-, so a whole tier reads
as a colour family) and a definition (`def`, either an exact hand-written
entry or, for a rank string never seen before, a definition COMPOSED at
render time from a prefix glossary — `rankDefinition()` never returns
empty, per the CLAUDE.md invariant "no chip is a dead end").

**Verified** (2026-09-12, full scan of `tree.json` and every file in
`genera/`, not a sample): the live data carries exactly **39 distinct
rank strings** (class, domain, epifamily, family, genus, gigaclass,
infraclass, infrakingdom, infraorder, infraphylum, infratribe, kingdom,
megaclass, nanorder, order, parvorder, parvphylum, phylum, realm, root,
section zoology, series zoology, species, subclass, subfamily, subgenus,
subkingdom, suborder, subphylum, subsection zoology, subspecies,
subterclass, subtribe, superclass, superfamily, superorder, supertribe,
tribe, unranked) and every one of them is an exact entry in `RANK_SEEDS`
— none had to fall through to the composed-prefix path. `node
scripts/check-taxonomy.mjs` independently gates this on every run and
reports "39 rank strings, all defined."

Nothing needed fixing here; the prior agent's rank table was complete and
accurate on inspection against the codes.

**44.2 The rank legend: a two-column grid at every width.**

`src/components/taxonomy/RankLegend.tsx` lays the full glossary out as
`grid-cols-[7.5rem_minmax(0,1fr)]` (chip column fixed at 7.5rem, the
description column flexible) inside `dl.rank-grid`, one `<dl>` per tier
group. Verified with Playwright (headed Chrome) at 360, 768 and 1280px:
at every width every `<dd>` in every tier's grid starts at the identical
x-coordinate (measured: a single value, no spread, at all three widths).
Screenshots: `.scratch/shots/taxonomy-legend-{360,768,1280}.png`.

Nothing needed fixing here either.

**44.3 Descriptions, sourced, generated ones flagged.**

Every node — tree and genera files alike — carries `descSrc` in
`wikipedia | wikidata | col | generated`, filled by the ETL in that
priority order (Wikipedia intro extract, then Wikidata description, then
a Catalogue of Life remark, then a summary GENERATED from structured
facts: rank, parent, descendant/genus counts, up to three notable members,
first appearance in Ma, extinct flag). `generatedSummary()` in
`src/lib/taxonomy.ts` composes the same sentence shape the ETL uses for
tree nodes, so live-loaded and not-yet-enriched genus nodes (`pending:
true`) get an honest sentence instead of nothing. The UI (`TaxonDetail.tsx`
→ `Description`) always shows a "Generated from Catalogue of Life facts"
chip ahead of a generated description and a plain source line ("—
Wikipedia, retrieved 2026-09-06" etc.) after any other source; there is no
code path that can show a generated summary without the label.

`check-taxonomy.mjs` gates a non-empty description with a valid recorded
source on every node (`DESC_SOURCES` set) and fails loudly on a
`wikidata`/`col` node with no `desc` string, a tree node whose extract
shard lacks its text, or any node with a `descSrc` outside the four
values. **Verified counts** (full data, both gate output and manual
re-check):

- Tree (35,214 nodes): wikipedia 9,088 · wikidata 7,575 · col 0 ·
  generated 18,551 — all flagged, zero empty.
- Genera files (257,389 nodes across 14,196 files): wikipedia 6,481 ·
  wikidata 12,563 · col 0 · generated 224,149 — all flagged, zero empty.

(`col` is 0 in both because the ETL's third tier — a Catalogue of Life
prose remark — is empty for essentially every taxon in the 3LR release;
the code path exists and is gated but has nothing to draw on. Not a bug,
just an empty tier; noted so a future contributor does not go looking for
a broken COL-remark fetch.)

Nothing needed fixing here.

**44.4 The mobile detail sheet.**

`src/components/taxonomy/DetailSheet.tsx` is a modal bottom sheet
(`role="dialog"`, `aria-modal`, `aria-labelledby`) that opens on
`isNarrow` (`max-width: 1023px`) whenever a taxon is selected. Verified
with Playwright at 390x844: tapping "Mammals" opens the sheet, focus
lands on the Close button, `Escape` closes it and returns focus to the
opener, the page behind gets `inert` while it is open, and Tab is trapped
inside the sheet. Screenshot: `.scratch/shots/taxonomy-mobile-sheet.png`.

**Gap found and fixed in this audit.** The sheet's `className` referenced
`taxonomy-sheet` with a doc comment claiming "the slide-up transition is
disabled under prefers-reduced-motion (the global rule in index.css)" —
but no such rule existed anywhere in the codebase (`grep -rn
"taxonomy-sheet\|slide-up\|translateY" src/` found only the component
itself and one unrelated `translateY` in index.css). The sheet had NO
transition at all: it simply appeared, and the comment was aspirational
dead prose. Since `src/index.css` is off-limits for this audit (owned by
another area) the fix lives entirely inside `DetailSheet.tsx`: an
`entered` state flips `true` two animation frames after mount, the sheet
transforms from `translateY(100%)` to `translateY(0)` over 220ms
(scrim fades 0 → 1 over the same window), and BOTH are skipped outright
(`transition: none`, final position immediately) when
`matchMedia('(prefers-reduced-motion: reduce)').matches`. Verified with
Playwright's `reducedMotion` context option: under `reduce` the computed
transform is the identity matrix from the first frame the sheet exists;
under `no-preference` the mid-open computed transform shows the sheet
still ~210px below its resting position 40ms after it mounts, settling to
identity within 500ms. This is a genuinely new capability (motion now
exists to disable), not a regression — nothing before this audit animated
either way, so no prior behaviour was removed.

**44.5 Depth below family: on-demand genera, LIVE species.**

**What the family-genus tier is.** One static file per family —
`data/biology/taxonomy/genera/{familyId}.json` — holding the family's
subfamilies/tribes/subtribes/genera exactly as Catalogue of Life nests
them, fetched by the app only when that family is expanded
(`loadGenera()`). 14,196 files, 37.0 MB total, largest Formicidae at
1.86 MB; 257,389 nodes; 204,480 genera. Wikipedia/Wikidata enrichment of
genus nodes is INCREMENTAL — `TAXONOMY_GENUS_ENRICH_CAP` (default 20,000
per run, `etl/config.py`) new genera per ETL run — because looking up
~204k genera against Wikidata/Wikipedia in one run is not realistic; a
genus not yet reached carries `pending: true` alone (wiki/img/desc keys
absent, expanded to explicit nulls + a generated description client-side
by `expandPending()`), never a silent "no Wikipedia article" claim. As of
this audit: 1,571 of 204,480 genera enriched (853 with a Wikipedia
article), 202,909 still pending. **At the current 20,000/run cap this
takes roughly ten more monthly runs to finish** — see the workflow note
below; Andy may want a bigger cap or several catch-up runs if that pace
is too slow.

**What ships species, and how.** Two different depths below genus, by
design, both verified live in the browser:

1. **The ~30 editorial focus families** (`etl/reference/taxonomy_focus.json`
   — Hominidae, Felidae, Canidae, Ursidae, Elephantidae, Equidae,
   Delphinidae, Physeteridae, Macropodidae, Ornithorhynchidae, Accipitridae,
   Falconidae, Corvidae, Spheniscidae, Strigidae, Crocodylidae,
   Testudinidae, Varanidae, Salamandridae, Lamnidae, Salmonidae, Apidae,
   Formicidae, Culicidae, Theraphosidae, Octopodidae, Rosaceae, Fagaceae,
   Pinaceae, Amanitaceae) carry their species INLINE in the genera file,
   fully enriched, no further fetch needed. 24,233 focus species ship this
   way. Verified: Felidae -> Pantherinae -> Panthera shows five species
   (leo, onca, pardus, tigris, uncia) immediately on expanding the genus,
   each with rank chip, image, description and links.
   (`.scratch/shots/taxonomy-depth-felidae-focus.png`)
2. **Every other genus** (the other ~204k) loads its species LIVE from the
   Catalogue of Life ChecklistBank API (`loadLiveChildren()`,
   `CHECKLISTBANK_API`, dataset `3LR`) the moment it is expanded — a
   documented render-time exception, same shape as the Trek tile
   streaming of §41.2. Verified: Sciuridae (not a focus family) ->
   Callosciurinae -> Callosciurus (`pending: true`, placeholder
   silhouette, "Generated from Catalogue of Life facts" description)
   expands to 14 live-loaded species rows, each tagged `live`.
   (`.scratch/shots/taxonomy-depth-sciuridae-live.png`)

**Search still finds species by name.** The static per-node index only
covers what has been loaded into the page so far (tree + any expanded
genera files); a query of 3+ characters with no local match ALSO fires a
debounced live ChecklistBank name search (`liveNameSearch()`, prefix
match on scientific name + English vernacular). Verified: searching
"Vulpes lagopus" from a cold page (nothing expanded) returns 25 live
hits; selecting one walks and loads every ancestor (genus, family, all
the way to the domain) via `revealLive()` and lands on a fully-detailed
species panel — photo (CC0, Commons), Wikipedia extract with retrieval
date, rank chip, lineage breadcrumbs to Life, and the Wikipedia/COL/
OneZoom links. (`.scratch/shots/taxonomy-live-search.png`,
`taxonomy-live-reveal.png`)

**Every new node — focus-species, live-genus-species, or live-search hit
— carries rank colour** (`rankChipStyle`/`RankChip`, works on any rank
string via `rankInfo()`), **image-or-placeholder** (`TaxonThumb`, the
same neutral silhouette used everywhere else on the page), **a
description** (source-flagged per §44.3; live nodes are always
`generated` since no Wikipedia/photo lookup happens at render time — the
panel says so explicitly: "Loaded live from the Catalogue of Life API;
no Wikipedia or photo lookup happens at render time"), **and links**
(Wikipedia — direct if known, else a pre-filled search; the Catalogue of
Life source record; OneZoom by scientific name; Lifemap when a Wikidata
NCBI taxid (P685) is on the node). Nothing needed fixing in this area —
the design and its trade-offs (static-for-curated-depth vs.
live-for-everything-else, capped incremental enrichment rather than one
giant Wikidata batch) were already sound and are now verified end to end.

**44.6 Gates.** `check:taxonomy` passes: tree 35,214 nodes / 39 rank strings all defined / descriptions wikipedia 9,088, wikidata 7,575, generated 18,551 (flagged); genera 14,196 files, 37.0 MB, 257,389 nodes, descriptions wikipedia 6,481, wikidata 12,563, generated 224,149 (flagged). Incremental genus enrichment runs at `TAXONOMY_GENUS_ENRICH_CAP` = 20,000 per ETL run, so full Wikipedia coverage of the 203k pending genera is roughly ten monthly refreshes away; raising the cap for the workflow only is the lever if Andy wants it faster.

## 45. Round 3, Phases 4-5: Solar System textures, labels, and Moon exposure (2026-09-12/13)

Audit and completion of a WIP checkpoint (`b245f1b`) covering the Solar
System page's texture pipeline, the shared zoom control, surface-feature
label anchoring, and the Moon's brightness. Most of the substantive work
was already correct in the WIP; this pass verified it against the brief
with Playwright (headed, real GPU), fixed the one thing that needed
fixing (nothing did, after verification — see 45.3), and writes the
record the WIP checkpoint never got to.

**45.1 Hi-res textures, honestly labelled — and why not KTX2.**

Round 2 (§42.9) recorded "8k variants... committed for the Sun, Earth,
Jupiter and Saturn." That was wrong for three of the four: Sun, Jupiter
and Saturn's "8k" Solar System Scope files are natively **4096×2048**
(verified by opening each with Pillow) — only Earth's is a true 8192.
The pack's own filename lied; §42.9 repeated it uncritically. The fix
committed here renames the three to their real width (`sun-4k.jpg`,
`jupiter-4k.jpg`, `saturn-4k.jpg`, same bytes — `git diff` shows these as
pure renames) and adds genuinely-new hi-res files for **Moon, Mars and
Mercury** at 4096×2048 (the pack's largest file for each is a "8k" that
is honestly 8192-something; it is Lanczos-downsampled to 4096 and
re-encoded as a quality-88 progressive JPEG in the ETL, because these
three bodies get their real deep-zoom detail from the streamed NASA Trek
mosaic — see 45.4/§41.2 — and a full 8-15 MB commit would buy nothing a
reader can see before Trek tiles land). Venus, Uranus, Neptune, Ceres and
the outer dwarfs have no hi-res file in the pack at all (404s, checked
2026-09-07) and stay at 2k; Venus is compensated by its own Trek layer.
The credit line and the ETL's manifest citation both now say the real
pixel width per body — never "8k" for a 4096 file again.

**Repo growth**: 6.87 MB of new binary — `mars-4k.jpg` (1.45 MB),
`mercury-4k.jpg` (2.50 MB), `moon-4k.jpg` (2.91 MB). The three renamed
files (sun/jupiter/saturn) and the pre-existing `earth-8k.jpg` (4.57 MB,
genuinely 8192×4096) add no new bytes — they already lived in the repo.
Total hi-res texture payload across all seven files is ~19.3 MB, all
loaded lazily (never on first paint — see 45.2).

**GPU compression (KTX2/Basis Universal): considered, not adopted.**
Three reasons, together:
1. **Toolchain.** KTX2/Basis encoding needs the `basisu`/`toktx` compiled
   CLI in the ETL environment. This project's ETL is deliberately a
   keyless-Python pipeline with no compiled binary dependency beyond the
   couple of `curl` fallbacks CLAUDE.md already documents as exceptions;
   adding a C++ toolchain for seven files is a heavier footprint than the
   saving justifies.
2. **Runtime cost cuts the other way.** three.js's `KTX2Loader` needs its
   own ~250 KB WASM transcoder fetched by every page that shows a globe —
   a second code-split payload on top of the ~600 KB three.js chunk
   §41.1 already isolates to the Space pages. For seven textures under
   20 MB total, that fixed cost is not obviously a win.
3. **Provenance.** Every note in `etl/sources/space.py` for this pack
   says textures are "copied byte-for-byte" or, where a resize is
   unavoidable, "Lanczos-downsampled and re-encoded as progressive JPEG"
   — an auditable one-hop relationship to the CC BY 4.0 source bytes that
   the project has leaned on since round 1. Re-encoding into a
   GPU-native container from an already-JPEG source would be a second,
   lossy re-encode with no real Basis benefit (Basis's efficiency comes
   from encoding the *original* art, not from transcoding a JPEG), for a
   texture set the maintainer can no longer point at and say "these are
   the pack's own bytes."

The trade-off actually shipped is progressive JPEG (quality 88,
`optimize=True`) plus the 2k-then-hi-res loading ladder (45.2), which
already solves GPU compression's real user-facing complaint (a stall on
first paint) by never showing a stall — the 2k placeholder (0.2-0.9 MB)
paints immediately, the hi-res file swaps in after. Measured sizes and a
calculated (size ÷ bandwidth, not a live capture) download time for the
worst case (moon-4k, 2.91 MB) once it starts fetching:

| Link | Speed | moon-4k.jpg |
|---|---|---|
| Constrained mobile | 10 Mbps | ~2.3 s |
| Typical broadband | 50 Mbps | ~0.5 s |

**45.2 Progressive texture loading, and a texture "ladder" that can't go backwards.**

Every body's scene mesh and globe modal now open on the 2k Solar System
Scope file; the globe modal always upgrades to the committed hi-res file
when one exists (45.1), and the *scene* upgrades only the body currently
flown to (one hi-res texture resident in the scene at a time — a 4096
RGBA texture with mipmaps is ~43 MB of GPU memory, 8192 is ~170 MB;
upgrading all eleven bodies at once risks integrated GPUs). Flying to a
different body restores the previous one's 2k and releases its hi-res
texture.

The globe modal chains a third rung for Moon/Mars/Venus/Mercury: the
streamed NASA Trek mosaic (§41.2), requested at levels 2 and 3
immediately on open and level 4 on close zoom. Each rung carries a rank
(2k=1, hi-res=2, Trek level *n*=10+*n*); a texture is only ever applied
if its rank exceeds what is already showing, so a slow 2k or a Trek tile
that lands out of order can never overwrite something sharper (this
generalises the round-2 §42.8 out-of-order guard to the whole ladder,
not just Trek-vs-Trek).

**45.3 Zoom controls: one shared component, verified identical.**

The Solar System scene's zoom in/out/fullscreen buttons and its optional
vertical zoom slider now use the exact component the Global Data maps
use (`src/components/ZoomControls.tsx`, extracted from `WorldMap.tsx`);
each caller only supplies what its own 0-100 means (a d3-zoom scale for
the map, `1 - log(distance/min)/log(max/min)` — camera distance — for
the scene) and a `storageKey` so the two "show slider" preferences don't
collide in `sessionStorage`.

Verified with Playwright (headed Chrome) rather than by inspection alone,
because a moderate drag on a 3D perspective scene and a 2D orthographic
globe *look* different even when the underlying control is identical (a
50%-of-track drag reads very differently on a log-scaled camera-distance
axis than on a log-scaled d3-zoom-`k` axis). Reading the raw `<input>`
value confirmed the two sliders are byte-for-byte identical in behaviour:
dragging from 10% to 90% of the track sets the same raw value (3) on
both; dragging the opposite way sets the same value (97) on both; the
physical top of the track is value 100 (closest/most zoomed in) and the
bottom is 0 on both. Screenshots at the extremes confirm the *meaning*
matches too — value 100 shows a single country filling the map and the
camera effectively inside the Sun's texture on the scene; value 0 shows
the full globe and the full orbit diagram respectively. No fix was
needed here; the WIP's extraction was correct.

A related fly-to change (already in the WIP, verified working): clicking
a body no longer just re-targets the camera, it also glides the viewing
*distance* to 4-8 body radii (keeping the reader's current distance if
already in range), so flying to a small body like Mercury from a wide
view of the whole system doesn't leave the camera parked kilometres away
showing a speck.

**45.4 Surface-feature labels: anchored to the terrain, not floating near it.**

Root cause of the round-2 anchoring bug (fixed in this WIP, verified
here): the surface-point formula used `theta = (lon + 90)°` against
three.js's `SphereGeometry` UV wrapping, which is a 90-degree offset
from the equirectangular texture's actual `u = (lon+180)/360` mapping —
every label sat a quarter-turn east of its feature. The gazetteer's
longitude convention (checked against the shapefile CRS, which declares
`AXIS["Longitude",EAST]`) is planetocentric, **east-positive, 0-360**
(e.g. Olympus Mons 226.198°E, Tycho 348.785°E) and needed no conversion
once the wrapping itself was fixed:

```
phi = lat * pi/180
lambda = normalize(lon + 180, 360) - 180    // wrap into (-180, 180]
anchor = (cos(phi)*cos(lambda), sin(phi), -cos(phi)*sin(lambda))
```

Each label is a `THREE.Sprite` **parented to the globe mesh**, so it
rotates with the body for free; every frame it is: (a) re-scaled from
its fixed CSS-pixel size so it reads as a constant size on screen
regardless of zoom, (b) faded out over the last ~13° before the limb and
hidden past it via an occlusion test (`dot(toCamera, surfaceNormal) >
0.08` fading to 1 at 0.30), and (c) decluttered greedily in screen space
(largest features placed first, later ones dropped on overlap) within a
budget that grows from 12 to 60 labels as the camera closes in. A small
always-visible dot marks the exact anchor point even when its label is
hidden by declutter, so the geometry is never lying even when the text
is.

A second gap, also closed here: labelling purely by IAU diameter buries
the features a reader actually looks for (Tycho is 85 km across; the
Moon has ~300 larger craters). `etl/config.py`'s new
`GAZETTEER_FEATURED` list pulls specific well-known names — Olympus
Mons, Valles Marineris, Tycho, Copernicus, Maxwell Montes, Caloris
Planitia, etc. — from the **same gazetteer rows** (nothing hand-typed)
and places them at the head of each body's feature list, so they label
at every zoom level instead of only once the camera is close enough for
80-deep diameter ranking to reach them. A name missing from that year's
gazetteer download aborts the ETL run rather than silently vanishing.

**Verified** with Playwright at several camera angles per body
(screenshots below): Olympus Mons's label sits exactly on the volcano's
caldera on the Mars globe; Tycho's sits exactly on its bright ray-crater
on the Moon globe; clicking either opens the feature card with the
gazetteer's own origin/approval-year/culture/link columns (never
hand-typed) — e.g. Olympus Mons: "Mons, montes — mountain · 610.1 km
across / Classical albedo feature name. / Name approved by the IAU in
1973 · origin: Greek / USGS Gazetteer entry".

**45.5 The Moon reads bright now.**

Two independent changes, both already in the WIP and verified working
here with a genuine A/B (temporarily reverting each value, screenshotting,
reverting back — not a description of intent):

1. **Trek exposure gain.** The streamed LRO WAC mosaic (the LROC WAC
   source the brief asked for) is a low-mean-luminance radiometric
   product — measured on its own level-1 tiles at 79/255, against
   132-194/255 for the Solar System Scope textures it replaces mid-zoom.
   `etl/config.py`'s `TREK_EXPOSURE` applies a linear multiplier
   (Moon and Mercury ×1.8, Mars ×1.15, Venus ×1.0) so the hand-off from
   the placeholder texture to the Trek mosaic doesn't visibly darken the
   globe; the value is a stated camera-exposure choice, not a relabelled
   surface, and it prints in the on-screen credit ("...displayed at
   ×1.8 exposure"). Verified by toggling the Moon's committed exposure
   value 1.8 → 1.0 in `data/space/bodies.json` and back (reverted after
   the screenshots; no net change): sampled pixels on the same frozen
   camera angle read 78→103, 64→85, 87→113 (before→after, ~30%
   brighter), and the credit line's conditional "displayed at ×N
   exposure" clause correctly appears only when the multiplier is not 1.
2. **Globe lighting.** three.js's physically-based lighting divides the
   Lambertian term by π; the previous ambient 1.1 + directional 1.6 put
   the fully-lit sub-solar point at ~0.86× its texture value and the
   terminator side far darker — every globe read dim, worst on the
   low-albedo mosaics. Ambient 1.5 + directional 2.0 puts the sub-solar
   point at ~1.1× and the limb at ~0.5×: a brighter exposure of the same
   surface, applied to every body's globe (not Moon-specific — the
   modal is one component for all bodies). Verified by reverting to
   1.1/1.6 and back on a frozen Trek-loaded frame: measurable but modest
   brightening (mean per-pixel diff 4.4/255, max 29/255) since the
   Trek exposure gain above already dominates the frame once a Trek
   texture is showing; the effect is largest on bodies without a Trek
   override (e.g. Jupiter, Saturn) where it is the only exposure control.

Neither change touches the source imagery's actual albedo data — both
are stated display-exposure multipliers, credited on screen, leaving the
underlying LRO WAC mosaic and Solar System Scope textures exactly as
downloaded.

**45.6 What was verified but needed no change.**

`npx tsc -b --noEmit` passes with zero errors. `prefers-reduced-motion`
still starts orbital playback paused (unchanged code path). The zoom
buttons and the "Show/Hide slider" link are ordinary `<button>`
elements — keyboard- and screen-reader-reachable without touching the
canvas, as before. Attribution renders in three places already: the
scene's caption line, the globe modal's caption line (naming whatever
rung of the texture ladder is currently showing), and each body card.

## 46. Round 3, Phase 6: Cosmic Phenomena becomes a full catalogue (2026-09)

The 13-entry Cosmic Phenomena page (§41.3, §42.10) becomes a ~60-entry
categorised, searchable catalogue with every image downloaded, licence-gated
and served locally. A prior WIP pass (commit `b245f1b`) had already written
`etl/sources/phenomena.py`, `scripts/check-phenomena.mjs` and expanded
`etl/reference/cosmic_phenomena.json` to 62 entries, but the stage had never
been run end to end and the page itself was still the old 13-card layout
reading the old (string-array facts, hotlink-shaped) schema. This phase
finished the job: ran the stage, fixed what broke, rebuilt the page, and
re-verified sourcing.

**46.1 The two originally bare cards.** Andy's brief called out "Stars and
stellar life cycles" and "Gamma-ray bursts" as having no appropriate photo.
The expanded reference file already carried fixes for both, verified before
shipping: `stellar-lifecycles` pins NASA Image Library item
`GSFC_20171208_Archive_e000743` — Hubble's Westerlund 2 star-forming
cluster, released for Hubble's 25th anniversary — and `gamma-ray-bursts`
pins the Commons file `Gamma-ray-burst-illustration.jpg`, confirmed to be
NASA Goddard's Dana Berry GRB-jet illustration (public domain, "NASA
material is not protected by copyright unless noted"). Both now render with
full credit and licence lines.

**46.2 Image pipeline: download, gate, never hotlink.** Every entry pins one
of `nasaId` (NASA Image and Video Library item), `commons` (a Wikimedia file
that must clear the free-licence gate: public domain, CC0, CC BY, CC BY-SA,
Attribution — never NC/ND), `query` (a NASA library search, first hit with a
preview), or falls back to the pinned Wikipedia article's lead image through
the same Commons gate. `etl/sources/phenomena.py` downloads the chosen
rendition, re-encodes it to a bounded progressive JPEG (max 960×720, q82,
alpha composited onto white), and writes it under
`data/space/phenomena/<id>.jpg` with a provenance row in
`data/space/phenomena/manifest.json` (source URL, author, licence, credit
line). Nothing is hotlinked at render time. Running the stage cold-cached
resolved all 62 entries with zero rejects: 41 via `nasaId`, 12 via
`commons`, 8 via `query`, 1 via the Wikipedia fallback (wormholes, per
§42.10) — 4.47 MB total.

**46.3 Two upstream data-quality bugs found and fixed in our code.** (a) The
NASA Image and Video Library's `/asset/<id>` endpoint sometimes serves
rendition hrefs as plain `http://images-assets.nasa.gov/...` even though the
same host answers `https` (verified with a HEAD probe); `check-phenomena.mjs`
correctly failed 49 entries on "manifest sourceUrl is not https". Fixed by
normalising the scheme to https wherever an asset or preview href is read
in `phenomena.py`, before it is fetched or recorded — the file itself was
never insecurely served, only the recorded provenance URL was. (b) One
Commons file's Artist template renders the literal, un-filled string
"NASA's Scientific Visualization Studio - null" (verified against the file's
own page) — a known class of Commons authoring bug, not a real credit.
`_commons_image` now strips a trailing `- null` artefact from the author
field (a narrow regex, scoped to this file only) rather than inventing a
credit; if a Commons page ever lacks an author entirely the existing
"Wikimedia Commons contributor" fallback still applies.

**46.4 Broken NASA reference links from earlier rounds.** A HEAD probe (per
the standing note that some round-2 NASA links fail) found five dead
`science.nasa.gov` paths reused across the expanded catalogue's `nasa` field
and several facts' citation URLs: `/universe/stars/supernovae/`,
`/universe/neutron-stars/`, `/universe/what-are-nebulae/`,
`/universe/galaxies/active-galaxies/` and
`/universe/what-are-gamma-ray-bursts/` — all genuine 404s, not redirects.
Replaced with current equivalents verified live: the neutron-star family
(neutron-stars, pulsars, magnetars, kilonovae, quark-stars, fast-radio-bursts)
now cites `/category/universe/stars/neutron-stars/`; supernovae cites
`/category/universe/stars/supernovae/`; the three nebula entries split by
specificity (`/category/universe/nebulae/`,
`/category/universe/nebulae/planetary-nebulae/`,
`/category/universe/nebulae/star-forming-nebulae/`); quasars-agn and
blazars cite Webb's "What Are Active Galactic Nuclei?" explainer; and
gamma-ray-bursts cites NASA's dedicated GRB explainer article. All other
`nasa` links, all 62 Wikipedia links, and every fact URL (111 unique URLs in
total) were HEAD-probed and resolve 200 with a descriptive User-Agent
(Wikipedia rate-limits anonymous curl bursts with 429s — a probing artefact,
not a link problem).

**46.5 One description failed its own word/sentence gate.** `gravitational-waves`
had a 2-sentence description against the reference file's own 3–6-sentence
rule; expanded to four sentences (adding the Virgo/KAGRA multi-detector
network) without changing any figure.

**46.6 Fact spot-checks.** A sample across categories (GW170817's merger
delay and host galaxy, Betelgeuse's 2020 radius/distance, Planck 2018's
reionization redshift, magnetar counts and field strengths, the two
previously-bare cards' image provenance) was independently re-fetched via
Wikipedia/NASA and matched the reference file's values and cited years
exactly. Not every one of the 62×3-plus facts was re-verified line by line;
the sample targeted the entries most likely to have drifted (recent
observational records) and the two cards the maintainer flagged by name.

**46.7 The page: category filter + search, same tokens as the rest of the
site.** `CosmicPhenomenaPage.tsx` is a full rewrite (the old version still
read the pre-expansion schema: string-array facts, a single `BodyImage`-typed
hotlink field). Cards show the image (with a category chip and a status
badge — Observed muted, Theoretical `--accent`, Hypothesis `--negative`,
both already AA-gated against `--surface`/`--surface-raised` by
`check-contrast.mjs`), the description, an expandable "Key facts" list (each
fact linking its own source and year), NASA/Wikipedia links, and the image's
credit + licence + source-page link. A `role="group"` row of
`aria-pressed` category buttons (the same pattern as `TaxonomyPage`'s view
toggle) and a `type="search"` input filter the 62 entries client-side on
every keystroke; a live region announces "N of 62 entries"; an empty result
set shows a named "No phenomena match…" state with a one-click "clear the
filters" recovery rather than a bare "0 results" (per the no-dead-ends UX
guideline). No new colours, motion, or CSS were introduced — the global
`prefers-reduced-motion` rule in `index.css` already applies, and the type
additions (`PhenomenonFact`, `PhenomenonImage`, `PhenomenaCategory`,
`PhenomenaStatusInfo`, `PhenomenonEntry`, `phenomenonImageUrl`) live
alongside the existing `PhenomenaFile`/`usePhenomena` in `src/lib/space.ts`
without touching any other export there (bodies, moons, nomenclature
untouched).

**46.8 Refresh.** `cosmic_phenomena` joins the manifest as its own source
row (editorial text CC0, images NASA media or Commons free licences per
item); NASA and Commons links are static citations re-verified whenever the
reference file is next edited, not polled independently. No new runtime
exception: everything ships as a committed artifact under `data/space/`.

**46.9 Left for a full pipeline run.** This phase ran
`etl/run.py --only phenomena` under `LEADERS_CACHED_ONLY=1
CURRENCY_CACHED_ONLY=1` per the coordination brief, which — per the
CLAUDE.md hard rule — writes a partial `data/manifest.json` (crosswalk +
phenomena stages only). **Before this lands in a PR, run a full cached
`etl/run.py`** so the committed manifest's `content_fingerprint` covers the
whole pipeline again; nothing else about `/data` needs to change for this
phase.

## 47. Round 3, Phase 7: the periodic table of the elements (2026-09-12)

A prior agent (transcript lost; WIP commit `b245f1b`) built the Chemistry
section: the ETL stage (`etl/sources/chemistry.py`), the table and panel
components, the three.js Bohr-model schematic, the glossary, and the
Chemistry SECTIONS/token registration. Typecheck, contrast and
theme-parity passed; `node scripts/check-chemistry.mjs` failed with 43
problems. This entry records the diagnosis, the fixes, and the sourcing
for every field the panel shows.

**47.1 What already worked and was left alone.**

The table (`PeriodicTable.tsx`) renders all 118 elements in the IUPAC
18x7 layout with the f-block as two footer rows, category colouring with
a legend, and seven property views (electronegativity, atomic radius,
melting point, density, crustal abundance, discovery year, phase at STP)
on a sequential ramp with a HATCHED no-data swatch and legend entry —
exactly the seven the spec asked for, plus category. The grid uses a
roving tabindex; arrow keys skip empty cells and move between real
elements, Home/End jump to the row ends, Enter/Space opens the panel —
verified with a scripted Playwright session (Hydrogen -> 2x ArrowRight ->
Helium -> ArrowDown -> Neon -> Enter opens the panel). The element panel
(`ElementPanel.tsx`) shows the Commons photograph with author/licence/
Commons-page attribution, the animated three.js Bohr-model schematic
(`AtomModel.tsx`, nucleus + one ring per shell from the electron
configuration, OrbitControls, paused by default under
`prefers-reduced-motion` with an always-present Play/Pause control,
labelled "Bohr-model schematic" with a "not to scale" caption), and every
property with an `InfoTip` (a real `<button>`, `aria-describedby`,
click-to-pin so the glossary link is Tab-reachable, Escape closes) linked
to `/chemistry/glossary#<key>`. None of this needed changing.

**47.2 The 43 gate failures, by class.**

**Two elements with no image and no `noSample` flag (He, Pu).** Both had
a Wikidata P18 image that failed the licence gate: Helium's
`Helium discharge tube.jpg` (Alchemist-hp) is GFDL-1.2-only, and
Plutonium's `Plutonium ring.jpg` (Los Alamos National Laboratory) carries
a bespoke "Attribution" licence with no linked terms — both genuinely
outside the accepted set (PD / CC0 / CC BY / CC BY-SA / FAL), so the
rejection was correct. Neither element is a case for `noSample`,
though — free-licensed photographs of both exist — so
`etl/sources/chemistry.py` gained a `file` override in
`chemistry_samples.json` that lets an editorial pick replace the
automatic P18 choice. He now uses `Glowing ultrapure helium.jpg`
(images-of-elements.com, CC BY 3.0 — an ultrapure-helium discharge tube,
matching the spec's "gases: discharge tube" rule); Pu now uses
`Pubutton.jpg` (US Department of Energy, public domain — a plutonium
metal button). Both were verified against the live Commons API before
being picked (`LicenseShortName` checked directly, not guessed from the
element name).

**Three elements with `electricalConductivity: 0` (S, Br, I).** Not an
absence — a rounding bug. Conductivity is computed as 1/resistivity, and
sulfur's resistivity (~2x10^15 Ohm*m) gives a real conductivity of
~5x10^-16 S/m; `round(x, 4)` (fixed decimal places) crushed that, and
bromine's and iodine's smaller-but-still-tiny values, to `0.0`, which the
gate correctly refuses to accept as a bare zero. Fixed with a new
`round_sig()` helper (significant figures, not decimal places); the true
values (S: 5e-16, Br: 1.282e-11, I: 7.692e-08 S/m) now carry their
`computed as 1/rho from resistivity ...` note, and the front end's
existing `formatNumber()` already renders sub-0.001 magnitudes in
scientific notation, so no UI change was needed.

**38 elements with `stableIsotopes: 0` (Tc, Pm, and every element Z >=
83).** Also not an absence in the "no data" sense — these elements
really do have zero stable isotopes, every known isotope being
radioactive — but this site's convention (stated in the gate and matched
elsewhere, e.g. Space §33: "a figure a source does not publish is null")
treats the *display* of a bare `0` as indistinguishable from a missing
figure, so a definitional zero is rendered as an explicit null with a
reason rather than a number. `stableIsotopes` now emits
`{value: null, reason: "no stable isotopes -- every known isotope is
radioactive"}` when the IAEA count is 0, and the true count otherwise.

**Root cause behind the two image failures being visible at all, and
behind biologicalRole's high null rate.** `.cache/chemistry` held zero
cached PUG-View records (`pugviewRecords: 0` in the prior manifest) —
every one of the 118 fetches had apparently been skipped or failed
silently in the build that produced `b245f1b`. Re-running
`.venv/Scripts/python etl/run.py --only chemistry` (no
`CHEMISTRY_PUGVIEW_CACHED_ONLY`, PubChem's stated ~2.5 req/s pacing
already in the fetch loop) retrieved all 118 PUG-View records cleanly in
this pass (0 throttled, 0 missing) and dropped `biologicalRole` nulls
from 73 to 66 by supplying real PubChem-cited biological-role prose where
it exists. The remaining 66 are elements PubChem's PUG-View genuinely has
no biological-role section for, and whose Wikipedia article also has no
matching section — checked by inspection, not assumed.

**47.3 Honesty audit of the remaining nulls (not gate failures, checked anyway).**

The spec asked for gaps to be filled from real sources where they exist,
not just null-with-a-reason to satisfy the gate. The worst-null fields
after the fixes above were spot-checked against their actual upstream
source rather than taken on faith:

- **discoveryPlace (71 null).** Queried Wikidata directly for every
  element's P189 (`discovery place`): only 49 of 118 items carry it at
  all. This is a real gap in Wikidata, not a parsing bug — confirmed by
  running the SPARQL query standalone and inspecting the raw bindings.
  Left as an honestly-sourced null; a future pass could try each
  element's Wikipedia infobox for a "discovered" narrative field, but
  the standard `{{Infobox element}}` template has no place-of-discovery
  parameter to mine, so that would mean parsing free text per element —
  out of scope for this pass.
- **electronAffinity (61 null), abundanceUniverse (35 null),
  specificHeat (32 null).** All three check out against their sources:
  PubChem's `ElectronAffinity` field is empty for elements with no
  measured or bound anion (mostly noble gases, plus much of the
  d/f-block); Anders & Grevesse (1989) is a stable/long-lived-primordial
  solar-system compilation, so its 35 absences are exactly the elements
  with no stable isotope (Tc, Pm, Z>=84 minus none — an exact match);
  Wikipedia's heat-capacities data page simply has no tabulated value for
  32, mostly synthetic, elements.

No other `round()`-on-a-small-value bug was found elsewhere in the
module (`ionizationEnergies` is the only other rounded figure, and eV
values are never sub-0.001).

**47.4 Per-field source mapping (as shipped, vintages from this run).**

| Panel field | Source id | Title | Vintage |
| --- | --- | --- | --- |
| Atomic number, symbol, name, category, electron config (short + full), electron shells, electronegativity, ionization-energy fallback, electron affinity, oxidation states, phase at STP, melting/boiling point, density, van der Waals radius | `pubchem` | PubChem Periodic Table (NIH/NCBI) | retrieved 2026-09-08 |
| Uses, biological role, hazards (PubChem-sourced prose where present) | `pugview` | PubChem element records (PUG-View), per-statement references | retrieved 2026-09-13 |
| Standard atomic weight | `ciaaw` | IUPAC/CIAAW Standard Atomic Weights | revisions to 2024 |
| First three ionization energies | `nist_asd` | NIST Atomic Spectra Database | retrieved 2026-09-08 |
| Group, period, block, natural occurrence, specific heat (list fallback) | `wp_list` | Wikipedia: List of chemical elements (CRC-cited columns) | retrieved 2026-09-08 |
| CAS number, discovery year, discoverers, discovery place | `wikidata` | Wikidata (P18/P61/P138/P189/P231/P373/P575) | retrieved 2026-09-08 |
| Covalent radius | `wp_radii` | Wikipedia: Atomic radii of the elements (data page) | retrieved 2026-09-08 |
| Crystal structure, magnetic ordering | `wp_infobox` | Wikipedia element infobox templates | retrieved 2026-09-08 |
| Thermal conductivity | `wp_thermal` | Wikipedia: Thermal conductivities of the elements (data page) | retrieved 2026-09-08 |
| Electrical conductivity | `wp_resistivity` | Wikipedia: Electrical resistivities of the elements (data page) | retrieved 2026-09-08 |
| Specific heat (data-page value, where tabulated) | `wp_heat` | Wikipedia: Heat capacities of the elements (data page) | retrieved 2026-09-08 |
| Crustal abundance | `crc_crust` | CRC Handbook via Wikipedia "Abundances of the elements", column C1 | CRC 85th ed. (2005); retrieved 2026-09-08 |
| Universe (solar-system) abundance | `anders_grevesse` | Anders & Grevesse (1989) via the same Wikipedia data page, column Y2 | 1989 compilation; retrieved 2026-09-08 |
| Etymology | `wp_etymology` | Wikipedia: List of chemical element name etymologies | retrieved 2026-09-08 |
| Description, uses/biological role/hazards (Wikipedia fallback) | `wikipedia` | Wikipedia article text (CC BY-SA, attributed) | retrieved 2026-09-08 |
| Stable/known isotope counts, notable isotopes | `iaea` | IAEA Nuclear Data Section, Live Chart of Nuclides (NUBASE2020/ENSDF) | IAEA extraction 2023-10-18 |
| Element photographs | `commons` (per file) | Wikimedia Commons | licence gated per file: PD / CC0 / CC BY / CC BY-SA / FAL |
| noSample reasons, facility photos, editorial image overrides | `editorial` | `etl/reference/chemistry_samples.json` | v1 |

RSC's periodic table (periodic-table.rsc.org) was inspected, confirmed to
carry an RSC copyright notice with no reuse licence, and is linked from
the panel as further reading only, not scraped — unchanged from the
prior pass, restated here because the spec calls it out explicitly.

**47.5 Coverage, after this pass.**

118 elements, all with a full property set. 117 with an image (18 of
those are discovering-facility photos for atom-at-a-time elements, 1 is
a labelled "related" image for radon); 20 elements carry an explicit
`noSample` flag with a reason (unchanged set: At has a sample photo with
a `sampleNote` instead of `noSample`, since one exists; Rn, Fr, Md
through Og do not). 647 null figures remain across 22 properties, every
one carrying a reason; worst offenders after this pass: discoveryPlace
71, biologicalRole 66, electricalConductivity 63 (now all genuinely
untabulated resistivities, not rounding artefacts), electronAffinity 61,
stableIsotopes 38 (all "no stable isotopes" reasons, not zeros),
abundanceUniverse 35. 44 glossary entries, one per property key the
panel renders, each with a >=60-character definition and an http(s)
source (IUPAC Gold Book, NIST, CAS, IAEA, OpenStax CC BY 4.0, or the
relevant Wikipedia data page).

**47.6 Not changed.**

The table layout, colouring, legends, keyboard model, the Bohr-model
renderer, the glossary content and structure, and every property key and
its glossary entry. The `file` override added to the samples schema is
additive — existing `noSample`/`facility`/`dropWikidataImage` entries are
untouched and still take the same precedence order (override file, then
Wikidata P18, then facility fallback).

**47.7 Open question.**

`discoveryPlace` is null for 71/118 elements because Wikidata's P189
simply isn't populated for most elements, not because of a bug. A future
pass could mine each element's Wikipedia infobox free text (not a
structured template field) for a discovery-place mention, but that is
per-element prose parsing rather than a table extraction and was judged
out of scope here.

## 48. Round 3, Phase 2: the Antique direction becomes "A / Blaeu 1635" (2026-09-07)

Andy rejected the round-2 antique scheme and asked for one researched
from real 16th-19th-century hand-coloured maps. Scans were sampled in
OKLCH (Blaeu 1635, Mercator 1595, Ortelius 1570, Homann 1730, Cary
1801, Colton 1855, Johnson 1864; Commons + Library of Congress, all
public domain; sampling scripts in .scratch/antique_*.py, measured
swatches were embedded in the candidate artifact). Three candidates
(A Blaeu 1635 / B Cary 1801 / C Johnson 1864) were shown as swatch
sheets plus draggable globes; **Andy picked A**.

**48.1 The palette.** Measured from the Blaeu scan: parchment paper
oklch(0.90 0.045 83) #eddcbd; parchment sea oklch(0.905 0.03 86)
#e9dfca; umber line oklch(0.40 0.042 61) #594330; ink #422e1e; coast
band #b7a087. Fills: flag hue pulled halfway toward ochre (blendTo 85,
strength 0.5), chroma 0.055, light tiers L 0.70/0.75/0.80/0.85 (the
measured wash range). The 4-tier lightness encoding and the graph
colouring are unchanged; neighbour dE min 4.75.

**48.2 Gate trade-off (agreed in the candidate sheet).** True
hand-tint paleness puts these tiers too close to the parchment sea for
the 1.35 fill-vs-water floor. As on the originals, the ENGRAVED
COASTLINE carries the land/water separation, so for this direction
only, build-map-palette.mjs verifies a coastline gate instead: the
umber line must clear 3.0 contrast against the sea, the paper and
every fill (currently 3.38 minimum). Every other direction keeps the
water floor. Antique fills are theme-invariant (already true of all
direction fills, --fill-globe-<dir>-*).

**48.3 Rendering (WorldMap.tsx).** In the antique direction (country
mode, political base) the map renders as a sheet: parchment sea AND
parchment past the projection edge (the one exception to the
black-space rule of 2026-08-24 -- black around an antique sheet reads
as a screen; noted as an exception, not a reversal); umber country
strokes; a soft double coast band stroked from the merged land
outline under the fills; names in Newsreader italic umber with a
parchment halo; a static feTurbulence paper grain (multiply, alpha
0.09) and corner vignette above everything, view-fixed and inert.
Drag frames (canvas + GL borders) use the same literal colours.
Satellite/terrain and continent modes are untouched.

## 49. PhyloPic build rollover (2026-09-13)

The first full ETL run of round 3 aborted in the `evolution` stage:
PhyloPic's API answered HTTP 410 Gone for `build=555`. The API is
versioned by a build number every query must carry; the root document
naming it is cached like any other fetch, so a cached root goes stale
while a NEW name query (one not yet in the cache) reaches the live API
with a retired build. `etl/sources/evolution.py` now holds the build in
a small `_PhylopicBuild` object and, on a 410, re-reads the live root
once and retries the query. Per-name cache keys were already
build-independent (§21), so cached answers stay valid across
rollovers. A 404 still means "no silhouette" and anything else still
aborts the run.

## 50. Round-3 code review fixes (2026-09-13)

A high-effort review of the round-3 diff (`/code-review main high`)
found 15 defects, all fixed before the PR.

**50.1 Globe renderer (§43).** (a) The drag lambda is never wrapped,
so after more than 180 degrees of spin the visible-window unwrap in
`globegl.ts` fell outside the tile grid and no fine tile was requested
again: the centre longitude is now normalised before unwrapping, the
window is returned unwrapped, and `drawTiles` wraps column indices
modulo the tile count, which also fixes the second finding that a view
centred near the antimeridian never fetched the far-side tiles
(verified: tiles keep arriving through a scripted >360-degree spin at
9x zoom, columns 0-3 all requested). (b) A WebGL context restore
relinked programs but kept stale uniform locations, a dead clip buffer
and no blend state: GPU setup now lives in `initGpu()` and runs on
restore too. (c) `destroy()` sets a flag so an in-flight base fetch
no longer uploads into a discarded context or calls back an unmounted
map (StrictMode double-mount leak).

**50.2 Solar System (§45).** In true-scale mode every body radius sat
at the 0.02 floor, so the fly-to distance (4-8 radii) was below
`minDistance`, the lerp could never settle, and every later zoom-out
was dragged back to the floor. The fly distance is now clamped to the
controls' own range.

**50.3 Taxonomy (§44).** Expanding a capped focus genus (Bombus,
100/292 species shipped) silently live-fetched over the shipped
species; load errors stuck through collapse/re-expand and cards view
had no retry; `loadLiveChildren` flagged the cap on the last child
instead of the parent; `revealLive` read genera state from a stale
closure; `_bubble_images` could give a photo to a `pending` node
(latent); and 18 families with descendants but no genus-rank rows
(Sarcomeniaceae ...) had a genera file the UI never offered to expand
(`gen` is now set, possibly 0, whenever the file exists). All six
verified in Playwright, two with mocked network failures.

**50.4 Chemistry (§47).** PubChem's "Isotopes in Biology" heading
matched the loose `biolog` needle ahead of the real biological-role
fallback (18 elements, Fe among them, showed tracer text; now anchored
headings, "Isotopes in ..." excluded); any coarse-precision Wikidata
date was treated as antiquity (Arsenic, 1300 AD at century precision,
now shows 1300 / Albertus Magnus; only non-positive years are ancient);
the -3000 antiquity sentinel sat inside the discovery-year colour
domain and crushed all real dates into 9% of the ramp (ancient
elements now get their own legended `--chem-ancient` swatch, gated in
check-contrast); Escape on a pinned tooltip closed the whole element
panel (handled on the tooltip's root with stopPropagation while open);
and a bound such as chlorine's "> 10 ohm m" resistivity was parsed as
a point value and inverted into a false 0.1 S/m conductivity
(`parse_number` flags bounds; the field is a reasoned null).

## 51. Round 4: map performance on phones, palettes on every base view (2026-09-13)

Andy's brief: the Global Data maps were still sluggish on a phone
(frame-rate drops while navigating, a slow Satellite globe), the
colour directions did not apply to every base view ("Antique is not
available for the Terrain map"), the antique surround should be black
"to reflect space" — and evaluate the open-source **God's Eye View**
project (bilawalsidhu/gods-eye-view, MIT) for what its approach could
bring to our maps.

**51.0 What God's Eye View is, and what carries over.** It is a Cesium
globe (Google Photorealistic 3D Tiles or Esri World Imagery, Cesium
World Terrain, keyed and server-brokered) with live layers — OpenSky /
adsb.lol flights, AISStream vessels, CelesTrak satellites via SGP4,
USGS earthquakes, NASA FIRMS fires, Launch Library 2, TomTom traffic,
municipal CCTV, GBFS bikeshare, Radio Browser — and an OpenAI Realtime
voice agent. Every one of those is a runtime API, most need a key, and
the whole thing runs behind a Node key-broker. None of that fits this
site's architecture (§28: static Pages, committed data, keyless ETL,
two contained live fetches) or its licensing posture (OpenSky is
non-commercial, Google tiles may not be cached). So NO God's Eye code
or data source is imported. What DID carry over is its rendering
discipline, which is exactly what the political globe lacked:

- *Pixels on the GPU, CPU only for discrete changes.* GEV's globe is a
  textured sphere; the CPU never re-tessellates the world per frame. Our
  satellite globe already worked that way (§43) and was cheap; the
  political globe still re-projected 250 polygons on the CPU per frame.
- *A render governor* (`renderGovernor.js`): render continuously only
  while something animates, one frame per discrete change otherwise.
  Ours is the same shape — drag/inertia frames outside React, one
  commit per gesture — and round 4 extends it to zoom (51.3).
- *Budgets per view* (`localGeojsonLod.js`): bound per-frame work to
  what is in view. Round 4's culled vector frames (51.2) are that.

**51.1 Colour directions on every base view.** A direction colours the
country fills, and there are no fills on imagery — hence "Map colours"
did nothing on Satellite/Terrain. What a direction *can* carry onto
imagery is its sheet: a tone, its lettering, its texture. Each
direction now has an `ImageryGrade` (`src/lib/mapgrade.ts`) applied
per pixel in the imagery shader — atlas: none; paper: desaturate 0.4,
lift 0.08; antique: sepia 0.9, lift 0.06; pastel: desaturate 0.5, lift
0.22; nautical: desaturate 0.25 + a luminance-preserving tint toward
chart blue (0.55, 0.70, 0.82) at 0.3; mono: luminance only. The 2-D
fallback approximates the same with a CSS `filter`. Antique on imagery
also brings the sheet's lettering (Newsreader italic umber, parchment
halo), paper grain and corner vignette; its parchment sea, umber
strokes and coast band remain political-only because on imagery the
relief IS the sea and coast. The grade is presentation, encodes
nothing, and is never applied to the political fills (they already are
the palette), so it sits outside the palette gates — /methodology says
so. The "Map colours" control is therefore live in every base view.

**51.2 Political drag frames move to the GPU.** Measured with
`scripts/globe-spin-capture.mjs` (headed Chrome, desktop): a political
drag frame cost a median **8.9 ms of main-thread time** (p90 9.8, 422
frames per gesture); the satellite globe's cost **under 0.5 ms**. A
phone's CPU is three to six times slower, which puts the political
globe at 30–55 ms per frame — the sluggishness. Now:

- The country fills are painted ONCE into an equirectangular canvas
  (`src/lib/politicalraster.ts`: 4096×2048, 2048×1024 on low-power
  devices; ocean underneath; no strokes) whenever their resolved
  colours change — palette, fill mode, theme — during idle time, and
  uploaded to the imagery renderer as a world raster
  (`GlobeGL.setRaster`). A drag frame is then the SAME single
  inverse-projection pass the satellite view runs, plus the GL border
  lines from the same rotation uniform. Result: **2–4 frames above
  0.5 ms per gesture, median 2.4 ms**, i.e. the political globe now
  costs what the satellite globe costs.
- Above 6× zoom a raster texel would span more than ~1.5 screen pixels
  and fill edges would soften, so deeper drags use vector frames again
  — but culled to the countries whose `geoBounds` touch the inverted
  viewport window (`visibleLonLatWindow` / `boundsTouch`). At 6× and
  12×: **median 1.0 ms** (was 9.2). The no-WebGL2 fallback keeps its
  canvas frames and gains the same culling.
- The settle after a gesture ran THREE geometry passes per country
  (`path()`, `path.centroid()`, `path.area()`). Spherical centroid and
  area (`geoCentroid`, `geoArea`) are now computed once per topology;
  the label anchor is that point projected and the label-visibility
  area is steradians × scale² (exact for the equal-area projections)
  × cos(angular distance from the view centre) on the globe. Only a
  country whose centroid is over the horizon while part of it is
  visible still pays for the planar centroid and area. The merged
  land outline (antique coast band) is projected only when it is drawn.
- Resolving a CSS colour through a fresh GPU-backed canvas stalled
  30–60 ms on the readback (measured — it was the whole first-frame
  budget); the resolver now uses one `willReadFrequently` probe and a
  cache.

**51.3 Zoom, pinch and hover.** (a) Every stroke that scaled with the
zoom (country borders, coast band, rivers, admin-1 lines, marker rings)
now carries `vector-effect="non-scaling-stroke"`, so a wheel tick or
pinch step rewrites NO path attribute — before, 250 `stroke-width`
attributes changed per zoom event. A non-scaling width is in CSS
pixels (measured: Chrome ignores the viewBox scale too), so the old
viewBox-unit widths are converted through the viewBox-to-element scale
— identical hairlines, at every zoom. (b) d3-zoom's events are
coalesced to one React commit per animation frame (a pinch fires per
touchmove, up to 120 Hz on a phone). (c) A hover or tap used to
re-render the 250-row entity table because HomePage rebuilt its `rows`
array inline; rows are memoised and the table is `memo`-wrapped.
(d) Device tier (`src/lib/device.ts`): a coarse primary pointer, ≤4 GB
reported memory or ≤4 logical cores marks a low-power device (Apple
exposes neither memory nor cores, so the pointer is the signal that
catches iPhones). Low-power: canvas backing stores capped at 1.25×
(was 1.75× everywhere), anisotropic filtering 2× (was 8×), fine-tile
budget 4 (was 8, and only when memory was reported) with tiles decoded
at 1350² instead of 2700² (a quarter of the texture memory: eight full
tiles were ~310 MB, which is where iOS Safari starts dropping the
context). (e) Each fine-tile pass on the globe was a FULL-SCREEN
triangle whose fragments ran the inverse projection and then discarded
themselves outside the tile window — with eight tiles on screen, eight
full-screen passes of transcendentals. Each pass is now scissored to
the tile's projected bounding box (boundary samples forward-projected;
a sample over the horizon falls back to the disc's box; an empty box
skips the pass). Not measurable on a desktop GPU; it is the fill-rate
term a phone pays.

**51.4 Antique surround is black.** Reverses §48.3's exception on
Andy's explicit ruling ("the background of the Antique colour political
map type should be black to reflect space"): the parchment now stops at
the planet's edge on every projection, like every other direction.
`ANTIQUE.paper` survives as the label halo and the drag-frame colours
are unchanged.

**51.5 Data fix found on the way.** Seven admin-1 labels shipped with
the literal name `"nan"` (Natural Earth polygons with no name: pandas
hands a float NaN to `row.get`, which is truthy and stringifies). The
mapdetail stage now accepts only non-blank strings as names (places
too, defensively); the regenerated `admin1-labels.json` drops them.

**51.6 Verification.** `scripts/globe-spin-capture.mjs` gained a
`PALETTE=` option; captured before/after for political (world, 6×,
12×), satellite (world, 6×, 12×), terrain-antique, political-antique
and satellite-mono; frames compared against the pre-change captures
for identical geometry. Phone-side numbers are inferred from the
main-thread costs above, not measured on a device — Andy reviews the
live site on his phone and that remains the acceptance test.

## 52. Round 4: the periodic table fits a desktop, and the categories are defined (2026-09-13)

Andy: on a desktop the Chemistry table needed a sideways slider to
reach the last column; and the element types (transition metals and
the rest) had no definitions.

**52.1 Fit.** The table sat beside the element panel from the lg
breakpoint (1024px) with a hard 54rem floor, which at 1024–1279px left
it ~630px of column and forced the scroll; at 1280px it fitted only
with nothing else in the way (a scrollbar or a larger font tipped it
over). Now: the two-column layout starts at **xl (1280px)** with the
panel capped at 24rem; below that the table takes the full width and
the panel follows underneath (the select handler scrolls to it below
1280 instead of 1024). From lg the grid drops its floor and is 18
columns of `minmax(0, 1fr)` in a `container-type: inline-size` grid,
with the cell type in container-query units — symbol
`clamp(10px, 2.1cqw, 18px)`, number and name `clamp(7px, 0.95cqw, 9px)`
— so the cells and their lettering shrink together. Below lg the 54rem
floor and the sideways scroll remain (a phone cannot show 18 readable
columns) and the hint says so up to lg. Verified in headed Chrome at
1024/1280/1366/1600: the grid equals its region's width, nothing
scrolls, oganesson's right edge is inside the column, symbol 17–18px.

**52.2 Category definitions.** Ten EDITORIAL entries join
`etl/reference/chemistry_glossary.json` (version 2), keyed
`category.<key>` for the ten `CATEGORY_ORDER` keys, each a
plain-language paraphrase with a cited source: OpenStax Chemistry 2e
§2.5 for alkali metals, alkaline earth metals, transition metals,
metalloids, noble gases, lanthanides and actinides; Wikipedia
("Post-transition metal", "Nonmetal", "Superheavy element", CC BY-SA)
for the three that are conventions rather than textbook terms, and the
entries say so. They surface as the same ⓘ InfoTip beside each chip of
the category legend and beside the category name in the element
panel's header, and they list on /chemistry/glossary with everything
else. check:chemistry accepts extra glossary entries by design (it
requires an entry per property key and validates every entry's
definition and source); the chemistry stage's own guard is unchanged.

## 53. Round 5: the phone globe — square frame, bottom sheet, explore mode, search (2026-09-13)

Andy's brief, after checking WorldMap.tsx himself: the map keeps a
1000×480 frame, so at 350 px wide the globe is 168 px tall and the
popup competes for that space. His list, in his order: a near-square
globe that fills the width with the counter compressed and the year
controls underneath; a bottom information panel instead of floating
popups (tap → highlight → name/population/growth; swipe up for more,
down to keep exploring; selected country stays visible); scrolling
separated from globe gestures with the fullscreen option as an obvious
"Explore globe" button; "Search countries" directly above the globe
that flies to the result; thumb-sized controls (Globe/Map, zoom, Reset)
with the rest in one Map settings panel; more forgiving selection (more
labels with zoom, a short list of nearby countries on an ambiguous tap).

**53.1 Square frame.** The viewBox is now a per-render value: 1000×1000
for the globe on a compact stage (< 640 px), 1000×480 otherwise. Every
consumer of the frame — projection fit, layouts for both canvases, the
zoom extent, the label bounds, the antique rects, the stroke conversion
— takes `viewW`/`viewH`; `compact` is decided by the measured stage
width, seeded from the window so the first paint is already right.
Measured on a Pixel 7 (412 px viewport): the svg is 361×361 (was
361×174). The page container is a flex column so the phone order
differs without duplicating anything: header → toolbar+search+map →
year controls (order-4 on phones, order-2 on wider screens) → table.
The counter drops a size on phones and the header loses padding.

**53.2 Bottom sheet.** `renderSheet(target, expanded)` is a new WorldMap
prop; when it is set and the tap is a touch (or the stage is compact),
`selectUnlessDragging` no longer pins a popover — it highlights the
country (through `onHover`) and opens `.map-sheet` IN FLOW under the
stage, so it never covers the globe. In explore mode the frame is a
flex column and the stage shrinks above the sheet, so the selected
country stays visible whatever the sheet's height. Collapsed: flag,
name, population, growth, More info. Expanded (swipe up, or tap the
grip): the full popover card plus the MapReadout, which the phone
layout no longer shows beside the map (`aside` is hidden below sm).
Swipe thresholds ±30 px; swipe down collapses, then closes. The swipe
uses native non-passive touch listeners on the grip — React's touch
handlers are passive, so the page scrolled under the first attempt
(measured with CDP touch events; expanded stayed false). Mouse users
get the same through pointer events. The desktop hover popover is
unchanged; a search on a desktop shows the result in the readout, not a
sheet.

**53.3 Explore mode.** The svg's touch-action is `pan-y` when embedded:
a vertical swipe scrolls the page (the browser takes it and fires
pointercancel, which ends any drag session), a horizontal drag still
spins, a pinch still zooms. "Explore globe" (a labelled pill, top-left,
compact only) is the fullscreen control: inside, touch-action is
`none`, one finger spins and two zoom, "Done" leaves. iOS Safari has no
element fullscreen, so the frame falls back to a CSS pin (`fixed
inset-0`, body scroll locked, Escape leaves) when `requestFullscreen`
is missing or rejects. The fullscreen element is the FRAME (stage +
sheet), and the stage is what is measured — `containerRef` is the
stage, `frameRef` the frame.

**53.4 Search.** `CountrySearch` (combobox + listbox, no library;
accent-folded prefix-on-any-word then substring) sits directly above
the map on every width. Picking a result calls `WorldMapHandle.flyTo`
(the map is now a forwardRef): the globe rotates to the entity's
spherical centroid, the fit projects it under that orientation and
zooms so it fills about a third of the frame (markers get a small
context box), through the d3-zoom behaviour with a 650 ms transition
(none under reduced motion), then the sheet opens (touch/compact) or
the readout shows it (pointer). Flat projections zoom without rotating.

**53.5 Thumb controls.** On phones the toolbar is a Globe / Map
segmented toggle (Map returns to the last flat projection) plus a "Map
settings" disclosure holding fill mode, base view, projection and
colours; on wider screens the same controls render as the toolbar
(one DOM, CSS decides). ZoomControls gains `large` (44 px targets),
`horizontal` (a row for the short flat map, where a column of four hung
below it) and `onReset` (initial orientation, zoom 1, sheet closed).

**53.6 Forgiving selection.** Label growth is capped at 3× the zoom-1
size (`LABEL_GROWTH_CAP`; it used to grow without bound — "Cuneo" was a
billboard at 48×), and compact stages show country names at 0.6× the
area threshold. On a touch tap, nine probe points on a 14 px ring go
through `elementFromPoint`; every distinct `data-iso3` under them
becomes a "Nearby" chip in the sheet (e.g. a tap on the Central African
Republic offers DR Congo, Cameroon, Chad).

**53.7 Dev-server fix found on the way.** Tailwind v4 scans every
non-gitignored file for class names, and /data is 224 MB in ~20k
committed files: every dev CSS rebuild walked it, and index.html took
10–20 s after an ETL run touched 4k genera files. `@import
'tailwindcss' source(none)` with explicit `@source '../src'` and
`'../index.html'` — index.html now serves in 7 ms; the production CSS
still carries every class (built size grew only by the new
components).

**53.8 Verification.** Pixel 7 emulation with CDP touch: tap → sheet
with nearby chips; swipe → expanded; search "mona" → Monaco flown to
and sheeted; Explore → Done; Map settings; flat Map with a horizontal
control row; search "japan" on the flat map. Desktop 1280: hover
popover intact, search "nepal" flies without a sheet. No console
errors. The live site on Andy's phone remains the acceptance test.

## 54. Round 6: timeline banners, the drifting outlines, the compass, and the 2004 imagery (2026-09-13)

**54.1 The axis line no longer cuts through era banners.** On /history
the vertical axis was drawn after the era bands in the DOM, so it
painted over the banner boxes and through their text. The banner is
now `position: relative; z-index: 1` — an opaque box the line passes
behind — and nothing else moved (Andy: "it can disappear behind it").

**54.2 White outlines drifting from the imagery when the globe spins
fast.** Andy's report persisted after round 4 on his phone. The cause
is not a stale frame: mid-drag the outlines and the imagery are drawn
by the same GL pass from the same rotation uniform. What differs is
the ARITHMETIC. The drag accumulated lambda without bound — a few fast
spins reach thousands of degrees — and while d3 does not care, mobile
GPUs evaluate sin/cos of large arguments with visibly reduced
precision. The imagery is the inverse path (atan/asin per fragment) and
the outline lines the forward path (sin/cos per vertex), so their
errors differ and the lines land beside the coast. Fix: lambda is
wrapped to [-180, 180) at every write of the rotation ref (drag frame,
inertia step, fly-to) and, defensively, before it becomes a shader
uniform. Two further guards found on the way: the at-rest imagery
render is now a layout effect (it painted a frame after the SVG's new
outlines, one frame of mismatch on every stage resize or sheet open)
and it never runs while a drag session is live (a tile landing or a
pinch mid-gesture used to repaint the canvas from stale React state).
Sensitivity comes down from 0.5625 to **0.375°/px** and inertia decay
from 0.93 to 0.9 on Andy's request ("I don't need the globe to spin
that quickly") — this reverses the second of the two 2026-08 raises.
The Reset view control is now a **compass** icon (ring and needle,
north filled) that returns the globe or map to its default orientation
and zoom and closes any selection; it shows on every width.

**54.3 Why the satellite view is still Blue Marble 2004.** Andy asked
for something more recent. What the satellite base needs is a
cloud-free, true-colour, global mosaic that can be BAKED into
committed tiles (§30: no runtime tile servers) under a licence this
site can carry. The options, checked on 2026-09-13:

| Source | Vintage | Licence | Verdict |
|---|---|---|---|
| NASA Blue Marble Next Generation | 2004 (monthly) | Public domain | Shipped. Still the newest cloud-free global true-colour composite NASA has published as a downloadable mosaic. |
| NASA GIBS VIIRS / MODIS Corrected Reflectance | daily, current | Public domain | Daily scenes with cloud; no cloud-free annual composite is published. Would need our own compositing of a year of daily tiles. |
| EOX Sentinel-2 cloudless (s2maps.eu) | 2016–2024, yearly | CC BY-NC-SA 4.0 (non-commercial); commercial licence otherwise | The best-looking recent option. Non-commercial use fits this site, but share-alike would attach to the committed tiles and the free tile service is not offered for bulk download of the ~10k tiles the tiers need. Not adopted without Andy's ruling. |
| Copernicus Sentinel-2 Global Mosaic / Data Space quarterly mosaics | 2023–, quarterly | Copernicus free and open | Registration-gated, 10 m COGs measured in terabytes; no world-scale rendition to bake. |

Decision at the time: keep Blue Marble 2004 and record the EOX route
as the candidate. Andy then ruled "Use EOX Sentinel-2 cloudless" the
same day — see §56 for what shipped.

## 55. Round 6: Human Anatomy — the body in layers (2026-09-13)

Andy's brief: a new page with a comprehensive diagram of the human body
presented in LAYERS, from the outer layer inward to the skeleton;
information on every organ and every system — lymphatic, central and
peripheral nervous, circulatory, pulmonary, musculoskeletal and the
rest — with detailed definitions and descriptions, and how the organs
work together.

**55.1 Shape.** A seventh top-level section, `/anatomy` (SECTIONS
registry, `--nav-anatomy` and the `--anatomy-bg/-text` pill, hue 20,
gated in check-contrast and check-theme-parity). The page is one stage
showing a whole-body diagram, a depth control (Outward / Deeper
buttons, the numbered chip list, arrow keys) that steps through TEN
layers in order — body surface, muscles, heart and vessels, airways
and lungs, digestive tract, lymphatic vessels and nodes, brain/cord/
nerves, endocrine glands, kidneys and bladder, skeleton — and, beside
it, the layer's system: summary, description, functions, the systems
it works with (chips that jump to that layer), its figures, and its
organs as expandable entries (location, description, function, facts,
source). The reproductive system, which has no whole-body diagram, is
an eleventh view built from its two figures; the integumentary system
carries a skin-section figure beside its body-surface layer. Below the
viewer, eight "how the systems work together" notes trace one job each
across the systems that share it (oxygen to a cell; a meal to energy;
a movement; water and salt; an infection; 37 degrees; building bone;
homeostasis as the common thread), then an alphabetical index of every
organ. Deep links: `#skeleton` opens a layer, `#organ-heart` opens an
organ.

**55.2 Content and sources.** EDITORIAL — `etl/reference/anatomy.json`,
written by `etl/reference/build_anatomy.py` (prose is easier to keep
honest in Python literals than in hand-edited JSON; run the script,
never edit the JSON). Eleven systems (integumentary, skeletal,
muscular, nervous with its central/peripheral/autonomic divisions,
endocrine, circulatory, respiratory, lymphatic and immune, digestive,
urinary, reproductive) and sixty organs, ~8,000 words, every entry a
plain-language paraphrase citing the OpenStax Anatomy and Physiology
2e chapter it follows (CC BY 4.0; chapter-introduction URLs). Figures
are given where OpenStax gives them (skin area, alveolar surface,
nephron counts, cardiac output, blood volume) and stated as "about".
An organ belongs to every system it serves (`systems`, the first is
where it is listed; the pancreas is digestive first and endocrine
second, the diaphragm muscular first and respiratory second) and the
secondary systems list it as "also under". The `anatomy` ETL stage
validates all of this — minimum description lengths, every organ
listed by its primary system, every worksWith pointing at a real other
system, every system reachable from a layer or figure — and
`check:anatomy` proves it again on the shipped artifact.

**55.3 Diagrams.** Wikimedia Commons files, resolved through the same
free-licence gate as the phenomena (PD, CC0, CC BY, CC BY-SA; NC/ND
refused) and downloaded as the ORIGINAL file — SVG stays SVG, because
these are labelled line drawings and a JPEG rendition blurs the
labels; PNG originals over 2.5 MB would be re-fetched at 1600 px (none
were). The set: Human silhouette gender neutral front (CC0, Sebastian
Wallroth); Muscles anterior labeled (PD, Mikael Häggström);
Circulatory System en, Respiratory system complete en, Digestive
system diagram en, Human skeleton front en (PD, LadyofHats / Mariana
Ruiz Villarreal); TE-Lymphatic system diagram (CC BY 3.0, LadyofHats);
Nervous system diagram-en (CC BY-SA 4.0, Medium69/Jmarchn); Illu
endocrine system New (PD, NCI); Urinary system ver 2 (CC BY-SA 3.0,
Jordi March i Nogué); Skin layers (CC BY-SA 3.0, Madhero88/
M.Komorniczak); Scheme female reproductive system-en (PD, CDC/Mysid);
Male internal reproductive organs (CC BY-SA 4.0, RWhitwam). 7.0 MB in
all, credited under the stage and in the sources list, provenance in
data/anatomy/images/manifest.json. The layers are different artists'
drawings at different scales, so the stage cross-fades between them
rather than pretending they register pixel for pixel; a single
consistent set (OpenStax's own Figure 1.4 panels, CC BY) would be the
upgrade if Andy wants the layers to overlay.

**55.4 Verification.** check:anatomy (systems, organs, images, licences,
reachability); headed Chrome at 1280 (layers step, organ opens, the
reproductive view, no console errors) and Pixel 7 (stage stacks above
the panel).

## 56. Round 6: the satellite view moves to EOX Sentinel-2 cloudless 2025 (2026-09-13)

Andy's ruling on §54.3: "Use EOX Sentinel-2 cloudless." This reverses
the 2004 default and accepts the licence trade-off recorded there.

**56.1 Source.** EOxCloudless (https://cloudless.eox.at), EOX IT
Services GmbH: a cloud-free Sentinel-2 mosaic published per year; the
WMS at tiles.maps.eox.at offers `s2cloudless-2016` … `s2cloudless-2025`
in EPSG:4326 and Web Mercator. **2025** is used — the newest layer the
capabilities document lists (fetched 2026-09-13). Licence for
non-commercial use: **CC BY-NC-SA 4.0**, attribution required verbatim:
"EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH
(Contains modified Copernicus Sentinel data 2025)". This site is
non-commercial; the committed tiles under `data/geo/terrain/` are a
derived work and carry the same licence (README says so; the map's
credit line carries the sentence verbatim with a link and names the
licence; the manifest's source record and /methodology repeat it).
The repo's MIT licence covers code only, as it already does for the
other carved-out data folders.

**56.2 How the tiers are built (mapdetail stage).** The three tiers are
unchanged in shape — 2700×1350 world; 10800×5400 as 8 tiles; 21600×
10800 as 32 tiles of 2700 px — but instead of cutting one giant source
image, each tile is ONE WMS GetMap request for exactly its lon/lat
window at exactly its pixel size (`eox_tile_request`), so nothing is
resampled: 41 requests in all, sequential, cached under
`.cache/terrain/eox-s2cloudless-2025-t*.png`. A 2700 px window renders
server-side for about three minutes before the first byte, so
`fetch()` gained a per-call `timeout` (EOX_TIMEOUT_SECONDS = 900;
requests' timeout is per read). The server answers PNG with alpha
regardless of the requested format; transparent areas (beyond
Sentinel-2's coverage at the poles) are composited onto white, which
is what the ice there is, and each tile is re-encoded as progressive
JPEG q72 under the same file names the renderer already reads, so
`src/lib/globegl.ts` and the tier meta needed no change beyond the
attribution. The equal-area flat views and the antimeridian handling
are unaffected: the equirectangular layout is identical. NASA Blue
Marble 2004 stays in the pipeline as `SATELLITE_SOURCE=bluemarble`,
the documented public-domain fallback; the manifest source id stays
`nasa_blue_marble` so artifact references and the freshness panel keep
working, with the title/licence/citation fields now describing EOX.

**56.3 What changed on screen.** The satellite globe shows 2025 land
cover — current reservoirs, cities, deforestation fronts, the Aral
Sea as it is — with the ocean rendered as EOX's bathymetric blue (no
shaded relief, unlike Blue Marble's baked hillshade). Polar caps are
flat white where Sentinel-2 does not image. The imagery tone grades
(§51.1) apply as before.

## 57. Round 7: outlines drawn by one renderer, Google-Earth pace, OpenStax layers, three small fixes (2026-09-13)

**57.1 Outlines and imagery from ONE renderer.** Andy's phone still
showed the white outlines parting from the countries after a fast spin,
so the longitude wrap of §54.2 was necessary but not sufficient. The
remaining way two things on screen can disagree is if two renderers
draw them: at rest the outlines were SVG strokes over a GL picture,
and any difference in when or from what each painted showed as a
gap. Now, in the satellite and terrain views, the GL pass draws the
outlines at rest as well as during drags (the same `borders` option
the drag frames use, from the same rotation), and the SVG country
shapes carry no stroke in those views — they stay as transparent hit
targets for hover, tap, keyboard and the highlight fill. One renderer
cannot disagree with itself. The 2-D fallback keeps its SVG strokes
(it has no GL pass). Two seams surfaced once the GL lines were always
on: Natural Earth's antimeridian and pole cuts (Russia, Fiji,
Antarctica) are data edges, not borders, and are dropped from the
border mesh; and the EOX WMS antialiases the outermost pixel of every
window against transparency, which the white composite turned into a
pale one-pixel frame — a bright line down the antimeridian — so the
mapdetail stage now extends the second column and row over the first
in every tile.

**57.2 Pace.** "Match the maximum movement speed of the globe on
Google Earth": sensitivity 0.375 → **0.25°/px** (the original value), and
a flick's starting speed is capped at 18 CSS px per frame
(`INERTIA_MAX_PX_PER_FRAME`) before the 0.9 decay, so the hardest flick
carries the globe about a quarter turn and stops within a second —
Google Earth's feel, no blur of revolutions.

**57.3 Antique: the faint bar.** The feTurbulence paper-grain rect is
removed. Its rendered region is what GPUs tile and clamp at large
sizes, so the multiply landed on a rectangle of the sheet and not the
rest — Andy's "transparent bar, slightly darker inside". The vignette
(a plain radial gradient) stays; the sheet is otherwise unchanged.

**57.4 Evolution event box.** The description column had `min-w-56`,
which cannot shrink inside a narrow period column, so on phones the
text ran past the box's right edge. It is a flex basis now
(`flex-[1_1_14rem]`, `min-w-0`) with `break-words`.

**57.5 Year controls.** Directly under the World population box on
every width (the round-5 phone-only reordering under the map is
reversed on Andy's request).

**57.6 Anatomy layers are the OpenStax panels.** "Adopt the OpenStax
organ system": the eleven whole-body layers are now the twelve panels
of OpenStax Anatomy and Physiology Figure 1.4 (Commons "Organ Systems
I.jpg" and "Organ Systems II.jpg", OpenStax College/Connexions,
**CC BY 3.0**), cut on the 2×3 grid by the anatomy stage from the
cached composite (`panel: {commons, col, row}` in the reference, JPEG
q90, provenance from the composite with the panel noted). They are
one artist's drawings on one pose at one scale, so stepping inward now
registers: skin → muscles → heart and vessels → airways → gut →
lymph → nerves → glands → kidneys → reproductive (female panel; the
male panel is a figure) → skeleton. The LadyofHats and other
whole-body diagrams are retired; the skin-section and the two
reproductive sectional figures stay as supplementary figures. Layer
images total 3.3 MB (was 7.0).

## 58. Round 8: one inertia loop, and the antique sheet with nothing on top (2026-09-13)

Andy, from his phone after round 7: labels and outlines separate AFTER
the spin stops, with some freezing; and the faint darker bar in the
antique view is still there.

**58.1 The double inertia loop.** A release fires `pointerup` and then
`lostpointercapture` (the drag captures the pointer), and on touch
`pointerleave` as well; all three reach `handleGlobePointerEnd`, which
started an inertia loop each time the session was still live. Two or
three loops then advanced the same rotation ref in parallel. The first
to settle committed the rotation to React and brought the SVG back; the
others kept painting GL frames that carried the imagery on (and, in the
political view, switched the GL canvas back on under the SVG), so once
everything stopped the SVG's labels and outlines stood where the first
loop ended and the imagery where the last one did. That is exactly
"separate after the spin stops"; the doubled per-frame work on a phone
GPU was the freezing. On a desktop the two loops started in the same
tick with the same delta and finished on the same frame, which is why
no capture here ever showed it. `startInertia` now returns if a loop is
already running, and `drawDragFrame` refuses to paint outside a live
session, so a stray frame can never move a canvas after the commit.

**58.2 Antique overlays.** The vignette rect follows the grain rect
(§57.3) out: a gradient-filled rectangle painted across the whole
viewport was the last thing left over the sheet, and Andy still saw a
darker rectangle after the grain went. The antique direction is now
its parchment sea, umber lines, coast band and lettering with nothing
view-fixed on top; if the bar survives this, it is not ours and a
screenshot is the next step.

## 59. Round 9: pace up again, gestures at zoom, and a compass that reorients instead of relocating (2026-09-14)

Andy after round 8: the globe now moves "way too slowly"; zoomed in,
the map sometimes "freezes so I can no longer move it"; and the compass
must not jump back to the default view — it should reorient so north is
up, the way Google Earth's and Google Maps' compasses do.

**59.1 Pace.** Round 7's 0.25°/px and 18 px/frame flick cap were set
while the double inertia loop (§58.1) was still making every flick look
wild; with that fixed they were simply slow. Now 0.375°/px and a 40 px
cap: a hard flick carries the globe about half a turn and stops within
a second.

**59.2 The "freeze" at zoom.** Embedded, the svg had `touch-action:
pan-y` so a page scroll could start over the map (§53.3). Zoomed in,
the natural gesture is a vertical drag — and the browser took every one
of those as a page scroll and cancelled the pointer, so the map would
not move. The svg is `touch-none` whenever the zoom is above 1.05 (the
map owns every gesture once you are in it) and `pan-y` only at world
zoom, where the page still scrolls over it.

**59.3 Compass = north up, not reset.** This globe has no heading axis:
at the disc centre the meridian is always vertical. What makes a
zoomed-and-panned view feel "not north-up" is that the screen centre is
then off the disc centre, where the meridians lean toward the pole — the
moment a Google Earth user reaches for the compass. North up therefore
means: find the place under the screen centre, rotate the globe so that
place becomes the disc centre (its meridian now straight up), and bring
the pan back to centre, keeping the zoom. The place stays where the
reader is looking; the globe reorients around it. Animated over 500 ms
through the drag-frame path with the zoom transform driven from a ref
(`transformRef`, which the drag frames now read instead of React state),
committed once at the end; instant under reduced motion. Round 5's Reset
view (initial orientation, zoom 1) is gone; the handle exposes `northUp`
and the flat maps, always north-up, show no compass.

## 60. Round 10: the freeze was the settle (2026-09-14)

Andy: "Still freezes on mobile." Measured with a long-task observer in
headed Chrome: after every drag on a zoomed map the main thread blocked
for **~950 ms on a desktop** (three to five seconds on a phone), at any
zoom past about 2×. It was the settle, 160 ms after the rotation
commits: `detailPaths` projected EVERY feature of the loaded detail
layers (10m rivers alone, 300 ms) and `detailLabels` ran
`path.centroid` over every lake and river and the collision loop over
every place and admin-1 label — almost all of it geometry off screen,
because at 18× the viewport is a few degrees wide. §59.2's gesture fix
was real but not this; this is what "cannot move it" felt like.

Fix: per-feature `geoBounds` are computed once per collection (WeakMap)
and only the features whose bounds touch the visible lon/lat window
(`visibleLonLatWindow`, the culling the drag frames already used) are
projected, centroided or offered to the collision loop; places and
admin-1 points get the same window test before their projection. The
window is null at world zoom or when the limb is in view, and then
everything is drawn as before. Long task after a drag: **~950 ms →
70–100 ms** at 4 and 12 wheel steps (the remainder is the rotation
commit of the 250 country paths). Nothing about what is drawn changed
— a feature outside the window has no pixels to lose.

## 61. Round 11: the globe owns every touch gesture (2026-09-14)

Andy: on the phone the map "does not smoothly move, nor does it move much
when I use my finger to spin — ever so slightly, very rigid."

That is what `touch-action: pan-y` does to a globe on iOS: the browser
holds each touch until it has classified the direction, hands the map
only the strictly horizontal ones, coalesces their pointer events, and
cancels the pointer the moment the finger drifts vertically — so a
natural spinning motion, which always has some vertical component, was
being cut off after a few pixels. §53.3 chose pan-y at world zoom so the
page could still be scrolled from over the embedded map; §59.2 already
withdrew it above zoom 1.05. Now the globe is `touch-action: none` at
every zoom, embedded or not, and only the flat maps at world zoom (where
d3-zoom allows no pan anyway) keep pan-y. The cost is deliberate: to
scroll the page on a phone you start the swipe outside the globe — the
same trade every embedded globe makes, and the one Andy's report asks
for.

## Resolved questions

- **SGS continent assignment** — resolved 2026-08-10 in favour of South
  America, following UN M49, with the biogeographic tension recorded (§2.3).
- **Morocco / Western Sahara boundary** — resolved 2026-08-10. The premise of
  the question was wrong: the map and the biome maths do not disagree. Natural
  Earth's de facto boundary is kept and disclosed on the affected pages (§9.5).

## Open questions

- Whether to surface UN WPP's own regional aggregates alongside our computed
  seven-continent ones, given they will not match (§2).
- **Åland, French Polynesia and the Faroe Islands** each measure 25–52% below
  their published land area (§9.5). Unlike Western Sahara these are not
  disputed — they are small-island coastline definitions, and the gap is
  probably Natural Earth omitting minor islands. Worth confirming against a
  finer resolution if island-level accuracy ever matters.
