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


def _emit_tiers(source, tiers: list[dict[str, int]], out_dir: Path,
                label: str) -> list[dict[str, Any]]:
    """Cut an equirectangular image into the resolution-tier tile scheme
    shared by every imagery base (satellite, hypsometric terrain)."""
    from PIL import Image

    out_dir.mkdir(parents=True, exist_ok=True)
    tier_records: list[dict[str, Any]] = []
    for tier in tiers:
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
        print(f"    {label} tier {tier['level']}: {width}x{height}, "
              f"{len(tiles)} tile(s)", flush=True)
    return tier_records


def eox_tile_request(level: int, col: int, row: int, cols: int, rows: int,
                     width: int, height: int) -> tuple[str, str]:
    """(WMS GetMap URL, cache filename) for one tile of the EOX mosaic in
    EPSG:4326: the tile's exact lon/lat window at its exact pixel size, so
    the returned image IS the tile and nothing is resampled."""
    deg_x = 360 / cols
    deg_y = 180 / rows
    lon0 = -180 + col * deg_x
    lon1 = lon0 + deg_x
    lat1 = 90 - row * deg_y
    lat0 = lat1 - deg_y
    url = (
        f"{config.EOX_WMS_URL}?service=WMS&request=GetMap&version=1.1.1"
        f"&layers={config.EOX_S2CLOUDLESS_LAYER}&srs=EPSG:4326"
        f"&bbox={lon0:g},{lat0:g},{lon1:g},{lat1:g}"
        f"&width={width}&height={height}&format=image/png"
    )
    name = f"eox-{config.EOX_S2CLOUDLESS_LAYER}-t{level}-{col}-{row}.png"
    return url, name


