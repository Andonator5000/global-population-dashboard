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

# Mythical / heraldic emblems (2026-08-29). The Wikipedia lists tag these
# with "Mythical" in the scientific-name column; a second net catches an
# untagged legendary name that has no binomial. "Komodo dragon" keeps its
# binomial and is a real lizard, so the name net only fires when the
# scientific name is missing or non-binomial.
_MYTHICAL_TAGS = {"mythical", "legendary", "heraldic", "fictional", "mythological"}
_MYTHICAL_NAME = re.compile(
    r"\b(phoenix|unicorn|griffin|gryphon|garuda|qilin|qianlima|wyvern|"
    r"heraldic|coat of arms|double-headed|double-tailed|dragon)\b",
    re.IGNORECASE,
)
# Heraldic figures the list files under a real taxon's binomial.
_HERALDIC_NAMES = {"lion of judah"}
_BINOMIAL = re.compile(r"^[A-Z][a-z-]+ [a-z-]+(?: [a-z-]+)?$")
_GENUS = re.compile(r"^[A-Z][a-z-]+$")
_SPLIT = re.compile(r"\s*(?:,|;| and | or |/)\s*")


def _scientific_parts(entry: dict[str, Any]) -> list[str]:
    """Binomials and genera named in the scientific-name cell, in order.

    The lists join several taxa with commas ("Quercus, Quercus robur";
    "Hibiscus syriacus, Pinus densiflora"); each part is a taxon in its own
    right. Cultivar quotes are stripped (Betula pendula 'Dalecarlica').
    """
    raw = (entry.get("scientificName") or "").strip()
    parts: list[str] = []
    for part in _SPLIT.split(raw):
        part = re.sub(r"\s*'[^']*'\s*$", "", part).strip()
        if _BINOMIAL.match(part) or _GENUS.match(part):
            parts.append(part)
    # Species before genus, so the most specific taxon is tried first.
    return sorted(parts, key=lambda p: (" " not in p, parts.index(p)))


def _is_emblem(entry: dict[str, Any]) -> bool:
    scientific = (entry.get("scientificName") or "").strip()
    if scientific.lower() in _MYTHICAL_TAGS:
        return True
    if "mythical" in (entry.get("type") or "").lower():
        return True
    if entry["name"].strip().lower() in _HERALDIC_NAMES:
        return True
    if not _BINOMIAL.match(scientific) and _MYTHICAL_NAME.search(entry["name"]):
        return True
    return False


def _name_tokens(entry: dict[str, Any]) -> list[str]:
    """Lowercased names a matching photo's metadata must mention."""
    tokens: list[str] = []
    for part in _scientific_parts(entry):
        tokens.append(part.lower())
        tokens.append(part.split()[0].lower())  # genus
    for name in _SPLIT.split(entry["name"].strip().lower()):
        if len(name) > 3:
            tokens.append(name)
    return tokens


def _commons_matches(filename: str, entry: dict[str, Any],
                     metadata: dict[str, dict[str, Any]]) -> bool:
    """True when the Commons file's own metadata names this taxon."""
    haystack = commons.metadata_text(filename, metadata)
    return any(token in haystack for token in _name_tokens(entry))

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


