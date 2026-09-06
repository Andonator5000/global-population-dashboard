"""Tree of life from the Catalogue of Life (Phase 5, DATA_DECISIONS.md §31).

BACKBONE CHOICE
---------------
Catalogue of Life (via the keyless ChecklistBank API; dataset alias 3LR is
the latest COL release) is the primary backbone: it is the curated
consensus checklist, its latest releases carry a proper three-domain root
(Archaea, Bacteria, Eukaryota, plus Viruses as an unranked lineage), and
every node carries a descendant-name count. The alternatives compared and
declined: GBIF Backbone (an aggregation optimised for occurrence matching,
with known artifacts at higher ranks), NCBI Taxonomy (only taxa with
sequence data; explicitly "not an authority"), Open Tree of Life (no ranks,
and identifiers that shift between synthesis versions). Wikidata maps each
node to its Wikipedia article via P10585 (Catalogue of Life ID).

SHAPE OF THE OUTPUT
-------------------
- biology/taxonomy/tree.json -- one document from the synthetic "Life" root
  down to FAMILY rank (~14k nodes). The app renders it lazily (children
  mount on expand), so one gzipped fetch beats thousands of little ones.
- biology/taxonomy/focus/{familyId}.json -- genus and species depth for the
  families listed in etl/reference/taxonomy_focus.json (an EDITORIAL
  choice of well-known groups; the tree itself is never hand-typed).
  Fetched by the app only when such a family is expanded.

Contested placements (Chromista, Protozoa, Viruses, the two- vs
three-domain question) carry notes from etl/reference/taxonomy_notes.json
rather than being presented as settled. Truncation is always explicit: a
node whose children were capped carries `"truncated": true`.

Every node records either its English Wikipedia title or an explicit
`"wiki": null` -- the check:taxonomy gate refuses a node with neither.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch
from . import commons

# Same free-licence gate the history and evolution stages apply to images.
_FREE = re.compile(r"public domain|cc0|cc[- ]by(?![- ]n[cd])|pd-", re.IGNORECASE)

# Ranks we stop descending at (family) and never descend past outside the
# focus families. COL interleaves intermediate ranks (subphylum, suborder,
# ...); those are kept as they come -- flattening them would misstate the
# source.
FAMILY_RANK = "family"
GENUS_RANK = "genus"
MAX_DEPTH = 14

WIKIDATA_BATCH = 200

_WIKIDATA_QUERY = """
SELECT ?colid ?itemDescription ?article ?common ?image ?ncbi ?ott
       ?rangeStart WHERE {{
  VALUES ?colid {{ {values} }}
  ?item wdt:P10585 ?colid .
  OPTIONAL {{
    ?article schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> .
  }}
  OPTIONAL {{ ?item wdt:P1843 ?common . FILTER(LANG(?common) = "en") }}
  OPTIONAL {{ ?item wdt:P18 ?image . }}
  OPTIONAL {{ ?item wdt:P685 ?ncbi . }}
  OPTIONAL {{ ?item wdt:P9157 ?ott . }}
  OPTIONAL {{ ?item wdt:P523 ?rangeStart . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
"""


def _api(path: str, *, refresh: bool, filename: str) -> Any:
    response = fetch(
        f"{config.CHECKLISTBANK_API}{path}",
        refresh=refresh,
        subdir="taxonomy",
        filename=filename,
        expect_json=True,
    )
    return response.read_json()


def _children(taxon_id: str, *, refresh: bool, limit: int,
              counter: dict[str, int]) -> tuple[list[dict[str, Any]], bool]:
    """One page of accepted children, plus whether the list was truncated.

    Cache filenames are derived from the taxon id (content-defining), never
    from a running index -- the positional-cache-key bug of §21.
    """
    counter["calls"] += 1
    if counter["calls"] % 250 == 0:
        print(f"      ...{counter['calls']} tree calls", flush=True)
    safe = hashlib.sha256(taxon_id.encode("utf-8")).hexdigest()[:16]
    page = _api(
        f"/dataset/{config.COL_DATASET}/tree/{urllib.parse.quote(taxon_id)}"
        f"/children?limit={limit}",
        refresh=refresh,
        filename=f"children-{safe}.json",
    )
    result = [
        row for row in page.get("result", [])
        if row.get("status") in ("accepted", "provisionally accepted")
    ]
    return result, bool(page.get("total", 0) > limit)


def _node_from(row: dict[str, Any]) -> dict[str, Any]:
    node: dict[str, Any] = {
        "id": row["id"],
        "name": row["name"],
        "rank": row.get("rank") or "unranked",
        "names": row.get("count", 0),
    }
    if row.get("authorship"):
        node["auth"] = row["authorship"]
    if row.get("status") == "provisionally accepted":
        node["provisional"] = True
    return node


def _build_to_family(
    row: dict[str, Any],
    *,
    refresh: bool,
    depth: int,
    counter: dict[str, int],
    families: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    node = _node_from(row)
    rank = node["rank"]
    if rank == FAMILY_RANK:
        families[node["name"]] = node
        return node
    # Anything at or below genus reached without passing a family (it
    # happens in odd corners of the checklist) is kept as a leaf.
    if rank in (GENUS_RANK, "species", "subspecies") or depth >= MAX_DEPTH:
        return node
    if row.get("childCount", 0) == 0:
        return node
    rows, truncated = _children(
        row["id"], refresh=refresh,
        limit=config.COL_CHILD_PAGE_LIMIT, counter=counter,
    )
    if truncated:
        node["truncated"] = True
    children = [
        _build_to_family(child, refresh=refresh, depth=depth + 1,
                         counter=counter, families=families)
        for child in rows
    ]
    children.sort(key=lambda item: item["name"])
    if children:
        node["children"] = children
    return node


def _build_focus_subtree(
    family_node: dict[str, Any], *, refresh: bool, counter: dict[str, int],
    depth: int = 0,
) -> dict[str, Any]:
    """Genus and species depth for one focus family.

    Recursive, because COL interleaves subfamilies and tribes between a
    family and its genera (Felidae -> Pantherinae -> Panthera); stopping
    at the first level silently dropped every genus in such families.
    Species lists are capped per genus; intermediate levels use the
    ordinary children cap. Depth-limited as a loop guard.
    """
    subtree = dict(family_node)
    rows, truncated = _children(
        family_node["id"], refresh=refresh,
        limit=config.COL_CHILD_PAGE_LIMIT, counter=counter,
    )
    if truncated:
        subtree["truncated"] = True
    children = []
    for row in rows:
        child = _node_from(row)
        rank = row.get("rank")
        has_children = row.get("childCount", 0) > 0
        if rank == GENUS_RANK and has_children:
            species_rows, species_truncated = _children(
                row["id"], refresh=refresh,
                limit=config.COL_SPECIES_PER_GENUS_LIMIT, counter=counter,
            )
            if species_truncated:
                child["truncated"] = True
            species = [_node_from(item) for item in species_rows]
            species.sort(key=lambda item: item["name"])
            if species:
                child["children"] = species
        elif (rank not in ("species", "subspecies") and has_children
              and depth < 4):
            child = _build_focus_subtree(
                child, refresh=refresh, counter=counter, depth=depth + 1,
            )
        children.append(child)
    children.sort(key=lambda item: item["name"])
    if children:
        subtree["children"] = children
    return subtree


def _collect_ids(node: dict[str, Any], into: list[str]) -> None:
    if node.get("id"):
        into.append(node["id"])
    for child in node.get("children", []):
        _collect_ids(child, into)


def _wikidata_lookup(
    ids: list[str], *, refresh: bool,
) -> dict[str, dict[str, str]]:
    """COL id -> {wiki, common, desc} via batched SPARQL on P10585."""
    lookup: dict[str, dict[str, str]] = {}
    batches = [
        ids[start:start + WIKIDATA_BATCH]
        for start in range(0, len(ids), WIKIDATA_BATCH)
    ]
    for index, batch in enumerate(batches):
        values = " ".join(json.dumps(colid) for colid in batch)
        query = _WIKIDATA_QUERY.format(values=values)
        # Cache key from the batch CONTENT: re-chunking or reordering can
        # never serve one batch's rows as another's (§21).
        digest = hashlib.sha256("|".join(batch).encode("utf-8")).hexdigest()[:16]
        response = fetch(
            f"{config.WIKIDATA_SPARQL}?format=json&query="
            + urllib.parse.quote(query),
            refresh=refresh,
            subdir="taxonomy",
            filename=f"wikidata-{digest}.json",
            expect_json=True,
        )
        if (index + 1) % 10 == 0:
            print(f"      ...wikidata batch {index + 1}/{len(batches)}",
                  flush=True)
        for row in response.read_json()["results"]["bindings"]:
            colid = row["colid"]["value"]
            entry = lookup.setdefault(colid, {})
            article = row.get("article", {}).get("value")
            if article and "wiki" not in entry:
                title = urllib.parse.unquote(
                    article.rsplit("/wiki/", 1)[-1]
                ).replace("_", " ")
                entry["wiki"] = title
            common = row.get("common", {}).get("value")
            if common and "common" not in entry:
                entry["common"] = common
            desc = row.get("itemDescription", {}).get("value")
            if desc and "desc" not in entry:
                entry["desc"] = desc
            # Round-2 §39: P18 image (Commons filename, licence checked
            # later), NCBI/OTT ids for Lifemap and OneZoom links, and the
            # stated start of the taxon's temporal range.
            image = row.get("image", {}).get("value")
            if image and "imageFile" not in entry:
                entry["imageFile"] = urllib.parse.unquote(
                    image.rsplit("/", 1)[-1]
                ).replace("_", " ")
            ncbi = row.get("ncbi", {}).get("value")
            if ncbi and "ncbi" not in entry:
                entry["ncbi"] = ncbi
            ott = row.get("ott", {}).get("value")
            if ott and "ott" not in entry:
                entry["ott"] = ott
            range_start = row.get("rangeStart", {}).get("value")
            if range_start and "rangeStart" not in entry:
                entry["rangeStart"] = range_start
    return lookup


def _first_ma(range_start: str) -> float | None:
    """Wikidata P523 time value -> millions of years before present."""
    match = re.match(r"^(-\d+)", range_start)
    if not match:
        return None
    year = int(match.group(1))
    if year > -100_000:  # too recent to state in Ma; skip oddities
        return None
    return round(-year / 1e6, 2)


def _apply_metadata(
    node: dict[str, Any],
    lookup: dict[str, dict[str, str]],
    notes: dict[str, str],
    images: dict[str, dict[str, Any]],
    pageimages: dict[str, str],
    stats: dict[str, int],
) -> None:
    entry = lookup.get(node.get("id", ""), {})
    # Explicit null, never absence: the check:taxonomy gate distinguishes
    # "we checked, there is no article" from "we forgot to check".
    node["wiki"] = entry.get("wiki") or None
    if entry.get("common"):
        node["common"] = entry["common"]
    if entry.get("desc"):
        node["desc"] = entry["desc"]
    # Round-2 §39: photo (P18 preferred, article lead image as fallback,
    # both licence-gated through the Commons metadata), external ids, and
    # the stated start of the temporal range. img is ALWAYS present:
    # an object, or null meaning "checked, no free image" (the page then
    # shows its placeholder silhouette).
    filename = entry.get("imageFile") or (
        pageimages.get(node["wiki"]) if node["wiki"] else None
    )
    node["img"] = images.get(filename or "") or None
    if entry.get("ncbi"):
        node["ncbi"] = entry["ncbi"]
    if entry.get("ott"):
        node["ott"] = entry["ott"]
    if entry.get("rangeStart"):
        first = _first_ma(entry["rangeStart"])
        if first is not None:
            node["firstMa"] = first
    note = notes.get(f"{node['name']}|{node['rank']}")
    if note:
        node["note"] = note
    stats["nodes"] += 1
    if node["wiki"]:
        stats["with_wiki"] += 1
    if node["img"]:
        stats["with_image"] += 1
    for child in node.get("children", []):
        _apply_metadata(child, lookup, notes, images, pageimages, stats)


def _bubble_images(
    node: dict[str, Any],
    focus_reps: dict[str, tuple[dict[str, Any], str]] | None,
    stats: dict[str, int],
) -> tuple[dict[str, Any], str] | None:
    """Round-2 feedback pass: a taxon with no free photo of its own borrows
    the first descendant's (depth-first), labelled with that descendant's
    name — a photographed member IS a correct illustration of the group
    (standard taxobox practice). Runs after _apply_metadata; `focus_reps`
    lets the family nodes in the main tree borrow from their own focus
    subtrees, whose depth lives in separate documents. Returns the node's
    best (img-without-rep, source-name) for the parent to borrow.
    """
    best: tuple[dict[str, Any], str] | None = None
    for child in node.get("children") or []:
        found = _bubble_images(child, focus_reps, stats)
        if best is None and found is not None:
            best = found
    img = node.get("img")
    if img:
        clean = {k: v for k, v in img.items() if k != "rep"}
        return (clean, img.get("rep") or node["name"])
    if best is None and focus_reps is not None:
        best = focus_reps.get(node.get("id", ""))
    if best is not None:
        node["img"] = dict(best[0])
        node["img"]["rep"] = best[1]
        stats["bubbled"] += 1
    return best


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry  # taxa are not countries
    out_dir = config.DATA_DIR / "biology" / "taxonomy"
    focus_dir = out_dir / "focus"
    out_dir.mkdir(parents=True, exist_ok=True)
    focus_dir.mkdir(parents=True, exist_ok=True)

    focus_ref = json.loads(
        (config.REFERENCE_DIR / "taxonomy_focus.json").read_text("utf-8")
    )
    notes_ref = json.loads(
        (config.REFERENCE_DIR / "taxonomy_notes.json").read_text("utf-8")
    )
    focus_names: set[str] = set(focus_ref["families"])
    notes: dict[str, str] = notes_ref["notes"]

    dataset_response = fetch(
        f"{config.CHECKLISTBANK_API}/dataset/{config.COL_DATASET}.json",
        refresh=refresh, subdir="taxonomy", filename="dataset.json",
        expect_json=True,
    )
    dataset = dataset_response.read_json()
    release = dataset.get("version") or dataset.get("issued") or "unknown"

    counter = {"calls": 0}
    roots_page = _api(
        f"/dataset/{config.COL_DATASET}/tree?limit=20",
        refresh=refresh, filename="roots.json",
    )
    root_rows = [
        row for row in roots_page.get("result", [])
        if row.get("status") == "accepted"
    ]
    if len(root_rows) < 3:
        raise FetchError(
            f"COL tree root returned {len(root_rows)} accepted nodes; "
            f"expected the three domains plus viruses. The dataset moved "
            f"under us -- fix the traversal, do not publish a stump."
        )

    print(f"    traversing Catalogue of Life {release} to {FAMILY_RANK} "
          f"rank...", flush=True)
    families: dict[str, dict[str, Any]] = {}
    top_level = [
        _build_to_family(row, refresh=refresh, depth=0,
                         counter=counter, families=families)
        for row in root_rows
    ]
    top_level.sort(key=lambda item: item["name"])
    print(f"    {counter['calls']} tree calls, "
          f"{len(families)} families reached", flush=True)

    missing_focus = sorted(focus_names - set(families))
    if missing_focus:
        raise FetchError(
            "taxonomy_focus.json names families absent from the current COL "
            "release: " + ", ".join(missing_focus) +
            ". Update the reference file deliberately rather than letting "
            "curated depth vanish."
        )

    focus_subtrees: dict[str, dict[str, Any]] = {}
    for name in sorted(focus_names):
        family_node = families[name]
        family_node["focus"] = True
        focus_subtrees[family_node["id"]] = _build_focus_subtree(
            family_node, refresh=refresh, counter=counter,
        )
    print(f"    focus depth for {len(focus_subtrees)} families "
          f"({counter['calls']} total tree calls)", flush=True)

    root: dict[str, Any] = {
        "id": "",
        "name": "Life",
        "rank": "root",
        "names": sum(node.get("names", 0) for node in top_level),
        "children": top_level,
    }

    ids: list[str] = []
    _collect_ids(root, ids)
    for subtree in focus_subtrees.values():
        _collect_ids(subtree, ids)
    ids = sorted(set(filter(None, ids)))
    print(f"    mapping {len(ids)} taxa to Wikipedia via Wikidata "
          f"P10585...", flush=True)
    lookup = _wikidata_lookup(ids, refresh=refresh)

    # ---- Round-2 §39: Wikipedia extracts and licence-gated photos --------
    titles = sorted({e["wiki"] for e in lookup.values() if e.get("wiki")})
    print(f"    fetching {len(titles)} Wikipedia extracts (batched)...",
          flush=True)
    extracts = commons.wikipedia_extracts(
        titles, refresh=refresh, subdir="taxonomy",
    )
    pageimages = {
        title: record["pageimage"]
        for title, record in extracts.items()
        if record.get("pageimage")
    }
    image_files = sorted(
        {e["imageFile"] for e in lookup.values() if e.get("imageFile")}
        | {
            pageimages[e["wiki"]]
            for e in lookup.values()
            if e.get("wiki") and not e.get("imageFile")
            and e["wiki"] in pageimages
        }
    )
    print(f"    checking licences for {len(image_files)} candidate "
          f"images...", flush=True)
    metadata, _meta_resp = commons.fetch_metadata(
        image_files, refresh=refresh, subdir="taxonomy",
    )
    images: dict[str, dict[str, Any]] = {}
    for filename in image_files:
        meta = metadata.get(filename)
        licence = (meta or {}).get("license") or ""
        if meta and _FREE.search(licence):
            images[filename] = {
                "url": commons.image_url_for(filename, 320),
                "license": licence,
                "author": meta.get("author"),
                "page": commons.file_page_for(filename),
            }

    stats = {"nodes": 0, "with_wiki": 0, "with_image": 0}
    _apply_metadata(root, lookup, notes, images, pageimages, stats)
    focus_stats = {"nodes": 0, "with_wiki": 0, "with_image": 0}
    for subtree in focus_subtrees.values():
        _apply_metadata(subtree, lookup, notes, images, pageimages,
                        focus_stats)

    # Representative photos (round-2 feedback): focus subtrees first, so
    # their family nodes in the main tree can borrow the same pick.
    bubble_stats = {"bubbled": 0}
    focus_reps: dict[str, tuple[dict[str, Any], str]] = {}
    for family_id, subtree in focus_subtrees.items():
        found = _bubble_images(subtree, None, bubble_stats)
        if found is not None:
            focus_reps[family_id] = found
    _bubble_images(root, focus_reps, bubble_stats)
    print(f"    representative photos bubbled onto {bubble_stats['bubbled']}"
          " taxa without their own", flush=True)

    # Extract shards: the full intro texts would balloon tree.json, so the
    # page fetches them per-shard on selection. 32 shards keyed by the
    # first two hex digits of the node id's sha1.
    shard_count = 32
    shards: list[dict[str, str]] = [{} for _ in range(shard_count)]

    def shard_of(node_id: str) -> int:
        return int(
            hashlib.sha1(node_id.encode("utf-8")).hexdigest()[:2], 16,
        ) % shard_count

    def collect_extracts(node: dict[str, Any]) -> None:
        wiki = node.get("wiki")
        node_id = node.get("id")
        if wiki and node_id:
            extract = (extracts.get(wiki) or {}).get("extract")
            if extract:
                shards[shard_of(node_id)][node_id] = extract
        for child in node.get("children", []):
            collect_extracts(child)

    collect_extracts(root)
    for subtree in focus_subtrees.values():
        collect_extracts(subtree)
    extracts_dir = out_dir / "extracts"
    extracts_dir.mkdir(parents=True, exist_ok=True)
    for index, shard in enumerate(shards):
        (extracts_dir / f"{index:02d}.json").write_text(
            json.dumps(shard, separators=(",", ":"), ensure_ascii=False)
            + "\n",
            encoding="utf-8", newline="\n",
        )
    print(f"    extracts: {sum(len(s) for s in shards)} across "
          f"{shard_count} shards; images kept: {len(images)}", flush=True)

    document = {
        "source": "Catalogue of Life (ChecklistBank dataset 3LR)",
        "release": release,
        "rank_floor": FAMILY_RANK,
        "col_dataset_url":
            f"https://www.checklistbank.org/dataset/{config.COL_DATASET}",
        # Round-2 §39: intro texts live in extracts/{00..1f}.json, fetched
        # per shard on selection; this stamp is what "retrieved" means on
        # the page. Photos are per-node (P18 or article lead image), kept
        # only under PD/CC licences, attribution inline.
        "extractShards": 32,
        "extractsRetrieved": dataset_response.fetched_at[:10],
        "imageNote": (
            "Taxon photos come from Wikimedia Commons (Wikidata P18, or "
            "the article's lead image), kept only under public-domain or "
            "CC licences; attribution shows with each. A taxon without "
            "its own free photo shows a member's, labelled as a "
            "representative; only taxa with no photographed member at "
            "all show the placeholder silhouette."
        ),
        "tree": root,
    }
    (out_dir / "tree.json").write_text(
        json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    for family_id, subtree in focus_subtrees.items():
        safe = urllib.parse.quote(family_id, safe="")
        (focus_dir / f"{safe}.json").write_text(
            json.dumps(subtree, separators=(",", ":"), ensure_ascii=False)
            + "\n",
            encoding="utf-8", newline="\n",
        )

    log_dir = config.REPO_ROOT / "etl" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / "taxonomy.log").write_text(
        json.dumps({
            "release": release,
            "tree_nodes": stats["nodes"],
            "tree_with_wikipedia": stats["with_wiki"],
            "focus_nodes": focus_stats["nodes"],
            "focus_with_wikipedia": focus_stats["with_wiki"],
            "families": len(families),
            "focus_families": sorted(focus_names),
        }, indent=2) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "catalogue_of_life",
        title=f"Catalogue of Life, {release} (ChecklistBank)",
        url=f"{config.CHECKLISTBANK_API}/dataset/{config.COL_DATASET}",
        licence="CC BY 4.0",
        fetched_at=dataset_response.fetched_at,
        upstream_release=str(release),
        vintage=str(release),
        citation=(
            "Catalogue of Life Checklist, via ChecklistBank (CC BY 4.0); "
            "Wikipedia links via Wikidata P10585 (CC0)"
        ),
        notes=(
            f"Traversed to {FAMILY_RANK} rank via the tree API "
            f"({stats['nodes']} nodes); genus/species depth for "
            f"{len(focus_subtrees)} editorially chosen well-known families "
            f"(etl/reference/taxonomy_focus.json). Contested placements "
            f"annotated from etl/reference/taxonomy_notes.json. "
            f"{stats['with_wiki']} of {stats['nodes']} tree nodes carry an "
            f"English Wikipedia article; the rest say so explicitly."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "biology/taxonomy/tree.json",
        description=(
            "Tree of life from the synthetic Life root to family rank, with "
            "per-node name counts, Wikipedia links, and contested-placement "
            "notes."
        ),
        sources=["catalogue_of_life"],
        row_count=stats["nodes"],
    )
    manifest_mod.record_artifact(
        manifest, "biology/taxonomy/focus/",
        description=(
            "Genus/species subtrees for the focus families, fetched on "
            "expand."
        ),
        sources=["catalogue_of_life"],
        row_count=focus_stats["nodes"],
    )

    print(f"    tree: {stats['nodes']} nodes "
          f"({stats['with_wiki']} with Wikipedia); focus: "
          f"{focus_stats['nodes']} nodes", flush=True)


__all__ = ["ingest"]
