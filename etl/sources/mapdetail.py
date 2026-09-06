"""Map detail layers: sub-national borders, water, places, terrain imagery.

Phase 4 (2026-09-05, DATA_DECISIONS.md §30). Everything the map needs beyond
country polygons, all fetched and processed here so nothing is hand-typed:

VECTORS (Natural Earth, public domain, via naciscdn.org)
--------------------------------------------------------
- admin-1 boundary LINES (10m)  -> geo/detail/admin1-lines.json
- admin-1 label points          -> geo/detail/admin1-labels.json
  (computed from the admin-1 polygons; the lines file carries no names)
- lakes at 50m and 10m          -> geo/detail/lakes-{50m,10m}.json
- rivers at 50m and 10m         -> geo/detail/rivers-{50m,10m}.json
- populated places (10m simple) -> geo/detail/places.json

Vector layers are emitted as simplified, coordinate-rounded GeoJSON rather
than TopoJSON: these layers share no edges (the border lines are already
dissolved; lakes are disjoint), so TopoJSON's shared-arc encoding buys
nothing here, and rounding to 3 decimals (~110 m) is the same quantization
in plainer clothes. 110 m is invisible at the map's maximum zoom (~0.5
km/px fullscreen).

TERRAIN (NASA Blue Marble Next Generation, public domain)
---------------------------------------------------------
The August 2004 composite WITH topography and bathymetry: shaded relief is
baked into the imagery, so mountains, valleys and deserts read without a
separate hillshade layer, and August snow cover hides the least terrain.
The 21600x10800 source (~1.85 km/px) is cut into resolution tiers so the
app fetches only what the current zoom needs:

    tier 0: one 2700x1350 world JPEG (every page load)
    tier 1: 10800x5400 as 8 tiles of 2700px (mid zoom)
    tier 2: 21600x10800 as 32 tiles of 2700px (high zoom, fetched by
            visible window only)

NASA's 500 m set (86400x43200, 8 source tiles) exists in the same image
family; adopting it is a config change plus ~100 MB of committed tiles,
recorded as an open question in DATA_DECISIONS.md §30.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch

# Feature filters. 10m lakes and rivers carry thousands of features that are
# invisible even at our maximum zoom; scalerank is Natural Earth's own
# rendering-priority field, so filtering on it is cartographic judgement
# delegated to the cartographers. Counts are logged so a change shows up.
LAKES_10M_MAX_SCALERANK = 7
RIVERS_10M_MAX_SCALERANK = 8

# Simplification tolerances in degrees (the layers are rendering-only; no
# area math happens on them -- that stays in EPSG:6933 in the biomes stage).
SIMPLIFY_DEG = {
    "admin1": 0.01,
    "lakes-50m": 0.01,
    "lakes-10m": 0.005,
    "rivers-50m": 0.01,
    "rivers-10m": 0.005,
}

COORD_DECIMALS = 3  # ~110 m; invisible at max zoom (~0.5 km/px)

TILE_PX = 2700
TIERS = [
    {"level": 0, "width": 2700, "height": 1350},
    {"level": 1, "width": 10800, "height": 5400},
    {"level": 2, "width": 21600, "height": 10800},
]


def _round_coords(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, COORD_DECIMALS)
    if isinstance(value, (list, tuple)):
        return [_round_coords(item) for item in value]
    return value


def _write_json(path: Path, document: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(document, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )


def _feature_collection(features: list[dict[str, Any]]) -> dict[str, Any]:
    return {"type": "FeatureCollection", "features": features}


def _load_frame(response: CachedResponse):
    import geopandas as gpd

    frame = gpd.read_file(response.path)
    if frame.crs is None:
        frame = frame.set_crs(config.SOURCE_CRS)
    return frame


def _simplify(frame, tolerance: float):
    out = frame.copy()
    out["geometry"] = out.geometry.simplify(tolerance, preserve_topology=True)
    return out


def _emit_lines(
    frame, path: Path, *, properties: dict[str, str],
) -> int:
    """Write a line/polygon layer as rounded GeoJSON. Returns feature count."""
    from shapely.geometry import mapping

    features: list[dict[str, Any]] = []
    for _, row in frame.iterrows():
        shape = row.geometry
        if shape is None or shape.is_empty:
            continue
        geometry = mapping(shape)
        geometry["coordinates"] = _round_coords(geometry["coordinates"])
        props = {}
        for out_name, column in properties.items():
            value = row.get(column)
            if value is not None and value == value:  # drop NaN
                props[out_name] = value
        features.append(
            {"type": "Feature", "properties": props, "geometry": geometry}
        )
    _write_json(path, _feature_collection(features))
    return len(features)


def _first_column(frame, candidates: list[str], *, url: str) -> str:
    for name in candidates:
        if name in frame.columns:
            return name
    raise FetchError(
        f"{url}: none of the expected columns {candidates} present "
        f"(got {sorted(frame.columns)[:20]}...). The schema moved; fix the "
        f"mapping rather than emitting a layer with no names."
    )


def _build_terrain(refresh: bool, out_dir: Path) -> tuple[CachedResponse, list[dict[str, Any]]]:
    from PIL import Image

    response = fetch(
        config.BLUE_MARBLE_URL,
        refresh=refresh,
        subdir="terrain",
        filename="bluemarble-topo-bathy-21600.jpg",
    )

    # 21600x10800 = 233 Mpx exceeds Pillow's decompression-bomb guard (178
    # Mpx), which exists to stop hostile images. This one is a known NASA
    # file whose sha256 the manifest records; lifting the guard for exactly
    # this decode is deliberate.
    Image.MAX_IMAGE_PIXELS = None

    out_dir.mkdir(parents=True, exist_ok=True)
    source = Image.open(response.path).convert("RGB")
    if source.size != (21600, 10800):
        raise FetchError(
            f"Blue Marble source is {source.size}, expected (21600, 10800); "
            f"the tier math below would emit misaligned tiles."
        )

    tier_records: list[dict[str, Any]] = []
    for tier in TIERS:
        width, height = tier["width"], tier["height"]
        cols = max(1, width // TILE_PX)
        rows = max(1, height // TILE_PX)
        image = (
            source if (width, height) == source.size
            else source.resize((width, height), Image.LANCZOS)
        )
        tiles: list[str] = []
        for row in range(rows):
            for col in range(cols):
                if cols == 1 and rows == 1:
                    name = f"t{tier['level']}.jpg"
                    tile = image
                else:
                    name = f"t{tier['level']}-{col}-{row}.jpg"
                    box = (
                        col * TILE_PX, row * TILE_PX,
                        min((col + 1) * TILE_PX, width),
                        min((row + 1) * TILE_PX, height),
                    )
                    tile = image.crop(box)
                tile.save(
                    out_dir / name, "JPEG",
                    quality=72, optimize=True, progressive=True,
                )
                tiles.append(name)
        tier_records.append({
            "level": tier["level"],
            "width": width,
            "height": height,
            "cols": cols,
            "rows": rows,
            "tile_px": TILE_PX,
            "tiles": tiles,
        })
        print(f"    terrain tier {tier['level']}: {width}x{height}, "
              f"{len(tiles)} tile(s)", flush=True)

    return response, tier_records


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry  # rendering layers are not keyed to entities
    detail_dir = config.DATA_DIR / "geo" / "detail"
    terrain_dir = config.DATA_DIR / "geo" / "terrain"

    responses: list[CachedResponse] = []

    def grab(url: str, filename: str) -> CachedResponse:
        response = fetch(url, refresh=refresh, subdir="mapdetail",
                         filename=filename)
        responses.append(response)
        return response

    # ---- admin-1 borders (lines) and labels (from polygons) --------------
    lines_resp = grab(config.NATURAL_EARTH_ADMIN1_LINES_10M, "admin1-lines.zip")
    lines = _simplify(_load_frame(lines_resp), SIMPLIFY_DEG["admin1"])
    n = _emit_lines(lines, detail_dir / "admin1-lines.json", properties={})
    print(f"    admin1-lines: {n} features", flush=True)

    poly_resp = grab(config.NATURAL_EARTH_ADMIN1_10M, "admin1-polygons.zip")
    polygons = _load_frame(poly_resp)
    name_col = _first_column(polygons, ["name", "name_en"], url=poly_resp.url)
    labels: list[dict[str, Any]] = []
    for _, row in polygons.iterrows():
        name = row.get(name_col) or row.get("name_en")
        shape = row.geometry
        if not name or shape is None or shape.is_empty:
            continue
        point = shape.representative_point()
        labels.append({
            "name": str(name),
            "a0": str(row.get("adm0_a3") or ""),
            "lon": round(float(point.x), 2),
            "lat": round(float(point.y), 2),
        })
    labels.sort(key=lambda item: (item["a0"], item["name"]))
    _write_json(detail_dir / "admin1-labels.json", labels)
    print(f"    admin1-labels: {len(labels)} points", flush=True)

    # ---- lakes and rivers, two scales ------------------------------------
    water_layers = [
        ("lakes-50m", config.NATURAL_EARTH_LAKES_50M, None),
        ("lakes-10m", config.NATURAL_EARTH_LAKES_10M, LAKES_10M_MAX_SCALERANK),
        ("rivers-50m", config.NATURAL_EARTH_RIVERS_50M, None),
        ("rivers-10m", config.NATURAL_EARTH_RIVERS_10M, RIVERS_10M_MAX_SCALERANK),
    ]
    for key, url, max_scalerank in water_layers:
        response = grab(url, f"{key}.zip")
        frame = _load_frame(response)
        total = len(frame)
        if max_scalerank is not None and "scalerank" in frame.columns:
            frame = frame[frame["scalerank"] <= max_scalerank]
        frame = _simplify(frame, SIMPLIFY_DEG[key])
        name_col = "name" if "name" in frame.columns else None
        props = {"name": name_col} if name_col else {}
        if "scalerank" in frame.columns:
            props["rank"] = "scalerank"
        n = _emit_lines(frame, detail_dir / f"{key}.json", properties=props)
        print(f"    {key}: {n} of {total} features "
              f"(scalerank<={max_scalerank})" if max_scalerank is not None
              else f"    {key}: {n} features", flush=True)

    # ---- populated places ------------------------------------------------
    places_resp = grab(config.NATURAL_EARTH_PLACES_10M, "places.zip")
    places_frame = _load_frame(places_resp)
    place_name = _first_column(places_frame, ["name", "NAME"], url=places_resp.url)
    places: list[dict[str, Any]] = []
    for _, row in places_frame.iterrows():
        name = row.get(place_name)
        if not name or row.geometry is None:
            continue
        entry = {
            "name": str(name),
            "lon": round(float(row.geometry.x), 3),
            "lat": round(float(row.geometry.y), 3),
            "rank": int(row.get("scalerank", 10)),
        }
        pop = row.get("pop_max")
        if pop and pop == pop and pop > 0:
            entry["pop"] = int(pop)
        if int(row.get("adm0cap") or 0) == 1:
            entry["cap"] = 1
        places.append(entry)
    places.sort(key=lambda item: (item["rank"], -item.get("pop", 0), item["name"]))
    _write_json(detail_dir / "places.json", places)
    print(f"    places: {len(places)} points", flush=True)

    # ---- terrain imagery -------------------------------------------------
    terrain_resp, tier_records = _build_terrain(refresh, terrain_dir)
    _write_json(terrain_dir / "meta.json", {
        "source": "NASA Blue Marble Next Generation (topography & bathymetry)",
        "vintage": config.BLUE_MARBLE_VINTAGE,
        "attribution": "NASA Earth Observatory (Blue Marble)",
        "tiers": tier_records,
    })

    # ---- provenance ------------------------------------------------------
    manifest_mod.record_source(
        manifest,
        "natural_earth_detail",
        title="Natural Earth 10m/50m detail layers (admin-1, lakes, rivers, places)",
        url="https://www.naturalearthdata.com/",
        licence="Public domain",
        fetched_at=max(r.fetched_at for r in responses),
        upstream_release=responses[0].upstream_release,
        vintage=None,
        citation="Natural Earth, 1:10m and 1:50m Cultural and Physical Vectors (public domain)",
        notes=(
            "Admin-1 boundaries as dissolved border lines with label points "
            "computed from the polygons; lakes and rivers at both scales "
            f"(10m filtered to scalerank <= {LAKES_10M_MAX_SCALERANK} lakes / "
            f"{RIVERS_10M_MAX_SCALERANK} rivers); populated places from the "
            "'simple' subset. Simplified and rounded for rendering only -- "
            "no measurements are taken from these layers."
        ),
    )
    manifest_mod.record_source(
        manifest,
        "nasa_blue_marble",
        title="NASA Blue Marble Next Generation, August 2004 (topo & bathy)",
        url=config.BLUE_MARBLE_URL,
        licence="Public domain (NASA; credit requested)",
        fetched_at=terrain_resp.fetched_at,
        upstream_release=terrain_resp.upstream_release,
        vintage=config.BLUE_MARBLE_VINTAGE,
        citation=(
            "NASA Earth Observatory, Blue Marble: Next Generation with "
            "Topography and Bathymetry (public domain)"
        ),
        notes=(
            "21600x10800 (~1.85 km/px) cut into three resolution tiers of "
            "2700 px JPEG tiles; shaded relief is baked into the imagery. "
            "The 500 m set exists upstream if the size budget is raised."
        ),
    )
    for filename, description in [
        ("geo/detail/admin1-lines.json",
         "First-level administrative boundary lines (10m, simplified)."),
        ("geo/detail/admin1-labels.json",
         "Admin-1 label points: name, country code, representative point."),
        ("geo/detail/lakes-50m.json", "Lakes at 50m for low/mid zoom."),
        ("geo/detail/lakes-10m.json", "Lakes at 10m for high zoom."),
        ("geo/detail/rivers-50m.json", "Rivers at 50m for low/mid zoom."),
        ("geo/detail/rivers-10m.json", "Rivers at 10m for high zoom."),
        ("geo/detail/places.json",
         "Populated places with scalerank and population for zoom-gated labels."),
        ("geo/terrain/meta.json",
         "Terrain tier index for the satellite view (Blue Marble tiles)."),
    ]:
        manifest_mod.record_artifact(
            manifest, filename,
            description=description,
            sources=["nasa_blue_marble"] if "terrain" in filename
            else ["natural_earth_detail"],
        )


__all__ = ["ingest"]
