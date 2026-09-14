"""Human Anatomy: editorial reference + downloaded, licence-gated diagrams.

Round 6 (DATA_DECISIONS.md section 55). The prose lives in
etl/reference/anatomy.json (built by etl/reference/build_anatomy.py) --
systems, organs, the whole-body layers and the "how they work together"
notes, each with its OpenStax chapter citation. This stage validates
that file, resolves every diagram on Wikimedia Commons through the same
free-licence gate the phenomena stage uses, downloads the ORIGINAL file
(SVG stays SVG: the diagrams are line art, and a raster copy would blur
their labels), records author/licence/credit line per image, and emits:

    data/anatomy/anatomy.json          the reference with local image refs
    data/anatomy/images/<id>.<ext>     one file per layer/figure
    data/anatomy/images/manifest.json  provenance per image

A reference problem or a failed image aborts the stage: the page does
not ship an unillustrated layer or an uncredited figure.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import time
from pathlib import Path
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch
from . import commons

SUBDIR = "anatomy"
_FREE_LICENCE = re.compile(
    r"public domain|cc0|cc[- ]by(?![- ]n[cd])|pd-|^attribution$",
    re.IGNORECASE,
)
_KEEP_MIME = {"image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg"}
# Originals above this are re-fetched as a 1600 px rendition.
ORIGINAL_MAX_BYTES = 2_500_000
RENDER_WIDTH = 1600
MIN_WORDS = {"system": 240, "organ": 40, "cooperation": 60}


class AnatomyError(FetchError):
    """A reference or image problem; aborts the stage."""


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def _words(text: str) -> int:
    return len(text.split())


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AnatomyError(f"anatomy.json: {message}")


def _validate(doc: dict[str, Any]) -> None:
    for key in ("layers", "figures", "systems", "organs", "cooperation"):
        _require(isinstance(doc.get(key), list) and doc[key], f"`{key}` missing or empty")
    systems = {s["id"]: s for s in doc["systems"]}
    organs = {o["id"]: o for o in doc["organs"]}
    _require(len(systems) == len(doc["systems"]), "duplicate system id")
    _require(len(organs) == len(doc["organs"]), "duplicate organ id")
    for system in doc["systems"]:
        sid = system["id"]
        for field in ("name", "summary", "description", "functions", "organs", "worksWith", "source"):
            _require(field in system, f"system {sid} lacks {field}")
        _require(_words(" ".join(system["description"])) >= MIN_WORDS["system"],
                 f"system {sid}: description under {MIN_WORDS['system']} words")
        _require(system["source"].get("url", "").startswith("https://"),
                 f"system {sid}: no source URL")
        for oid in system["organs"]:
            _require(oid in organs, f"system {sid} lists unknown organ {oid}")
        for link in system["worksWith"]:
            _require(link.get("system") in systems and link["system"] != sid,
                     f"system {sid}: bad worksWith {link!r}")
            _require(_words(link.get("how", "")) >= 6, f"system {sid}: worksWith text too short")
    for organ in doc["organs"]:
        oid = organ["id"]
        for field in ("name", "systems", "location", "description", "function", "facts", "source"):
            _require(field in organ, f"organ {oid} lacks {field}")
        _require(_words(" ".join(organ["description"])) >= MIN_WORDS["organ"],
                 f"organ {oid}: description under {MIN_WORDS['organ']} words")
        _require(organ["source"].get("url", "").startswith("https://"), f"organ {oid}: no source URL")
        for sid in organ["systems"]:
            _require(sid in systems, f"organ {oid}: unknown system {sid}")
        # An organ is listed by its first system; that system must list it
        # back, or the reader could never reach it.
        first = organ["systems"][0]
        _require(oid in systems[first]["organs"],
                 f"organ {oid}: primary system {first} does not list it")
        for fact in organ["facts"]:
            _require(fact.get("label") and fact.get("value"), f"organ {oid}: bad fact {fact!r}")
    seen_layer_systems: set[str] = set()
    for item in doc["layers"] + doc["figures"]:
        _require(item.get("id") and item.get("commons") and item.get("caption"),
                 f"layer/figure {item!r} incomplete")
        _require(item["system"] in systems, f"layer {item['id']}: unknown system")
    for layer in doc["layers"]:
        seen_layer_systems.add(layer["system"])
    for note in doc["cooperation"]:
        _require(note.get("title") and _words(note.get("text", "")) >= MIN_WORDS["cooperation"],
                 f"cooperation note {note.get('title')!r} too short")
        for sid in note["systems"]:
            _require(sid in systems, f"cooperation {note['title']}: unknown system {sid}")
    # Every system is reachable from a layer or a figure.
    figured = seen_layer_systems | {f["system"] for f in doc["figures"]}
    missing = sorted(set(systems) - figured)
    _require(not missing, f"systems without a diagram: {missing}")


# --------------------------------------------------------------------------
# Images
# --------------------------------------------------------------------------

def _polite(response: CachedResponse) -> CachedResponse:
    if not response.from_cache:
        time.sleep(0.5)
    return response


def _original_url(filename: str) -> str:
    import urllib.parse
    return ("https://commons.wikimedia.org/wiki/Special:FilePath/"
            + urllib.parse.quote(filename))


def _check_decodes(raw: bytes, ext: str, context: str) -> tuple[int, int]:
    if ext == "svg":
        head = raw[:4096].decode("utf-8", "replace")
        if "<svg" not in head:
            raise AnatomyError(f"{context}: downloaded file is not an SVG")
        m_w = re.search(r'\bwidth="([\d.]+)', head)
        m_h = re.search(r'\bheight="([\d.]+)', head)
        m_vb = re.search(r'viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"', head)
        if m_vb:
            return int(float(m_vb.group(1))), int(float(m_vb.group(2)))
        if m_w and m_h:
            return int(float(m_w.group(1))), int(float(m_h.group(1)))
        return 0, 0
    from PIL import Image
    try:
        with Image.open(io.BytesIO(raw)) as img:
            img.verify()
        with Image.open(io.BytesIO(raw)) as img:
            return img.width, img.height
    except Exception as exc:  # noqa: BLE001
        raise AnatomyError(f"{context}: downloaded image does not decode ({exc!r})") from exc


def _resolve(item: dict[str, Any], img_dir: Path, *, refresh: bool,
             responses: list[CachedResponse]) -> dict[str, Any]:
    filename = item["commons"].replace("_", " ")
    context = item["id"]
    metadata, meta_responses = commons.fetch_metadata([filename], refresh=refresh, subdir=SUBDIR)
    responses.extend(meta_responses)
    record = metadata.get(filename)
    if not record:
        raise AnatomyError(f"{context}: {filename!r} is not on Commons")
    licence = record.get("license") or ""
    if not _FREE_LICENCE.search(licence):
        raise AnatomyError(f"{context}: {filename!r} licence {licence or 'unrecorded'!r} is not free")
    mime = record.get("mime") or ""
    ext = _KEEP_MIME.get(mime)
    if not ext:
        raise AnatomyError(f"{context}: {filename!r} mime {mime!r} is not svg/png/jpeg")
    # First line only: some Commons author fields carry paragraphs of reuse
    # boilerplate after the name. An editorial `author` in the reference
    # wins where Commons' template leaves the field empty.
    author = (record.get("author") or "").split("\n")[0]
    author = re.sub(r"\s*[-–—]\s*null\s*$", "", author, flags=re.I).strip().rstrip(".")
    author = item.get("author") or author
    url = _original_url(filename)
    response = _polite(fetch(url, refresh=refresh, subdir=SUBDIR))
    responses.append(response)
    raw = response.read_bytes()
    if not raw:
        raise AnatomyError(f"{context}: {url} is empty")
    if ext != "svg" and len(raw) > ORIGINAL_MAX_BYTES:
        url = commons.image_url_for(filename, RENDER_WIDTH)
        response = _polite(fetch(url, refresh=refresh, subdir=SUBDIR))
        responses.append(response)
        raw = response.read_bytes()
        ext = "png" if mime == "image/png" else "jpg"
    width, height = _check_decodes(raw, ext, context)
    target = img_dir / f"{context}.{ext}"
    target.write_bytes(raw)
    credit = author or "Wikimedia Commons contributor"
    return {
        "id": context,
        "file": f"anatomy/images/{context}.{ext}",
        "source": "Wikimedia Commons",
        "sourceId": filename,
        "sourceUrl": url,
        "sourcePage": commons.file_page_for(filename),
        "title": record.get("objectName") or filename.rsplit(".", 1)[0],
        "author": credit,
        "licence": licence,
        "creditLine": f"{filename.rsplit('.', 1)[0]} — {credit} · {licence} · Wikimedia Commons",
        "width": width or record.get("width") or 0,
        "height": height or record.get("height") or 0,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


# --------------------------------------------------------------------------
# Stage
# --------------------------------------------------------------------------

def build(refresh: bool, out_dir: Path) -> tuple[list[CachedResponse], dict[str, Any]]:
    doc = json.loads((config.REFERENCE_DIR / "anatomy.json").read_text("utf-8"))
    _validate(doc)
    img_dir = out_dir / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    responses: list[CachedResponse] = []
    images: list[dict[str, Any]] = []

    def attach(item: dict[str, Any]) -> dict[str, Any]:
        image = _resolve(item, img_dir, refresh=refresh, responses=responses)
        images.append(image)
        return {
            "id": item["id"], "label": item.get("label"), "system": item["system"],
            "caption": item["caption"],
            "image": {k: image[k] for k in ("file", "width", "height", "title", "author",
                                             "licence", "creditLine", "sourcePage")},
        }

    layers = [attach(layer) for layer in doc["layers"]]
    figures = [attach(fig) for fig in doc["figures"]]
    (img_dir / "manifest.json").write_text(
        json.dumps({"images": images, "note": (
            "Original Commons files (SVG kept as SVG); each passed the "
            "free-licence gate (PD, CC0, CC BY, CC BY-SA, Attribution) and is "
            "credited per image on the page.")}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n")
    out = {
        "version": doc["version"],
        "note": doc["note"],
        "layers": layers,
        "figures": figures,
        "systems": doc["systems"],
        "organs": doc["organs"],
        "cooperation": doc["cooperation"],
    }
    (out_dir / "anatomy.json").write_text(
        json.dumps(out, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    words = sum(_words(" ".join(s["description"])) for s in doc["systems"]) + \
        sum(_words(" ".join(o["description"])) for o in doc["organs"]) + \
        sum(_words(c["text"]) for c in doc["cooperation"])
    summary = {
        "systems": len(doc["systems"]), "organs": len(doc["organs"]),
        "layers": len(layers), "figures": len(figures),
        "cooperation": len(doc["cooperation"]), "words": words,
        "images": [{"id": i["id"], "licence": i["licence"], "author": i["author"],
                    "bytes": i["bytes"]} for i in images],
        "image_bytes": sum(i["bytes"] for i in images),
    }
    print(f"    anatomy: {summary['systems']} systems, {summary['organs']} organs, "
          f"{summary['layers']} layers + {summary['figures']} figures, ~{words} words, "
          f"{summary['image_bytes'] / 1e6:.2f} MB of diagrams", flush=True)
    return responses, summary


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry
    out_dir = config.DATA_DIR / "anatomy"
    out_dir.mkdir(parents=True, exist_ok=True)
    responses, summary = build(refresh, out_dir)

    log_dir = config.REPO_ROOT / "etl" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / "anatomy.log").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n")

    fetched_at = max(r.fetched_at for r in responses) if responses else manifest["generated_at"]
    manifest_mod.record_source(
        manifest, "anatomy",
        title="Human Anatomy (editorial, after OpenStax Anatomy and Physiology 2e) with Commons diagrams",
        url="https://openstax.org/books/anatomy-and-physiology-2e/pages/1-introduction",
        licence="Editorial text CC0 (this project), paraphrasing OpenStax A&P 2e (CC BY 4.0); "
                "diagrams Wikimedia Commons free licences, credited per image "
                "(data/anatomy/images/manifest.json)",
        fetched_at=fetched_at, upstream_release=None, vintage="OpenStax A&P 2e (2022)",
        citation="OpenStax, Anatomy and Physiology 2e (Rice University, CC BY 4.0); "
                 "Wikimedia Commons diagrams by LadyofHats, Mikael Häggström, NCI and others",
        notes=(f"{summary['systems']} systems, {summary['organs']} organs, "
               f"{summary['layers']} whole-body layers, ~{summary['words']} words."),
    )
    manifest_mod.record_artifact(
        manifest, "anatomy/anatomy.json",
        description="Human Anatomy reference: layered diagrams, systems, organs and "
                    "how they work together, with per-entry sources and image credits.",
        sources=["anatomy"], row_count=summary["organs"],
    )
    manifest_mod.record_artifact(
        manifest, "anatomy/images/",
        description="Original Commons diagrams (SVG/PNG) plus manifest.json with provenance.",
        sources=["anatomy"], row_count=summary["layers"] + summary["figures"],
    )


__all__ = ["ingest", "build"]
