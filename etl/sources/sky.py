"""The night sky behind the 3-D globe: real stars, real constellation figures.

Round 13 (DATA_DECISIONS section 66). The globe's surround is black on every
view and palette direction; this stage gives that black a real sky to be.
Nothing here is decorative sampling -- every star is a catalogue entry at its
J2000 position, and every constellation line joins two real stars.

Outputs one artifact:

    data/geo/sky.json     stars (RA/Dec/V/B-V, proper names) + 88 constellation
                          figures (polylines through star positions, IAU name,
                          figure centroid) + a `sources` block

Sources and licences
--------------------
Stars
    Yale Bright Star Catalogue, 5th Revised Edition (Hoffleit & Warren 1991),
    the ADC/CDS catalogue V/50, served by the Harvard Telescope Data Center as
    a 197-byte fixed-record ASCII file. 9,110 records to V ~ 7.1, which is
    every star the unaided eye can see and then some. The catalogue is a NASA
    Astronomical Data Center product in the public domain; CDS distributes the
    same bytes. We read only the J2000 position (bytes 76-90), V magnitude
    (103-107) and B-V colour (110-114).

Proper names
    IAU Catalog of Star Names (IAU-CSN), the WGSN's own table -- the only
    authority for "Betelgeuse" rather than "alpha Orionis". IAU-produced
    products are released under Creative Commons Attribution, so the artifact
    carries the attribution. Joined to the BSC by the catalogue's own
    `HR nnnn` designation, falling back to the HD number.

Constellation figures
    d3-celestial's `constellations.lines.json` and `constellations.json`
    (Olaf Frohn, BSD-3-Clause), pinned to a commit. Deliberately NOT
    Stellarium's sky cultures, which are GPL and would infect the app.
    Serpens ships as two features with the same id; they are merged, which is
    how the count comes to the 88 IAU constellations.

Nothing is precessed here: positions stay J2000 mean places and the renderer
documents the ~0.3 deg it therefore owes the epoch of date (src/lib/sky.ts,
`skyCentreForGlobe`, which absorbs the mean term into sidereal time).
"""

from __future__ import annotations

import gzip
import json
import math
import re
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch

SUBDIR = "sky"

# The Harvard Telescope Data Center copy of ADC/CDS V/50. Same bytes as
# cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz, one fewer redirect.
BSC5_URL = "http://tdc-www.harvard.edu/catalogs/bsc5.dat.gz"
BSC5_PAGE = "http://tdc-www.harvard.edu/catalogs/bsc5.html"

IAU_CSN_URL = "https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt"

# Pinned commit, not `master`: a silent upstream edit to a constellation
# figure would otherwise change /data with no commit of ours to explain it.
D3_CELESTIAL_COMMIT = "b56735c22935b7bde41a944a74e0f780ca0c6dfa"
D3_CELESTIAL_RAW = (
    f"https://raw.githubusercontent.com/ofrohn/d3-celestial/"
    f"{D3_CELESTIAL_COMMIT}/data"
)
LINES_URL = f"{D3_CELESTIAL_RAW}/constellations.lines.json"
NAMES_URL = f"{D3_CELESTIAL_RAW}/constellations.json"

IAU_CONSTELLATION_COUNT = 88

# Rounding. 3 decimals of a degree is 3.6 arcsec; at the globe's ~5.5 px per
# degree that is a five-hundredth of a pixel, so the extra digit the brief
# allows would only buy bytes. Magnitudes and colours are published to 0.01.
COORD_DP = 3
MAG_DP = 2
BV_DP = 2

MAX_BYTES = 400_000


class SkyError(FetchError):
    """A catalogue that will not parse or will not join; aborts the stage."""


# --------------------------------------------------------------------------
# Bright Star Catalogue
# --------------------------------------------------------------------------