def _inaturalist_photo(
    query: str, *, refresh: bool, scientific: str | None = None,
) -> dict[str, Any] | None:
    """The community's best CC0/CC-BY photo of a species, or None.

    Two keyless calls: name -> taxon, then the top research-grade
    observation by votes with the licence filter applied server-side.
    Only photos on the inaturalist-open-data bucket (published for
    third-party use) are accepted; anything else falls back to Commons.

    Verification (2026-08-29): the resolved taxon must actually BE the
    queried one -- its scientific name equal to the query (or its species
    part, for a subspecies query), or its common name equal to the queried
    common name. iNaturalist's search is fuzzy, and an unverified first
    hit put the wrong animal on a card.
    """
    import time

    try:
        taxa_response = fetch(
            config.INATURALIST_TAXA_URL.format(
                query=urllib.parse.quote(query)
            ),
            refresh=refresh, subdir="florafauna/inat", expect_json=True,
        )
        if not taxa_response.from_cache:
            time.sleep(config.INATURALIST_THROTTLE_SECONDS)
        taxa = taxa_response.read_json().get("results") or []
        if not taxa:
            return None
        taxon = taxa[0]
        taxon_name = (taxon.get("name") or "").strip().lower()
        wanted = (scientific or query).strip().lower()
        common = (taxon.get("preferred_common_name") or "").strip().lower()
        species_part = " ".join(wanted.split()[:2])
        if not (
            taxon_name == wanted
            or (scientific and taxon_name == species_part)
            or (not scientific and common == wanted)
        ):
            return None  # fuzzy hit on some other taxon: no image beats a wrong one
        if scientific and " " not in wanted and taxon.get("rank") != "genus":
            return None  # a genus query must resolve to the genus itself
        observations_response = fetch(
            config.INATURALIST_OBSERVATIONS_URL.format(
                taxon_id=taxa[0]["id"]
            ),
            refresh=refresh, subdir="florafauna/inat", expect_json=True,
        )
        if not observations_response.from_cache:
            time.sleep(config.INATURALIST_THROTTLE_SECONDS)
        observations = observations_response.read_json().get("results") or []
    except FetchError:
        return None  # photo enrichment must never sink the stage
    for observation in observations:
        for photo in observation.get("photos") or []:
            url = photo.get("url") or ""
            if "inaturalist-open-data" not in url:
                continue
            if not re.search(r"/square\.(\w+)$", url):
                continue
            licence = (photo.get("license_code") or "").upper()
            if licence not in ("CC0", "CC-BY"):
                continue
            return {
                "imageUrl": re.sub(r"/square\.(\w+)$", r"/medium.\1", url),
                "largeUrl": re.sub(r"/square\.(\w+)$", r"/large.\1", url),
                "commonsPage": config.INATURALIST_PHOTO_PAGE.format(
                    photo_id=photo["id"]
                ),
                "license": licence,
                "author": photo.get("attribution"),
                "source": "iNaturalist",
            }
    return None


