"""The Solar System: planets, moons, dwarf planets (Phase 7, §33).

SOURCES
-------
- **NSSDC Planetary Fact Sheets** for the Sun, the eight planets, Earth's
  Moon and Pluto — the brief's named source. nssdc.gsfc.nasa.gov now
  307-redirects wholesale to a nasa.gov landing page, so the sheets come
  from PINNED Internet Archive snapshots (config.NSSDC_SNAPSHOTS; the
  `id_` variant serves original bytes). Planetary constants do not move
  month to month; the pin is recorded per body as the figure's vintage.
- **JPL Solar System Dynamics** (live, keyless) for the full natural-
  satellite catalogue: orbital elements for every known moon, physical
  parameters for the ~46 with measured values, and discovery year and
  discoverer. Moon counts are derived by counting this catalogue, never
  copied from a stale fact sheet.
- **JPL Small-Body Database API** for the non-Pluto dwarf planets (Ceres,
  Eris, Haumea, Makemake). Fields SBDB does not carry are emitted as null
  and render as "not available" — never zero, per the repo's rules.
- **NASA Image and Video Library** (images-api.nasa.gov, keyless, NASA
  media) for one portrait per major body, resolved from a curated search
  query per body; the picked asset is logged for review.

Every figure's source and vintage ride with its body record. Fact-sheet
parsing is strict: a missing expected field aborts the run.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch

PLANETS = [
    "mercury", "venus", "earth", "mars",
    "jupiter", "saturn", "uranus", "neptune",
]
DWARF_SBDB = ["Ceres", "Eris", "Haumea", "Makemake"]

# Horizons body ids for the archived-vs-live cross-check.
HORIZONS_IDS: dict[str, str] = {
    "mercury": "199", "venus": "299", "earth": "399", "mars": "499",
    "jupiter": "599", "saturn": "699", "uranus": "799", "neptune": "899",
    "pluto": "999",
}

# Pre-telescopic planets have no discoverer; these do. Editorial constants
# of the "capital of France" kind, recorded here rather than scraped.
DISCOVERY: dict[str, dict[str, Any]] = {
    "uranus": {"by": "William Herschel", "year": 1781},
    "neptune": {"by": "Johann Galle, from Urbain Le Verrier's prediction",
                "year": 1846},
    "pluto": {"by": "Clyde Tombaugh", "year": 1930},
}

WIKIPEDIA: dict[str, str] = {
    "sun": "Sun", "mercury": "Mercury (planet)", "venus": "Venus",
    "earth": "Earth", "mars": "Mars", "jupiter": "Jupiter",
    "saturn": "Saturn", "uranus": "Uranus", "neptune": "Neptune",
    "moon": "Moon", "pluto": "Pluto", "ceres": "Ceres (dwarf planet)",
    "eris": "Eris (dwarf planet)", "haumea": "Haumea",
    "makemake": "Makemake",
}

NASA_IMAGE_QUERY: dict[str, str] = {
    "sun": "sun sdo full disk", "mercury": "mercury planet messenger globe",
    "venus": "venus planet global view", "earth": "blue marble earth",
    "mars": "mars planet global mosaic", "jupiter": "jupiter planet cassini portrait",
    "saturn": "saturn planet cassini rings portrait",
    "uranus": "uranus planet voyager", "neptune": "neptune planet voyager full disk",
    "moon": "moon lro nearside mosaic", "pluto": "pluto new horizons full disk",
    "ceres": "dawn ceres global", "eris": "eris dwarf planet artist",
    "haumea": "haumea dwarf planet artist", "makemake": "makemake dwarf planet artist",
}

AU_KM = 149_597_870.7


# --------------------------------------------------------------------------
# NSSDC fact sheets
# --------------------------------------------------------------------------

def _strip_tags(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html)
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    return text


class FactSheet:
    """One NSSDC fact sheet, readable by label.

    Two layouts exist. The Earth and Sun sheets are single-column text
    (label and value on one line). The planet, Moon and Pluto sheets are
    THREE-column comparison tables — label cell, body value cell, Earth
    value, ratio — so the body's number is the row's second cell, and a
    line scan would read nothing (or, worse, the Earth column). Table rows
    are read first (first match wins, which also keeps Pluto's figures
    ahead of the Charon table lower on its page); the line scan is the
    fallback for the single-column sheets and prose lines.
    """

    def __init__(self, page: str, html: str) -> None:
        self.page = page
        self.text = _strip_tags(html)
        self.rows: list[tuple[str, str]] = []
        for table in re.findall(r"<table.*?</table>", html, re.S | re.I):
            for row_html in re.findall(r"<tr.*?</tr>", table, re.S | re.I):
                # Labels sit in <th>, values in <td>; capture both in
                # document order so cells[0] is the row's label.
                cells = [
                    re.sub(r"\s+", " ", _strip_tags(cell)).strip()
                    for cell in re.findall(
                        r"<t[hd][^>]*>(.*?)</t[hd]>", row_html, re.S | re.I)
                ]
                if len(cells) >= 2 and cells[0]:
                    self.rows.append((cells[0], cells[1]))

    def _first_number(self, value: str) -> float | None:
        match = re.search(r"-?[\d,]+\.?\d*(?:\s*[eE][+-]?\d+)?", value)
        return float(match.group(0).replace(",", "")) if match else None

    def number(self, labels: list[str], *, optional: bool = False
               ) -> float | None:
        for label, value in self.rows:
            for wanted in labels:
                if label.lower().startswith(wanted.lower()):
                    number = self._first_number(value)
                    if number is not None:
                        return number
        for line in self.text.splitlines():
            squashed = re.sub(r"\s+", " ", line).strip()
            for wanted in labels:
                if squashed.lower().startswith(wanted.lower()):
                    number = self._first_number(squashed[len(wanted):])
                    if number is not None:
                        return number
        if optional:
            return None
        raise FetchError(
            f"NSSDC {self.page} fact sheet: none of {labels} found with a "
            f"numeric value. The sheet layout moved; fix the parser, do "
            f"not ship a partial body."
        )

    def mass_kg(self) -> float:
        """Mass with its exponent read from the label itself — the sheets
        scale it per body (10 22 for the Moon, 10 24 for the giants)."""
        exponent = re.compile(r"Mass \(10 (\d+) kg\)")
        for label, value in self.rows:
            match = exponent.match(label)
            if match:
                number = self._first_number(value)
                if number is not None:
                    return number * 10 ** int(match.group(1))
        for line in self.text.splitlines():
            squashed = re.sub(r"\s+", " ", line).strip()
            match = exponent.match(squashed)
            if match:
                number = self._first_number(squashed[match.end():])
                if number is not None:
                    return number * 10 ** int(match.group(1))
        raise FetchError(
            f"NSSDC {self.page} fact sheet: no 'Mass (10 N kg)' row found. "
            f"The sheet layout moved; fix the parser."
        )


def _parse_fact_sheet(page: str, sheet: FactSheet) -> dict[str, Any]:
    """The brief's required figures from one NSSDC planetary fact sheet."""
    rotation_hours = sheet.number(
        ["Sidereal rotation period (hrs)", "Sidereal rotation period (hours)"],
        optional=True)
    if rotation_hours is None:
        # Pluto's sheet states rotation in days.
        rotation_days = sheet.number(["Sidereal rotation period (days)"])
        rotation_hours = rotation_days * 24 if rotation_days else None
    facts: dict[str, Any] = {
        "massKg": sheet.mass_kg(),
        "equatorialRadiusKm": sheet.number(
            ["Equatorial radius (km)",
             "Equatorial radius (1 bar level) (km)"]),
        "densityKgM3": sheet.number(["Mean density (kg/m 3 )"]),
        "gravityMS2": sheet.number(
            ["Surface gravity (mean) (m/s 2 )", "Surface gravity (eq.) (m/s 2 )",
             "Surface gravity (equatorial) (m/s 2 )",
             "Gravity (mean, 1 bar) (m/s 2 )",
             "Gravity (eq., 1 bar) (m/s 2 )", "Surface gravity (m/s 2 )"]),
        "escapeKmS": sheet.number(["Escape velocity (km/s)"]),
        "rotationPeriodHours": rotation_hours,
    }
    if page == "moon":
        # The Moon orbits Earth, not the Sun; its sheet carries different
        # orbital labels.
        facts["semimajorAxisKm"] = sheet.number(
            ["Semimajor axis (10 6 km)"]) * 1e6
        facts["orbitalPeriodDays"] = sheet.number(
            ["Revolution period (days)", "Sidereal orbit period (days)"])
        facts["eccentricity"] = sheet.number(["Orbit eccentricity"])
        facts["axialTiltDeg"] = sheet.number(["Obliquity to orbit (deg)"])
    else:
        facts["semimajorAxisKm"] = sheet.number(
            ["Semimajor axis (10 6 km)"]) * 1e6
        facts["orbitalPeriodDays"] = sheet.number(
            ["Sidereal orbit period (days)"])
        facts["eccentricity"] = sheet.number(["Orbit eccentricity"])
        facts["axialTiltDeg"] = sheet.number(["Obliquity to orbit (deg)"])
    facts["semimajorAxisAu"] = round(facts["semimajorAxisKm"] / AU_KM, 6)
    facts["meanTempK"] = sheet.number(
        ["Mean temperature (K)", "Average temperature:",
         "Mean surface temperature", "Effective temperature (K)",
         "Black-body temperature (K)"],
        optional=True)
    return facts


