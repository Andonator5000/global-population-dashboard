"""Central configuration for the ETL pipeline.

Every upstream URL, indicator code, and editorial constant lives here. Nothing
in etl/sources/ should contain a hardcoded indicator code or endpoint -- if you
find yourself typing one there, add it to this file instead.

Indicator codes are validated against the upstream catalogue by
`python etl/run.py --validate-indicators`, which fails loudly on any code that
no longer resolves. That check exists because World Bank retires indicators
without notice, and a retired code otherwise surfaces as a silently empty
series rather than an error.
"""

from __future__ import annotations

from pathlib import Path
from typing import NamedTuple

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
CACHE_DIR = REPO_ROOT / ".cache"          # raw downloads, gitignored
REFERENCE_DIR = Path(__file__).resolve().parent / "reference"
MANIFEST_PATH = DATA_DIR / "manifest.json"

# --------------------------------------------------------------------------
# Editorial constants  (see DATA_DECISIONS.md for the reasoning behind each)
# --------------------------------------------------------------------------

# Resolved with the user 2026-08-09: seven-continent model, Americas split.
CONTINENTS: dict[str, str] = {
    "AF": "Africa",
    "AN": "Antarctica",
    "AS": "Asia",
    "EU": "Europe",
    "NA": "North America",
    "OC": "Oceania",
    "SA": "South America",
}

# Equal-area CRS for all area math. EPSG:6933 (NSIDC EASE-Grid 2.0 Global) is
# a cylindrical equal-area projection valid worldwide. Area computed in
# EPSG:4326 degrees is meaningless -- see DATA_DECISIONS.md.
EQUAL_AREA_CRS = "EPSG:6933"
SOURCE_CRS = "EPSG:4326"

# Biome share validation tolerance: shares per entity must sum to 100% +/- this.
BIOME_SHARE_TOLERANCE_PCT = 1.0

# --------------------------------------------------------------------------
# UN World Population Prospects
# --------------------------------------------------------------------------
#
# Access decision (2026-08-09): bulk CSV only, no Data Portal API.
# The Data Portal's /data/ endpoints return HTTP 401 without a registered
# token. Requiring a secret would mean a fresh checkout could not run
# `python etl/run.py --refresh` unattended, which is an explicit acceptance
# criterion. The bulk CSVs carry the same WPP 2024 numbers with no auth.
#
# Revision note: WPP 2024 is current as of 2026-08. The 2026 revision was
# postponed to 2027, so a stable 2024 result from the monthly job is the
# CORRECT outcome, not a stalled fetcher. discover_latest_revision() probes
# for newer revisions rather than assuming an annual cadence.

WPP_REVISION_DEFAULT = 2024
WPP_REVISION_PROBE_RANGE = range(2024, 2032)  # probed newest-first at runtime

WPP_CSV_BASE = (
    "https://population.un.org/wpp/assets/Excel%20Files/"
    "1_Indicator%20(Standard)/CSV_FILES"
)


class WppFile(NamedTuple):
    key: str
    filename_template: str
    approx_mb: int
    description: str


# Filenames verified live 2026-08-09. Note the single-age files are split
# 1950-2023 / 2024-2100 rather than carrying one 1950-2100 range -- a
# 1950-2100 single-age filename 404s.
#
# We take FIVE-YEAR age groups for the pyramids, not single-year ages: five-year
# groups are the conventional pyramid granularity, arrive in one 30 MB file
# covering the whole 1950-2100 range, and cost a quarter of the ~129 MB the two
# single-age files would. Swap to single-age only if a chart genuinely needs it.
WPP_FILES: tuple[WppFile, ...] = (
    WppFile(
        "demographic_indicators_medium",
        "WPP{rev}_Demographic_Indicators_Medium.csv.gz",
        16,
        "Totals, growth rate, TFR, CBR, CDR, net migration, median age, life "
        "expectancy. Estimates 1950-2023 + medium projection 2024-2100.",
    ),
    WppFile(
        "demographic_indicators_othervariants",
        "WPP{rev}_Demographic_Indicators_OtherVariants.csv.gz",
        75,
        "Low / high / constant-fertility variants, for the projection bands.",
    ),
    WppFile(
        "population_age5group_medium",
        "WPP{rev}_PopulationByAge5GroupSex_Medium.csv.gz",
        30,
        "Population by five-year age group x sex, for the age/sex pyramid.",
    ),
)

