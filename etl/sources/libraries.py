"""Public library counts from IFLA's Library Map of the World (added 2026-08-30).

The maintainer asked for the public library figure back, done properly.
The Wikidata item count that shipped before (Russia: 9) measured
cataloguing, not libraries. IFLA's Library Map of the World is the
international federation's own compilation: national library
associations and statistics offices report the number of PUBLIC library
service points per country, each with a year and a data-collection
method (official statistics, census survey, administrative data, sample
survey...). The map's data file is a static JSON the site's own map
loads; it is fetched here with a browser user agent, as the site fronts
itself with Cloudflare.

Ruling: ship the latest reported value per country with its year and
method; never interpolate or mix years. Countries IFLA has no report for
render as explicitly unavailable.
"""

from __future__ import annotations

import json
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import FetchError, fetch_via_curl
from ..validate import Plausibility


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "education"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Cloudflare in front of librarymap.ifla.org rejects Python's TLS
    # fingerprint outright (403 with any headers) but serves curl with a
    # browser user agent, hence the curl path.
    response = fetch_via_curl(
        config.IFLA_MAP_DATA_URL,
        refresh=refresh, subdir="libraries", filename="ifla-map-data.json",
        user_agent=config.WHC_BROWSER_UA,
    )
    payload = response.read_json()
    countries = {c["id"]: c for c in payload.get("countries", [])}
    sources = {int(k): v.get("name") for k, v in (payload.get("sources") or {}).items()}
    public_type = next(
        (t["id"] for t in payload.get("libraryTypes", []) if str(t.get("name", "")).lower().startswith("public")),
        None,
    )
    metric = next(
        (m["id"] for m in payload.get("metrics", []) if m.get("slug") == "libraries-service-points"),
        None,
    )
    if public_type is None or metric is None:
        raise FetchError(
            "IFLA map data no longer carries a 'Public' library type or the "
            "'libraries-service-points' metric; the file's shape changed."
        )

    plausibility = Plausibility("libraries", registry)
    best: dict[str, dict[str, Any]] = {}
    for value in payload.get("values", []):
        if value.get("library_type_id") != public_type or value.get("metric_id") != metric:
            continue
        country = countries.get(value.get("country_id"))
        if not country:
            continue
        iso3 = (country.get("ISO") or "").upper()
        if iso3 not in registry or value.get("val") is None:
            continue
        year = value.get("year")
        if iso3 in best and (year or 0) <= best[iso3]["year"]:
            continue
        best[iso3] = {
            "publicLibraries": int(value["val"]),
            "year": year,
            "method": sources.get(value.get("source_id")),
        }
    for iso3 in [k for k, v in best.items()
                 if not plausibility.check(k, "libraries.public", v["publicLibraries"],
                                           year=v["year"], label="Public libraries")]:
        del best[iso3]
    if len(best) < 80:
        raise FetchError(
            f"IFLA map data resolved to only {len(best)} countries; expected 130+."
        )

    document = {
        "source": "ifla_library_map",
        "note": (
            "Number of public library service points per country as reported "
            "to IFLA's Library Map of the World by national library "
            "associations and statistics offices. Each figure carries its own "
            "report year and collection method; years differ by country and "
            "are never mixed."
        ),
        "entities": dict(sorted(best.items())),
    }
    (out_dir / "libraries.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    plausibility.flush(manifest)

    years = sorted({v["year"] for v in best.values() if v["year"]})
    manifest_mod.record_source(
        manifest,
        "ifla_library_map",
        title="IFLA Library Map of the World",
        url="https://librarymap.ifla.org/",
        licence="© IFLA; data contributed by national library associations, reused with attribution",
        fetched_at=response.fetched_at,
        upstream_release=response.upstream_release,
        vintage=f"per country, report years {years[0]}–{years[-1]}" if years else "per country",
        citation="IFLA Library Map of the World (librarymap.ifla.org)",
        notes=(
            f"{len(best)} countries with a public-library service-point count. "
            f"Replaces the Wikidata item count dropped 2026-08-29."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "education/libraries.json",
        description="Public library service points per entity with report year and collection method (IFLA).",
        sources=["ifla_library_map"], entity_count=len(best),
    )
    print(f"    libraries: {len(best)} countries from IFLA")


__all__ = ["ingest"]