# --------------------------------------------------------------------------
# Cross-check: archived NSSDC vs live JPL Horizons
# --------------------------------------------------------------------------

def _horizons_physical(body_id: str, *, refresh: bool
                       ) -> tuple[dict[str, float | None], CachedResponse]:
    """Volumetric mean radius, mass and density from Horizons OBJ_DATA.

    The physical-properties block is free text whose labels vary per body
    (mass exponents differ; Pluto omits a parseable density), so each
    field is matched tolerantly and reported as None when absent — the
    caller decides which absences are acceptable.
    """
    response = fetch(
        f"{config.JPL_HORIZONS_API}?format=json&COMMAND='{HORIZONS_IDS[body_id]}'"
        f"&OBJ_DATA='YES'&MAKE_EPHEM='NO'",
        refresh=refresh, subdir="space",
        filename=f"horizons-{body_id}.json", expect_json=True,
    )
    text = response.read_json().get("result", "")
    radius = re.search(r"Vol\.? [Mm]ean [Rr]adius[^=]*= *([\d.]+)", text)
    mass = re.search(r"Mass,? x? ?10\^(\d+) ?\(?(kg|g)\)? *=? *([\d.]+)", text)
    density = re.search(
        r"Density,? ?\(?(?:g[ /]cm\^?-?3\)?|g cm\^-3)[^=]*= *([\d.]+)", text)
    mass_kg: float | None = None
    if mass:
        mass_kg = float(mass.group(3)) * 10 ** int(mass.group(1))
        if mass.group(2) == "g":
            mass_kg /= 1000
    return {
        "radiusKm": float(radius.group(1)) if radius else None,
        "massKg": mass_kg,
        "densityGCm3": float(density.group(1)) if density else None,
    }, response


