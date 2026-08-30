"""Notable inventions per country, from Wikidata and Wikipedia list articles.

Anchor: an item with a country of origin (P495) that either names an
inventor (P61) or carries a time of invention (P575). Sitelink count is the
notability proxy and the ranking. The invention date prefers P575 (time of
discovery or invention) over P571 (inception) -- inception on an invention
item is often the item's own founding-adjacent date, not the invention's.

Class gate (2026-08-29): every candidate -- Wikidata row or Wikipedia list
entry -- must pass `config.WIKIDATA_INVENTION_ALLOW_ROOTS` and none of
`config.WIKIDATA_INVENTION_DENY_ROOTS` through its Wikidata class
ancestry. P495 is "country of origin", which editors also set on diseases
first described in a country, on species, on minerals and on theorems;
the Wikipedia lists mix "inventions AND discoveries" by title. Neither is
an invention for this section. Everything rejected is written to
etl/logs/inventions-rejected.json for review.

Coverage is honest and thin. The page renders explicit unavailability for
countries with nothing left; padding from prose sources would mean
inventing an editorial ranking this project has no basis for.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch
from . import commons

_EXCLUDED_SECTIONS = {
    "see also", "references", "external links", "notes", "further reading",
    "bibliography", "sources", "citations", "gallery",
}
_YEAR_RE = re.compile(r"\b(1[0-9]{3}|20[0-2][0-9])\b")
_ERA_RE = re.compile(
    r"\b(\d{1,2}(?:st|nd|rd|th)\s+century(?:\s+BCE?)?|\d{3,4}s?\s+BCE?)\b"
)
_INVENTOR_RE = re.compile(
    r"(?:invented|discovered|developed|created|designed|patented|devised|"
    r"introduced)\s+(?:in\s+\d{3,4}\s+)?by\s+"
    r"([A-Z][\w.'’-]+(?:\s+(?:van|von|de|der|du|la|le)\s+|\s+)"
    r"[A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+)?)"
)


def _year(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return int(value.lstrip("+")[:4])
    except ValueError:
        return None


def _qid(uri: str | None) -> str:
    return (uri or "").rsplit("/", 1)[-1]


def _commons_filename_from_upload_url(url: str) -> str | None:
    """Original Commons filename from an upload.wikimedia.org URL.

    enwiki-local files (/wikipedia/en/) are skipped outright: they are
    usually non-free media that must not be hotlinked elsewhere.
    """
    if "/wikipedia/commons/" not in url:
        return None
    if "/thumb/" in url:
        return commons.filename_from_thumb_url(url)
    tail = url.rsplit("/", 1)[-1]
    return urllib.parse.unquote(tail).replace("_", " ") or None


# --------------------------------------------------------------------------
# Wikidata class gate
# --------------------------------------------------------------------------

def _sparql(query: str, *, refresh: bool) -> list[dict[str, Any]]:
    response = fetch(
        f"{config.WIKIDATA_SPARQL}?format=json&query="
        + urllib.parse.quote(query),
        refresh=refresh, subdir="inventions", expect_json=True,
    )
    return response.read_json()["results"]["bindings"]


def _class_roots(
    classes: list[str], *, refresh: bool
) -> tuple[dict[str, set[str]], set[str]]:
    """{class qid: roots reached} plus the set of food-by-label classes."""
    roots = " ".join(
        f"wd:{q}" for q in (
            list(config.WIKIDATA_INVENTION_ALLOW_ROOTS)
            + list(config.WIKIDATA_INVENTION_DENY_ROOTS)
        )
    )
    reached: dict[str, set[str]] = {}
    food_by_label: set[str] = set()
    for start in range(0, len(classes), config.FOOD_CLASS_BATCH):
        batch = classes[start:start + config.FOOD_CLASS_BATCH]
        values = " ".join(f"wd:{qid}" for qid in batch)
        for row in _sparql(
            config.WIKIDATA_CLASS_ROOTS_QUERY_TEMPLATE.format(
                qids=values, roots=roots
            ),
            refresh=refresh,
        ):
            reached.setdefault(_qid(row["class"]["value"]), set()).add(
                _qid(row["root"]["value"])
            )
        # Second net for food: brand items ("drink brand") never subclass
        # food, and Coca-Cola sailed through the ancestry test.
        for row in _sparql(
            config.WIKIDATA_CLASS_LABELS_QUERY_TEMPLATE.format(qids=values),
            refresh=refresh,
        ):
            label = (row.get("classLabel", {}).get("value") or "").lower()
            if any(k in label for k in config.FOOD_CLASS_LABEL_KEYWORDS):
                food_by_label.add(_qid(row["class"]["value"]))
    return reached, food_by_label


def _item_classes(qids: list[str], *, refresh: bool) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {q: set() for q in qids}
    for start in range(0, len(qids), config.FOOD_CLASS_BATCH):
        batch = qids[start:start + config.FOOD_CLASS_BATCH]
        values = " ".join(f"wd:{qid}" for qid in batch)
        for row in _sparql(
            config.WIKIDATA_ITEM_CLASSES_QUERY_TEMPLATE.format(qids=values),
            refresh=refresh,
        ):
            out.setdefault(_qid(row["item"]["value"]), set()).add(
                _qid(row["class"]["value"])
            )
    return out


class _Gate:
    """Allow/deny verdicts over class ancestry, with a rejection log."""

    def __init__(
        self, reached: dict[str, set[str]], food_by_label: set[str]
    ) -> None:
        self.reached = reached
        self.food_by_label = food_by_label
        self.rejected: list[dict[str, Any]] = []

    def verdict(self, qid: str, classes: set[str]) -> tuple[bool, str, list[str]]:
        """(accepted, reason, matched root labels).

        The item ITSELF is tested alongside its classes: generic items like
        "hot dog" carry no P31 -- they ARE classes -- and only their own
        ancestry reveals what they are.
        """
        nodes = set(classes) | {qid}
        allowed: set[str] = set()
        denied: set[str] = set()
        for node in nodes:
            for root in self.reached.get(node, ()):
                if root in config.WIKIDATA_INVENTION_DENY_ROOTS:
                    denied.add(root)
                elif root in config.WIKIDATA_INVENTION_ALLOW_ROOTS:
                    allowed.add(root)
            if node in self.food_by_label:
                denied.add("Q2095")
        if denied:
            labels = sorted(
                config.WIKIDATA_INVENTION_DENY_ROOTS[r] for r in denied
            )
            return False, "denied class ancestry", labels
        if not allowed:
            return False, "no allowed class ancestry", []
        return True, "ok", sorted(
            config.WIKIDATA_INVENTION_ALLOW_ROOTS[r] for r in allowed
        )

    def reject(self, **entry: Any) -> None:
        self.rejected.append(entry)


# --------------------------------------------------------------------------
# Wikipedia list articles
# --------------------------------------------------------------------------

def _parse_list_page(html_bytes: bytes) -> list[dict[str, Any]]:
    """Invention candidates from one Wikipedia list article.

    Generic heuristic (the ~50 list pages share no strict format): each
    candidate is a list item in a content section whose first wiki link
    names the invention; year, era and inventor are regexed out of the
    item's prose and are honestly lossy.
    """
    from lxml import html as lhtml

    doc = lhtml.fromstring(html_bytes)
    entries: list[dict[str, Any]] = []
    seen_titles: set[str] = set()
    for section in doc.xpath("//section"):
        headings = section.xpath("./h2|./h3|./h4")
        if headings and headings[0].text_content().strip().lower() in _EXCLUDED_SECTIONS:
            continue
        for item in section.xpath("./ul/li|./div/ul/li"):
            text = item.text_content()
            link = next(
                (
                    a for a in item.xpath(".//a[@rel='mw:WikiLink']")
                    if (a.get("href") or "").startswith("./")
                    and ":" not in (a.get("href") or "")
                    and len(a.text_content().strip()) > 1
                ),
                None,
            )
            if link is None:
                continue
            title = urllib.parse.unquote(
                (link.get("href") or "").removeprefix("./")
            )
            if title in seen_titles:
                continue
            seen_titles.add(title)
            entry: dict[str, Any] = {
                "name": link.text_content().strip(),
                "articleTitle": title,
            }
            year_match = _YEAR_RE.search(text)
            if year_match:
                entry["year"] = int(year_match.group(1))
            else:
                era_match = _ERA_RE.search(text)
                if era_match:
                    entry["era"] = era_match.group(1)
            inventor_match = _INVENTOR_RE.search(text)
            if inventor_match:
                entry["inventors"] = [inventor_match.group(1).rstrip(".,")]
            entries.append(entry)
    return entries


def _wikipedia_candidates(
    registry: dict[str, Entity], *, refresh: bool
) -> dict[str, list[dict[str, Any]]]:
    """{iso3: candidates} from the curated per-country list articles.

    Each candidate is enriched through the REST summary of its linked
    article, which also yields its Wikidata item (`wikibase_item`) for the
    class gate. Entries whose summary is missing are dropped as parse noise.
    """
    out: dict[str, list[dict[str, Any]]] = {}
    for title, iso3 in config.WIKIPEDIA_INVENTION_LISTS.items():
        if iso3 not in registry:
            continue
        try:
            page = fetch(
                config.WIKIPEDIA_REST_HTML_TEMPLATE.format(
                    title=urllib.parse.quote(title.replace(" ", "_"))
                ),
                refresh=refresh, subdir="inventions/wikipedia",
            )
        except FetchError:
            continue  # a renamed list page must not sink the stage
        candidates = _parse_list_page(page.read_bytes())
        # Sample EVENLY across the page rather than taking its head: these
        # lists are sectioned by category, and head-taking made every French
        # invention an artefact of whichever category sorts first ("Gothic
        # art" led the list). Even spacing crosses the categories.
        window = config.WIKIPEDIA_INVENTIONS_SAMPLE_WINDOW
        if len(candidates) > window:
            step = len(candidates) / window
            candidates = [candidates[int(i * step)] for i in range(window)]
        kept: list[dict[str, Any]] = []
        for entry in candidates:
            try:
                summary_response = fetch(
                    config.WIKIPEDIA_REST_SUMMARY_TEMPLATE.format(
                        title=urllib.parse.quote(
                            entry["articleTitle"].replace(" ", "_")
                        )
                    ),
                    refresh=refresh, subdir="inventions/summaries",
                    expect_json=True,
                )
            except FetchError:
                continue
            summary = summary_response.read_json()
            if summary.get("type") not in ("standard", None):
                continue  # disambiguation or missing page: parse noise
            entry["qid"] = summary.get("wikibase_item")
            entry["description"] = summary.get("description") or ""
            entry["listArticle"] = title
            image = (summary.get("originalimage") or {}).get("source")
            if image:
                filename = _commons_filename_from_upload_url(image)
                if filename:
                    entry["file"] = filename
            # The article's own display title reads better than raw link
            # text ("LED" over "light-emitting diodes").
            display = (summary.get("title") or "").strip()
            if display:
                entry["name"] = display
            kept.append(entry)
        if kept:
            out.setdefault(iso3, []).extend(kept)
    return out


# --------------------------------------------------------------------------
# Stage
# --------------------------------------------------------------------------

def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "inventions"
    out_dir.mkdir(parents=True, exist_ok=True)

    response = fetch(
        f"{config.WIKIDATA_SPARQL}?format=json&query="
        + urllib.parse.quote(config.WIKIDATA_INVENTIONS_QUERY),
        refresh=refresh,
        subdir="inventions",
        filename="wikidata-inventions.json",
        expect_json=True,
    )
    bindings = response.read_json().get("results", {}).get("bindings", [])
    if len(bindings) < 200:
        raise FetchError(
            f"Inventions query returned only {len(bindings)} rows; expected "
            f"several hundred. The query or Wikidata shape changed."
        )

    # qid-level merge: OPTIONAL inventor/class multiply rows per item.
    by_item: dict[str, dict[str, Any]] = {}
    for row in bindings:
        iso3 = (row.get("iso3", {}).get("value") or "").upper()
        if iso3 not in registry:
            continue
        qid = _qid(row.get("item", {}).get("value"))
        label = (row.get("itemLabel", {}).get("value") or "").strip()
        if not label or label == qid:
            continue
        record = by_item.setdefault(qid, {
            "iso3": iso3,
            "name": label,
            "inventors": [],
            "year": None,
            "file": None,
            "classes": set(),
            "links": int(row.get("links", {}).get("value") or 0),
        })
        inventor = (row.get("inventorLabel", {}).get("value") or "").strip()
        if inventor and not inventor.startswith("Q") and inventor not in record["inventors"]:
            record["inventors"].append(inventor)
        if record["year"] is None:
            record["year"] = _year(
                row.get("invented", {}).get("value")
            ) or _year(row.get("inception", {}).get("value"))
        if record["file"] is None:
            image = row.get("image", {}).get("value")
            if image:
                record["file"] = commons.filename_from_special_path(image)
        item_class = _qid(row.get("class", {}).get("value"))
        if item_class.startswith("Q"):
            record["classes"].add(item_class)

    # Wikipedia list candidates, then their direct classes from Wikidata so
    # the same gate judges both sources.
    wiki_by_country = _wikipedia_candidates(registry, refresh=refresh)
    wiki_qids = sorted({
        c["qid"] for cs in wiki_by_country.values() for c in cs if c.get("qid")
    })
    wiki_classes = _item_classes(wiki_qids, refresh=refresh)

    all_classes = sorted(
        {c for r in by_item.values() for c in r["classes"]}
        | set(by_item)
        | {c for cs in wiki_classes.values() for c in cs}
        | set(wiki_qids)
    )
    reached, food_by_label = _class_roots(all_classes, refresh=refresh)
    gate = _Gate(reached, food_by_label)

    by_country: dict[str, list[dict[str, Any]]] = {}
    for qid, record in by_item.items():
        ok, reason, roots = gate.verdict(qid, record["classes"])
        if not ok:
            gate.reject(
                source="wikidata", iso3=record["iso3"], qid=qid,
                name=record["name"], reason=reason, matched=roots,
            )
            continue
        record["roots"] = roots
        by_country.setdefault(record["iso3"], []).append(record)
    for records in by_country.values():
        records.sort(key=lambda r: (-r["links"], r["name"]))
        del records[config.INVENTIONS_TOP_N:]

    wiki_accepted: dict[str, list[dict[str, Any]]] = {}
    for iso3, candidates in wiki_by_country.items():
        for candidate in candidates:
            qid = candidate.get("qid")
            if not qid:
                gate.reject(
                    source="wikipedia", iso3=iso3, qid=None,
                    name=candidate["name"], reason="no Wikidata item",
                    matched=[], listArticle=candidate["listArticle"],
                )
                continue
            ok, reason, roots = gate.verdict(qid, wiki_classes.get(qid, set()))
            if not ok:
                gate.reject(
                    source="wikipedia", iso3=iso3, qid=qid,
                    name=candidate["name"], reason=reason, matched=roots,
                    description=candidate.get("description"),
                    listArticle=candidate["listArticle"],
                )
                continue
            if len(wiki_accepted.setdefault(iso3, [])) < config.WIKIPEDIA_INVENTIONS_PER_PAGE * 2:
                wiki_accepted[iso3].append(candidate)

    # Wikidata entries lead, list entries top the country up to the cap,
    # deduplicated by name. A country with two solid entries shows two.
    merged: dict[str, list[dict[str, Any]]] = {}
    for iso3 in sorted(set(by_country) | set(wiki_accepted)):
        entries: list[dict[str, Any]] = [
            {
                "name": r["name"],
                "inventors": r["inventors"][:3],
                "year": r["year"],
                "era": None,
                "file": r["file"],
                "source": "wikidata",
            }
            for r in by_country.get(iso3, [])
        ]
        names = {e["name"].casefold() for e in entries}
        for candidate in wiki_accepted.get(iso3, []):
            if len(entries) >= config.INVENTIONS_TOP_N:
                break
            if candidate["name"].casefold() in names:
                continue
            names.add(candidate["name"].casefold())
            entries.append({
                "name": candidate["name"],
                "inventors": candidate.get("inventors", []),
                "year": candidate.get("year"),
                "era": candidate.get("era"),
                "file": candidate.get("file"),
                "source": "wikipedia",
            })
        if entries:
            merged[iso3] = entries[:config.INVENTIONS_TOP_N]

    filenames = [
        r["file"]
        for records in merged.values()
        for r in records
        if r["file"]
    ]
    metadata, meta_responses = commons.fetch_metadata(
        filenames, refresh=refresh, subdir="inventions",
    )

    # Remove artifacts for countries no longer covered -- a stale file
    # would keep serving a rejected item forever.
    for stale in out_dir.glob("*.json"):
        if stale.stem not in merged:
            stale.unlink()

    written = 0
    total = 0
    for iso3, records in sorted(merged.items()):
        items = []
        for record in records:
            item: dict[str, Any] = {
                "name": record["name"],
                "source": record["source"],
            }
            if record["inventors"]:
                item["inventors"] = record["inventors"][:3]
            if record["year"]:
                item["year"] = record["year"]
            elif record["era"]:
                item["era"] = record["era"]
            if record["file"]:
                image = commons.image_record(record["file"], metadata)
                if image:
                    item["image"] = image
            items.append(item)
        document = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": "wikidata_wikipedia",
            "note": (
                "Inventions with a recorded country of origin in Wikidata, "
                "topped up from the English Wikipedia's per-country "
                "invention list articles (CC BY-SA). Every entry passed a "
                "Wikidata class check (device, technology, process, "
                "product, software, medication ...); diseases, species, "
                "discoveries, theorems and food are excluded by ruling. "
                "Dates are recorded or parsed from prose and are often "
                "approximate."
            ),
            "inventions": items,
        }
        (out_dir / f"{iso3}.json").write_text(
            json.dumps(document, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )
        written += 1
        total += len(items)

    # Reviewable rejection log (committed, outside /data).
    config.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    rejected = sorted(
        gate.rejected, key=lambda r: (r["iso3"], r["source"], r["name"])
    )
    by_reason: dict[str, int] = {}
    for entry in rejected:
        by_reason[entry["reason"]] = by_reason.get(entry["reason"], 0) + 1
    (config.LOGS_DIR / "inventions-rejected.json").write_text(
        json.dumps({
            "note": (
                "Every inventions candidate the class gate rejected, with "
                "the reason and the matched roots. 'denied class ancestry' "
                "names the deny roots hit; 'no allowed class ancestry' "
                "means the item reaches none of the allow roots and may "
                "deserve a new root or a Wikidata fix."
            ),
            "summary": by_reason,
            "rejected": rejected,
        }, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "wikidata_inventions",
        title="Inventions: Wikidata origin tags + Wikipedia list articles",
        url=config.WIKIDATA_SPARQL,
        licence=(
            "Wikidata CC0; Wikipedia CC BY-SA 4.0; per-file Commons "
            "licences on images"
        ),
        fetched_at=max(
            r.fetched_at for r in [response, *meta_responses]
        ),
        upstream_release=None,
        vintage="as retrieved",
        citation=(
            "Wikidata (P495/P61/P575, P31/P279 class gate); English "
            "Wikipedia per-country invention lists; Wikimedia Commons"
        ),
        notes=(
            f"{written} countries with qualifying items, {total} inventions. "
            f"Class gate rejected {len(rejected)} candidates "
            f"({', '.join(f'{k}: {v}' for k, v in sorted(by_reason.items()))}); "
            f"see etl/logs/inventions-rejected.json. Wikidata origin tags "
            f"plus {len(config.WIKIPEDIA_INVENTION_LISTS)} curated "
            f"Wikipedia list articles."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "inventions/<ISO3>.json",
        description=(
            "Notable inventions (name, inventor, approximate year, Commons "
            "image with attribution) for countries with coverage after the "
            "class gate."
        ),
        sources=["wikidata_inventions"], entity_count=written,
    )
    print(f"    inventions: {written} countries, {total} items "
          f"({len(rejected)} candidates rejected by the class gate, "
          f"{len(wiki_accepted)} countries from Wikipedia lists)")


__all__ = ["ingest"]
