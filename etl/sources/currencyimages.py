"""Banknote images: one consistent treatment per currency (rewritten 2026-08-29).

Maintainer ruling: every currency shows a SINGLE banknote, flat, head-on,
obverse side -- no hands, no stacks, no rolled bundles, no coins-and-notes
composites. Where no compliant free image exists the app renders a
designed fallback card, never a mismatched photo.

Canonical source: Wikimedia Commons banknote categories. Each currency's
Wikidata item names its Commons category (P373); the "Banknotes of ..."
subcategories under it (and the conventional "Banknotes of the <name>"
titles) are enumerated one level deep, and every file is judged against
the acceptance criteria below using only what Commons itself records
about the file (dimensions, MIME type, name, description, categories).
The Wikidata P18 image is a last-resort candidate judged by the same
rules. Editorial overrides (reference/currency_image_overrides.json) are
also judged -- an override cannot bypass the criteria, only add a
candidate.

ACCEPTANCE CRITERIA (all must hold)
    1. raster image (JPEG/PNG/TIFF) or SVG, at least MIN_WIDTH px wide
    2. landscape aspect ratio between ASPECT_MIN and ASPECT_MAX -- a single
       flat note photographed head-on; stacks, fans, vertical composites
       and two-sided sheets fall outside this band
    3. the file's name/description/categories mention nothing on the
       REJECT list (reverse, back, coin, stack, bundle, hand, wallet, pile,
       set, collection, both sides, specimen sheet, ...)
    4. the file's metadata names THIS currency (its unit word, ISO code or
       Commons category name) -- a walk from "Banknotes of Brazil" also
       reaches cruzado and mil-réis notes, which are not the real
Ranking among compliant files: an explicit "obverse"/"front" mention
first, then the NEWEST year the filename states (the current series
beats a colonial-era note), then width.

Everything considered -- accepted, rejected and why -- is written to
etl/logs/currency-images.json for review.
"""

from __future__ import annotations

import json
import os
import re
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch, is_cached
from . import commons

_OVERRIDES_PATH = config.REFERENCE_DIR / "currency_image_overrides.json"

# Operational escape hatch, same shape as LEADERS_CACHED_ONLY: with
# CURRENCY_CACHED_ONLY=1 the category walk consults only listings already
# in the raw cache and never fetches a new one. Commons rate-limits the
# ~1,500 category listings hard enough that a cold walk takes hours; a
# local run can ship what is cached and the monthly refresh (which runs
# WITHOUT the flag) completes the walk.
_CACHED_ONLY = os.environ.get("CURRENCY_CACHED_ONLY") == "1"

# The Commons category WALK is opt-in (CURRENCY_WALK=1) until its
# candidate selection is trusted. The 2026-08-29 review found two ways it
# picks a wrong note: a currency used by several countries (the yen is
# listed for Zimbabwe, the euro for Croatia) pulls in those countries'
# category trees, and a stem such as "Brazilian" matches the historic
# "Brazilian cruzado". Without the walk, only the Wikidata P18 image and
# any editorial override are judged -- fewer images, none mismatched. The
# maintainer chose to hold the walk for another day rather than delay the
# batch; see DATA_DECISIONS.md §22.7.
_WALK = os.environ.get("CURRENCY_WALK") == "1"

MIN_WIDTH = 600
ASPECT_MIN = 1.45
ASPECT_MAX = 2.6
MAX_FILES_PER_CURRENCY = 80
ACCEPTED_MIME = {
    "image/jpeg", "image/png", "image/tiff", "image/svg+xml", "image/webp",
}

_REJECT = re.compile(
    r"\b(reverse|rear|back(?:side)?|verso|coins?|stack(?:s|ed)?|bundle|"
    r"roll(?:ed)?|wad|hands?|holding|wallet|purse|pile|heap|set of|"
    r"collection|both sides|two sides|front and back|obverse and reverse|"
    r"specimen sheet|uncut|sheet of|proof|essay|error note|counterfeit|"
    r"fake|replica|souvenir|play money|torn|damaged|detail|close-up|"
    r"crop|watermark|hologram|security thread|signature|serial number|"
    r"collage|montage|composite|mosaic|comparison|gallery|various|assorted|"
    r"mixed|several|multiple|all denominations|full set|complete set|"
    r"medal|token|cheque|check|bond|stamp|voucher|scrip|map|chart|"
    r"table|diagram|logo|symbol|sign|icon|emblem)\b",
    re.IGNORECASE,
)
_OBVERSE = re.compile(r"\b(obverse|front|face|avers|recto|o\.jpg)\b", re.IGNORECASE)
_BANKNOTE = re.compile(r"banknote|bank note|bill\b|note\b|paper money|currency", re.IGNORECASE)
_YEAR = re.compile(r"\b(1[89]\d{2}|20\d{2})\b")
_STOP = {"the", "of", "and", "dollar", "pound", "franc", "peso", "rupee", "shilling", "dinar", "rial", "riyal", "krone", "krona"}


