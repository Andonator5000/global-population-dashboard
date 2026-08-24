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
import re
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch
from . import commons

_EXCLUDED_SECTIONS = {
    "see also", "references", "external links", "notes", "further reading",
    "bibliography", "sources", "citations", "gallery",
}
_YEAR_RE = re.compile(r"\b(1[0-9]{3}|20[0-2][0-9])\b")
_ERA_RE = re.compile(
    r"\b(\d{1,2}(?:st|nd|rd|th)\s+century(?:\s+BCE?)?|\d{3,4}s?\s+BCE?)\b"
)
_INVENTOR_RE = re.compile(
    r"(?:invented|discovered|developed|created|designed|patented|devised|"
    r"introduced)\s+(?:in\s+\d{3,4}\s+)?by\s+"
    r"([A-Z][\w.'’-]+(?:\s+(?:van|von|de|der|du|la|le)\s+|\s+)"
    r"[A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+)?)"
)


def _year(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return int(value.lstrip("+")[:4])
    except ValueError:
        return None


def _commons_filename_from_upload_url(url: str) -> str | None:
    """Original Commons filename from an upload.wikimedia.org URL.

    enwiki-local files (/wikipedia/en/) are skipped outright: they are
    usually non-free media that must not be hotlinked elsewhere.
    """
    if "/wikipedia/commons/" not in url:
        return None
    if "/thumb/" in url:
        return commons.filename_from_thumb_url(url)
    tail = url.rsplit("/", 1)[-1]
    return urllib.parse.unquote(tail).replace("_", " ") or None


def _parse_list_page(html_bytes: bytes) -> list[dict[str, Any]]:
    """Invention candidates from one Wikipedia list article.

    Generic heuristic (the ~50 list pages share no strict format): each
    candidate is a list item in a content section whose first wiki link
    names the invention; year, era and inventor are regexed out of the
    item's prose and are honestly lossy.
    """
    from lxml import html as lhtml

    doc = lhtml.fromstring(html_bytes)
    entries: list[dict[str, Any]] = []
    seen_titles: set[str] = set()
    for section in doc.xpath("//section"):
        headings = section.xpath("./h2|./h3|./h4")
        if headings and headings[0].text_content().strip().lower() in _EXCLUDED_SECTIONS:
            continue
        for item in section.xpath("./ul/li|./div/ul/li"):
            text = item.text_content()
            link = next(
                (
                    a for a in item.xpath(".//a[@rel='mw:WikiLink']")
                    if (a.get("href") or "").startswith("./")
                    and ":" not in (a.get("href") or "")
                    and len(a.text_content().strip()) > 1
                ),
                None,
            )
            if link is None:
                continue
            title = urllib.parse.unquote(
                (link.get("href") or "").removeprefix("./")
            )
            if title in seen_titles:
                continue
            seen_titles.add(title)
            entry: dict[str, Any] = {
                "name": link.text_content().strip(),
                "articleTitle": title,
            }
            year_match = _YEAR_RE.search(text)
            if year_match:
                entry["year"] = int(year_match.group(1))
            else:
                era_match = _ERA_RE.search(text)
                if era_match:
                    entry["era"] = era_match.group(1)
            inventor_match = _INVENTOR_RE.search(text)
            if inventor_match:
                entry["inventors"] = [inventor_match.group(1).rstrip(".,")]
            entries.append(entry)
    return entries


def _wikipedia_entries(
    registry: dict[str, Entity], *, refresh: bool
) -> tuple[dict[str, list[dict[str, Any]]], int]:
    """{iso3: candidates} from the curated per-country list articles.

    Each candidate is enriched (and vetted) through the REST summary of its
    linked article: entries whose summary is missing are dropped as parse
    noise, and food/drink reads in the summary description are excluded --
    the national lists enjoy listing champagne and pad thai as inventions,
    and this section is non-edible by ruling (see the Wikidata filter).
    """
    out: dict[str, list[dict[str, Any]]] = {}
    dropped_food = 0
    for title, iso3 in config.WIKIPEDIA_INVENTION_LISTS.items():
        if iso3 not in registry:
            continue
        try:
            page = fetch(
                config.WIKIPEDIA_REST_HTML_TEMPLATE.format(
                    title=urllib.parse.quote(title.replace(" ", "_"))
                ),
                refresh=refresh, subdir="inventions/wikipedia",
            )
        except FetchError:
            continue  # a renamed list page must not sink the stage
        candidates = _parse_list_page(page.read_bytes())
        # Sample EVENLY across the page rather than taking its head: these
        # lists are sectioned by category, and head-taking made every French
        # invention an artefact of whichever category sorts first ("Gothic
        # art" led the list). Even spacing crosses the categories.
        window = config.WIKIPEDIA_INVENTIONS_PER_PAGE * 2  # survive drops
        if len(candidates) > window:
            step = len(candidates) / window
            candidates = [
                candidates[int(i * step)] for i in range(window)
            ]
        kept: list[dict[str, Any]] = []
        for entry in candidates:
            if len(kept) >= config.WIKIPEDIA_INVENTIONS_PER_PAGE:
                break
            try:
                summary_response = fetch(
                    config.WIKIPEDIA_REST_SUMMARY_TEMPLATE.format(
                        title=urllib.parse.quote(
                            entry["articleTitle"].replace(" ", "_")
                        )
                    ),
                    refresh=refresh, subdir="inventions/summaries",
                    expect_json=True,
                )
            except FetchError:
                continue
            summary = summary_response.read_json()
            if summary.get("type") not in ("standard", None):
                continue  # disambiguation or missing page: parse noise
            description = (summary.get("description") or "").lower()
            if any(k in description for k in config.FOOD_CLASS_LABEL_KEYWORDS):
                dropped_food += 1
                continue
            image = (summary.get("originalimage") or {}).get("source")
            if image:
                filename = _commons_filename_from_upload_url(image)
                if filename:
                    entry["file"] = filename
            # The article's own display title reads better than raw link
            # text ("LED" over "light-emitting diodes").
            display = (summary.get("title") or "").strip()
            if display:
                entry["name"] = display
            kept.append(entry)
        if kept:
            out.setdefault(iso3, []).extend(kept)
    return out, dropped_food


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

    # qid-level merge: OPTIONAL inventor/class multiply rows per item.
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
            "classes": set(),
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
        item_class = (row.get("class", {}).get("value") or "").rsplit("/", 1)[-1]
        if item_class.startswith("Q"):
            record["classes"].add(item_class)

    # Food and drink are NOT inventions for this section (maintainer ruling
    # 2026-08-24: Coca-Cola was listed beside the electric guitar). The
    # subclass test runs as its own query over the items' direct classes --
    # a P279* closure inside the main query's FILTER answers 504.
    # The ancestry test covers the items THEMSELVES too, not only their
    # classes: generic foods like "hot dog" carry no P31 at all -- they ARE
    # classes (P279 "sausage sandwich") and only the item's own ancestry
    # reveals them as food.
    all_classes = sorted(
        {c for r in by_item.values() for c in r["classes"]} | set(by_item)
    )
    food_classes: set[str] = set()
    for start in range(0, len(all_classes), config.FOOD_CLASS_BATCH):
        batch = all_classes[start:start + config.FOOD_CLASS_BATCH]
        values = " ".join(f"wd:{qid}" for qid in batch)
        # Net 1: classes that subclass food or drink.
        food_response = fetch(
            f"{config.WIKIDATA_SPARQL}?format=json&query="
            + urllib.parse.quote(
                config.WIKIDATA_FOOD_CLASSES_QUERY_TEMPLATE.format(qids=values)
            ),
            refresh=refresh, subdir="inventions", expect_json=True,
        )
        for row in food_response.read_json()["results"]["bindings"]:
            food_classes.add(
                (row.get("class", {}).get("value") or "").rsplit("/", 1)[-1]
            )
        # Net 2: classes whose label READS food-like -- brand items ("drink
        # brand") never subclass food, and Coca-Cola sailed through net 1.
        labels_response = fetch(
            f"{config.WIKIDATA_SPARQL}?format=json&query="
            + urllib.parse.quote(
                config.WIKIDATA_CLASS_LABELS_QUERY_TEMPLATE.format(qids=values)
            ),
            refresh=refresh, subdir="inventions", expect_json=True,
        )
        for row in labels_response.read_json()["results"]["bindings"]:
            label = (row.get("classLabel", {}).get("value") or "").lower()
            if any(k in label for k in config.FOOD_CLASS_LABEL_KEYWORDS):
                food_classes.add(
                    (row.get("class", {}).get("value") or "").rsplit("/", 1)[-1]
                )
    edible = [
        qid for qid, record in by_item.items()
        if record["classes"] & food_classes or qid in food_classes
    ]
    for qid in edible:
        del by_item[qid]

    by_country: dict[str, list[dict[str, Any]]] = {}
    for record in by_item.values():
        by_country.setdefault(record["iso3"], []).append(record)
    for records in by_country.values():
        records.sort(key=lambda r: (-r["links"], r["name"]))
        del records[config.INVENTIONS_TOP_N:]

    # Wikipedia's per-country list articles fill in what Wikidata's origin
    # tagging misses (2026-08-24) -- Wikidata entries lead, list entries
    # top the country up to the cap, deduplicated by name.
    wiki_by_country, wiki_dropped_food = _wikipedia_entries(
        registry, refresh=refresh
    )

    merged: dict[str, list[dict[str, Any]]] = {}
    for iso3 in sorted(set(by_country) | set(wiki_by_country)):
        entries: list[dict[str, Any]] = [
            {
                "name": r["name"],
                "inventors": r["inventors"][:3],
                "year": r["year"],
                "era": None,
                "file": r["file"],
                "source": "wikidata",
            }
            for r in by_country.get(iso3, [])
        ]
        names = {e["name"].casefold() for e in entries}
        for candidate in wiki_by_country.get(iso3, []):
            if len(entries) >= config.INVENTIONS_TOP_N:
                break
            if candidate["name"].casefold() in names:
                continue
            names.add(candidate["name"].casefold())
            entries.append({
                "name": candidate["name"],
                "inventors": candidate.get("inventors", []),
                "year": candidate.get("year"),
                "era": candidate.get("era"),
                "file": candidate.get("file"),
                "source": "wikipedia",
            })
        merged[iso3] = entries[:config.INVENTIONS_TOP_N]

    filenames = [
        r["file"]
        for records in merged.values()
        for r in records
        if r["file"]
    ]
    metadata, meta_responses = commons.fetch_metadata(
        filenames, refresh=refresh, subdir="inventions",
    )

    # Remove artifacts for countries no longer covered -- the food
    # exclusion legitimately dropped some, and a stale file would keep
    # serving Coca-Cola forever.
    for stale in out_dir.glob("*.json"):
        if stale.stem not in merged:
            stale.unlink()

    written = 0
    total = 0
    for iso3, records in sorted(merged.items()):
        items = []
        for record in records:
            item: dict[str, Any] = {
                "name": record["name"],
                "source": record["source"],
            }
            if record["inventors"]:
                item["inventors"] = record["inventors"][:3]
            if record["year"]:
                item["year"] = record["year"]
            elif record["era"]:
                item["era"] = record["era"]
            if record["file"]:
                image = commons.image_record(record["file"], metadata)
                if image:
                    item["image"] = image
            items.append(item)
        document = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": "wikidata_wikipedia",
            "note": (
                "Inventions with a recorded country of origin in Wikidata, "
                "topped up from the English Wikipedia's per-country "
                "invention list articles (CC BY-SA). Dates are recorded or "
                "parsed from prose and are often approximate; food and "
                "drink are excluded by ruling."
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
        title="Inventions: Wikidata origin tags + Wikipedia list articles",
        url=config.WIKIDATA_SPARQL,
        licence=(
            "Wikidata CC0; Wikipedia CC BY-SA 4.0; per-file Commons "
            "licences on images"
        ),
        fetched_at=max(
            r.fetched_at for r in [response, *meta_responses]
        ),
        upstream_release=None,
        vintage="as retrieved",
        citation=(
            "Wikidata (P495/P61/P575); English Wikipedia per-country "
            "invention lists; Wikimedia Commons"
        ),
        notes=(
            f"{written} countries with qualifying items, {total} inventions "
            f"({len(edible)} Wikidata food/drink items excluded by class, "
            f"{wiki_dropped_food} Wikipedia list entries excluded by "
            f"description). Wikidata origin tags plus "
            f"{len(config.WIKIPEDIA_INVENTION_LISTS)} curated Wikipedia "
            f"list articles."
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
    print(f"    inventions: {written} countries, {total} items "
          f"({len(edible)}+{wiki_dropped_food} food/drink excluded, "
          f"{len(wiki_by_country)} countries from Wikipedia lists)")


__all__ = ["ingest"]