# --------------------------------------------------------------------------
# World Bank Indicators API
# --------------------------------------------------------------------------

WORLD_BANK_BASE = "https://api.worldbank.org/v2"
WORLD_BANK_PER_PAGE = 20000        # one page per indicator for all countries
WORLD_BANK_START_YEAR = 1960


class Indicator(NamedTuple):
    code: str
    label: str
    section: str      # which country-page section it feeds
    unit: str


# Grouped by the country-page section they serve. Section keys follow the
# page layout as of 2026-08-23: economy, demographics, education, government,
# environment, technology, security, crime, healthcare, culture, freedom
# (education and crime split out of demographics/security 2026-08-23;
# freedom is fed by OWID below).
# Codes verified live against the World Bank catalogue -- see run.py.
WORLD_BANK_INDICATORS: tuple[Indicator, ...] = (
    # -- Economic Data -----------------------------------------------------
    Indicator("NY.GDP.MKTP.CD", "GDP (current US$)", "economy", "USD"),
    Indicator("NY.GDP.PCAP.PP.CD", "GDP per capita, PPP (current int'l $)", "economy", "USD_PPP"),
    Indicator("NY.GDP.MKTP.KD.ZG", "GDP growth (annual %)", "economy", "percent"),
    Indicator("NV.AGR.TOTL.ZS", "Agriculture, value added (% of GDP)", "economy", "percent"),
    Indicator("NV.IND.TOTL.ZS", "Industry, value added (% of GDP)", "economy", "percent"),
    Indicator("NV.SRV.TOTL.ZS", "Services, value added (% of GDP)", "economy", "percent"),
    Indicator("SL.UEM.TOTL.ZS", "Unemployment (% of labour force, ILO est.)", "economy", "percent"),
    Indicator("SI.POV.GINI", "Gini index", "economy", "index"),
    Indicator("SL.AGR.EMPL.ZS", "Employment in agriculture (% of employment)", "economy", "percent"),
    Indicator("SL.IND.EMPL.ZS", "Employment in industry (% of employment)", "economy", "percent"),
    Indicator("SL.SRV.EMPL.ZS", "Employment in services (% of employment)", "economy", "percent"),
    # Official exchange rate, annual average. No keyless source publishes live
    # FX, so the page shows this with its year rather than pretending to be a
    # currency converter.
    Indicator("PA.NUS.FCRF", "Official exchange rate (LCU per US$, period average)", "economy", "lcu_per_usd"),
    # -- Education (split out of demographics 2026-08-23) ------------------
    Indicator("SE.ADT.LITR.ZS", "Literacy rate, adult total (% 15+)", "education", "percent"),
    Indicator("SE.ADT.LITR.MA.ZS", "Literacy rate, adult male (% 15+)", "education", "percent"),
    Indicator("SE.ADT.LITR.FE.ZS", "Literacy rate, adult female (% 15+)", "education", "percent"),
    Indicator("SE.XPD.TOTL.GD.ZS", "Government expenditure on education (% of GDP)", "education", "percent"),
    Indicator("SE.PRM.ENRR", "School enrollment, primary (% gross)", "education", "percent"),
    Indicator("SE.PRM.NENR", "School enrollment, primary (% net)", "education", "percent"),
    Indicator("SE.SEC.ENRR", "School enrollment, secondary (% gross)", "education", "percent"),
    Indicator("SE.SEC.NENR", "School enrollment, secondary (% net)", "education", "percent"),
    Indicator("SE.TER.ENRR", "School enrollment, tertiary (% gross)", "education", "percent"),
    # -- Demographics and People -------------------------------------------
    Indicator("SP.URB.TOTL.IN.ZS", "Urban population (% of total)", "demographics", "percent"),
    Indicator("EN.POP.DNST", "Population density (people per sq km of land)", "demographics", "per_sqkm"),
    # -- Environment and Geography -----------------------------------------
    Indicator("AG.LND.TOTL.K2", "Land area (sq. km)", "environment", "sq_km"),
    Indicator("AG.LND.FRST.ZS", "Forest area (% of land area)", "environment", "percent"),
    Indicator("AG.LND.AGRI.ZS", "Agricultural land (% of land area)", "environment", "percent"),
    Indicator("EG.FEC.RNEW.ZS", "Renewable energy consumption (% of total final energy)", "environment", "percent"),
    # -- Government and Stability ------------------------------------------
    # NOTE (2026-08-15): the Worldwide Governance Indicators (PV.EST, GE.EST,
    # RL.EST, CC.EST) were tried first and REJECTED: the codes resolve in the
    # v2 /indicator catalogue but their data endpoint answers "deleted or
    # archived", and the WGI database (source=3) hangs outright -- the WB
    # migrated it off the v2 API. Governance measures come from V-Dem via
    # OWID instead; see OWID_INDICATORS below.
    # -- Technology and Infrastructure -------------------------------------
    Indicator("IT.NET.USER.ZS", "Individuals using the Internet (% of population)", "technology", "percent"),
    Indicator("IT.CEL.SETS.P2", "Mobile cellular subscriptions (per 100 people)", "technology", "per_100"),
    Indicator("EG.ELC.ACCS.ZS", "Access to electricity (% of population)", "technology", "percent"),
    # -- Security and Defense ----------------------------------------------
    Indicator("MS.MIL.XPND.GD.ZS", "Military expenditure (% of GDP)", "security", "percent"),
    Indicator("MS.MIL.TOTL.P1", "Armed forces personnel, total", "security", "count"),
    # -- Crime and Incarceration (split out of security 2026-08-23) --------
    Indicator("VC.IHR.PSRC.P5", "Intentional homicides (per 100,000 people)", "crime", "per_100k"),
    # -- Weather and Climate -----------------------------------------------
    # Long-run average precipitation. The World Bank stopped updating it after
    # 2022, but it is a climatological average, not a weather reading -- an
    # older vintage is still the right number to show.
    Indicator("AG.LND.PRCP.MM", "Average precipitation in depth (mm per year)", "weather", "mm_per_year"),
    # -- Healthcare and Public Health --------------------------------------
    Indicator("SP.DYN.LE00.IN", "Life expectancy at birth (years)", "healthcare", "years"),
    Indicator("SH.XPD.CHEX.GD.ZS", "Current health expenditure (% of GDP)", "healthcare", "percent"),
    Indicator("SH.DYN.MORT", "Under-5 mortality (per 1,000 live births)", "healthcare", "per_1000"),
    Indicator("SH.STA.MMRT", "Maternal mortality ratio (per 100,000 live births)", "healthcare", "per_100k"),
    Indicator("SH.MED.PHYS.ZS", "Physicians (per 1,000 people)", "healthcare", "per_1000"),
    Indicator("SH.MED.BEDS.ZS", "Hospital beds (per 1,000 people)", "healthcare", "per_1000"),
    Indicator("SH.IMM.MEAS", "Measles immunisation (% of children 12-23 months)", "healthcare", "percent"),
)

