"""UNESCO World Heritage List ingestion.

Feeds the Culture and Heritage section of the country pages. One artifact for
the whole list rather than 250 per-country files: the full list is ~1,300
sites and the trimmed output is small enough to load once.

Transboundary sites (iso_code carries a comma-separated list of states) are
listed under EVERY member state, flagged `transnational` so the page can say
"shared" — counting Struve Geodetic Arc once per its ten countries without the
flag would overstate national totals.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch


def _text(row: ET.Element, tag: str) -> str:
    node = row.find(tag)
    return (node.text or "").strip() if node is not None else ""


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    response = fetch(
        config.WHC_LIST_XML,
        refresh=refresh,
        subdir="heritage",
        filename="whc-list.xml",
        # See the note in config.py: the syndication feed 403s non-browser UAs.
        headers={"User-Agent": config.WHC_BROWSER_UA},
    )

    try:
        root = ET.fromstring(response.read_text())
    except ET.ParseError as exc:
        raise FetchError(
            f"UNESCO World Heritage XML did not parse: {exc}. The WAF may "
            f"have served a challenge page instead of the feed."
        ) from exc

    rows = root.findall("row")
    if len(rows) < 1000:
        raise FetchError(
            f"UNESCO World Heritage XML carried only {len(rows)} rows; the "
            f"list has over 1,200 inscribed properties, so this is a partial "
            f"or error response. Refusing to publish."
        )

    iso2_to_iso3 = {
        entity.iso2.lower(): iso3
        for iso3, entity in registry.items()
        if entity.iso2
    }

    by_iso3: dict[str, list[dict[str, Any]]] = {}
    unmatched: set[str] = set()
    total = 0
    for row in rows:
        name = _text(row, "site")
        category = _text(row, "category")
        year_raw = _text(row, "date_inscribed")
        codes = [
            c.strip().lower()
            for c in _text(row, "iso_code").split(",")
            if c.strip()
        ]
        if not name or not codes:
            continue
        total += 1
        site = {
            "name": name,
            "category": category or None,
            "year": int(year_raw) if year_raw.isdigit() else None,
            "danger": bool(_text(row, "danger")),
            "transnational": len(codes) > 1,
            "url": _text(row, "http_url") or None,
        }
        for code in codes:
            iso3 = iso2_to_iso3.get(code)
            if iso3 is None:
                unmatched.add(code)
                continue
            by_iso3.setdefault(iso3, []).append(site)

    for sites in by_iso3.values():
        sites.sort(key=lambda s: (s["year"] or 9999, s["name"]))

    out_dir = config.DATA_DIR / "heritage"
    out_dir.mkdir(parents=True, exist_ok=True)
    document = {
        "note": (
            "UNESCO World Heritage properties per entity. Transboundary "
            "sites appear under every member state and are flagged "
            "transnational, so national counts include shared sites."
        ),
        "source": "unesco_whc",
        "totalSites": total,
        "entities": {
            iso3: {"count": len(sites), "sites": sites}
            for iso3, sites in sorted(by_iso3.items())
        },
    }
    (out_dir / "sites.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "unesco_whc",
        title="UNESCO World Heritage List",
        url=config.WHC_LIST_XML,
        licence="© UNESCO World Heritage Centre; syndication feed",
        fetched_at=response.fetched_at,
        upstream_release=response.upstream_release,
        vintage="inscription years 1978 onward",
        citation="UNESCO World Heritage Centre, World Heritage List",
        files=[{
            "url": response.url, "sha256": response.sha256,
            "size_bytes": response.size_bytes, "fetched_at": response.fetched_at,
        }],
        notes=(
            f"{total} inscribed properties across {len(by_iso3)} entities. "
            f"Transboundary sites listed under every member state."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "heritage/sites.json",
        description=(
            "World Heritage properties per entity: name, category, "
            "inscription year, in-danger and transboundary flags."
        ),
        sources=["unesco_whc"],
        row_count=total,
        entity_count=len(by_iso3),
    )

    if unmatched:
        manifest_mod.add_warning(
            manifest,
            f"UNESCO list carried {len(unmatched)} ISO2 codes absent from the "
            f"registry: {', '.join(sorted(unmatched))}. Those attributions "
            f"were dropped."
        )

    print(f"    {total} sites across {len(by_iso3)} entities")


__all__ = ["ingest"]
