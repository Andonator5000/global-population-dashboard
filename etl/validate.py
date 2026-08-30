"""Plausibility layer for scalar figures (added 2026-08-29, maintainer request).

Motivating case: Wikidata "counted" 9 public libraries in Russia -- an
artefact of what happens to be catalogued, not a figure about Russia. A
number that is orders of magnitude off is worse than no number, because
the page renders it with the same authority as a real one.

Two kinds of check, both applied at build time by the stage that produces
the figure:

* **Bounds** -- an absolute range per metric (or per unit as a default).
* **Ratios** -- the figure against the entity's population or land area
  (libraries per capita, prisoners per 100k, ...).

A figure outside its range is SUPPRESSED (the artifact carries the usual
explicit-unavailable state) and LOGGED to `etl/logs/plausibility-<stage>.json`
with the value, the rule and the denominator used, so every suppression is
reviewable on the PR diff. The bounds are deliberately wide: the layer is
a tripwire for order-of-magnitude nonsense, not an editorial opinion about
which countries are outliers. Every rule lives in this file so the set is
auditable in one place.

Population comes from the WPP series artifact already in /data (the wpp
stage runs first); land area from the registry. A stage whose denominator
is missing skips the ratio check rather than failing the figure.
"""

from __future__ import annotations

import json
from typing import Any

from . import config
from .crosswalk import Entity

# --------------------------------------------------------------------------
# Rules
# --------------------------------------------------------------------------

#: Default absolute bounds by World Bank unit string.
UNIT_BOUNDS: dict[str, tuple[float, float]] = {
    "percent": (0.0, 100.0),
    "USD": (1e6, 5e13),
    "USD_PPP": (100.0, 400_000.0),
    "index": (0.0, 100.0),
    # Pre-redenomination years legitimately sit at 1e-7 (Angola 1992).
    "lcu_per_usd": (1e-12, 1e10),
    "per_sqkm": (0.0, 40_000.0),
    "sq_km": (0.5, 2e7),
    "per_100": (0.0, 500.0),
    "count": (0.0, 1e8),
    "per_100k": (0.0, 500.0),
    "mm_per_year": (0.0, 8_000.0),
    # Rwanda 1994 and Cambodia 1977 are real, and far below 25.
    "years": (10.0, 100.0),
    "per_1000": (0.0, 200.0),
}

#: Per-metric bounds, keyed by metric id (World Bank code or a stage-local
#: key). These override the unit default.
METRIC_BOUNDS: dict[str, tuple[float, float]] = {
    # Rates that legitimately leave 0-100.
    "NY.GDP.MKTP.KD.ZG": (-70.0, 150.0),
    "SE.PRM.ENRR": (0.0, 250.0),
    "SE.SEC.ENRR": (0.0, 250.0),
    "SE.TER.ENRR": (0.0, 250.0),
    # Kuwait 1991 spent 117% of GDP on its military; a war year is real.
    "MS.MIL.XPND.GD.ZS": (0.0, 200.0),
    # Per-1,000 figures have tighter real ranges than the unit default.
    "SH.MED.PHYS.ZS": (0.0, 30.0),
    "SH.MED.BEDS.ZS": (0.0, 50.0),
    # 1960s child mortality exceeded 400 per 1,000 in several countries.
    "SH.DYN.MORT": (0.0, 700.0),
    "SH.STA.MMRT": (0.0, 5_000.0),
    "SI.POV.GINI": (15.0, 80.0),
    "MS.MIL.TOTL.P1": (0.0, 6e6),
    # Stage-local counts.
    "education.universities": (1.0, 10_000.0),
    "heritage.count": (1.0, 100.0),
    # Zero is a real figure for the Vatican; the bound catches negatives.
    "unodc.prisoners": (0.0, 5e6),
    "unodc.facilities": (1.0, 20_000.0),
    "airports.passengers": (1.0, 200e6),
    # Uninhabited atolls really do have 0 people.
    "subdivisions.population": (0.0, 2e9),
    "libraries.public": (1.0, 200_000.0),
    "energy.nuclearPlants": (1.0, 100.0),
}

#: Ratio rules: metric id -> (denominator, lo, hi). Denominators:
#: "per_million" (value / population * 1e6), "per_100k", "share_of_population"
#: (value / population), "per_1000_sqkm" (value / area * 1000).
#: Per-capita ratios are skipped below RATIO_MIN_POPULATION: one university
#: in Niue (1,800 people) is 550 per million and perfectly real.
RATIO_MIN_POPULATION = 100_000
RATIO_RULES: dict[str, tuple[str, float, float]] = {
    "MS.MIL.TOTL.P1": ("share_of_population", 0.0, 0.15),
    "education.universities": ("per_million", 0.005, 400.0),
    "unodc.prisoners": ("per_100k", 0.5, 2_500.0),
    "unodc.facilities": ("per_million", 0.005, 150.0),
    "airports.passengers": ("share_of_population", 0.0, 60.0),
    "subdivisions.population": ("share_of_population", 0.0, 1.05),
    # Czechia reports 558 branches per million and Canada 443 -- dense,
    # real networks -- so the ceiling sits well above them; 0.05 is a
    # country that reports a handful.
    "libraries.public": ("per_million", 0.05, 1500.0),
}