# --------------------------------------------------------------------------
# CIA World Factbook (factbook.json mirror)
# --------------------------------------------------------------------------

FACTBOOK_BASE = "https://raw.githubusercontent.com/factbook/factbook.json/master"
FACTBOOK_API_COMMITS = "https://api.github.com/repos/factbook/factbook.json/commits"

# Factbook groups countries into these region folders in the mirror. These are
# the mirror's own folder names, NOT our continent model -- the mapping from
# Factbook GEC code to our ISO3/continent is handled in crosswalk.py.
FACTBOOK_REGIONS: tuple[str, ...] = (
    "africa",
    "australia-oceania",
    "central-america-n-caribbean",
    "central-asia",
    "east-n-southeast-asia",
    "europe",
    "middle-east",
    "north-america",
    "south-america",
    "south-asia",
    "antarctica",
    "oceans",
    "world",
)

# --------------------------------------------------------------------------
# Country metadata
# --------------------------------------------------------------------------
#
# SOURCE SWITCH (2026-08-09): the brief specified REST Countries v3.1. That API
# is now DEPRECATED -- every v3.1 endpoint answers HTTP 200 with an error body
# directing callers to v5, and v5 requires an account plus a
# `Authorization: Bearer` key. A mandatory secret would break
# `python etl/run.py --refresh` on a fresh checkout, which is an explicit
# acceptance criterion, so v5 was rejected for the same reason as the UN Data
# Portal token.
#
# We use mledoze/countries instead: it is the upstream dataset REST Countries
# is BUILT from, so the field shape is effectively identical (name.common,
# name.official, cca2/cca3/ccn3, region, subregion, borders, area, capital,
# currencies, languages, unMember, independent). MIT licensed, static JSON on
# GitHub raw, no key, no rate limit. Verified 250 entities on 2026-08-09.
#
# Note the response is served with HTTP 200 whether healthy or not, so the
# ingest asserts on entity count and shape rather than trusting the status code.