def _lead_images(
    titles: list[str], *, refresh: bool
) -> tuple[dict[str, str], dict[str, str], list[CachedResponse]]:
    """({article title: lead image Commons filename}, {title: Wikidata QID}).

    The QID feeds `_taxon_names`: the flowers article names most species by
    common name only, and the image verification needs the binomial.
    """
    out: dict[str, str] = {}
    qids: dict[str, str] = {}
    responses: list[CachedResponse] = []
    ordered = sorted(set(titles))
    for start in range(0, len(ordered), 20):
        batch = ordered[start:start + 20]
        url = (
            f"{config.WIKIPEDIA_API_URL}?action=query&format=json"
            f"&prop=pageimages%7Cpageprops&piprop=name&ppprop=wikibase_item"
            f"&redirects=1"
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
            qid = (page.get("pageprops") or {}).get("wikibase_item")
            original = redirect_back.get(title, title)
            original = normalise_back.get(original, original)
            for key in {title, original}:
                if image:
                    out[key.replace(" ", "_")] = image.replace("_", " ")
                if qid:
                    qids[key.replace(" ", "_")] = qid
    return out, qids, responses


def _taxon_names(
    qids: list[str], *, refresh: bool
) -> tuple[dict[str, str], list[CachedResponse]]:
    """{QID: taxon name (P225)} for the species/genus articles."""
    out: dict[str, str] = {}
    responses: list[CachedResponse] = []
    ordered = sorted(set(qids))
    for start in range(0, len(ordered), 100):
        batch = ordered[start:start + 100]
        values = " ".join(f"wd:{q}" for q in batch)
        query = (
            "SELECT ?item ?taxon WHERE { VALUES ?item { " + values + " } "
            "?item wdt:P225 ?taxon . }"
        )
        try:
            response = fetch(
                f"{config.WIKIDATA_SPARQL}?format=json&query="
                + urllib.parse.quote(query),
                refresh=refresh, subdir="florafauna", expect_json=True,
            )
        except FetchError:
            continue  # enrichment only; the stage must not sink on it
        responses.append(response)
        for row in response.read_json()["results"]["bindings"]:
            qid = (row["item"]["value"]).rsplit("/", 1)[-1]
            out[qid] = row["taxon"]["value"]
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
    lead, flower_qids, lead_responses = _lead_images(
        flower_titles, refresh=refresh,
    )
    taxon_names, taxon_responses = _taxon_names(
        list(flower_qids.values()), refresh=refresh,
    )
    lead_responses = [*lead_responses, *taxon_responses]
    for record in flowers.values():
        title = record.pop("articleTitle", None)
        if title and title in lead:
            record["file"] = lead[title]
        # Scientific name from the article's Wikidata item when the prose
        # gave only a common name -- it is what the image check verifies.
        qid = flower_qids.get(title or "")
        if qid and qid in taxon_names and not record.get("scientificName"):
            record["scientificName"] = taxon_names[qid]

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

    rejected_images: list[dict[str, Any]] = []

    def finalise(entry: dict[str, Any], *, emblem: bool = False) -> dict[str, Any]:
        record = {k: v for k, v in entry.items() if k != "file"}
        filename = entry.get("file")
        image = None
        if not emblem:
            # iNaturalist first (community-vote-ranked, licence-filtered
            # wildlife photography, verified against the taxon); the
            # Commons image is the fallback and must name the taxon in its
            # own metadata. Otherwise: no image.
            for scientific in _scientific_parts(entry) or [None]:
                image = _inaturalist_photo(
                    scientific or entry["name"], refresh=refresh,
                    scientific=scientific,
                )
                if image:
                    break
        if image is None and filename:
            if emblem or _commons_matches(filename, entry, metadata):
                image = commons.image_record(filename, metadata)
            elif filename in metadata:
                rejected_images.append({
                    "name": entry["name"],
                    "scientificName": entry.get("scientificName"),
                    "file": filename,
                    "reason": "Commons metadata does not mention the taxon",
                })
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
            real = [e for e in animals[iso3] if not _is_emblem(e)]
            emblems = [e for e in animals[iso3] if _is_emblem(e)]
            entries = [finalise(e) for e in real[:5]]
            # The headline national animal first, then birds and the rest.
            entries.sort(key=lambda e: (e["type"] != "national animal", e["name"]))
            if entries:
                document["animals"] = entries
            if emblems:
                # Mythical and heraldic figures are real national symbols
                # but not real taxa; they ship in their own list so the UI
                # can keep them out of the species grid.
                document["emblems"] = [
                    {
                        **{k: v for k, v in finalise(e, emblem=True).items()
                           if k != "scientificName"},
                        "kind": "heraldic or mythical emblem",
                    }
                    for e in emblems[:3]
                ]
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

    config.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    (config.LOGS_DIR / "florafauna-rejected-images.json").write_text(
        json.dumps({
            "note": (
                "Commons images the flora/fauna stage refused because the "
                "file's own metadata (name, description, categories) does "
                "not mention the taxon. The card renders its typographic "
                "fallback instead."
            ),
            "rejected": sorted(rejected_images, key=lambda r: r["name"]),
        }, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
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
        licence=(
            "CC BY-SA 4.0 (text); images CC0/CC-BY via iNaturalist or "
            "per-file Commons licences"
        ),
        fetched_at=max(r.fetched_at for r in all_responses),
        upstream_release=pages["animals"].upstream_release,
        vintage="pages as retrieved",
        citation=(
            "Wikipedia: List of national animals; List of national trees; "
            "List of national flowers. Photos: iNaturalist (CC0/CC-BY, "
            "research grade) with Wikimedia Commons fallback"
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
            "National animal(s), tree and flower with verified images and "
            "attribution, per entity; mythical/heraldic emblems listed "
            "separately."
        ),
        sources=["wikipedia_national_symbols"], entity_count=written,
    )
    print(f"    flora/fauna: {written} countries "
          f"({len(animals)} animals, {len(trees)} trees, "
          f"{len(flowers)} flowers), {with_images} images, "
          f"{len(rejected_images)} Commons images rejected as unverified")


__all__ = ["ingest"]