def _cross_check(page: str, facts: dict[str, Any], sheet: FactSheet,
                 *, refresh: bool,
                 log: list[dict[str, Any]]) -> CachedResponse:
    """Abort if the archived fact sheet disagrees with live Horizons.

    Radius compares the sheet's VOLUMETRIC mean radius (Horizons reports
    that, not the equatorial figure). Mass and density compare directly.
    A field Horizons does not expose for a body is skipped, not passed.
    """
    live, response = _horizons_physical(page, refresh=refresh)
    tolerance = config.HORIZONS_CHECK_TOLERANCE
    sheet_volumetric = sheet.number(
        ["Volumetric mean radius (km)"], optional=True)
    pairs: list[tuple[str, float | None, float | None, float]] = [
        ("massKg", facts.get("massKg"), live["massKg"], tolerance["massKg"]),
        ("radiusKm", sheet_volumetric, live["radiusKm"], tolerance["radiusKm"]),
        ("density", facts.get("densityKgM3"),
         live["densityGCm3"] * 1000 if live["densityGCm3"] else None,
         tolerance["density"]),
    ]
    for name, ours, theirs, allowed in pairs:
        if ours is None or theirs is None:
            log.append({"body": page, "field": name, "status": "skipped"})
            continue
        diff = abs(ours - theirs) / theirs
        log.append({"body": page, "field": name, "sheet": ours,
                    "horizons": theirs, "diff": round(diff, 5)})
        if diff > allowed:
            raise FetchError(
                f"{page}: archived NSSDC {name} = {ours} disagrees with "
                f"live JPL Horizons {theirs} by {diff:.2%} "
                f"(tolerance {allowed:.0%}). The archive cannot be trusted "
                f"for this body — investigate before publishing."
            )
    return response


# --------------------------------------------------------------------------
# JPL SSD satellite tables
# --------------------------------------------------------------------------

def _table_rows(html: str, *, index: int = 0) -> list[list[str]]:
    tables = re.findall(r"<table.*?</table>", html, re.S)
    if index >= len(tables):
        raise FetchError(
            f"expected at least {index + 1} <table> blocks, found "
            f"{len(tables)}."
        )
    rows: list[list[str]] = []
    for row_html in re.findall(r"<tr.*?</tr>", tables[index], re.S):
        cells = [
            re.sub(r"\s+", " ", _strip_tags(cell)).strip()
            for cell in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row_html, re.S)
        ]
        if cells:
            rows.append(cells)
    return rows


def _parse_float(value: str) -> float | None:
    match = re.search(r"-?[\d,]+\.?\d*(?:[eE][+-]?\d+)?", value or "")
    return float(match.group(0).replace(",", "")) if match else None


def _load_moons(refresh: bool) -> tuple[dict[str, list[dict[str, Any]]],
                                        list[CachedResponse]]:
    responses: list[CachedResponse] = []

    elem_resp = fetch(config.JPL_SATS_ELEM, refresh=refresh, subdir="space",
                      filename="sats-elem.html")
    responses.append(elem_resp)
    elem_rows = _table_rows(elem_resp.read_bytes().decode("utf-8", errors="replace"), index=0)
    header = [h.lower() for h in elem_rows[0]]

    def col(rows_header: list[str], *names: str) -> int:
        # Exact match first: 'e' must find the eccentricity column, not
        # win a startswith race against 'Ephemeris'.
        for name in names:
            for i, h in enumerate(rows_header):
                if h == name:
                    return i
        for name in names:
            for i, h in enumerate(rows_header):
                if h.startswith(name):
                    return i
        raise FetchError(f"JPL table: column {names} not found in {rows_header}")

    c_planet = col(header, "planet")
    c_sat = col(header, "satellite")
    c_a = col(header, "a(km)", "a (km)")
    c_e = col(header, "e")
    c_i = col(header, "i(deg)", "i (deg)")
    c_p = col(header, "p(days)", "p (days)")

    phys_resp = fetch(config.JPL_SATS_PHYS, refresh=refresh, subdir="space",
                      filename="sats-phys.html")
    responses.append(phys_resp)
    phys: dict[str, dict[str, Any]] = {}
    phys_rows = _table_rows(phys_resp.read_bytes().decode("utf-8", errors="replace"), index=0)
    for row in phys_rows[1:]:
        if len(row) < 6:
            continue
        # Six columns: Planet, Satellite, Code, GM, Radius, Density — the
        # last three each pack "value sigma reference" into one cell, so
        # the value is the cell's first numeric token.
        name = row[1]
        phys[name] = {
            "gm": _parse_float(row[3]),
            "radiusKm": _parse_float(row[4]),
            "densityGCm3": _parse_float(row[5]),
        }

    disc_resp = fetch(config.JPL_SATS_DISCOVERY, refresh=refresh,
                      subdir="space", filename="sats-discovery.html")
    responses.append(disc_resp)
    discovery: dict[str, dict[str, Any]] = {}
    for row in _table_rows(disc_resp.read_bytes().decode("utf-8", errors="replace"), index=0)[1:]:
        if len(row) < 5:
            continue
        name = row[1] or row[2]
        year = _parse_float(row[3])
        if name:
            discovery[name] = {
                "year": int(year) if year else None,
                "by": row[4] or None,
            }

    moons: dict[str, list[dict[str, Any]]] = {}
    seen: set[tuple[str, str]] = set()
    for row in elem_rows[1:]:
        if len(row) <= max(c_planet, c_sat, c_a, c_e, c_i, c_p):
            continue
        planet = row[c_planet].lower()
        name = row[c_sat]
        if not planet or not name or planet == "planet":
            continue
        # JPL can list a moon twice with two element solutions (Puck);
        # first row wins, and moon COUNTS are of distinct names (§42).
        if (planet, name) in seen:
            continue
        seen.add((planet, name))
        physical = phys.get(name, {})
        gm = physical.get("gm")
        found = discovery.get(name, {})
        moons.setdefault(planet, []).append({
            "name": name,
            "aKm": _parse_float(row[c_a]),
            "e": _parse_float(row[c_e]),
            "iDeg": _parse_float(row[c_i]),
            "periodDays": _parse_float(row[c_p]),
            "radiusKm": physical.get("radiusKm"),
            # GM (km^3/s^2) -> kg via G = 6.6743e-20 km^3 kg^-1 s^-2.
            "massKg": (gm / 6.6743e-20) if gm else None,
            "densityGCm3": physical.get("densityGCm3"),
            "discoveryYear": found.get("year"),
            "discoveredBy": found.get("by"),
            "major": physical.get("radiusKm") is not None,
        })
    for listing in moons.values():
        listing.sort(key=lambda moon: (moon["aKm"] or 0))
    return moons, responses


