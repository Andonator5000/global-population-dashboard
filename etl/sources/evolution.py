"""Evolution timeline: ICS chart + editorial events + free illustrations.

Phase 6 (DATA_DECISIONS.md §32), round 14 (§73). Four ingredients:

1. THE CHART. The International Chronostratigraphic Chart, from the
   commission's own linked-data publication (i-c-stratigraphy/chart,
   CC BY 4.0). The TTL is machine-generated and regular, so it is parsed
   with a strict block parser that fails loudly if the shape shifts —
   no RDF dependency for one file. Every interval carries its rank, parent,
   boundary ages in Ma with stated margins of error, and the CGMW colour.

2. THE EVENTS. `etl/reference/evolution_events.json` is EDITORIAL, exactly
   like the history timeline's source file: which ~50 moments in four and
   a half billion years make the cut is curation, versioned and validated
   here. Every summary states its own uncertainty where the science is
   unsettled. Nothing about the events is scraped at runtime.

3. THE PICTURES. PhyloPic silhouettes for organisms — only images whose
   recorded licence is CC0/public-domain are kept, with attribution stored
   anyway — and, as fallback, the anchor Wikipedia article's lead image
   through the same Commons licence gate the history stage uses. An event
   whose images are all non-free ships without one.

4. THE TREE (round 14, section 73). `etl/reference/evolution_tree.json`
   is the editorial tree of life through time: ~180 lineages with a
   sourced origin age each (divergence estimate or oldest fossil), the
   extinct ones with an end date, endosymbiosis recorded as merges, and
   PhyloPic silhouettes through the same licence ranking. The stage
   validates the chronology (a child never predates its parent), checks
   every Wikipedia anchor exists, and writes tree.json.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch
from . import commons

_SOURCE = config.REFERENCE_DIR / "evolution_events.json"
# Round 14 (DATA_DECISIONS section 73): the tree of life through time.
_TREE_SOURCE = config.REFERENCE_DIR / "evolution_tree.json"
TREE_ORIGIN_KINDS = ("divergence", "fossil", "estimate")
TREE_STATUSES = ("extant", "extinct")

KINDS = ("event", "organism", "extinction")
_FREE = re.compile(r"public domain|cc0|cc[- ]by(?![- ]n[cd])|pd-", re.IGNORECASE)


def _phylopic_license_rank(href: str) -> int | None:
    """Acceptability rank per the brief: CC0/PD preferred, CC BY and
    CC BY-SA accepted with attribution, NC/ND never. None = rejected."""
    lower = href.lower()
    if re.search(r"publicdomain/(zero|mark)", lower):
        return 0
    if re.search(r"licenses/by(-sa)?/", lower) and "nc" not in lower \
            and "nd" not in lower:
        return 1 if "/by/" in lower else 2
    return None

# Ranks in display order; the chart also carries sub-ages we keep as-is.
ICS_RANKS = ("Super-Eon", "Eon", "Era", "Period", "Sub-Period", "Epoch",
             "Sub-Epoch", "Age")


# --------------------------------------------------------------------------
# ICS chart TTL parsing
# --------------------------------------------------------------------------

_BLOCK = re.compile(r"^gtsd:(\w+)\n(.*?)^\.$", re.MULTILINE | re.DOTALL)
_RANK = re.compile(r"gts:rank rank:([\w-]+)")
_BROADER = re.compile(r"skos:broader gtsd:(\w+)")
_LABEL_EN = re.compile(r'"([^"]+)"@en\b')
_BEGIN = re.compile(r"time:hasBeginning\s*\[([^\]]*)\]", re.DOTALL)
_END = re.compile(r"time:hasEnd\s*\[([^\]]*)\]", re.DOTALL)
_IN_MYA = re.compile(r"gtsd:inMYA\s+([0-9.]+)")
_MARGIN = re.compile(r"schema:marginOfError\s+([0-9.]+)")
_UNCERTAIN = re.compile(r'skos:note\s+"uncertain"')


def _boundary(match: re.Match[str] | None
              ) -> tuple[float | None, float | None, bool]:
    """(age Ma, margin of error, is-uncertain) from one boundary bracket.

    A few boundaries (e.g. Cambrian Stage 10's base) carry the chart's own
    `skos:note "uncertain"` alongside — or instead of — a margin of error;
    that flag is kept, not discarded, so the page can say so.
    """
    if not match:
        return None, None, False
    body = match.group(1)
    age = _IN_MYA.search(body)
    margin = _MARGIN.search(body)
    return (
        float(age.group(1)) if age else None,
        float(margin.group(1)) if margin else None,
        bool(_UNCERTAIN.search(body)),
    )
_COLOR = re.compile(r'schema:color "(#[0-9A-Fa-f]{6})"')
_ORDER = re.compile(r"sh:order (\d+)")
_PREF_BLOCK = re.compile(r"skos:prefLabel(.*?);\n", re.DOTALL)


def _parse_chart(ttl: str) -> list[dict[str, Any]]:
    intervals: list[dict[str, Any]] = []
    for match in _BLOCK.finditer(ttl):
        ident, body = match.group(1), match.group(2)
        rank_match = _RANK.search(body)
        if not rank_match:
            continue  # scheme/collection/boundary blocks, not intervals
        rank = rank_match.group(1)
        pref = _PREF_BLOCK.search(body)
        label_match = _LABEL_EN.search(pref.group(1)) if pref else None
        # A few intervals await formal ratification and carry no prefLabel
        # at all (Upper Pleistocene, pending "Tarantian"); the identifier's
        # CamelCase is the chart's own de facto name for them.
        name = (label_match.group(1) if label_match
                else re.sub(r"(?<=[a-z])(?=[A-Z0-9])", " ", ident))
        start_ma, start_error, start_uncertain = _boundary(_BEGIN.search(body))
        end_ma, end_error, end_uncertain = _boundary(_END.search(body))
        color = _COLOR.search(body)
        order = _ORDER.search(body)
        broader = _BROADER.search(body)
        if start_ma is None:
            raise FetchError(
                f"ICS chart block gtsd:{ident} ({rank}) is missing its "
                f"beginning age; the TTL layout moved — fix the parser "
                f"rather than shipping a partial chart."
            )
        interval: dict[str, Any] = {
            "id": ident,
            "name": name,
            "rank": rank,
            "parent": broader.group(1) if broader else None,
            "startMa": start_ma,
            # The Holocene-and-younger blocks omit hasEnd (they run to the
            # present); 0 is the honest reading, not a parse failure.
            "endMa": end_ma if end_ma is not None else 0.0,
        }
        if start_error is not None:
            interval["startError"] = start_error
        if end_error is not None:
            interval["endError"] = end_error
        if start_uncertain:
            interval["startUncertain"] = True
        if end_uncertain:
            interval["endUncertain"] = True
        if color:
            interval["color"] = color.group(1)
        if order:
            interval["order"] = int(order.group(1))
        intervals.append(interval)

    by_rank: dict[str, int] = {}
    for interval in intervals:
        by_rank[interval["rank"]] = by_rank.get(interval["rank"], 0) + 1
    if by_rank.get("Eon", 0) < 3 or by_rank.get("Period", 0) < 20 \
            or by_rank.get("Age", 0) < 90:
        raise FetchError(
            f"ICS chart parse looks like a stump: {by_rank}. Expected >=3 "
            f"eons, >=20 periods, >=90 ages."
        )
    intervals.sort(key=lambda item: (-item["startMa"],
                                     ICS_RANKS.index(item["rank"])
                                     if item["rank"] in ICS_RANKS else 99))
    return intervals


# --------------------------------------------------------------------------
# PhyloPic
# --------------------------------------------------------------------------

class _PhylopicBuild:
    """PhyloPic's API is versioned by a `build` number that every query
    must carry. The root document that names it is cached like any other
    fetch, so a cached root can go stale while a NEW query (a name not
    yet in the cache) hits the live API — which then answers HTTP 410
    Gone for the retired build (seen 2026-09-13, build 555). The build is
    therefore held here and re-read from the live root once on a 410,
    after which the query is retried. Cached per-name responses are
    keyed by name only (§21), so old builds' answers stay valid."""

    def __init__(self, refresh: bool) -> None:
        self.refresh = refresh
        self.response = self._read(refresh)
        self.build = int(self.response.read_json()["build"])

    @staticmethod
    def _read(refresh: bool):  # noqa: ANN205
        return fetch(
            f"{config.PHYLOPIC_API}/", refresh=refresh,
            subdir="evolution", filename="phylopic-root.json", expect_json=True,
        )

    def renew(self) -> bool:
        """Re-read the live root; True if the build number changed."""
        previous = self.build
        self.response = self._read(True)
        self.build = int(self.response.read_json()["build"])
        return self.build != previous


def _phylopic_silhouette(
    name: str, *, build: _PhylopicBuild, refresh: bool,
    prefer_exact: bool = False,
) -> dict[str, Any] | None:
    """First CC0/public-domain silhouette matching `name`, or None.

    PhyloPic answers HTTP 404 for a name with no matches at all — that is
    "no silhouette", not an outage, so it degrades to the genus (first
    word) and then to None rather than aborting the run. HTTP 410 means
    the build number is retired: the build is renewed once and the query
    retried. Anything else still fails loudly. Cache keys derive from the
    query NAME (content), never the build or a running index (§21).
    Attribution is stored even for CC0 — courtesy costs nothing and the
    site renders it. With `prefer_exact` (the round-14 tree) an image
    whose own name equals the query outranks any other acceptable
    licence: PhyloPic's name filter is a substring match, and "Homo
    sapiens" otherwise came back as a CC0 Homo longi.
    """
    def page_for(query: str, renewed: bool = False) -> list[dict[str, Any]]:
        digest = hashlib.sha256(query.lower().encode("utf-8")).hexdigest()[:16]
        try:
            response = fetch(
                f"{config.PHYLOPIC_API}/images?build={build.build}"
                f"&filter_name={urllib.parse.quote(query.lower())}"
                f"&page=0&embed_items=true",
                refresh=refresh,
                subdir="evolution",
                filename=f"phylopic-{digest}.json",
                expect_json=True,
            )
        except FetchError as exc:
            if "HTTP 404" in str(exc):
                return []
            if "HTTP 410" in str(exc) and not renewed and build.renew():
                return page_for(query, renewed=True)
            raise
        return response.read_json().get("_embedded", {}).get("items", [])

    items = page_for(name)
    if not items and " " in name.strip():
        items = page_for(name.split()[0])
    best: tuple[tuple[int, int], dict[str, Any]] | None = None
    for item in items:
        links = item.get("_links", {})
        licence = (links.get("license") or {}).get("href", "")
        rank = _phylopic_license_rank(licence)
        if rank is None:
            continue
        rasters = links.get("rasterFiles") or []
        if not rasters:
            continue
        title = ((links.get("self") or {}).get("title") or "").strip().lower()
        exact = 0 if (prefer_exact and title == name.strip().lower()) else 1
        score = (exact, rank) if prefer_exact else (0, rank)
        if best is not None and score >= best[0]:
            continue
        # Rasters are listed largest first; the middle size (~512px) is
        # plenty for a detail panel.
        raster = rasters[min(len(rasters) - 1, len(rasters) // 2)]
        uuid = (links.get("self") or {}).get("href", "").split("?")[0]
        uuid = uuid.rsplit("/", 1)[-1]
        best = (score, {
            "url": raster["href"],
            "license": licence,
            "attribution": item.get("attribution"),
            "page": f"https://www.phylopic.org/images/{uuid}",
            "matched": (links.get("self") or {}).get("title") or name,
        })
        if score == (0, 0):
            break
    return best[1] if best else None



# --------------------------------------------------------------------------
# Tree of life (round 14, section 73)
# --------------------------------------------------------------------------

def _validate_tree(tree: dict[str, Any]) -> list[str]:
    """Structural and chronological checks on the editorial tree.

    Every node has a parent except the root; a child never originates
    before its parent (no tolerance -- the reference file is edited by
    hand and an inversion is an error, not noise); an extinct lineage
    carries an extinctMa no older than its origin; ageRange brackets
    originMa; every source key exists in the library; merges name real
    nodes; summaries are one sentence long (12-60 words).
    """
    problems: list[str] = []
    nodes: list[dict[str, Any]] = tree.get("nodes") or []
    library = tree.get("sourceLibrary") or {}
    groups = tree.get("groups") or {}
    by_id: dict[str, dict[str, Any]] = {}
    for node in nodes:
        nid = node.get("id")
        if not nid or nid in by_id:
            problems.append(f"duplicate or missing id: {nid!r}")
            continue
        by_id[nid] = node
    root = tree.get("root")
    if root not in by_id:
        problems.append(f"root {root!r} is not a node")
    for nid, node in by_id.items():
        for key in ("name", "parent", "originMa", "originKind", "status",
                    "group", "wikipedia", "summary", "sources"):
            if key not in node:
                problems.append(f"{nid}: missing {key}")
        parent = node.get("parent")
        if nid == root:
            if parent is not None:
                problems.append(f"{nid}: the root has a parent")
        elif parent not in by_id:
            problems.append(f"{nid}: unknown parent {parent!r}")
        origin = node.get("originMa")
        if not isinstance(origin, (int, float)) or origin <= 0 or origin > 4600:
            problems.append(f"{nid}: originMa {origin!r} out of range")
        elif parent in by_id and isinstance(by_id[parent].get("originMa"), (int, float)) \
                and origin > by_id[parent]["originMa"]:
            problems.append(
                f"{nid}: originMa {origin} is older than its parent "
                f"{parent} ({by_id[parent]['originMa']})"
            )
        if node.get("originKind") not in TREE_ORIGIN_KINDS:
            problems.append(f"{nid}: originKind {node.get('originKind')!r}")
        if node.get("status") not in TREE_STATUSES:
            problems.append(f"{nid}: status {node.get('status')!r}")
        extinct = node.get("extinctMa")
        if node.get("status") == "extinct":
            if not isinstance(extinct, (int, float)) or extinct < 0 \
                    or (isinstance(origin, (int, float)) and extinct > origin):
                problems.append(f"{nid}: extinct lineage without a sane extinctMa")
        elif extinct is not None:
            problems.append(f"{nid}: extant lineage carries extinctMa")
        rng = node.get("ageRange")
        if rng is not None:
            if (not isinstance(rng, list) or len(rng) != 2
                    or not all(isinstance(v, (int, float)) for v in rng)
                    or not (rng[0] >= origin >= rng[1])):
                problems.append(f"{nid}: ageRange {rng!r} does not bracket originMa")
        if node.get("group") not in groups:
            problems.append(f"{nid}: group {node.get('group')!r} not declared")
        sources = node.get("sources") or []
        if not sources:
            problems.append(f"{nid}: no sources")
        for key in sources:
            if key not in library:
                problems.append(f"{nid}: source {key!r} not in the library")
        for merge in node.get("merges") or []:
            if merge.get("from") not in by_id:
                problems.append(f"{nid}: merge from unknown node {merge.get('from')!r}")
            if not merge.get("label"):
                problems.append(f"{nid}: merge without a label")
        words = len((node.get("summary") or "").split())
        if not 12 <= words <= 60:
            problems.append(f"{nid}: summary is {words} words (want 12-60)")
    for band in tree.get("bands") or []:
        for key in ("id", "name", "kind", "startMa", "endMa", "summary", "sources"):
            if key not in band:
                problems.append(f"band {band.get('id')}: missing {key}")
        if band.get("kind") not in ("extinction", "event"):
            problems.append(f"band {band.get('id')}: kind {band.get('kind')!r}")
        if isinstance(band.get("startMa"), (int, float)) and isinstance(band.get("endMa"), (int, float)) \
                and band["endMa"] > band["startMa"]:
            problems.append(f"band {band.get('id')}: endMa after startMa")
        for key in band.get("sources") or []:
            if key not in library:
                problems.append(f"band {band.get('id')}: source {key!r} not in the library")
    return problems


def _check_titles(titles: list[str], *, refresh: bool) -> list[str]:
    """Titles with no English Wikipedia article (redirects followed).

    Batched through the Action API, 50 per call, cache keyed by the
    batch's own content (section 21), so a renamed article shows up as
    a loud failure on the next run rather than a dead link on the page.
    """
    missing: list[str] = []
    ordered = sorted(set(titles))
    for start in range(0, len(ordered), 50):
        batch = ordered[start:start + 50]
        digest = hashlib.sha256("|".join(batch).encode("utf-8")).hexdigest()[:16]
        url = (
            f"{config.WIKIPEDIA_API_URL}?action=query&format=json&prop=info"
            f"&redirects=1&titles={urllib.parse.quote('|'.join(batch))}"
        )
        response = fetch(
            url, refresh=refresh, subdir="evolution",
            filename=f"wikipedia-exists-{digest}.json", expect_json=True,
        )
        payload = response.read_json().get("query", {})
        norm = {n["from"]: n["to"] for n in payload.get("normalized", [])}
        redirect = {r["from"]: r["to"] for r in payload.get("redirects", [])}
        present = {
            page.get("title") for page in payload.get("pages", {}).values()
            if "missing" not in page and "invalid" not in page
        }
        for title in batch:
            resolved = norm.get(title, title)
            resolved = redirect.get(resolved, resolved)
            if resolved not in present:
                missing.append(title)
    return missing


def _wiki_url(title: str) -> str:
    return "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"))


def _ingest_tree(
    *, build: _PhylopicBuild, refresh: bool, out_dir: Any, manifest: dict[str, Any],
) -> dict[str, Any]:
    tree = json.loads(_TREE_SOURCE.read_text("utf-8"))
    problems = _validate_tree(tree)
    if problems:
        raise FetchError(
            "evolution_tree.json failed validation:\n  "
            + "\n  ".join(problems[:30])
        )
    nodes: list[dict[str, Any]] = tree["nodes"]
    bands: list[dict[str, Any]] = tree.get("bands") or []
    titles = [n["wikipedia"] for n in nodes] + [b["wikipedia"] for b in bands if b.get("wikipedia")]
    missing = _check_titles(titles, refresh=refresh)
    if missing:
        raise FetchError(
            "evolution_tree.json names Wikipedia articles that do not exist: "
            + ", ".join(sorted(missing))
        )

    library = tree["sourceLibrary"]

    def cite(keys: list[str]) -> list[dict[str, str]]:
        return [{"title": library[k]["title"], "url": library[k]["url"]} for k in keys]

    silhouettes = 0
    unillustrated: list[str] = []
    out_nodes: list[dict[str, Any]] = []
    for node in nodes:
        record: dict[str, Any] = {
            "id": node["id"],
            "name": node["name"],
            "scientific": node.get("scientific"),
            "parent": node["parent"],
            "originMa": node["originMa"],
            "originKind": node["originKind"],
            "ageRange": node.get("ageRange"),
            "status": node["status"],
            "extinctMa": node.get("extinctMa"),
            "group": node["group"],
            "summary": node["summary"].strip(),
            "wikipedia": _wiki_url(node["wikipedia"]),
            "sources": cite(node["sources"]),
            "merges": node.get("merges") or [],
            "image": None,
        }
        if node.get("phylopic"):
            silhouette = _phylopic_silhouette(
                node["phylopic"], build=build, refresh=refresh,
                prefer_exact=True,
            )
            if silhouette:
                record["image"] = {"type": "phylopic", **silhouette}
                silhouettes += 1
            else:
                unillustrated.append(node["id"])
        out_nodes.append(record)
    out_bands = []
    for band in bands:
        out_band = {k: v for k, v in band.items() if k not in ("sources", "wikipedia")}
        out_band["sources"] = cite(band["sources"])
        out_band["wikipedia"] = _wiki_url(band["wikipedia"]) if band.get("wikipedia") else None
        out_bands.append(out_band)
    (out_dir / "tree.json").write_text(
        json.dumps({
            "source": "editorial",
            "version": tree.get("version", 1),
            "note": tree.get("note", ""),
            "imageNote": (
                "Silhouettes are PhyloPic images -- CC0/public domain "
                "preferred, CC BY and CC BY-SA accepted, NC/ND never; "
                "attribution and licence are rendered with each."
            ),
            "root": tree["root"],
            "groups": tree["groups"],
            "bands": out_bands,
            "nodes": out_nodes,
        }, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    manifest_mod.record_artifact(
        manifest, "biology/evolution/tree.json",
        description=(
            "Editorial tree of life through time: lineages with sourced "
            "origin ages, extinctions, endosymbiosis merges and licence-gated "
            "PhyloPic silhouettes."
        ),
        sources=["evolution_events"], row_count=len(out_nodes),
    )
    parents = {n["parent"] for n in out_nodes}
    print(f"    tree: {len(out_nodes)} lineages ({silhouettes} silhouettes, "
          f"{len(unillustrated)} hinted but without), {len(out_bands)} bands",
          flush=True)
    return {
        "tree_nodes": len(out_nodes),
        "tree_leaves": sum(1 for n in out_nodes if n["id"] not in parents),
        "tree_extinct": sum(1 for n in out_nodes if n["status"] == "extinct"),
        "tree_silhouettes": silhouettes,
        "tree_unillustrated": unillustrated,
        "tree_bands": len(out_bands),
    }


# --------------------------------------------------------------------------
# Events
# --------------------------------------------------------------------------

def _validate(events: list[dict[str, Any]]) -> list[str]:
    problems: list[str] = []
    ids: set[str] = set()
    for event in events:
        eid = event.get("id")
        if not eid or eid in ids:
            problems.append(f"duplicate or missing id: {eid!r}")
        ids.add(eid)
        for key in ("title", "kind", "startMa", "summary", "wikipedia",
                    "sources"):
            if key not in event:
                problems.append(f"{eid}: missing {key}")
        if event.get("kind") not in KINDS:
            problems.append(f"{eid}: kind {event.get('kind')!r} not in {KINDS}")
        start = event.get("startMa")
        end = event.get("endMa")
        if not isinstance(start, (int, float)) or start < 0 or start > 4600:
            problems.append(f"{eid}: startMa {start!r} out of range")
        if end is not None:
            if not isinstance(end, (int, float)) or end < 0 or end > start:
                problems.append(f"{eid}: endMa {end!r} not in [0, startMa]")
        words = len((event.get("summary") or "").split())
        if not 40 <= words <= 130:
            problems.append(f"{eid}: summary is {words} words (want 40-130)")
        if not event.get("sources"):
            problems.append(f"{eid}: no sources")
    return problems


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry
    out_dir = config.DATA_DIR / "biology" / "evolution"
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- chart -----------------------------------------------------------
    chart_response = fetch(
        config.ICS_CHART_TTL, refresh=refresh,
        subdir="evolution", filename="ics-chart.ttl",
    )
    intervals = _parse_chart(chart_response.read_text())
    print(f"    ICS chart: {len(intervals)} intervals", flush=True)

    # Round-2 §40: editorial descriptions and cited etymologies for the
    # units shown as banners. Keys must match the chart exactly — a note
    # for a renamed unit fails loudly rather than silently vanishing.
    unit_notes = json.loads(
        (config.REFERENCE_DIR / "ics_unit_notes.json").read_text("utf-8")
    )["units"]
    by_key = {f"{i['name']}|{i['rank']}": i for i in intervals}
    missing = sorted(set(unit_notes) - set(by_key))
    if missing:
        raise FetchError(
            "ics_unit_notes.json keys not present in the chart: "
            + ", ".join(missing)
        )
    for key, note in unit_notes.items():
        by_key[key]["description"] = note["description"]
        by_key[key]["etymology"] = note["etymology"]
        by_key[key]["etymologySource"] = note["source"]

    # ---- events ----------------------------------------------------------
    source = json.loads(_SOURCE.read_text("utf-8"))
    events: list[dict[str, Any]] = source["events"]
    problems = _validate(events)
    if problems:
        raise FetchError(
            "evolution_events.json failed validation:\n  "
            + "\n  ".join(problems[:20])
        )

    build = _PhylopicBuild(refresh)

    # Wikipedia lead images for events WITHOUT a silhouette query, through
    # the history stage's own helper so the licence gate is identical.
    from .history import _lead_images  # shared deliberately

    # Lead images are resolved for EVERY event: they are the fallback both
    # for events with no silhouette query and for organisms whose PhyloPic
    # matches all carry unusable licences.
    fallback_titles = [e["wikipedia"] for e in events]
    lead, _lead_resp = _lead_images(fallback_titles, refresh=refresh)
    filenames = sorted({lead[t] for t in fallback_titles if t in lead})
    metadata, _meta_resp = commons.fetch_metadata(
        filenames, refresh=refresh, subdir="evolution",
    )

    silhouettes = 0
    lead_images = 0
    unillustrated: list[str] = []
    out_events: list[dict[str, Any]] = []
    for event in sorted(events, key=lambda x: -x["startMa"]):
        record: dict[str, Any] = {
            "id": event["id"],
            "title": event["title"],
            "kind": event["kind"],
            "startMa": event["startMa"],
            "endMa": event.get("endMa"),
            "summary": event["summary"].strip(),
            "image": None,
            "sources": event["sources"],
            "wikipedia": "https://en.wikipedia.org/wiki/"
            + urllib.parse.quote(event["wikipedia"].replace(" ", "_")),
        }
        if event.get("phylopic"):
            silhouette = _phylopic_silhouette(
                event["phylopic"], build=build, refresh=refresh,
            )
            if silhouette:
                record["image"] = {"type": "phylopic", **silhouette}
                silhouettes += 1
        if record["image"] is None:
            filename = lead.get(event["wikipedia"])
            if filename and filename in metadata:
                licence = metadata[filename].get("license") or ""
                if _FREE.search(licence):
                    record["image"] = {
                        "type": "commons",
                        "url": commons.image_url_for(filename, 640),
                        "license": licence,
                        "attribution": metadata[filename].get("author"),
                        "page": commons.file_page_for(filename),
                    }
                    lead_images += 1
        if record["image"] is None:
            unillustrated.append(event["id"])
        out_events.append(record)

    # ---- write -----------------------------------------------------------
    (out_dir / "chart.json").write_text(
        json.dumps({
            "source": "ICS International Chronostratigraphic Chart "
                      "(linked-data publication)",
            "url": "https://stratigraphy.org/chart",
            "license": "CC BY 4.0",
            "intervals": intervals,
        }, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    (out_dir / "events.json").write_text(
        json.dumps({
            "source": "editorial",
            "version": source.get("version", 1),
            "note": source.get("note", ""),
            "imageNote": (
                "Organism silhouettes are PhyloPic images — CC0/public "
                "domain preferred, CC BY and CC BY-SA accepted, NC/ND "
                "never; other images are Wikipedia lead images kept only "
                "under PD/CC licences. Attribution and licence are "
                "rendered with each."
            ),
            "events": out_events,
        }, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    # ---- tree of life (round 14, section 73) ------------------------------
    tree_stats = _ingest_tree(
        build=build, refresh=refresh, out_dir=out_dir, manifest=manifest,
    )

    log_dir = config.REPO_ROOT / "etl" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / "evolution.log").write_text(
        json.dumps({
            "intervals": len(intervals),
            "events": len(out_events),
            "phylopic_silhouettes": silhouettes,
            "commons_lead_images": lead_images,
            "unillustrated": unillustrated,
            **tree_stats,
        }, indent=2) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "ics_chart",
        title="ICS International Chronostratigraphic Chart (linked data)",
        url=config.ICS_CHART_TTL,
        licence="CC BY 4.0",
        fetched_at=chart_response.fetched_at,
        upstream_release=chart_response.upstream_release,
        vintage=None,
        citation=(
            "International Commission on Stratigraphy, International "
            "Chronostratigraphic Chart (CC BY 4.0)"
        ),
        notes=(
            f"{len(intervals)} intervals with boundary ages, stated margins "
            f"of error, and CGMW colours, parsed from the commission's "
            f"linked-data TTL."
        ),
    )
    manifest_mod.record_source(
        manifest,
        "evolution_events",
        title="Evolution timeline (editorial) with PhyloPic and Commons images",
        url="https://www.phylopic.org",
        licence=(
            "Editorial text CC0 (this project); silhouettes CC0/PD "
            "(PhyloPic, attributed); photos per-file PD/CC (attributed)"
        ),
        fetched_at=build.response.fetched_at,
        upstream_release=f"PhyloPic build {build.build}",
        vintage=None,
        citation="PhyloPic (per-image CC0/PD); Wikimedia Commons (per-file)",
        notes=(
            f"{len(out_events)} editorial events; {silhouettes} PhyloPic "
            f"silhouettes, {lead_images} Commons lead images, "
            f"{len(unillustrated)} events ship without an image because no "
            f"verifiably free one was found."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "biology/evolution/chart.json",
        description="ICS chart intervals with ages, errors, and colours.",
        sources=["ics_chart"], row_count=len(intervals),
    )
    manifest_mod.record_artifact(
        manifest, "biology/evolution/events.json",
        description=(
            "Editorial timeline of the history of life, with licence-gated "
            "illustrations."
        ),
        sources=["evolution_events"], row_count=len(out_events),
    )

    print(f"    events: {len(out_events)} ({silhouettes} silhouettes, "
          f"{lead_images} lead images, {len(unillustrated)} without)",
          flush=True)


__all__ = ["ingest"]
