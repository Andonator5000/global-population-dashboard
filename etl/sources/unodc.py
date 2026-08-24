"""UNODC prisons and prisoners (dataUNODC bulk xlsx).

Two figures per entity for the Crime and Incarceration section:

    prisoners   "Persons held" -- total incarcerated persons (Counts)
    facilities  "Prisons facilities and capacity" / "Number of facilities"

The xlsx URL carries a release-dated path that changes every update, so the
CURRENT href is scraped from the stable landing page. Facilities coverage is
thin upstream (~90 countries report it); that renders as an honest
"not available" rather than being padded from another source.

World Prison Brief was considered for fuller facilities coverage and
rejected: no bulk endpoint, ~220 HTML page fetches per run against a small
academic site, and its prison-population figures already reach the app
through OWID (prison-population-rate). See DATA_DECISIONS.md §19.
"""

from __future__ import annotations

import io
import json
import re
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch


def _latest_by_iso3(frame: Any) -> dict[str, dict[str, float | int]]:
    """{iso3: {value, year}} taking each country's newest observation."""
    out: dict[str, dict[str, float | int]] = {}
    for row in frame.itertuples(index=False):
        iso3 = str(row.Iso3_code).strip().upper()
        try:
            year = int(row.Year)
            value = float(row.VALUE)
        except (TypeError, ValueError):
            continue
        if iso3 not in out or year > out[iso3]["year"]:
            out[iso3] = {"value": value, "year": year}
    return out


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    import pandas as pd

    out_dir = config.DATA_DIR / "crime"
    out_dir.mkdir(parents=True, exist_ok=True)

    landing = fetch(
        config.UNODC_PRISON_LANDING,
        refresh=refresh,
        subdir="unodc",
        filename="prison-landing.html",
        headers={"User-Agent": config.WHC_BROWSER_UA},
    )
    match = re.search(config.UNODC_PRISON_XLSX_RE, landing.read_text())
    if not match:
        raise FetchError(
            f"Could not find the prisons xlsx link on "
            f"{config.UNODC_PRISON_LANDING}. The landing page markup changed; "
            f"update UNODC_PRISON_XLSX_RE in etl/config.py."
        )
    xlsx_url = match.group(1)
    if xlsx_url.startswith("/"):
        xlsx_url = "https://data.unodc.org" + xlsx_url

    response = fetch(
        xlsx_url,
        refresh=refresh,
        subdir="unodc",
        filename="prisons_and_prisoners.xlsx",
        headers={"User-Agent": config.WHC_BROWSER_UA},
    )
    frame = pd.read_excel(io.BytesIO(response.read_bytes()), skiprows=2)
    required = {"Iso3_code", "Indicator", "Dimension", "Category", "Sex",
                "Age", "Year", "Unit of measurement", "VALUE"}
    if not required.issubset(frame.columns):
        raise FetchError(
            f"UNODC xlsx columns changed: {list(frame.columns)!r}."
        )

    totals = (
        (frame["Dimension"] == "Total")
        & (frame["Sex"] == "Total")
        & (frame["Age"] == "Total")
        & (frame["Unit of measurement"] == "Counts")
    )
    prisoners = _latest_by_iso3(frame[
        totals & (frame["Indicator"] == "Persons held")
        & (frame["Category"] == "Total")
    ])
    facilities = _latest_by_iso3(frame[
        totals & (frame["Indicator"] == "Prisons facilities and capacity")
        & (frame["Category"] == "Number of facilities")
    ])
    if len(prisoners) < 100:
        raise FetchError(
            f"UNODC 'Persons held' parsed to only {len(prisoners)} countries; "
            f"expected 200+. The sheet layout likely changed."
        )

    entities: dict[str, Any] = {}
    for iso3 in sorted(registry):
        record: dict[str, Any] = {}
        if iso3 in prisoners:
            record["prisoners"] = {
                "value": int(prisoners[iso3]["value"]),
                "year": prisoners[iso3]["year"],
            }
        if iso3 in facilities:
            record["facilities"] = {
                "value": int(facilities[iso3]["value"]),
                "year": facilities[iso3]["year"],
            }
        if record:
            entities[iso3] = record

    document = {
        "source": "unodc",
        "note": (
            "Latest reported value per country; countries report in "
            "different years. 'Facilities' is the number of penal "
            "institutions, reported by fewer than half of countries."
        ),
        "entities": entities,
    }
    (out_dir / "unodc-prisons.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "unodc_prisons",
        title="UNODC — persons held in prisons and penal facilities",
        url=xlsx_url,
        licence="United Nations / UNODC terms; free reuse with attribution",
        fetched_at=response.fetched_at,
        upstream_release=response.upstream_release,
        vintage="per country; newest observations 2024",
        citation="UNODC, Data Portal — Prisons and prisoners (CTS)",
        notes=(
            f"{len(prisoners)} countries with prisoner totals, "
            f"{len(facilities)} with facility counts. The xlsx href is "
            f"re-discovered from the landing page each run because its path "
            f"is release-dated."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "crime/unodc-prisons.json",
        description=(
            "Total persons held in prison and number of penal facilities per "
            "entity, latest reported year."
        ),
        sources=["unodc_prisons"], entity_count=len(entities),
    )
    print(f"    UNODC: {len(prisoners)} prisoner totals, "
          f"{len(facilities)} facility counts")


__all__ = ["ingest"]