def _f(text: str) -> float | None:
    text = text.strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _parse_bsc5(raw: bytes) -> list[dict[str, Any]]:
    """Fixed-column BSC5 records -> J2000 degrees, V, B-V.

    Byte offsets are the ADC V/50 ReadMe's, 1-indexed there and converted
    here. The catalogue keeps a handful of records for objects that turned
    out to be novae or not to exist at all; those carry a blank position or a
    blank magnitude and are dropped rather than shipped as zeroes.
    """
    stars: list[dict[str, Any]] = []
    dropped = 0
    for line in raw.decode("latin-1").splitlines():
        if len(line) < 107:
            dropped += 1
            continue
        hr = _f(line[0:4])
        ra_h, ra_m, ra_s = _f(line[75:77]), _f(line[77:79]), _f(line[79:83])
        sign = line[83:84]
        de_d, de_m, de_s = _f(line[84:86]), _f(line[86:88]), _f(line[88:90])
        vmag = _f(line[102:107])
        if None in (ra_h, ra_m, ra_s, de_d, de_m, de_s) or vmag is None:
            dropped += 1
            continue
        assert ra_h is not None and ra_m is not None and ra_s is not None
        assert de_d is not None and de_m is not None and de_s is not None
        ra = (ra_h + ra_m / 60.0 + ra_s / 3600.0) * 15.0
        dec = de_d + de_m / 60.0 + de_s / 3600.0
        if sign == "-":
            dec = -dec
        if not (0.0 <= ra < 360.0) or not (-90.0 <= dec <= 90.0):
            dropped += 1
            continue
        hd = _f(line[25:31])
        stars.append({
            "hr": int(hr) if hr is not None else None,
            "hd": int(hd) if hd is not None else None,
            "ra": ra,
            "dec": dec,
            "mag": vmag,
            "bv": _f(line[109:114]),
        })
    if len(stars) < 9000:
        raise SkyError(
            f"BSC5 parsed to only {len(stars)} usable stars (dropped "
            f"{dropped}); the fixed-column layout has probably changed."
        )
    return stars


# --------------------------------------------------------------------------
# IAU proper names
# --------------------------------------------------------------------------

# Trailing fields of an IAU-CSN row: HIP, HD, RA, Dec, approval date. Anchored
# on the date so a missing identifier ("_") cannot shift the parse.
_CSN_TAIL = re.compile(
    r"(?P<hip>[\d_]+)\s+(?P<hd>[\d_]+)\s+"
    r"(?P<ra>[-\d.]+)\s+(?P<dec>[-+\d.]+)\s+"
    r"(?P<date>\d{4}-\d{2}-\d{2})"
)
_CSN_HR = re.compile(r"^HR\s+(\d+)$")


def _parse_iau_names(text: str) -> tuple[dict[int, str], dict[int, str]]:
    """-> ({HR: name}, {HD: name}) for the stars the WGSN has named."""
    by_hr: dict[int, str] = {}
    by_hd: dict[int, str] = {}
    for line in text.splitlines():
        if not line or line[0] in "#$":
            continue
        if len(line) < 80:
            continue
        name = line[0:18].strip()
        designation = line[36:49].strip()
        tail = _CSN_TAIL.search(line[60:])
        if not name or not tail:
            continue
        hr_match = _CSN_HR.match(designation)
        if hr_match:
            by_hr.setdefault(int(hr_match.group(1)), name)
        hd = tail.group("hd")
        if hd.isdigit():
            by_hd.setdefault(int(hd), name)
    if len(by_hr) < 200:
        raise SkyError(
            f"IAU-CSN yielded only {len(by_hr)} HR-designated names; the "
            f"table layout has probably changed."
        )
    return by_hr, by_hd


# --------------------------------------------------------------------------
# Constellation figures
# --------------------------------------------------------------------------

def _wrap_ra(value: float) -> float:
    """d3-celestial stores RA as GeoJSON longitude in [-180, 180)."""
    return value % 360.0


def _centroid(vertices: list[tuple[float, float]]) -> tuple[float, float]:
    """Spherical centroid: the mean of the unit vectors, re-normalised.

    Averaging degrees would put Pisces' label in the wrong hemisphere the
    moment a figure straddles RA 0h, and averaging declination alone would
    bias every circumpolar figure toward the equator.
    """
    x = y = z = 0.0
    for ra, dec in vertices:
        lam = math.radians(ra)
        phi = math.radians(dec)
        x += math.cos(phi) * math.cos(lam)
        y += math.cos(phi) * math.sin(lam)
        z += math.sin(phi)
    norm = math.sqrt(x * x + y * y + z * z)
    if norm < 1e-9:
        return vertices[0]
    x, y, z = x / norm, y / norm, z / norm
    return (math.degrees(math.atan2(y, x)) % 360.0, math.degrees(math.asin(z)))


