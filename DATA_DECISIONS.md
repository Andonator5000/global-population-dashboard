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
