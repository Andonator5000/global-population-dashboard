"""Tree of life from the Catalogue of Life (Phase 5 §31, round 2 §39,
round 3 phase 3 §44 of DATA_DECISIONS.md).

BACKBONE CHOICE
---------------
Catalogue of Life (ChecklistBank dataset alias 3LR, the latest COL release)
is the primary backbone: the curated consensus checklist, with a proper
three-domain root (Archaea, Bacteria, Eukaryota, plus Viruses as an
unranked lineage). The alternatives compared and declined: GBIF Backbone,
NCBI Taxonomy, Open Tree of Life (§31.1). Wikidata maps each node to its
Wikipedia article via P10585 (Catalogue of Life ID).

WHERE THE ROWS COME FROM (§44.5)
--------------------------------
The whole checklist comes from COL's monthly ColDP bulk export — ONE
~780 MB zip (NameUsage.tsv, 5.4M rows) cached under .cache/taxonomy/coldp/
— instead of ~15k paged tree-API calls. The export carries the same
identifiers the API serves, so links and cached enrichment stay valid. A
compact TSV of the 2.7M accepted rows is derived once per release so
re-runs load in seconds.

SHAPE OF THE OUTPUT
-------------------
- biology/taxonomy/tree.json -- Life down to FAMILY rank, every
  intermediate rank COL records kept (subphylum, gigaclass, parvorder,
  epifamily ...). No child cap: the bulk export has no page size.
- biology/taxonomy/genera/{familyId}.json -- ONE FILE PER FAMILY: the
  family with its subfamilies, tribes, subtribes and genera nested exactly
  as COL records them, each genus with its species count. Fetched by the
  app only when the family is expanded. Species beneath a genus are NOT
  shipped (2.27M rows); the app loads them live from ChecklistBank -- the
  documented render-time exception of §44.5. The editorial focus families
  (etl/reference/taxonomy_focus.json) additionally carry their species
  inline, enriched (migrated from the old focus/ directory).
- biology/taxonomy/extracts/{00..1f}.json -- description texts for tree
  nodes (Wikipedia intros and generated summaries), 32 shards.

DESCRIPTIONS (§44.3): every node carries `descSrc`, filled in this order:
Wikipedia intro extract -> Wikidata description -> a prose Catalogue of
Life remark -> a summary GENERATED from structured facts (rank, parent,
counts, notable members, first appearance). Generated summaries are flagged
in the data and labelled in the UI. Wikipedia enrichment of the ~217k
genera-file nodes is INCREMENTAL: each run looks up a capped number of new
nodes; the committed genera files are the accumulating store; a node not
yet looked up carries `pending: true` (wiki/img null means "not looked up
yet", not "none exists").

Every node records either its English Wikipedia title or an explicit
`"wiki": null` -- the check:taxonomy gate refuses a node with neither.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import shutil
import time
import urllib.parse
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NamedTuple

import requests

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch
from . import commons

# Same free-licence gate the history and evolution stages apply to images.
_FREE = re.compile(r"public domain|cc0|cc[- ]by(?![- ]n[cd])|pd-", re.IGNORECASE)

FAMILY_RANK = "family"
GENUS_RANK = "genus"
# §44.3: the third description tier (Catalogue of Life remarks) was
# EVALUATED and switched off. 254,882 accepted rows carry a remark and
# 91,050 pass a prose heuristic, but sampling shows they are curators'
# nomenclatural notes ("Unresolved nomenclatural problems based on the
# Principle of Homonymy", "revised by Daffner (1987a); gender feminine ...")
# and Kew range strings ("Temp. & Subalpine. Northern Hemisphere to C.
# America") -- true, but not descriptions, and shipping them under a
# "description" heading would misrepresent them. The remark column is still
# kept in the compact TSV; flip this to True to re-enable the tier.
COL_REMARKS_AS_DESCRIPTIONS = False
SPECIES_RANK = "species"
SHARD_COUNT = 32
WIKIDATA_BATCH = 200

# ChecklistBank's rank vocabulary in ladder order (GET /vocab/rank,
# 2026-09). Used only to decide "at or below genus": the tree stops there.
_RANK_LADDER = [
    "superdomain", "domain", "subdomain", "infradomain", "empire", "realm",
    "subrealm", "superkingdom", "kingdom", "subkingdom", "infrakingdom",
    "superphylum", "phylum", "subphylum", "infraphylum", "parvphylum",
    "microphylum", "nanophylum", "claudius", "gigaclass", "megaclass",
    "superclass", "class", "subclass", "infraclass", "subterclass",
    "parvclass", "superdivision", "division zoology", "subdivision",
    "infradivision", "superlegion", "legion", "sublegion", "infralegion",
    "megacohort", "supercohort", "cohort", "subcohort", "infracohort",
    "gigaorder", "magnorder", "grandorder", "mirorder", "superorder",
    "order", "nanorder", "hypoorder", "minorder", "suborder", "infraorder",
    "parvorder", "supersection zoology", "section zoology",
    "subsection zoology", "superseries zoology", "series zoology",
    "subseries zoology", "falanx", "gigafamily", "megafamily",
    "grandfamily", "superfamily", "epifamily", "family", "subfamily",
    "infrafamily", "supertribe", "tribe", "subtribe", "infratribe",
    "suprageneric name", "supergenus", "genus", "subgenus", "infragenus",
    "division botany", "supersection botany", "section botany",
    "subsection botany", "superseries botany", "series botany",
    "subseries botany", "infrageneric name", "species aggregate", "species",
    "infraspecific name", "grex", "klepton", "subspecies", "cultivar group",
    "convariety", "infrasubspecific name", "proles", "natio", "aberration",
    "morph", "supervariety", "variety", "subvariety", "superform", "form",
    "subform", "pathovar", "biovar", "chemovar", "morphovar", "phagovar",
    "serovar", "chemoform", "forma specialis", "lusus", "cultivar",
    "mutatio", "strain", "other", "unranked",
]
_RANK_INDEX = {name: index for index, name in enumerate(_RANK_LADDER)}
_GENUS_INDEX = _RANK_INDEX[GENUS_RANK]


def _at_or_below_genus(rank: str) -> bool:
    index = _RANK_INDEX.get(rank)
    # Unranked/other nodes are placed by their parent, never treated as
    # genus-level; an unknown new rank string is treated as above genus so
    # it is displayed rather than skipped.
    if index is None or rank in ("unranked", "other"):
        return False
    return index >= _GENUS_INDEX


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


class Row(NamedTuple):
    id: str
    parent: str
    rank: str
    name: str
    auth: str
    status: str
    extinct: bool
    remark: str


# ---------------------------------------------------------------------------
# Bulk export: download, compact, load
# ---------------------------------------------------------------------------

def _coldp_dir() -> Path:
    directory = config.CACHE_DIR / "taxonomy" / "coldp"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _download_bulk(release: str, *, refresh: bool) -> tuple[Path, str]:
    """Stream the ColDP zip to the cache (etl.fetch reads bodies into
    memory, which a 780 MB archive should not). Same sidecar shape as the
    ordinary cache so provenance reads identically."""
    url = config.COL_COLDP_URL_TEMPLATE.format(release=release)
    path = _coldp_dir() / f"{release}_coldp.zip"
    sidecar = path.with_suffix(path.suffix + ".meta.json")
    if path.exists() and sidecar.exists() and not refresh:
        return path, json.loads(sidecar.read_text("utf-8"))["fetched_at"]
    print(f"    downloading COL bulk export {url} ...", flush=True)
    digest = hashlib.sha256()
    size = 0
    tmp = path.with_suffix(".part")
    with requests.get(
        url, stream=True, timeout=config.HTTP_TIMEOUT_SECONDS,
        headers={"User-Agent": config.USER_AGENT},
    ) as response:
        if response.status_code != 200:
            raise FetchError(
                f"{url} returned HTTP {response.status_code}; the bulk "
                f"export for release {release} is not where the dataset "
                f"record says it should be. Aborting rather than building "
                f"a tree from nothing."
            )
        with tmp.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1 << 20):
                handle.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        etag = response.headers.get("ETag")
        last_modified = response.headers.get("Last-Modified")
    tmp.replace(path)
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    sidecar.write_text(json.dumps({
        "url": url,
        "fetched_at": fetched_at,
        "sha256": digest.hexdigest(),
        "size_bytes": size,
        "etag": etag,
        "last_modified": last_modified,
    }, indent=2), encoding="utf-8", newline="\n")
    print(f"    ... {size / 1e6:.0f} MB", flush=True)
    return path, fetched_at


_CITATION = re.compile(r"\d{4}\s*[:;,)]|\bet al\b|\bdoi\b|http|\[|†|\bnov\b", re.IGNORECASE)
_NOT_PROSE = re.compile(
    r"^(validly published|incertae sedis|genus |species |type |nomen|see |"
    r"fossil|synonym|not |unavailable|original|published|cf\.|placed|"
    r"treated|status|described|name |authority|checklist|source|note)",
    re.IGNORECASE,
)


def _prose_remark(text: str) -> str:
    """COL remarks are mostly nomenclatural bookkeeping ('validly published
    under the ICNP. <citation>'); keep only what reads as a description."""
    clean = " ".join((text or "").split())
    if len(clean) < 40 or clean.count(" ") < 6:
        return ""
    if _CITATION.search(clean) or _NOT_PROSE.match(clean):
        return ""
    return clean[:400]


def _compact_bulk(zip_path: Path, compact: Path, vernacular: Path) -> None:
    """One streaming pass over NameUsage.tsv (1.9 GB) keeping the accepted
    rows and the columns the page needs; English vernacular names from
    VernacularName.tsv. Written once per release."""
    csv.field_size_limit(1 << 30)
    print("    compacting NameUsage.tsv (one pass, a few minutes) ...",
          flush=True)
    kept = 0
    seen = 0
    with zipfile.ZipFile(zip_path) as archive:
        with archive.open("NameUsage.tsv") as raw, \
                compact.with_suffix(".part").open(
                    "w", encoding="utf-8", newline="\n") as out:
            text = io.TextIOWrapper(raw, encoding="utf-8", newline="")
            reader = csv.reader(text, delimiter="\t", quoting=csv.QUOTE_NONE)
            header = next(reader)
            col = {name: index for index, name in enumerate(header)}
            fields = [col[key] for key in (
                "col:ID", "col:parentID", "col:status", "col:rank",
                "col:scientificName", "col:authorship", "col:extinct",
                "col:remarks",
            )]
            for row in reader:
                seen += 1
                if seen % 1_000_000 == 0:
                    print(f"      ...{seen // 1_000_000}M rows", flush=True)
                if len(row) <= fields[-1]:
                    continue
                status = row[fields[2]]
                if status not in ("accepted", "provisionally accepted"):
                    continue
                values = [row[index] for index in fields]
                values[-1] = _prose_remark(values[-1])
                out.write("\t".join(
                    value.replace("\t", " ").replace("\n", " ")
                    for value in values
                ) + "\n")
                kept += 1
        with archive.open("VernacularName.tsv") as raw, \
                vernacular.with_suffix(".part").open(
                    "w", encoding="utf-8", newline="\n") as out:
            text = io.TextIOWrapper(raw, encoding="utf-8", newline="")
            reader = csv.reader(text, delimiter="\t", quoting=csv.QUOTE_NONE)
            header = next(reader)
            col = {name: index for index, name in enumerate(header)}
            i_id, i_name, i_lang, i_pref = (
                col["col:taxonID"], col["col:name"], col["col:language"],
                col["col:preferred"],
            )
            for row in reader:
                if len(row) <= i_pref or row[i_lang] != "eng":
                    continue
                name = " ".join(row[i_name].split())
                if name:
                    out.write(f"{row[i_id]}\t{row[i_pref]}\t{name}\n")
    compact.with_suffix(".part").replace(compact)
    vernacular.with_suffix(".part").replace(vernacular)
    print(f"    ... {kept} accepted rows of {seen}", flush=True)


def _load_bulk(
    release: str, *, refresh: bool,
) -> tuple[dict[str, Row], dict[str, str], str]:
    zip_path, fetched_at = _download_bulk(release, refresh=refresh)
    compact = _coldp_dir() / f"{release}_accepted.tsv"
    vernacular = _coldp_dir() / f"{release}_vernacular_en.tsv"
    if not compact.exists() or not vernacular.exists():
        _compact_bulk(zip_path, compact, vernacular)
    rows: dict[str, Row] = {}
    with compact.open("r", encoding="utf-8", newline="\n") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 8:
                continue
            rows[parts[0]] = Row(
                id=parts[0], parent=parts[1], status=parts[2], rank=parts[3],
                name=parts[4], auth=parts[5], extinct=parts[6] == "true",
                remark=parts[7],
            )
    common: dict[str, str] = {}
    preferred: set[str] = set()
    with vernacular.open("r", encoding="utf-8", newline="\n") as handle:
        for line in handle:
            taxon_id, pref, name = line.rstrip("\n").split("\t", 2)
            if pref == "true":
                common[taxon_id] = name
                preferred.add(taxon_id)
            elif taxon_id not in common:
                common[taxon_id] = name
    return rows, common, fetched_at


# ---------------------------------------------------------------------------
# Counting and tree building
# ---------------------------------------------------------------------------

def _index(rows: dict[str, Row]) -> tuple[dict[str, list[str]], dict[str, list[int]], int]:
    """children lists, per-node [descendants, species, genera] counts, and
    the number of rows dropped because their parent is not an accepted
    row (a handful in every release)."""
    kids: dict[str, list[str]] = {}
    counts: dict[str, list[int]] = {}
    dropped = 0
    for row in rows.values():
        if row.parent and row.parent not in rows:
            dropped += 1
            continue
        kids.setdefault(row.parent, []).append(row.id)
    parent_of = {row.id: row.parent for row in rows.values()}
    for row in rows.values():
        if row.parent and row.parent not in rows:
            continue
        is_species = row.rank == SPECIES_RANK
        is_genus = row.rank == GENUS_RANK
        cursor = row.parent
        while cursor:
            bucket = counts.get(cursor)
            if bucket is None:
                bucket = counts[cursor] = [0, 0, 0]
            bucket[0] += 1
            if is_species:
                bucket[1] += 1
            if is_genus:
                bucket[2] += 1
            cursor = parent_of.get(cursor, "")
    return kids, counts, dropped


def _node_from(row: Row, counts: dict[str, list[int]], common: dict[str, str]) -> dict[str, Any]:
    bucket = counts.get(row.id) or [0, 0, 0]
    node: dict[str, Any] = {
        "id": row.id,
        "name": row.name,
        "rank": row.rank or "unranked",
        "names": bucket[0],
    }
    if row.auth:
        node["auth"] = row.auth
    if row.status == "provisionally accepted":
        node["provisional"] = True
    if row.extinct:
        node["extinct"] = True
    if bucket[1]:
        node["spp"] = bucket[1]
    if common.get(row.id):
        node["common"] = common[row.id]
    return node


def _sorted_children(ids: list[str], rows: dict[str, Row]) -> list[Row]:
    return sorted((rows[i] for i in ids), key=lambda r: r.name)


def _build_tree(
    row: Row, *, rows: dict[str, Row], kids: dict[str, list[str]],
    counts: dict[str, list[int]], common: dict[str, str],
    families: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    node = _node_from(row, counts, common)
    child_ids = kids.get(row.id, [])
    if row.rank == FAMILY_RANK:
        bucket = counts.get(row.id) or [0, 0, 0]
        if child_ids:
            # `gen` marks "this family has an on-demand genera file" --
            # set even when the count is 0 (18 families in the tree, e.g.
            # Sarcomeniaceae, have accepted descendants but no genus-rank
            # row among them). Without it the tree node carries neither
            # `gen`, `kids` nor `children`, so the UI can never expand a
            # family whose genera file the ETL writes and populates below.
            node["gen"] = bucket[2]
            families[row.id] = node
        return node
    if _at_or_below_genus(row.rank):
        # Reached without passing a family (bacteria under an order,
        # incertae sedis corners): a leaf here, expanded LIVE in the app.
        if child_ids:
            node["kids"] = len(child_ids)
        return node
    if child_ids:
        node["children"] = [
            _build_tree(child, rows=rows, kids=kids, counts=counts,
                        common=common, families=families)
            for child in _sorted_children(child_ids, rows)
        ]
    return node


def _build_genera(
    family: Row, *, rows: dict[str, Row], kids: dict[str, list[str]],
    counts: dict[str, list[int]], common: dict[str, str], focus: bool,
) -> dict[str, Any]:
    """The family's on-demand file: intermediate ranks nested as recorded,
    genera as leaves with counts (live species), or — for a focus family —
    with their direct children inline (capped, flagged)."""

    def rec(row: Row) -> dict[str, Any]:
        node = _node_from(row, counts, common)
        child_ids = kids.get(row.id, [])
        if _at_or_below_genus(row.rank):
            if not child_ids:
                return node
            if focus:
                ordered = _sorted_children(child_ids, rows)
                limit = config.COL_SPECIES_PER_GENUS_LIMIT
                if len(ordered) > limit:
                    node["truncated"] = True
                    ordered = ordered[:limit]
                children = []
                for child in ordered:
                    leaf = _node_from(child, counts, common)
                    grand = kids.get(child.id, [])
                    if grand:
                        leaf["kids"] = len(grand)
                    children.append(leaf)
                node["children"] = children
                node["kids"] = len(child_ids)
            else:
                node["kids"] = len(child_ids)
            return node
        if child_ids:
            node["children"] = [rec(child) for child in _sorted_children(child_ids, rows)]
        return node

    return rec(family)


def _walk(node: dict[str, Any], parent: dict[str, Any] | None = None):
    yield node, parent
    for child in node.get("children") or []:
        yield from _walk(child, node)


# ---------------------------------------------------------------------------
# Enrichment stores (§44.5): id -> Wikidata entry, title -> extract,
# filename -> Commons metadata. Kept under .cache so a local re-run only
# fetches the delta whatever happens to batch boundaries; on a cold CI
# cache the batches are simply refetched.
# ---------------------------------------------------------------------------

class _Store:
    def __init__(self, name: str) -> None:
        self.path = config.CACHE_DIR / "taxonomy" / f"{name}-store.json"
        self.data: dict[str, Any] = {}
        if self.path.exists():
            try:
                self.data = json.loads(self.path.read_text("utf-8"))
            except json.JSONDecodeError:
                self.data = {}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(self.data, separators=(",", ":"), ensure_ascii=False),
            encoding="utf-8", newline="\n",
        )


def _wikidata_batches(ids: list[str], *, refresh: bool, store: _Store) -> None:
    """COL id -> {wiki, common, desc, imageFile, ncbi, ott, rangeStart}
    via batched SPARQL on P10585; every requested id lands in the store
    (None when Wikidata has no item), so it is never asked twice."""
    missing = sorted({i for i in ids if i and i not in store.data})
    if not missing:
        return
    batches = [
        missing[start:start + WIKIDATA_BATCH]
        for start in range(0, len(missing), WIKIDATA_BATCH)
    ]
    print(f"      wikidata: {len(missing)} ids in {len(batches)} batches",
          flush=True)
    for index, batch in enumerate(batches):
        values = " ".join(json.dumps(colid) for colid in batch)
        query = _WIKIDATA_QUERY.format(values=values)
        # Cache key from the batch CONTENT (§21): re-chunking can never
        # serve one batch's rows as another's.
        digest = hashlib.sha256("|".join(batch).encode("utf-8")).hexdigest()[:16]
        try:
            response = fetch(
                f"{config.WIKIDATA_SPARQL}?format=json&query="
                + urllib.parse.quote(query),
                refresh=refresh, subdir="taxonomy",
                filename=f"wikidata-{digest}.json", expect_json=True,
            )
        except FetchError as exc:
            print(f"      wikidata batch {index + 1} failed: {exc}", flush=True)
            continue
        found: dict[str, dict[str, str]] = {}
        for row in response.read_json()["results"]["bindings"]:
            colid = row["colid"]["value"]
            entry = found.setdefault(colid, {})
            article = row.get("article", {}).get("value")
            if article and "wiki" not in entry:
                entry["wiki"] = urllib.parse.unquote(
                    article.rsplit("/wiki/", 1)[-1]
                ).replace("_", " ")
            for key, field in (
                ("common", "common"), ("itemDescription", "desc"),
                ("ncbi", "ncbi"), ("ott", "ott"), ("rangeStart", "rangeStart"),
            ):
                value = row.get(key, {}).get("value")
                if value and field not in entry:
                    entry[field] = value
            image = row.get("image", {}).get("value")
            if image and "imageFile" not in entry:
                entry["imageFile"] = urllib.parse.unquote(
                    image.rsplit("/", 1)[-1]
                ).replace("_", " ")
        for colid in batch:
            store.data[colid] = found.get(colid)
        if (index + 1) % 10 == 0 or index + 1 == len(batches):
            print(f"      ...wikidata batch {index + 1}/{len(batches)}",
                  flush=True)
            store.save()
        if not response.from_cache:
            time.sleep(0.5)
    store.save()


def _extract_batches(titles: list[str], *, refresh: bool, store: _Store) -> None:
    missing = sorted({t for t in titles if t and t not in store.data})
    if not missing:
        return
    print(f"      wikipedia extracts: {len(missing)} titles", flush=True)
    for start in range(0, len(missing), 400):
        chunk = missing[start:start + 400]
        records = commons.wikipedia_extracts(chunk, refresh=refresh, subdir="taxonomy")
        for title in chunk:
            record = records.get(title)
            store.data[title] = (
                {"extract": record.get("extract") or "",
                 "pageimage": record.get("pageimage")}
                if record else None
            )
        store.save()
        print(f"      ...extracts {min(start + 400, len(missing))}/{len(missing)}",
              flush=True)


def _image_batches(filenames: list[str], *, refresh: bool, store: _Store) -> None:
    missing = sorted({f for f in filenames if f and f not in store.data})
    if not missing:
        return
    print(f"      commons licences: {len(missing)} files", flush=True)
    for start in range(0, len(missing), 500):
        chunk = missing[start:start + 500]
        metadata, _responses = commons.fetch_metadata(
            chunk, refresh=refresh, subdir="taxonomy",
        )
        for name in chunk:
            meta = metadata.get(name)
            store.data[name] = (
                {"license": meta.get("license"), "author": meta.get("author")}
                if meta else None
            )
        store.save()


class _Enricher:
    """The three stores plus the derivation of a node's enrichment."""

    def __init__(self) -> None:
        self.wikidata = _Store("wikidata")
        self.extracts = _Store("extracts")
        self.images = _Store("images")

    def lookup(self, ids: list[str], *, refresh: bool) -> None:
        _wikidata_batches(ids, refresh=refresh, store=self.wikidata)
        titles = [
            entry["wiki"] for i in ids
            if (entry := self.wikidata.data.get(i)) and entry.get("wiki")
        ]
        _extract_batches(titles, refresh=refresh, store=self.extracts)
        files: list[str] = []
        for i in ids:
            entry = self.wikidata.data.get(i)
            if not entry:
                continue
            if entry.get("imageFile"):
                files.append(entry["imageFile"])
            elif entry.get("wiki"):
                record = self.extracts.data.get(entry["wiki"])
                if record and record.get("pageimage"):
                    files.append(record["pageimage"])
        _image_batches(files, refresh=refresh, store=self.images)

    def known(self, taxon_id: str) -> bool:
        return taxon_id in self.wikidata.data

    def entry(self, taxon_id: str) -> dict[str, Any]:
        return self.wikidata.data.get(taxon_id) or {}

    def extract(self, title: str | None) -> str:
        if not title:
            return ""
        record = self.extracts.data.get(title)
        return " ".join(((record or {}).get("extract") or "").split())

    def image(self, entry: dict[str, Any]) -> dict[str, Any] | None:
        filename = entry.get("imageFile")
        if not filename and entry.get("wiki"):
            record = self.extracts.data.get(entry["wiki"])
            filename = (record or {}).get("pageimage")
        if not filename:
            return None
        meta = self.images.data.get(filename)
        licence = (meta or {}).get("license") or ""
        if not meta or not _FREE.search(licence):
            return None
        return {
            "url": commons.image_url_for(filename, 320),
            "license": licence,
            "author": meta.get("author"),
            "page": commons.file_page_for(filename),
        }


def _first_ma(range_start: str) -> float | None:
    """Wikidata P523 time value -> millions of years before present."""
    match = re.match(r"^(-\d+)", range_start)
    if not match:
        return None
    year = int(match.group(1))
    if year > -100_000:  # too recent to state in Ma; skip oddities
        return None
    return round(-year / 1e6, 2)


def _apply_entry(node: dict[str, Any], entry: dict[str, Any], enricher: _Enricher) -> None:
    """Explicit null, never absence: the gate distinguishes 'we checked,
    there is no article' from 'we forgot to check'."""
    node["wiki"] = entry.get("wiki") or None
    if entry.get("common") and not node.get("common"):
        node["common"] = entry["common"]
    node["img"] = enricher.image(entry)
    if entry.get("ncbi"):
        node["ncbi"] = entry["ncbi"]
    if entry.get("ott"):
        node["ott"] = entry["ott"]
    if entry.get("rangeStart"):
        first = _first_ma(entry["rangeStart"])
        if first is not None:
            node["firstMa"] = first


# ---------------------------------------------------------------------------
# Descriptions (§44.3)
# ---------------------------------------------------------------------------

def _plural(count: int, one: str, many: str) -> str:
    return f"{count:,} {one if count == 1 else many}"


def _generated_summary(node: dict[str, Any], parent: dict[str, Any] | None) -> str:
    """Mirror of generatedSummary() in src/lib/taxonomy.ts — the SAME
    template composes genera-file and live nodes at render time."""
    rank = "clade" if node["rank"] == "unranked" else node["rank"]
    article = "an" if rank[:1].lower() in "aeiou" else "a"
    text = f"{node['name']} is {article} {rank}"
    if parent and parent.get("rank") != "root":
        prank = "clade" if parent["rank"] == "unranked" else parent["rank"]
        text += f" in the {prank} {parent['name']}"
    if node.get("auth"):
        text += f", described by {node['auth']}"
    text += "."
    facts: list[str] = []
    child_count = len(node.get("children") or []) or node.get("kids") or 0
    if node.get("spp") and node["rank"] != SPECIES_RANK:
        facts.append(
            f"Catalogue of Life records {_plural(node['spp'], 'species', 'species')} beneath it"
        )
    elif node.get("names"):
        facts.append(
            f"Catalogue of Life records {_plural(node['names'], 'taxon', 'taxa')} beneath it"
        )
    elif child_count:
        facts.append(
            "Catalogue of Life records "
            + _plural(child_count, "direct subdivision", "direct subdivisions")
        )
    if node.get("gen"):
        facts.append(f"in {_plural(node['gen'], 'genus', 'genera')}")
    if facts:
        text += " " + " ".join(facts) + "."
    notable = [
        f"{c['name']} ({c['common']})" if c.get("common") else c["name"]
        for c in (node.get("children") or [])
        if c.get("wiki") or c.get("common")
    ][:3]
    if notable:
        text += f" Members include {', '.join(notable)}."
    if node.get("firstMa") is not None:
        text += (
            f" Its first appearance in the fossil record is put at about "
            f"{node['firstMa']} million years ago (Wikidata)."
        )
    if node.get("extinct"):
        text += " Catalogue of Life marks it extinct."
    return text


def _describe(
    node: dict[str, Any], parent: dict[str, Any] | None, *,
    extract: str, wikidata_desc: str, remark: str, inline_wikipedia: bool,
) -> str | None:
    """Sets desc/descSrc on the node. Returns the text destined for the
    extract shard (tree nodes) or None when the node carries it inline."""
    node.pop("desc", None)
    if extract:
        node["descSrc"] = "wikipedia"
        if inline_wikipedia:
            node["desc"] = commons.first_sentence(extract, limit=240) or extract[:240]
            return None
        return extract
    if wikidata_desc:
        node["descSrc"] = "wikidata"
        node["desc"] = wikidata_desc
        return None
    if remark and COL_REMARKS_AS_DESCRIPTIONS:
        node["descSrc"] = "col"
        node["desc"] = remark
        return None
    node["descSrc"] = "generated"
    if inline_wikipedia:
        return None  # genera files: composed from facts at render time
    return _generated_summary(node, parent)


# ---------------------------------------------------------------------------
# The widened free-photo ladder (round 14, §72)
# ---------------------------------------------------------------------------
#
# Before round 14 a taxon had a picture only when its Wikidata item carried
# P18 or its English Wikipedia article had a lead image -- 8,333 of 35,214
# tree nodes (2,437 of those borrowed from a photographed member). Everything
# else showed a placeholder silhouette. Andy asked for the gaps to be filled
# and, where no free photo exists, for an AI-GENERATED one. Generation is not
# available here (no image-model key) and an AI picture presented as a
# photograph of a taxon would break the CLAUDE.md invariant that no
# flora/fauna image ships unverified against its taxon, so instead the FREE
# sources were widened into a ladder, tried in this order and stopping at the
# first accepted candidate:
#
#   1. Wikidata P18 on the COL-linked item          (pre-existing)
#   2. the English Wikipedia article's lead image   (pre-existing)
#   3. Wikidata P18 reached by TAXON NAME (P225) -- catches the items whose
#      COL id (P10585) is missing or sits on a synonym; ambiguous names
#      (two items, two different pictures) are skipped rather than guessed
#   4. the Wikimedia Commons CATEGORY of the taxon name -- first file that
#      passes the free-licence gate, is a raster photograph, and does not
#      read as a map/range/diagram/cladogram/label/stamp
#   5. GBIF occurrence media (mediaType=StillImage), iNaturalist and
#      Observation.org research-grade datasets preferred, then any publisher;
#      only CC0 / CC BY / CC BY-SA media, credited to rightsHolder/creator
#   6. iNaturalist open data directly (the florafauna stage's pattern), for
#      genus- and species-rank nodes GBIF missed
#   7. a PhyloPic SILHOUETTE, labelled as a silhouette and never as a photo
#      (the licence ranking is evolution.py's: CC0 best, BY/BY-SA accepted,
#      NC/ND never)
#
# Biodiversity Heritage Library plates were in the brief and are NOT used:
# api.biodiversitylibrary.org requires an API key, and this ETL is keyless by
# construction. If the maintainer ever adds a key, BHL slots in at tier 7 as
# `kind: "illustration"`.
#
# Everything is cached on disk under .cache/taxonomy with content-derived
# keys (§21), rate-limited, and INCREMENTAL: each run attempts at most
# TAXONOMY_IMAGE_ENRICH_CAP nodes (highest ranks and biggest groups first)
# and the published artifacts replay the accumulated picks, so the monthly
# refresh keeps going and TAXONOMY_CACHED_ONLY=1 reproduces the same output
# from the caches with no network at all.

#: Nodes the ladder ATTEMPTS per run. Each attempt is up to five HTTP calls
#: against four hosts; measured 2026-10-10 at ~14 nodes a minute cold, so 800
#: is roughly an hour -- the same order as the banknote category walk, and a
#: sensible ceiling for a local run. The monthly refresh can afford more (see
#: DATA_DECISIONS §72.12). TAXONOMY_IMAGE_ENRICH_CAP=n overrides;
#: TAXONOMY_CACHED_ONLY=1 sets it to 0.
#: (Kept here rather than in etl/config.py so the whole ladder is one file;
#: moving it beside TAXONOMY_GENUS_ENRICH_CAP would be a tidy follow-up.)
IMAGE_ENRICH_CAP_DEFAULT = 800

GBIF_API = "https://api.gbif.org/v1"
#: Research-grade citizen-science datasets whose media are consistently
#: identified, free-licensed and credited. Tried before any other publisher.
GBIF_PREFERRED_DATASETS = (
    "50c9509d-22c7-4a22-a47d-8c48425ef4a7",  # iNaturalist Research-grade
    "8a863029-f435-446a-821e-275f4f641165",  # Observation.org
)
#: GBIF records we take media from. A PRESERVED_SPECIMEN, FOSSIL_SPECIMEN or
#: MATERIAL_SAMPLE record's "media" is very often the museum's DIGITISATION
#: of the specimen's paperwork -- a ledger page, an accession card, a slide
#: label -- not a picture of the organism at all. The 2026-10-10 contact
#: sheet found nine such scans in a sample of sixty, every one of them from
#: a specimen-based record (Smithsonian dataset 7e380070 and friends), and
#: no way to tell them from a good specimen photograph by their metadata:
#: they carry no description. So the ladder takes OBSERVATIONS only. The
#: cost is a handful of genuine SEM plates of forams and ostracods; the
#: gain is that nothing on the page is a photograph of a filing cabinet,
#: and the taxa that lose out fall through to a labelled silhouette or the
#: honest placeholder, which is what they should show.
GBIF_LIVING_BASIS = {
    "HUMAN_OBSERVATION", "MACHINE_OBSERVATION", "OBSERVATION",
    "LIVING_SPECIMEN",
}
#: GBIF ranks we can pass to /species/match; our rank vocabulary is wider.
GBIF_RANKS = {
    "kingdom", "phylum", "class", "order", "family", "genus", "species",
    "subspecies", "variety", "form",
}
LADDER_SLEEP_SECONDS = 0.12
#: Candidates kept per node (the deny list can reject the first few and the
#: next one is used WITHOUT a refetch).
LADDER_CANDIDATES = 5

#: NC and ND are never acceptable; everything else is normalised to a label.
_LICENCE_NONFREE = re.compile(
    r"by[-_ ]?nc|non[-_ ]?commercial|by[-_ ]?nd|no[-_ ]?deriv", re.IGNORECASE
)

#: Files that are not pictures OF the organism. Commons categories are full
#: of range maps, cladograms, specimen labels and stamps; an occurrence
#: record's media can be a habitat shot of a signboard.
_NOT_AN_ORGANISM = re.compile(
    r"\b(map|maps|range|ranges|distribution|locator|chart|graph|graphs|"
    r"diagram|diagramm|schematic|infographic|cladogram|phylogeny|"
    r"phylogenetic|dendrogram|stamp|stamps|postage|coin|coins|banknote|"
    r"logo|coat of arms|signature|flag|label|labels|plaque|signboard|"
    r"poster|book cover|title page|frontispiece|handwriting|barcode|"
    r"screenshot|silhouette|icon|table of|chromosome ideogram|"
    r"sequence alignment|gel electrophoresis|ledger|register|logbook|"
    r"accession|index card|catalogue card|catalog card|folio|manuscript|"
    r"life cycle|lifecycle|field notes|notebook)\b",
    re.IGNORECASE,
)
_RASTER_MIME = {"image/jpeg", "image/png", "image/webp"}

#: Hosts that publish a GBIF media URL and then refuse to serve it to
#: anything but their own site. images.ala.org.au's thumbnail proxy answers
#: HTTP 403 to every client we tried, browser user-agent included
#: (2026-10-10), so a pick from it is a guaranteed broken picture.
_HOTLINK_HOSTILE = re.compile(r"images\.ala\.org\.au/image/proxyImage", re.IGNORECASE)

#: A Commons category can hold a file NAMED for a different taxon of the
#: same rank -- Category:Notacanthiformes contains "Synbranchiformes.jpg",
#: a picture of the swamp eels. A file whose first word is itself a
#: suprageneric name and is NOT this taxon's name is somebody else's
#: picture, filed here; a genus or species file name (Panthera leo.jpg) is
#: a legitimate member and is kept.
_SUPRAGENERIC_FILE = re.compile(
    r"^([A-Z][a-z]+(?:iformes|idae|aceae|ales|oidea|inae|idea|ida|ota|"
    r"phyta|mycota|opsida|phyceae|virales|viridae))"
)


def _canonical_licence(raw: str) -> str | None:
    """A free-licence label for a GBIF/iNaturalist/PhyloPic licence string or
    URL, or None when the licence is absent, unknown or NC/ND."""
    text = " ".join((raw or "").split())
    if not text:
        return None
    # GBIF says "CC_BY_SA_4_0", Commons/CC URLs say "licenses/by-sa/4.0",
    # iNaturalist says "cc-by". Underscores are word characters, so they are
    # normalised to hyphens before any \b-anchored match.
    low = re.sub(r"[_\s]+", "-", text.lower())
    if _LICENCE_NONFREE.search(low):
        return None
    match = re.search(r"(\d)[.-](\d)", low)
    version = f" {match.group(1)}.{match.group(2)}" if match else ""
    if "publicdomain/zero" in low or re.search(r"\bcc-?0\b", low):
        return "CC0 1.0"
    if "publicdomain/mark" in low or re.search(r"public-?domain|\bpd\b", low):
        return "Public domain"
    if re.search(r"\bby-sa\b", low):
        return f"CC BY-SA{version}"
    if re.search(r"\bby\b", low):
        return f"CC BY{version}"
    return None


def _image_text(*parts: Any) -> str:
    return " ".join(str(part) for part in parts if part).lower()


def _clean_credit(raw: Any) -> str | None:
    """A renderable credit, or None. GBIF publishers put internal record ids
    in rightsHolder ("-1374429873"); a credit with no letters in it credits
    nobody, and "Unknown author" is the honest fallback the UI already
    renders."""
    text = " ".join(str(raw or "").split())
    if not text or not re.search(r"[A-Za-z]", text):
        return None
    return text[:120]


class _Rejects:
    """etl/reference/taxonomy_image_rejects.json: the reviewed deny list.

    `urls` rejects one picture (the ladder falls through to its next cached
    candidate); `taxa` rejects every ladder picture for a taxon, so the node
    keeps the designed placeholder. Commons filenames are accepted in `urls`
    as well as full URLs, because that is what a reviewer reads off a file
    page."""

    def __init__(self) -> None:
        path = config.REFERENCE_DIR / "taxonomy_image_rejects.json"
        payload = (
            json.loads(path.read_text("utf-8")) if path.exists() else {}
        )
        self.urls = {
            self._key(url): reason
            for url, reason in (payload.get("urls") or {}).items()
        }
        self.taxa: dict[str, str] = payload.get("taxa") or {}

    @staticmethod
    def _norm(text: str) -> str:
        return urllib.parse.unquote(text or "").strip().split("?")[0]             .replace("_", " ").lower()

    @classmethod
    def _key(cls, url: str) -> str:
        """The canonical deny-list key for a picture URL.

        A Commons Special:FilePath hotlink and the bare file name are the
        same picture, so the TAIL is the key. But iNaturalist's tails are
        all `medium.jpeg`, so for those the key keeps the preceding path
        segment as well -- a reviewer rejecting one iNaturalist photo must
        not blacklist every iNaturalist photo on the site."""
        norm = cls._norm(url)
        parts = [part for part in norm.split("/") if part]
        if not parts:
            return norm
        tail = parts[-1]
        if len(parts) > 1 and re.fullmatch(
            r"(original|large|medium|small|square|thumb)\.\w+", tail
        ):
            return "/".join(parts[-2:])
        return tail

    def rejects(self, record: dict[str, Any]) -> bool:
        url = record.get("url", "")
        if self._key(url) in self.urls:
            return True
        # A reviewer may paste the whole URL; match that too.
        return self._norm(url) in self.urls


def _ladder_record(
    *, url: str, licence: str, author: str | None, page: str, source: str,
    kind: str, rep: str | None,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "url": url,
        "license": licence,
        "author": author or None,
        "page": page,
        "src": source,
        "kind": kind,
    }
    if rep:
        record["rep"] = rep
    return record


# ---- tier 3: Wikidata P18 by taxon name (P225) -----------------------------

_WIKIDATA_NAME_QUERY = """
SELECT ?name ?article ?image ?common WHERE {{
  VALUES ?name {{ {values} }}
  ?item wdt:P225 ?name .
  OPTIONAL {{
    ?article schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> .
  }}
  OPTIONAL {{ ?item wdt:P18 ?image . }}
  OPTIONAL {{ ?item wdt:P1843 ?common . FILTER(LANG(?common) = "en") }}
}}
"""


def _wikidata_name_batches(
    names: list[str], *, refresh: bool, store: _Store,
) -> None:
    """Taxon NAME -> {wiki, imageFile, common} via P225, for taxa whose COL
    id is not on any Wikidata item. A name that two items claim with two
    DIFFERENT pictures is recorded as ambiguous and never used: a homonym
    across kingdoms (Prunella the plant vs. the bird) must not borrow the
    other's photo."""
    missing = sorted({n for n in names if n and n not in store.data})
    if not missing:
        return
    batches = [
        missing[start:start + WIKIDATA_BATCH]
        for start in range(0, len(missing), WIKIDATA_BATCH)
    ]
    print(f"      wikidata by taxon name: {len(missing)} names in "
          f"{len(batches)} batches", flush=True)
    for index, batch in enumerate(batches):
        values = " ".join(json.dumps(name) for name in batch)
        query = _WIKIDATA_NAME_QUERY.format(values=values)
        digest = hashlib.sha256("|".join(batch).encode("utf-8")).hexdigest()[:16]
        try:
            response = fetch(
                f"{config.WIKIDATA_SPARQL}?format=json&query="
                + urllib.parse.quote(query),
                refresh=refresh, subdir="taxonomy",
                filename=f"wikidata-name-{digest}.json", expect_json=True,
            )
        except FetchError as exc:
            print(f"      wikidata-name batch {index + 1} failed: {exc}",
                  flush=True)
            continue
        found: dict[str, dict[str, Any]] = {}
        for row in response.read_json()["results"]["bindings"]:
            name = row["name"]["value"]
            entry = found.setdefault(name, {"images": set()})
            article = row.get("article", {}).get("value")
            if article and "wiki" not in entry:
                entry["wiki"] = urllib.parse.unquote(
                    article.rsplit("/wiki/", 1)[-1]
                ).replace("_", " ")
            common = row.get("common", {}).get("value")
            if common and "common" not in entry:
                entry["common"] = common
            image = row.get("image", {}).get("value")
            if image:
                entry["images"].add(
                    urllib.parse.unquote(image.rsplit("/", 1)[-1]).replace("_", " ")
                )
        for name in batch:
            entry = found.get(name)
            if not entry:
                store.data[name] = None
                continue
            images = entry.pop("images")
            record = dict(entry)
            if len(images) == 1:
                record["imageFile"] = next(iter(images))
            elif len(images) > 1:
                record["ambiguous"] = True
            store.data[name] = record
        if (index + 1) % 10 == 0 or index + 1 == len(batches):
            store.save()
        if not response.from_cache:
            time.sleep(0.5)
    store.save()


# ---- tier 4: the Commons category of the taxon name ------------------------

def _commons_category_candidates(
    name: str, *, refresh: bool,
) -> list[dict[str, Any]]:
    """Files in Category:<taxon name> that are free-licensed raster
    photographs of an organism. One API call per taxon; the generator brings
    the licence, author, description, size and MIME back with the list, so no
    second metadata pass is needed."""
    url = (
        f"{config.COMMONS_API_URL}?action=query&format=json"
        f"&generator=categorymembers&gcmtype=file&gcmlimit=50"
        f"&gcmtitle={urllib.parse.quote('Category:' + name)}"
        f"&prop=imageinfo&iiprop=extmetadata%7Csize%7Cmime&redirects=1"
    )
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:16]
    try:
        response = fetch(
            url, refresh=refresh, subdir="taxonomy/commonscat",
            filename=f"cat-{digest}.json", expect_json=True,
        )
    except FetchError:
        return []
    if not response.from_cache:
        time.sleep(LADDER_SLEEP_SECONDS)
    pages = (response.read_json().get("query") or {}).get("pages") or {}
    scored: list[tuple[int, dict[str, Any]]] = []
    for page in pages.values():
        title = (page.get("title") or "").removeprefix("File:")
        info = (page.get("imageinfo") or [{}])[0]
        if not title or "missing" in page:
            continue
        if (info.get("mime") or "") not in _RASTER_MIME:
            continue
        width = info.get("width") or 0
        height = info.get("height") or 0
        if width < 320 or height < 240:
            continue
        meta = info.get("extmetadata") or {}
        licence = (meta.get("LicenseShortName") or {}).get("value") or ""
        if not _FREE.search(licence):
            continue
        description = commons.strip_html(
            (meta.get("ImageDescription") or {}).get("value") or ""
        )
        categories = (meta.get("Categories") or {}).get("value") or ""
        if _NOT_AN_ORGANISM.search(_image_text(title, description, categories)):
            continue
        named = _SUPRAGENERIC_FILE.match(title)
        if named and named.group(1).lower() != name.lower():
            continue
        author = commons.strip_html(
            (meta.get("Artist") or {}).get("value") or ""
        ) or None
        # A file whose own name carries the taxon name is the safest pick in
        # a category that also holds habitat and museum shots.
        score = 0 if name.lower() in title.lower() else 1
        scored.append((score, _ladder_record(
            url=commons.image_url_for(title, 640),
            licence=licence, author=author,
            page=commons.file_page_for(title),
            source="commons", kind="photo", rep=None,
        )))
    scored.sort(key=lambda pair: pair[0])
    return [record for _score, record in scored[:LADDER_CANDIDATES]]


