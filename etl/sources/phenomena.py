"""Cosmic Phenomena: editorial catalogue + downloaded, licence-gated images.

Round-3 phase 6 (DATA_DECISIONS §46). The entries are EDITORIAL and live in
etl/reference/cosmic_phenomena.json (bump `version` when editing); this
stage validates them, resolves one image per entry, DOWNLOADS it, re-encodes
it to a bounded JPEG under data/space/phenomena/, and writes

    data/space/phenomena.json           entries + facts + image references
    data/space/phenomena/<id>.jpg       one served-locally image per entry
    data/space/phenomena/manifest.json  per-image provenance (source URL,
                                        author/credit, licence, credit line)

Image resolution order per entry (the reference pins one of these):

    nasaId   a NASA Image and Video Library item -- credited as the library
             credits it (secondary_creator / center)
    commons  a Wikimedia Commons file -- must pass the free-licence gate
             (public domain, CC0, CC BY, CC BY-SA, Attribution; never NC/ND)
    query    a NASA library search; the first hit with a preview is used,
             then fetched by its nasa_id like a pin (phrasing-sensitive,
             which is why pins are preferred)
    (none)   the Wikipedia article's lead image through the same Commons
             licence gate

An entry that resolves NO image aborts the stage: the page never ships an
unillustrated card, and scripts/check-phenomena.mjs re-verifies every file
decodes. Nothing here is hotlinked at render time.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import time
import urllib.parse
from pathlib import Path
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch
from . import commons

SUBDIR = "space/phenomena"            # .cache/<SUBDIR>/ for every download
IMAGE_MAX_WIDTH = 960
IMAGE_MAX_HEIGHT = 720
JPEG_QUALITY = 82
COMMONS_FETCH_WIDTH = 1200            # Commons renders SVG/TIFF to raster
POLITE_SLEEP_SECONDS = 0.3            # after every UNCACHED network fetch

STATUSES = ("observed", "theoretical", "hypothesis")
DESCRIPTION_WORDS = (55, 130)
DESCRIPTION_SENTENCES = (3, 6)
MIN_FACTS = 3
FACT_YEAR_RANGE = (1600, 2026)

NASA_API = "https://images-api.nasa.gov"
NASA_LICENCE = ("NASA Image and Video Library media (NASA media usage "
                "guidelines; credited as the library credits it)")

# Commons licence short names that are FREE for our purposes. `Attribution`
# is Commons' {{Attribution}} template (attribution-only, no other
# restriction). NC and ND are excluded by the negative lookahead.
_FREE_LICENCE = re.compile(
    r"public domain|cc0|cc[- ]by(?![- ]n[cd])|pd-|^attribution$",
    re.IGNORECASE,
)
# Commons renders every one of these to a raster thumbnail via
# Special:FilePath?width=; videos, PDFs and the like are refused.
_RENDERABLE_MIME = {
    "image/jpeg", "image/png", "image/tiff", "image/svg+xml", "image/gif",
    "image/webp",
}


class PhenomenaError(FetchError):
    """A reference-file or image-resolution problem; aborts the stage."""


# --------------------------------------------------------------------------
# Reference validation
# --------------------------------------------------------------------------

def _sentence_count(text: str) -> int:
    # Terminal punctuation followed by whitespace or end of text. Good enough
    # for plain encyclopaedic prose; abbreviations are rare in this file.
    return len(re.findall(r"[.!?](?:['\")”]*)(?:\s|$)", text))


def _validate(source: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    categories = source.get("categories")
    if not isinstance(categories, list) or not categories:
        raise PhenomenaError("cosmic_phenomena: `categories` missing")
    cat_labels: dict[str, str] = {}
    for cat in categories:
        if not cat.get("id") or not cat.get("label"):
            raise PhenomenaError(f"cosmic_phenomena: bad category {cat!r}")
        if cat["id"] in cat_labels:
            raise PhenomenaError(f"cosmic_phenomena: duplicate category {cat['id']}")
        cat_labels[cat["id"]] = cat["label"]

    entries = source.get("entries")
    if not isinstance(entries, list) or not entries:
        raise PhenomenaError("cosmic_phenomena: `entries` missing")
    seen: set[str] = set()
    for entry in entries:
        eid = entry.get("id")
        if not eid or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", eid):
            raise PhenomenaError(f"cosmic_phenomena: bad id {eid!r}")
        if eid in seen:
            raise PhenomenaError(f"cosmic_phenomena: duplicate id {eid}")
        seen.add(eid)
        for key in ("title", "category", "status", "wikipedia", "nasa",
                    "description", "facts"):
            if not entry.get(key):
                raise PhenomenaError(f"cosmic_phenomena: {eid} missing {key}")
        if entry["category"] not in cat_labels:
            raise PhenomenaError(
                f"cosmic_phenomena: {eid} has unknown category "
                f"{entry['category']!r}")
        if entry["status"] not in STATUSES:
            raise PhenomenaError(
                f"cosmic_phenomena: {eid} has status {entry['status']!r}; "
                f"want one of {STATUSES}")
        if entry["status"] != "observed":
            # Non-observed entries must SAY so in their own text (§41.3).
            text = (entry["title"] + " " + entry["description"]).lower()
            if not re.search(r"hypothe|theor|never been observed|not been"
                             r" confirmed|none has been confirmed|unconfirmed"
                             r"|inferred", text):
                raise PhenomenaError(
                    f"cosmic_phenomena: {eid} is {entry['status']} but its "
                    f"text does not say so")
        if not entry["nasa"].startswith("https://"):
            raise PhenomenaError(f"cosmic_phenomena: {eid} nasa link not https")
        words = len(entry["description"].split())
        if not DESCRIPTION_WORDS[0] <= words <= DESCRIPTION_WORDS[1]:
            raise PhenomenaError(
                f"cosmic_phenomena: {eid} description is {words} words "
                f"(want {DESCRIPTION_WORDS[0]}-{DESCRIPTION_WORDS[1]})")
        sentences = _sentence_count(entry["description"])
        if not DESCRIPTION_SENTENCES[0] <= sentences <= DESCRIPTION_SENTENCES[1]:
            raise PhenomenaError(
                f"cosmic_phenomena: {eid} description has {sentences} "
                f"sentences (want {DESCRIPTION_SENTENCES[0]}-"
                f"{DESCRIPTION_SENTENCES[1]})")
        facts = entry["facts"]
        if not isinstance(facts, list) or len(facts) < MIN_FACTS:
            raise PhenomenaError(
                f"cosmic_phenomena: {eid} needs at least {MIN_FACTS} facts")
        for fact in facts:
            for key in ("value", "source", "url", "year"):
                if key not in fact or fact[key] in (None, ""):
                    raise PhenomenaError(
                        f"cosmic_phenomena: {eid} fact missing {key}: {fact!r}")
            if not str(fact["url"]).startswith("https://"):
                raise PhenomenaError(
                    f"cosmic_phenomena: {eid} fact url not https: {fact['url']}")
            year = fact["year"]
            if not isinstance(year, int) or not (
                    FACT_YEAR_RANGE[0] <= year <= FACT_YEAR_RANGE[1]):
                raise PhenomenaError(
                    f"cosmic_phenomena: {eid} fact year {year!r} outside "
                    f"{FACT_YEAR_RANGE}")
        pins = [k for k in ("nasaId", "commons", "query") if entry.get(k)]
        if len(pins) > 1:
            raise PhenomenaError(
                f"cosmic_phenomena: {eid} pins more than one image source "
                f"({', '.join(pins)}); pick one")
    return entries, cat_labels


# --------------------------------------------------------------------------
# Image resolution
# --------------------------------------------------------------------------

def _polite(response: CachedResponse) -> CachedResponse:
    if not response.from_cache:
        time.sleep(POLITE_SLEEP_SECONDS)
    return response


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:80]


def _nasa_item(nasa_id: str, *, refresh: bool,
               responses: list[CachedResponse]) -> dict[str, Any] | None:
    """The library's metadata record for one item (title, creator, date)."""
    response = _polite(fetch(
        f"{NASA_API}/search?nasa_id={urllib.parse.quote(nasa_id)}",
        refresh=refresh, subdir=SUBDIR,
        filename=f"nasa-item-{_safe(nasa_id)}.json", expect_json=True,
    ))
    responses.append(response)
    items = response.read_json().get("collection", {}).get("items", [])
    for item in items:
        data = (item.get("data") or [{}])[0]
        if data.get("nasa_id") == nasa_id:
            return {"data": data, "links": item.get("links") or []}
    return None


