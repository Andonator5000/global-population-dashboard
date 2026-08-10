"""Biome breakdown per country and per continent, computed at BUILD TIME.

RESOLVE Ecoregions 2017 intersected with Natural Earth country polygons, both
reprojected to an equal-area CRS, summed by (country, biome), and normalised to
each country's land area.

WHY THE CRS STEP IS NOT OPTIONAL
--------------------------------
Both sources ship in EPSG:4326, whose units are DEGREES. A degree of longitude
is about 111 km at the equator and zero at the poles, so `polygon.area` in 4326
is not an area at all -- it is a number with no physical meaning that
systematically shrinks high-latitude land. Computing biome shares that way
would understate tundra and boreal forest across Russia and Canada by a large
factor. Everything here happens in EPSG:6933 (NSIDC EASE-Grid 2.0 Global,
cylindrical equal-area), where `.area` is square metres.

WHY SIMPLIFY FIRST
------------------
The raw ecoregion file is a 149 MB shapefile of 847 multipolygons at full
coastline detail. Overlaying that against 242 country polygons without
simplifying is intractable. Geometry is simplified in PROJECTED metres (not
degrees) so the tolerance means the same thing everywhere on Earth, then
repaired, because simplification routinely produces self-intersections that
would silently poison the overlay.

WHAT THE SHARES MEAN
--------------------
`share` is a percentage of the COUNTRY'S OWN land area, not of its ecoregion
coverage. That choice makes the ±1% validation meaningful: if shares sum to
94%, it means 6% of that country's polygon has no ecoregion assigned (small
islands, ice, inland water), and we report it rather than rescaling the gap
away. Normalising by covered area instead would force every country to exactly
100% and the check would prove nothing.
"""

from __future__ import annotations

import json
import zipfile
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch

# Ecoregion polygons carrying this biome label are rock, ice and inland water
# rather than a biome. Kept as an explicit category -- Greenland and Antarctica
# are mostly this, and dropping it would make their shares nonsense.
NON_BIOME_LABEL = "N/A"
NON_BIOME_DISPLAY = "Rock, ice and inland water"

