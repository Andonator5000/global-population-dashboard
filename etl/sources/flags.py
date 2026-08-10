"""Flag colour extraction and map palette, bridged from the ETL.

These two steps are Node scripts rather than Python, for a good reason: flag
sources are SVG, and rasterising SVG needs a real renderer. `sharp` (libvips
with librsvg) does it well and is already a project dependency; the Python
equivalents would mean shipping Cairo or an extra system library.

The bridge exists because of an acceptance criterion, not for tidiness:
`python etl/run.py --refresh` must reproduce /data from scratch with NO manual
steps. Leaving the palette to a separate `npm run` would have made that false,
and a fresh checkout would have built a map with no country colours.

Run directly if you prefer: `npm run flags && npm run palette`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity


class FlagStageError(RuntimeError):
    """Raised when the Node palette pipeline cannot run or fails."""


def _npm_command() -> list[str]:
    """Resolve npm across platforms.

    On Windows npm is a .cmd shim, which subprocess will not execute without
    the extension; shutil.which finds the right one.
    """
    for candidate in ("npm", "npm.cmd"):
        found = shutil.which(candidate)
        if found:
            return [found]
    raise FlagStageError(
        "npm is not on PATH, so the flag palette cannot be built. Install "
        "Node.js, or run the ETL with --skip-flags and build the palette "
        "separately with `npm run flags && npm run palette`."
    )


def _run(script: str) -> None:
    command = [*_npm_command(), "run", script]
    print(f"      $ npm run {script}", flush=True)
    result = subprocess.run(
        command,
        cwd=config.REPO_ROOT,
        capture_output=True,
        text=True,
        # npm on Windows inherits a shell env; without this the child can miss
        # the Node install that the parent shell resolved.
        env={**os.environ},
    )
    if result.returncode != 0:
        tail = "\n".join(
            (result.stdout or "").splitlines()[-15:]
            + (result.stderr or "").splitlines()[-15:]
        )
        raise FlagStageError(
            f"`npm run {script}` failed with exit code {result.returncode}:\n{tail}"
        )


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry, refresh  # the Node scripts read data/entities.json directly

    if not (config.REPO_ROOT / "node_modules").exists():
        raise FlagStageError(
            "node_modules is missing, so the flag palette cannot be built. "
            "Run `npm install` first."
        )

    _run("flags")
    _run("palette")

    palette_path = config.DATA_DIR / "flags" / "map-palette.json"
    raw_path = config.DATA_DIR / "flags" / "raw-palette.json"
    if not palette_path.exists():
        raise FlagStageError(
            f"{palette_path} was not produced; the palette build reported "
            f"success but wrote nothing."
        )

    palette = json.loads(palette_path.read_text("utf-8"))
    raw = json.loads(raw_path.read_text("utf-8"))
    verification = palette.get("verification", {})

    manifest_mod.record_source(
        manifest,
        "flagcdn",
        title="flagcdn.com flag SVGs",
        url="https://flagcdn.com",
        licence="Public domain / free to use",
        fetched_at=manifest["generated_at"],
        upstream_release=None,
        vintage=None,
        citation="flagcdn.com",
        notes=(
            f"Flag SVGs rasterised and quantised to a dominant non-neutral "
            f"colour for {raw.get('extracted', 0)} entities. Map fills take "
            f"the flag hue at one of four graph-coloured lightness tiers so no "
            f"two bordering countries share a fill."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "flags/map-palette.json",
        description=(
            "Normalised map fills, continent accents, and per-entity flag "
            "accent colours with AA-safe text steps."
        ),
        sources=["flagcdn"],
        entity_count=len(palette.get("entities", {})),
    )

    for theme in ("light", "dark"):
        report = verification.get(theme)
        if not report:
            continue
        if report.get("violations"):
            raise FlagStageError(
                f"Palette verification failed in {theme} mode: "
                f"{len(report['violations'])} bordering pairs share a fill. "
                f"This breaks an acceptance criterion; refusing to publish."
            )

    light = verification.get("light", {})
    print(
        f"      palette OK: {light.get('borderPairs', 0)} bordering pairs, "
        f"min deltaE {light.get('minDeltaE', 'n/a')}"
    )


__all__ = ["ingest", "FlagStageError"]
