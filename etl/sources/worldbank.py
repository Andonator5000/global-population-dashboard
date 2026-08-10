"""World Bank Indicators API v2 ingestion.

Feeds the Economy, Education, Health, and Land sections of the country pages.

VINTAGE IS PER INDICATOR, PER COUNTRY
-------------------------------------
This is the thing that makes World Bank data easy to misreport. There is no
single "current year": a country may have 2025 GDP, 2018 literacy, and no Gini
at all. Quoting a 2018 literacy rate as though it were current is exactly the
failure the brief forbids, so every value we emit carries its OWN observation
year, and `latest` records that year alongside the number. A chart that cannot
show a year does not get to show the number.

AGGREGATES ARE NOT COUNTRIES
----------------------------
`/country/all/...` returns ~266 rows including "World", "Euro area", "Low
income", and other aggregates mixed in with real countries. Emitting those as
countries would corrupt every ranking. They are identified from the API's own
/country endpoint (aggregates carry region.id == "NA") with the explicit code
list in editorial_overrides.json as a backstop.
"""

from __future__ import annotations

import json
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity, excluded_aggregate_codes
from ..fetch import CachedResponse, FetchError, fetch


def _fetch_country_catalogue(refresh: bool) -> tuple[dict[str, str], set[str]]:
    """Return (iso3 -> region name, aggregate codes) from the API's own list."""
    url = (
        f"{config.WORLD_BANK_BASE}/country"
        f"?format=json&per_page=400"
    )
    response = fetch(
        url, refresh=refresh, subdir="worldbank",
        filename="country_catalogue.json", expect_json=True,
    )
    payload = response.read_json()
    if not isinstance(payload, list) or len(payload) < 2:
        raise FetchError(
            f"World Bank /country returned an unexpected envelope: "
            f"{str(payload)[:200]!r}"
        )
    rows = payload[1]
    regions: dict[str, str] = {}
    aggregates: set[str] = set()
    for row in rows:
        iso3 = (row.get("id") or "").upper()
        if not iso3:
            continue
        region = (row.get("region") or {}).get("id")
        if region == "NA":
            aggregates.add(iso3)
        else:
            regions[iso3] = (row.get("region") or {}).get("value") or ""
    if not aggregates:
        raise FetchError(
            "World Bank /country returned no aggregate rows, which means the "
            "region.id == 'NA' convention changed. Refusing to proceed, since "
            "aggregates would otherwise be emitted as countries."
        )
    return regions, aggregates