# ---- tier 5: GBIF occurrence media -----------------------------------------

def _gbif_usage_key(name: str, rank: str, *, refresh: bool) -> int | None:
    """GBIF usageKey for an EXACT name match, or None.

    Verification notes (probed 2026-10-10): `strict=true` answers
    matchType NONE with "Multiple equal matches" for a homonym (Prunella,
    Drosophila) -- exactly the behaviour we want, so a homonym never borrows
    the other kingdom's photo. It also answers matchType HIGHERRANK for a
    perfectly good above-species match (Tetrigidae), and passing the `rank`
    parameter made it answer Animalia for `Panthera`, so the rank is NOT
    sent -- the canonical name and the returned rank are checked instead.
    """
    url = f"{GBIF_API}/species/match?" + urllib.parse.urlencode(
        {"name": name, "strict": "true"}
    )
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]
    try:
        response = fetch(
            url, refresh=refresh, subdir="taxonomy/gbif",
            filename=f"match-{digest}.json", expect_json=True,
        )
    except FetchError:
        return None
    if not response.from_cache:
        time.sleep(LADDER_SLEEP_SECONDS)
    payload = response.read_json()
    canonical = (payload.get("canonicalName") or "").strip()
    if canonical.lower() != name.strip().lower():
        return None
    matched_rank = (payload.get("rank") or "").lower()
    if rank in GBIF_RANKS and matched_rank and matched_rank != rank:
        return None
    key = payload.get("usageKey")
    return int(key) if isinstance(key, int) else None


