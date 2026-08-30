"""Electricity generation mix and nuclear power plants (added 2026-08-30).

Maintainer request: nuclear power and renewable sources per country in
the Technology & Infrastructure section.

* Electricity MIX: Our World in Data grapher series (producer: Ember and
  the Energy Institute Statistical Review, which OWID's metadata names)
  -- the share of electricity generated from coal, gas, oil, nuclear,
  hydro, wind, solar and bioenergy, plus the renewables total. Shares
  are taken for the latest year in which the entity has a value for the
  largest source, and the breakdown completion rules add the explicit
  "Other" (other renewables such as geothermal, and rounding).

* Nuclear power PLANTS: Wikidata items typed nuclear power station with
  the country set, kept when their state of use is "in use" (or unset)
  and no retirement/dissolution date is recorded, and a nameplate
  capacity is recorded (which excludes proposed sites). Wikidata is not
  the authority -- the IAEA's PRIS is, but it publishes no keyless table
  -- so the tile says "as catalogued in Wikidata" and the plausibility
  layer bounds the count.
"""

from __future__ import annotations

import csv
import io
import json
import urllib.parse
from typing import Any

from .. import breakdown, config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch
from ..validate import Plausibility


def _parse_csv(text: str, slug: str) -> dict[str, dict[int, float]]:
    reader = csv.DictReader(io.StringIO(text))
    fields = reader.fieldnames or []
    code_field = "Code" if "Code" in fields else "code" if "code" in fields else None
    year_field = "Year" if "Year" in fields else "year" if "year" in fields else None
    if code_field is None or year_field is None:
        raise FetchError(f"OWID grapher {slug} returned unexpected columns: {fields!r}")
    value_field = next(
        (f for f in fields if f not in ("Entity", "entity", code_field, year_field)
         and not f.lower().startswith("world region")),
        None,
    )
    if value_field is None:
        raise FetchError(f"OWID grapher {slug} has no value column: {fields!r}")
    out: dict[str, dict[int, float]] = {}
    for row in reader:
        code = (row.get(code_field) or "").strip().upper()
        raw = row.get(value_field)
        if not code or code.startswith("OWID") or raw in (None, ""):
            continue
        try:
            out.setdefault(code, {})[int(row[year_field])] = float(raw)
        except ValueError:
            continue
    return out


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "energy"
    out_dir.mkdir(parents=True, exist_ok=True)

    responses: list[CachedResponse] = []
    series: dict[str, dict[str, dict[int, float]]] = {}
    producers: set[str] = set()
    for key, slug in config.OWID_ELECTRICITY_SHARES.items():
        response = fetch(
            config.OWID_GRAPHER_CSV.format(slug=slug) + "?v=1&csvType=full&useColumnShortNames=true",
            refresh=refresh, subdir="energy", filename=f"{slug}.csv",
        )
        responses.append(response)
        try:
            meta = fetch(
                config.OWID_GRAPHER_METADATA.format(slug=slug),
                refresh=refresh, subdir="energy", filename=f"{slug}.metadata.json",
                expect_json=True,
            ).read_json()
            for column in (meta.get("columns") or {}).values():
                for origin in column.get("citationShort", "").split(";"):
                    if origin.strip():
                        producers.add(origin.strip())
        except FetchError:
            pass
        series[key] = _parse_csv(response.read_text(), slug)

    # Nuclear plants, Wikidata.
    plants_response = fetch(
        f"{config.WIKIDATA_SPARQL}?format=json&query="
        + urllib.parse.quote(config.WIKIDATA_NUCLEAR_PLANTS_QUERY),
        refresh=refresh, subdir="energy", filename="wikidata-nuclear-plants.json",
        expect_json=True,
    )
    responses.append(plants_response)
    plants: dict[str, dict[str, Any]] = {}
    for row in plants_response.read_json()["results"]["bindings"]:
        iso3 = (row.get("iso3", {}).get("value") or "").upper()
        if iso3 in registry:
            plants[iso3] = {
                "count": int(row["plants"]["value"]),
                "capacityMw": round(float(row["mw"]["value"])) if row.get("mw") else None,
            }

    plausibility = Plausibility("energy", registry)
    entities: dict[str, Any] = {}
    for iso3 in sorted(registry):
        record: dict[str, Any] = {}
        # Latest year with a coal-or-gas-or-hydro value anchors the mix year.
        years = set()
        for key in ("coal", "gas", "hydro", "nuclear", "solar", "wind"):
            years |= set(series.get(key, {}).get(iso3, {}))
        if years:
            year = max(years)
            items = []
            for key in config.OWID_ELECTRICITY_SHARES:
                if key == "renewables":
                    continue
                value = series.get(key, {}).get(iso3, {}).get(year)
                if value is not None and value <= 0:
                    continue  # a source the country does not use is not a row
                if value is not None and plausibility.check(
                    iso3, f"energy.share.{key}", value, unit="percent", year=year, label=f"{key} share",
                ):
                    items.append({
                        "label": config.ELECTRICITY_SOURCE_LABELS[key],
                        "percent": round(value, 2),
                        "isUpperBound": False, "official": False, "qualifier": None,
                    })
            if len(items) >= 2:
                total = round(sum(i["percent"] for i in items), 2)
                field: dict[str, Any] = {
                    "available": True,
                    "text": "; ".join(f"{i['label']} {i['percent']:g}%" for i in items),
                    "vintageYear": year, "vintageQualifier": None,
                    "chartable": True, "items": items, "quantifiedCount": len(items),
                    "percentTotal": total, "sumsToApprox100": bool(97 <= total <= 103),
                    "sharesMayOverlap": False, "sourceTextMalformed": False,
                    "malformedReason": None, "concatenatedSegments": None,
                    "note": "Shares of electricity generated, by source.",
                }
                field.update(breakdown.complete("electricityMix", total, iso3=iso3, label="electricity mix"))
                record["mix"] = field
            renewables = series.get("renewables", {}).get(iso3, {}).get(year)
            if renewables is not None:
                record["renewablesShare"] = {"value": round(renewables, 2), "year": year}
            nuclear = series.get("nuclear", {}).get(iso3, {}).get(year)
            if nuclear is not None:
                record["nuclearShare"] = {"value": round(nuclear, 2), "year": year}
        if iso3 in plants and plausibility.check(
            iso3, "energy.nuclearPlants", plants[iso3]["count"], label="Nuclear power plants",
        ):
            record["nuclearPlants"] = plants[iso3]
        if record:
            entities[iso3] = record

    document = {
        "source": "owid_wikidata",
        "note": (
            "Electricity generation shares by source from Our World in Data "
            "(producers: Ember; Energy Institute Statistical Review of World "
            "Energy), latest year per entity. Nuclear power plant counts are "
            "operating stations as catalogued in Wikidata (state of use 'in "
            "use' or unset, no retirement date, capacity recorded); the IAEA "
            "PRIS is the authority and may differ."
        ),
        "entities": entities,
    }
    (out_dir / "energy.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    breakdown.flush("energy", manifest)
    plausibility.flush(manifest)

    with_mix = sum(1 for e in entities.values() if "mix" in e)
    with_plants = sum(1 for e in entities.values() if "nuclearPlants" in e)
    manifest_mod.record_source(
        manifest,
        "owid_electricity",
        title="Electricity mix (Our World in Data) and nuclear plants (Wikidata)",
        url=config.OWID_GRAPHER_CSV.format(slug=config.OWID_ELECTRICITY_SHARES["nuclear"]),
        licence="OWID CC BY 4.0 (Ember CC BY 4.0; Energy Institute); Wikidata CC0",
        fetched_at=max(r.fetched_at for r in responses),
        upstream_release=None,
        vintage="latest year per entity",
        citation="; ".join(sorted(producers)) or "Ember; Energy Institute, via Our World in Data; Wikidata",
        notes=f"{with_mix} entities with an electricity mix, {with_plants} with nuclear plants.",
    )
    manifest_mod.record_artifact(
        manifest, "energy/energy.json",
        description="Electricity generation mix by source, renewable and nuclear shares, and operating nuclear power plants per entity.",
        sources=["owid_electricity"], entity_count=len(entities),
    )
    print(f"    energy: {with_mix} entities with a mix, {with_plants} with nuclear plants")


__all__ = ["ingest"]
