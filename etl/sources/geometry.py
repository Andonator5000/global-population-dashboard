"""Natural Earth geometry, re-keyed from UN M49 to our canonical ISO3.

WHAT THIS SOLVES
----------------
The world-atlas 110m TopoJSON keys its 177 country geometries by **M49 numeric
code**, not ISO3, and three of them carry `id: null` because the entity has no
M49 code at all -- Kosovo, Northern Cyprus, and Somaliland. Every one of those
three needs an explicit editorial ruling; none can be resolved by a join.

THE 110m COVERAGE GAP
---------------------
Only 174 of our 250 entities have a polygon at 110m. The missing 76 are small
islands and city-states -- but that list includes Singapore, Malta, Bahrain,
Mauritius, Hong Kong, and Macao: real places with millions of residents that
would simply be absent from a population map.

We keep 110m for rendering (per the brief, and because 50m roughly quadruples
the payload for detail invisible at world zoom) and emit a POINT MARKER for any
entity that has population data but no polygon. A marker is honest -- it says
"this exists here, it is too small to draw at this scale" -- where omission
silently implies the country does not exist. It also gives those entities a
hit target, which a sub-pixel polygon never could.
"""

from __future__ import annotations

import json
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch

# Natural Earth geometries with no M49 code, resolved by their `name` property.
#
# Kosovo joins to our XKX entity. Northern Cyprus and Somaliland are NOT
# separate entities in our registry -- neither has an ISO 3166-1 code, and both
# UN WPP and the World Bank report their territory within Cyprus and Somalia
# respectively. Assigning their polygons to the parent keeps the map consistent
# with the data: colouring Cyprus while leaving a hole where Northern Cyprus
# sits would imply we hold a figure for one and not the other, which is false.
# See DATA_DECISIONS.md.
NULL_ID_ASSIGNMENTS: dict[str, str] = {
    "Kosovo": "XKX",
    "N. Cyprus": "CYP",
    "Somaliland": "SOM",
}


# A split only happens when the containing part's measured area is this close
# to the territory's published land area -- i.e. when the part IS the
# territory, not merely a landmass that encloses it.
_DETACH_AREA_RATIO = (0.7, 1.4)


