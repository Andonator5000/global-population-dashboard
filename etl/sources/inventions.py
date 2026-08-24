"""Notable inventions per country, from Wikidata.

Anchor: an item with a country of origin (P495) that either names an
inventor (P61) or carries a time of invention (P575). Sitelink count is the
notability proxy and the ranking. The invention date prefers P575 (time of
discovery or invention) over P571 (inception) -- inception on an invention
item is often the item's own founding-adjacent date, not the invention's.

Coverage is honest and thin: ~57 countries have any qualifying item. The
page renders explicit unavailability for the rest; padding from prose
sources would mean inventing an editorial ranking this project has no
basis for.
"""

from __future__ import annotations

import json
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch
from . import commons


def _year(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return int(value.lstrip("+")[:4])
    except ValueError:
        return None


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "inventions"
    out_dir.mkdir(parents=True, exist_ok=True)

    response = fetch(
        f"{config.WIKIDATA_SPARQL}?format=json&query="
        + urllib.parse.quote(config.WIKIDATA_INVENTIONS_QUERY),
        refresh=refresh,
        subdir="inventions",
        filename="wikidata-inventions.json",
        expect_json=True,
    )
    bindings = response.read_json().get("results", {}).get("bindings", [])
    if len(bindings) < 200:
        raise FetchError(
            f"Inventions query returned only {len(bindings)} rows; expected "
            f"several hundred. The query or Wikidata shape changed."
        )

    # qid-level merge: OPTIONAL inventor multiplies rows per item.
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
            "inventors": [],
            "year": None,
            "file": None,
            "links": int(row.get("links", {}).get("value") or 0),
        })
        inventor = (row.get("inventorLabel", {}).get("value") or "").strip()
        if inventor and not inventor.startswith("Q") and inventor not in record["inventors"]:
            record["inventors"].append(inventor)
        if record["year"] is None:
            record["year"] = _year(
                row.get("invented", {}).get("value")
            ) or _year(row.get("inception", {}).get("value"))
        if record["file"] is None:
            image = row.get("image", {}).get("value")
            if image:
                record["file"] = commons.filename_from_special_path(image)

    by_country: dict[str, list[dict[str, Any]]] = {}
    for record in by_item.values():
        by_country.setdefault(record["iso3"], []).append(record)
    for records in by_country.values():
        records.sort(key=lambda r: (-r["links"], r["name"]))
        del records[config.INVENTIONS_TOP_N:]

    filenames = [
        r["file"]
        for records in by_country.values()
        for r in records
        if r["file"]
    ]
    metadata, meta_responses = commons.fetch_metadata(
        filenames, refresh=refresh, subdir="inventions",
    )

    written = 0
    total = 0
    for iso3, records in sorted(by_country.items()):
        items = []
        for record in records:
            item: dict[str, Any] = {"name": record["name"]}
            if record["inventors"]:
                item["inventors"] = record["inventors"][:3]
            if record["year"]:
                item["year"] = record["year"]
            if record["file"]:
                image = commons.image_record(record["file"], metadata)
                if image:
                    item["image"] = image
            items.append(item)
        document = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": "wikidata",
            "note": (
                "Inventions with a recorded country of origin in Wikidata, "
                "ranked by Wikipedia-language coverage. Dates are the "
                "recorded invention date and are often approximate."
            ),
            "inventions": items,
        }
        (out_dir / f"{iso3}.json").write_text(
            json.dumps(document, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )
        written += 1
        total += len(items)

    manifest_mod.record_source(
        manifest,
        "wikidata_inventions",
        title="Wikidata — inventions by country of origin",
        url=config.WIKIDATA_SPARQL,
        licence="CC0 (data); per-file Commons licences on images",
        fetched_at=max(
            r.fetched_at for r in [response, *meta_responses]
        ),
        upstream_release=None,
        vintage="as retrieved",
        citation="Wikidata (P495/P61/P575); Wikimedia Commons",
        notes=(
            f"{written} countries with qualifying items, {total} inventions. "
            f"Coverage reflects Wikidata tagging, not national histories; "
            f"most countries have none tagged and render as unavailable."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "inventions/<ISO3>.json",
        description=(
            "Notable inventions (name, inventor, approximate year, Commons "
            "image with attribution) for countries with Wikidata coverage."
        ),
        sources=["wikidata_inventions"], entity_count=written,
    )
    print(f"    inventions: {written} countries, {total} items")


__all__ = ["ingest"]
