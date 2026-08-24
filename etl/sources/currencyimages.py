"""Representative currency images from Wikidata and Wikimedia Commons.

country -> currency (P38) -> ISO 4217 code (P498) + image (P18), with
editorial overrides per code in reference/currency_image_overrides.json.

WHAT THIS CAN AND CANNOT PROMISE
--------------------------------
The request was "the smallest banknote per country, high resolution". No
structured source orders denominations, banknote copyright varies by
jurisdiction (many modern notes cannot be on Commons at all), and P18 for a
currency is whatever a Wikidata editor chose -- sometimes a coin or a
historical note. So the artifact ships a REPRESENTATIVE image per currency,
captioned as such, with the override file as the curation lever for codes
where the default is poor. Images are hotlinked via Special:FilePath at a
Commons-bucketed width (arbitrary widths answer HTTP 400 since 2026); the
per-file licence and author come from the Commons API because CC licences
make attribution a reuse condition, not a courtesy.
"""

from __future__ import annotations

import json
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import fetch
from . import commons

_OVERRIDES_PATH = config.REFERENCE_DIR / "currency_image_overrides.json"


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "economy"
    out_dir.mkdir(parents=True, exist_ok=True)

    response = fetch(
        f"{config.WIKIDATA_SPARQL}?format=json&query="
        + urllib.parse.quote(config.WIKIDATA_CURRENCY_IMAGES_QUERY),
        refresh=refresh,
        subdir="currency-images",
        filename="wikidata-currencies.json",
        expect_json=True,
    )
    overrides: dict[str, str] = {
        code: filename
        for code, filename in json.loads(
            _OVERRIDES_PATH.read_text("utf-8")
        ).items()
        if not code.startswith("_")
    }

    # code -> {name, file}. First P18 wins; overrides replace afterwards.
    by_code: dict[str, dict[str, str | None]] = {}
    for row in response.read_json()["results"]["bindings"]:
        iso3 = (row.get("iso3", {}).get("value") or "").upper()
        code = (row.get("code", {}).get("value") or "").upper()
        if iso3 not in registry or len(code) != 3:
            continue
        image = row.get("image", {}).get("value")
        filename = commons.filename_from_special_path(image) if image else None
        existing = by_code.get(code)
        if existing is None or (existing["file"] is None and filename):
            by_code[code] = {
                "name": row.get("currencyLabel", {}).get("value") or code,
                "file": filename,
            }
    for code, filename in overrides.items():
        by_code.setdefault(code, {"name": code, "file": None})["file"] = filename

    with_files = sorted(
        {record["file"] for record in by_code.values() if record["file"]}
    )
    metadata, meta_responses = commons.fetch_metadata(
        with_files, refresh=refresh, subdir="currency-images",
    )

    currencies: dict[str, Any] = {}
    dropped: list[str] = []
    for code, record in sorted(by_code.items()):
        filename = record["file"]
        if not filename:
            continue
        if filename not in metadata:
            # The Commons file was renamed or deleted under Wikidata.
            dropped.append(code)
            continue
        currencies[code] = {
            "name": record["name"],
            "file": filename,
            "imageUrl": commons.image_url_for(filename),
            "commonsPage": commons.file_page_for(filename),
            "license": metadata[filename]["license"],
            "author": metadata[filename]["author"],
            "curated": code in overrides,
        }

    document = {
        "source": "wikidata_commons",
        "note": (
            "Representative image per ISO 4217 currency (Wikidata P18, plus "
            "editorial overrides). Not guaranteed to be the smallest or the "
            "current banknote series -- some currencies are represented by a "
            "coin or a historical note, and several countries' modern notes "
            "are copyrighted and absent from Commons entirely."
        ),
        "currencies": currencies,
    }
    (out_dir / "currency-images.json").write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "currency_images",
        title="Currency images (Wikidata P18 via Wikimedia Commons)",
        url=config.WIKIDATA_SPARQL,
        licence="Per-file Commons licences, recorded per image",
        fetched_at=max(
            r.fetched_at for r in [response, *meta_responses]
        ),
        upstream_release=None,
        vintage="as retrieved",
        citation="Wikidata; Wikimedia Commons (per-file attribution in artifact)",
        notes=(
            f"{len(currencies)} currencies with a usable image; "
            f"{len(dropped)} Wikidata-referenced files missing on Commons "
            f"were dropped. Hotlinked at width {config.COMMONS_IMAGE_WIDTH} "
            f"via Special:FilePath."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "economy/currency-images.json",
        description=(
            "Representative currency image per ISO 4217 code, with Commons "
            "file page, licence and author for attribution."
        ),
        sources=["currency_images"], row_count=len(currencies),
    )
    if dropped:
        manifest_mod.add_warning(
            manifest,
            f"Currency images referenced by Wikidata but missing on Commons: "
            f"{', '.join(dropped)}."
        )
    print(f"    currency images: {len(currencies)} currencies "
          f"({len(dropped)} dropped)")


__all__ = ["ingest"]
