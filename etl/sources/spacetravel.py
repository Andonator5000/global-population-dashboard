"""Space Travel: editorial history, craft catalogue, people and diagrams.

Round 14 (DATA_DECISIONS section 74). The content is EDITORIAL and lives in
etl/reference/space_travel.json (bump `version` when editing); this stage
validates it, resolves one image per event, person and cutaway, DOWNLOADS
each one through a free-licence gate, re-encodes it, and writes

    data/space/travel/travel.json         the page payload
    data/space/travel/images/<file>.jpg   every served image, local
    data/space/travel/manifest.json       per-image provenance

Image resolution per item (the reference file pins one of these):

    commons   a Wikimedia Commons file -- must pass the free-licence gate
              (public domain, CC0, CC BY, CC BY-SA, Attribution; never
              NC/ND)
    nasaId    a NASA Image and Video Library item
    wikipedia the pinned Wikipedia article's lead image, through the same
              Commons licence gate (the default for events and portraits)
    null      explicitly no image, with a stated reason

Nothing is hotlinked at render time. A CUTAWAY that fails to resolve aborts
the stage -- the labelled plates are the point of the page. An event or
portrait that fails is logged, rendered as an explicit absence, and gated at
a coverage floor by scripts/check-spacetravel.mjs rather than failing the
build, because a Wikipedia lead image can legitimately be non-free.

The stage is fully cached after its first run: every network read goes
through etl.fetch with a content-derived cache filename under
.cache/spacetravel.
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

SUBDIR = "spacetravel"                 # .cache/spacetravel/
POLITE_SLEEP_SECONDS = 0.3

# Three image budgets: a cutaway must stay legible with numbered callouts
# over it, an event photograph is a card illustration, a portrait is small.
SIZES = {
    "cutaway": (1600, 1200, 85),
    "event": (860, 650, 80),
    "person": (560, 680, 80),
}
COMMONS_FETCH_WIDTH = {"cutaway": 1600, "event": 1100, "person": 700}

NASA_API = "https://images-api.nasa.gov"
NASA_LICENCE = ("NASA Image and Video Library media (NASA media usage "
                "guidelines; credited as the library credits it)")

CRAFT_TYPES = ("rocket", "crewed", "satellite", "probe", "station")
CRAFT_STATUSES = (
    "active", "retired", "cancelled", "in development", "deorbited",
    "re-entered", "mission ended", "contact lost", "derelict in orbit",
    "inoperative in orbit", "in solar orbit",
)
VERTICAL_SHAPES = ("cone", "cyl", "taper", "sphere", "dome")
SPAN_SHAPES = ("rect", "cyl", "disc", "rod", "cone", "kite")
PART_ROLES = ("body", "panel", "truss", "dish", "antenna", "radiator",
              "mirror", "shield")

BIO_WORDS = (50, 230)
EVENT_WORDS = (30, 140)
ERA_SUMMARY_WORDS = (15, 90)

# Commons licence short names that are FREE for our purposes (the same gate
# as the phenomena stage, section 46.2). NC and ND are excluded by the
# negative lookahead.
_FREE_LICENCE = re.compile(
    r"public domain|cc0|cc[- ]by(?![- ]n[cd])|pd-|^attribution$",
    re.IGNORECASE,
)
_RENDERABLE_MIME = {
    "image/jpeg", "image/png", "image/tiff", "image/svg+xml", "image/gif",
    "image/webp",
}


class SpaceTravelError(FetchError):
    """A reference-file or image problem; aborts the stage."""


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def _words(text: str) -> int:
    return len(text.split())


def _slug(value: Any) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"[a-z0-9][a-z0-9-]*", value))


def _https(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("https://")


def _check_sources(where: str, sources: Any, problems: list[str]) -> None:
    if not isinstance(sources, list) or not sources:
        problems.append(f"{where}: no sources")
        return
    for source in sources:
        if not source.get("title"):
            problems.append(f"{where}: source without a title")
        if not _https(source.get("url")):
            problems.append(f"{where}: source url is not https ({source.get('url')!r})")
        year = source.get("year")
        if year is not None and not (isinstance(year, int) and 1500 <= year <= 2100):
            problems.append(f"{where}: implausible source year {year!r}")


def _check_spec(where: str, key: str, spec: Any, problems: list[str]) -> None:
    if not isinstance(spec, dict):
        problems.append(f"{where}: spec {key} is not an object")
        return
    if spec.get("v") is None:
        # The missing-is-a-state rule: null WITH a reason, never zero.
        if not spec.get("why"):
            problems.append(f"{where}: spec {key} is null with no reason")
        return
    if spec["v"] == 0:
        problems.append(f"{where}: spec {key} is zero; use null with a reason")
    if not spec.get("src"):
        problems.append(f"{where}: spec {key} has no source")
    if not _https(spec.get("url")):
        problems.append(f"{where}: spec {key} source url is not https")


def _check_silhouette(craft: dict[str, Any], problems: list[str]) -> None:
    sil = craft.get("silhouette")
    cid = craft["id"]
    if sil is None:
        return
    axis = sil.get("axis")
    specs = craft.get("specs") or {}

    def published(*keys: str) -> list[float]:
        out = []
        for key in keys:
            spec = specs.get(key)
            if isinstance(spec, dict) and isinstance(spec.get("v"), (int, float)):
                out.append(float(spec["v"]))
        return out

    if axis == "vertical":
        sections = sil.get("sections")
        if not isinstance(sections, list) or not sections:
            problems.append(f"craft {cid}: vertical silhouette has no sections")
            return
        total = 0.0
        for section in sections:
            if section.get("s") not in VERTICAL_SHAPES:
                problems.append(f"craft {cid}: unknown section shape {section.get('s')!r}")
            for key in ("len", "d0", "d1"):
                if not isinstance(section.get(key), (int, float)):
                    problems.append(f"craft {cid}: section {key} is not a number")
            total += float(section.get("len") or 0)
        height = sil.get("heightM")
        if not isinstance(height, (int, float)) or height <= 0:
            problems.append(f"craft {cid}: silhouette heightM missing")
            return
        if abs(total - height) / height > 0.06:
            problems.append(
                f"craft {cid}: section lengths sum to {total:.1f} m but the "
                f"silhouette is {height} m (over 6% apart)")
        candidates = published("heightM", "lengthM")
        if not any(abs(height - c) / max(height, c) <= 0.02 for c in candidates):
            if not sil.get("heightNote"):
                problems.append(
                    f"craft {cid}: silhouette heightM {height} matches no "
                    f"published height and carries no heightNote")
    elif axis == "span":
        parts = sil.get("parts")
        if not isinstance(parts, list) or not parts:
            problems.append(f"craft {cid}: span silhouette has no parts")
            return
        for part in parts:
            if part.get("s") not in SPAN_SHAPES:
                problems.append(f"craft {cid}: unknown part shape {part.get('s')!r}")
            if part.get("r") not in PART_ROLES:
                problems.append(f"craft {cid}: unknown part role {part.get('r')!r}")
            for key in ("x", "y", "w", "h"):
                if not isinstance(part.get(key), (int, float)):
                    problems.append(f"craft {cid}: part {key} is not a number")
        span = sil.get("spanM")
        if not isinstance(span, (int, float)) or span <= 0:
            problems.append(f"craft {cid}: silhouette spanM missing")
            return
        candidates = published("spanM", "lengthM", "widthM", "diameterM")
        if not any(abs(span - c) / max(span, c) <= 0.02 for c in candidates):
            if not sil.get("spanNote"):
                problems.append(
                    f"craft {cid}: silhouette spanM {span} matches no published "
                    f"dimension and carries no spanNote")
    else:
        problems.append(f"craft {cid}: silhouette axis {axis!r} is not vertical or span")


def _validate(source: dict[str, Any]) -> None:
    problems: list[str] = []

    if not isinstance(source.get("version"), int):
        problems.append("top level: `version` must be an integer")
    for key in ("note", "sourcingPolicy", "imageNote", "eraNote"):
        if not source.get(key):
            problems.append(f"top level: `{key}` missing")

    eras = source.get("eras") or []
    era_ids: set[str] = set()
    if not eras:
        problems.append("top level: no eras")
    for era in eras:
        eid = era.get("id")
        where = f"era {eid}"
        if not _slug(eid) or eid in era_ids:
            problems.append(f"{where}: bad or duplicate id")
        era_ids.add(eid)
        for key in ("label", "dateLabel", "summary"):
            if not era.get(key):
                problems.append(f"{where}: {key} missing")
        if not isinstance(era.get("from"), int) or not isinstance(era.get("to"), int):
            problems.append(f"{where}: from/to must be integers")
        elif era["from"] >= era["to"]:
            problems.append(f"{where}: from is not before to")
        hue = era.get("hue")
        if not isinstance(hue, (int, float)) or not 0 <= hue <= 360:
            problems.append(f"{where}: hue must be 0-360")
        if era.get("summary") and not (
                ERA_SUMMARY_WORDS[0] <= _words(era["summary"]) <= ERA_SUMMARY_WORDS[1]):
            problems.append(
                f"{where}: summary is {_words(era['summary'])} words "
                f"(want {ERA_SUMMARY_WORDS[0]}-{ERA_SUMMARY_WORDS[1]})")
        _check_sources(where, era.get("sources"), problems)

    refs = source.get("scaleReferences") or []
    ref_ids = {r.get("id") for r in refs}
    for ref in refs:
        where = f"scale reference {ref.get('id')}"
        if not _slug(ref.get("id")):
            problems.append(f"{where}: bad id")
        if not isinstance(ref.get("heightM"), (int, float)) or ref["heightM"] <= 0:
            problems.append(f"{where}: heightM missing")
        if not ref.get("label") or not ref.get("note"):
            problems.append(f"{where}: label/note missing")
        _check_sources(where, [ref.get("source")] if ref.get("source") else None, problems)

    craft_list = source.get("craft") or []
    craft_ids: set[str] = set()
    craft_by_id: dict[str, dict[str, Any]] = {}
    for craft in craft_list:
        cid = craft.get("id")
        where = f"craft {cid}"
        if not _slug(cid) or cid in craft_ids:
            problems.append(f"{where}: bad or duplicate id")
        craft_ids.add(cid)
        craft_by_id[cid] = craft
        for key in ("name", "country", "organisation", "summary", "wikipedia"):
            if not craft.get(key):
                problems.append(f"{where}: {key} missing")
        if craft.get("type") not in CRAFT_TYPES:
            problems.append(f"{where}: type {craft.get('type')!r} unknown")
        if craft.get("status") not in CRAFT_STATUSES:
            problems.append(f"{where}: status {craft.get('status')!r} unknown")
        for key in ("firstFlight", "lastFlight"):
            value = craft.get(key)
            if value is not None and not re.fullmatch(r"\d{4}(-\d{2}(-\d{2})?)?", str(value)):
                problems.append(f"{where}: {key} {value!r} is not a date")
        specs = craft.get("specs")
        if not isinstance(specs, dict) or not specs:
            problems.append(f"{where}: no specs")
        else:
            for key, spec in specs.items():
                _check_spec(where, key, spec, problems)
        _check_sources(where, craft.get("sources"), problems)
        _check_silhouette(craft, problems)

    people = source.get("people") or []
    person_ids: set[str] = set()
    for person in people:
        pid = person.get("id")
        where = f"person {pid}"
        if not _slug(pid) or pid in person_ids:
            problems.append(f"{where}: bad or duplicate id")
        person_ids.add(pid)
        for key in ("name", "lifeDisplay", "nationality", "role", "bio", "wikipedia"):
            if not person.get(key):
                problems.append(f"{where}: {key} missing")
        if not isinstance(person.get("born"), int):
            problems.append(f"{where}: born must be an integer year")
        died = person.get("died")
        if died is not None and not isinstance(died, int):
            problems.append(f"{where}: died must be an integer year or null")
        if person.get("bio") and not (
                BIO_WORDS[0] <= _words(person["bio"]) <= BIO_WORDS[1]):
            problems.append(
                f"{where}: bio is {_words(person['bio'])} words "
                f"(want {BIO_WORDS[0]}-{BIO_WORDS[1]})")
        if len(person.get("knownFor") or []) < 1:
            problems.append(f"{where}: knownFor is empty")
        for cid in person.get("craft") or []:
            if cid not in craft_ids:
                problems.append(f"{where}: unknown craft {cid}")
        _check_sources(where, person.get("sources"), problems)

    for craft in craft_list:
        for pid in craft.get("designers") or []:
            if pid not in person_ids:
                problems.append(f"craft {craft.get('id')}: unknown designer {pid}")

    events = source.get("events") or []
    event_ids: set[str] = set()
    for event in events:
        eid = event.get("id")
        where = f"event {eid}"
        if not _slug(eid) or eid in event_ids:
            problems.append(f"{where}: bad or duplicate id")
        event_ids.add(eid)
        if event.get("era") not in era_ids:
            problems.append(f"{where}: unknown era {event.get('era')!r}")
        for key in ("dateDisplay", "title", "text", "wikipedia"):
            if not event.get(key):
                problems.append(f"{where}: {key} missing")
        year = event.get("year")
        if not isinstance(year, int) or not 100 <= year <= 2030:
            problems.append(f"{where}: year {year!r} outside 100-2030")
        if event.get("text") and not (
                EVENT_WORDS[0] <= _words(event["text"]) <= EVENT_WORDS[1]):
            problems.append(
                f"{where}: text is {_words(event['text'])} words "
                f"(want {EVENT_WORDS[0]}-{EVENT_WORDS[1]})")
        for cid in event.get("craft") or []:
            if cid not in craft_ids:
                problems.append(f"{where}: unknown craft {cid}")
        for pid in event.get("people") or []:
            if pid not in person_ids:
                problems.append(f"{where}: unknown person {pid}")
        _check_sources(where, event.get("sources"), problems)

    plates = source.get("plates") or []
    for plate in plates:
        where = f"plate {plate.get('id')}"
        if not _slug(plate.get("id")):
            problems.append(f"{where}: bad id")
        if plate.get("kind") not in ("vertical", "span"):
            problems.append(f"{where}: kind {plate.get('kind')!r} unknown")
        for key in ("title", "intro", "note"):
            if not plate.get(key):
                problems.append(f"{where}: {key} missing")
        if len(plate.get("items") or []) < 2:
            problems.append(f"{where}: needs at least two items")
        for cid in plate.get("items") or []:
            craft = craft_by_id.get(cid)
            if craft is None:
                problems.append(f"{where}: unknown craft {cid}")
                continue
            sil = craft.get("silhouette")
            if not sil:
                problems.append(f"{where}: craft {cid} has no silhouette")
            elif sil.get("axis") != plate["kind"]:
                problems.append(
                    f"{where}: craft {cid} silhouette axis {sil.get('axis')!r} "
                    f"does not match plate kind {plate['kind']!r}")
            if not craft.get("drawing", {}).get("title"):
                problems.append(f"{where}: craft {cid} cites no reference drawing")
        for rid in plate.get("scaleRefs") or []:
            if rid not in ref_ids:
                problems.append(f"{where}: unknown scale reference {rid}")

    cutaways = source.get("cutaways") or []
    cut_ids: set[str] = set()
    for cut in cutaways:
        cuid = cut.get("id")
        where = f"cutaway {cuid}"
        if not _slug(cuid) or cuid in cut_ids:
            problems.append(f"{where}: bad or duplicate id")
        cut_ids.add(cuid)
        if cut.get("craft") not in craft_ids:
            problems.append(f"{where}: unknown craft {cut.get('craft')!r}")
        if not cut.get("commons"):
            problems.append(f"{where}: no Commons file pinned")
        if not cut.get("title") or not cut.get("note"):
            problems.append(f"{where}: title/note missing")
        overlay = cut.get("overlay")
        if not isinstance(overlay, bool):
            problems.append(f"{where}: overlay must be true or false")
        callouts = cut.get("callouts") or []
        seen_marks: set[str] = set()
        for callout in callouts:
            if not callout.get("label") or not callout.get("note"):
                problems.append(f"{where}: callout without label/note")
            mark = callout.get("n", callout.get("key"))
            if mark is None or str(mark) in seen_marks:
                problems.append(f"{where}: callout mark {mark!r} missing or duplicated")
            seen_marks.add(str(mark))
            if overlay:
                for axis in ("x", "y"):
                    value = callout.get(axis)
                    if not isinstance(value, (int, float)) or not 0 <= value <= 1:
                        problems.append(
                            f"{where}: callout {mark} {axis}={value!r} is not a "
                            f"fraction of the image")
        if overlay and not callouts:
            problems.append(f"{where}: overlay is on but there are no callouts")
        _check_sources(where, cut.get("sources"), problems)

    if problems:
        listing = "\n  ".join(problems[:40])
        more = "" if len(problems) <= 40 else f"\n  ... and {len(problems) - 40} more"
        raise SpaceTravelError(
            f"space_travel.json has {len(problems)} problem(s):\n  {listing}{more}")


# --------------------------------------------------------------------------
# Image resolution (the licence gate)
# --------------------------------------------------------------------------

def _polite(response: CachedResponse) -> CachedResponse:
    if not response.from_cache:
        time.sleep(POLITE_SLEEP_SECONDS)
    return response


def _key(value: str) -> str:
    """Content-derived cache filename fragment (never positional)."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _nasa_image(nasa_id: str, *, refresh: bool,
                responses: list[CachedResponse]) -> dict[str, Any] | None:
    search = _polite(fetch(
        f"{NASA_API}/search?nasa_id={urllib.parse.quote(nasa_id)}",
        refresh=refresh, subdir=SUBDIR,
        filename=f"nasa-item-{_key(nasa_id)}.json", expect_json=True,
    ))
    responses.append(search)
    item = None
    for candidate in search.read_json().get("collection", {}).get("items", []):
        data = (candidate.get("data") or [{}])[0]
        if data.get("nasa_id") == nasa_id:
            item = {"data": data, "links": candidate.get("links") or []}
            break
    if item is None:
        return None
    asset = _polite(fetch(
        f"{NASA_API}/asset/{urllib.parse.quote(nasa_id)}",
        refresh=refresh, subdir=SUBDIR,
        filename=f"nasa-asset-{_key(nasa_id)}.json", expect_json=True,
    ))
    responses.append(asset)
    hrefs = [row.get("href") or "" for row in
             asset.read_json().get("collection", {}).get("items", [])]
    url = None
    for tag in ("~large.jpg", "~medium.jpg", "~orig.jpg", "~small.jpg",
                "~orig.png", "~medium.png"):
        for href in hrefs:
            if href.lower().endswith(tag):
                url = href
                break
        if url:
            break
    if url is None:
        url = next((l.get("href") for l in item["links"]
                    if l.get("rel") == "preview"), None)
    if not url:
        return None
    # The library sometimes serves hrefs as plain http though the same host
    # answers https; normalise so nothing is fetched or recorded insecurely
    # (the same upstream quirk as section 46.3).
    if url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    data = item["data"]
    return {
        "source": "NASA Image and Video Library",
        "sourceUrl": url,
        "sourcePage": f"https://images.nasa.gov/details/{urllib.parse.quote(nasa_id)}",
        "sourceId": nasa_id,
        "title": data.get("title") or nasa_id,
        "credit": data.get("secondary_creator") or data.get("center") or "NASA",
        "licence": NASA_LICENCE,
    }


