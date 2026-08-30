"""Flag metadata: adoption date, designer, and a short symbolism text.

Added 2026-08-29 (Phase 2.2). Sources:

* Wikidata: the country's flag item (P163) with its inception (P571) and
  designer (P287). Wikidata's dates carry a precision; a year-precision
  date renders as the year only, never as "1 January".
* Wikipedia: the flag item's English article, via the REST summary
  endpoint. The lead extract is trimmed to at most four sentences and
  shipped VERBATIM with the article URL, because it is CC BY-SA 4.0 text
  and the licence requires attribution and a link -- the UI renders both.
  No paraphrase, no synthesis: an editorial rewrite of 250 flags is not a
  data pipeline's job.

Every field is optional and absent when unsourced; the UI omits the line.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"“(])")
MAX_SENTENCES = 4


def _date(value: str | None, precision: str | None) -> dict[str, Any] | None:
    """Wikidata time -> {value, precision} with the precision made explicit."""
    if not value:
        return None
    raw = value.lstrip("+")
    year = raw[:4]
    try:
        p = int(precision) if precision else 9
    except ValueError:
        p = 9
    if p >= 11:
        return {"value": raw[:10], "precision": "day"}
    if p == 10:
        return {"value": raw[:7], "precision": "month"}
    if p == 9:
        return {"value": year, "precision": "year"}
    if p == 8:
        return {"value": f"{year[:3]}0s", "precision": "decade"}
    return {"value": year, "precision": "approximate"}


def _trim(extract: str) -> str:
    sentences = _SENTENCE_END.split(extract.strip())
    return " ".join(sentences[:MAX_SENTENCES]).strip()


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "flags"
    out_dir.mkdir(parents=True, exist_ok=True)

    response = fetch(
        f"{config.WIKIDATA_SPARQL}?format=json&query="
        + urllib.parse.quote(config.WIKIDATA_FLAG_META_QUERY),
        refresh=refresh,
        subdir="flags",
        filename="wikidata-flagmeta.json",
        expect_json=True,
    )
    bindings = response.read_json().get("results", {}).get("bindings", [])
    if len(bindings) < 150:
        raise FetchError(
            f"Flag metadata query returned only {len(bindings)} rows; "
            f"expected ~200. The query or Wikidata shape changed."
        )

    by_iso3: dict[str, dict[str, Any]] = {}
    for row in bindings:
        iso3 = (row.get("iso3", {}).get("value") or "").upper()
        if iso3 not in registry:
            continue
        record = by_iso3.setdefault(iso3, {
            "flagName": None, "adopted": None, "designer": None,
            "article": None, "qid": None,
        })
        record["qid"] = record["qid"] or (row.get("flag", {}).get("value") or "").rsplit("/", 1)[-1]
        label = (row.get("flagLabel", {}).get("value") or "").strip()
        if label and not label.startswith("Q") and not record["flagName"]:
            record["flagName"] = label
        if not record["adopted"]:
            record["adopted"] = _date(
                row.get("inception", {}).get("value"),
                row.get("inceptionPrecision", {}).get("value"),
            )
        designer = (row.get("designerLabel", {}).get("value") or "").strip()
        if designer and not designer.startswith("Q") and not record["designer"]:
            record["designer"] = designer
        article = row.get("article", {}).get("value")
        if article and not record["article"]:
            record["article"] = article

    responses: list[CachedResponse] = [response]
    with_text = 0
    for iso3, record in sorted(by_iso3.items()):
        article = record.get("article")
        if not article:
            continue
        title = urllib.parse.unquote(article.rsplit("/", 1)[-1])
        try:
            summary_response = fetch(
                config.WIKIPEDIA_REST_SUMMARY_TEMPLATE.format(
                    title=urllib.parse.quote(title)
                ),
                refresh=refresh, subdir="flags/summaries", expect_json=True,
            )
        except FetchError:
            continue  # a moved article must not sink the stage
        responses.append(summary_response)
        summary = summary_response.read_json()
        extract = (summary.get("extract") or "").strip()
        if summary.get("type") not in ("standard", None) or not extract:
            continue
        record["symbolism"] = {
            "text": _trim(extract),
            "source": "Wikipedia",
            "article": summary.get("content_urls", {}).get("desktop", {}).get("page") or article,
            "title": summary.get("title") or title,
            "license": "CC BY-SA 4.0",
            "retrieved": summary_response.fetched_at[:10],
        }
        with_text += 1

    entities = {
        iso3: {k: v for k, v in record.items() if v is not None and k != "qid"}
        for iso3, record in by_iso3.items()
    }
    document = {
        "source": "wikidata_wikipedia",
        "note": (
            "Flag adoption date (Wikidata P571 on the flag item, with its "
            "stated precision), designer (P287), and the lead of the English "
            "Wikipedia flag article, trimmed to four sentences and shipped "
            "verbatim under CC BY-SA 4.0 with a link back. Absent fields are "
            "unrecorded upstream. Wikidata has no separate 'date designed' "
            "property; only adoption is recorded."
        ),
        "entities": entities,
    }
    (out_dir / "meta.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "flag_metadata",
        title="Flag metadata (Wikidata) and symbolism text (Wikipedia)",
        url=config.WIKIDATA_SPARQL,
        licence="Wikidata CC0; Wikipedia text CC BY-SA 4.0 (attributed, linked)",
        fetched_at=max(r.fetched_at for r in responses),
        upstream_release=None,
        vintage="as retrieved",
        citation="Wikidata (P163/P571/P287); English Wikipedia flag articles",
        notes=(
            f"{len(entities)} entities with a flag item; "
            f"{sum(1 for e in entities.values() if e.get('adopted'))} with an "
            f"adoption date, {sum(1 for e in entities.values() if e.get('designer'))} "
            f"with a designer, {with_text} with Wikipedia lead text."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "flags/meta.json",
        description="Flag adoption date, designer and attributed symbolism text per entity.",
        sources=["flag_metadata"], entity_count=len(entities),
    )
    print(f"    flag metadata: {len(entities)} entities, {with_text} with text")


__all__ = ["ingest"]