def _nasa_asset_url(nasa_id: str, *, refresh: bool,
                    responses: list[CachedResponse]) -> str | None:
    """Best served rendition: ~medium, else ~small, else ~large/orig jpg."""
    response = _polite(fetch(
        f"{NASA_API}/asset/{urllib.parse.quote(nasa_id)}",
        refresh=refresh, subdir=SUBDIR,
        filename=f"nasa-asset-{_safe(nasa_id)}.json", expect_json=True,
    ))
    responses.append(response)
    hrefs = [item.get("href") or "" for item in
             response.read_json().get("collection", {}).get("items", [])]
    for tag in ("~medium.jpg", "~small.jpg", "~large.jpg", "~orig.jpg",
                "~medium.png", "~small.png", "~orig.png"):
        for href in hrefs:
            if href.lower().endswith(tag):
                # The library's asset API sometimes serves hrefs as plain
                # http even though the CDN answers https on the same host
                # (verified) -- normalise so nothing is fetched or recorded
                # as an insecure URL.
                if href.startswith("http://"):
                    href = "https://" + href[len("http://"):]
                return href
    return None


def _nasa_image(nasa_id: str, *, refresh: bool,
                responses: list[CachedResponse]) -> dict[str, Any] | None:
    item = _nasa_item(nasa_id, refresh=refresh, responses=responses)
    if item is None:
        return None
    data = item["data"]
    url = _nasa_asset_url(nasa_id, refresh=refresh, responses=responses)
    if url is None:
        url = next((l.get("href") for l in item["links"]
                    if l.get("rel") == "preview"), None)
    if not url:
        return None
    if url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    return {
        "source": "NASA Image and Video Library",
        "sourceUrl": url,
        "sourcePage": f"https://images.nasa.gov/details/"
                      f"{urllib.parse.quote(nasa_id)}",
        "sourceId": nasa_id,
        "title": data.get("title") or nasa_id,
        "credit": (data.get("secondary_creator") or data.get("center")
                   or "NASA"),
        "licence": NASA_LICENCE,
        "dateCreated": (data.get("date_created") or "")[:10] or None,
    }


