"""Heads of state and government, with portraits, from Wikidata/Commons.

See the rationale note in etl/config.py. The doctrine points enforced here:

- A portrait is committed only when the country has EXACTLY ONE truthy
  holder of the role. A single face for a collective head of state would be
  confidently wrong, which is worse than absent.
- The Factbook prose remains the authoritative office-holder text on the
  page; the Wikidata name rides with the photo as its caption, so a
  disagreement between the two sources is visible rather than papered over.
- Every image records its Commons file page so the app can link attribution.
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
from typing import Any

# Operational escape hatch: with LEADERS_CACHED_ONLY=1 the stage builds
# leaders.json from already-cached portraits and skips every uncached
# download. Used to finalise a run when Commons rate limiting stretches the
# tail of ~400 downloads beyond patience; the monthly refresh runs WITHOUT
# it, so missing portraits are retried automatically each month.
_CACHED_ONLY = os.environ.get("LEADERS_CACHED_ONLY") == "1"

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch

_ROLES = ("hos", "hog")


def _commons_name(image_url: str) -> str | None:
    """`.../Special:FilePath/Foo%20Bar.jpg` -> `Foo Bar.jpg`."""
    marker = "Special:FilePath/"
    index = image_url.find(marker)
    if index == -1:
        return None
    return urllib.parse.unquote(image_url[index + len(marker):])


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    response = fetch(
        f"{config.WIKIDATA_SPARQL}?format=json&query="
        + urllib.parse.quote(config.WIKIDATA_LEADERS_QUERY),
        refresh=refresh,
        subdir="leaders",
        filename="wikidata-leaders.json",
        expect_json=True,
    )
    payload = response.read_json()
    bindings = payload.get("results", {}).get("bindings", [])
    if len(bindings) < 150:
        raise FetchError(
            f"Wikidata leaders query returned only {len(bindings)} rows; "
            f"expected several hundred. Refusing to publish a partial list."
        )

    # iso3 -> role -> {qid: {name, image}}
    collected: dict[str, dict[str, dict[str, dict[str, str | None]]]] = {}
    for row in bindings:
        iso3 = (row.get("iso3", {}).get("value") or "").upper()
        role = row.get("role", {}).get("value")
        qid = row.get("person", {}).get("value")
        if iso3 not in registry or role not in _ROLES or not qid:
            continue
        person = collected.setdefault(iso3, {}).setdefault(role, {}).setdefault(
            qid, {"name": None, "image": None},
        )
        label = row.get("personLabel", {}).get("value")
        if label and not label.startswith("Q"):
            person["name"] = label
        image = row.get("image", {}).get("value")
        # A person can carry several P18 images; the first is kept.
        if image and not person["image"]:
            person["image"] = image

    out_dir = config.DATA_DIR / "leaders"
    img_dir = out_dir / "img"
    img_dir.mkdir(parents=True, exist_ok=True)

    image_responses: list[CachedResponse] = []
    document: dict[str, Any] = {}
    photos = 0
    plural: list[str] = []
    for iso3 in sorted(collected):
        entry: dict[str, Any] = {}
        for role in _ROLES:
            people = collected[iso3].get(role, {})
            if not people:
                continue
            if len(people) > 1:
                # Collective or contested office: name count, ship no photo.
                plural.append(f"{iso3}:{role}({len(people)})")
                entry[role] = {
                    "name": None,
                    "holders": len(people),
                    "image": None,
                    "commonsPage": None,
                }
                continue
            person = next(iter(people.values()))
            record: dict[str, Any] = {
                "name": person["name"],
                "holders": 1,
                "image": None,
                "commonsPage": None,
            }
            if person["image"]:
                name = _commons_name(person["image"])
                is_cached = (
                    config.CACHE_DIR / "leaders" / "img" / f"{iso3}-{role}.jpg"
                ).exists()
                if name and _CACHED_ONLY and not is_cached:
                    name = None  # skip the download; retried next refresh
                if name:
                    # Commons throttles rapid sequential thumbnailing; ~400
                    # back-to-back requests outlasted the fetch retries and
                    # silently dropped half the portraits. A small pause per
                    # UNCACHED download keeps the run polite and complete.
                    if not is_cached:
                        time.sleep(0.5)
                    try:
                        image_response = fetch(
                            "https://commons.wikimedia.org/wiki/"
                            "Special:FilePath/"
                            + urllib.parse.quote(name)
                            + f"?width={config.LEADER_IMAGE_WIDTH}",
                            refresh=refresh,
                            subdir="leaders/img",
                            filename=f"{iso3}-{role}.jpg",
                        )
                    except FetchError:
                        # A single missing portrait must not sink the run;
                        # the entry ships without a photo.
                        image_response = None
                    if image_response is not None:
                        image_responses.append(image_response)
                        (img_dir / f"{iso3}-{role}.jpg").write_bytes(
                            image_response.read_bytes()
                        )
                        record["image"] = f"leaders/img/{iso3}-{role}.jpg"
                        record["commonsPage"] = (
                            "https://commons.wikimedia.org/wiki/File:"
                            + name.replace(" ", "_")
                        )
                        photos += 1
            entry[role] = record
        if entry:
            document[iso3] = entry

    (out_dir / "leaders.json").write_text(
        json.dumps(
            {
                "note": (
                    "Current heads of state (hos) and government (hog) per "
                    "Wikidata's truthy P35/P6 statements. Countries with a "
                    "collective office carry a holder count and no portrait. "
                    "Portraits are Wikimedia Commons thumbnails; commonsPage "
                    "links the file page for author and licence."
                ),
                "source": "wikidata_leaders",
                "imageWidth": config.LEADER_IMAGE_WIDTH,
                "entities": document,
            },
            indent=2, ensure_ascii=False,
        ) + "\n",
        encoding="utf-8", newline="\n",
    )

    manifest_mod.record_source(
        manifest,
        "wikidata_leaders",
        title="Wikidata heads of state and government, portraits via Wikimedia Commons",
        url=config.WIKIDATA_SPARQL,
        licence=(
            "Wikidata: CC0. Portraits: individual Commons licences, "
            "attributed via the linked file page."
        ),
        fetched_at=response.fetched_at,
        upstream_release=response.upstream_release,
        vintage="current incumbents at fetch time",
        citation="Wikidata (P35/P6/P18); Wikimedia Commons",
        files=[{
            "url": response.url, "sha256": response.sha256,
            "size_bytes": response.size_bytes, "fetched_at": response.fetched_at,
        }],
        notes=(
            f"{len(document)} entities, {photos} portraits. Collective "
            f"offices without a single incumbent ship no portrait: "
            f"{', '.join(plural[:12])}{'…' if len(plural) > 12 else ''}."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "leaders/leaders.json",
        description=(
            "Heads of state and government with portrait paths and Commons "
            "attribution links."
        ),
        sources=["wikidata_leaders"],
        entity_count=len(document),
    )

    print(f"    {len(document)} entities, {photos} portraits, "
          f"{len(plural)} collective offices without one")


__all__ = ["ingest"]