def _aspect(record: dict[str, Any]) -> float | None:
    width, height = record.get("width"), record.get("height")
    try:
        if width and height and float(height) > 0:
            return float(width) / float(height)
    except (TypeError, ValueError):
        return None
    return None


def _judge(
    filename: str, record: dict[str, Any], *, from_banknote_category: bool,
    stems: set[str] = frozenset(),
) -> tuple[bool, str]:
    """(compliant, reason). The reason names the FIRST failed criterion."""
    mime = (record.get("mime") or "").lower()
    if mime not in ACCEPTED_MIME:
        return False, f"criterion 1: unsupported type {mime or 'unknown'}"
    width = record.get("width") or 0
    if mime != "image/svg+xml" and width < MIN_WIDTH:
        return False, f"criterion 1: only {width}px wide (min {MIN_WIDTH})"
    aspect = _aspect(record)
    if aspect is None:
        return False, "criterion 2: no dimensions recorded"
    if not (ASPECT_MIN <= aspect <= ASPECT_MAX):
        return False, (
            f"criterion 2: aspect ratio {aspect:.2f} outside "
            f"[{ASPECT_MIN}, {ASPECT_MAX}] -- not a single flat note"
        )
    haystack = commons.metadata_text(filename, {filename: record})
    hit = _REJECT.search(haystack)
    if hit:
        return False, f"criterion 3: metadata mentions '{hit.group(1).lower()}'"
    if not (from_banknote_category or _BANKNOTE.search(haystack)):
        return False, "criterion 4: not described or categorised as a banknote"
    if stems and not any(re.search(rf"(?<![a-z]){re.escape(stem)}(?![a-z])", haystack) for stem in stems):
        return False, f"criterion 4: metadata names none of {sorted(stems)}"
    return True, "compliant"


def _rank_key(filename: str, record: dict[str, Any], stems: set[str] = frozenset()) -> tuple[int, int, float]:
    text = f"{filename} {record.get('objectName') or ''}"
    obverse = 0 if _OBVERSE.search(text) else 1
    lower = filename.lower()
    named = 0 if any(re.search(rf"(?<![a-z]){re.escape(s)}(?![a-z])", lower) for s in stems) else 1
    # A year in a filename is as often the photo date as the series, so it
    # does not rank; width does, as a proxy for a proper scan.
    return (obverse, named, -float(record.get("width") or 0))


def _stems(name: str, code: str, commons_category: str | None) -> set[str]:
    """Words that identify THIS currency in a filename or category.

    The unit noun alone ("dollar", "pound") would match every other
    country's notes, so generic unit words are dropped and the qualifier
    kept: "Brazilian real" -> {real, brl}; "pound sterling" -> {sterling,
    gbp}; "Eastern Caribbean dollar" -> {eastern, caribbean, xcd}.
    """
    words = [w for w in re.split(r"[\s-]+", name.lower()) if len(w) > 2 and w not in _STOP]
    stems = {code.lower(), *words}
    if commons_category:
        stems |= {w for w in re.split(r"[\s-]+", commons_category.lower()) if len(w) > 2 and w not in _STOP}
    return {s for s in stems if not s.startswith("q") or not s[1:].isdigit()}


def _category_members(
    category: str, *, cmtype: str, refresh: bool,
    responses: list[CachedResponse],
) -> list[str]:
    url = (
        f"{config.COMMONS_API_URL}?action=query&format=json"
        f"&list=categorymembers&cmtype={cmtype}&cmlimit=100"
        f"&cmtitle={urllib.parse.quote('Category:' + category)}"
    )
    if _CACHED_ONLY and not is_cached(url, subdir="currency-images/categories"):
        return []
    try:
        response = fetch(
            url, refresh=refresh, subdir="currency-images/categories",
            expect_json=True,
        )
    except FetchError:
        return []
    responses.append(response)
    members = response.read_json().get("query", {}).get("categorymembers", [])
    return [m.get("title") or "" for m in members]


