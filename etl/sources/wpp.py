"""UN World Population Prospects 2024 ingestion.

The spine of the project. Everything population-related traces here.

UNITS -- read this before touching the numbers
---------------------------------------------
WPP publishes counts in THOUSANDS (TPopulation1July for the World in 2023 is
8091734.93, i.e. 8.09 billion people). We convert counts to PERSONS on the way
out so nothing downstream has to remember the factor. Rates are published in
their natural units and pass through untouched:

    counts (population, births, deaths, migrations)  thousands -> persons
    PopDensity                                       persons / km2  (as-is)
    PopGrowthRate                                    percent        (as-is)
    CBR / CDR / CNMR                                 per 1,000      (as-is)
    TFR                                              births / woman (as-is)
    MedianAgePop / LEx                               years          (as-is)
    IMR / Q5                                         per 1,000      (as-is)

ESTIMATES vs PROJECTIONS
------------------------
The medium-variant file contains both in one series. WPP 2024 carries
estimates through 2023 and projections from 2024 to 2100; the boundary is
`revision - 1`. Charts must render the projection segment distinctly, so the
boundary year is written into every artifact rather than left implicit.

OUTPUT SHAPE
------------
Deliberately split so the map does not pay for detail it does not show --
"initial map interaction stays responsive" is an acceptance criterion:

    data/population/summary.json          one row per entity, current year
    data/population/series/<ISO3>.json    full 1950-2100 series, lazy-loaded
    data/population/pyramids/<ISO3>.json  age x sex, every 5th year
"""

from __future__ import annotations

import gzip
import json
from typing import Any, Iterator

import pandas as pd

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch

# Columns we lift from the demographic indicators file, and the artifact key
# each becomes. Anything not listed here is deliberately dropped.
INDICATOR_COLUMNS: dict[str, str] = {
    "TPopulation1July": "population",
    "TPopulationMale1July": "populationMale",
    "TPopulationFemale1July": "populationFemale",
    "PopDensity": "density",
    "PopGrowthRate": "growthRate",
    "PopSexRatio": "sexRatio",
    "MedianAgePop": "medianAge",
    "NatChange": "naturalChange",
    "Births": "births",
    "Deaths": "deaths",
    "NetMigrations": "netMigration",
    "CBR": "birthRate",
    "CDR": "deathRate",
    "CNMR": "netMigrationRate",
    "TFR": "fertilityRate",
    "LEx": "lifeExpectancy",
    "LExMale": "lifeExpectancyMale",
    "LExFemale": "lifeExpectancyFemale",
    "IMR": "infantMortalityRate",
    "Q5": "under5MortalityRate",
}

# Counts published in thousands -> multiplied to persons on output.
COUNT_KEYS: frozenset[str] = frozenset({
    "population", "populationMale", "populationFemale",
    "naturalChange", "births", "deaths", "netMigration",
})

UNITS: dict[str, str] = {
    "population": "persons",
    "populationMale": "persons",
    "populationFemale": "persons",
    "density": "persons per sq km",
    "growthRate": "percent per year",
    "sexRatio": "males per 100 females",
    "medianAge": "years",
    "naturalChange": "persons per year",
    "births": "persons per year",
    "deaths": "persons per year",
    "netMigration": "persons per year",
    "birthRate": "per 1,000 population",
    "deathRate": "per 1,000 population",
    "netMigrationRate": "per 1,000 population",
    "fertilityRate": "live births per woman",
    "lifeExpectancy": "years",
    "lifeExpectancyMale": "years",
    "lifeExpectancyFemale": "years",
    "infantMortalityRate": "per 1,000 live births",
    "under5MortalityRate": "per 1,000 live births",
}

# Pyramids are emitted every Nth year rather than annually: 151 annual frames
# per country would be ~30x the payload for a chart nobody scrubs annually.
PYRAMID_YEAR_STEP = 5

# Projection variants kept for the trend-chart bands.
BAND_VARIANTS: dict[str, str] = {"Low": "low", "High": "high"}

MAX_YEAR = 2100  # the file carries stray 2101 rows for aggregates, all NaN


