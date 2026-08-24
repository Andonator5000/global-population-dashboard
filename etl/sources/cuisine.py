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
from ..crosswalk import Entity, build_name_index, normalise_name, normalise_name_strict
from ..fetch import FetchError, fetch
from . import commons


def _themealdb_dishes(
    registry: dict[str, Entity], *, refresh: bool
) -> dict[str, list[dict[str, Any]]]:
    """{iso3: dishes} from TheMealDB, for the ~62 countries it covers.

    Chosen as the PRIMARY source where available (2026-08-24): every photo
    is a guaranteed 700x700 with exact-size variants, which is what makes
    the uniform card grid actually uniform. The area list's strCountry
    field is the reliable join key -- the demonym areas are mid-migration
    upstream and inconsistently populated.
    """
    strict, loose = build_name_index(registry)
    try:
        areas_response = fetch(
            config.THEMEALDB_LIST_URL, refresh=refresh,
            subdir="cuisine/mealdb", filename="areas.json", expect_json=True,
        )
    except FetchError:
        return {}
    out: dict[str, list[dict[str, Any]]] = {}
    for area in areas_response.read_json().get("meals") or []:
        country_name = (area.get("strCountry") or "").strip()
        if not country_name:
            continue
        iso3 = (
            strict.get(normalise_name_strict(country_name))
            or loose.get(normalise_name(country_name))
        )
        if iso3 is None or iso3 in out:
            continue
        try:
            meals_response = fetch(
                config.THEMEALDB_FILTER_TEMPLATE.format(
                    area=urllib.parse.quote(country_name)
                ),
                refresh=refresh, subdir="cuisine/mealdb", expect_json=True,
            )
        except FetchError:
            continue
        meals = meals_response.read_json().get("meals") or []
        dishes: list[dict[str, Any]] = []
        for meal in meals[: config.CUISINE_TOP_N]:
            name = (meal.get("strMeal") or "").strip()
            thumb = (meal.get("strMealThumb") or "").strip()
            meal_id = meal.get("idMeal")
            if not name or not thumb:
                continue
            dish: dict[str, Any] = {"name": name}
            try:
                detail_response = fetch(
                    config.THEMEALDB_LOOKUP_TEMPLATE.format(meal_id=meal_id),
                    refresh=refresh, subdir="cuisine/mealdb",
                    expect_json=True,
                )
                detail = (detail_response.read_json().get("meals") or [{}])[0]
                category = (detail.get("strCategory") or "").strip()
                if category:
                    dish["description"] = category
            except FetchError:
                pass
            dish["image"] = {
                # /medium is a 350x350 variant; the bare URL is the 700x700
                # original, which feeds the lightbox.
                "imageUrl": f"{thumb}/medium",
                "largeUrl": thumb,
                "commonsPage": f"https://www.themealdb.com/meal/{meal_id}",
                "license": None,
                "author": None,
                "source": "TheMealDB",
            }
            dishes.append(dish)
        if dishes:
            out[iso3] = dishes
    return out


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
            "description": None,
            "file": None,
            "links": int(row.get("links", {}).get("value") or 0),
        })
        if record["file"] is None:
            image = row.get("image", {}).get("value")
            if image:
                record["file"] = commons.filename_from_special_path(image)
        if record["description"] is None:
            description = (row.get("description", {}).get("value") or "").strip()
            if description:
                record["description"] = description

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

    mealdb = _themealdb_dishes(registry, refresh=refresh)

    written = 0
    total = 0
    from_mealdb = 0
    for iso3 in sorted(set(by_country) | set(mealdb)):
        if iso3 in mealdb:
            dishes = mealdb[iso3]
            source = "themealdb"
            note = (
                "Signature dishes from TheMealDB, whose photography is "
                "shot to one uniform format. Attribution: TheMealDB "
                "(themealdb.com)."
            )
            from_mealdb += 1
        else:
            dishes = []
            for record in by_country.get(iso3, []):
                dish: dict[str, Any] = {"name": record["name"]}
                if record["description"]:
                    dish["description"] = record["description"]
                if record["file"]:
                    image = commons.image_record(record["file"], metadata)
                    if image:
                        dish["image"] = image
                dishes.append(dish)
            source = "wikidata"
            note = (
                "Dishes with a recorded country of origin in Wikidata, "
                "ranked by Wikipedia-language coverage — a notability "
                "proxy, not a popularity measurement."
            )
        if not dishes:
            continue
        document = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": source,
            "note": note,
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
        title="Cuisine: TheMealDB (primary) + Wikidata dishes (fallback)",
        url=config.THEMEALDB_LIST_URL,
        licence=(
            "TheMealDB free/educational tier, attributed; Wikidata CC0; "
            "per-file Commons licences on fallback images"
        ),
        fetched_at=max(r.fetched_at for r in [*responses, *meta_responses]),
        upstream_release=None,
        vintage="as retrieved",
        citation=(
            "TheMealDB (themealdb.com); Wikidata (P495 on dish items); "
            "Wikimedia Commons"
        ),
        notes=(
            f"{written} countries, {total} dishes; {from_mealdb} countries "
            f"served by TheMealDB's uniform 700x700 photography, the rest "
            f"by Wikidata+Commons. Countries covered by neither render as "
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
    print(f"    cuisine: {written} countries, {total} dishes "
          f"({from_mealdb} via TheMealDB)")


__all__ = ["ingest"]