def _gbif_media_candidates(
    taxon_key: int, name: str, *, preferred: bool, refresh: bool,
) -> list[dict[str, Any]]:
    params = [
        ("taxonKey", str(taxon_key)),
        ("mediaType", "StillImage"),
        ("limit", "20"),
    ]
    if preferred:
        params.extend(("datasetKey", key) for key in GBIF_PREFERRED_DATASETS)
    url = f"{GBIF_API}/occurrence/search?" + urllib.parse.urlencode(params)
    digest = hashlib.sha256(
        f"{taxon_key}|{'pref' if preferred else 'any'}".encode("utf-8")
    ).hexdigest()[:16]
    try:
        response = fetch(
            url, refresh=refresh, subdir="taxonomy/gbif",
            filename=f"occ-{digest}.json", expect_json=True,
        )
    except FetchError:
        return []
    if not response.from_cache:
        time.sleep(LADDER_SLEEP_SECONDS)
    out: list[dict[str, Any]] = []
    for record in response.read_json().get("results") or []:
        if (record.get("basisOfRecord") or "") not in GBIF_LIVING_BASIS:
            continue
        # A citizen scientist cannot photograph a virus. An occurrence of a
        # viral taxon is an observation of its HOST -- Cirlivirales came back
        # as a photograph of bare tree branches, from an iNaturalist record
        # of a parrot circovirus (contact sheet 2026-10-10, seed 41, tile
        # 51). GBIF classifies these under kingdom "Viruses"; the whole
        # lineage is skipped, and viral taxa fall through to a PhyloPic
        # silhouette or the placeholder.
        if (record.get("kingdom") or "") == "Viruses":
            continue
        organism = (
            record.get("species")
            or record.get("acceptedScientificName")
            or record.get("scientificName")
            or ""
        )
        # Strip the authorship GBIF appends to accepted names.
        organism = " ".join(organism.split()[:2]) if organism else ""
        for media in record.get("media") or []:
            if (media.get("type") or "") != "StillImage":
                continue
            image_url = (media.get("identifier") or "").strip()
            if not image_url.startswith(("http://", "https://")):
                continue
            if _HOTLINK_HOSTILE.search(image_url):
                continue
            licence = _canonical_licence(media.get("license") or "")
            if not licence:
                continue
            description = _image_text(
                media.get("title"), media.get("description"),
                record.get("habitat"),
            )
            if _NOT_AN_ORGANISM.search(description):
                continue
            if "inaturalist-open-data" in image_url or "static.inaturalist" in image_url:
                image_url = re.sub(
                    r"/(original|large)\.(\w+)$", r"/medium.\2", image_url
                )
            author = _clean_credit(
                media.get("rightsHolder") or media.get("creator")
                or record.get("recordedBy")
            )
            page = (
                media.get("references")
                or (f"https://www.gbif.org/occurrence/{record['key']}"
                    if record.get("key") else "")
            )
            if not page:
                continue
            rep = organism if organism and organism.lower() != name.lower() else None
            out.append(_ladder_record(
                url=image_url, licence=licence, author=author, page=page,
                source="gbif", kind="photo", rep=rep,
            ))
            break  # one picture per occurrence; variety beats duplicates
        if len(out) >= LADDER_CANDIDATES:
            break
    return out


