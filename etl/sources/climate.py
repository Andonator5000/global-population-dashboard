"""Climate series and capital coordinates.

Two artifacts for the Weather and Climate section:

    climate/climate.json    annual mean surface temperature per country
                            (OWID's redistribution of Copernicus ERA5,
                            1940 onward) plus a 50-year warming figure
    climate/capitals.json   capital-city coordinates (GeoNames PPLC), which
                            the app feeds to Open-Meteo at RENDER time for
                            live weather -- the only live fetches this app
                            makes are the ones a static build cannot carry

The warming figure compares DECADE MEANS (1971-1980 vs 2016-2025), never
single years: single years are weather, and a country's 1971-vs-2025 delta
would swing by several degrees depending on which two years you happened to
pick. Precipitation lives in the World Bank stage (AG.LND.PRCP.MM).
"""

from __future__ import annotations

import io
import json
import zipfile
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch
from .owid_indicators import _parse_csv


def _decade_mean(
    series: dict[int, float], decade: tuple[int, int]
) -> float | None:
    values = [v for y, v in series.items() if decade[0] <= y <= decade[1]]
    # A mean of a couple of stray years is not a decade climate; require most
    # of the decade to be present.
    if len(values) < 7:
        return None
    return sum(values) / len(values)


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "climate"
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- OWID / Copernicus annual mean surface temperature ---------------
    slug = config.OWID_SURFACE_TEMPERATURE_SLUG
    temperature_response = fetch(
        config.OWID_GRAPHER_CSV.format(slug=slug),
        refresh=refresh, subdir="climate", filename=f"{slug}.csv",
    )
    metadata_response = fetch(
        config.OWID_GRAPHER_METADATA.format(slug=slug),
        refresh=refresh, subdir="climate", filename=f"{slug}.metadata.json",
        expect_json=True,
    )
    chart = metadata_response.read_json().get("chart", {})
    citation = chart.get("citation") or "Copernicus ERA5, via Our World in Data"

    parsed = _parse_csv(temperature_response.read_text(), slug)
    entities: dict[str, Any] = {}
    for iso3, series in parsed.items():
        if iso3 not in registry:
            continue
        years = sorted(series)
        latest_year = years[-1]
        record: dict[str, Any] = {
            "latestTempC": {
                "year": latest_year,
                "value": round(series[latest_year], 2),
            },
        }
        baseline = _decade_mean(series, config.CLIMATE_BASELINE_DECADE)
        recent = _decade_mean(series, config.CLIMATE_RECENT_DECADE)
        if baseline is not None and recent is not None:
            record["warming"] = {
                "value": round(recent - baseline, 2),
                "baseline": "–".join(map(str, config.CLIMATE_BASELINE_DECADE)),
                "recent": "–".join(map(str, config.CLIMATE_RECENT_DECADE)),
            }
        entities[iso3] = record
    if len(entities) < 150:
        raise FetchError(
            f"OWID surface-temperature series matched only {len(entities)} "
            f"entities; expected ~190."
        )

    climate_document = {
        "source": "owid_copernicus",
        "citation": citation,
        "note": (
            "Country-mean annual surface air temperature (ERA5 reanalysis). "
            "Warming compares decade means, not single years."
        ),
        "entities": entities,
    }
    (out_dir / "climate.json").write_text(
        json.dumps(climate_document, separators=(",", ":"), ensure_ascii=False)
        + "\n",
        encoding="utf-8", newline="\n",
    )

    # ---- GeoNames capitals ----------------------------------------------
    cities_response = fetch(
        config.GEONAMES_CITIES15000_URL,
        refresh=refresh, subdir="climate", filename="cities15000.zip",
    )
    by_iso2 = {
        entity.iso2.upper(): iso3
        for iso3, entity in registry.items()
        if entity.iso2
    }
    capitals: dict[str, dict[str, Any]] = {}
    with zipfile.ZipFile(io.BytesIO(cities_response.read_bytes())) as archive:
        with archive.open("cities15000.txt") as handle:
            for raw_line in io.TextIOWrapper(handle, encoding="utf-8"):
                fields = raw_line.rstrip("\n").split("\t")
                if len(fields) < 18 or fields[7] != "PPLC":
                    continue
                iso3 = by_iso2.get(fields[8].upper())
                if iso3 is None:
                    continue
                try:
                    population = int(fields[14] or 0)
                    latitude = float(fields[4])
                    longitude = float(fields[5])
                except ValueError:
                    continue
                current = capitals.get(iso3)
                # A few countries carry several PPLC rows (e.g. seats of
                # government); the most populous one is the display capital.
                if current is None or population > current["population"]:
                    capitals[iso3] = {
                        "name": fields[1],
                        "lat": latitude,
                        "lon": longitude,
                        "population": population,
                    }
    if len(capitals) < 150:
        raise FetchError(
            f"GeoNames yielded only {len(capitals)} capitals; expected ~190."
        )

    capitals_document = {
        "source": "geonames",
        "note": (
            "Capital-city coordinates (GeoNames feature code PPLC, most "
            "populous where several are recorded). Used by the app to ask "
            "Open-Meteo for live weather at render time."
        ),
        "entities": capitals,
    }
    (out_dir / "capitals.json").write_text(
        json.dumps(capitals_document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "climate",
        title="Copernicus ERA5 country temperatures (via OWID); GeoNames capitals",
        url=config.OWID_GRAPHER_CSV.format(slug=slug),
        licence="Copernicus/OWID CC BY 4.0; GeoNames CC BY 4.0",
        fetched_at=max(
            temperature_response.fetched_at, cities_response.fetched_at
        ),
        upstream_release=temperature_response.upstream_release,
        vintage=f"temperature through {max(e['latestTempC']['year'] for e in entities.values())}",
        citation=f"{citation}; GeoNames",
        notes=(
            f"{len(entities)} entities with temperature series, "
            f"{len(capitals)} capitals. Live weather itself is fetched by "
            f"the BROWSER from Open-Meteo (CC BY 4.0, non-commercial API) "
            f"and never enters /data."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "climate/climate.json",
        description=(
            "Annual mean surface temperature (latest year) and 50-year "
            "decade-mean warming per entity."
        ),
        sources=["climate"], entity_count=len(entities),
    )
    manifest_mod.record_artifact(
        manifest, "climate/capitals.json",
        description="Capital coordinates for the live weather panel.",
        sources=["climate"], entity_count=len(capitals),
    )
    print(f"    climate: {len(entities)} temperature series, "
          f"{len(capitals)} capitals")


__all__ = ["ingest"]