def _build_terrain_eox(refresh: bool, out_dir: Path
                       ) -> tuple[list[CachedResponse], list[dict[str, Any]]]:
    """Round 6 (section 56): the satellite tiers straight from the EOX
    WMS, one request per tile. Transparent areas (beyond Sentinel-2's
    coverage at the poles) composite onto white, which is what the ice
    there looks like."""
    from PIL import Image

    out_dir.mkdir(parents=True, exist_ok=True)
    responses: list[CachedResponse] = []
    tier_records: list[dict[str, Any]] = []
    for tier in TIERS:
        width, height = tier["width"], tier["height"]
        cols = max(1, width // TILE_PX)
        rows = max(1, height // TILE_PX)
        tiles: list[str] = []
        for row in range(rows):
            for col in range(cols):
                tile_w = TILE_PX if cols > 1 else width
                tile_h = TILE_PX if rows > 1 else height
                url, cache_name = eox_tile_request(
                    tier["level"], col, row, cols, rows, tile_w, tile_h)
                response = fetch(url, refresh=refresh, subdir="terrain",
                                 filename=cache_name,
                                 timeout=config.EOX_TIMEOUT_SECONDS)
                responses.append(response)
                image = Image.open(response.path)
                if image.size != (tile_w, tile_h):
                    raise FetchError(
                        f"EOX tile t{tier['level']}-{col}-{row} is {image.size}, "
                        f"expected {(tile_w, tile_h)}")
                if image.mode in ("RGBA", "LA", "P"):
                    rgba = image.convert("RGBA")
                    flat = Image.new("RGB", rgba.size, (255, 255, 255))
                    flat.paste(rgba, mask=rgba.getchannel("A"))
                    image = flat
                else:
                    image = image.convert("RGB")
                # The WMS antialiases the outermost pixel of every window
                # against transparency, which the white composite turned
                # into a pale 1 px frame -- a bright seam down the
                # antimeridian and along every tile edge on the globe (round
                # 7, section 57.2). Extend the second column/row over it.
                w, h = image.size
                image.paste(image.crop((1, 0, 2, h)), (0, 0))
                image.paste(image.crop((w - 2, 0, w - 1, h)), (w - 1, 0))
                image.paste(image.crop((0, 1, w, 2)), (0, 0))
                image.paste(image.crop((0, h - 2, w, h - 1)), (0, h - 1))
                name = (f"t{tier['level']}.jpg" if cols == 1 and rows == 1
                        else f"t{tier['level']}-{col}-{row}.jpg")
                image.save(out_dir / name, "JPEG", quality=72, optimize=True,
                           progressive=True)
                tiles.append(name)
        tier_records.append({
            "level": tier["level"], "width": width, "height": height,
            "cols": cols, "rows": rows, "tile_px": TILE_PX, "tiles": tiles,
        })
        print(f"    satellite (EOX) tier {tier['level']}: {width}x{height}, "
              f"{len(tiles)} tile(s)", flush=True)
    return responses, tier_records


def _build_terrain(refresh: bool, out_dir: Path) -> tuple[CachedResponse, list[dict[str, Any]]]:
    """Blue Marble 2004: the documented fallback (section 54.3), kept for
    a `SATELLITE_SOURCE=bluemarble` run."""
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

    source = Image.open(response.path).convert("RGB")
    if source.size != (21600, 10800):
        raise FetchError(
            f"Blue Marble source is {source.size}, expected (21600, 10800); "
            f"the tier math below would emit misaligned tiles."
        )
    return response, _emit_tiers(source, TIERS, out_dir, "satellite")


def _build_hypso(refresh: bool, out_dir: Path) -> tuple[CachedResponse, list[dict[str, Any]]]:
    """Round-2 §37: the Terrain view's imagery — Natural Earth's Cross
    Blended Hypso with Shaded Relief and Water (public domain), the classic
    hypsometric-tint look with hillshade and light-blue water baked in."""
    import zipfile

    from PIL import Image

    response = fetch(
        config.NATURAL_EARTH_HYPSO_50M,
        refresh=refresh,
        subdir="terrain",
        filename="hypso-50m.zip",
    )
    Image.MAX_IMAGE_PIXELS = None
    with zipfile.ZipFile(response.path) as archive:
        tif_names = [n for n in archive.namelist() if n.lower().endswith(".tif")]
        if len(tif_names) != 1:
            raise FetchError(
                f"HYP_50M_SR_W.zip: expected exactly one .tif, found "
                f"{tif_names}. The archive layout moved."
            )
        extract_dir = response.path.parent / "hypso-extract"
        archive.extract(tif_names[0], extract_dir)
        source = Image.open(extract_dir / tif_names[0]).convert("RGB")
    if source.size != (10800, 5400):
        raise FetchError(
            f"Hypso raster is {source.size}, expected (10800, 5400)."
        )
    tiers = [
        {"level": 0, "width": 2700, "height": 1350},
        {"level": 1, "width": 10800, "height": 5400},
    ]
    return response, _emit_tiers(source, tiers, out_dir, "hypso")


def _clean_name(value: Any) -> str:
    """A label name, or '' for None/NaN/blank."""
    if isinstance(value, str):
        return value.strip()
    return ""


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
        # A missing name arrives from pandas as float NaN, which is truthy
        # and stringifies to "nan" -- seven such labels shipped and rendered
        # literally on the map (round 4, section 51.5). Only a non-blank
        # string is a name.
        name = _clean_name(row.get(name_col)) or _clean_name(row.get("name_en"))
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
        name = _clean_name(row.get(place_name))
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
    # EOX Sentinel-2 cloudless since round 6 (section 56); Blue Marble
    # 2004 only on SATELLITE_SOURCE=bluemarble.
    import os
    use_bluemarble = os.environ.get("SATELLITE_SOURCE") == "bluemarble"
    if use_bluemarble:
        terrain_resp, tier_records = _build_terrain(refresh, terrain_dir)
        terrain_responses = [terrain_resp]
        _write_json(terrain_dir / "meta.json", {
            "source": "NASA Blue Marble Next Generation (topography & bathymetry)",
            "vintage": config.BLUE_MARBLE_VINTAGE,
            "attribution": "NASA Earth Observatory (Blue Marble)",
            "licence": "Public domain",
            "tiers": tier_records,
        })
    else:
        terrain_responses, tier_records = _build_terrain_eox(refresh, terrain_dir)
        terrain_resp = terrain_responses[0]
        _write_json(terrain_dir / "meta.json", {
            "source": f"EOX Sentinel-2 cloudless {config.EOX_S2CLOUDLESS_VINTAGE}",
            "vintage": config.EOX_S2CLOUDLESS_VINTAGE,
            "attribution": config.EOX_S2CLOUDLESS_ATTRIBUTION,
            "licence": config.EOX_S2CLOUDLESS_LICENCE,
            "licenceUrl": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
            "tiers": tier_records,
        })

    # ---- hypsometric terrain view (round-2 §37) --------------------------
    hypso_dir = config.DATA_DIR / "geo" / "terrain-hypso"
    hypso_resp, hypso_tiers = _build_hypso(refresh, hypso_dir)
    responses.append(hypso_resp)
    _write_json(hypso_dir / "meta.json", {
        "source": "Natural Earth Cross Blended Hypso with Shaded Relief "
                  "and Water (50m)",
        "vintage": None,
        "attribution": "Terrain: Natural Earth (public domain)",
        "tiers": hypso_tiers,
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
    if use_bluemarble:
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
    else:
        manifest_mod.record_source(
            manifest,
            "nasa_blue_marble",
            title=f"EOX Sentinel-2 cloudless {config.EOX_S2CLOUDLESS_VINTAGE} (satellite view)",
            url="https://cloudless.eox.at",
            licence=f"{config.EOX_S2CLOUDLESS_LICENCE} (non-commercial); "
                    f"attribution required: {config.EOX_S2CLOUDLESS_ATTRIBUTION}",
            fetched_at=max(r.fetched_at for r in terrain_responses),
            upstream_release=None,
            vintage=config.EOX_S2CLOUDLESS_VINTAGE,
            citation=config.EOX_S2CLOUDLESS_ATTRIBUTION,
            notes=(
                "Three resolution tiers (2700x1350; 10800x5400 as 8 tiles; "
                "21600x10800 as 32 tiles of 2700 px) fetched as 41 EPSG:4326 WMS "
                "windows from tiles.maps.eox.at, each the tile's exact bounds and "
                "size, re-encoded as progressive JPEG q72. Polar areas beyond "
                "Sentinel-2 coverage are white. Source id kept as "
                "'nasa_blue_marble' so artifact references stay stable; the "
                "Blue Marble fallback is SATELLITE_SOURCE=bluemarble."
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
         "Terrain tier index for the satellite view (EOX Sentinel-2 cloudless "
         "tiles; Blue Marble on SATELLITE_SOURCE=bluemarble)."),
        ("geo/terrain-hypso/meta.json",
         "Tier index for the Terrain view (Natural Earth cross-blended "
         "hypsometric relief tiles)."),
    ]:
        manifest_mod.record_artifact(
            manifest, filename,
            description=description,
            sources=["nasa_blue_marble"] if "terrain" in filename
            else ["natural_earth_detail"],
        )


__all__ = ["ingest"]
