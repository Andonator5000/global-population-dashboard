"""Education extras: university counts, public library counts, top universities.

Three sources with three very different confidence levels, and the artifact
says so per figure rather than blending them:

    universities  Hipolabs university-domains list (MIT). Counts institutions
                  with web domains, so it UNDERCOUNTS; labelled as such.
    libraries     Wikidata count of items typed public library. IFLA's
                  Library Map is the authoritative count but sits behind
                  Cloudflare with no keyless endpoint (verified 2026-08-23),
                  so the honest option is Wikidata WITH its coverage caveat
                  in the label -- Czechia outscoring Germany is a Wikidata
                  cataloguing artefact, not a fact about libraries.
    top 10        CWUR World University Rankings, national-rank column.
                  © CWUR, displayed with attribution; countries outside the
                  ~2,000 ranked institutions simply have no list.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from datetime import datetime, timezone
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity, build_name_index, normalise_name, normalise_name_strict
from ..fetch import CachedResponse, FetchError, fetch

# CWUR location spellings that name folding cannot reach.
_CWUR_ALIASES: dict[str, str] = {
    "usa": "USA",
    "uk": "GBR",
    "china": "CHN",
    "taiwan": "TWN",
    "hong kong": "HKG",
    "macau": "MAC",
    "south korea": "KOR",
    "north korea": "PRK",
    "russia": "RUS",
    "czech republic": "CZE",
    "slovak republic": "SVK",
    "ivory coast": "CIV",
    "palestine": "PSE",
}

_TAG = re.compile(r"<[^>]+>")


def _strip_tags(html: str) -> str:
    return _TAG.sub("", html).replace("&nbsp;", " ").replace("&amp;", "&").strip()


def _load_cwur(refresh: bool) -> tuple[CachedResponse, int]:
    this_year = datetime.now(timezone.utc).year
    last_error: FetchError | None = None
    for year in range(this_year, this_year - config.CWUR_PROBE_YEARS_BACK, -1):
        try:
            response = fetch(
                config.CWUR_RANKING_TEMPLATE.format(year=year),
                refresh=refresh,
                subdir="education",
                filename=f"cwur-{year}.html",
                headers={"User-Agent": config.WHC_BROWSER_UA},
            )
            return response, year
        except FetchError as exc:
            last_error = exc
    raise FetchError(f"No CWUR ranking page found; last error: {last_error}")


def _parse_cwur(
    html: str, registry: dict[str, Entity]
) -> tuple[dict[str, list[dict[str, Any]]], set[str]]:
    """{iso3: [{name, worldRank, nationalRank}]} from the single ranking table."""
    table = re.search(r"<table.*?</table>", html, re.S)
    if not table:
        raise FetchError("CWUR page carries no <table>; layout changed.")
    strict, loose = build_name_index(registry)
    top: dict[str, list[dict[str, Any]]] = {}
    unmatched: set[str] = set()
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table.group(0), re.S):
        cells = [
            _strip_tags(c)
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)
        ]
        if len(cells) < 4 or cells[0] == "World Rank":
            continue
        world_rank_match = re.match(r"(\d+)", cells[0])
        national_rank_match = re.match(r"(\d+)", cells[3])
        if not world_rank_match or not national_rank_match:
            continue
        national_rank = int(national_rank_match.group(1))
        if national_rank > config.CWUR_TOP_N:
            continue
        location = cells[2]
        iso3 = (
            _CWUR_ALIASES.get(normalise_name_strict(location))
            or strict.get(normalise_name_strict(location))
            or loose.get(normalise_name(location))
        )
        if iso3 is None or iso3 not in registry:
            unmatched.add(location)
            continue
        top.setdefault(iso3, []).append({
            "name": cells[1],
            "worldRank": int(world_rank_match.group(1)),
            "nationalRank": national_rank,
        })
    if len(top) < 50:
        raise FetchError(
            f"CWUR parse matched only {len(top)} countries; expected ~90. "
            f"The table layout or location spellings changed."
        )
    for ranks in top.values():
        ranks.sort(key=lambda r: r["nationalRank"])
    return top, unmatched


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "education"
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- Hipolabs university counts (ISO2-keyed) -------------------------
    hipo = fetch(
        config.HIPOLABS_UNIVERSITIES_URL,
        refresh=refresh,
        subdir="education",
        filename="universities.json",
        expect_json=True,
    )
    by_iso2: dict[str, str] = {
        entity.iso2.upper(): iso3
        for iso3, entity in registry.items()
        if entity.iso2
    }
    university_counts: dict[str, int] = {}
    for item in hipo.read_json():
        iso3 = by_iso2.get(str(item.get("alpha_two_code", "")).upper())
        if iso3:
            university_counts[iso3] = university_counts.get(iso3, 0) + 1
    if len(university_counts) < 150:
        raise FetchError(
            f"Hipolabs list resolved to only {len(university_counts)} "
            f"countries; expected ~200."
        )

    # ---- Wikidata public library counts ----------------------------------
    libraries_response = fetch(
        f"{config.WIKIDATA_SPARQL}?format=json&query="
        + urllib.parse.quote(config.WIKIDATA_PUBLIC_LIBRARIES_QUERY),
        refresh=refresh,
        subdir="education",
        filename="wikidata-libraries.json",
        expect_json=True,
    )
    library_counts: dict[str, int] = {}
    for row in libraries_response.read_json()["results"]["bindings"]:
        iso3 = (row.get("iso3", {}).get("value") or "").upper()
        if iso3 in registry:
            try:
                library_counts[iso3] = int(row["libraries"]["value"])
            except (KeyError, ValueError):
                continue

    # ---- CWUR top universities -------------------------------------------
    cwur_response, cwur_year = _load_cwur(refresh)
    top_universities, cwur_unmatched = _parse_cwur(
        cwur_response.read_text(), registry
    )

    entities: dict[str, Any] = {}
    for iso3 in sorted(registry):
        record: dict[str, Any] = {}
        if iso3 in university_counts:
            record["universities"] = university_counts[iso3]
        if iso3 in library_counts:
            record["publicLibraries"] = library_counts[iso3]
        if iso3 in top_universities:
            record["topUniversities"] = top_universities[iso3]
        if record:
            entities[iso3] = record

    document = {
        "cwurYear": cwur_year,
        "notes": {
            "universities": (
                "Count of institutions in the Hipolabs university-domains "
                "list; an institution appears only if it has a web domain, "
                "so this undercounts."
            ),
            "publicLibraries": (
                "Count of items typed 'public library' in Wikidata. Coverage "
                "varies enormously by country's cataloguing activity; treat "
                "as a floor, not a census."
            ),
            "topUniversities": (
                f"CWUR World University Rankings {cwur_year} national ranks; "
                f"countries with fewer than 10 ranked institutions list what "
                f"is ranked."
            ),
        },
        "entities": entities,
    }
    (out_dir / "education.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "education_extras",
        title="University and library counts; CWUR rankings",
        url=config.CWUR_RANKING_TEMPLATE.format(year=cwur_year),
        licence=(
            "Hipolabs MIT; Wikidata CC0; CWUR © Center for World University "
            "Rankings, displayed with attribution"
        ),
        fetched_at=max(
            r.fetched_at for r in (hipo, libraries_response, cwur_response)
        ),
        upstream_release=cwur_response.upstream_release,
        vintage=f"CWUR {cwur_year}; counts as retrieved",
        citation=(
            "Hipolabs university-domains-list; Wikidata; Center for World "
            f"University Rankings (CWUR) {cwur_year}"
        ),
        notes=(
            f"{len(university_counts)} countries with university counts, "
            f"{len(library_counts)} with Wikidata library counts, "
            f"{len(top_universities)} with CWUR-ranked institutions."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "education/education.json",
        description=(
            "University count, Wikidata public-library count, and CWUR "
            "top-10 universities per entity."
        ),
        sources=["education_extras"], entity_count=len(entities),
    )
    if cwur_unmatched:
        manifest_mod.add_warning(
            manifest,
            f"CWUR locations not matched to the registry: "
            f"{', '.join(sorted(cwur_unmatched))}."
        )
    print(f"    education: {len(university_counts)} university counts, "
          f"{len(library_counts)} library counts, "
          f"{len(top_universities)} CWUR countries")


__all__ = ["ingest"]