def _detach_embedded_territories(
    topology: dict[str, Any],
    registry: dict[str, Entity],
    assigned: dict[str, list[int]],
    out_dir: Any,
) -> list[str]:
    """Split territories that Natural Earth draws inside their parent state.

    Natural Earth models France's overseas departments as part of the France
    geometry, which is constitutionally right and cartographically standard.
    But this project keys on ISO 3166-1, where French Guiana is a separate
    entity with its own population, economy and biome data. Left alone, an
    85,596 km2 landmass -- larger than Ireland -- renders and responds to
    clicks as France, while a marker dot for the real entity sits on top of it.

    THE TEST IS AREA, NOT POSITION
    ------------------------------
    Plenty of entities legitimately sit inside a neighbour's polygon and must
    NOT be split out: Vatican City (0.49 km2), Monaco, Gibraltar, Singapore,
    Hong Kong. At 110m those pixels genuinely ARE the surrounding country, and
    the marker is the honest way to reach them.

    What separates the two cases is whether the containing part *is* the
    territory:

        French Guiana  part 85,596 km2 vs published 83,534 km2  -> ratio 1.02
        Singapore      part 135,269 km2 vs published    710 km2 -> ratio 190

    So a part is only detached when its measured area is within
    _DETACH_AREA_RATIO of the entity's published land area. That keeps the rule
    general -- it will catch a comparable case if Natural Earth bundles another
    territory later -- without ever carving a microstate out of its neighbour.

    Operates on the TopoJSON arc indices directly, so no geometry is
    re-encoded: a MultiPolygon part is simply moved into its own geometry
    object referencing the same arcs.
    """
    import geopandas as gpd
    from shapely.geometry import Point

    collection = topology["objects"]["countries"]
    geometries = collection["geometries"]

    # Decode once so we can measure and hit-test parts. Written to a scratch
    # file because the geospatial readers want a path.
    scratch = out_dir / ".topology-scratch.json"
    scratch.write_text(json.dumps(topology), encoding="utf-8", newline="\n")
    try:
        frame = gpd.read_file(scratch, layer="countries")
    finally:
        scratch.unlink(missing_ok=True)

    # TopoJSON carries no CRS metadata, so the reader hands back naive
    # geometries. The coordinates are lon/lat, so state that before projecting
    # -- guessing would be exactly the kind of silent assumption that makes
    # area maths wrong.
    if frame.crs is None:
        frame = frame.set_crs(config.SOURCE_CRS)
    equal_area = frame.to_crs(config.EQUAL_AREA_CRS)

    # Candidates: entities with published area and coordinates but no polygon.
    candidates = [
        entity
        for iso3, entity in registry.items()
        if iso3 not in assigned and entity.latlng and entity.area_km2
    ]

    detached: list[str] = []
    for entity in candidates:
        lat, lon = entity.latlng  # type: ignore[misc]
        point = Point(lon, lat)

        for row_index, row in frame.iterrows():
            parent_iso3 = row["iso3"]
            if parent_iso3 == entity.iso3:
                continue
            shape = row.geometry
            if shape is None or shape.geom_type != "MultiPolygon":
                continue
            if not shape.contains(point):
                continue

            parts = list(shape.geoms)
            projected = list(equal_area.geometry.iloc[row_index].geoms)
            for part_index, part in enumerate(parts):
                if not part.contains(point):
                    continue
                area_km2 = projected[part_index].area / 1e6
                ratio = area_km2 / entity.area_km2  # type: ignore[operator]
                if not (_DETACH_AREA_RATIO[0] <= ratio <= _DETACH_AREA_RATIO[1]):
                    # A much larger landmass that merely encloses this entity.
                    # Correct to leave alone -- see the docstring.
                    continue

                parent_geometry = next(
                    (g for g in geometries if g.get("id") == parent_iso3
                     and g.get("type") == "MultiPolygon"),
                    None,
                )
                if parent_geometry is None:
                    continue
                arcs = parent_geometry["arcs"]
                if part_index >= len(arcs) or len(arcs) < 2:
                    continue

                moved = arcs.pop(part_index)
                geometries.append({
                    "type": "Polygon",
                    "arcs": moved,
                    "id": entity.iso3,
                    "properties": {
                        "iso3": entity.iso3,
                        "name": entity.name_common,
                        "continent": entity.continent,
                        "contested": entity.is_contested,
                    },
                })
                if len(arcs) == 1:
                    parent_geometry["type"] = "Polygon"
                    parent_geometry["arcs"] = arcs[0]
                detached.append(entity.iso3)
                print(
                    f"      detached {entity.iso3} ({entity.name_common}) from "
                    f"{parent_iso3}: part measured {area_km2:,.0f} km2 vs "
                    f"published {entity.area_km2:,.0f} km2",
                    flush=True,
                )
                break
            if entity.iso3 in detached:
                break

    return detached


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "geo"
    out_dir.mkdir(parents=True, exist_ok=True)

    response = fetch(
        config.NATURAL_EARTH_TOPOJSON_110M,
        refresh=refresh,
        subdir="geo",
        filename="countries-110m.json",
        expect_json=True,
    )
    topology = response.read_json()

    if topology.get("type") != "Topology" or "countries" not in topology.get(
        "objects", {}
    ):
        raise FetchError(
            f"Expected a TopoJSON Topology with a 'countries' object; got "
            f"objects={list(topology.get('objects', {}))!r}."
        )

    by_m49 = {
        str(entity.m49).zfill(3): iso3
        for iso3, entity in registry.items()
        if entity.m49 is not None
    }

    geometries = topology["objects"]["countries"]["geometries"]
    assigned: dict[str, list[int]] = {}
    unresolved: list[str] = []

    for index, geometry in enumerate(geometries):
        raw_id = geometry.get("id")
        name = (geometry.get("properties") or {}).get("name") or ""

        if raw_id is None:
            iso3 = NULL_ID_ASSIGNMENTS.get(name)
            if iso3 is None:
                unresolved.append(f"{name!r} (no M49 code, no assignment rule)")
                continue
        else:
            iso3 = by_m49.get(str(raw_id).zfill(3))
            if iso3 is None:
                unresolved.append(f"{name!r} (M49 {raw_id})")
                continue

        if iso3 not in registry:
            unresolved.append(f"{name!r} -> {iso3} not in registry")
            continue

        geometry["id"] = iso3
        geometry["properties"] = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "continent": registry[iso3].continent,
            "contested": registry[iso3].is_contested,
        }
        assigned.setdefault(iso3, []).append(index)

    if unresolved:
        raise FetchError(
            "Natural Earth geometries could not be resolved to ISO3: "
            + "; ".join(unresolved)
            + ". Add an explicit rule rather than dropping the polygon."
        )

    # Entities whose territory is drawn by more than one polygon (Kosovo is its
    # own; Cyprus and Somalia now carry two). Recorded so the app knows a fill
    # may paint several paths for one entity.
    multi_polygon = {iso3: idx for iso3, idx in assigned.items() if len(idx) > 1}

    topology["objects"]["countries"]["geometries"] = geometries
    detached = _detach_embedded_territories(topology, registry, assigned, out_dir)
    for iso3 in detached:
        assigned.setdefault(iso3, []).append(-1)

    (out_dir / "countries-110m.json").write_text(
        json.dumps(topology, separators=(",", ":")) + "\n",
        encoding="utf-8", newline="\n",
    )

    # ---- markers for entities with data but no polygon -------------------
    summary_path = config.DATA_DIR / "population" / "summary.json"
    populated: set[str] = set()
    if summary_path.exists():
        summary = json.loads(summary_path.read_text("utf-8"))
        populated = {
            row["iso3"] for row in summary["entities"]
            if row.get("available") and row.get("population")
        }

    markers: list[dict[str, Any]] = []
    no_geometry_no_marker: list[str] = []
    for iso3 in sorted(set(registry) - set(assigned)):
        entity = registry[iso3]
        if iso3 not in populated:
            # No polygon AND no population: nothing to show and nothing to say.
            no_geometry_no_marker.append(iso3)
            continue
        if not entity.latlng:
            no_geometry_no_marker.append(iso3)
            continue
        lat, lon = entity.latlng
        markers.append({
            "iso3": iso3,
            "name": entity.name_common,
            "continent": entity.continent,
            # GeoJSON order: [longitude, latitude].
            "coordinates": [lon, lat],
            "contested": entity.is_contested,
        })

    marker_document = {
        "note": (
            "Entities with population data but no polygon in the 110m Natural "
            "Earth geometry. Rendered as point markers so a populated country "
            "is never silently absent from the map."
        ),
        "resolution": "110m",
        "markers": markers,
    }
    (out_dir / "markers.json").write_text(
        json.dumps(marker_document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "natural_earth",
        title="Natural Earth 110m Admin 0 (via world-atlas TopoJSON)",
        url=config.NATURAL_EARTH_TOPOJSON_110M,
        licence="Public domain",
        fetched_at=response.fetched_at,
        upstream_release=response.upstream_release,
        vintage=None,
        citation="Natural Earth, 1:110m Cultural Vectors (public domain)",
        notes=(
            f"Re-keyed from UN M49 to ISO3. Kosovo, Northern Cyprus and "
            f"Somaliland carry no M49 code and are assigned explicitly "
            f"(Kosovo to XKX; the other two to Cyprus and Somalia, matching "
            f"how UN WPP and the World Bank report that territory). "
            f"{len(markers)} populated entities are too small to appear at "
            f"110m and are emitted as point markers instead."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "geo/countries-110m.json",
        description="Country polygons keyed by ISO3, for map rendering.",
        sources=["natural_earth"], entity_count=len(assigned),
    )
    manifest_mod.record_artifact(
        manifest, "geo/markers.json",
        description=(
            "Point markers for populated entities with no polygon at 110m."
        ),
        sources=["natural_earth", "country_metadata"], entity_count=len(markers),
    )

    if markers:
        manifest_mod.add_warning(
            manifest,
            f"{len(markers)} populated entities are too small to render as "
            f"polygons at 110m resolution and appear as point markers "
            f"instead, among them Singapore, Malta, Hong Kong and Macao. "
            f"Their area is not to scale on the map."
        )
    if multi_polygon:
        manifest_mod.add_warning(
            manifest,
            "Entities drawn by more than one Natural Earth polygon: "
            + ", ".join(sorted(multi_polygon))
            + " (Cyprus includes Northern Cyprus; Somalia includes "
              "Somaliland). Their fills paint multiple paths."
        )

    print(f"    {len(assigned)} entities with polygons, "
          f"{len(markers)} point markers, "
          f"{len(no_geometry_no_marker)} entities with neither")


__all__ = ["ingest"]