COUNTRIES_DATASET_URL = (
    "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"
)
COUNTRIES_DATASET_REPO_API = (
    "https://api.github.com/repos/mledoze/countries/commits?path=countries.json&per_page=1"
)
COUNTRIES_DATASET_MIN_ENTITIES = 240

# Flag images are NOT in that dataset (it carries only the emoji). We key
# flagcdn by cca2 instead -- see FLAGCDN_SVG below.

# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------

# 110m for map rendering; 50m for the biome intersection math (10m is ~10x the
# size for a difference that vanishes after we normalise to percentages).
NATURAL_EARTH_TOPOJSON_110M = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json"
NATURAL_EARTH_ADMIN0_50M = (
    "https://naciscdn.org/naturalearth/50m/cultural/ne_50m_admin_0_countries.zip"
)
NATURAL_EARTH_ADMIN0_110M = (
    "https://naciscdn.org/naturalearth/110m/cultural/ne_110m_admin_0_countries.zip"
)

# RESOLVE Ecoregions 2017 (WWF terrestrial ecoregions lineage).
ECOREGIONS_URL = "https://storage.googleapis.com/teow2016/Ecoregions2017.zip"
# Geometry is simplified to this tolerance (in EQUAL_AREA_CRS metres) before
# the overlay, or the intersection is intractably slow.
#
# Set empirically, and the test mattered: small island territories come out of
# the overlay with very low ecoregion coverage (Maldives ~1%, Marshall Islands
# ~6%), which looks like simplification damage. It is not. Re-running at 250 m
# -- a 4x finer tolerance -- moved the failure count from 114 to 117 and the
# Maldives from 1.3% to 4.9%, i.e. nothing. RESOLVE Ecoregions simply does not
# resolve small oceanic islands. So we keep the coarser, faster tolerance and
# report the coverage gap honestly instead. See DATA_DECISIONS.md.
ECOREGION_SIMPLIFY_TOLERANCE_M = 1000

# --------------------------------------------------------------------------
# Our World in Data
# --------------------------------------------------------------------------
#
# Two distinct roles, deliberately kept separate:
#
# 1. POPULATION CROSS-CHECK (owid_crosscheck stage). OWID's modern population
#    series is itself UN WPP, so it can only validate our parsing, never the
#    estimates. It remains a cross-check and never feeds a rendered figure.
#
# 2. PRIMARY SOURCE for series no other keyless upstream carries
#    (owid_indicators stage, added 2026-08-15). The country pages' "Freedom"
#    section needs democracy and human-rights measures; V-Dem publishes them
#    but not as a stable no-auth API, and OWID redistributes them under
#    CC BY with clean ISO3 keys. Here OWID is the distribution channel and
#    the citation names the underlying producer (V-Dem etc.).

OWID_POPULATION_CSV = "https://ourworldindata.org/grapher/population.csv"

OWID_GRAPHER_CSV = "https://ourworldindata.org/grapher/{slug}.csv"
OWID_GRAPHER_METADATA = "https://ourworldindata.org/grapher/{slug}.metadata.json"

# Democracy-index series start in 1789; the Freedom section's trend does not
# need the age of sail, and trimming keeps 250 committed artifacts lean.
OWID_START_YEAR = 1900


class OwidIndicator(NamedTuple):
    slug: str         # ourworldindata.org/grapher/<slug>
    code: str         # stable key in our artifacts (never the slug, which OWID may rename)
    label: str
    section: str      # which country-page section it feeds
    unit: str
    kind: str         # "number" | "category"