# --------------------------------------------------------------------------
# Dwarf planets via SBDB
# --------------------------------------------------------------------------

def _sbdb_body(name: str, *, refresh: bool) -> tuple[dict[str, Any], CachedResponse]:
    response = fetch(
        f"{config.JPL_SBDB_API}?sstr={urllib.parse.quote(name)}&phys-par=1",
        refresh=refresh, subdir="space",
        filename=f"sbdb-{name.lower()}.json", expect_json=True,
    )
    payload = response.read_json()
    elements = {
        e["name"]: _parse_float(str(e.get("value")))
        for e in payload.get("orbit", {}).get("elements", [])
    }
    phys = {
        p["name"]: _parse_float(str(p.get("value")))
        for p in payload.get("phys_par", [])
    }
    a_au = elements.get("a")
    diameter = phys.get("diameter")
    rot_hours = phys.get("rot_per")
    facts: dict[str, Any] = {
        "semimajorAxisAu": a_au,
        "semimajorAxisKm": round(a_au * AU_KM) if a_au else None,
        "orbitalPeriodDays": elements.get("per"),
        "eccentricity": elements.get("e"),
        "equatorialRadiusKm": round(diameter / 2, 1) if diameter else None,
        "rotationPeriodHours": rot_hours,
        "densityKgM3": phys.get("density") * 1000 if phys.get("density") else None,
        # SBDB does not publish these for most TNOs; null renders honestly.
        "massKg": (phys.get("GM") / 6.6743e-20) if phys.get("GM") else None,
        "gravityMS2": None,
        "escapeKmS": None,
        "axialTiltDeg": None,
        "meanTempK": None,
    }
    vintage = payload.get("orbit", {}).get("last_obs")
    facts["_vintage"] = vintage
    return facts, response


# --------------------------------------------------------------------------
# NASA image library portraits
# --------------------------------------------------------------------------

def _nasa_portrait(body_id: str, *, refresh: bool) -> tuple[dict[str, Any] | None,
                                                            CachedResponse]:
    query = NASA_IMAGE_QUERY[body_id]
    # Cache key includes the QUERY content (§21): editing a body's search
    # terms must never re-serve the old query's results.
    import hashlib
    digest = hashlib.sha256(query.encode("utf-8")).hexdigest()[:10]
    response = fetch(
        "https://images-api.nasa.gov/search?media_type=image&q="
        + urllib.parse.quote(query),
        refresh=refresh, subdir="space",
        filename=f"nasaimg-{body_id}-{digest}.json", expect_json=True,
    )
    items = response.read_json().get("collection", {}).get("items", [])
    for item in items:
        data = (item.get("data") or [{}])[0]
        links = item.get("links") or []
        preview = next(
            (l.get("href") for l in links if l.get("rel") == "preview"), None)
        if not preview:
            continue
        return {
            "url": preview,
            "title": data.get("title"),
            "nasaId": data.get("nasa_id"),
            "page": "https://images.nasa.gov/details/"
            + urllib.parse.quote(data.get("nasa_id") or ""),
            "credit": data.get("secondary_creator") or data.get("center")
            or "NASA",
        }, response
    return None, response


# --------------------------------------------------------------------------
# Round-2 §41: textures, gazetteer, phenomena
# --------------------------------------------------------------------------

