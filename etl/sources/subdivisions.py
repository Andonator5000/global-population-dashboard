"""First-level administrative subdivisions with populations, from Wikidata.

One SPARQL query covers every country (P150 with truthy rank, ~4,200 rows,
verified under 1s). GeoNames was the considered alternative and lost: its
admin1 populations live only in a 400 MB all-countries dump or ~250
per-country zips, and its figures are generally staler than Wikidata's
truthy P1082.

KNOWN LIMITS, stated in the artifact rather than papered over:
- P150 membership is Wikidata's judgment of "first-level"; excluding items
  typed as FORMER entities (Q19953632) removes the worst offenders (India's
  dissolved territories), but the odd duplicate or non-first-level item can
  survive. Rows are deduplicated by label, keeping the one with a population.
- Population is truthy P1082 (preferred rank, usually the latest census or
  official estimate); its reference year is NOT carried by this query, so
  the page says "latest Wikidata figure" rather than inventing a vintage.
"""

from __future__ import annotations

import json
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "subdivisions"
    out_dir.mkdir(parents=True, exist_ok=True)

    response = fetch(
        f"{config.WIKIDATA_SPARQL}?format=json&query="
        + urllib.parse.quote(config.WIKIDATA_SUBDIVISIONS_QUERY),
        refresh=refresh,
        subdir="subdivisions",
        filename="wikidata-subdivisions.json",
        expect_json=True,
    )
    bindings = response.read_json().get("results", {}).get("bindings", [])
    if len(bindings) < 2000:
        raise FetchError(
            f"Wikidata subdivisions query returned only {len(bindings)} "
            f"rows; expected ~4,000+. Refusing to publish a partial world."
        )

    # iso3 -> label -> {name, population, qid}; label-level dedupe because
    # P150 occasionally lists an entity twice under different items.
    collected: dict[str, dict[str, dict[str, Any]]] = {}
    # iso3 -> class label -> occurrences, for "what this country calls them".
    class_votes: dict[str, dict[str, int]] = {}
    for row in bindings:
        iso3 = (row.get("iso3", {}).get("value") or "").upper()
        if iso3 not in registry:
            continue
        qid = (row.get("division", {}).get("value") or "").rsplit("/", 1)[-1]
        label = (row.get("divisionLabel", {}).get("value") or "").strip()
        if not label or label == qid:
            continue  # an item with no English label is unrenderable
        population: int | None = None
        raw = row.get("population", {}).get("value")
        if raw is not None:
            try:
                population = int(float(raw))
            except ValueError:
                population = None
        class_label = (row.get("classLabel", {}).get("value") or "").strip()
        if (
            class_label
            and class_label.lower() not in config.SUBDIVISION_GENERIC_CLASS_LABELS
        ):
            votes = class_votes.setdefault(iso3, {})
            votes[class_label] = votes.get(class_label, 0) + 1
        existing = collected.setdefault(iso3, {}).get(label)
        if existing is None or (existing["population"] is None and population):
            collected[iso3][label] = {
                "name": label,
                "population": population,
                "qid": qid,
            }

    written = 0
    index: dict[str, int] = {}
    for iso3, by_label in sorted(collected.items()):
        divisions = sorted(
            by_label.values(),
            key=lambda d: (-(d["population"] or -1), d["name"]),
        )
        votes = class_votes.get(iso3, {})
        # The most common specific class label is the country's own term
        # ("canton of Switzerland", "state of the United States").
        division_type = (
            max(votes.items(), key=lambda kv: kv[1])[0] if votes else None
        )
        document = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": "wikidata",
            "note": (
                "First-level administrative divisions as recorded in "
                "Wikidata (P150); population is the latest Wikidata figure "
                "(P1082), whose reference year varies by division."
            ),
            "divisionType": division_type,
            "divisions": divisions,
        }
        (out_dir / f"{iso3}.json").write_text(
            json.dumps(document, separators=(",", ":"), ensure_ascii=False)
            + "\n",
            encoding="utf-8", newline="\n",
        )
        index[iso3] = len(divisions)
        written += 1

    (out_dir / "index.json").write_text(
        json.dumps(
            {"source": "wikidata", "counts": index},
            indent=2, ensure_ascii=False,
        ) + "\n",
        encoding="utf-8", newline="\n",
    )

    with_population = sum(
        1
        for by_label in collected.values()
        for d in by_label.values()
        if d["population"] is not None
    )
    total = sum(len(v) for v in collected.values())

    manifest_mod.record_source(
        manifest,
        "wikidata_subdivisions",
        title="Wikidata — first-level administrative divisions",
        url=config.WIKIDATA_SPARQL,
        licence="CC0",
        fetched_at=response.fetched_at,
        upstream_release=None,
        vintage="as retrieved; division populations carry their own vintages",
        citation="Wikidata (P150 contains administrative territorial entity)",
        notes=(
            f"{written} countries, {total} divisions, {with_population} with "
            f"a population figure. Former administrative entities excluded "
            f"by P31 filter."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "subdivisions/<ISO3>.json",
        description=(
            "First-level administrative divisions (states, provinces, "
            "cantons...) with latest Wikidata populations, sorted by "
            "population."
        ),
        sources=["wikidata_subdivisions"], entity_count=written,
    )
    print(f"    subdivisions: {written} countries, {total} divisions "
          f"({with_population} with population)")


__all__ = ["ingest"]