OWID_INDICATORS: tuple[OwidIndicator, ...] = (
    # -- Freedom -----------------------------------------------------------
    OwidIndicator("electoral-democracy-index", "owid.vdem.electdem",
                  "Electoral democracy index", "freedom", "index_0_1", "number"),
    OwidIndicator("liberal-democracy-index", "owid.vdem.libdem",
                  "Liberal democracy index", "freedom", "index_0_1", "number"),
    OwidIndicator("human-rights-index-vdem", "owid.vdem.rights",
                  "Human rights index", "freedom", "index_0_1", "number"),
    OwidIndicator("political-regime", "owid.row.regime",
                  "Political regime (Regimes of the World)", "freedom",
                  "category", "category"),
    # -- Government and Stability ------------------------------------------
    # Replaces the archived World Bank WGI codes -- see the note above
    # WORLD_BANK_INDICATORS. Mind the direction of the corruption index:
    # HIGHER means MORE corruption, the opposite of WGI's "control of
    # corruption", and the page must say so.
    OwidIndicator("political-corruption-index", "owid.vdem.corruption",
                  "Political corruption index", "government",
                  "index_0_1", "number"),
    OwidIndicator("rule-of-law-index", "owid.vdem.ruleoflaw",
                  "Rule of law index", "government", "index_0_1", "number"),
    OwidIndicator("state-capacity-index", "owid.hanson.statecap",
                  "State capacity index", "government", "score", "number"),
    # -- Environment -------------------------------------------------------
    OwidIndicator("co-emissions-per-capita", "owid.co2.percapita",
                  "CO₂ emissions per capita", "environment",
                  "t_per_person", "number"),
    # -- Crime and Incarceration (added 2026-08-23) ------------------------
    # Producer is the Institute for Crime & Justice Policy Research (the
    # World Prison Brief compilers); WPB itself publishes no bulk endpoint,
    # so OWID is the distribution channel, same doctrine as V-Dem above.
    OwidIndicator("prison-population-rate", "owid.wpb.prisonrate",
                  "Prison population rate", "crime", "per_100k", "number"),
    OwidIndicator("prison-capacity", "owid.wpb.occupancy",
                  "Prison occupancy level", "crime", "percent", "number"),
)

# Regimes of the World categories, as encoded in the political-regime series.
OWID_REGIME_LABELS: dict[int, str] = {
    0: "Closed autocracy",
    1: "Electoral autocracy",
    2: "Electoral democracy",
    3: "Liberal democracy",
}

# --------------------------------------------------------------------------
# Heads of state and government (Wikidata + Wikimedia Commons)
# --------------------------------------------------------------------------
#
# The Factbook names office-holders but ships no photographs. Wikidata's
# truthy P35 (head of state) / P6 (head of government) statements provide the
# incumbent and a Commons portrait (P18), keyless via the public SPARQL
# endpoint. A photo is committed ONLY when the country has exactly one truthy
# holder for the role -- collective heads (Bosnia's presidency, San Marino's
# captains regent, the Swiss federal council) get no photo rather than a
# misleading single face. Portraits are Commons thumbnails; the app links
# each to its Commons file page for author and licence attribution.

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
WIKIDATA_LEADERS_QUERY = """
SELECT ?iso3 ?role ?person ?personLabel ?image WHERE {
  ?country wdt:P298 ?iso3 .
  {
    ?country wdt:P35 ?person . BIND("hos" AS ?role)
  } UNION {
    ?country wdt:P6 ?person . BIND("hog" AS ?role)
  }
  OPTIONAL { ?person wdt:P18 ?image . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
"""
LEADER_IMAGE_WIDTH = 384  # px; displayed small, sharp on 2-4x screens

# --------------------------------------------------------------------------
# UNESCO World Heritage List
# --------------------------------------------------------------------------
#
# The official syndication feed: every inscribed property with category,
# inscription year, and ISO2 state codes (comma-separated for transboundary
# sites). Keyless — but fronted by a WAF that answers 403 to non-browser user
# agents, including our honest ETL UA. The feed exists explicitly for reuse
# (whc.unesco.org/en/syndication), so the fetch identifies as a browser for
# this one source. If UNESCO ever gates it properly, the stage fails loudly.

WHC_LIST_XML = "https://whc.unesco.org/en/list/xml"
WHC_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

# --------------------------------------------------------------------------
# Flags
# --------------------------------------------------------------------------

FLAGCDN_SVG = "https://flagcdn.com/{cca2_lower}.svg"
FLAG_RASTER_WIDTH = 160

