"""Our World in Data as a primary source.

This is distinct from owid.py (the population cross-check) on purpose, and the
distinction is doctrinal: OWID's population series is UN WPP re-published, so
it can only ever validate our parsing. The series ingested HERE are ones OWID
is the sensible distribution channel for -- V-Dem's democracy and human-rights
measures and the Global Carbon Budget's emissions series have no keyless
first-party API, and OWID redistributes them under CC BY with clean ISO3 keys.

The citation therefore names the underlying producer (V-Dem, Regimes of the
World, Global Carbon Budget) *via* Our World in Data, pulled from each
grapher's own metadata endpoint rather than hardcoded, so a producer change
upstream shows up in our manifest instead of silently going stale.

Output mirrors the World Bank per-country artifact shape (the app already has
rendering conventions for it), but in a separate /data/owid tree so per-file
`source` provenance stays truthful.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch


def _parse_csv(
    text: str, slug: str
) -> dict[str, dict[int, float]]:
    """ISO3 -> {year: value} for one grapher CSV.

    Grapher CSVs are Entity,Code,Year,<value>[,extras]. The value column is
    found by position (index 3) being unreliable across graphers; instead take
    the first column that is not Entity/Code/Year and not an OWID region
    annotation.
    """
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None or "Code" not in reader.fieldnames:
        raise FetchError(
            f"OWID grapher {slug} returned unexpected columns: "
            f"{reader.fieldnames!r}"
        )
    value_field = next(
        (
            f
            for f in reader.fieldnames
            if f not in ("Entity", "Code", "Year")
            and not f.lower().startswith("world region")
        ),
        None,
    )
    if value_field is None:
        raise FetchError(
            f"OWID grapher {slug} has no value column: {reader.fieldnames!r}"
        )

    out: dict[str, dict[int, float]] = {}
    for row in reader:
        code = (row.get("Code") or "").upper()
        if len(code) != 3:
            continue  # aggregates, regions, and OWID_* pseudo-codes
        try:
            year = int(row["Year"])
        except (TypeError, ValueError, KeyError):
            continue
        if year < config.OWID_START_YEAR:
            continue
        raw = row.get(value_field)
        if raw is None or raw == "":
            continue
        try:
            out.setdefault(code, {})[year] = float(raw)
        except ValueError:
            continue
    if not out:
        raise FetchError(f"OWID grapher {slug} yielded no ISO3 observations.")
    return out


def _citation(metadata: Any, slug: str) -> dict[str, str | None]:
    chart = metadata.get("chart", {}) if isinstance(metadata, dict) else {}
    return {
        "citation": chart.get("citation") or f"Our World in Data ({slug})",
        "subtitle": chart.get("subtitle"),
    }


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "owid"
    country_dir = out_dir / "by-country"
    for directory in (out_dir, country_dir):
        directory.mkdir(parents=True, exist_ok=True)

    responses: list[CachedResponse] = []
    # code -> iso3 -> {year: value}
    observations: dict[str, dict[str, dict[int, float]]] = {}
    citations: dict[str, dict[str, str | None]] = {}
    newest_year: dict[str, int] = {}
    unmatched: set[str] = set()

    for indicator in config.OWID_INDICATORS:
        response = fetch(
            config.OWID_GRAPHER_CSV.format(slug=indicator.slug),
            refresh=refresh,
            subdir="owid/indicators",
            filename=f"{indicator.slug}.csv",
        )
        responses.append(response)
        meta_response = fetch(
            config.OWID_GRAPHER_METADATA.format(slug=indicator.slug),
            refresh=refresh,
            subdir="owid/indicators",
            filename=f"{indicator.slug}.metadata.json",
            expect_json=True,
        )
        citations[indicator.code] = _citation(
            meta_response.read_json(), indicator.slug
        )

        parsed = _parse_csv(response.read_text(), indicator.slug)
        kept: dict[str, dict[int, float]] = {}
        for iso3, series in parsed.items():
            if iso3 not in registry:
                unmatched.add(iso3)
                continue
            kept[iso3] = series
            newest_year[indicator.code] = max(
                newest_year.get(indicator.code, 0), max(series)
            )
        observations[indicator.code] = kept
        print(
            f"    {indicator.slug:32s} {len(kept):>4} entities, "
            f"newest {newest_year.get(indicator.code, 'n/a')}",
            flush=True,
        )

    written = 0
    coverage: dict[str, int] = {}
    for iso3 in sorted(registry):
        document: dict[str, Any] = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": "owid",
            "indicators": {},
        }
        for indicator in config.OWID_INDICATORS:
            series = observations.get(indicator.code, {}).get(iso3, {})
            base = {
                "label": indicator.label,
                "section": indicator.section,
                "unit": indicator.unit,
                "kind": indicator.kind,
                "citation": citations[indicator.code]["citation"],
            }
            if not series:
                document["indicators"][indicator.code] = {
                    **base,
                    "available": False,
                    "unavailableReason": (
                        f"Our World in Data publishes no "
                        f"{indicator.label.lower()} observations for "
                        f"{registry[iso3].name_common}."
                    ),
                    "latest": None,
                    "years": [],
                    "values": [],
                }
                continue
            years = sorted(series)
            latest_year = years[-1]
            document["indicators"][indicator.code] = {
                **base,
                "available": True,
                # The vintage of THIS figure for THIS country.
                "latest": {"year": latest_year, "value": series[latest_year]},
                "years": years,
                "values": [series[y] for y in years],
            }
            coverage[indicator.code] = coverage.get(indicator.code, 0) + 1

        (country_dir / f"{iso3}.json").write_text(
            json.dumps(document, separators=(",", ":"), ensure_ascii=False)
            + "\n",
            encoding="utf-8", newline="\n",
        )
        written += 1

    catalogue = {
        "source": "owid",
        "note": (
            f"Series trimmed to {config.OWID_START_YEAR} onward. Citations "
            f"name the underlying producer via Our World in Data and come "
            f"from each grapher's metadata endpoint."
        ),
        "regimeLabels": {
            str(k): v for k, v in config.OWID_REGIME_LABELS.items()
        },
        "indicators": {
            indicator.code: {
                "slug": indicator.slug,
                "label": indicator.label,
                "section": indicator.section,
                "unit": indicator.unit,
                "kind": indicator.kind,
                "citation": citations[indicator.code]["citation"],
                "subtitle": citations[indicator.code]["subtitle"],
                "latestYearAnywhere": newest_year.get(indicator.code),
            }
            for indicator in config.OWID_INDICATORS
        },
        "entityCoverage": {
            indicator.code: coverage.get(indicator.code, 0)
            for indicator in config.OWID_INDICATORS
        },
        "entityCount": written,
    }
    (out_dir / "catalogue.json").write_text(
        json.dumps(catalogue, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "owid_indicators",
        title="Our World in Data — curated indicators",
        url="https://ourworldindata.org/grapher",
        licence="CC BY 4.0 (underlying producers' terms apply)",
        fetched_at=max(r.fetched_at for r in responses),
        upstream_release=None,
        vintage=(
            f"per indicator and country; newest observation "
            f"{max(newest_year.values()) if newest_year else 'n/a'}"
        ),
        citation="; ".join(
            sorted({c["citation"] for c in citations.values() if c["citation"]})
        ) + ", via Our World in Data",
        files=[
            {"url": r.url, "sha256": r.sha256, "size_bytes": r.size_bytes,
             "fetched_at": r.fetched_at}
            for r in responses
        ],
        notes=(
            f"{len(config.OWID_INDICATORS)} series, primary source for the "
            f"Freedom section (V-Dem democracy and human-rights indices, "
            f"Regimes of the World classification) and CO2 per capita "
            f"(Global Carbon Budget). Distinct from the population "
            f"cross-check, which remains validation-only."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "owid/catalogue.json",
        description="OWID indicator metadata, citations, and coverage.",
        sources=["owid_indicators"],
        row_count=len(config.OWID_INDICATORS),
    )
    manifest_mod.record_artifact(
        manifest, "owid/by-country/<ISO3>.json",
        description=(
            "Our World in Data indicator series per entity (V-Dem democracy "
            "and rights indices, regime classification, CO2 per capita), "
            "each value carrying its own observation year."
        ),
        sources=["owid_indicators"], entity_count=written,
    )

    if unmatched:
        manifest_mod.add_warning(
            manifest,
            f"OWID indicators carried {len(unmatched)} ISO3 codes absent from "
            f"the registry: {', '.join(sorted(unmatched))}. Their data was "
            f"dropped."
        )

    print(f"    wrote {written} country OWID files")


__all__ = ["ingest"]