# --------------------------------------------------------------------------
# Denominators
# --------------------------------------------------------------------------

_population_cache: dict[str, float | None] = {}


def latest_population(iso3: str) -> float | None:
    """Latest WPP estimate (not projection) from the committed series."""
    if iso3 in _population_cache:
        return _population_cache[iso3]
    path = config.DATA_DIR / "population" / "series" / f"{iso3}.json"
    value: float | None = None
    if path.exists():
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
            years = doc.get("years") or []
            series = (doc.get("series") or {}).get("population") or []
            through = doc.get("estimatesThrough")
            pairs = [
                (y, v) for y, v in zip(years, series)
                if v is not None and (through is None or y <= through)
            ]
            if pairs:
                value = float(pairs[-1][1])
        except (OSError, ValueError):
            value = None
    _population_cache[iso3] = value
    return value


def land_area(registry: dict[str, Entity], iso3: str) -> float | None:
    entity = registry.get(iso3)
    return float(entity.area_km2) if entity and entity.area_km2 else None


# --------------------------------------------------------------------------
# Checker
# --------------------------------------------------------------------------

class Plausibility:
    """Per-stage checker. `check` returns True when the value may ship."""

    def __init__(self, stage: str, registry: dict[str, Entity]) -> None:
        self.stage = stage
        self.registry = registry
        self.suppressed: list[dict[str, Any]] = []
        self.checked = 0

    def check(
        self,
        iso3: str,
        metric: str,
        value: float | int | None,
        *,
        unit: str | None = None,
        year: int | None = None,
        label: str | None = None,
    ) -> bool:
        if value is None:
            return False
        self.checked += 1
        try:
            number = float(value)
        except (TypeError, ValueError):
            self._log(iso3, metric, value, year, label, "not numeric", None, None)
            return False
        if number != number:  # NaN
            self._log(iso3, metric, value, year, label, "NaN", None, None)
            return False

        bounds = METRIC_BOUNDS.get(metric) or (
            UNIT_BOUNDS.get(unit) if unit else None
        )
        if bounds and not (bounds[0] <= number <= bounds[1]):
            self._log(
                iso3, metric, number, year, label,
                f"outside bounds [{bounds[0]:g}, {bounds[1]:g}]", None, None,
            )
            return False

        rule = RATIO_RULES.get(metric)
        if rule:
            kind, lo, hi = rule
            if kind == "per_1000_sqkm":
                denominator = land_area(self.registry, iso3)
                ratio = number / denominator * 1000 if denominator else None
            else:
                denominator = latest_population(iso3)
                if not denominator or denominator < RATIO_MIN_POPULATION:
                    ratio = None
                elif kind == "per_million":
                    ratio = number / denominator * 1e6
                elif kind == "per_100k":
                    ratio = number / denominator * 1e5
                else:
                    ratio = number / denominator
            if ratio is not None and not (lo <= ratio <= hi):
                self._log(
                    iso3, metric, number, year, label,
                    f"{kind} {ratio:.4g} outside [{lo:g}, {hi:g}]",
                    kind, denominator,
                )
                return False
        return True

    def _log(
        self, iso3: str, metric: str, value: Any, year: int | None,
        label: str | None, rule: str, kind: str | None,
        denominator: float | None,
    ) -> None:
        entry: dict[str, Any] = {
            "iso3": iso3,
            "metric": metric,
            "value": value,
            "rule": rule,
        }
        if label:
            entry["label"] = label
        if year is not None:
            entry["year"] = year
        if kind:
            entry["denominator"] = {"kind": kind, "value": denominator}
        self.suppressed.append(entry)

    def flush(self, manifest: dict[str, Any] | None = None) -> int:
        """Write the stage log; add a manifest warning when anything hit."""
        from . import manifest as manifest_mod

        config.LOGS_DIR.mkdir(parents=True, exist_ok=True)
        path = config.LOGS_DIR / f"plausibility-{self.stage}.json"
        by_metric: dict[str, int] = {}
        for entry in self.suppressed:
            by_metric[entry["metric"]] = by_metric.get(entry["metric"], 0) + 1
        path.write_text(
            json.dumps({
                "note": (
                    "Figures the plausibility layer suppressed in this "
                    "stage (etl/validate.py). Each shipped as explicitly "
                    "unavailable instead of as a number."
                ),
                "stage": self.stage,
                "checked": self.checked,
                "summary": by_metric,
                "suppressed": sorted(
                    self.suppressed, key=lambda e: (e["metric"], e["iso3"])
                ),
            }, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )
        if self.suppressed and manifest is not None:
            manifest_mod.add_warning(
                manifest,
                f"{self.stage}: plausibility layer suppressed "
                f"{len(self.suppressed)} figure(s) "
                f"({', '.join(f'{k} x{v}' for k, v in sorted(by_metric.items()))}); "
                f"see etl/logs/plausibility-{self.stage}.json.",
            )
        return len(self.suppressed)


__all__ = [
    "Plausibility", "latest_population", "land_area",
    "UNIT_BOUNDS", "METRIC_BOUNDS", "RATIO_RULES",
]