def _commons_image(filename: str, *, kind: str, refresh: bool,
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
        rejects.append(f"{filename}: licence {licence or 'unrecorded'!r} is not free")
        return None
    mime = record.get("mime") or ""
    if mime not in _RENDERABLE_MIME:
        rejects.append(f"{filename}: mime {mime!r} is not a renderable image")
        return None
    author = record.get("author") or ""
    author = re.sub(r"\s*[-–—]\s*null\s*$", "", author, flags=re.I).strip()
    return {
        "source": "Wikimedia Commons",
        "sourceUrl": commons.image_url_for(filename, COMMONS_FETCH_WIDTH[kind]),
        "sourcePage": commons.file_page_for(filename),
        "sourceId": filename,
        "title": record.get("objectName") or filename.rsplit(".", 1)[0],
        "credit": author or "Wikimedia Commons contributor",
        "licence": licence,
    }


def _wikipedia_lead(title: str, *, refresh: bool,
                    responses: list[CachedResponse]) -> str | None:
    response = _polite(fetch(
        f"{config.WIKIPEDIA_API_URL}?action=query&format=json"
        f"&prop=pageimages&piprop=name&redirects=1"
        f"&titles={urllib.parse.quote(title)}",
        refresh=refresh, subdir=SUBDIR,
        filename=f"wiki-lead-{_key(title)}.json", expect_json=True,
    ))
    responses.append(response)
    pages = response.read_json().get("query", {}).get("pages", {})
    return next((p.get("pageimage") for p in pages.values() if p.get("pageimage")),
                None)


def _resolve(spec: dict[str, Any] | None, wikipedia: str, *, kind: str,
             label: str, refresh: bool, responses: list[CachedResponse],
             rejects: list[str]) -> tuple[dict[str, Any] | None, str]:
    """(image record, how). `spec` None means: fall back to the article lead."""
    if spec is not None and spec.get("commons"):
        return (_commons_image(spec["commons"], kind=kind, refresh=refresh,
                               responses=responses, rejects=rejects), "commons")
    if spec is not None and spec.get("nasaId"):
        image = _nasa_image(spec["nasaId"], refresh=refresh, responses=responses)
        if image is None:
            rejects.append(f"{label}: NASA id {spec['nasaId']} not found")
        return image, "nasaId"
    filename = _wikipedia_lead(wikipedia, refresh=refresh, responses=responses)
    if not filename:
        rejects.append(f"{label}: Wikipedia article '{wikipedia}' has no lead image")
        return None, "wikipedia"
    return (_commons_image(filename, kind=kind, refresh=refresh,
                           responses=responses, rejects=rejects), "wikipedia")


# --------------------------------------------------------------------------
# Download + re-encode
# --------------------------------------------------------------------------

def _encode(raw: bytes, *, kind: str, context: str) -> tuple[bytes, int, int]:
    from PIL import Image, ImageOps

    max_w, max_h, quality = SIZES[kind]
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
            img.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            img.save(out, format="JPEG", quality=quality, optimize=True,
                     progressive=True)
            return out.getvalue(), img.width, img.height
    except Exception as exc:  # noqa: BLE001 - any decode failure is fatal here
        raise SpaceTravelError(
            f"{context}: downloaded image does not decode ({exc!r})") from exc


def _download(image: dict[str, Any], target: Path, *, kind: str, refresh: bool,
              responses: list[CachedResponse], context: str) -> dict[str, Any]:
    response = _polite(fetch(image["sourceUrl"], refresh=refresh, subdir=SUBDIR,
                             filename=f"img-{_key(image['sourceUrl'])}"))
    responses.append(response)
    raw = response.read_bytes()
    if not raw:
        raise SpaceTravelError(f"{context}: {image['sourceUrl']} is empty")
    encoded, width, height = _encode(raw, kind=kind, context=context)
    floor = 400 if kind == "cutaway" else 160
    if width < floor or height < 120:
        raise SpaceTravelError(
            f"{context}: image is only {width}x{height} after encoding "
            f"(a {kind} needs at least {floor} px wide)")
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
        (config.REFERENCE_DIR / "space_travel.json").read_text("utf-8"))
    _validate(source)

    img_dir = out_dir / "images"
    img_dir.mkdir(parents=True, exist_ok=True)

    responses: list[CachedResponse] = []
    rejects: list[str] = []
    manifest_images: list[dict[str, Any]] = []
    by_how: dict[str, int] = {}
    keep = {"manifest.json"}

    def take(kind: str, item_id: str, spec: dict[str, Any] | None,
             wikipedia: str, label: str) -> dict[str, Any] | None:
        image, how = _resolve(spec, wikipedia, kind=kind, label=label,
                              refresh=refresh, responses=responses,
                              rejects=rejects)
        if image is None:
            return None
        basename = f"{kind}-{item_id}.jpg"
        stats = _download(image, img_dir / basename, kind=kind, refresh=refresh,
                          responses=responses, context=label)
        keep.add(basename)
        by_how[how] = by_how.get(how, 0) + 1
        file_rel = f"space/travel/images/{basename}"
        manifest_images.append({
            "id": f"{kind}:{item_id}",
            "file": file_rel,
            "kind": kind,
            "resolvedVia": how,
            "source": image["source"],
            "sourceId": image["sourceId"],
            "sourceUrl": image["sourceUrl"],
            "sourcePage": image["sourcePage"],
            "title": image["title"],
            "author": image["credit"],
            "licence": image["licence"],
            "creditLine": f"{image['title']} — {image['credit']} · {image['licence']}",
            **stats,
        })
        return {
            "file": file_rel,
            "width": stats["width"],
            "height": stats["height"],
            "title": image["title"],
            "credit": image["credit"],
            "licence": image["licence"],
            "source": image["source"],
            "page": image["sourcePage"],
        }

    # --- cutaways first: a failure here aborts the run -------------------
    out_cutaways: list[dict[str, Any]] = []
    for cut in source["cutaways"]:
        image = take("cutaway", cut["id"], {"commons": cut["commons"]},
                     cut["commons"], f"cutaway {cut['id']}")
        if image is None:
            raise SpaceTravelError(
                f"cutaway {cut['id']}: the pinned Commons file "
                f"{cut['commons']!r} did not clear the licence gate "
                f"({rejects[-1] if rejects else 'unknown'}). Pin a different "
                f"free drawing; the page does not ship an unlabelled plate.")
        out_cutaways.append({
            "id": cut["id"],
            "title": cut["title"],
            "craft": cut["craft"],
            "note": cut["note"],
            "overlay": cut["overlay"],
            "sourceLabelled": bool(cut.get("sourceLabelled")),
            "callouts": cut.get("callouts") or [],
            "image": image,
            "sources": cut["sources"],
        })

    # --- events -----------------------------------------------------------
    out_events: list[dict[str, Any]] = []
    for event in sorted(source["events"], key=lambda e: (e["year"], e["id"])):
        spec = event.get("image")
        image = None
        if spec is None or spec.get("wikipedia") or spec.get("commons") or spec.get("nasaId"):
            if spec is not None and spec.get("none"):
                image = None
            else:
                image = take("event", event["id"],
                             None if (spec or {}).get("wikipedia") else spec,
                             event["wikipedia"], f"event {event['id']}")
        out_events.append({
            "id": event["id"],
            "era": event["era"],
            "year": event["year"],
            "dateDisplay": event["dateDisplay"],
            "title": event["title"],
            "text": event["text"],
            "craft": event.get("craft") or [],
            "people": event.get("people") or [],
            "vintage": event.get("vintage"),
            "wikipedia": "https://en.wikipedia.org/wiki/"
            + urllib.parse.quote(event["wikipedia"].replace(" ", "_")),
            "image": image,
            "imageNote": None if image else
            "No free image was available for this event.",
            "sources": event["sources"],
        })

    # --- people -----------------------------------------------------------
    out_people: list[dict[str, Any]] = []
    for person in source["people"]:
        portrait = take("person", person["id"], person.get("portrait"),
                        person["wikipedia"], f"person {person['id']}")
        out_people.append({
            "id": person["id"],
            "name": person["name"],
            "born": person["born"],
            "died": person.get("died"),
            "lifeDisplay": person["lifeDisplay"],
            "nationality": person["nationality"],
            "role": person["role"],
            "bio": person["bio"],
            "knownFor": person.get("knownFor") or [],
            "craft": person.get("craft") or [],
            "wikipedia": "https://en.wikipedia.org/wiki/"
            + urllib.parse.quote(person["wikipedia"].replace(" ", "_")),
            "portrait": portrait,
            "portraitNote": None if portrait else
            "No free-licensed portrait of this person could be found.",
            "sources": person["sources"],
        })

    # --- craft, plates, eras pass through -------------------------------
    designers_by_craft: dict[str, list[str]] = {
        c["id"]: list(c.get("designers") or []) for c in source["craft"]}
    for person in source["people"]:
        for cid in person.get("craft") or []:
            if person["id"] not in designers_by_craft.get(cid, []):
                designers_by_craft.setdefault(cid, []).append(person["id"])

    out_craft = []
    for craft in source["craft"]:
        out_craft.append({
            "id": craft["id"],
            "name": craft["name"],
            "type": craft["type"],
            "country": craft["country"],
            "organisation": craft["organisation"],
            "designers": craft.get("designers") or [],
            "people": designers_by_craft.get(craft["id"], []),
            "firstFlight": craft.get("firstFlight"),
            "lastFlight": craft.get("lastFlight"),
            "status": craft["status"],
            "summary": craft["summary"],
            "specs": craft["specs"],
            "silhouette": craft.get("silhouette"),
            "drawing": craft.get("drawing"),
            "wikipedia": "https://en.wikipedia.org/wiki/"
            + urllib.parse.quote(craft["wikipedia"].replace(" ", "_")),
            "sources": craft["sources"],
        })

    # Orphans from removed or renamed entries must not linger in /data.
    for stale in img_dir.iterdir():
        if stale.name not in keep:
            stale.unlink()

    events_by_era: dict[str, int] = {}
    for event in out_events:
        events_by_era[event["era"]] = events_by_era.get(event["era"], 0) + 1
    craft_by_type: dict[str, int] = {}
    for craft in out_craft:
        craft_by_type[craft["type"]] = craft_by_type.get(craft["type"], 0) + 1

    payload = {
        "source": "editorial",
        "version": source["version"],
        "note": source["note"],
        "sourcingPolicy": source["sourcingPolicy"],
        "imageNote": source["imageNote"],
        "eraNote": source["eraNote"],
        "eras": source["eras"],
        "scaleReferences": source["scaleReferences"],
        "plates": source["plates"],
        "craft": out_craft,
        "people": out_people,
        "events": out_events,
        "cutaways": out_cutaways,
        "counts": {
            "eras": len(source["eras"]),
            "events": len(out_events),
            "craft": len(out_craft),
            "people": len(out_people),
            "cutaways": len(out_cutaways),
            "plates": len(source["plates"]),
            "eventsByEra": events_by_era,
            "craftByType": craft_by_type,
            "images": len(manifest_images),
        },
    }
    (out_dir / "travel.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n")

    (out_dir / "manifest.json").write_text(
        json.dumps({
            "note": (
                "Provenance for every image under data/space/travel/images/. "
                "Files are re-encoded JPEGs of the sourceUrl rendition "
                "(cutaways up to 1600x1200, event photographs 960x720, "
                "portraits 640x760); the licence is the source's own. NASA "
                "library items are NASA media unless the credit names a "
                "partner; Commons files passed the free-licence gate (PD, "
                "CC0, CC BY, CC BY-SA, Attribution -- never NC or ND)."
            ),
            "images": manifest_images,
        }, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n")

    summary = {
        "version": source["version"],
        "eras": len(source["eras"]),
        "events": len(out_events),
        "events_with_image": sum(1 for e in out_events if e["image"]),
        "craft": len(out_craft),
        "craft_by_type": craft_by_type,
        "people": len(out_people),
        "people_with_portrait": sum(1 for p in out_people if p["portrait"]),
        "cutaways": len(out_cutaways),
        "plates": len(source["plates"]),
        "images": len(manifest_images),
        "images_by_source": by_how,
        "image_bytes": sum(m["bytes"] for m in manifest_images),
        "rejects": rejects,
    }
    print(f"    spacetravel: {summary['events']} events, {summary['craft']} craft, "
          f"{summary['people']} people, {summary['cutaways']} cutaways; "
          f"{summary['images']} images via {by_how}; "
          f"{summary['image_bytes'] / 1e6:.2f} MB", flush=True)
    return responses, summary


def ingest(registry: dict[str, Entity], *, refresh: bool,
           manifest: dict[str, Any]) -> None:
    del registry
    out_dir = config.DATA_DIR / "space" / "travel"
    out_dir.mkdir(parents=True, exist_ok=True)
    responses, summary = build(refresh, out_dir)

    log_dir = config.REPO_ROOT / "etl" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / "spacetravel.log").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n")

    fetched_at = (max(r.fetched_at for r in responses) if responses
                  else manifest["generated_at"])
    manifest_mod.record_source(
        manifest,
        "space_travel",
        title="Space Travel (editorial) with downloaded NASA/Commons imagery",
        url="https://images.nasa.gov",
        licence="Editorial text CC0 (this project); images NASA media or "
                "Commons free licences, credited per item "
                "(data/space/travel/manifest.json)",
        fetched_at=fetched_at,
        upstream_release=None,
        vintage="per figure (each spec and source carries its own year)",
        citation="NASA, NSSDCA, ESA, ISRO, JAXA, CNSA and Wikimedia Commons; "
                 "per-figure agency pages and Wikipedia articles",
        notes=(
            f"{summary['events']} events across {summary['eras']} eras, "
            f"{summary['craft']} craft, {summary['people']} people, "
            f"{summary['cutaways']} labelled cutaways and "
            f"{summary['plates']} scale plates; "
            f"{summary['images']} images resolved via "
            f"{summary['images_by_source']}. Scale diagrams are generated "
            f"from published dimensions in the reference file, not traced."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "space/travel/travel.json",
        description="Space Travel: eras, events, craft specifications, "
                    "people, scale-diagram geometry and labelled cutaways.",
        sources=["space_travel"], row_count=summary["events"],
    )
    manifest_mod.record_artifact(
        manifest, "space/travel/images/",
        description="Licence-gated images for the Space Travel page "
                    "(cutaway drawings, event photographs, portraits) with "
                    "per-image provenance in manifest.json.",
        sources=["space_travel"], row_count=summary["images"],
    )


__all__ = ["ingest", "build"]
