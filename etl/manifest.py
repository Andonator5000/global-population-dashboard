"""The data manifest: provenance for every artifact in /data.

The app's "data freshness" footer panel reads this file directly, and the
per-figure source attributions on the country pages resolve their vintage
through it. That makes the manifest load-bearing for an acceptance criterion
("every visible number traces to a named source and a year"), not just a build
log -- so it is written last, only after every source has succeeded.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from . import config

MANIFEST_VERSION = 1


def new_manifest() -> dict[str, Any]:
    return {
        "manifest_version": MANIFEST_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pipeline_version": "0.1.0",
        "editorial_decisions_doc": "DATA_DECISIONS.md",
        "sources": {},
        "artifacts": {},
        "warnings": [],
    }


def record_source(
    manifest: dict[str, Any],
    name: str,
    *,
    title: str,
    url: str,
    licence: str,
    fetched_at: str,
    upstream_release: str | None,
    vintage: str | None,
    citation: str,
    files: list[dict[str, Any]] | None = None,
    notes: str | None = None,
) -> None:
    """Record one upstream source.

    `vintage` is the year (or range) the OBSERVATIONS describe -- distinct from
    `fetched_at`, which is when we downloaded them, and from
    `upstream_release`, which is when the publisher cut the release. Conflating
    these three is the most common way a dashboard ends up claiming data is
    fresher than it is, so they are stored separately and rendered separately.
    """
    manifest["sources"][name] = {
        "title": title,
        "url": url,
        "licence": licence,
        "fetched_at": fetched_at,
        "upstream_release": upstream_release,
        "vintage": vintage,
        "citation": citation,
        "files": files or [],
        "notes": notes,
    }


def record_artifact(
    manifest: dict[str, Any],
    filename: str,
    *,
    description: str,
    sources: list[str],
    row_count: int | None = None,
    entity_count: int | None = None,
) -> None:
    manifest["artifacts"][filename] = {
        "description": description,
        "sources": sources,
        "row_count": row_count,
        "entity_count": entity_count,
    }


def add_warning(manifest: dict[str, Any], message: str) -> None:
    """Record a non-fatal data-quality issue.

    These surface in the app's freshness panel. A warning means "we shipped
    this, but you should know" -- anything that would make a figure wrong is an
    exception, not a warning.
    """
    manifest["warnings"].append(message)


def write(manifest: dict[str, Any]) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.MANIFEST_PATH.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=False) + "\n",
        encoding="utf-8",
    )


def read() -> dict[str, Any] | None:
    if not config.MANIFEST_PATH.exists():
        return None
    return json.loads(config.MANIFEST_PATH.read_text("utf-8"))


__all__ = [
    "MANIFEST_VERSION",
    "new_manifest",
    "record_source",
    "record_artifact",
    "add_warning",
    "write",
    "read",
]
