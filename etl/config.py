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
    description: str


# Medium variant is the headline series; low/high are kept for the projection
# bands on the trend charts, per the brief.
WPP_FILES: tuple[WppFile, ...] = (
    WppFile(
        "demographic_indicators_medium",
        "WPP{rev}_Demographic_Indicators_Medium.csv.gz",
        "Totals, growth rate, TFR, CBR, CDR, net migration, median age, "
        "life expectancy. Estimates 1950-2023 + medium projection 2024-2100.",
    ),
    WppFile(
        "demographic_indicators_other",
        "WPP{rev}_Demographic_Indicators_OtherVariants.csv.gz",
        "Low / high / constant-fertility variants, for projection bands.",
    ),
    WppFile(
        "population_by_age_sex_medium",
        "WPP{rev}_PopulationBySingleAgeSex_Medium_1950-2100.csv.gz",
        "Single-year age x sex population, for the age/sex pyramid.",
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


# Grouped by the country-page section they serve (brief section 5).
# Codes verified live against the World Bank catalogue -- see run.py.
WORLD_BANK_INDICATORS: tuple[Indicator, ...] = (
    # -- Economy -----------------------------------------------------------
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
    # -- Education ---------------------------------------------------------
    Indicator("SE.ADT.LITR.ZS", "Literacy rate, adult total (% 15+)", "education", "percent"),
    Indicator("SE.ADT.LITR.MA.ZS", "Literacy rate, adult male (% 15+)", "education", "percent"),
    Indicator("SE.ADT.LITR.FE.ZS", "Literacy rate, adult female (% 15+)", "education", "percent"),
    Indicator("SE.XPD.TOTL.GD.ZS", "Government expenditure on education (% of GDP)", "education", "percent"),
    Indicator("SE.PRM.ENRR", "School enrolment, primary (% gross)", "education", "percent"),
    Indicator("SE.SEC.ENRR", "School enrolment, secondary (% gross)", "education", "percent"),
    Indicator("SE.TER.ENRR", "School enrolment, tertiary (% gross)", "education", "percent"),
    # -- Population / urbanisation ----------------------------------------
    Indicator("SP.URB.TOTL.IN.ZS", "Urban population (% of total)", "population", "percent"),
    Indicator("EN.POP.DNST", "Population density (people per sq km of land)", "population", "per_sqkm"),
    # -- Land --------------------------------------------------------------
    Indicator("AG.LND.TOTL.K2", "Land area (sq. km)", "land", "sq_km"),
    Indicator("AG.LND.FRST.ZS", "Forest area (% of land area)", "land", "percent"),
    Indicator("AG.LND.AGRI.ZS", "Agricultural land (% of land area)", "land", "percent"),
    # -- Health ------------------------------------------------------------
    Indicator("SP.DYN.LE00.IN", "Life expectancy at birth (years)", "health", "years"),
    Indicator("SH.XPD.CHEX.GD.ZS", "Current health expenditure (% of GDP)", "health", "percent"),
    Indicator("SH.DYN.MORT", "Under-5 mortality (per 1,000 live births)", "health", "per_1000"),
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
ECOREGION_SIMPLIFY_TOLERANCE_M = 1000

# --------------------------------------------------------------------------
# Our World in Data (cross-check only, never a primary source)
# --------------------------------------------------------------------------

OWID_POPULATION_CSV = "https://ourworldindata.org/grapher/population.csv"

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
# HTTP
# --------------------------------------------------------------------------

USER_AGENT = (
    "global-population-dashboard/0.1 (ETL; contact: repository owner) "
    "python-requests"
)
HTTP_TIMEOUT_SECONDS = 120
HTTP_MAX_RETRIES = 4
HTTP_BACKOFF_SECONDS = 2.0
