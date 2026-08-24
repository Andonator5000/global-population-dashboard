"""National cuisine: signature dishes per country, from Wikidata.

Dishes and food types carrying a country of origin (P495), ranked by
sitelink count -- the same notability proxy the inventions stage uses. The
class list is a VALUES enumeration (dish, type of food, food, soup) because
the full subclass closure of "dish" times out the query service.

"Most popular foods" has no measured global source; language-coverage
ranking of origin-tagged dishes is the defensible approximation, and tacos/
burritos for Mexico or sushi's absence for a country Wikidata never tagged
is exactly what it yields. Coverage: ~113 countries; the rest render as
explicitly unavailable.
"""

from __future__ import annotations

import json
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch
from . import commons


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "cuisine"
    out_dir.mkdir(parents=True, exist_ok=True)

    responses = []
    bindings: list[Any] = []
    for qid in config.WIKIDATA_CUISINE_CLASSES:
        response = fetch(
            f"{config.WIKIDATA_SPARQL}?format=json&query="
            + urllib.parse.quote(
                config.WIKIDATA_CUISINE_QUERY_TEMPLATE.format(qid=qid)
            ),
            refresh=refresh,
            subdir="cuisine",
            filename=f"wikidata-cuisine-{qid}.json",
            expect_json=True,
        )
        responses.append(response)
        bindings.extend(
            response.read_json().get("results", {}).get("bindings", [])
        )
    if len(bindings) < 500:
        raise FetchError(
            f"Cuisine queries returned only {len(bindings)} rows; expected "
            f"1,000+."
        )

    by_item: dict[str, dict[str, Any]] = {}
    for row in bindings:
        iso3 = (row.get("iso3", {}).get("value") or "").upper()
        if iso3 not in registry:
            continue
        qid = (row.get("item", {}).get("value") or "").rsplit("/", 1)[-1]
        label = (row.get("itemLabel", {}).get("value") or "").strip()
        if not label or label == qid:
            continue
        record = by_item.setdefault(qid, {
            "iso3": iso3,
            "name": label,
            "file": None,
            "links": int(row.get("links", {}).get("value") or 0),
        })
        if record["file"] is None:
            image = row.get("image", {}).get("value")
            if image:
                record["file"] = commons.filename_from_special_path(image)

    by_country: dict[str, list[dict[str, Any]]] = {}
    for record in by_item.values():
        by_country.setdefault(record["iso3"], []).append(record)
    for records in by_country.values():
        # Dishes WITH a photo rank first within equal notability -- the
        # section is visual by request, and a tie broken toward the entry
        # that can actually show the food is the better page.
        records.sort(key=lambda r: (-r["links"], r["file"] is None, r["name"]))
        del records[config.CUISINE_TOP_N:]

    filenames = [
        r["file"]
        for records in by_country.values()
        for r in records
        if r["file"]
    ]
    metadata, meta_responses = commons.fetch_metadata(
        filenames, refresh=refresh, subdir="cuisine",
    )

    written = 0
    total = 0
    for iso3, records in sorted(by_country.items()):
        dishes = []
        for record in records:
            dish: dict[str, Any] = {"name": record["name"]}
            if record["file"]:
                image = commons.image_record(record["file"], metadata)
                if image:
                    dish["image"] = image
            dishes.append(dish)
        document = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": "wikidata",
            "note": (
                "Dishes with a recorded country of origin in Wikidata, "
                "ranked by Wikipedia-language coverage — a notability "
                "proxy, not a popularity measurement."
            ),
            "dishes": dishes,
        }
        (out_dir / f"{iso3}.json").write_text(
            json.dumps(document, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )
        written += 1
        total += len(dishes)

    manifest_mod.record_source(
        manifest,
        "wikidata_cuisine",
        title="Wikidata — dishes by country of origin",
        url=config.WIKIDATA_SPARQL,
        licence="CC0 (data); per-file Commons licences on images",
        fetched_at=max(r.fetched_at for r in [*responses, *meta_responses]),
        upstream_release=None,
        vintage="as retrieved",
        citation="Wikidata (P495 on dish items); Wikimedia Commons",
        notes=(
            f"{written} countries, {total} dishes. Coverage reflects "
            f"Wikidata tagging; countries without tagged dishes render as "
            f"unavailable."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "cuisine/<ISO3>.json",
        description=(
            "Signature dishes with Commons images and attribution, per "
            "entity."
        ),
        sources=["wikidata_cuisine"], entity_count=written,
    )
    print(f"    cuisine: {written} countries, {total} dishes")


__all__ = ["ingest"]