# OKLCH clamp band for map fills. Chosen so every country fill sits in one
# coherent lightness/chroma band and the map reads as a system rather than a
# jumble -- only hue varies. Verified for WCAG AA against both themes in
# scripts/extract-flag-colors.mjs.
MAP_FILL_OKLCH = {
    "light": {"l": 0.86, "c": 0.055},
    "dark": {"l": 0.42, "c": 0.070},
}
# Bordering countries must differ by at least this much hue (degrees).
MAP_HUE_MIN_SEPARATION_DEG = 12.0
MAP_HUE_NUDGE_TOLERANCE_DEG = 18.0

# --------------------------------------------------------------------------
# RSF World Press Freedom Index  (added 2026-08-23)
# --------------------------------------------------------------------------
#
# RSF publishes the full index as a semicolon-delimited CSV at a stable
# year-keyed URL (verified live for 2024/2025/2026). Quirks, all verified:
# windows-1252 encoding, decimal commas, ISO3 in the `ISO` column, 180
# countries. A new edition lands around May, so the stage probes the current
# year first and falls back. RSF's CDN rejects unfamiliar user agents, so
# this source fetches with the browser UA (same ruling as UNESCO, §WHC).

RSF_CSV_TEMPLATE = "https://rsf.org/sites/default/files/import_classement/{year}.csv"
RSF_PROBE_YEARS_BACK = 3

# --------------------------------------------------------------------------
# UNODC prisons data  (added 2026-08-23)
# --------------------------------------------------------------------------
#
# dataUNODC ships the full "prisons and prisoners" table as one keyless xlsx,
# but the file URL carries a release-dated path (/files/2026-07/...) that
# changes every update -- so the stage scrapes the CURRENT href from the
# stable landing page rather than pinning a URL that will silently go stale.

UNODC_PRISON_LANDING = "https://data.unodc.org/datareport/prison-held"
UNODC_PRISON_XLSX_RE = r'href="([^"]*data_cts_prisons_and_prisoners\.xlsx)"'

# --------------------------------------------------------------------------
# Death penalty status (Wikipedia)  (added 2026-08-23)
# --------------------------------------------------------------------------
#
# Amnesty International is the primary compiler but publishes only PDFs; no
# keyless machine-readable source exists (checked OWID, Wikidata, UNODC).
# Wikipedia's "Capital punishment by country" tables carry per-country status
# (A abolished / L abolitionist in practice / E exceptional crimes only /
# P retains), last-execution year and latest-year execution figures, under
# CC BY-SA 4.0. Parsed from the REST HTML endpoint.

WIKIPEDIA_CAPITAL_PUNISHMENT_URL = (
    "https://en.wikipedia.org/api/rest_v1/page/html/Capital_punishment_by_country"
)
DEATH_PENALTY_STATUS_LABELS: dict[str, str] = {
    "A": "Abolished for all crimes",
    "E": "Abolished except exceptional circumstances",
    "L": "Abolitionist in practice (retains, no recent executions)",
    "P": "Retains the death penalty",
}

# --------------------------------------------------------------------------
# Education extras  (added 2026-08-23)
# --------------------------------------------------------------------------
#
# University counts: Hipolabs' university-domains list (MIT licensed, keyed by
# ISO2). It counts institutions with web domains, so it UNDERCOUNTS and the
# page must label it as such. Public library counts: Wikidata (IFLA's Library
# Map has no keyless endpoint -- Cloudflare-gated); Wikidata coverage is
# uneven, so the label says "recorded in Wikidata". Top universities: CWUR's
# ranking page carries a National Rank column for ~2,000 institutions in ~90
# countries; © CWUR, displayed with attribution.

HIPOLABS_UNIVERSITIES_URL = (
    "https://raw.githubusercontent.com/Hipo/university-domains-list/master/"
    "world_universities_and_domains.json"
)
CWUR_RANKING_TEMPLATE = "https://cwur.org/{year}.php"
CWUR_PROBE_YEARS_BACK = 3
CWUR_TOP_N = 10

WIKIDATA_PUBLIC_LIBRARIES_QUERY = """
SELECT ?iso3 (COUNT(DISTINCT ?lib) AS ?libraries) WHERE {
  ?lib wdt:P31/wdt:P279* wd:Q28564 .
  ?lib wdt:P17 ?country .
  ?country wdt:P298 ?iso3 .
}
GROUP BY ?iso3
"""

