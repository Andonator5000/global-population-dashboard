"""Human History timeline: editorial events, build-time images (Phase 3).

The event list is EDITORIAL and versioned: `etl/reference/history_events.json`
is hand-curated (title, dates with their precision, category, a 60-100 word
summary that says so when a date is contested, sources, regions, and the
English Wikipedia article that anchors the event). Nothing is scraped at
runtime.

This stage validates that file (schema, categories, regional balance, word
counts) and resolves each event's IMAGE at build time: the anchor article's
lead image via the Wikipedia pageimages API, then the file's licence and
author from the Commons API. Only public-domain or Creative Commons files
are kept -- an event whose lead image is non-free ships without one. The
output is `data/history/events.json`, which the app reads like any other
artifact.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch
from . import commons

_SOURCE = config.REFERENCE_DIR / "history_events.json"

CATEGORIES = (
    "evolution-prehistory",
    "invention-technology",
    "scientific-discovery",
    "other-discovery",
    "war-conflict",
    "religion",
    "rights-document",
)
PRECISIONS = ("exact", "decade", "century", "millennium", "approximate")
REGIONS = (
    "Africa", "Europe", "West Asia", "South Asia", "East Asia",
    "Southeast Asia", "Central Asia", "North America", "Mesoamerica",
    "South America", "Oceania", "Global",
)
_FREE = re.compile(r"public domain|cc0|cc[- ]by(?![- ]n[cd])|pd-", re.IGNORECASE)


def _validate(events: list[dict[str, Any]]) -> list[str]:
    problems: list[str] = []
    ids: set[str] = set()
    for e in events:
        eid = e.get("id")
        if not eid or eid in ids:
            problems.append(f"duplicate or missing id: {eid!r}")
        ids.add(eid)
        for key in ("title", "startYear", "datePrecision", "category", "summary", "sources", "regions", "wikipedia"):
            if key not in e:
                problems.append(f"{eid}: missing {key}")
        if e.get("category") not in CATEGORIES:
            problems.append(f"{eid}: unknown category {e.get('category')!r}")
        if e.get("datePrecision") not in PRECISIONS:
            problems.append(f"{eid}: unknown datePrecision {e.get('datePrecision')!r}")
        if not isinstance(e.get("startYear"), int):
            problems.append(f"{eid}: startYear must be an integer year (negative = BCE)")
        end = e.get("endYear")
        if end is not None and (not isinstance(end, int) or end < e.get("startYear", 0)):
            problems.append(f"{eid}: endYear must be null or >= startYear")
        words = len((e.get("summary") or "").split())
        if not 55 <= words <= 110:
            problems.append(f"{eid}: summary is {words} words (want 60-100)")
        if not e.get("sources"):
            problems.append(f"{eid}: no sources")
        for r in e.get("regions") or []:
            if r not in REGIONS:
                problems.append(f"{eid}: unknown region {r!r}")
    return problems


def _lead_images(
    titles: list[str], *, refresh: bool
) -> tuple[dict[str, str], list[CachedResponse]]:
    out: dict[str, str] = {}
    responses: list[CachedResponse] = []
    ordered = sorted(set(titles))
    for start in range(0, len(ordered), 20):
        batch = ordered[start:start + 20]
        url = (
            f"{config.WIKIPEDIA_API_URL}?action=query&format=json"
            f"&prop=pageimages&piprop=name&redirects=1"
            f"&titles={urllib.parse.quote('|'.join(batch))}"
        )
        response = fetch(url, refresh=refresh, subdir="history", expect_json=True)
        responses.append(response)
        payload = response.read_json().get("query", {})
        back = {r["to"]: r["from"] for r in payload.get("redirects", [])}
        norm = {n["to"]: n["from"] for n in payload.get("normalized", [])}
        for page in payload.get("pages", {}).values():
            title = page.get("title") or ""
            image = page.get("pageimage")
            if not image:
                continue
            original = norm.get(back.get(title, title), back.get(title, title))
            for key in {title, original}:
                out[key.replace("_", " ")] = image.replace("_", " ")
    return out, responses


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry  # global history is not keyed by entity
    out_dir = config.DATA_DIR / "history"
    out_dir.mkdir(parents=True, exist_ok=True)

    source = json.loads(_SOURCE.read_text("utf-8"))
    events: list[dict[str, Any]] = source["events"]
    problems = _validate(events)
    if problems:
        raise FetchError(
            "history_events.json failed validation:\n  " + "\n  ".join(problems[:20])
        )

    lead, lead_responses = _lead_images(
        [e["wikipedia"] for e in events], refresh=refresh,
    )
    filenames = sorted({lead[e["wikipedia"]] for e in events if e["wikipedia"] in lead})
    metadata, meta_responses = commons.fetch_metadata(
        filenames, refresh=refresh, subdir="history",
    )

    with_image = 0
    nonfree: list[str] = []
    out_events: list[dict[str, Any]] = []
    for e in sorted(events, key=lambda x: (x["startYear"], x["title"])):
        record = {
            "id": e["id"],
            "title": e["title"],
            "startYear": e["startYear"],
            "endYear": e.get("endYear"),
            "datePrecision": e["datePrecision"],
            "category": e["category"],
            "summary": e["summary"].strip(),
            "image": None,
            "sources": e["sources"],
            "regions": e["regions"],
            "wikipedia": f"https://en.wikipedia.org/wiki/{urllib.parse.quote(e['wikipedia'].replace(' ', '_'))}",
        }
        filename = lead.get(e["wikipedia"])
        if filename and filename in metadata:
            licence = metadata[filename].get("license") or ""
            if _FREE.search(licence):
                record["image"] = {
                    "url": commons.image_url_for(filename, 640),
                    "license": licence,
                    "attribution": metadata[filename].get("author"),
                    "commonsPage": commons.file_page_for(filename),
                }
                with_image += 1
            else:
                nonfree.append(f"{e['id']} ({licence or 'no licence recorded'})")
        out_events.append(record)

    by_region: dict[str, int] = {}
    by_category: dict[str, int] = {}
    for e in out_events:
        by_category[e["category"]] = by_category.get(e["category"], 0) + 1
        for r in e["regions"]:
            by_region[r] = by_region.get(r, 0) + 1

    document = {
        "source": "editorial",
        "version": source.get("version", 1),
        "note": source.get("note", ""),
        "categories": list(CATEGORIES),
        "regions": list(REGIONS),
        "counts": {"events": len(out_events), "byCategory": by_category, "byRegion": by_region},
        "imageNote": (
            "Images are the lead image of each event's English Wikipedia "
            "article, kept only when Wikimedia Commons records a public-domain "
            "or Creative Commons licence; attribution is rendered with each."
        ),
        "events": out_events,
    }
    (out_dir / "events.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "history_events",
        title="Human History timeline (editorial) with Commons images",
        url="https://commons.wikimedia.org",
        licence="Editorial text CC0 (this project); images per-file PD/CC (attributed)",
        fetched_at=max(r.fetched_at for r in [*lead_responses, *meta_responses]) if (lead_responses or meta_responses) else manifest["generated_at"],
        upstream_release=None,
        vintage=f"events file version {source.get('version', 1)}",
        citation="etl/reference/history_events.json; Wikimedia Commons",
        notes=(
            f"{len(out_events)} events, {with_image} with a free image; "
            f"{len(nonfree)} lead images skipped as non-free."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "history/events.json",
        description="Curated global human-history events with dates, precision, category, summary, sources, regions and attributed images.",
        sources=["history_events"], row_count=len(out_events),
    )
    if nonfree:
        manifest_mod.add_warning(
            manifest,
            f"history: {len(nonfree)} event lead images are not free-licensed and were omitted: "
            f"{', '.join(nonfree[:10])}{'...' if len(nonfree) > 10 else ''}.",
        )
    print(f"    history: {len(out_events)} events, {with_image} with free images, "
          f"{len(nonfree)} non-free skipped")


__all__ = ["ingest"]
