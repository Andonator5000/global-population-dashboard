"""RSF World Press Freedom Index.

First-party CSV at a stable year-keyed URL (see config.RSF_CSV_TEMPLATE for
the verified quirks: windows-1252, semicolons, decimal commas, ISO3 keys).
OWID also mirrors this index but froze it in 2021 on the OLD inverted
methodology (0 = best), so the mirror was rejected: mixing methodologies
across years would make every trend a lie. Current methodology is 0-100,
HIGHER = MORE press freedom.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch


def _load_index(refresh: bool) -> tuple[Any, int]:
    """Fetch the newest published edition, probing current year backwards."""
    this_year = datetime.now(timezone.utc).year
    last_error: FetchError | None = None
    for year in range(this_year, this_year - config.RSF_PROBE_YEARS_BACK, -1):
        try:
            response = fetch(
                config.RSF_CSV_TEMPLATE.format(year=year),
                refresh=refresh,
                subdir="pressfreedom",
                filename=f"rsf-{year}.csv",
                headers={"User-Agent": config.WHC_BROWSER_UA},
            )
            return response, year
        except FetchError as exc:
            last_error = exc
    raise FetchError(
        f"No RSF index CSV found for {this_year} back to "
        f"{this_year - config.RSF_PROBE_YEARS_BACK + 1}. The URL pattern may "
        f"have moved; check https://rsf.org/en/index. Last error: {last_error}"
    )


def _decimal(raw: str) -> float:
    """RSF uses decimal commas ('87,18')."""
    return float(raw.replace(",", "."))


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "freedom"
    out_dir.mkdir(parents=True, exist_ok=True)

    response, year = _load_index(refresh)
    text = response.read_bytes().decode("windows-1252")
    reader = csv.DictReader(io.StringIO(text), delimiter=";")
    fields = reader.fieldnames or []

    score_field = next((f for f in fields if f.startswith("Score ")), None)
    if score_field is None or "ISO" not in fields or "Rank" not in fields:
        raise FetchError(
            f"RSF {year} CSV columns changed: {fields!r}. Expected ISO, "
            f"Rank and a 'Score {year}'-style column."
        )

    entities: dict[str, Any] = {}
    unmatched: list[str] = []
    for row in reader:
        iso3 = (row.get("ISO") or "").strip().upper()
        if not iso3:
            continue
        if iso3 not in registry:
            unmatched.append(iso3)
            continue
        try:
            entities[iso3] = {
                "score": round(_decimal(row[score_field]), 2),
                "rank": int(row["Rank"]),
            }
        except (KeyError, ValueError) as exc:
            raise FetchError(
                f"RSF {year} row for {iso3} failed to parse: {exc!r}"
            ) from exc

    if len(entities) < 150:
        raise FetchError(
            f"RSF {year} CSV parsed to only {len(entities)} countries; the "
            f"index covers ~180, so this looks like a truncated or reshaped "
            f"file rather than real data."
        )

    document = {
        "source": "rsf",
        "year": year,
        "scale": (
            "0-100, higher means more press freedom (methodology in use "
            "since 2022; not comparable with pre-2022 editions)."
        ),
        "rankedCountries": len(entities),
        "entities": entities,
    }
    (out_dir / "press-freedom.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "rsf_press_freedom",
        title="RSF World Press Freedom Index",
        url=config.RSF_CSV_TEMPLATE.format(year=year),
        licence="© Reporters Without Borders; reproduced with attribution",
        fetched_at=response.fetched_at,
        upstream_release=response.upstream_release,
        vintage=str(year),
        citation=f"Reporters Without Borders (RSF), World Press Freedom Index {year}",
        notes=(
            f"{len(entities)} countries matched to the registry. First-party "
            f"CSV; the OWID mirror was rejected (frozen in 2021 on the old "
            f"inverted 0-is-best methodology)."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "freedom/press-freedom.json",
        description="RSF press-freedom score and rank per entity.",
        sources=["rsf_press_freedom"], entity_count=len(entities),
    )
    if unmatched:
        manifest_mod.add_warning(
            manifest,
            f"RSF index carried {len(unmatched)} ISO3 codes absent from the "
            f"registry: {', '.join(sorted(unmatched))}."
        )
    print(f"    RSF {year}: {len(entities)} countries")


__all__ = ["ingest"]