# --------------------------------------------------------------------------
# IMF World Economic Outlook (DataMapper API)  (added 2026-08-23)
# --------------------------------------------------------------------------
#
# Keyless JSON keyed by ISO3, with ~5 years of projections past the current
# year. NOT CORS-enabled, so it is strictly a build-time source; the app
# interpolates between annual values the same way the population counter
# does, and labels the result as a modelled estimate.

IMF_DATAMAPPER_TEMPLATE = "https://www.imf.org/external/datamapper/api/v1/{code}"
IMF_DEBT_PCT_GDP = "GGXWDG_NGDP"     # general government gross debt, % of GDP
IMF_GDP_USD_BILLIONS = "NGDPD"       # GDP, current prices, US$ billions
IMF_AGGREGATE_KEYS = {
    "ADVEC", "DA", "OEMDC", "EURO", "EU", "WE", "MECA", "WEOWORLD",
}

# --------------------------------------------------------------------------
# Currency images (Wikidata + Wikimedia Commons)  (added 2026-08-23)
# --------------------------------------------------------------------------
#
# country -> currency (P38) -> ISO 4217 code (P498) + image (P18). The P18
# image is a REPRESENTATIVE specimen -- for some currencies Commons holds a
# coin or a historical note, and no property orders denominations, so the
# page must caption it honestly rather than promising "the smallest bill".
# Editorial overrides in reference/currency_image_overrides.json take
# precedence per ISO 4217 code. Images are hotlinked via Special:Redirect at
# a Commons-bucketed width (arbitrary widths now answer HTTP 400), with
# per-file licence/author pulled from the Commons API for attribution.

WIKIDATA_CURRENCY_IMAGES_QUERY = """
SELECT DISTINCT ?iso3 ?code ?image ?currencyLabel WHERE {
  ?country wdt:P298 ?iso3 .
  ?country wdt:P38 ?currency .
  OPTIONAL { ?currency wdt:P498 ?code . }
  OPTIONAL { ?currency wdt:P18 ?image . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
"""
COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php"
COMMONS_IMAGE_WIDTH = 960  # bucketed width accepted by upload.wikimedia.org

# --------------------------------------------------------------------------
# First-level administrative subdivisions (Wikidata)  (added 2026-08-23)
# --------------------------------------------------------------------------
#
# One query for every country: P150 (contains administrative territorial
# entity) with truthy rank, excluding items typed as FORMER administrative
# entities (Q19953632) -- the filter that stops India returning Daman and Diu.
# Populations are truthy P1082 (preferred rank, usually the latest census or
# estimate). Coverage and typing are only as good as Wikidata; the page
# labels the source and the residual risk of the odd duplicate.

WIKIDATA_SUBDIVISIONS_QUERY = """
SELECT ?iso3 ?division ?divisionLabel ?population WHERE {
  ?country wdt:P298 ?iso3 .
  ?country wdt:P150 ?division .
  FILTER NOT EXISTS { ?division wdt:P31 wd:Q19953632 }
  OPTIONAL { ?division wdt:P1082 ?population . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
"""

# --------------------------------------------------------------------------
# Climate  (added 2026-08-23)
# --------------------------------------------------------------------------
#
# Annual mean surface temperature per country: OWID's redistribution of
# Copernicus ERA5 (1940 onward), which is what makes a 50-year warming
# figure computable. The comparison is decade mean vs decade mean -- single
# years are weather, not climate. Capitals (for the live weather panel) come
# from GeoNames' cities15000 dump, feature code PPLC.

OWID_SURFACE_TEMPERATURE_SLUG = "average-annual-surface-temperature"
CLIMATE_BASELINE_DECADE = (1971, 1980)
CLIMATE_RECENT_DECADE = (2016, 2025)
GEONAMES_CITIES15000_URL = "https://download.geonames.org/export/dump/cities15000.zip"

# --------------------------------------------------------------------------
# Notable inventions (Wikidata)  (added 2026-08-24)
# --------------------------------------------------------------------------
#
# Items carrying an inventor (P61) or a time of discovery/invention (P575)
# plus a country of origin (P495), ranked by sitelink count as the
# notability proxy. Verified coverage: ~57 countries clear the sitelink
# floor -- Wikidata simply has no tagged notable inventions for most
# countries, and the section renders that honestly rather than padding.