def _build_textures(refresh: bool, out_dir: Path
                    ) -> tuple[list[CachedResponse], dict[str, str],
                               dict[str, dict[str, Any]]]:
    """Solar System Scope textures (CC BY 4.0). The 2k placeholders are
    copied byte-for-byte; the hi-res variants (round 3 §45) are copied
    byte-for-byte when at or under their configured width and otherwise
    Lanczos-downsampled to it and re-encoded as a progressive JPEG. Returns
    (responses, 2k paths by body, hi-res records by body)."""
    import shutil

    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    out_dir.mkdir(parents=True, exist_ok=True)
    responses: list[CachedResponse] = []
    paths: dict[str, str] = {}
    hi: dict[str, dict[str, Any]] = {}
    for body_id, filename in config.SOLARSYSTEMSCOPE_TEXTURES.items():
        response = fetch(
            f"{config.SOLARSYSTEMSCOPE_BASE}/{filename}",
            refresh=refresh, subdir="space", filename=f"tex-{filename}",
        )
        responses.append(response)
        target = out_dir / f"{body_id}.jpg"
        shutil.copyfile(response.path, target)
        paths[body_id] = f"space/textures/{body_id}.jpg"
    # Hi-res variants, named by their ACTUAL width (the pack's "8k" Sun,
    # Jupiter and Saturn are 4096 wide). Loaded lazily by the app — the
    # globe modal always, the scene only for the body flown to.
    for body_id, (filename, max_width) in (
            config.SOLARSYSTEMSCOPE_TEXTURES_HI.items()):
        response = fetch(
            f"{config.SOLARSYSTEMSCOPE_BASE}/{filename}",
            refresh=refresh, subdir="space", filename=f"tex-{filename}",
        )
        responses.append(response)
        with Image.open(response.path) as image:
            source_size = image.size
            width = min(source_size[0], max_width)
            label = f"{width // 1024}k"
            target = out_dir / f"{body_id}-{label}.jpg"
            if width == source_size[0]:
                shutil.copyfile(response.path, target)
                derived = False
            else:
                height = round(source_size[1] * width / source_size[0])
                image.convert("RGB").resize(
                    (width, height), Image.Resampling.LANCZOS,
                ).save(
                    target, "JPEG",
                    quality=config.SOLARSYSTEMSCOPE_HI_JPEG_QUALITY,
                    optimize=True, progressive=True,
                )
                derived = True
        hi[body_id] = {
            "path": f"space/textures/{target.name}",
            "px": width,
            "bytes": target.stat().st_size,
            "derivedFrom": (f"{filename} ({source_size[0]}x{source_size[1]})"
                            if derived else None),
        }
    ring = fetch(
        f"{config.SOLARSYSTEMSCOPE_BASE}/{config.SOLARSYSTEMSCOPE_RING}",
        refresh=refresh, subdir="space", filename="tex-saturn-ring.png",
    )
    responses.append(ring)
    shutil.copyfile(ring.path, out_dir / "saturn-ring.png")
    paths["saturn-ring"] = "space/textures/saturn-ring.png"
    hi_mb = sum(record["bytes"] for record in hi.values()) / 1e6
    print(f"    textures: {len(paths)} 2k files + {len(hi)} hi-res "
          f"({hi_mb:.1f} MB): "
          + ", ".join(f"{k}@{v['px']}" for k, v in hi.items()), flush=True)
    return responses, paths, hi


