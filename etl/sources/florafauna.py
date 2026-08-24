"""National animals, trees, and flowers, from Wikipedia's list articles.

No Wikidata property reliably links a country to its national symbols, so
the maintained compilations are the English Wikipedia lists (CC BY-SA 4.0,
attributed):

    List of national animals   wikitable, country cell rowspans over several
                               entries ("national animal", "national bird"...)
    List of national trees     wikitable, same shape
    List of national flowers   prose sections (h4 per country) under the
                               "National plants" heading -- the article's only
                               wikitable is SUBNATIONAL flowers and is ignored

Images come from each table's own picture cell where present; entries
without one (all flowers) use the linked article's lead image via the
pageimages API. Every image resolves to the ORIGINAL Commons file so the
licence and author ride along; a file the Commons API does not know is
dropped, never hotlinked blind.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity, build_name_index, normalise_name, normalise_name_strict
from ..fetch import CachedResponse, FetchError, fetch
from . import commons

# Wikipedia spellings the registry's folding cannot reach.
_NAME_ALIASES: dict[str, str] = {
    "democratic republic of the congo": "COD",
    "republic of the congo": "COG",
    "east timor": "TLS",
    "sao tome and principe": "STP",
    "cape verde": "CPV",
    "ivory coast": "CIV",
    "burma": "MMR",
    "vatican city": "VAT",
    "state of palestine": "PSE",
    "palestine": "PSE",
    "turkey": "TUR",
    "china": "CHN",
    "taiwan": "TWN",
    "federated states of micronesia": "FSM",
}

_PAREN = re.compile(r"\(([^)]*)\)")
_REF = re.compile(r"\[[^\]]*\]")


def _clean(text: str) -> str:
    return _REF.sub("", text).replace(" ", " ").strip()


def _match_iso3(
    name: str,
    strict: dict[str, str],
    loose: dict[str, str],
) -> str | None:
    return (
        _NAME_ALIASES.get(normalise_name_strict(name))
        or strict.get(normalise_name_strict(name))
        or loose.get(normalise_name(name))
    )


def _picture_filename(cell: Any) -> str | None:
    for src in cell.xpath(".//img/@src"):
        name = commons.filename_from_thumb_url(src)
        # Flag icons live in country cells, but guard anyway.
        if name and not name.lower().startswith("flag of"):
            return name
    return None


def _parse_symbol_table(
    table: Any,
    strict: dict[str, str],
    loose: dict[str, str],
    default_type: str,
) -> tuple[dict[str, list[dict[str, Any]]], set[str]]:
    """Rowspan-aware parse of a Country | Name | Scientific | Picture table."""
    out: dict[str, list[dict[str, Any]]] = {}
    unmatched: set[str] = set()
    pending_country: str | None = None
    pending_rows = 0

    for row in table.xpath(".//tr")[1:]:
        cells = row.xpath("./td|./th")
        if not cells:
            continue
        if pending_rows > 0:
            country_name = pending_country
            content = cells
            pending_rows -= 1
        else:
            country_name = _clean(cells[0].text_content())
            try:
                pending_rows = int(cells[0].get("rowspan") or 1) - 1
            except ValueError:
                pending_rows = 0
            pending_country = country_name
            content = cells[1:]
        if not country_name or len(content) < 1:
            continue

        raw_name = _clean(content[0].text_content())
        if not raw_name:
            continue
        qualifier = _PAREN.search(raw_name)
        entry: dict[str, Any] = {
            "name": _PAREN.sub("", raw_name).strip().rstrip(","),
            "type": (
                qualifier.group(1).strip().lower()
                if qualifier and "national" in qualifier.group(1).lower()
                else default_type
            ),
        }
        if len(content) >= 2:
            scientific = _clean(content[1].text_content())
            if scientific:
                entry["scientificName"] = scientific
        for cell in content:
            filename = _picture_filename(cell)
            if filename:
                entry["file"] = filename
                break

        iso3 = _match_iso3(country_name, strict, loose)
        if iso3 is None:
            unmatched.add(country_name)
            continue
        out.setdefault(iso3, []).append(entry)
    return out, unmatched


def _parse_flowers_prose(
    doc: Any,
    strict: dict[str, str],
    loose: dict[str, str],
) -> tuple[dict[str, dict[str, Any]], set[str]]:
    """Country -> flower from the prose sections under "National plants"."""
    out: dict[str, dict[str, Any]] = {}
    unmatched: set[str] = set()
    national = None
    for h2 in doc.xpath("//h2"):
        if _clean(h2.text_content()) == "National plants":
            national = h2.getparent()
            break
    if national is None:
        raise FetchError(
            "The flowers article no longer has a 'National plants' section."
        )
    for h4 in national.xpath(".//h4"):
        country_name = _clean(h4.text_content())
        section = h4.getparent()
        paragraphs = section.xpath(".//p")
        if not paragraphs:
            continue
        iso3 = _match_iso3(country_name, strict, loose)
        if iso3 is None:
            unmatched.add(country_name)
            continue

        # The flower is the wiki link NEAREST to the "national flower" /
        # "national floral emblem" phrase. Taking the paragraph's FIRST link
        # instead put Ronald Reagan's portrait on the United States' rose
        # ("President Ronald Reagan signed legislation to make the rose...").
        paragraph = paragraphs[0]
        text = paragraph.text_content()
        phrase = re.search(r"national\s+flo", text, re.IGNORECASE)
        anchor = phrase.start() if phrase else 0
        links = paragraph.xpath(".//a[@rel='mw:WikiLink']")
        candidates: list[tuple[int, int, Any]] = []
        for order, link in enumerate(links):
            label = _clean(link.text_content())
            if not label:
                continue
            lowered = label.lower()
            if (
                _match_iso3(label, strict, loose) == iso3
                or lowered.startswith("list of")
                or "state" in lowered
            ):
                continue  # the country itself, or list/state boilerplate
            position = text.find(label)
            if position == -1:
                continue
            candidates.append((abs(position - anchor), order, link))
        if not candidates:
            continue
        candidates.sort()
        _, order, chosen = candidates[0]
        record: dict[str, Any] = {"name": _clean(chosen.text_content())}
        # Species-first prose ("X aethiopica, commonly known as calla lily"):
        # the italic chosen link is the scientific name and the next link is
        # the readable one.
        if chosen.xpath("ancestor::i") and order + 1 < len(links):
            follower = _clean(links[order + 1].text_content())
            if follower and text.find(follower) - text.find(record["name"]) < 60:
                record["scientificName"] = record["name"]
                record["name"] = follower
        title = (chosen.get("href") or "").removeprefix("./")
        record["articleTitle"] = urllib.parse.unquote(title) if title else None
        out.setdefault(iso3, record)
    return out, unmatched


def _lead_images(
    titles: list[str], *, refresh: bool
) -> tuple[dict[str, str], list[CachedResponse]]:
    """{article title: lead image Commons filename} via the pageimages API."""
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
        # URL-hash cache naming; see commons.fetch_metadata for why
        # positional batch filenames go stale.
        response = fetch(url, refresh=refresh, subdir="florafauna",
                         expect_json=True)
        responses.append(response)
        payload = response.read_json().get("query", {})
        redirect_back = {
            r["to"]: r["from"] for r in payload.get("redirects", [])
        }
        normalise_back = {
            n["to"]: n["from"] for n in payload.get("normalized", [])
        }
        for page in payload.get("pages", {}).values():
            title = page.get("title") or ""
            image = page.get("pageimage")
            if not image:
                continue
            original = redirect_back.get(title, title)
            original = normalise_back.get(original, original)
            for key in {title, original}:
                out[key.replace(" ", "_")] = image.replace("_", " ")
    return out, responses


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    from lxml import html as lhtml

    out_dir = config.DATA_DIR / "flora-fauna"
    out_dir.mkdir(parents=True, exist_ok=True)
    strict, loose = build_name_index(registry)

    pages = {
        "animals": fetch(
            config.WIKIPEDIA_NATIONAL_ANIMALS_URL, refresh=refresh,
            subdir="florafauna", filename="animals.html",
        ),
        "trees": fetch(
            config.WIKIPEDIA_NATIONAL_TREES_URL, refresh=refresh,
            subdir="florafauna", filename="trees.html",
        ),
        "flowers": fetch(
            config.WIKIPEDIA_NATIONAL_FLOWERS_URL, refresh=refresh,
            subdir="florafauna", filename="flowers.html",
        ),
    }

    animals_doc = lhtml.fromstring(pages["animals"].read_bytes())
    trees_doc = lhtml.fromstring(pages["trees"].read_bytes())
    flowers_doc = lhtml.fromstring(pages["flowers"].read_bytes())

    animal_tables = animals_doc.xpath("//table[contains(@class,'wikitable')]")
    tree_tables = trees_doc.xpath("//table[contains(@class,'wikitable')]")
    if not animal_tables or not tree_tables:
        raise FetchError("Animals or trees article lost its wikitable.")

    animals, un_a = _parse_symbol_table(
        animal_tables[0], strict, loose, "national animal",
    )
    trees, un_t = _parse_symbol_table(
        tree_tables[0], strict, loose, "national tree",
    )
    flowers, un_f = _parse_flowers_prose(flowers_doc, strict, loose)

    if len(animals) < 100 or len(trees) < 40 or len(flowers) < 30:
        raise FetchError(
            f"Symbol parses look truncated: {len(animals)} animal countries, "
            f"{len(trees)} tree, {len(flowers)} flower. Article layouts "
            f"changed."
        )

    # Flowers carry no picture cells; fetch their articles' lead images.
    flower_titles = [
        record["articleTitle"]
        for record in flowers.values()
        if record.get("articleTitle")
    ]
    lead, lead_responses = _lead_images(flower_titles, refresh=refresh)
    for record in flowers.values():
        title = record.pop("articleTitle", None)
        if title and title in lead:
            record["file"] = lead[title]

    filenames = [
        entry["file"]
        for group in (animals, trees)
        for entries in group.values()
        for entry in entries
        if entry.get("file")
    ] + [record["file"] for record in flowers.values() if record.get("file")]
    metadata, meta_responses = commons.fetch_metadata(
        filenames, refresh=refresh, subdir="florafauna",
    )

    def finalise(entry: dict[str, Any]) -> dict[str, Any]:
        record = {k: v for k, v in entry.items() if k != "file"}
        filename = entry.get("file")
        if filename:
            image = commons.image_record(filename, metadata)
            if image:
                record["image"] = image
        return record

    written = 0
    with_images = 0
    for iso3 in sorted(set(animals) | set(trees) | set(flowers)):
        document: dict[str, Any] = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": "wikipedia_national_symbols",
            "note": (
                "As compiled by the English Wikipedia lists of national "
                "animals, trees and flowers (CC BY-SA 4.0). Symbols are not "
                "always enshrined in law; absence here means the lists "
                "record none."
            ),
        }
        if iso3 in animals:
            entries = [finalise(e) for e in animals[iso3][:5]]
            # The headline national animal first, then birds and the rest.
            entries.sort(key=lambda e: (e["type"] != "national animal", e["name"]))
            document["animals"] = entries
        if iso3 in trees:
            document["tree"] = finalise(trees[iso3][0])
        if iso3 in flowers:
            document["flower"] = finalise(flowers[iso3])
        (out_dir / f"{iso3}.json").write_text(
            json.dumps(document, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )
        written += 1
        with_images += sum(
            1
            for part in [*document.get("animals", []),
                         document.get("tree"), document.get("flower")]
            if part and part.get("image")
        )

    unmatched = sorted(un_a | un_t | un_f)
    all_responses = [
        *pages.values(), *lead_responses, *meta_responses,
    ]
    manifest_mod.record_source(
        manifest,
        "wikipedia_national_symbols",
        title="Wikipedia — lists of national animals, trees and flowers",
        url="https://en.wikipedia.org/wiki/List_of_national_animals",
        licence="CC BY-SA 4.0 (text); per-file Commons licences on images",
        fetched_at=max(r.fetched_at for r in all_responses),
        upstream_release=pages["animals"].upstream_release,
        vintage="pages as retrieved",
        citation=(
            "Wikipedia: List of national animals; List of national trees; "
            "List of national flowers"
        ),
        notes=(
            f"{written} countries with at least one symbol; {with_images} "
            f"symbol images with Commons attribution. Unmatched rows: "
            f"{', '.join(unmatched[:10])}{'…' if len(unmatched) > 10 else ''}."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "flora-fauna/<ISO3>.json",
        description=(
            "National animal(s), tree and flower with Commons images and "
            "attribution, per entity."
        ),
        sources=["wikipedia_national_symbols"], entity_count=written,
    )
    print(f"    flora/fauna: {written} countries "
          f"({len(animals)} animals, {len(trees)} trees, "
          f"{len(flowers)} flowers), {with_images} images")


__all__ = ["ingest"]