def _build_constellations(
    lines_doc: dict[str, Any], names_doc: dict[str, Any]
) -> list[dict[str, Any]]:
    names: dict[str, dict[str, Any]] = {}
    for feature in names_doc.get("features", []):
        props = feature.get("properties") or {}
        cid = feature.get("id")
        if not cid or not props.get("name"):
            continue
        # Serpens appears twice under one id; the first row carries the name.
        names.setdefault(cid, props)

    figures: dict[str, dict[str, Any]] = {}
    for feature in lines_doc.get("features", []):
        cid = feature.get("id")
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "MultiLineString":
            raise SkyError(f"constellation {cid}: unexpected geometry "
                           f"{geometry.get('type')!r}")
        entry = figures.setdefault(cid, {"id": cid, "polylines": []})
        for polyline in geometry.get("coordinates", []):
            if len(polyline) < 2:
                continue
            entry["polylines"].append([
                (_wrap_ra(float(ra)), float(dec)) for ra, dec in polyline
            ])

    out: list[dict[str, Any]] = []
    for cid, entry in sorted(figures.items()):
        props = names.get(cid)
        if props is None:
            raise SkyError(f"constellation {cid} has lines but no name row")
        if not entry["polylines"]:
            raise SkyError(f"constellation {cid} has a name but no lines")
        vertices = [v for pl in entry["polylines"] for v in pl]
        centre_ra, centre_dec = _centroid(vertices)
        rank = props.get("rank")
        out.append({
            "id": cid,
            "name": props["name"],
            "genitive": props.get("gen") or None,
            # d3-celestial's rank 1/2/3 is naked-eye prominence. The renderer
            # uses it to decide which label survives an overlap.
            "rank": int(rank) if rank not in (None, "") else 3,
            "centre": [round(centre_ra, COORD_DP), round(centre_dec, COORD_DP)],
            "lines": [
                [round(c, COORD_DP) for v in pl for c in v]
                for pl in entry["polylines"]
            ],
        })
    if len(out) != IAU_CONSTELLATION_COUNT:
        raise SkyError(
            f"built {len(out)} constellation figures, expected "
            f"{IAU_CONSTELLATION_COUNT}"
        )
    return out


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