def _fetch_indicator(
    code: str, *, refresh: bool, responses: list[CachedResponse]
) -> list[dict[str, Any]]:
    """All observations for one indicator, across all countries and years."""
    collected: list[dict[str, Any]] = []
    page = 1
    while True:
        url = (
            f"{config.WORLD_BANK_BASE}/country/all/indicator/{code}"
            f"?format=json&per_page={config.WORLD_BANK_PER_PAGE}&page={page}"
        )
        response = fetch(
            url, refresh=refresh, subdir="worldbank/indicators",
            filename=f"{code}_p{page}.json", expect_json=True,
        )
        responses.append(response)
        payload = response.read_json()

        if not isinstance(payload, list) or len(payload) < 2:
            # The API reports errors as a single-element list with a "message".
            message = ""
            if isinstance(payload, list) and payload:
                message = str(payload[0])[:200]
            elif isinstance(payload, dict):
                message = str(payload)[:200]
            raise FetchError(
                f"World Bank indicator {code} returned no data envelope "
                f"({message!r}). Run --validate-indicators; the code may have "
                f"been retired."
            )

        meta, rows = payload[0], payload[1]
        if rows:
            collected.extend(rows)
        total_pages = int(meta.get("pages") or 1)
        if page >= total_pages:
            break
        page += 1

    if not collected:
        raise FetchError(
            f"World Bank indicator {code} returned zero observations. This is "
            f"almost certainly a retired code rather than a genuinely empty "
            f"indicator; run --validate-indicators."
        )
    return collected


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "indicators"
    country_dir = out_dir / "by-country"
    for directory in (out_dir, country_dir):
        directory.mkdir(parents=True, exist_ok=True)

    responses: list[CachedResponse] = []
    _, api_aggregates = _fetch_country_catalogue(refresh)
    aggregates = api_aggregates | excluded_aggregate_codes()

    # iso3 -> indicator code -> {year: value}
    observations: dict[str, dict[str, dict[int, float]]] = {}
    # indicator code -> newest year seen anywhere (for the manifest vintage)
    newest_year: dict[str, int] = {}
    unmatched_codes: set[str] = set()
    last_updated: str | None = None

    for indicator in config.WORLD_BANK_INDICATORS:
        rows = _fetch_indicator(
            indicator.code, refresh=refresh, responses=responses
        )
        kept = 0
        for row in rows:
            iso3 = (row.get("countryiso3code") or "").upper()
            if not iso3 or iso3 in aggregates:
                continue
            if iso3 not in registry:
                unmatched_codes.add(iso3)
                continue
            value = row.get("value")
            if value is None:
                continue
            try:
                year = int(row.get("date"))
            except (TypeError, ValueError):
                continue
            observations.setdefault(iso3, {}).setdefault(
                indicator.code, {}
            )[year] = float(value)
            newest_year[indicator.code] = max(
                newest_year.get(indicator.code, year), year
            )
            kept += 1
        print(f"    {indicator.code:22s} {kept:>7,} observations", flush=True)

    # `lastupdated` is the World Bank's own release stamp for the source.
    first_payload = responses[0].read_json() if responses else None
    if isinstance(first_payload, list) and first_payload:
        last_updated = (first_payload[0] or {}).get("lastupdated")

    indicator_meta = {
        indicator.code: {
            "label": indicator.label,
            "section": indicator.section,
            "unit": indicator.unit,
            "latestYearAnywhere": newest_year.get(indicator.code),
        }
        for indicator in config.WORLD_BANK_INDICATORS
    }

    written = 0
    coverage: dict[str, int] = {}
    for iso3 in sorted(registry):
        by_indicator = observations.get(iso3, {})
        document: dict[str, Any] = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": "world_bank",
            "indicators": {},
        }
        for indicator in config.WORLD_BANK_INDICATORS:
            series = by_indicator.get(indicator.code, {})
            if not series:
                # Explicit unavailable state -- never zero, never omitted, so
                # the app can say "not available from World Bank" rather than
                # rendering an empty chart that looks like a data bug.
                document["indicators"][indicator.code] = {
                    "label": indicator.label,
                    "section": indicator.section,
                    "unit": indicator.unit,
                    "available": False,
                    "unavailableReason":
                        f"World Bank publishes no {indicator.code} "
                        f"observations for {registry[iso3].name_common}.",
                    "latest": None,
                    "years": [],
                    "values": [],
                }
                continue
            years = sorted(series)
            latest_year = years[-1]
            document["indicators"][indicator.code] = {
                "label": indicator.label,
                "section": indicator.section,
                "unit": indicator.unit,
                "available": True,
                # `year` here is the vintage of THIS figure for THIS country --
                # never assume it matches any other indicator's year.
                "latest": {"year": latest_year, "value": series[latest_year]},
                "years": years,
                "values": [series[y] for y in years],
            }
            coverage[indicator.code] = coverage.get(indicator.code, 0) + 1

        (country_dir / f"{iso3}.json").write_text(
            json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        written += 1

    catalogue = {
        "source": "world_bank",
        "lastUpdated": last_updated,
        "indicators": indicator_meta,
        "entityCoverage": {
            code: coverage.get(code, 0)
            for code in (i.code for i in config.WORLD_BANK_INDICATORS)
        },
        "entityCount": written,
    }
    (out_dir / "catalogue.json").write_text(
        json.dumps(catalogue, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    manifest_mod.record_source(
        manifest,
        "world_bank",
        title="World Bank World Development Indicators",
        url=config.WORLD_BANK_BASE,
        licence="CC BY 4.0",
        fetched_at=max(r.fetched_at for r in responses),
        upstream_release=last_updated,
        vintage=(
            f"per indicator and country; newest observation "
            f"{max(newest_year.values()) if newest_year else 'n/a'}"
        ),
        citation="World Bank, World Development Indicators (api.worldbank.org/v2)",
        files=[
            {"url": r.url, "sha256": r.sha256, "size_bytes": r.size_bytes,
             "fetched_at": r.fetched_at}
            for r in responses[:3]
        ],
        notes=(
            f"{len(config.WORLD_BANK_INDICATORS)} indicators. Every value "
            f"carries its own observation year -- there is no single current "
            f"year across indicators. Regional and income aggregates are "
            f"excluded via the API's region.id == 'NA' flag."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "indicators/catalogue.json",
        description="Indicator metadata, units, sections, and entity coverage.",
        sources=["world_bank"],
        row_count=len(config.WORLD_BANK_INDICATORS),
    )
    manifest_mod.record_artifact(
        manifest, "indicators/by-country/<ISO3>.json",
        description=(
            "Full World Bank indicator series per entity, each value carrying "
            "its own observation year."
        ),
        sources=["world_bank"], entity_count=written,
    )

    if unmatched_codes:
        manifest_mod.add_warning(
            manifest,
            f"World Bank returned {len(unmatched_codes)} non-aggregate ISO3 "
            f"codes absent from the registry: "
            f"{', '.join(sorted(unmatched_codes))}. Their data was dropped."
        )

    thin = [
        code for code, count in
        ((i.code, coverage.get(i.code, 0)) for i in config.WORLD_BANK_INDICATORS)
        if count < 40
    ]
    if thin:
        manifest_mod.add_warning(
            manifest,
            f"Sparse World Bank indicators (fewer than 40 entities with any "
            f"observation): {', '.join(thin)}. Affected country pages render "
            f"an explicit unavailable state."
        )

    print(f"    wrote {written} country indicator files")


__all__ = ["ingest"]