def _nasa_search(query: str, *, refresh: bool,
                 responses: list[CachedResponse]) -> str | None:
    digest = hashlib.sha256(query.encode("utf-8")).hexdigest()[:10]
    response = _polite(fetch(
        f"{NASA_API}/search?media_type=image&q="
        + urllib.parse.quote(query),
        refresh=refresh, subdir=SUBDIR,
        filename=f"nasa-search-{digest}.json", expect_json=True,
    ))
    responses.append(response)
    for item in response.read_json().get("collection", {}).get("items", []):
        data = (item.get("data") or [{}])[0]
        preview = next((l.get("href") for l in (item.get("links") or [])
                        if l.get("rel") == "preview"), None)
        if preview and data.get("nasa_id"):
            return data["nasa_id"]
    return None


def _commons_image(filename: str, *, refresh: bool,
                   responses: list[CachedResponse],
                   rejects: list[str]) -> dict[str, Any] | None:
    filename = filename.replace("_", " ")
    metadata, meta_responses = commons.fetch_metadata(
        [filename], refresh=refresh, subdir=SUBDIR)
    responses.extend(meta_responses)
    record = metadata.get(filename)
    if not record:
        rejects.append(f"{filename}: not on Commons")
        return None
    licence = record.get("license") or ""
    if not _FREE_LICENCE.search(licence):
        rejects.append(f"{filename}: licence {licence or 'unrecorded'!r} "
                       f"is not free")
        return None
    mime = record.get("mime") or ""
    if mime not in _RENDERABLE_MIME:
        rejects.append(f"{filename}: mime {mime!r} is not a renderable image")
        return None
    author = record.get("author") or ""
    # A handful of Commons pages render an unfilled template field as the
    # literal word "null" (e.g. "NASA's Scientific Visualization Studio -
    # null") -- a known upstream authoring bug, not a real name. Trim only
    # that exact trailing artefact; never invent a credit that isn't there.
    author = re.sub(r"\s*[-–—]\s*null\s*$", "", author, flags=re.I).strip()
    return {
        "source": "Wikimedia Commons",
        "sourceUrl": commons.image_url_for(filename, COMMONS_FETCH_WIDTH),
        "sourcePage": commons.file_page_for(filename),
        "sourceId": filename,
        "title": record.get("objectName") or filename.rsplit(".", 1)[0],
        "credit": author or "Wikimedia Commons contributor",
        "licence": licence,
        "dateCreated": None,
    }