def _build_nomenclature(refresh: bool, out_dir: Path
                        ) -> tuple[list[CachedResponse], dict[str, int]]:
    """IAU Gazetteer named features (USGS, public domain), most prominent
    first, capped per body — for the deep-zoom globes' labels."""
    import geopandas as gpd

    out_dir.mkdir(parents=True, exist_ok=True)
    responses: list[CachedResponse] = []
    counts: dict[str, int] = {}
    for target in config.GAZETTEER_BODIES:
        response = fetch(
            config.GAZETTEER_URL.format(target=target),
            refresh=refresh, subdir="space",
            filename=f"gazetteer-{target.lower()}.zip",
        )
        responses.append(response)
        frame = gpd.read_file(response.path)
        cols = {c.lower(): c for c in frame.columns}
        name_col = cols.get("name") or cols.get("clean_name")
        diam_col = cols.get("diameter")
        type_col = cols.get("type") or cols.get("code")
        if not name_col or not diam_col:
            raise FetchError(
                f"gazetteer {target}: expected name/diameter columns, got "
                f"{sorted(frame.columns)[:15]}"
            )
        frame = frame.sort_values(diam_col, ascending=False)
        # Round 3 §45.4: the well-known features ride at the head of the
        # list (labelled at every zoom level), then the largest by
        # diameter — all from the same gazetteer rows.
        featured_names = list(config.GAZETTEER_FEATURED.get(target, ()))
        featured = frame[frame[name_col].isin(featured_names)]
        missing_featured = sorted(
            set(featured_names) - set(featured[name_col].astype(str)))
        if missing_featured:
            raise FetchError(
                f"gazetteer {target}: featured names not found: "
                + ", ".join(missing_featured)
            )
        featured = featured.set_index(name_col).loc[featured_names].reset_index()
        rest = frame[~frame[name_col].isin(featured_names)].head(
            config.GAZETTEER_TOP_FEATURES - len(featured),
        )
        import pandas as pd
        frame = pd.concat([featured, rest], ignore_index=True)
        featured_set = set(featured_names)
        # Round-2 feedback: the labels should open a card saying what the
        # feature is, when it was named and after what — the gazetteer
        # carries origin text, approval date, the name's cultural origin
        # and the USGS feature page, so ship them.
        origin_col = cols.get("origin")
        approval_col = cols.get("approvaldt")
        ethnicity_col = cols.get("ethnicity")
        link_col = cols.get("link")

        def _clean(value: Any) -> str | None:
            text = str(value or "").strip().strip('"').strip()
            return text or None

        features = []
        for _, row in frame.iterrows():
            geometry = row.geometry
            if geometry is None:
                continue
            approved = _clean(row[approval_col]) if approval_col else None
            features.append({
                "name": str(row[name_col]),
                "lat": round(float(geometry.y), 3),
                "lon": round(float(geometry.x), 3),
                "dKm": round(float(row[diam_col]), 1),
                "type": str(row[type_col]) if type_col else None,
                "origin": _clean(row[origin_col]) if origin_col else None,
                "approved": approved[:4] if approved else None,
                "culture": (_clean(row[ethnicity_col])
                            if ethnicity_col else None),
                "link": _clean(row[link_col]) if link_col else None,
                "featured": str(row[name_col]) in featured_set,
            })
        (out_dir / f"{target.lower()}.json").write_text(
            json.dumps({"target": target.lower(), "features": features},
                       separators=(",", ":"), ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )
        counts[target.lower()] = len(features)
    print(f"    nomenclature: {counts}", flush=True)
    return responses, counts


# Cosmic Phenomena builders moved to etl/sources/phenomena.py (round 3, §46).

# --------------------------------------------------------------------------

def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry
    out_dir = config.DATA_DIR / "space"
    moons_dir = out_dir / "moons"
    out_dir.mkdir(parents=True, exist_ok=True)
    moons_dir.mkdir(parents=True, exist_ok=True)

    moons, sat_responses = _load_moons(refresh)
    counts = {planet: len(listing) for planet, listing in moons.items()}
    print(f"    moons: {sum(counts.values())} across {len(counts)} planets "
          f"({counts})", flush=True)
    if counts.get("saturn", 0) < 100 or counts.get("jupiter", 0) < 70:
        raise FetchError(
            f"JPL satellite catalogue looks truncated: {counts}. "
            f"Refusing to publish partial moon counts."
        )

    fact_responses: list[CachedResponse] = []
    bodies: list[dict[str, Any]] = []

    def links_for(body_id: str) -> dict[str, str]:
        title = WIKIPEDIA[body_id]
        return {
            "wikipedia": "https://en.wikipedia.org/wiki/"
            + urllib.parse.quote(title.replace(" ", "_")),
        }

    portraits_used = 0

    def portrait_for(body_id: str) -> dict[str, Any] | None:
        nonlocal portraits_used
        portrait, response = _nasa_portrait(body_id, refresh=refresh)
        fact_responses.append(response)
        if portrait:
            portraits_used += 1
        return portrait

    # ---- Sun -------------------------------------------------------------
    sun_ts = config.NSSDC_SNAPSHOTS.get("sun")
    sun_facts: dict[str, Any] = {}
    if sun_ts:
        response = fetch(
            config.NSSDC_FACT_URL.format(timestamp=sun_ts, page="sun"),
            refresh=refresh, subdir="space", filename="fact-sun.html",
        )
        fact_responses.append(response)
        sun_sheet = FactSheet(
            "sun", response.read_bytes().decode("utf-8", errors="replace"))
        sun_facts = {
            "massKg": sun_sheet.mass_kg(),
            "equatorialRadiusKm": sun_sheet.number(
                ["Volumetric mean radius (km)"]),
            "densityKgM3": sun_sheet.number(["Mean density (kg/m 3 )"]),
            "gravityMS2": sun_sheet.number(
                ["Surface gravity (eq.) (m/s 2 )", "Surface gravity (m/s 2 )"]),
            "escapeKmS": sun_sheet.number(["Escape velocity (km/s)"]),
            "rotationPeriodHours": sun_sheet.number(
                ["Sidereal rotation period (hrs)"]),
            "meanTempK": sun_sheet.number(
                ["Effective temperature (K)"], optional=True),
        }
    bodies.append({
        "id": "sun", "name": "Sun", "kind": "star", "primary": None,
        "facts": sun_facts,
        "moonCount": None,
        "source": "NSSDC Sun Fact Sheet (archived)" if sun_ts else None,
        "vintage": sun_ts[:8] if sun_ts else None,
        "links": links_for("sun"),
        "image": portrait_for("sun"),
    })

    # ---- planets + Pluto + the Moon --------------------------------------
    check_log: list[dict[str, Any]] = []
    for page in [*PLANETS, "pluto", "moon"]:
        timestamp = config.NSSDC_SNAPSHOTS[page]
        response = fetch(
            config.NSSDC_FACT_URL.format(timestamp=timestamp, page=page),
            refresh=refresh, subdir="space", filename=f"fact-{page}.html",
        )
        fact_responses.append(response)
        sheet = FactSheet(
            page, response.read_bytes().decode("utf-8", errors="replace"))
        facts = _parse_fact_sheet(page, sheet)
        # The archive is trusted only as far as live NASA agrees with it
        # (maintainer-requested): every planet's mass, volumetric radius
        # and density must match JPL Horizons within tolerance or the run
        # aborts. The Moon has no Horizons check here (its Horizons block
        # uses Earth-relative conventions); its sheet is cross-lit by the
        # JPL satellite table instead.
        if page in HORIZONS_IDS:
            fact_responses.append(
                _cross_check(page, facts, sheet, refresh=refresh,
                             log=check_log))
        body: dict[str, Any] = {
            "id": page,
            "name": page.capitalize(),
            "kind": "moon" if page == "moon"
            else "dwarf" if page == "pluto" else "planet",
            "primary": "earth" if page == "moon" else "sun",
            "facts": facts,
            "moonCount": 1 if page == "earth"
            else counts.get(page, 0) if page != "moon" else None,
            "source": "NSSDC Planetary Fact Sheet (archived)",
            "vintage": timestamp[:8],
            "links": links_for(page),
            "image": portrait_for(page),
        }
        if page in DISCOVERY:
            body["discovery"] = DISCOVERY[page]
        bodies.append(body)

    # ---- dwarf planets via SBDB ------------------------------------------
    for name in DWARF_SBDB:
        body_id = name.lower()
        facts, response = _sbdb_body(name, refresh=refresh)
        fact_responses.append(response)
        vintage = facts.pop("_vintage", None)
        bodies.append({
            "id": body_id, "name": name, "kind": "dwarf", "primary": "sun",
            "facts": facts,
            "moonCount": counts.get(body_id, 0),
            "source": "JPL Small-Body Database",
            "vintage": vintage,
            "links": links_for(body_id),
            "image": portrait_for(body_id),
        })

    # ---- round-2 §41: textures, notes, trek layers, gazetteer, phenomena -
    texture_responses, texture_paths, texture_hi = _build_textures(
        refresh, out_dir / "textures",
    )
    notes_ref = json.loads(
        (config.REFERENCE_DIR / "space_body_notes.json").read_text("utf-8")
    )["bodies"]
    missing_notes = sorted(
        {body["id"] for body in bodies} - set(notes_ref)
    )
    if missing_notes:
        raise FetchError(
            "space_body_notes.json is missing bodies: "
            + ", ".join(missing_notes)
        )
    trek_names = {"moon": "Moon", "mars": "Mars", "venus": "Venus",
                  "mercury": "Mercury"}
    for body in bodies:
        body["texture"] = texture_paths.get(body["id"])
        # Round 3 §45: the hi-res variant with its real width, so the app
        # and the credit line never call a 4096 file "8k".
        hi_record = texture_hi.get(body["id"])
        body["textureHi"] = hi_record["path"] if hi_record else None
        body["textureHiPx"] = hi_record["px"] if hi_record else None
        body["notes"] = notes_ref[body["id"]]
        trek = config.TREK_LAYERS.get(body["id"])
        if trek:
            body["trek"] = {
                "urlTemplate": config.TREK_TILE_URL.format(
                    body=trek_names[body["id"]], layer=trek["layer"],
                ),
                "ext": trek["ext"],
                "credit": trek["credit"],
                # Display exposure gain (§45.5) — a stated camera-exposure
                # choice, printed in the on-screen credit.
                "exposure": config.TREK_EXPOSURE.get(body["id"], 1.0),
            }
    gaz_responses, gaz_counts = _build_nomenclature(
        refresh, out_dir / "nomenclature",
    )
    # Cosmic Phenomena moved to its own stage in round 3 (§46):
    # etl/sources/phenomena.py owns data/space/phenomena*.
    fact_responses.extend(texture_responses)

    # ---- regions ---------------------------------------------------------
    regions = [
        {
            "id": "asteroid-belt", "name": "Asteroid belt",
            "innerAu": 2.1, "outerAu": 3.3,
            "note": "Millions of rocky bodies between Mars and Jupiter; "
                    "Ceres, inside it, is the only dwarf planet of the "
                    "inner Solar System.",
            "wikipedia": "https://en.wikipedia.org/wiki/Asteroid_belt",
        },
        {
            "id": "kuiper-belt", "name": "Kuiper belt",
            "innerAu": 30.0, "outerAu": 50.0,
            "note": "Icy bodies beyond Neptune, including Pluto, Haumea and "
                    "Makemake; Eris orbits mostly beyond it, in the "
                    "scattered disc.",
            "wikipedia": "https://en.wikipedia.org/wiki/Kuiper_belt",
        },
    ]

    document = {
        "bodies": bodies,
        "regions": regions,
        "moonCatalog": {
            "source": "JPL Solar System Dynamics: planetary satellite "
                      "elements, physical parameters, discovery",
            "counts": counts,
        },
        "notes": {
            "factSheets": (
                "NSSDC fact sheets are read from pinned Internet Archive "
                "snapshots because nssdc.gsfc.nasa.gov currently redirects "
                "to a landing page; each body's vintage is its snapshot "
                "date. See DATA_DECISIONS.md §33."
            ),
            "nulls": "A null figure means the source does not publish it.",
        },
    }
    (out_dir / "bodies.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    for planet, listing in moons.items():
        (moons_dir / f"{planet}.json").write_text(
            json.dumps({"planet": planet, "moons": listing},
                       separators=(",", ":"), ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )

    log_dir = config.REPO_ROOT / "etl" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / "space.log").write_text(
        json.dumps({
            "moon_counts": counts,
            "portraits": {
                b["id"]: (b.get("image") or {}).get("nasaId") for b in bodies
            },
            "horizons_cross_check": check_log,
        }, indent=2) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "nssdc_factsheets",
        title="NSSDC Planetary Fact Sheets (pinned Internet Archive snapshots)",
        url="https://nssdc.gsfc.nasa.gov/planetary/factsheet/",
        licence="Public domain (NASA)",
        fetched_at=max(r.fetched_at for r in fact_responses),
        upstream_release=None,
        vintage="2025 snapshots (see per-body vintage)",
        citation="NASA NSSDCA Planetary Fact Sheets (D.R. Williams), via the "
                 "Internet Archive",
        notes=(
            "nssdc.gsfc.nasa.gov 307-redirects to a nasa.gov landing page "
            "(checked 2026-09-05); sheets are read from pinned snapshots "
            "whose dates ride with each body. Every planet's mass, "
            "volumetric radius and density are cross-checked against live "
            "JPL Horizons within tolerance on every run — the archive is "
            "trusted only as far as live NASA agrees with it. Swap back if "
            "NSSDC returns."
        ),
    )
    manifest_mod.record_source(
        manifest,
        "jpl_horizons",
        title="JPL Horizons (live cross-check of archived fact sheets)",
        url=config.JPL_HORIZONS_API,
        licence="Public domain (NASA/JPL)",
        fetched_at=max(r.fetched_at for r in fact_responses),
        upstream_release=None,
        vintage=None,
        citation="NASA/JPL Horizons System, physical-properties blocks",
        notes=(
            f"{len(check_log)} field comparisons for the nine "
            f"Horizons-checked bodies; any disagreement beyond tolerance "
            f"aborts the run. Full comparison table in etl/logs/space.log."
        ),
    )
    manifest_mod.record_source(
        manifest,
        "jpl_ssd",
        title="JPL Solar System Dynamics: satellites and small bodies",
        url="https://ssd.jpl.nasa.gov",
        licence="Public domain (NASA/JPL)",
        fetched_at=max(r.fetched_at for r in sat_responses),
        upstream_release=None,
        vintage=None,
        citation="NASA/JPL Solar System Dynamics: planetary satellite tables "
                 "and the Small-Body Database",
        notes=(
            f"{sum(counts.values())} satellites across {len(counts)} "
            f"planets; physical parameters where measured; discovery "
            f"circumstances; dwarf planets via SBDB with nulls where SBDB "
            f"publishes no value. {portraits_used} NASA-library portraits."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "space/bodies.json",
        description="Sun, planets, Earth's Moon, dwarf planets, and belt "
                    "regions with sourced figures.",
        sources=["nssdc_factsheets", "jpl_ssd"], row_count=len(bodies),
    )
    manifest_mod.record_artifact(
        manifest, "space/moons/",
        description="Full per-planet natural satellite catalogues.",
        sources=["jpl_ssd"], row_count=sum(counts.values()),
    )
    manifest_mod.record_source(
        manifest,
        "solarsystemscope_textures",
        title="Solar System Scope planetary textures",
        url="https://www.solarsystemscope.com/textures/",
        licence="CC BY 4.0",
        fetched_at=max(r.fetched_at for r in texture_responses),
        upstream_release=None,
        vintage=None,
        citation="Solar System Scope textures (CC BY 4.0), based on NASA "
                 "imagery and elevation data",
        notes="2k files copied byte-for-byte; hi-res variants copied "
              "byte-for-byte at or under their configured width, else "
              "Lanczos-downsampled and re-encoded (progressive JPEG q"
              f"{config.SOLARSYSTEMSCOPE_HI_JPEG_QUALITY}): "
              + "; ".join(
                  f"{k} {v['px']}px"
                  + (f" from {v['derivedFrom']}" if v["derivedFrom"] else "")
                  for k, v in texture_hi.items())
              + ". Ceres uses the pack's clearly-labelled 'fictional' "
              "texture; the icy dwarf planets get untextured materials "
              "rather than invented surfaces.",
    )
    manifest_mod.record_source(
        manifest,
        "iau_gazetteer",
        title="IAU Gazetteer of Planetary Nomenclature (USGS)",
        url="https://planetarynames.wr.usgs.gov/",
        licence="Public domain (USGS/IAU)",
        fetched_at=max(r.fetched_at for r in gaz_responses),
        upstream_release=None,
        vintage=None,
        citation="Gazetteer of Planetary Nomenclature, IAU Working Group "
                 "for Planetary System Nomenclature (USGS Astrogeology)",
        notes=f"Top named features by diameter per body: {gaz_counts}. "
              f"NASA Solar System Treks tiles for the deep-zoom globes are "
              f"STREAMED at runtime (documented exception, §41.2) — a "
              f"global tile pyramid cannot be committed to a static repo.",
    )
    manifest_mod.record_artifact(
        manifest, "space/textures/",
        description="Planetary textures for the 3D scene (CC BY 4.0).",
        sources=["solarsystemscope_textures"],
    )
    manifest_mod.record_artifact(
        manifest, "space/nomenclature/",
        description="Named surface features for the deep-zoom globes.",
        sources=["iau_gazetteer"],
    )
    print(f"    bodies: {len(bodies)}; portraits: {portraits_used}",
          flush=True)


__all__ = ["ingest"]