def build(refresh: bool, out_dir: Any) -> tuple[list[CachedResponse], dict[str, Any]]:
    responses: list[CachedResponse] = []

    bsc = fetch(BSC5_URL, refresh=refresh, subdir=SUBDIR,
                filename="bsc5.dat.gz")
    responses.append(bsc)
    stars = _parse_bsc5(gzip.decompress(bsc.read_bytes()))

    csn = fetch(IAU_CSN_URL, refresh=refresh, subdir=SUBDIR,
                filename="iau-csn.txt")
    responses.append(csn)
    names_by_hr, names_by_hd = _parse_iau_names(csn.read_text("utf-8"))

    lines_res = fetch(LINES_URL, refresh=refresh, subdir=SUBDIR,
                      filename="constellations.lines.json", expect_json=True)
    names_res = fetch(NAMES_URL, refresh=refresh, subdir=SUBDIR,
                      filename="constellations.json", expect_json=True)
    responses.extend([lines_res, names_res])
    constellations = _build_constellations(
        lines_res.read_json(), names_res.read_json()
    )

    # Brightest first. The renderer buckets by magnitude and can stop early on
    # a low-power device without losing the stars that carry the figures.
    stars.sort(key=lambda s: (s["mag"], s["ra"]))

    ra_list: list[float] = []
    dec_list: list[float] = []
    mag_list: list[float] = []
    bv_list: list[float | None] = []
    named: list[list[Any]] = []
    matched_hr = matched_hd = 0
    for index, star in enumerate(stars):
        ra_list.append(round(star["ra"], COORD_DP))
        dec_list.append(round(star["dec"], COORD_DP))
        mag_list.append(round(star["mag"], MAG_DP))
        bv_list.append(None if star["bv"] is None
                       else round(star["bv"], BV_DP))
        name = None
        if star["hr"] is not None and star["hr"] in names_by_hr:
            name = names_by_hr[star["hr"]]
            matched_hr += 1
        elif star["hd"] is not None and star["hd"] in names_by_hd:
            name = names_by_hd[star["hd"]]
            matched_hd += 1
        if name:
            named.append([index, name])

    payload = {
        "version": 1,
        "equinox": "J2000.0",
        "note": (
            "Mean places for equinox and epoch J2000.0. No precession, "
            "nutation, aberration or proper motion is applied; the renderer's "
            "skyCentreForGlobe() absorbs the mean precession in right "
            "ascension into sidereal time, leaving under 0.2 deg of residual "
            "for the current decade."
        ),
        "stars": {
            "count": len(stars),
            "order": "ascending visual magnitude (brightest first)",
            "magnitudeRange": [round(mag_list[0], MAG_DP),
                               round(mag_list[-1], MAG_DP)],
            "fields": {
                "ra": "right ascension, degrees, J2000",
                "dec": "declination, degrees, J2000",
                "mag": "visual magnitude V",
                "bv": "B-V colour index, null where the catalogue has none",
                "names": "[index, IAU proper name] for named stars only",
            },
            "ra": ra_list,
            "dec": dec_list,
            "mag": mag_list,
            "bv": bv_list,
            "names": named,
        },
        "constellations": constellations,
        "sources": {
            "stars": {
                "title": "Yale Bright Star Catalogue, 5th Revised Edition",
                "authors": "Hoffleit, D. & Warren, W. H. Jr. (1991)",
                "catalogue": "ADC/CDS V/50",
                "url": BSC5_PAGE,
                "file": BSC5_URL,
                "licence": "Public domain",
                "licenceUrl": "https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50",
                "citation": (
                    "Hoffleit D., Warren W.H. Jr. (1991) The Bright Star "
                    "Catalogue, 5th Revised Ed., ADC/CDS catalogue V/50"
                ),
            },
            "names": {
                "title": "IAU Catalog of Star Names (IAU-CSN)",
                "authors": "IAU Division C Working Group on Star Names",
                "url": "https://www.iau.org/public/themes/naming_stars/",
                "file": IAU_CSN_URL,
                "licence": "CC BY 4.0",
                "licenceUrl": "https://creativecommons.org/licenses/by/4.0/",
                "citation": (
                    "IAU Working Group on Star Names, IAU Catalog of Star "
                    "Names (IAU-CSN)"
                ),
            },
            "constellations": {
                "title": "d3-celestial constellation lines and names",
                "authors": "Olaf Frohn",
                "url": "https://github.com/ofrohn/d3-celestial",
                "file": LINES_URL,
                "commit": D3_CELESTIAL_COMMIT,
                "licence": "BSD-3-Clause",
                "licenceUrl": (
                    "https://github.com/ofrohn/d3-celestial/blob/master/LICENSE"
                ),
                "citation": (
                    "Copyright (c) 2015 Olaf Frohn, d3-celestial, BSD-3-Clause"
                ),
                "notes": (
                    "Stellarium's sky cultures were rejected: they are GPL "
                    "and this is a permissively licensed static site."
                ),
            },
        },
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "sky.json"
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    out_path.write_text(text, encoding="utf-8", newline="\n")
    size = len(text.encode("utf-8"))
    if size > MAX_BYTES:
        raise SkyError(
            f"data/geo/sky.json is {size} bytes, over the {MAX_BYTES} budget"
        )

    histogram: dict[str, int] = {}
    for mag in mag_list:
        bucket = f"{int(math.floor(mag)):+d}".replace("+-", "-")
        histogram[bucket] = histogram.get(bucket, 0) + 1
    summary = {
        "stars": len(stars),
        "stars_with_bv": sum(1 for b in bv_list if b is not None),
        "stars_named": len(named),
        "names_matched_by_hr": matched_hr,
        "names_matched_by_hd": matched_hd,
        "iau_names_in_catalogue": len(names_by_hr),
        "magnitude_range": [mag_list[0], mag_list[-1]],
        "magnitude_histogram": dict(sorted(histogram.items())),
        "constellations": len(constellations),
        "constellation_polylines": sum(len(c["lines"]) for c in constellations),
        "constellation_vertices": sum(
            len(pl) // 2 for c in constellations for pl in c["lines"]
        ),
        "bytes": size,
        "byte_budget": MAX_BYTES,
        "sources": {
            key: {"url": value["url"], "licence": value["licence"]}
            for key, value in payload["sources"].items()
        },
    }
    return responses, summary


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry
    out_dir = config.DATA_DIR / "geo"
    responses, summary = build(refresh, out_dir)

    log_dir = config.REPO_ROOT / "etl" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / "sky.log").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    fetched_at = max(r.fetched_at for r in responses)
    manifest_mod.record_source(
        manifest,
        "sky",
        title="Yale Bright Star Catalogue V/50 + IAU-CSN + d3-celestial",
        url=BSC5_PAGE,
        licence="BSC5 public domain; IAU-CSN CC BY 4.0; d3-celestial "
                "BSD-3-Clause (per-source detail in data/geo/sky.json)",
        fetched_at=fetched_at,
        upstream_release=(
            f"BSC5 5th revised ed. 1991; d3-celestial "
            f"{D3_CELESTIAL_COMMIT[:7]}"
        ),
        vintage="J2000.0 mean places",
        citation=(
            "Hoffleit D., Warren W.H. Jr. (1991) The Bright Star Catalogue, "
            "5th Revised Ed. (ADC/CDS V/50); IAU WGSN Catalog of Star Names; "
            "Olaf Frohn, d3-celestial (BSD-3-Clause)"
        ),
        notes=(
            f"{summary['stars']} stars to V {summary['magnitude_range'][1]} "
            f"with B-V colour for {summary['stars_with_bv']} and "
            f"{summary['stars_named']} IAU proper names; "
            f"{summary['constellations']} constellation figures in "
            f"{summary['constellation_polylines']} polylines. Drawn behind "
            f"the 3-D globe by src/lib/sky.ts. Stellarium's GPL sky cultures "
            f"were deliberately not used."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "geo/sky.json",
        description=(
            "The real night sky for the 3-D globe's black surround: J2000 "
            "star positions, magnitudes and B-V colours from the Bright Star "
            "Catalogue, IAU proper names, and the 88 IAU constellation "
            "figures as polylines through star positions."
        ),
        sources=["sky"], row_count=summary["stars"],
    )


__all__ = ["ingest", "build"]