# ---- tier 6: iNaturalist open data (the florafauna pattern) ----------------

def _inat_candidates(
    name: str, rank: str, *, refresh: bool,
) -> list[dict[str, Any]]:
    """The community's best CC0/CC-BY photo, verified to be the queried
    taxon (iNaturalist's search is fuzzy -- §22's lesson)."""
    try:
        taxa_response = fetch(
            config.INATURALIST_TAXA_URL.format(query=urllib.parse.quote(name)),
            refresh=refresh, subdir="taxonomy/inat", expect_json=True,
        )
        if not taxa_response.from_cache:
            time.sleep(config.INATURALIST_THROTTLE_SECONDS)
        taxa = taxa_response.read_json().get("results") or []
        if not taxa:
            return []
        taxon = taxa[0]
        if (taxon.get("name") or "").strip().lower() != name.strip().lower():
            return []
        if (taxon.get("rank") or "").lower() != rank.lower():
            return []
        observations_response = fetch(
            config.INATURALIST_OBSERVATIONS_URL.format(taxon_id=taxon["id"]),
            refresh=refresh, subdir="taxonomy/inat", expect_json=True,
        )
        if not observations_response.from_cache:
            time.sleep(config.INATURALIST_THROTTLE_SECONDS)
        observations = observations_response.read_json().get("results") or []
    except FetchError:
        return []
    out: list[dict[str, Any]] = []
    for observation in observations:
        organism = ((observation.get("taxon") or {}).get("name") or "").strip()
        for photo in observation.get("photos") or []:
            url = photo.get("url") or ""
            if "inaturalist-open-data" not in url:
                continue
            if not re.search(r"/square\.(\w+)$", url):
                continue
            licence = _canonical_licence(photo.get("license_code") or "")
            if not licence:
                continue
            rep = organism if organism and organism.lower() != name.lower() else None
            out.append(_ladder_record(
                url=re.sub(r"/square\.(\w+)$", r"/medium.\1", url),
                licence=licence, author=photo.get("attribution"),
                page=config.INATURALIST_PHOTO_PAGE.format(photo_id=photo["id"]),
                source="inaturalist", kind="photo", rep=rep,
            ))
            break
        if len(out) >= LADDER_CANDIDATES:
            break
    return out