WIKIDATA_INVENTIONS_QUERY = """
SELECT ?iso3 ?item ?itemLabel ?inventorLabel ?invented ?inception ?image ?links WHERE {
  ?item wdt:P495 ?country .
  ?country wdt:P298 ?iso3 .
  ?item wikibase:sitelinks ?links .
  FILTER(?links >= 5)
  { ?item wdt:P61 ?inventorAnchor . } UNION { ?item wdt:P575 ?dateAnchor . }
  OPTIONAL { ?item wdt:P61 ?inventor . }
  OPTIONAL { ?item wdt:P575 ?invented . }
  OPTIONAL { ?item wdt:P571 ?inception . }
  OPTIONAL { ?item wdt:P18 ?image . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
"""
INVENTIONS_TOP_N = 10

# --------------------------------------------------------------------------
# Airports (OurAirports + Wikidata patronage)  (added 2026-08-24)
# --------------------------------------------------------------------------
#
# OurAirports (public domain) supplies the airport roster -- large airports
# plus medium airports with scheduled service, ISO2-keyed. It carries no
# traffic figures, so annual passenger counts join from Wikidata (P3872
# patronage, ~4,500 IATA codes) and rank the list; airports without a
# figure sort below those with one, largest class first. "Top 20 by flight
# volume" is therefore approximated by best-available passenger data, and
# the page says so.

OURAIRPORTS_CSV_URL = (
    "https://davidmegginson.github.io/ourairports-data/airports.csv"
)
WIKIDATA_AIRPORT_PATRONAGE_QUERY = """
SELECT ?iata (MAX(?value) AS ?patronage) WHERE {
  ?airport wdt:P238 ?iata .
  ?airport p:P3872/ps:P3872 ?value .
}
GROUP BY ?iata
"""
AIRPORTS_TOP_N = 20

# --------------------------------------------------------------------------
# Flora and fauna (Wikipedia national-symbol lists)  (added 2026-08-24)
# --------------------------------------------------------------------------
#
# No Wikidata property reliably links a country to its national animal,
# tree, or flower; the English Wikipedia list articles are the maintained
# compilations (CC BY-SA 4.0, attributed). Animals and trees are wikitables
# (rowspan-aware parse); the flowers article is prose sections per country.
# Images come from the tables' own picture cells where present, otherwise
# from the linked article's lead image, always resolved to the ORIGINAL
# Commons file so licence and author can ride along.

WIKIPEDIA_NATIONAL_ANIMALS_URL = (
    "https://en.wikipedia.org/api/rest_v1/page/html/List_of_national_animals"
)
WIKIPEDIA_NATIONAL_TREES_URL = (
    "https://en.wikipedia.org/api/rest_v1/page/html/List_of_national_trees"
)
WIKIPEDIA_NATIONAL_FLOWERS_URL = (
    "https://en.wikipedia.org/api/rest_v1/page/html/List_of_national_flowers"
)
WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php"

# --------------------------------------------------------------------------
# National cuisine (Wikidata)  (added 2026-08-24)
# --------------------------------------------------------------------------
#
# Dishes and food types with a country of origin (P495), ranked by sitelink
# count. The class list is a VALUES enumeration because the full Q746549
# subclass closure times the query out. Verified coverage: ~113 countries.

# One query PER CLASS, not a VALUES union: the combined query answers 504
# under load, and a 504 (unlike 429/503) is not retried by fetch().
WIKIDATA_CUISINE_CLASSES: tuple[str, ...] = (
    "Q746549",    # dish
    "Q19861951",  # type of food or dish
    "Q28803",     # food
    "Q40050",     # drink
)
WIKIDATA_CUISINE_QUERY_TEMPLATE = """
SELECT ?iso3 ?item ?itemLabel ?image ?links WHERE {{
  ?item wdt:P31 wd:{qid} .
  ?item wdt:P495 ?country .
  ?country wdt:P298 ?iso3 .
  ?item wikibase:sitelinks ?links .
  FILTER(?links >= 5)
  OPTIONAL {{ ?item wdt:P18 ?image . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
"""
CUISINE_TOP_N = 8

# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

USER_AGENT = (
    "global-population-dashboard/0.1 (ETL; contact: repository owner) "
    "python-requests"
)
HTTP_TIMEOUT_SECONDS = 120
HTTP_MAX_RETRIES = 4
HTTP_BACKOFF_SECONDS = 2.0
