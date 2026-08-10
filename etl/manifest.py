"""The data manifest: provenance for every artifact in /data.

The app's "data freshness" footer panel reads this file directly, and the
per-figure source attributions on the country pages resolve their vintage
through it. That makes the manifest load-bearing for an acceptance criterion
("every visible number traces to a named source and a year"), not just a build
log -- so it is written last, only after every source has succeeded.
"""

from __future__ import annotations

import hashlib
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
        "refresh_policy": (
            "Re-run monthly by .github/workflows/refresh-data.yml. A pull "
            "request is opened only when content_fingerprint changes; a run "
            "that finds nothing new leaves the committed data untouched, so "
            "fetched_at reflects when these bytes were retrieved rather than "
            "when they were last checked."
        ),
        "sources": {},
        "artifacts": {},
        "warnings": [],
        # Filled in by write(); hash of every artifact except this file.
        "content_fingerprint": None,
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


def content_fingerprint() -> str:
    """SHA-256 over every artifact in /data EXCEPT the manifest itself.

    This exists to solve a specific operational problem. The manifest embeds
    `generated_at` and a `fetched_at` per source, so it changes on every run
    even when nothing upstream moved. A monthly job that diffs /data would
    therefore open a pull request every single month containing nothing but new
    timestamps, and a real data change would be indistinguishable from that
    noise.
    """
    digest = hashlib.sha256()
    files = sorted(
        path
        for path in config.DATA_DIR.rglob("*")
        if path.is_file() and path != config.MANIFEST_PATH
    )
    for path in files:
        digest.update(path.relative_to(config.DATA_DIR).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def write(manifest: dict[str, Any]) -> None:
    """Write the manifest, stamping it with the content fingerprint.

    Called last, after every artifact is on disk, so the fingerprint covers the
    finished output.
    """
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    manifest["content_fingerprint"] = content_fingerprint()
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