# ---- tier 7: PhyloPic silhouettes (never a photo) --------------------------

def _phylopic_candidates(
    name: str, *, build: int, refresh: bool,
) -> list[dict[str, Any]]:
    digest = hashlib.sha256(name.lower().encode("utf-8")).hexdigest()[:16]
    try:
        response = fetch(
            f"{config.PHYLOPIC_API}/images?build={build}"
            f"&filter_name={urllib.parse.quote(name.lower())}"
            f"&page=0&embed_items=true",
            refresh=refresh, subdir="taxonomy/phylopic",
            filename=f"phylopic-{digest}.json", expect_json=True,
        )
    except FetchError:
        return []
    if not response.from_cache:
        time.sleep(LADDER_SLEEP_SECONDS)
    items = (response.read_json().get("_embedded") or {}).get("items") or []
    ranked: list[tuple[int, dict[str, Any]]] = []
    for item in items:
        links = item.get("_links") or {}
        href = ((links.get("license") or {}).get("href") or "").lower()
        if "nc" in href or "nd" in href:
            continue
        if re.search(r"publicdomain/(zero|mark)", href):
            rank = 0
        elif "/by/" in href:
            rank = 1
        elif "/by-sa/" in href:
            rank = 2
        else:
            continue
        rasters = links.get("rasterFiles") or []
        if not rasters:
            continue
        raster = rasters[min(len(rasters) - 1, len(rasters) // 2)]
        uuid = ((links.get("self") or {}).get("href") or "").split("?")[0]
        uuid = uuid.rsplit("/", 1)[-1]
        matched = (links.get("self") or {}).get("title") or name
        ranked.append((rank, _ladder_record(
            url=raster["href"],
            licence=_canonical_licence(href) or "CC0 1.0",
            author=item.get("attribution"),
            page=f"https://www.phylopic.org/images/{uuid}",
            source="phylopic", kind="silhouette",
            rep=matched if matched.lower() != name.lower() else None,
        )))
    ranked.sort(key=lambda pair: pair[0])
    return [record for _rank, record in ranked[:LADDER_CANDIDATES]]


# ---- the ladder --------------------------------------------------------------

class _ImageLadder:
    """Candidate lists per taxon, cached on disk, plus the pick.

    The STORE holds the raw candidate list for every taxon the ladder has
    attempted ({"tiers": [...], "cands": [...]}), so a pick is a pure
    function of the cache and the deny list: editing
    etl/reference/taxonomy_image_rejects.json and re-running (even with
    TAXONOMY_CACHED_ONLY=1) repicks without one HTTP call."""

    def __init__(self, rejects: _Rejects) -> None:
        self.store = _Store("imageladder")
        self.names = _Store("wikiname")
        self.rejects = rejects
        self._build: int | None = None
        self.attempted = 0
        self.tier_hits: dict[str, int] = {}

    def phylopic_build(self, *, refresh: bool) -> int | None:
        if self._build is None:
            try:
                response = fetch(
                    f"{config.PHYLOPIC_API}/", refresh=refresh,
                    subdir="taxonomy", filename="phylopic-root.json",
                    expect_json=True,
                )
                self._build = int(response.read_json()["build"])
            except (FetchError, KeyError, ValueError):
                self._build = 0
        return self._build or None

    def known(self, taxon_id: str) -> bool:
        return taxon_id in self.store.data

    def pick(self, taxon_id: str) -> dict[str, Any] | None:
        """The first candidate the reviewer has not rejected."""
        if taxon_id in self.rejects.taxa:
            return None
        entry = self.store.data.get(taxon_id)
        if not entry:
            return None
        for record in entry.get("cands") or []:
            if not self.rejects.rejects(record):
                return dict(record)
        return None

    def attempt(
        self, node: dict[str, Any], *, refresh: bool,
        enricher: _Enricher,
    ) -> None:
        """Walk the ladder for one node, recording every candidate found."""
        taxon_id = node["id"]
        name = node["name"]
        rank = node.get("rank") or "unranked"
        candidates: list[dict[str, Any]] = []
        tiers: list[str] = []

        def keep(found: list[dict[str, Any]]) -> list[dict[str, Any]]:
            """Reviewed rejections are applied HERE as well as at pick time,
            so a tier whose every candidate is on the deny list falls through
            to the next RUNG rather than leaving the taxon with nothing.
            (pick() filters again, so a rejection added after this run still
            takes effect offline -- it just cannot reopen a later rung until
            the taxon is attempted again.)"""
            return [record for record in found if not self.rejects.rejects(record)]

        # tier 3 -- Wikidata P18 reached by taxon name.
        entry = self.names.data.get(name)
        if entry and not entry.get("ambiguous") and entry.get("imageFile"):
            tiers.append("wikidata-name")
            meta = enricher.images.data.get(entry["imageFile"])
            licence = (meta or {}).get("license") or ""
            if meta and _FREE.search(licence):
                candidates = keep([_ladder_record(
                    url=commons.image_url_for(entry["imageFile"], 640),
                    licence=licence, author=meta.get("author"),
                    page=commons.file_page_for(entry["imageFile"]),
                    source="commons", kind="photo", rep=None,
                )])

        # tier 4 -- the Commons category of the name.
        if not candidates:
            tiers.append("commons-category")
            candidates = keep(_commons_category_candidates(name, refresh=refresh))

        # tier 5 -- GBIF occurrence media, preferred datasets then any.
        if not candidates:
            tiers.append("gbif")
            key = _gbif_usage_key(name, rank, refresh=refresh)
            if key is not None:
                candidates = keep(_gbif_media_candidates(
                    key, name, preferred=True, refresh=refresh,
                ))
                if not candidates:
                    candidates = keep(_gbif_media_candidates(
                        key, name, preferred=False, refresh=refresh,
                    ))

        # tier 6 -- iNaturalist directly, for genus/species only.
        if not candidates and rank in ("genus", "species", "subspecies"):
            tiers.append("inaturalist")
            candidates = keep(_inat_candidates(name, rank, refresh=refresh))

        # tier 7 -- a PhyloPic silhouette, labelled as such.
        if not candidates:
            build = self.phylopic_build(refresh=refresh)
            if build:
                tiers.append("phylopic")
                candidates = keep(_phylopic_candidates(
                    name, build=build, refresh=refresh,
                ))

        self.store.data[taxon_id] = {"tiers": tiers, "cands": candidates}
        self.attempted += 1
        if candidates:
            self.tier_hits[candidates[0]["src"]] = (
                self.tier_hits.get(candidates[0]["src"], 0) + 1
            )

    def save(self) -> None:
        self.store.save()
        self.names.save()


_LADDER_RANK_WEIGHT = {
    "domain": 95, "realm": 94, "subdomain": 92, "kingdom": 92,
    "subkingdom": 89, "infrakingdom": 87,
    "phylum": 86, "subphylum": 83, "infraphylum": 81, "parvphylum": 80,
    "gigaclass": 79, "megaclass": 79, "superclass": 78, "class": 77,
    "subclass": 75, "infraclass": 73, "subterclass": 72, "parvclass": 72,
    "superorder": 69, "order": 70, "suborder": 67, "infraorder": 66,
    "parvorder": 64, "nanorder": 63,
    "family": 62, "superfamily": 60, "epifamily": 59,
    "subfamily": 50, "tribe": 48, "supertribe": 47, "subtribe": 45,
    "infratribe": 44,
    "genus": 30, "subgenus": 28,
    "species": 20, "subspecies": 18,
}
#: A species inside an editorial focus family is a destination (§44.5), so it
#: outranks an ordinary genus.
_LADDER_FOCUS_BONUS = 25


def _ladder_priority(node: dict[str, Any], *, focus: bool) -> tuple[int, int]:
    weight = _LADDER_RANK_WEIGHT.get(node.get("rank") or "", 40)
    if focus:
        weight += _LADDER_FOCUS_BONUS
    return (-weight, -int(node.get("names") or 0))


def _collect_uncovered(
    node: dict[str, Any],
    reps: set[str] | None,
    out: list[dict[str, Any]],
) -> bool:
    """Post-order pass mirroring _bubble_images WITHOUT mutating: returns
    True when this subtree holds any picture, and appends every node that
    would still show the placeholder to `out`."""
    covered = bool(node.get("img"))
    for child in node.get("children") or []:
        if _collect_uncovered(child, reps, out):
            covered = True
    if not covered and reps is not None and node.get("id") in reps:
        covered = True
    if not covered and node.get("id") and not node.get("pending"):
        out.append(node)
    return covered


# ---------------------------------------------------------------------------
# Representative photos (§42.7)
# ---------------------------------------------------------------------------

def _bubble_images(
    node: dict[str, Any],
    reps: dict[str, tuple[dict[str, Any], str]] | None,
    stats: dict[str, int],
) -> tuple[dict[str, Any], str] | None:
    """A taxon with no free photo of its own borrows the first descendant's
    (depth-first), labelled with that descendant's name. `reps` lets
    family nodes in the main tree borrow from their genera files."""
    best: tuple[dict[str, Any], str] | None = None
    for child in node.get("children") or []:
        found = _bubble_images(child, reps, stats)
        if best is None and found is not None:
            best = found
    img = node.get("img")
    if img:
        clean = {k: v for k, v in img.items() if k not in ("rep", "bub")}
        return (clean, img.get("rep") or node["name"])
    if best is None and reps is not None:
        best = reps.get(node.get("id", ""))
    if best is not None and not node.get("pending"):
        # A pending node (§44.5) ships the flag ALONE -- wiki/img/desc are
        # all implied null until enrichment reaches it. Giving it a
        # bubbled `img` here would violate that (check-taxonomy.mjs
        # rejects pending + img together) even though nothing was wrong
        # with the photo itself. Still RETURN `best` unassigned so the
        # bubble reaches a non-pending ancestor further up.
        node["img"] = dict(best[0])
        node["img"]["rep"] = best[1]
        # `bub` = "this picture is a copy of a descendant's, not a lookup of
        # this taxon's own" (round 14). It is what lets the next run replay
        # the ladder's OWN picks out of the published artifacts without
        # mistaking 4,900 bubbled copies for 4,900 ladder results.
        node["img"]["bub"] = True
        stats["bubbled"] += 1
    return best


# ---------------------------------------------------------------------------
# Previous artifacts = the durable enrichment store for genera (§44.5)
# ---------------------------------------------------------------------------

_ENRICHMENT_KEYS = ("wiki", "common", "desc", "descSrc", "img", "ncbi", "ott", "firstMa")

#: Image sources the ladder can record. A record with no `src` is a plain
#: Wikidata-P18/Wikipedia-lead Commons photo (tiers 1-2), the pre-round-14
#: default, left unmarked so 17k genera-file records do not grow.
LADDER_SOURCES = ("commons", "gbif", "inaturalist", "phylopic")


def _previous_ladder_picks(
    out_dir: Path, genera_dir: Path,
) -> dict[str, dict[str, Any]]:
    """Ladder picks already published, replayed into the store so the
    accumulated coverage survives a cold .cache (the same trick
    _previous_genera plays for genus enrichment)."""
    picks: dict[str, dict[str, Any]] = {}

    def harvest(payload: Any) -> None:
        for node, _parent in _walk(payload):
            image = node.get("img")
            if not node.get("id") or not isinstance(image, dict):
                continue
            if image.get("src") in LADDER_SOURCES and not image.get("rep"):
                picks[node["id"]] = {
                    key: value for key, value in image.items() if key != "rep"
                }

    tree_path = out_dir / "tree.json"
    if tree_path.exists():
        try:
            harvest(json.loads(tree_path.read_text("utf-8")).get("tree", {}))
        except json.JSONDecodeError:
            pass
    if genera_dir.exists():
        for path in genera_dir.glob("*.json"):
            try:
                harvest(json.loads(path.read_text("utf-8")))
            except json.JSONDecodeError:
                continue
    return picks


def _previous_genera(genera_dir: Path) -> dict[str, dict[str, Any]]:
    """Enrichment already committed for genera-file nodes (non-pending)."""
    store: dict[str, dict[str, Any]] = {}
    if not genera_dir.exists():
        return store
    for path in genera_dir.glob("*.json"):
        try:
            subtree = json.loads(path.read_text("utf-8"))
        except json.JSONDecodeError:
            continue
        for node, _parent in _walk(subtree):
            if node.get("pending") or "wiki" not in node or not node.get("id"):
                continue
            store[node["id"]] = {
                key: node[key] for key in _ENRICHMENT_KEYS if key in node
            }
    return store


def _coverage(nodes_iter) -> dict[str, Any]:  # noqa: ANN001
    """Picture coverage by rank, for the log: own photo / borrowed from a
    member / silhouette / still a placeholder."""
    by_rank: dict[str, dict[str, int]] = {}
    totals = {"nodes": 0, "own": 0, "rep": 0, "silhouette": 0, "none": 0,
              "pending": 0}
    for node in nodes_iter:
        rank = node.get("rank") or "unranked"
        bucket = by_rank.setdefault(
            rank,
            {"nodes": 0, "own": 0, "rep": 0, "silhouette": 0, "none": 0,
             "pending": 0},
        )
        image = node.get("img")
        for row in (bucket, totals):
            row["nodes"] += 1
            if node.get("pending"):
                row["pending"] += 1
            if not image:
                row["none"] += 1
            else:
                if image.get("kind") == "silhouette":
                    row["silhouette"] += 1
                if image.get("rep"):
                    row["rep"] += 1
                else:
                    row["own"] += 1
    # The log is committed and read by people: rank strings carried by a
    # handful of nodes are rolled up rather than printed one by one.
    ordered = sorted(by_rank.items(), key=lambda item: -item[1]["nodes"])
    kept = {rank: row for rank, row in ordered if row["nodes"] >= 20}
    rest = [row for rank, row in ordered if row["nodes"] < 20]
    if rest:
        kept["(other ranks, <20 nodes each)"] = {
            key: sum(row[key] for row in rest) for key in rest[0]
        }
    return {"total": totals, "by_rank": kept}


def _dump(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )


# ---------------------------------------------------------------------------
# The stage
# ---------------------------------------------------------------------------

def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry  # taxa are not countries
    started = time.monotonic()
    out_dir = config.DATA_DIR / "biology" / "taxonomy"
    genera_dir = out_dir / "genera"
    extracts_dir = out_dir / "extracts"
    out_dir.mkdir(parents=True, exist_ok=True)

    focus_ref = json.loads(
        (config.REFERENCE_DIR / "taxonomy_focus.json").read_text("utf-8")
    )
    notes_ref = json.loads(
        (config.REFERENCE_DIR / "taxonomy_notes.json").read_text("utf-8")
    )
    focus_names: set[str] = set(focus_ref["families"])
    notes: dict[str, str] = notes_ref["notes"]

    cap = config.TAXONOMY_GENUS_ENRICH_CAP
    if os.environ.get("TAXONOMY_GENUS_ENRICH_CAP"):
        cap = int(os.environ["TAXONOMY_GENUS_ENRICH_CAP"])
    if os.environ.get("TAXONOMY_CACHED_ONLY") == "1":
        cap = 0

    dataset_response = fetch(
        f"{config.CHECKLISTBANK_API}/dataset/{config.COL_DATASET}.json",
        refresh=refresh, subdir="taxonomy", filename="dataset.json",
        expect_json=True,
    )
    dataset = dataset_response.read_json()
    release = dataset.get("version") or dataset.get("issued") or "unknown"

    # ---- rows -------------------------------------------------------------
    rows, common, bulk_fetched_at = _load_bulk(release, refresh=refresh)
    kids, counts, dropped = _index(rows)
    root_rows = _sorted_children(kids.get("", []), rows)
    if len(root_rows) < 3:
        raise FetchError(
            f"COL bulk export has {len(root_rows)} root rows; expected the "
            f"three domains plus viruses. The export moved under us -- fix "
            f"the traversal, do not publish a stump."
        )
    print(f"    {len(rows)} accepted rows ({dropped} orphaned), "
          f"{len(root_rows)} roots; loaded in {time.monotonic() - started:.0f}s",
          flush=True)

    # ---- tree to family, genera files per family ---------------------------
    families: dict[str, dict[str, Any]] = {}
    top_level = [
        _build_tree(row, rows=rows, kids=kids, counts=counts, common=common,
                    families=families)
        for row in root_rows
    ]
    root: dict[str, Any] = {
        "id": "",
        "name": "Life",
        "rank": "root",
        "names": sum(node.get("names", 0) + 1 for node in top_level),
        "children": top_level,
    }
    family_names = {node["name"] for node in families.values()}
    missing_focus = sorted(focus_names - family_names)
    if missing_focus:
        raise FetchError(
            "taxonomy_focus.json names families absent from the current COL "
            "release: " + ", ".join(missing_focus) +
            ". Update the reference file deliberately rather than letting "
            "curated depth vanish."
        )
    genera_files: dict[str, dict[str, Any]] = {}
    for family_id, family_node in families.items():
        focus = family_node["name"] in focus_names
        if focus:
            family_node["focus"] = True
        genera_files[family_id] = _build_genera(
            rows[family_id], rows=rows, kids=kids, counts=counts,
            common=common, focus=focus,
        )
        if focus:
            genera_files[family_id]["focus"] = True
    tree_nodes = sum(1 for _ in _walk(root))
    print(f"    tree: {tree_nodes} nodes to family; {len(genera_files)} "
          f"genera files", flush=True)

    # ---- enrichment: tree + focus species (full), genera (incremental) ----
    enricher = _Enricher()
    if not enricher.wikidata.data:
        # First run with the stores: replay the previous artifacts' id set
        # so the batches it fetched (cached by content) seed the stores
        # without network; only the delta is then fetched.
        seed_ids: list[str] = []
        seed_paths = [out_dir / "tree.json"]
        if (out_dir / "focus").exists():
            seed_paths.extend(sorted((out_dir / "focus").glob("*.json")))
        for path in seed_paths:
            if not path.exists():
                continue
            try:
                payload = json.loads(path.read_text("utf-8"))
            except json.JSONDecodeError:
                continue
            seed_ids.extend(
                node["id"] for node, _p in _walk(payload.get("tree", payload))
                if node.get("id")
            )
        if seed_ids:
            print(f"    seeding enrichment stores from {len(set(seed_ids))} "
                  f"previously published ids (cached batches) ...", flush=True)
            enricher.lookup(sorted(set(seed_ids)), refresh=False)
    tree_ids = [node["id"] for node, _p in _walk(root) if node.get("id")]
    focus_ids = [
        node["id"]
        for family_id, subtree in genera_files.items()
        if subtree.get("focus")
        for node, _p in _walk(subtree) if node.get("id")
    ]
    print(f"    enriching {len(tree_ids)} tree nodes and {len(focus_ids)} "
          f"focus-family nodes via Wikidata P10585 ...", flush=True)
    enricher.lookup(sorted(set(tree_ids) | set(focus_ids)), refresh=refresh)

    previous = _previous_genera(genera_dir)
    focus_set = set(focus_ids)
    candidates: list[tuple[int, str]] = []
    for family_id, subtree in genera_files.items():
        for node, _p in _walk(subtree):
            taxon_id = node.get("id")
            if not taxon_id or taxon_id in focus_set:
                continue
            if enricher.known(taxon_id) or taxon_id in previous:
                continue
            # Intermediate ranks (few, structurally important) first, then
            # the genera with most species.
            priority = 10_000_000 if node["rank"] != GENUS_RANK else 0
            candidates.append((priority + node.get("spp", 0), taxon_id))
    candidates.sort(reverse=True)
    batch_ids = [taxon_id for _priority, taxon_id in candidates[:cap]]
    print(f"    genera enrichment: {len(candidates)} not yet looked up; "
          f"fetching {len(batch_ids)} this run (cap {cap}) ...", flush=True)
    if batch_ids:
        enricher.lookup(batch_ids, refresh=refresh)

    # ---- apply metadata + descriptions ------------------------------------
    shards: list[dict[str, str]] = [{} for _ in range(SHARD_COUNT)]

    def shard_of(node_id: str) -> int:
        return int(hashlib.sha1(node_id.encode("utf-8")).hexdigest()[:2], 16) % SHARD_COUNT

    tree_stats = {"nodes": 0, "with_wiki": 0, "with_image": 0,
                  "wikipedia": 0, "wikidata": 0, "col": 0, "generated": 0}
    for node, parent in _walk(root):
        tree_stats["nodes"] += 1
        taxon_id = node.get("id", "")
        entry = enricher.entry(taxon_id)
        _apply_entry(node, entry, enricher)
        note = notes.get(f"{node['name']}|{node['rank']}")
        if note:
            node["note"] = note
        row = rows.get(taxon_id)
        if node["wiki"]:
            tree_stats["with_wiki"] += 1
        if node["img"]:
            tree_stats["with_image"] += 1
        text = _describe(
            node, parent,
            extract=enricher.extract(node["wiki"]),
            wikidata_desc=entry.get("desc") or "",
            remark=row.remark if row else "",
            inline_wikipedia=False,
        )
        tree_stats[node["descSrc"]] += 1
        if text and taxon_id:
            shards[shard_of(taxon_id)][taxon_id] = text
        elif text and not taxon_id:
            node["desc"] = text  # the synthetic root

    genera_stats = {"nodes": 0, "genera": 0, "enriched": 0, "pending": 0,
                    "with_wiki": 0, "with_image": 0, "wikipedia": 0,
                    "wikidata": 0, "col": 0, "generated": 0,
                    "genera_enriched": 0, "genera_with_wiki": 0}
    for family_id, subtree in genera_files.items():
        for node, parent in _walk(subtree):
            genera_stats["nodes"] += 1
            is_genus = node["rank"] == GENUS_RANK
            if is_genus:
                genera_stats["genera"] += 1
            taxon_id = node["id"]
            row = rows.get(taxon_id)
            remark = row.remark if row else ""
            if enricher.known(taxon_id):
                entry = enricher.entry(taxon_id)
                _apply_entry(node, entry, enricher)
                _describe(
                    node, parent, extract=enricher.extract(node["wiki"]),
                    wikidata_desc=entry.get("desc") or "", remark=remark,
                    inline_wikipedia=True,
                )
            elif taxon_id in previous:
                prior = previous[taxon_id]
                node["wiki"] = prior.get("wiki") or None
                node["img"] = prior.get("img") or None
                for key in ("common", "ncbi", "ott", "firstMa"):
                    if prior.get(key) and not node.get(key):
                        node[key] = prior[key]
                if prior.get("descSrc") in ("wikipedia", "wikidata", "col") and prior.get("desc"):
                    node["descSrc"] = prior["descSrc"]
                    node["desc"] = prior["desc"]
                else:
                    _describe(node, parent, extract="", wikidata_desc="",
                              remark=remark, inline_wikipedia=True)
            else:
                # Not yet looked up (§44.5). The flag alone stands for
                # "wiki null, img null, description generated from facts":
                # the loader expands it and the gate verifies nothing else
                # is smuggled in. Spelling the three keys out on ~220k nodes
                # was 11 MB of boilerplate.
                node["pending"] = True
            note = notes.get(f"{node['name']}|{node['rank']}")
            if note:
                node["note"] = note
            if node.get("pending"):
                genera_stats["pending"] += 1
                genera_stats["generated"] += 1
                continue
            else:
                genera_stats["enriched"] += 1
                if is_genus:
                    genera_stats["genera_enriched"] += 1
            if node["wiki"]:
                genera_stats["with_wiki"] += 1
                if is_genus:
                    genera_stats["genera_with_wiki"] += 1
            if node["img"]:
                genera_stats["with_image"] += 1
            genera_stats[node["descSrc"]] += 1

    # ---- the widened free-photo ladder (§72) --------------------------------
    rejects = _Rejects()
    ladder = _ImageLadder(rejects)
    # Published picks are normally replayed into the store so the accumulated
    # coverage survives a cold .cache. TAXONOMY_IMAGE_LADDER_RESEED=0 turns
    # that off for one run: when the PICKING RULES change (round 14 stopped
    # accepting GBIF specimen-digitisation media after the contact sheet
    # found museum ledger scans among them), the already-published picks must
    # be re-derived from the caches rather than trusted. Needs a warm
    # .cache/taxonomy to be cheap; never set it in CI.
    reseed = os.environ.get("TAXONOMY_IMAGE_LADDER_RESEED", "1") != "0"
    previous_picks = (
        _previous_ladder_picks(out_dir, genera_dir) if reseed else {}
    )
    for taxon_id, record in previous_picks.items():
        if taxon_id not in ladder.store.data:
            ladder.store.data[taxon_id] = {
                "tiers": ["published"], "cands": [record],
            }

    # Which nodes would still show the placeholder after bubbling? Those are
    # the only ones worth a lookup, and the highest ranks and biggest groups
    # among them are what a reader actually lands on.
    uncovered: list[tuple[tuple[int, int], dict[str, Any], bool]] = []
    family_has_photo: set[str] = set()
    for family_id, subtree in genera_files.items():
        # The subtree ROOT is the family, which the tree already carries (and
        # whose photo is mirrored back onto the file after bubbling) -- walk
        # its children so the family is not queued twice.
        found: list[dict[str, Any]] = []
        covered = bool(subtree.get("img"))
        for child in subtree.get("children") or []:
            if _collect_uncovered(child, None, found):
                covered = True
        if covered:
            family_has_photo.add(family_id)
        is_focus = bool(subtree.get("focus"))
        for node in found:
            uncovered.append((_ladder_priority(node, focus=is_focus), node, is_focus))
    tree_uncovered: list[dict[str, Any]] = []
    _collect_uncovered(root, family_has_photo, tree_uncovered)
    for node in tree_uncovered:
        uncovered.append((_ladder_priority(node, focus=False), node, False))
    uncovered.sort(key=lambda item: item[0])

    image_cap = IMAGE_ENRICH_CAP_DEFAULT
    if os.environ.get("TAXONOMY_IMAGE_ENRICH_CAP"):
        image_cap = int(os.environ["TAXONOMY_IMAGE_ENRICH_CAP"])
    if os.environ.get("TAXONOMY_CACHED_ONLY") == "1":
        image_cap = 0
    pending_attempts = [
        node for _priority, node, _focus in uncovered
        if not ladder.known(node["id"])
    ]
    attempt_nodes = pending_attempts[:image_cap]
    if attempt_nodes:
        # Tier 3 is batched SPARQL, so resolve every name first, then the
        # Commons licences of the files it found; the per-node walk below
        # only makes the unbatchable calls.
        _wikidata_name_batches(
            [node["name"] for node in attempt_nodes],
            refresh=refresh, store=ladder.names,
        )
        _image_batches(
            [
                entry["imageFile"]
                for node in attempt_nodes
                if (entry := ladder.names.data.get(node["name"]))
                and not entry.get("ambiguous") and entry.get("imageFile")
            ],
            refresh=refresh, store=enricher.images,
        )
    print(f"    photo ladder: {len(uncovered)} nodes would show the "
          f"placeholder, {len(pending_attempts)} never attempted; trying "
          f"{len(attempt_nodes)} this run (cap {image_cap}) ...", flush=True)
    for index, node in enumerate(attempt_nodes):
        ladder.attempt(node, refresh=refresh, enricher=enricher)
        if (index + 1) % 100 == 0:
            ladder.save()
            print(f"      ...ladder {index + 1}/{len(attempt_nodes)} "
                  f"(hits {ladder.tier_hits})", flush=True)
    ladder.save()

    ladder_stats = {
        "placeholder_nodes_before": len(uncovered),
        "never_attempted_before": len(pending_attempts),
        "attempted_this_run": ladder.attempted,
        "cap_this_run": image_cap,
        "first_tier_hits_this_run": dict(sorted(ladder.tier_hits.items())),
        "applied": 0,
        "by_source": {},
        "by_kind": {},
        "rejected_urls": len(rejects.urls),
        "rejected_taxa": len(rejects.taxa),
    }
    for _priority, node, _focus in uncovered:
        if node.get("img"):
            continue
        record = ladder.pick(node["id"])
        if record is None:
            continue
        node["img"] = record
        ladder_stats["applied"] += 1
        source = record.get("src") or "commons"
        kind = record.get("kind") or "photo"
        ladder_stats["by_source"][source] = (
            ladder_stats["by_source"].get(source, 0) + 1
        )
        ladder_stats["by_kind"][kind] = ladder_stats["by_kind"].get(kind, 0) + 1
    print(f"    photo ladder: {ladder_stats['applied']} pictures applied "
          f"({ladder_stats['by_source']})", flush=True)

    # Representative photos: genera files first so the family nodes in the
    # main tree can borrow their best member's photo.
    bubble_stats = {"bubbled": 0}
    reps: dict[str, tuple[dict[str, Any], str]] = {}
    for family_id, subtree in genera_files.items():
        found = _bubble_images(subtree, None, bubble_stats)
        if found is not None:
            reps[family_id] = found
    _bubble_images(root, reps, bubble_stats)
    # The family node in the file mirrors the tree's (possibly borrowed)
    # photo so both views agree.
    for family_id, subtree in genera_files.items():
        subtree["img"] = families[family_id].get("img")
        subtree["wiki"] = families[family_id].get("wiki")
        for key in ("desc", "descSrc", "common", "ncbi", "ott", "firstMa", "note", "gen"):
            if families[family_id].get(key) is not None:
                subtree[key] = families[family_id][key]
    print(f"    representative photos bubbled onto {bubble_stats['bubbled']} "
          f"taxa without their own", flush=True)

    # ---- write --------------------------------------------------------------
    if genera_dir.exists():
        shutil.rmtree(genera_dir)
    genera_dir.mkdir(parents=True)
    legacy_focus = out_dir / "focus"
    if legacy_focus.exists():
        shutil.rmtree(legacy_focus)  # migrated into genera/ (§44.5)
    total_bytes = 0
    largest = (0, "")
    for family_id, subtree in genera_files.items():
        safe = urllib.parse.quote(family_id, safe="")
        path = genera_dir / f"{safe}.json"
        _dump(path, subtree)
        size = path.stat().st_size
        total_bytes += size
        if size > largest[0]:
            largest = (size, subtree["name"])
    extracts_dir.mkdir(parents=True, exist_ok=True)
    for index, shard in enumerate(shards):
        _dump(extracts_dir / f"{index:02d}.json", shard)

    document = {
        "source": "Catalogue of Life (ChecklistBank dataset 3LR)",
        "release": release,
        "rank_floor": FAMILY_RANK,
        "col_dataset_url":
            f"https://www.checklistbank.org/dataset/{config.COL_DATASET}",
        "extractShards": SHARD_COUNT,
        "extractsRetrieved": dataset_response.fetched_at[:10],
        "imageNote": (
            "Taxon pictures are FREE-LICENSED ONLY (public domain, CC0, "
            "CC BY or CC BY-SA — never NonCommercial or NoDerivatives), "
            "tried in a fixed order: the taxon's Wikidata photo (P18), its "
            "Wikipedia lead image, a Wikidata photo reached by taxon name, "
            "the taxon's Wikimedia Commons category, GBIF occurrence media "
            "(iNaturalist and Observation.org research-grade preferred), "
            "iNaturalist open data, and finally a PhyloPic silhouette, "
            "which is always labelled as a silhouette and never as a "
            "photograph. A taxon with no picture of its own shows a "
            "photographed member's, labelled “Representative”; a taxon with "
            "none at all shows a designed placeholder that says so. Every "
            "picture carries its author, licence and source link. No image "
            "on this page is AI-generated."
        ),
        "imageSources": [
            {"label": "Wikimedia Commons (Wikidata P18, Wikipedia lead "
                       "images, taxon categories)",
             "url": "https://commons.wikimedia.org",
             "licence": "per file: public domain, CC0, CC BY or CC BY-SA"},
            {"label": "GBIF occurrence media (StillImage), iNaturalist and "
                       "Observation.org research-grade preferred",
             "url": "https://www.gbif.org/occurrence/search?media_type=StillImage",
             "licence": "per record: CC0, CC BY or CC BY-SA"},
            {"label": "iNaturalist open data photos",
             "url": "https://www.inaturalist.org",
             "licence": "CC0 or CC BY"},
            {"label": "PhyloPic silhouettes (labelled as silhouettes)",
             "url": "https://www.phylopic.org",
             "licence": "CC0, CC BY or CC BY-SA"},
        ],
        "generaFiles": len(genera_files),
        "generaTotal": genera_stats["genera"],
        "generaEnriched": genera_stats["genera_enriched"],
        "tree": root,
    }
    _dump(out_dir / "tree.json", document)

    log_dir = config.REPO_ROOT / "etl" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    elapsed = round(time.monotonic() - started)
    (log_dir / "taxonomy.log").write_text(
        json.dumps({
            "release": release,
            "bulk_export": config.COL_COLDP_URL_TEMPLATE.format(release=release),
            "bulk_fetched_at": bulk_fetched_at,
            "accepted_rows": len(rows),
            "orphaned_rows": dropped,
            "tree": tree_stats,
            "genera_files": len(genera_files),
            "genera_files_bytes": total_bytes,
            "genera_largest_file": {"bytes": largest[0], "family": largest[1]},
            "genera": genera_stats,
            "photo_ladder": ladder_stats,
            "coverage_tree": _coverage(
                node for node, _p in _walk(root)
            ),
            "coverage_genera": _coverage(
                node
                for subtree in genera_files.values()
                for child in (subtree.get("children") or [])
                for node, _p in _walk(child)
            ),
            "genera_enrichment_cap_this_run": cap,
            "genera_looked_up_this_run": len(batch_ids),
            "genera_still_pending_after_run": max(0, len(candidates) - len(batch_ids)),
            "focus_families": sorted(focus_names),
            "seconds": elapsed,
        }, indent=2) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "catalogue_of_life",
        title=f"Catalogue of Life, {release} (ChecklistBank)",
        url=config.COL_COLDP_URL_TEMPLATE.format(release=release),
        licence="CC BY 4.0",
        fetched_at=bulk_fetched_at,
        upstream_release=str(release),
        vintage=str(release),
        citation=(
            "Catalogue of Life Checklist, via ChecklistBank ColDP bulk export "
            "(CC BY 4.0); Wikipedia links via Wikidata P10585 (CC0); intro "
            "texts from English Wikipedia (CC BY-SA 4.0)"
        ),
        notes=(
            f"Bulk export parsed to {FAMILY_RANK} rank ({tree_stats['nodes']} "
            f"tree nodes, every intermediate rank kept) plus one genera file "
            f"per family ({len(genera_files)} files, {genera_stats['genera']} "
            f"genera); species load live from ChecklistBank. Descriptions: "
            f"tree {tree_stats['wikipedia']} Wikipedia / "
            f"{tree_stats['wikidata']} Wikidata / {tree_stats['col']} COL / "
            f"{tree_stats['generated']} generated; genera-file nodes "
            f"{genera_stats['wikipedia']} / {genera_stats['wikidata']} / "
            f"{genera_stats['col']} / {genera_stats['generated']} "
            f"({genera_stats['pending']} not yet looked up). Contested "
            f"placements annotated from etl/reference/taxonomy_notes.json."
        ),
    )
    if ladder_stats["by_source"].get("gbif"):
        manifest_mod.record_source(
            manifest,
            "gbif_occurrence_media",
            title="GBIF occurrence media (StillImage)",
            url="https://www.gbif.org/occurrence/search?media_type=StillImage",
            licence="per record: CC0 / CC BY / CC BY-SA only",
            fetched_at=bulk_fetched_at,
            upstream_release=None,
            vintage=bulk_fetched_at[:10],
            citation=(
                "GBIF.org occurrence search API; media from iNaturalist "
                "Research-grade Observations and Observation.org preferred, "
                "credited to each record's rightsHolder or creator"
            ),
            notes=(
                f"{ladder_stats['by_source']['gbif']} taxon pictures on the "
                f"Taxonomy page, used only where no Wikidata/Wikipedia/Commons "
                f"photo exists; NC and ND media are never accepted."
            ),
        )
    if ladder_stats["by_source"].get("inaturalist"):
        manifest_mod.record_source(
            manifest,
            "inaturalist_taxonomy",
            title="iNaturalist open-data photos (taxonomy)",
            url="https://www.inaturalist.org",
            licence="CC0 / CC BY only",
            fetched_at=bulk_fetched_at,
            upstream_release=None,
            vintage=bulk_fetched_at[:10],
            citation="iNaturalist research-grade observations, open-data bucket",
            notes=(
                f"{ladder_stats['by_source']['inaturalist']} taxon pictures, "
                f"name-verified against the queried taxon before use."
            ),
        )
    if ladder_stats["by_source"].get("phylopic"):
        manifest_mod.record_source(
            manifest,
            "phylopic_taxonomy",
            title="PhyloPic silhouettes (taxonomy)",
            url="https://www.phylopic.org",
            licence="CC0 / CC BY / CC BY-SA only",
            fetched_at=bulk_fetched_at,
            upstream_release=None,
            vintage=bulk_fetched_at[:10],
            citation="PhyloPic, per-image licences",
            notes=(
                f"{ladder_stats['by_source']['phylopic']} silhouettes, the "
                f"last rung of the picture ladder, labelled as silhouettes "
                f"in the UI and never presented as photographs."
            ),
        )
    manifest_mod.record_artifact(
        manifest, "biology/taxonomy/tree.json",
        description=(
            "Tree of life from the synthetic Life root to family rank, with "
            "per-node counts, Wikipedia links, description sources, and "
            "contested-placement notes."
        ),
        sources=["catalogue_of_life"],
        row_count=tree_stats["nodes"],
    )
    manifest_mod.record_artifact(
        manifest, "biology/taxonomy/genera/",
        description=(
            "One file per family: subfamilies, tribes and genera as COL "
            "records them, fetched on expand; focus families carry species "
            "inline."
        ),
        sources=["catalogue_of_life"],
        row_count=genera_stats["nodes"],
    )
    manifest_mod.record_artifact(
        manifest, "biology/taxonomy/extracts/",
        description=(
            "Description texts for tree nodes (Wikipedia intros, generated "
            "summaries), 32 shards fetched on selection."
        ),
        sources=["catalogue_of_life"],
        row_count=sum(len(s) for s in shards),
    )

    print(f"    tree: {tree_stats['nodes']} nodes ({tree_stats['with_wiki']} "
          f"with Wikipedia); genera files: {len(genera_files)} "
          f"({total_bytes / 1e6:.1f} MB, largest {largest[1]} "
          f"{largest[0] / 1e3:.0f} kB); genera enriched "
          f"{genera_stats['genera_enriched']}/{genera_stats['genera']}; "
          f"{elapsed}s", flush=True)


__all__ = ["ingest"]
