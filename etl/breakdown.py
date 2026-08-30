"""Percentage-breakdown completion rules (added 2026-08-29, maintainer request).

Every breakdown on the site -- ethnic groups, religions, languages, trade
partners, land use, biomes, urban/rural -- must account for 100%. The
components as published rarely do, and the gap was left unexplained. The
rules here decide, per breakdown, what to ship:

  total < 100      an explicit "Other" item makes up the EXACT difference,
                   with a per-metric tooltip saying what it covers.
  100 <= total     no Other; if the overshoot is within OVERLAP_NOTE_PCT
  <= 100+2         the UI shows a short note that the source categories
                   overlap or round.
  total > 100+2    the breakdown is SUPPRESSED (the prose text still
                   renders) -- displaying it would misrepresent the source.
                   Logged.
  gap > 40 points  usually missing data rather than a genuine "Other". Kinds
                   that are partial BY DESIGN (top-5 trade partners) still
                   get their Other; every other kind ships WITHOUT an Other,
                   with a note, and is logged for review before it can
                   become an "Other".

Kinds whose shares overlap by nature (languages: people speak several) are
never suppressed and never padded; the note explains the multi-response.

The same rules are mirrored in src/lib/breakdown.ts for the pairs the app
assembles at render time from World Bank series (urban/rural, GDP sectors);
keep the two in step.
"""

from __future__ import annotations

import json
from typing import Any

from . import config

OVERLAP_NOTE_PCT = 2.0
LARGE_GAP_PCT = 40.0
ROUNDING_PCT = 0.05

#: What "Other" covers, per breakdown kind. Rendered as the tooltip.
OTHER_TOOLTIPS: dict[str, str] = {
    "landUse": (
        "Built-up land, barren land, inland water and land the source "
        "leaves unclassified."
    ),
    "biomes": (
        "Rounding, inland water and ice, and area no ecoregion is assigned to."
    ),
    "ethnicGroups": (
        "Groups the source does not enumerate, respondents who gave no "
        "answer, and rounding."
    ),
    "religions": (
        "Affiliations the source does not enumerate, respondents who gave "
        "no answer, and rounding."
    ),
    "exportPartners": "All other export destinations combined.",
    "importPartners": "All other import sources combined.",
    "urbanRural": "Rounding between the two World Bank series.",
    "gdpSectors": (
        "Net taxes and subsidies on products, and statistical discrepancy "
        "-- the World Bank's sector shares exclude them."
    ),
    "electricityMix": (
        "Other renewables (geothermal, wave and tidal), other sources the "
        "producer does not break out, and rounding."
    ),
}

#: Kinds that are partial lists by construction (the source publishes its
#: top N). Their "Other" is legitimate no matter how large.
# The electricity mix is partial by design too: geothermal, wave and tidal
# are not broken out by the source, and for Kenya or Iceland they are the
# largest "Other" there is.
PARTIAL_BY_DESIGN = {"exportPartners", "importPartners", "electricityMix"}

#: Kinds where shares overlap by nature; never padded, never suppressed.
OVERLAPPING_BY_NATURE = {"languages"}

_log: list[dict[str, Any]] = []


