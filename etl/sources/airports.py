"""Top airports per country: OurAirports roster ranked by Wikidata patronage.

OurAirports (public domain, ISO2-keyed) knows every airport but no traffic;
Wikidata knows annual passengers (P3872) for ~4,500 IATA codes but is not a
roster. Joined on IATA code: the roster is large airports plus medium
airports with scheduled service, ranked by patronage where known, then by
size class, then name. "Top 20 by flight volume" is therefore approximated
by best-available passenger figures -- the page's note says exactly that
rather than implying a ranking source that does not exist.
"""

from __future__ import annotations

import csv
import io
import json
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "airports"
    out_dir.mkdir(parents=True, exist_ok=True)

    roster_response = fetch(
        config.OURAIRPORTS_CSV_URL,
        refresh=refresh,
        subdir="airports",
        filename="airports.csv",
    )
    patronage_response = fetch(
        f"{config.WIKIDATA_SPARQL}?format=json&query="
        + urllib.parse.quote(config.WIKIDATA_AIRPORT_PATRONAGE_QUERY),
        refresh=refresh,
        subdir="airports",
        filename="wikidata-patronage.json",
        expect_json=True,
    )

    patronage: dict[str, int] = {}
    for row in patronage_response.read_json()["results"]["bindings"]:
        iata = row.get("iata", {}).get("value")
        try:
            value = int(float(row["patronage"]["value"]))
        except (KeyError, ValueError):
            continue
        if iata:
            patronage[iata] = max(patronage.get(iata, 0), value)
    if len(patronage) < 2000:
        raise FetchError(
            f"Airport patronage query returned only {len(patronage)} IATA "
            f"codes; expected ~4,500."
        )

    by_iso2 = {
        entity.iso2.upper(): iso3
        for iso3, entity in registry.items()
        if entity.iso2
    }

    by_country: dict[str, list[dict[str, Any]]] = {}
    rows = csv.DictReader(io.StringIO(roster_response.read_text()))
    for row in rows:
        kind = row.get("type")
        if kind == "large_airport":
            pass
        elif kind == "medium_airport" and row.get("scheduled_service") == "yes":
            pass
        else:
            continue
        iso3 = by_iso2.get((row.get("iso_country") or "").upper())
        if iso3 is None:
            continue
        iata = (row.get("iata_code") or "").strip() or None
        by_country.setdefault(iso3, []).append({
            "name": (row.get("name") or "").strip(),
            "iata": iata,
            "municipality": (row.get("municipality") or "").strip() or None,
            "large": kind == "large_airport",
            "passengers": patronage.get(iata) if iata else None,
        })
    if len(by_country) < 150:
        raise FetchError(
            f"OurAirports roster resolved to only {len(by_country)} "
            f"countries; expected ~200. Column layout may have changed."
        )

    written = 0
    total = 0
    ranked_count = 0
    for iso3, airports in sorted(by_country.items()):
        airports.sort(
            key=lambda a: (
                -(a["passengers"] or 0),
                not a["large"],
                a["name"],
            )
        )
        del airports[config.AIRPORTS_TOP_N:]
        document = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": "ourairports_wikidata",
            "note": (
                "Large airports plus medium airports with scheduled service "
                "(OurAirports), ranked by annual passengers where Wikidata "
                "records them; airports without a passenger figure follow, "
                "largest class first. Passenger figures are the latest "
                "recorded and their reference years vary."
            ),
            "airports": airports,
        }
        (out_dir / f"{iso3}.json").write_text(
            json.dumps(document, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )
        written += 1
        total += len(airports)
        ranked_count += sum(1 for a in airports if a["passengers"])

    manifest_mod.record_source(
        manifest,
        "airports",
        title="OurAirports roster; Wikidata annual passengers",
        url=config.OURAIRPORTS_CSV_URL,
        licence="OurAirports: public domain. Wikidata: CC0",
        fetched_at=max(
            roster_response.fetched_at, patronage_response.fetched_at
        ),
        upstream_release=roster_response.upstream_release,
        vintage="roster as retrieved; passenger figures carry their own years",
        citation="OurAirports; Wikidata (P3872 patronage)",
        notes=(
            f"{written} countries, {total} airports listed, {ranked_count} "
            f"with a passenger figure. Traffic ranking is best-available, "
            f"not exhaustive."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "airports/<ISO3>.json",
        description=(
            "Top airports per entity (name, IATA, city, annual passengers "
            "where recorded), large first."
        ),
        sources=["airports"], entity_count=written,
    )
    print(f"    airports: {written} countries, {total} listed, "
          f"{ranked_count} with passenger figures")


__all__ = ["ingest"]
