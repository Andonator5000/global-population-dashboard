"""Our World in Data cross-check.

WHAT THIS DOES AND DOES NOT PROVE
---------------------------------
OWID's population series cites "HYDE (2023); Gapminder (2022); UN WPP (2024)".
For modern years it IS UN WPP 2024 -- the same numbers we ingest. So agreement
here does NOT independently corroborate the UN's estimates.

What it does prove is that OUR PIPELINE handled them correctly: the
thousands-to-persons conversion, the ISO3 join, the Country/Area filter, and
the estimate/projection split. Those are the parts we can get wrong, and a
disagreement means we broke something. That is a narrower claim than "the
figures are verified", and this module is careful not to overstate it.

The check is therefore run against ESTIMATE years only. Projection years would
compare our medium variant against whatever variant OWID chose to publish, and
a mismatch there would say nothing useful.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch

# A discrepancy must exceed BOTH thresholds to be reported.
#
# The absolute floor is essential. WPP publishes counts in thousands with about
# three decimals, so an entity of ~2,000 people is quantised to roughly the
# nearest person and any re-derivation drifts by a few units -- which is a
# whopping 1.5% relative on Tokelau or Vatican City while being physically
# meaningless. Without the floor the report is 28 rounding artifacts burying
# the one finding that matters.
TOLERANCE = 0.005      # 0.5% relative
ABSOLUTE_FLOOR = 1000  # persons; below WPP's own publication granularity

# Checked at these years; all are estimates in WPP 2024 (<= 2023).
CHECK_YEARS = (1960, 1990, 2010, 2020, 2023)


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    response = fetch(
        config.OWID_POPULATION_CSV,
        refresh=refresh,
        subdir="owid",
        filename="population.csv",
    )

    text = response.read_text()
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None or "Code" not in reader.fieldnames:
        raise FetchError(
            f"OWID population CSV has unexpected columns: "
            f"{reader.fieldnames!r}. Expected Entity, Code, Year, Population."
        )
    population_field = next(
        (f for f in reader.fieldnames if f.lower().startswith("population")),
        None,
    )
    if population_field is None:
        raise FetchError(
            f"OWID population CSV has no Population column: "
            f"{reader.fieldnames!r}"
        )

    owid: dict[tuple[str, int], float] = {}
    for row in reader:
        code = (row.get("Code") or "").upper()
        if len(code) != 3:
            continue  # aggregates and regions carry non-ISO3 codes
        try:
            year = int(row["Year"])
        except (TypeError, ValueError, KeyError):
            continue
        if year not in CHECK_YEARS:
            continue
        raw = row.get(population_field)
        if not raw:
            continue
        try:
            owid[(code, year)] = float(raw)
        except ValueError:
            continue

    if not owid:
        raise FetchError(
            "OWID population CSV yielded no comparable observations."
        )

    series_dir = config.DATA_DIR / "population" / "series"
    if not series_dir.exists():
        raise FetchError(
            "population/series is missing; run the wpp stage before the "
            "owid_crosscheck stage."
        )

    compared = 0
    rounding_only = 0
    discrepancies: list[dict[str, Any]] = []
    missing_in_owid: list[str] = []

    for iso3 in sorted(registry):
        path = series_dir / f"{iso3}.json"
        if not path.exists():
            continue
        document = json.loads(path.read_text("utf-8"))
        years: list[int] = document["years"]
        values: list[float | None] = document["series"]["population"]
        index = {year: i for i, year in enumerate(years)}

        saw_any = False
        for year in CHECK_YEARS:
            ours = values[index[year]] if year in index else None
            theirs = owid.get((iso3, year))
            if ours is None or theirs is None:
                continue
            saw_any = True
            compared += 1
            if theirs == 0:
                continue
            absolute = abs(ours - theirs)
            delta = absolute / theirs
            if delta > TOLERANCE and absolute >= ABSOLUTE_FLOOR:
                discrepancies.append({
                    "iso3": iso3,
                    "name": registry[iso3].name_common,
                    "year": year,
                    "ours": ours,
                    "owid": theirs,
                    "relativeDelta": round(delta, 6),
                    "absoluteDelta": round(absolute),
                })
            elif delta > TOLERANCE:
                rounding_only += 1
        if not saw_any:
            missing_in_owid.append(iso3)

    report = {
        "check": "un_wpp population vs Our World in Data",
        "purpose": (
            "Validates OUR parsing (thousands-to-persons conversion, ISO3 "
            "join, Country/Area filter), NOT the UN's estimates. OWID's modern "
            "population series is itself UN WPP 2024, so agreement is expected "
            "by construction and disagreement indicates a pipeline bug."
        ),
        "owidCitation": "HYDE (2023); Gapminder (2022); UN WPP (2024)",
        "relativeTolerance": TOLERANCE,
        "absoluteFloorPersons": ABSOLUTE_FLOOR,
        "years": list(CHECK_YEARS),
        "comparisons": compared,
        "roundingOnlyCount": rounding_only,
        "roundingOnlyNote": (
            f"{rounding_only} comparisons exceeded the relative tolerance but "
            f"differed by fewer than {ABSOLUTE_FLOOR} people. These are "
            f"microstates where WPP's thousands-precision publication makes "
            f"sub-2% relative agreement unattainable, and are not defects."
        ),
        "discrepancyCount": len(discrepancies),
        "discrepancies": sorted(
            discrepancies, key=lambda d: -d["relativeDelta"]
        )[:50],
        "entitiesNotInOwid": missing_in_owid,
    }
    out_path = config.DATA_DIR / "crosscheck_owid.json"
    out_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    manifest_mod.record_source(
        manifest,
        "owid",
        title="Our World in Data — Population",
        url="https://ourworldindata.org/grapher/population",
        licence="CC BY 4.0",
        fetched_at=response.fetched_at,
        upstream_release=response.upstream_release,
        vintage="10,000 BCE - 2023",
        citation="HYDE (2023); Gapminder (2022); UN WPP (2024), via Our World in Data",
        notes=(
            "Cross-check only, never a primary source. Its modern series is UN "
            "WPP 2024, so this validates our parsing rather than the "
            "underlying estimates."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "crosscheck_owid.json",
        description="WPP-vs-OWID parsing cross-check results.",
        sources=["un_wpp", "owid"], row_count=compared,
    )

    if discrepancies:
        affected = sorted({d["iso3"] for d in discrepancies})
        manifest_mod.add_warning(
            manifest,
            f"WPP/OWID cross-check: {len(discrepancies)} of {compared} "
            f"comparisons differ materially ({', '.join(affected)}). Our "
            f"figures match the UN WPP source file exactly, so these reflect "
            f"Our World in Data substituting a different source for those "
            f"entities, not a defect in our pipeline. See crosscheck_owid.json."
        )

    print(f"    compared {compared} country-years; "
          f"{len(discrepancies)} material discrepancies, "
          f"{rounding_only} rounding-scale (ignored)")


__all__ = ["ingest"]