def _read_gzip_csv(response: CachedResponse, **kwargs: Any) -> pd.DataFrame:
    with gzip.open(response.path, "rt", encoding="utf-8-sig") as handle:
        return pd.read_csv(handle, low_memory=False, **kwargs)


def _iter_gzip_csv(
    response: CachedResponse, chunksize: int, **kwargs: Any
) -> Iterator[pd.DataFrame]:
    with gzip.open(response.path, "rt", encoding="utf-8-sig") as handle:
        yield from pd.read_csv(
            handle, low_memory=False, chunksize=chunksize, **kwargs
        )


def discover_revision() -> int:
    """Newest published WPP revision. See run.discover_wpp_revision."""
    from ..run import discover_wpp_revision

    return discover_wpp_revision()


def _clean(value: Any) -> float | None:
    """NaN -> None so it serialises as JSON null, not the invalid token NaN.

    Null here means "not published by the UN for this entity/year" and MUST
    render as an explicit unavailable state, never as zero.
    """
    if value is None or pd.isna(value):
        return None
    return round(float(value), 6)


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
    revision: int | None = None,
) -> None:
    revision = revision or discover_revision()
    estimates_through = revision - 1

    out_dir = config.DATA_DIR / "population"
    series_dir = out_dir / "series"
    pyramid_dir = out_dir / "pyramids"
    for directory in (out_dir, series_dir, pyramid_dir):
        directory.mkdir(parents=True, exist_ok=True)

    responses: list[CachedResponse] = []

    # ---- medium variant: the headline series ----------------------------
    medium_name = f"WPP{revision}_Demographic_Indicators_Medium.csv.gz"
    medium = fetch(
        f"{config.WPP_CSV_BASE}/{medium_name}",
        refresh=refresh,
        subdir="wpp",
        filename="demographic_indicators_medium.csv.gz",
    )
    responses.append(medium)

    frame = _read_gzip_csv(
        medium,
        usecols=["ISO3_code", "LocTypeName", "Location", "Time",
                 *INDICATOR_COLUMNS],
    )
    frame = frame[
        (frame["LocTypeName"] == "Country/Area")
        & frame["ISO3_code"].notna()
        & (frame["Time"] <= MAX_YEAR)
    ]
    if frame.empty:
        raise FetchError(
            f"{medium_name} yielded no Country/Area rows. The UN may have "
            f"changed the LocTypeName vocabulary; inspect {medium.path}."
        )

    frame = frame.rename(columns=INDICATOR_COLUMNS)
    frame["ISO3_code"] = frame["ISO3_code"].str.upper()

    known = set(registry)
    present = set(frame["ISO3_code"].unique())
    unknown = sorted(present - known)
    if unknown:
        raise FetchError(
            f"WPP publishes ISO3 codes absent from the registry: "
            f"{', '.join(unknown)}. Add them to the crosswalk rather than "
            f"dropping the data."
        )

    # ---- low/high variants for the projection bands ---------------------
    bands = _load_variant_bands(revision, refresh=refresh, responses=responses)

    # ---- per-country series ---------------------------------------------
    latest_year = int(frame["Time"].max())
    current_year = _current_estimate_year(frame, estimates_through)

    summary_rows: list[dict[str, Any]] = []
    written = 0

    for iso3, group in frame.groupby("ISO3_code", sort=True):
        entity = registry[iso3]
        group = group.sort_values("Time")
        years = [int(y) for y in group["Time"]]

        series: dict[str, list[float | None]] = {}
        for key in INDICATOR_COLUMNS.values():
            column = group[key]
            if key in COUNT_KEYS:
                values = [
                    None if v is None else v * 1000.0
                    for v in (_clean(x) for x in column)
                ]
            else:
                values = [_clean(x) for x in column]
            series[key] = values

        document: dict[str, Any] = {
            "iso3": iso3,
            "name": entity.name_common,
            "wppLocationName": str(group["Location"].iloc[0]),
            "source": "un_wpp",
            "revision": revision,
            "variant": "medium",
            "estimatesThrough": estimates_through,
            "units": UNITS,
            "years": years,
            "series": series,
        }
        if iso3 in bands:
            document["bands"] = bands[iso3]

        (series_dir / f"{iso3}.json").write_text(
            json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )
        written += 1

        summary_rows.append(_summary_row(iso3, entity, group, current_year))

    # ---- entities with no WPP coverage ----------------------------------
    uncovered = sorted(known - present)
    for iso3 in uncovered:
        entity = registry[iso3]
        summary_rows.append({
            "iso3": iso3,
            "name": entity.name_common,
            "continent": entity.continent,
            "year": current_year,
            "available": False,
            "unavailableReason": (
                f"UN World Population Prospects {revision} publishes no "
                f"separate series for {entity.name_common}."
            ),
        })

    summary = {
        "source": "un_wpp",
        "revision": revision,
        "variant": "medium",
        "year": current_year,
        "estimatesThrough": estimates_through,
        "latestProjectionYear": latest_year,
        "units": UNITS,
        "entities": sorted(summary_rows, key=lambda row: row["iso3"]),
    }
    (out_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    # ---- timeline, for the time scrubber ---------------------------------
    # A compact year-by-year matrix, lazy-loaded by the app only when the
    # scrubber is used. Values are kept in THOUSANDS (WPP's own publication
    # precision), which roughly halves the payload and loses nothing.
    timeline_years = sorted({int(y) for y in frame["Time"].unique()})
    year_index = {year: i for i, year in enumerate(timeline_years)}

    timeline_entities: dict[str, list[int | None]] = {}
    world_totals = [0.0] * len(timeline_years)
    world_counts = [0] * len(timeline_years)
    continent_totals: dict[str, list[float]] = {}
    # World component flows, summed from countries. Net migration sums to
    # ~zero globally by construction, which is itself a useful check.
    world_components: dict[str, list[float]] = {
        key: [0.0] * len(timeline_years)
        for key in ("births", "deaths", "netMigration")
    }

    for iso3, group in frame.groupby("ISO3_code", sort=True):
        row: list[int | None] = [None] * len(timeline_years)
        continent = registry[iso3].continent
        bucket = continent_totals.setdefault(
            continent, [0.0] * len(timeline_years)
        )
        for record in group.itertuples(index=False):
            slot = year_index[int(record.Time)]
            for key in world_components:
                component = _clean(getattr(record, key, None))
                if component is not None:
                    world_components[key][slot] += component
            value = _clean(record.population)
            if value is None:
                continue
            row[slot] = int(round(value))          # thousands
            world_totals[slot] += value
            world_counts[slot] += 1
            bucket[slot] += value
        timeline_entities[iso3] = row

    timeline = {
        "note": (
            "Population by year in THOUSANDS, the publication precision of "
            "UN WPP. Multiply by 1000 for persons. Loaded on demand by the "
            "time scrubber, not on first paint."
        ),
        "source": "un_wpp",
        "revision": revision,
        "variant": "medium",
        "unit": "thousands of persons",
        "estimatesThrough": estimates_through,
        "years": timeline_years,
        "world": [int(round(v)) for v in world_totals],
        "worldEntityCount": world_counts,
        "worldComponents": {
            key: [int(round(v)) for v in values]
            for key, values in world_components.items()
        },
        "continents": {
            key: [int(round(v)) for v in values]
            for key, values in sorted(continent_totals.items())
        },
        "entities": timeline_entities,
    }
    (out_dir / "timeline.json").write_text(
        json.dumps(timeline, separators=(",", ":")) + "\n",
        encoding="utf-8", newline="\n",
    )

    # ---- age/sex pyramids -----------------------------------------------
    pyramid_count = _write_pyramids(
        registry, revision, refresh=refresh, out_dir=pyramid_dir,
        responses=responses,
    )

    # ---- provenance ------------------------------------------------------
    manifest_mod.record_source(
        manifest,
        "un_wpp",
        title=f"UN World Population Prospects {revision}",
        url="https://population.un.org/wpp/",
        licence="CC BY 3.0 IGO",
        fetched_at=max(r.fetched_at for r in responses),
        upstream_release=responses[0].upstream_release,
        vintage=f"estimates 1950-{estimates_through}; "
                f"projections {revision}-{latest_year}",
        citation=(
            f"United Nations, Department of Economic and Social Affairs, "
            f"Population Division ({revision}). World Population Prospects "
            f"{revision}, Online Edition. Medium variant."
        ),
        files=[
            {"url": r.url, "sha256": r.sha256, "size_bytes": r.size_bytes,
             "fetched_at": r.fetched_at}
            for r in responses
        ],
        notes=(
            f"Counts converted from the published thousands to persons. "
            f"Estimates run through {estimates_through}; later years are the "
            f"medium-variant projection, with low/high variants supplied as "
            f"bands. Bulk CSV rather than the Data Portal API, which requires "
            f"a token (see DATA_DECISIONS.md)."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "population/summary.json",
        description=f"Per-entity population snapshot for {current_year}.",
        sources=["un_wpp"], entity_count=len(summary_rows),
    )
    manifest_mod.record_artifact(
        manifest, "population/series/<ISO3>.json",
        description=(
            f"Full {min(frame['Time'])}-{latest_year} demographic series per "
            f"entity, medium variant with low/high projection bands."
        ),
        sources=["un_wpp"], entity_count=written,
    )
    manifest_mod.record_artifact(
        manifest, "population/timeline.json",
        description=(
            "Population by year for every entity, continent and the world, in "
            "thousands. Feeds the time scrubber; lazy-loaded."
        ),
        sources=["un_wpp"], entity_count=len(timeline_entities),
    )
    manifest_mod.record_artifact(
        manifest, "population/pyramids/<ISO3>.json",
        description=(
            f"Age x sex population by five-year age group, every "
            f"{PYRAMID_YEAR_STEP}th year."
        ),
        sources=["un_wpp"], entity_count=pyramid_count,
    )

    if uncovered:
        manifest_mod.add_warning(
            manifest,
            f"UN WPP {revision} publishes no population series for "
            f"{len(uncovered)} registry entities "
            f"({', '.join(uncovered)}); these render as unavailable rather "
            f"than zero. Most are uninhabited territories, but Aland Islands "
            f"and Svalbard are inhabited and are reported within Finland and "
            f"Norway respectively."
        )

    print(f"    wrote {written} country series, {pyramid_count} pyramids, "
          f"{len(uncovered)} uncovered entities")


def _current_estimate_year(frame: pd.DataFrame, estimates_through: int) -> int:
    """The most recent year that is an estimate rather than a projection."""
    available = {int(y) for y in frame["Time"].unique()}
    return estimates_through if estimates_through in available else max(available)


def _summary_row(
    iso3: str, entity: Entity, group: pd.DataFrame, year: int
) -> dict[str, Any]:
    row = group[group["Time"] == year]
    if row.empty:
        return {
            "iso3": iso3,
            "name": entity.name_common,
            "continent": entity.continent,
            "year": year,
            "available": False,
            "unavailableReason": f"No UN WPP observation for {year}.",
        }
    record = row.iloc[0]
    population = _clean(record["population"])
    births = _clean(record["births"])
    deaths = _clean(record["deaths"])
    migration = _clean(record["netMigration"])
    return {
        "iso3": iso3,
        "name": entity.name_common,
        "continent": entity.continent,
        "year": year,
        "available": population is not None,
        "population": None if population is None else population * 1000.0,
        "growthRate": _clean(record["growthRate"]),
        "density": _clean(record["density"]),
        "medianAge": _clean(record["medianAge"]),
        "fertilityRate": _clean(record["fertilityRate"]),
        "lifeExpectancy": _clean(record["lifeExpectancy"]),
        # Per-year component flows, used by the Phase 7 interpolating counter.
        "births": None if births is None else births * 1000.0,
        "deaths": None if deaths is None else deaths * 1000.0,
        "netMigration": None if migration is None else migration * 1000.0,
    }


def _load_variant_bands(
    revision: int, *, refresh: bool, responses: list[CachedResponse]
) -> dict[str, dict[str, Any]]:
    """Low/high projection bands, keyed by ISO3.

    Read in chunks: the OtherVariants file is ~75 MB gzipped and expands to
    roughly a gigabyte, most of which is variants and aggregates we discard.
    """
    name = f"WPP{revision}_Demographic_Indicators_OtherVariants.csv.gz"
    response = fetch(
        f"{config.WPP_CSV_BASE}/{name}",
        refresh=refresh,
        subdir="wpp",
        filename="demographic_indicators_othervariants.csv.gz",
    )
    responses.append(response)

    collected: dict[str, dict[str, dict[int, float | None]]] = {}
    for chunk in _iter_gzip_csv(
        response,
        chunksize=500_000,
        usecols=["ISO3_code", "LocTypeName", "Variant", "Time",
                 "TPopulation1July"],
    ):
        chunk = chunk[
            (chunk["LocTypeName"] == "Country/Area")
            & chunk["ISO3_code"].notna()
            & chunk["Variant"].isin(BAND_VARIANTS)
            & (chunk["Time"] <= MAX_YEAR)
        ]
        if chunk.empty:
            continue
        for record in chunk.itertuples(index=False):
            iso3 = str(record.ISO3_code).upper()
            key = BAND_VARIANTS[str(record.Variant)]
            value = _clean(record.TPopulation1July)
            bucket = collected.setdefault(iso3, {"low": {}, "high": {}})
            bucket[key][int(record.Time)] = (
                None if value is None else value * 1000.0
            )

    bands: dict[str, dict[str, Any]] = {}
    for iso3, variants in collected.items():
        years = sorted(set(variants["low"]) | set(variants["high"]))
        if not years:
            continue
        bands[iso3] = {
            "years": years,
            "low": [variants["low"].get(y) for y in years],
            "high": [variants["high"].get(y) for y in years],
        }
    return bands


def _write_pyramids(
    registry: dict[str, Entity],
    revision: int,
    *,
    refresh: bool,
    out_dir: Any,
    responses: list[CachedResponse],
) -> int:
    name = f"WPP{revision}_PopulationByAge5GroupSex_Medium.csv.gz"
    response = fetch(
        f"{config.WPP_CSV_BASE}/{name}",
        refresh=refresh,
        subdir="wpp",
        filename="population_age5group_medium.csv.gz",
    )
    responses.append(response)

    collected: dict[str, dict[int, list[tuple[int, str, float | None, float | None]]]] = {}
    for chunk in _iter_gzip_csv(
        response,
        chunksize=500_000,
        usecols=["ISO3_code", "LocTypeName", "Time", "AgeGrp", "AgeGrpStart",
                 "PopMale", "PopFemale"],
    ):
        chunk = chunk[
            (chunk["LocTypeName"] == "Country/Area")
            & chunk["ISO3_code"].notna()
            & (chunk["Time"] <= MAX_YEAR)
            & (chunk["Time"] % PYRAMID_YEAR_STEP == 0)
        ]
        if chunk.empty:
            continue
        for record in chunk.itertuples(index=False):
            iso3 = str(record.ISO3_code).upper()
            if iso3 not in registry:
                continue
            male = _clean(record.PopMale)
            female = _clean(record.PopFemale)
            collected.setdefault(iso3, {}).setdefault(int(record.Time), []).append(
                (
                    int(record.AgeGrpStart),
                    str(record.AgeGrp),
                    None if male is None else male * 1000.0,
                    None if female is None else female * 1000.0,
                )
            )

    for iso3, by_year in collected.items():
        years = sorted(by_year)
        first = sorted(by_year[years[0]], key=lambda item: item[0])
        labels = [item[1] for item in first]
        document = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": "un_wpp",
            "revision": revision,
            "variant": "medium",
            "units": "persons",
            "ageGroups": labels,
            "years": years,
            "frames": {
                str(year): {
                    "male": [
                        item[2] for item in
                        sorted(by_year[year], key=lambda i: i[0])
                    ],
                    "female": [
                        item[3] for item in
                        sorted(by_year[year], key=lambda i: i[0])
                    ],
                }
                for year in years
            },
        }
        (out_dir / f"{iso3}.json").write_text(
            json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )

    return len(collected)


__all__ = ["ingest", "discover_revision"]
