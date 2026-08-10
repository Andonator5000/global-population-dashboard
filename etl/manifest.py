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


# Artifact types hashed as TEXT (line endings normalised). Anything else is
# hashed byte-for-byte, so a future .parquet or image is never corrupted by
# newline substitution.
_TEXT_SUFFIXES = frozenset({".json", ".csv", ".md", ".txt", ".geojson"})


def content_fingerprint() -> str:
    """SHA-256 over every artifact in /data EXCEPT the manifest itself.

    This exists to solve a specific operational problem. The manifest embeds
    `generated_at` and a `fetched_at` per source, so it changes on every run
    even when nothing upstream moved. A monthly job that diffs /data would
    therefore open a pull request every single month containing nothing but new
    timestamps, and a real data change would be indistinguishable from that
    noise.

    TWO THINGS MAKE IT PORTABLE, AND BOTH ARE LOAD-BEARING
    ------------------------------------------------------
    The first version was not portable at all, and CI caught it on the very
    first push to GitHub. Two independent causes:

    1. **Line endings.** Python's text-mode write turns "\\n" into "\\r\\n" on
       Windows, while .gitattributes stores LF and the Linux runner checks LF
       out. Hashing raw bytes measured the newline convention as well as the
       content. Text suffixes are therefore normalised to LF before hashing;
       everything else is hashed byte-for-byte so a future .parquet is never
       corrupted.

    2. **Sort order.** This one was subtler and was the actual blocker.
       `sorted()` on `Path` objects compares via `_str_normcase`, which is
       CASE-FOLDED on Windows and case-SENSITIVE on POSIX. Our tree mixes
       lowercase names with UPPERCASE ISO3 filenames, so the orders genuinely
       diverge -- `factbook/coverage.json` sorts between COM and CPV on
       Windows, but after every uppercase file on Linux. **194 of 977
       positions differed.** Since the hash folds in each path followed by its
       content, a different order gives a different digest for identical data.

       Sorting by the POSIX-style relative path STRING fixes it: Python string
       comparison is case-sensitive by codepoint on every platform.

    The general lesson, recorded because it was learned the hard way: a value
    whose whole purpose is to be compared across machines must be verified
    across machines. Verifying it twice on one machine proves nothing.
    """
    digest = hashlib.sha256()
    entries = sorted(
        (
            (path.relative_to(config.DATA_DIR).as_posix(), path)
            for path in config.DATA_DIR.rglob("*")
            if path.is_file() and path != config.MANIFEST_PATH
        ),
        key=lambda item: item[0],
    )
    for relative, path in entries:
        digest.update(relative.encode("utf-8"))
        raw = path.read_bytes()
        if path.suffix.lower() in _TEXT_SUFFIXES:
            raw = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        digest.update(raw)
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
        encoding="utf-8", newline="\n",
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