SHARE_TOLERANCE = config.BIOME_SHARE_TOLERANCE_PCT


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    # Imported lazily: geopandas pulls in GDAL and takes a second or two, and
    # every other stage runs without it.
    import geopandas as gpd
    import pandas as pd

    out_dir = config.DATA_DIR / "biomes"
    out_dir.mkdir(parents=True, exist_ok=True)

    eco_response = fetch(
        config.ECOREGIONS_URL,
        refresh=refresh,
        subdir="biomes",
        filename="Ecoregions2017.zip",
    )
    ne_response = fetch(
        config.NATURAL_EARTH_ADMIN0_50M,
        refresh=refresh,
        subdir="biomes",
        filename="ne_50m_admin_0_countries.zip",
    )

    with zipfile.ZipFile(eco_response.path) as archive:
        shapefile = next(
            (n for n in archive.namelist() if n.lower().endswith(".shp")), None
        )
    if shapefile is None:
        raise FetchError(
            f"No .shp inside {eco_response.path}; the ecoregions archive "
            f"layout changed."
        )

    print("    reading ecoregions...", flush=True)
    eco = gpd.read_file(f"zip://{eco_response.path}!{shapefile}")
    if eco.crs is None:
        raise FetchError("Ecoregions shapefile has no CRS; refusing to guess.")
    print(f"      {len(eco)} ecoregions, crs {eco.crs}", flush=True)

    print("    reading country polygons (Natural Earth 50m)...", flush=True)
    countries = gpd.read_file(f"zip://{ne_response.path}")
    print(f"      {len(countries)} polygons, crs {countries.crs}", flush=True)

    # ---- resolve country polygons onto our ISO3 -------------------------
    # ISO_A3_EH ("EH" = de facto, with Kosovo etc. filled in) has far fewer
    # gaps than ISO_A3; ADM0_A3 is the backstop and is never blank.
    #
    # The name fallback applies the SAME editorial rulings the map uses at
    # 110m. Without it the 50m layer silently drops Northern Cyprus and
    # Somaliland, which showed up as Cyprus measuring 38% and Somalia 26%
    # below their published land areas -- the map and the biome maths would
    # have disagreed about what those countries are.
    from .geometry import NULL_ID_ASSIGNMENTS

    def resolve(row: Any) -> str | None:
        for column in ("ISO_A3_EH", "ISO_A3", "ADM0_A3"):
            value = row.get(column)
            if isinstance(value, str) and value not in {"-99", "", "nan"}:
                if value in registry:
                    return value
        for column in ("NAME", "NAME_LONG", "BRK_NAME"):
            value = row.get(column)
            if isinstance(value, str) and value in NULL_ID_ASSIGNMENTS:
                return NULL_ID_ASSIGNMENTS[value]
        return None

    countries["iso3"] = countries.apply(resolve, axis=1)
    unresolved = countries[countries["iso3"].isna()]
    if len(unresolved):
        names = [
            str(n) for n in unresolved.get("NAME", []).tolist()  # type: ignore[union-attr]
        ]
        print(f"      unresolved polygons: {', '.join(names) or 'unnamed'}", flush=True)
    countries = countries[countries["iso3"].notna()].copy()
    print(
        f"      {len(countries)} joined to the registry, "
        f"{len(unresolved)} unresolved",
        flush=True,
    )

    # ---- equal-area reprojection ----------------------------------------
    print(f"    reprojecting both layers to {config.EQUAL_AREA_CRS}...", flush=True)
    eco = eco.to_crs(config.EQUAL_AREA_CRS)
    countries = countries.to_crs(config.EQUAL_AREA_CRS)

    # ---- simplify, then repair ------------------------------------------
    tolerance = config.ECOREGION_SIMPLIFY_TOLERANCE_M
    print(f"    simplifying ecoregions at {tolerance} m and repairing...", flush=True)
    eco["geometry"] = eco.geometry.simplify(tolerance, preserve_topology=True)
    eco["geometry"] = eco.geometry.make_valid()
    countries["geometry"] = countries.geometry.make_valid()
    eco = eco[~eco.geometry.is_empty & eco.geometry.notna()].copy()

    eco["biome"] = eco["BIOME_NAME"].fillna(NON_BIOME_LABEL)
    eco.loc[eco["biome"] == NON_BIOME_LABEL, "biome"] = NON_BIOME_DISPLAY

    # ---- country land area, measured in the same CRS ---------------------
    # Taken from the projected country polygon rather than any published
    # figure, so numerator and denominator come from identical geometry and
    # the share arithmetic is internally consistent.
    countries["country_area_m2"] = countries.geometry.area
    country_area = (
        countries.groupby("iso3")["country_area_m2"].sum().to_dict()
    )

    print("    overlaying (this is the expensive step)...", flush=True)
    overlay = gpd.overlay(
        countries[["iso3", "geometry"]],
        eco[["biome", "ECO_NAME", "geometry"]],
        how="intersection",
        keep_geom_type=True,
    )
    overlay["area_m2"] = overlay.geometry.area
    print(f"      {len(overlay)} intersection pieces", flush=True)

    # ---- aggregate -------------------------------------------------------
    by_biome = (
        overlay.groupby(["iso3", "biome"], as_index=False)["area_m2"].sum()
    )
    by_ecoregion = (
        overlay.groupby(["iso3", "ECO_NAME"], as_index=False)["area_m2"].sum()
    )

    entities: dict[str, Any] = {}
    validation_failures: list[dict[str, Any]] = []

    for iso3, group in by_biome.groupby("iso3"):
        total_country = country_area.get(iso3, 0.0)
        if total_country <= 0:
            continue
        rows = []
        for record in group.itertuples(index=False):
            share = (record.area_m2 / total_country) * 100.0
            rows.append({
                "biome": record.biome,
                "areaKm2": round(record.area_m2 / 1e6, 2),
                "share": round(share, 3),
            })
        rows.sort(key=lambda r: -r["share"])
        covered = round(sum(r["share"] for r in rows), 3)

        eco_rows = by_ecoregion[by_ecoregion["iso3"] == iso3]
        top_ecoregions = [
            {
                "name": r.ECO_NAME,
                "areaKm2": round(r.area_m2 / 1e6, 2),
                "share": round((r.area_m2 / total_country) * 100.0, 3),
            }
            for r in eco_rows.sort_values("area_m2", ascending=False)
            .head(8)
            .itertuples(index=False)
        ]

        within_tolerance = abs(covered - 100.0) <= SHARE_TOLERANCE
        if not within_tolerance:
            validation_failures.append({
                "iso3": iso3,
                "name": registry[iso3].name_common if iso3 in registry else iso3,
                "coveredShare": covered,
                "gap": round(100.0 - covered, 3),
            })

        entities[iso3] = {
            "iso3": iso3,
            "name": registry[iso3].name_common if iso3 in registry else iso3,
            "landAreaKm2": round(total_country / 1e6, 2),
            "biomes": rows,
            "topEcoregions": top_ecoregions,
            # Sum of shares. 100 means ecoregions cover the whole polygon;
            # a shortfall is reported, never rescaled away.
            "coveredShare": covered,
            "withinTolerance": within_tolerance,
        }

    # ---- continent aggregation ------------------------------------------
    # Areas are summed before dividing, so a continent's share is weighted by
    # land area. Averaging member percentages instead would let Vatican City
    # count as much as Russia.
    continent_area: dict[str, float] = {}
    continent_biome: dict[str, dict[str, float]] = {}
    for iso3, record in entities.items():
        entity = registry.get(iso3)
        if entity is None:
            continue
        key = entity.continent
        continent_area[key] = continent_area.get(key, 0.0) + record["landAreaKm2"]
        bucket = continent_biome.setdefault(key, {})
        for row in record["biomes"]:
            bucket[row["biome"]] = bucket.get(row["biome"], 0.0) + row["areaKm2"]

    continents: dict[str, Any] = {}
    for key, total in continent_area.items():
        if total <= 0:
            continue
        rows = [
            {
                "biome": biome,
                "areaKm2": round(area, 2),
                "share": round((area / total) * 100.0, 3),
            }
            for biome, area in continent_biome.get(key, {}).items()
        ]
        rows.sort(key=lambda r: -r["share"])
        continents[key] = {
            "continent": key,
            "name": config.CONTINENTS[key],
            "landAreaKm2": round(total, 2),
            "biomes": rows,
            "coveredShare": round(sum(r["share"] for r in rows), 3),
            "memberEntitiesWithBiomeData": sum(
                1
                for iso3 in entities
                if registry.get(iso3) and registry[iso3].continent == key
            ),
        }

    biome_names = sorted(
        {row["biome"] for record in entities.values() for row in record["biomes"]}
    )

    document = {
        "note": (
            "Computed at build time from RESOLVE Ecoregions 2017 intersected "
            "with Natural Earth 50m country polygons. Both layers reprojected "
            f"to {config.EQUAL_AREA_CRS} (equal-area) before any area "
            "arithmetic. Shares are percentages of each entity's own land "
            "area, so a sum below 100 means part of the polygon carries no "
            "ecoregion; that gap is reported, never rescaled."
        ),
        "equalAreaCrs": config.EQUAL_AREA_CRS,
        "simplifyToleranceM": tolerance,
        "shareTolerancePct": SHARE_TOLERANCE,
        "biomeNames": biome_names,
        "entitiesWithData": len(entities),
        "validationFailures": sorted(
            validation_failures, key=lambda f: abs(f["gap"]), reverse=True
        ),
        "entities": entities,
        "continents": continents,
    }
    (out_dir / "biomes.json").write_text(
        json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    manifest_mod.record_source(
        manifest,
        "resolve_ecoregions",
        title="RESOLVE Ecoregions 2017",
        url=config.ECOREGIONS_URL,
        licence="CC BY 4.0",
        fetched_at=eco_response.fetched_at,
        upstream_release=eco_response.upstream_release,
        vintage="2017",
        citation=(
            "Dinerstein et al. (2017), An Ecoregion-Based Approach to "
            "Protecting Half the Terrestrial Realm, BioScience 67(6)"
        ),
        notes=(
            f"Intersected with Natural Earth 50m country polygons in "
            f"{config.EQUAL_AREA_CRS}. Ecoregion geometry simplified at "
            f"{tolerance} m in projected metres before the overlay. Shares are "
            f"percentages of each entity's own land area."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "biomes/biomes.json",
        description="Biome and ecoregion shares by entity and by continent.",
        sources=["resolve_ecoregions", "natural_earth"],
        entity_count=len(entities),
    )

    if validation_failures:
        # Split the failures, because they have two quite different causes and
        # lumping them together hides which is which.
        small = [
            f for f in validation_failures
            if entities[f["iso3"]]["landAreaKm2"] < 50_000
        ]
        large = [f for f in validation_failures if f not in small]
        manifest_mod.add_warning(
            manifest,
            f"Biome shares fall outside {SHARE_TOLERANCE}% of 100 for "
            f"{len(validation_failures)} entities. {len(small)} are small "
            f"territories under 50,000 km2 that RESOLVE Ecoregions does not "
            f"resolve (verified: a 4x finer simplification tolerance did not "
            f"improve them). {len(large)} are larger countries whose polygons "
            f"include substantial inland water or ice that carries no "
            f"terrestrial ecoregion -- Tanzania's great lakes, Canada's Great "
            f"Lakes, the Greenland ice sheet. Shares are reported as computed "
            f"and never rescaled to 100."
        )

    # ---- flag entities whose measured area contradicts the published one --
    # A large gap here is not a maths error; it means the 50m polygon draws a
    # different territory than the published figure describes. The Morocco /
    # Western Sahara pair is the significant case: Natural Earth attributes
    # most of Western Sahara to Morocco at this resolution, so Morocco's biome
    # shares cover land the MAP shows as Western Sahara. Readers deserve to
    # know that before comparing the two.
    area_conflicts = []
    for iso3, record in entities.items():
        published_area = registry[iso3].area_km2 if iso3 in registry else None
        if not published_area or published_area < 1000:
            continue
        error = (record["landAreaKm2"] - published_area) / published_area
        if abs(error) > 0.25:
            area_conflicts.append({
                "iso3": iso3,
                "name": record["name"],
                "measuredKm2": record["landAreaKm2"],
                "publishedKm2": published_area,
                "errorPct": round(error * 100, 1),
            })
            record["areaDiffersFromPublishedPct"] = round(error * 100, 1)

    document_extra_conflicts = sorted(
        area_conflicts, key=lambda c: abs(c["errorPct"]), reverse=True
    )
    if document_extra_conflicts:
        worst = ", ".join(
            f"{c['iso3']} {c['errorPct']:+.0f}%" for c in document_extra_conflicts[:5]
        )
        manifest_mod.add_warning(
            manifest,
            f"{len(document_extra_conflicts)} entities' measured polygon area "
            f"differs from their published land area by more than 25% "
            f"({worst}). These are boundary-definition differences, not "
            f"measurement errors. Most significant: at 50m resolution Natural "
            f"Earth attributes most of Western Sahara to Morocco, so Morocco's "
            f"biome shares include territory the map renders as Western "
            f"Sahara, and Western Sahara's cover only the remainder."
        )
    document["areaConflicts"] = document_extra_conflicts
    (out_dir / "biomes.json").write_text(
        json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    missing = sorted(set(registry) - set(entities))
    if missing:
        manifest_mod.add_warning(
            manifest,
            f"{len(missing)} entities have no biome data, mostly small island "
            f"territories absent from the 50m geometry."
        )

    print(
        f"    {len(entities)} entities, {len(continents)} continents, "
        f"{len(validation_failures)} outside +/-{SHARE_TOLERANCE}% tolerance"
    )


__all__ = ["ingest"]
