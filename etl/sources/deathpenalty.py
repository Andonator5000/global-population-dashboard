"""Death penalty status per country, from Wikipedia's structured tables.

Amnesty International compiles this data but publishes only PDFs; OWID and
Wikidata carry nothing current (verified 2026-08-23). Wikipedia's "Capital
punishment by country" page keeps per-country status, last-execution year,
latest-year execution figures and abolition year in consistent wikitables,
licensed CC BY-SA 4.0 -- the only keyless machine-readable source.

The execution figures are Amnesty's and arrive as strings ("972+",
"1,000s", "unknown"); they are kept VERBATIM. Parsing "1,000s" into 1000
would launder a floor estimate into a false precision.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity, build_name_index, normalise_name, normalise_name_strict
from ..fetch import FetchError, fetch

# Wikipedia spellings that the registry's strict/loose folding cannot reach.
_NAME_ALIASES: dict[str, str] = {
    "democratic republic of the congo": "COD",
    "republic of the congo": "COG",
    "east timor": "TLS",
    "sao tome and principe": "STP",
    "cape verde": "CPV",
    "ivory coast": "CIV",
    "burma": "MMR",
    "vatican city": "VAT",
    "state of palestine": "PSE",
    "turkey": "TUR",
    "federated states of micronesia": "FSM",
    "china": "CHN",
    "taiwan": "TWN",
}


def _clean(text: Any) -> str:
    """Strip footnote markers ('[50]') and whitespace from a cell."""
    if text is None:
        return ""
    # pandas reads numeric-looking cells as floats; an execution count of 25
    # must not render as "25.0".
    if isinstance(text, float) and text.is_integer():
        text = int(text)
    return re.sub(r"\[[^\]]*\]", "", str(text)).replace(" ", " ").strip()


def _year_of(text: Any) -> int | None:
    """First plausible year in a cell, or None ('*None since 1991' -> 1991)."""
    match = re.search(r"\b(1[5-9]\d\d|20\d\d)\b", _clean(text))
    return int(match.group(1)) if match else None


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    import io

    import pandas as pd

    out_dir = config.DATA_DIR / "crime"
    out_dir.mkdir(parents=True, exist_ok=True)

    response = fetch(
        config.WIKIPEDIA_CAPITAL_PUNISHMENT_URL,
        refresh=refresh,
        subdir="wikipedia",
        filename="capital-punishment.html",
    )
    tables = pd.read_html(io.StringIO(response.read_text()))
    status_tables = [
        t for t in tables
        if {"Key", "Country"}.issubset({str(c) for c in t.columns})
    ]
    if len(status_tables) < 4:
        raise FetchError(
            f"Expected at least 4 continent status tables on the capital "
            f"punishment page; found {len(status_tables)}. The page layout "
            f"changed."
        )

    executions_year: int | None = None
    for table in status_tables:
        for column in table.columns:
            match = re.match(r"Executions in (\d{4})", str(column))
            if match:
                executions_year = int(match.group(1))
    strict, loose = build_name_index(registry)

    entities: dict[str, Any] = {}
    unmatched: list[str] = []
    for table in status_tables:
        exec_col = next(
            (c for c in table.columns if str(c).startswith("Executions in ")),
            None,
        )
        for row in table.to_dict("records"):
            name = _clean(row.get("Country")).lstrip("*").strip()
            status = _clean(row.get("Key")).upper()
            if not name or status not in config.DEATH_PENALTY_STATUS_LABELS:
                continue
            iso3 = (
                _NAME_ALIASES.get(normalise_name_strict(name))
                or strict.get(normalise_name_strict(name))
                or loose.get(normalise_name(name))
            )
            if iso3 is None or iso3 not in registry:
                unmatched.append(name)
                continue
            record: dict[str, Any] = {
                "status": status,
                "statusLabel": config.DEATH_PENALTY_STATUS_LABELS[status],
                "retained": status in ("P", "L", "E"),
            }
            last_exec = _year_of(row.get("Last execution"))
            if last_exec:
                record["lastExecutionYear"] = last_exec
            abolished = _year_of(row.get("Year abolished"))
            if abolished:
                record["abolishedYear"] = abolished
            raw_exec = _clean(row.get(exec_col)) if exec_col else ""
            if raw_exec and raw_exec.lower() not in ("nan", ""):
                record["recentExecutions"] = raw_exec
            entities[iso3] = record

    if len(entities) < 150:
        raise FetchError(
            f"Capital punishment tables matched only {len(entities)} "
            f"countries; expected ~190. Parsing or matching regressed."
        )

    document = {
        "source": "wikipedia_capital_punishment",
        "statusLabels": config.DEATH_PENALTY_STATUS_LABELS,
        "executionsYear": executions_year,
        "note": (
            "Execution figures are Amnesty International counts as recorded "
            "by Wikipedia and are kept verbatim -- values like '1,000s' are "
            "floor estimates, not numbers."
        ),
        "entities": entities,
    }
    (out_dir / "death-penalty.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "wikipedia_capital_punishment",
        title="Capital punishment by country (Wikipedia)",
        url="https://en.wikipedia.org/wiki/Capital_punishment_by_country",
        licence="CC BY-SA 4.0",
        fetched_at=response.fetched_at,
        upstream_release=response.upstream_release,
        vintage=f"page as retrieved; execution figures {executions_year}",
        citation=(
            "Wikipedia, 'Capital punishment by country' (execution figures "
            "originally compiled by Amnesty International)"
        ),
        notes=(
            f"{len(entities)} countries matched. Amnesty publishes only PDFs "
            f"and no keyless structured source exists; Wikipedia's tables "
            f"are the machine-readable secondary source, used with per-page "
            f"attribution."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "crime/death-penalty.json",
        description=(
            "Death penalty legal status, last execution year, and latest "
            "Amnesty execution figure per entity."
        ),
        sources=["wikipedia_capital_punishment"], entity_count=len(entities),
    )
    if unmatched:
        manifest_mod.add_warning(
            manifest,
            f"Capital punishment table rows not matched to the registry: "
            f"{', '.join(sorted(set(unmatched))[:12])}"
            f"{'…' if len(set(unmatched)) > 12 else ''}."
        )
    print(f"    death penalty: {len(entities)} countries, "
          f"{len(set(unmatched))} unmatched rows")


__all__ = ["ingest"]