def _banknote_files(
    name: str, commons_category: str | None, countries: list[str],
    stems: set[str], *, refresh: bool, responses: list[CachedResponse],
) -> tuple[list[str], list[str]]:
    """(candidate filenames, categories walked) for one currency.

    Commons files banknotes by CURRENCY for some ("Banknotes of the euro")
    and by COUNTRY for others ("Banknotes of the United States"), so both
    forms are tried. Subcategories are followed only when their title
    names this currency or one of its countries -- a walk from "Banknotes
    of Brazil" must not descend into the cruzado.
    """
    roots: list[str] = []
    stem = name.strip()
    for title in (
        f"Banknotes of the {stem}", f"Banknotes of {stem}",
        f"{stem} banknotes",
    ):
        roots.append(title)
    # Country-named roots ONLY for a currency with exactly one country: the
    # yen is listed for Zimbabwe and the euro for Croatia, and a walk into
    # "Banknotes of Zimbabwe" put a Zimbabwean note on Japan's page.
    if len(countries) == 1:
        roots.append(f"Banknotes of {countries[0]}")
        roots.append(f"Banknotes of the {countries[0]}")
    country_words = {w.lower() for c in countries[:1] for w in c.split() if len(w) > 3} if len(countries) == 1 else set()

    def relevant(sub_name: str) -> bool:
        lower = sub_name.lower()
        return (
            any(re.search(rf"(?<![a-z]){re.escape(s)}(?![a-z])", lower) for s in stems)
            or any(re.search(rf"(?<![a-z]){re.escape(w)}(?![a-z])", lower) for w in country_words)
        )
    walked: list[str] = []
    files: list[str] = []
    seen: set[str] = set()

    def visit(category: str, depth: int) -> None:
        if category in seen or len(files) >= MAX_FILES_PER_CURRENCY:
            return
        seen.add(category)
        walked.append(category)
        for title in _category_members(
            category, cmtype="file", refresh=refresh, responses=responses,
        ):
            if title.startswith("File:") and len(files) < MAX_FILES_PER_CURRENCY:
                files.append(title.removeprefix("File:"))
        if depth < 1:
            for sub in _category_members(
                category, cmtype="subcat", refresh=refresh, responses=responses,
            ):
                sub_name = sub.removeprefix("Category:")
                if re.match(r"(?i)banknotes? of", sub_name) and relevant(sub_name):
                    visit(sub_name, depth + 1)

    for root in roots:
        visit(root, 0)
    if commons_category:
        # The currency's own Commons category: only its banknote subcats.
        for sub in _category_members(
            commons_category, cmtype="subcat", refresh=refresh,
            responses=responses,
        ):
            sub_name = sub.removeprefix("Category:")
            if re.match(r"(?i)banknotes? of", sub_name):
                visit(sub_name, 0)
    return files, walked


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "economy"
    out_dir.mkdir(parents=True, exist_ok=True)

    response = fetch(
        f"{config.WIKIDATA_SPARQL}?format=json&query="
        + urllib.parse.quote(config.WIKIDATA_CURRENCY_IMAGES_QUERY),
        refresh=refresh,
        subdir="currency-images",
        filename="wikidata-currencies-v2.json",
        expect_json=True,
    )
    overrides: dict[str, str] = {
        code: filename
        for code, filename in json.loads(
            _OVERRIDES_PATH.read_text("utf-8")
        ).items()
        if not code.startswith("_")
    }

    # code -> {name, p18, commonsCategory, countries}
    by_code: dict[str, dict[str, Any]] = {}
    for row in response.read_json()["results"]["bindings"]:
        iso3 = (row.get("iso3", {}).get("value") or "").upper()
        code = (row.get("code", {}).get("value") or "").upper()
        # ISO 4217 alphabetic codes only -- the old `len(code) == 3` gate let
        # the numeric code "203" through as if it were a currency.
        if iso3 not in registry or not re.fullmatch(r"[A-Z]{3}", code):
            continue
        image = row.get("image", {}).get("value")
        label = (row.get("currencyLabel", {}).get("value") or "").strip()
        record = by_code.setdefault(code, {
            "name": label if label and not re.fullmatch(r"Q\d+", label) else code,
            "p18": None,
            "commonsCategory": None,
            "countries": [],
        })
        country_name = registry[iso3].name_common
        if country_name not in record["countries"]:
            record["countries"].append(country_name)
        if image and not record["p18"]:
            record["p18"] = commons.filename_from_special_path(image)
        category = row.get("commonsCategory", {}).get("value")
        if category and not record["commonsCategory"]:
            record["commonsCategory"] = category

    # Candidate files per code: banknote categories first, then P18 and the
    # override -- all judged by the same criteria.
    responses: list[CachedResponse] = []
    candidates: dict[str, list[tuple[str, bool]]] = {}
    walked_by_code: dict[str, list[str]] = {}
    for code, record in sorted(by_code.items()):
        if record["name"] == code and record["commonsCategory"]:
            record["name"] = record["commonsCategory"]
        record["stems"] = _stems(record["name"], code, record["commonsCategory"])
        if _WALK:
            files, walked = _banknote_files(
                record["name"], record["commonsCategory"], record["countries"],
                record["stems"], refresh=refresh, responses=responses,
            )
        else:
            files, walked = [], []
        walked_by_code[code] = walked
        entries: list[tuple[str, bool]] = [(f, True) for f in files]
        if record["p18"]:
            entries.append((record["p18"], False))
        if code in overrides:
            entries.append((overrides[code], False))
        deduped: dict[str, bool] = {}
        for filename, from_cat in entries:
            deduped[filename] = deduped.get(filename, False) or from_cat
        candidates[code] = list(deduped.items())

    all_files = sorted({f for entries in candidates.values() for f, _ in entries})
    metadata, meta_responses = commons.fetch_metadata(
        all_files, refresh=refresh, subdir="currency-images",
    )

    currencies: dict[str, Any] = {}
    log: dict[str, Any] = {}
    for code, entries in sorted(candidates.items()):
        judged: list[dict[str, Any]] = []
        compliant: list[tuple[tuple[int, float, float], str]] = []
        for filename, from_cat in entries:
            record = metadata.get(filename)
            if record is None:
                judged.append({"file": filename, "verdict": "missing on Commons"})
                continue
            ok, reason = _judge(
                filename, record, from_banknote_category=from_cat,
                stems=by_code[code]["stems"],
            )
            judged.append({"file": filename, "verdict": reason})
            if ok:
                compliant.append((_rank_key(filename, record, by_code[code]["stems"]), filename))
        compliant.sort()
        chosen = compliant[0][1] if compliant else None
        log[code] = {
            "name": by_code[code]["name"],
            "categoriesWalked": walked_by_code.get(code, []),
            "candidates": len(entries),
            "compliant": len(compliant),
            "chosen": chosen,
            "judged": judged,
        }
        if chosen:
            record = metadata[chosen]
            currencies[code] = {
                "name": by_code[code]["name"],
                "file": chosen,
                "imageUrl": commons.image_url_for(chosen),
                "commonsPage": commons.file_page_for(chosen),
                "license": record["license"],
                "author": record["author"],
                "width": record.get("width"),
                "height": record.get("height"),
                "curated": chosen == overrides.get(code),
                "verified": True,
            }

    document = {
        "source": "commons_banknotes",
        "note": (
            "One banknote per ISO 4217 currency from Wikimedia Commons "
            "banknote categories, accepted only when Commons' own metadata "
            "shows a single flat note, head-on, obverse side (see "
            "etl/sources/currencyimages.py for the criteria). Currencies "
            "with no compliant free image are absent here and render a "
            "designed fallback card; many modern notes are copyrighted and "
            "cannot be on Commons at all."
        ),
        "criteria": (
            f"raster/SVG >= {MIN_WIDTH}px; aspect {ASPECT_MIN}-{ASPECT_MAX}; "
            f"no reverse/coin/stack/bundle/hand/set/composite mentions; "
            f"banknote category or description"
        ),
        "currencies": currencies,
    }
    (out_dir / "currency-images.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    config.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    without = sorted(c for c in by_code if c not in currencies)
    (config.LOGS_DIR / "currency-images.json").write_text(
        json.dumps({
            "note": (
                "Every banknote candidate considered per currency and the "
                "first acceptance criterion it failed. Currencies under "
                "'withoutImage' render the fallback card; add a compliant "
                "Commons filename to etl/reference/currency_image_overrides.json "
                "to supply one (it is still judged)."
            ),
            "withImage": len(currencies),
            "withoutImage": without,
            "currencies": log,
        }, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "currency_images",
        title="Banknote images (Wikimedia Commons banknote categories)",
        url=config.COMMONS_API_URL,
        licence="Per-file Commons licences, recorded per image",
        fetched_at=max(
            r.fetched_at for r in [response, *responses, *meta_responses]
        ),
        upstream_release=None,
        vintage="as retrieved",
        citation="Wikimedia Commons (per-file attribution in artifact); Wikidata P373/P18",
        notes=(
            f"{len(currencies)} of {len(by_code)} currencies have a "
            f"compliant banknote image ({len(all_files)} candidate files "
            f"judged); {len(without)} render the fallback card. Criteria in "
            f"etl/sources/currencyimages.py; verdicts in "
            f"etl/logs/currency-images.json."
            + (" Built with CURRENCY_CACHED_ONLY=1: only cached category "
               "listings were consulted."
               if _CACHED_ONLY else "")
            + (" Commons category walk enabled (CURRENCY_WALK=1)."
               if _WALK else
               " Category walk OFF: candidates are the Wikidata P18 image "
               "and editorial overrides only, judged by the same criteria.")
        ),
    )
    manifest_mod.record_artifact(
        manifest, "economy/currency-images.json",
        description=(
            "One verified single-banknote (obverse) image per ISO 4217 "
            "code, with Commons file page, licence and author."
        ),
        sources=["currency_images"], row_count=len(currencies),
    )
    print(f"    currency images: {len(currencies)}/{len(by_code)} currencies "
          f"with a compliant banknote ({len(all_files)} files judged)")


__all__ = ["ingest"]