def complete(
    kind: str, total: float | None, *, iso3: str, label: str | None = None,
    overlapping: bool = False,
) -> dict[str, Any]:
    """Decide the Other / overlap / suppression state for one breakdown.

    Returns the fields to merge into the artifact:
      other:               {label, percent, tooltip} | None
      overlapPercent:      float | None     (total - 100, when > 0)
      overlapNote:         str | None
      breakdownSuppressed: bool
      breakdownNote:       str | None       (why suppressed / unexplained)
    """
    result: dict[str, Any] = {
        "other": None,
        "overlapPercent": None,
        "overlapNote": None,
        "breakdownSuppressed": False,
        "breakdownNote": None,
    }
    if total is None:
        return result
    tooltip = OTHER_TOOLTIPS.get(kind, "Categories the source does not enumerate.")
    gap = round(100.0 - total, 2)

    if kind in OVERLAPPING_BY_NATURE or overlapping:
        # `overlapping` is set when the source's own note says respondents
        # could pick more than one category (New Zealand's census ethnicity
        # question, 115%) -- a multi-response figure, not an error.
        if gap < -ROUNDING_PCT:
            result["overlapPercent"] = round(-gap, 2)
            result["overlapNote"] = (
                "Shares total more than 100% because respondents may be "
                "counted in more than one category"
                + (" (for example, people who speak several languages)."
                   if kind in OVERLAPPING_BY_NATURE else
                   ", as the source's own note states.")
            )
        return result

    if gap > ROUNDING_PCT:
        if gap > LARGE_GAP_PCT and kind not in PARTIAL_BY_DESIGN:
            result["breakdownNote"] = (
                f"The published categories total {total:g}%; the source "
                f"does not account for the remaining {gap:g}%, which is "
                f"too large to label as \"other\" with confidence."
            )
            _log.append({
                "iso3": iso3, "kind": kind, "label": label,
                "total": total, "gap": gap,
                "state": "large gap, shipped without Other -- review",
            })
        else:
            result["other"] = {
                "label": "Other", "percent": gap, "tooltip": tooltip,
            }
    elif gap < -ROUNDING_PCT:
        overshoot = round(-gap, 2)
        result["overlapPercent"] = overshoot
        if overshoot <= OVERLAP_NOTE_PCT:
            result["overlapNote"] = (
                f"Shares total {total:g}%: the source's categories overlap "
                f"or are rounded, so they are shown exactly as published "
                f"rather than rescaled."
            )
            _log.append({
                "iso3": iso3, "kind": kind, "label": label,
                "total": total, "overshoot": overshoot,
                "state": "overlap within tolerance, note shown",
            })
        else:
            result["breakdownSuppressed"] = True
            result["breakdownNote"] = (
                f"The published shares total {total:g}%, {overshoot:g} "
                f"points over 100 -- more than category overlap or "
                f"rounding can explain -- so no breakdown chart is shown. "
                f"The source's own wording is given instead."
            )
            _log.append({
                "iso3": iso3, "kind": kind, "label": label,
                "total": total, "overshoot": overshoot,
                "state": "suppressed",
            })
    return result


def flush(stage: str, manifest: dict[str, Any] | None = None) -> int:
    """Write the review log for this stage and reset."""
    from . import manifest as manifest_mod

    config.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    entries = sorted(_log, key=lambda e: (e["state"], e["kind"], e["iso3"]))
    by_state: dict[str, int] = {}
    for entry in entries:
        by_state[entry["state"]] = by_state.get(entry["state"], 0) + 1
    (config.LOGS_DIR / f"breakdowns-{stage}.json").write_text(
        json.dumps({
            "note": (
                "Percentage breakdowns whose components do not reconcile to "
                "100% (etl/breakdown.py). 'suppressed' breakdowns render as "
                "prose; 'large gap' ones render without an Other item until "
                "reviewed; 'overlap within tolerance' ones render with a "
                "note."
            ),
            "stage": stage,
            "summary": by_state,
            "entries": entries,
        }, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    count = len(entries)
    flagged = [e for e in entries if e["state"] != "overlap within tolerance, note shown"]
    if flagged and manifest is not None:
        manifest_mod.add_warning(
            manifest,
            f"{stage}: {len(flagged)} percentage breakdown(s) do not "
            f"reconcile to 100% beyond tolerance (suppressed or shipped "
            f"without an Other item); see etl/logs/breakdowns-{stage}.json.",
        )
    _log.clear()
    return count


__all__ = ["complete", "flush", "OTHER_TOOLTIPS", "OVERLAP_NOTE_PCT", "LARGE_GAP_PCT"]