def _wikipedia_lead_filename(title: str, *, refresh: bool,
                             responses: list[CachedResponse]) -> str | None:
    response = _polite(fetch(
        f"{config.WIKIPEDIA_API_URL}?action=query&format=json"
        f"&prop=pageimages&piprop=name&redirects=1"
        f"&titles={urllib.parse.quote(title)}",
        refresh=refresh, subdir=SUBDIR, expect_json=True,
    ))
    responses.append(response)
    pages = response.read_json().get("query", {}).get("pages", {})
    return next((p.get("pageimage") for p in pages.values()
                 if p.get("pageimage")), None)


def _resolve_image(entry: dict[str, Any], *, refresh: bool,
                   responses: list[CachedResponse],
                   rejects: list[str]) -> tuple[dict[str, Any] | None, str]:
    """(image record, how) -- how is the pin kind that produced it."""
    eid = entry["id"]
    if entry.get("nasaId"):
        image = _nasa_image(entry["nasaId"], refresh=refresh,
                            responses=responses)
        if image is None:
            rejects.append(f"{eid}: NASA id {entry['nasaId']} not found")
        return image, "nasaId"
    if entry.get("commons"):
        return _commons_image(entry["commons"], refresh=refresh,
                              responses=responses, rejects=rejects), "commons"
    if entry.get("query"):
        nasa_id = _nasa_search(entry["query"], refresh=refresh,
                               responses=responses)
        if nasa_id:
            image = _nasa_image(nasa_id, refresh=refresh, responses=responses)
            if image is not None:
                return image, "query"
        rejects.append(f"{eid}: NASA query {entry['query']!r} found nothing")
        return None, "query"
    filename = _wikipedia_lead_filename(entry["wikipedia"], refresh=refresh,
                                        responses=responses)
    if not filename:
        rejects.append(f"{eid}: Wikipedia article has no lead image")
        return None, "wikipedia"
    return _commons_image(filename, refresh=refresh, responses=responses,
                          rejects=rejects), "wikipedia"


# --------------------------------------------------------------------------
# Download + re-encode
# --------------------------------------------------------------------------

def _encode(raw: bytes, *, context: str) -> tuple[bytes, int, int]:
    """Bounded, progressive JPEG; alpha composited onto white."""
    from PIL import Image, ImageOps

    try:
        with Image.open(io.BytesIO(raw)) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode in ("RGBA", "LA") or (
                    img.mode == "P" and "transparency" in img.info):
                rgba = img.convert("RGBA")
                base = Image.new("RGB", rgba.size, (255, 255, 255))
                base.paste(rgba, mask=rgba.getchannel("A"))
                img = base
            else:
                img = img.convert("RGB")
            img.thumbnail((IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT),
                          Image.Resampling.LANCZOS)
            out = io.BytesIO()
            img.save(out, format="JPEG", quality=JPEG_QUALITY,
                     optimize=True, progressive=True)
            return out.getvalue(), img.width, img.height
    except Exception as exc:  # noqa: BLE001 - any decode failure aborts
        raise PhenomenaError(f"{context}: downloaded image does not decode "
                             f"({exc!r})") from exc


def _download(image: dict[str, Any], target: Path, *, refresh: bool,
              responses: list[CachedResponse], context: str
              ) -> dict[str, Any]:
    response = _polite(fetch(image["sourceUrl"], refresh=refresh,
                             subdir=SUBDIR))
    responses.append(response)
    raw = response.read_bytes()
    if not raw:
        raise PhenomenaError(f"{context}: {image['sourceUrl']} is empty")
    encoded, width, height = _encode(raw, context=context)
    if width < 200 or height < 120:
        raise PhenomenaError(
            f"{context}: image is only {width}x{height} after encoding")
    target.write_bytes(encoded)
    return {
        "width": width, "height": height, "bytes": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }


# --------------------------------------------------------------------------
# Stage
# --------------------------------------------------------------------------

def build(refresh: bool, out_dir: Path) -> tuple[list[CachedResponse], dict[str, Any]]:
    source = json.loads(
        (config.REFERENCE_DIR / "cosmic_phenomena.json").read_text("utf-8")
    )
    entries, cat_labels = _validate(source)
    img_dir = out_dir / "phenomena"
    img_dir.mkdir(parents=True, exist_ok=True)

    responses: list[CachedResponse] = []
    rejects: list[str] = []
    out_entries: list[dict[str, Any]] = []
    manifest_images: list[dict[str, Any]] = []
    by_how: dict[str, int] = {}

    for entry in entries:
        eid = entry["id"]
        image, how = _resolve_image(entry, refresh=refresh,
                                    responses=responses, rejects=rejects)
        if image is None:
            raise PhenomenaError(
                f"{eid}: no image resolved via {how} -- {rejects[-1] if rejects else 'unknown'}. "
                f"Pin a different nasaId/commons file; the page does not ship "
                f"unillustrated cards.")
        target = img_dir / f"{eid}.jpg"
        stats = _download(image, target, refresh=refresh,
                          responses=responses, context=eid)
        by_how[how] = by_how.get(how, 0) + 1
        file_rel = f"space/phenomena/{eid}.jpg"
        credit_line = f"{image['title']} — {image['credit']} · {image['licence']}"
        manifest_images.append({
            "id": eid,
            "file": file_rel,
            "resolvedVia": how,
            "source": image["source"],
            "sourceId": image["sourceId"],
            "sourceUrl": image["sourceUrl"],
            "sourcePage": image["sourcePage"],
            "title": image["title"],
            "author": image["credit"],
            "licence": image["licence"],
            "creditLine": credit_line,
            "dateCreated": image.get("dateCreated"),
            **stats,
        })
        out_entries.append({
            "id": eid,
            "title": entry["title"],
            "category": entry["category"],
            "status": entry["status"],
            "description": entry["description"],
            "facts": [
                {"value": f["value"], "source": f["source"], "url": f["url"],
                 "year": f["year"]} for f in entry["facts"]
            ],
            "image": {
                "file": file_rel,
                "width": stats["width"],
                "height": stats["height"],
                "title": image["title"],
                "credit": image["credit"],
                "licence": image["licence"],
                "source": image["source"],
                "page": image["sourcePage"],
            },
            "wikipedia": "https://en.wikipedia.org/wiki/"
            + urllib.parse.quote(entry["wikipedia"].replace(" ", "_")),
            "nasa": entry["nasa"],
        })

    # Orphans from removed/renamed entries must not linger in /data.
    keep = {f"{e['id']}.jpg" for e in entries} | {"manifest.json"}
    for stale in img_dir.iterdir():
        if stale.name not in keep:
            stale.unlink()

    counts_by_category: dict[str, int] = {}
    counts_by_status: dict[str, int] = {}
    for e in out_entries:
        counts_by_category[e["category"]] = counts_by_category.get(e["category"], 0) + 1
        counts_by_status[e["status"]] = counts_by_status.get(e["status"], 0) + 1

    (out_dir / "phenomena.json").write_text(
        json.dumps({
            "source": "editorial",
            "version": source.get("version", 1),
            "note": (
                "Editorial catalogue (etl/reference/cosmic_phenomena.json). "
                "Each fact carries its own source, URL and year -- the year "
                "is the vintage of the figure (measurement, event or "
                "publication), or the year the cited page was consulted for "
                "undated encyclopaedic values. `status` separates what has "
                "been observed from theory and hypothesis."
            ),
            "imageNote": (
                "Images are downloaded at build time and served from this "
                "site: NASA Image and Video Library media (NASA/ESA and "
                "partners), or Wikimedia Commons files that passed a "
                "free-licence gate -- credited per item; provenance in "
                "space/phenomena/manifest.json."
            ),
            "categories": [{"id": k, "label": v} for k, v in cat_labels.items()],
            "statuses": [
                {"id": "observed", "label": "Observed",
                 "note": "Directly observed and well established."},
                {"id": "theoretical", "label": "Theoretical",
                 "note": "A firm prediction of established physics, or an "
                         "inference from indirect evidence, not yet directly "
                         "observed."},
                {"id": "hypothesis", "label": "Hypothesis",
                 "note": "A proposed idea without confirming evidence; "
                         "presented as such."},
            ],
            "entries": out_entries,
        }, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    (img_dir / "manifest.json").write_text(
        json.dumps({
            "note": (
                "Provenance for every image under data/space/phenomena/. "
                "Files are re-encoded JPEGs (max "
                f"{IMAGE_MAX_WIDTH}x{IMAGE_MAX_HEIGHT}, quality "
                f"{JPEG_QUALITY}) of the sourceUrl rendition; the licence is "
                "the source's own. NASA library items are NASA media unless "
                "the credit names a partner; Commons files passed the "
                "free-licence gate (PD, CC0, CC BY, CC BY-SA, Attribution)."
            ),
            "images": manifest_images,
        }, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    summary = {
        "entries": len(out_entries),
        "by_category": counts_by_category,
        "by_status": counts_by_status,
        "images_by_source": by_how,
        "image_bytes": sum(m["bytes"] for m in manifest_images),
        "rejects": rejects,
    }
    print(f"    phenomena: {len(out_entries)} entries; images via {by_how}; "
          f"{summary['image_bytes'] / 1e6:.2f} MB", flush=True)
    return responses, summary


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry
    out_dir = config.DATA_DIR / "space"
    out_dir.mkdir(parents=True, exist_ok=True)
    responses, summary = build(refresh, out_dir)

    log_dir = config.REPO_ROOT / "etl" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / "phenomena.log").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    fetched_at = max(r.fetched_at for r in responses) if responses else (
        manifest["generated_at"])
    manifest_mod.record_source(
        manifest,
        "cosmic_phenomena",
        title="Cosmic Phenomena (editorial) with downloaded NASA/Commons images",
        url="https://images.nasa.gov",
        licence="Editorial text CC0 (this project); images NASA media or "
                "Commons free licences, credited per item "
                "(data/space/phenomena/manifest.json)",
        fetched_at=fetched_at,
        upstream_release=None,
        vintage="per fact (year field)",
        citation="NASA Image and Video Library; Wikimedia Commons; per-fact "
                 "NASA science pages and Wikipedia articles",
        notes=(
            f"{summary['entries']} entries "
            f"({summary['by_status']}); images resolved via "
            f"{summary['images_by_source']}. Theoretical objects and "
            f"hypotheses carry a status flag and say so in their own text."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "space/phenomena.json",
        description="Cosmic Phenomena catalogue: categorised, status-flagged "
                    "entries with per-fact sources and local image references.",
        sources=["cosmic_phenomena"], row_count=summary["entries"],
    )
    manifest_mod.record_artifact(
        manifest, "space/phenomena/",
        description="One re-encoded JPEG per phenomenon plus manifest.json "
                    "(source URL, author, licence, credit line per image).",
        sources=["cosmic_phenomena"], row_count=summary["entries"],
    )


__all__ = ["ingest", "build"]
