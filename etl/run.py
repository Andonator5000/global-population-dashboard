"""ETL entry point.

    python etl/run.py --refresh              # re-fetch everything, rebuild /data
    python etl/run.py                        # rebuild from cached raw downloads
    python etl/run.py --only crosswalk       # run a single stage
    python etl/run.py --validate-indicators  # check World Bank codes still resolve
    python etl/run.py --check-sources        # liveness probe, no writes

Exit codes: 0 clean, 1 a stage failed, 2 invalid invocation.

The pipeline aborts on the first failure. It never writes a partial manifest --
if a stage raises, /data keeps whatever it had, so the committed artifacts are
always internally consistent with the manifest that describes them.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from typing import Any, Callable

if __package__ in (None, ""):
    # Allow `python etl/run.py` as well as `python -m etl.run`.
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

from etl import config, crosswalk, manifest as manifest_mod
from etl.fetch import FetchError, fetch, head_ok


# --------------------------------------------------------------------------
# Console output
# --------------------------------------------------------------------------

def info(message: str) -> None:
    print(f"  {message}", flush=True)


def stage(name: str) -> None:
    print(f"\n[{name}]", flush=True)


def warn(message: str) -> None:
    print(f"  ! {message}", flush=True)


def fail(message: str) -> None:
    print(f"\nFAILED: {message}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Stage: crosswalk
# --------------------------------------------------------------------------

def stage_crosswalk(ctx: dict[str, Any]) -> None:
    stage("crosswalk")
    refresh: bool = ctx["refresh"]

    build_warnings: list[str] = []
    registry = crosswalk.build_registry(refresh=refresh, warnings=build_warnings)
    info(f"built registry with {len(registry)} entities")
    for message in build_warnings:
        warn(message)
        manifest_mod.add_warning(ctx["manifest"], message)

    problems = crosswalk.validate(registry)
    if problems:
        for problem in problems:
            warn(problem)
        raise crosswalk.CrosswalkError(
            f"{len(problems)} crosswalk validation problem(s). The registry is "
            f"the join key for every other source, so the run stops here rather "
            f"than propagating a bad key into /data."
        )

    by_continent: dict[str, int] = {}
    for entity in registry.values():
        by_continent[entity.continent] = by_continent.get(entity.continent, 0) + 1
    summary = ", ".join(
        f"{config.CONTINENTS[k]}={v}" for k, v in sorted(by_continent.items())
    )
    info(f"continents: {summary}")

    contested = [e for e in registry.values() if e.is_contested]
    info(f"contested entities rendered separately: "
         f"{', '.join(sorted(e.iso3 for e in contested))}")

    # Prove the Factbook mirror is reachable and enumerable now, so a Phase 5
    # run does not discover it is gone after doing all the other work. The
    # GEC -> ISO3 join itself is Phase 5.
    factbook_index = crosswalk.load_factbook_index(refresh=refresh)
    info(f"factbook mirror reachable: {len(factbook_index)} country files")
    ctx["factbook_index"] = factbook_index

    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = config.DATA_DIR / "entities.json"
    out_path.write_text(
        json.dumps(crosswalk.registry_to_records(registry), indent=2,
                   ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    info(f"wrote {out_path.relative_to(config.REPO_ROOT)}")

    ctx["registry"] = registry
    ctx["aliases"] = crosswalk.build_alias_map(registry)

    manifest_mod.record_source(
        ctx["manifest"],
        "country_metadata",
        title="mledoze/countries",
        url=config.COUNTRIES_DATASET_URL,
        licence="ODbL-1.0",
        fetched_at=ctx["manifest"]["generated_at"],
        upstream_release=None,
        vintage=None,
        citation="mledoze/countries (github.com/mledoze/countries)",
        notes=(
            "Replaces REST Countries v3.1, which was deprecated in favour of a "
            "key-gated v5 (see DATA_DECISIONS.md #1). This is the dataset REST "
            "Countries is built from. Used only for country metadata (names, "
            "ISO codes, borders, capital, area, currencies, languages). Never "
            "used for population or economic figures -- its population field is "
            "undated and disagrees with UN WPP. One documented upstream "
            "correction is applied (Vatican City UN membership)."
        ),
    )
    manifest_mod.record_artifact(
        ctx["manifest"],
        "entities.json",
        description=(
            "Canonical entity registry. The ISO3 join key for every other "
            "artifact, including editorial rulings on contested entities and "
            "continent assignment."
        ),
        sources=["country_metadata", "editorial"],
        entity_count=len(registry),
    )


# --------------------------------------------------------------------------
# Stage stubs -- implemented in later phases
# --------------------------------------------------------------------------

def _not_yet(phase: int, what: str) -> Callable[[dict[str, Any]], None]:
    def run(ctx: dict[str, Any]) -> None:
        stage(what)
        info(f"not implemented yet (phase {phase})")
    return run


def _require_registry(ctx: dict[str, Any]) -> dict[str, Any]:
    """Stages after `crosswalk` need its registry; build it if run standalone."""
    if "registry" not in ctx:
        stage_crosswalk(ctx)
    return ctx


def stage_wpp(ctx: dict[str, Any]) -> None:
    from etl.sources import wpp

    _require_registry(ctx)
    stage("wpp")
    revision = discover_wpp_revision()
    info(f"revision {revision} (newest published)")
    wpp.ingest(
        ctx["registry"],
        refresh=ctx["refresh"],
        manifest=ctx["manifest"],
        revision=revision,
    )


def stage_worldbank(ctx: dict[str, Any]) -> None:
    from etl.sources import worldbank

    _require_registry(ctx)
    stage("worldbank")
    worldbank.ingest(
        ctx["registry"], refresh=ctx["refresh"], manifest=ctx["manifest"]
    )


def stage_geometry(ctx: dict[str, Any]) -> None:
    from etl.sources import geometry

    _require_registry(ctx)
    stage("geometry")
    geometry.ingest(
        ctx["registry"], refresh=ctx["refresh"], manifest=ctx["manifest"]
    )


def stage_factbook(ctx: dict[str, Any]) -> None:
    from etl.sources import factbook

    _require_registry(ctx)
    stage("factbook")
    factbook.ingest(
        ctx["registry"], refresh=ctx["refresh"], manifest=ctx["manifest"]
    )


def stage_flags(ctx: dict[str, Any]) -> None:
    from etl.sources import flags

    _require_registry(ctx)
    stage("flags")
    flags.ingest(
        ctx["registry"], refresh=ctx["refresh"], manifest=ctx["manifest"]
    )


def stage_biomes(ctx: dict[str, Any]) -> None:
    from etl.sources import biomes

    _require_registry(ctx)
    stage("biomes")
    biomes.ingest(
        ctx["registry"], refresh=ctx["refresh"], manifest=ctx["manifest"]
    )


def stage_owid(ctx: dict[str, Any]) -> None:
    from etl.sources import owid

    _require_registry(ctx)
    stage("owid_crosscheck")
    owid.ingest(
        ctx["registry"], refresh=ctx["refresh"], manifest=ctx["manifest"]
    )


def stage_leaders(ctx: dict[str, Any]) -> None:
    from etl.sources import leaders

    _require_registry(ctx)
    stage("leaders")
    leaders.ingest(
        ctx["registry"], refresh=ctx["refresh"], manifest=ctx["manifest"]
    )


def stage_heritage(ctx: dict[str, Any]) -> None:
    from etl.sources import heritage

    _require_registry(ctx)
    stage("heritage")
    heritage.ingest(
        ctx["registry"], refresh=ctx["refresh"], manifest=ctx["manifest"]
    )


def stage_owid_indicators(ctx: dict[str, Any]) -> None:
    from etl.sources import owid_indicators

    _require_registry(ctx)
    stage("owid_indicators")
    owid_indicators.ingest(
        ctx["registry"], refresh=ctx["refresh"], manifest=ctx["manifest"]
    )


def _simple_stage(module_name: str, display: str) -> Callable[[dict[str, Any]], None]:
    """The standard stage shape: require the registry, import lazily, ingest.

    The 2026-08-23 batch added eight sources; writing eight identical
    stage_x functions would just be surface area for copy-paste drift.
    """
    def run(ctx: dict[str, Any]) -> None:
        import importlib

        _require_registry(ctx)
        stage(display)
        module = importlib.import_module(f"etl.sources.{module_name}")
        module.ingest(
            ctx["registry"], refresh=ctx["refresh"], manifest=ctx["manifest"]
        )
    return run


STAGES: dict[str, Callable[[dict[str, Any]], None]] = {
    "crosswalk": stage_crosswalk,
    "wpp": stage_wpp,
    "worldbank": stage_worldbank,
    "owid_indicators": stage_owid_indicators,
    "pressfreedom": _simple_stage("pressfreedom", "pressfreedom"),
    "unodc": _simple_stage("unodc", "unodc"),
    "deathpenalty": _simple_stage("deathpenalty", "deathpenalty"),
    "education": _simple_stage("education", "education"),
    "imf": _simple_stage("imf", "imf"),
    "currency_images": _simple_stage("currencyimages", "currency_images"),
    "subdivisions": _simple_stage("subdivisions", "subdivisions"),
    "climate": _simple_stage("climate", "climate"),
    "inventions": _simple_stage("inventions", "inventions"),
    "airports": _simple_stage("airports", "airports"),
    "florafauna": _simple_stage("florafauna", "florafauna"),
    "cuisine": _simple_stage("cuisine", "cuisine"),
    "geometry": stage_geometry,
    "flags": stage_flags,
    "flagmeta": _simple_stage("flagmeta", "flagmeta"),
    "history": _simple_stage("history", "history"),
    "factbook": stage_factbook,
    "leaders": stage_leaders,
    "heritage": stage_heritage,
    "biomes": stage_biomes,
    "owid_crosscheck": stage_owid,
}


# --------------------------------------------------------------------------
# Diagnostics
# --------------------------------------------------------------------------

def check_sources() -> int:
    """Liveness probe for every upstream. Writes nothing."""
    stage("source liveness")
    probes: list[tuple[str, str]] = [
        ("World Bank Indicators",
         f"{config.WORLD_BANK_BASE}/country/USA/indicator/NY.GDP.MKTP.CD?format=json&per_page=1"),
        ("Country metadata (mledoze/countries)", config.COUNTRIES_DATASET_URL),
        ("Factbook mirror",
         f"{config.FACTBOOK_BASE}/north-america/us.json"),
        ("Natural Earth 110m TopoJSON", config.NATURAL_EARTH_TOPOJSON_110M),
        ("RESOLVE Ecoregions 2017", config.ECOREGIONS_URL),
        ("Our World in Data", config.OWID_POPULATION_CSV),
        ("Our World in Data grapher",
         config.OWID_GRAPHER_CSV.format(slug=config.OWID_INDICATORS[0].slug)),
        ("flagcdn", config.FLAGCDN_SVG.format(cca2_lower="us")),
        ("IMF DataMapper",
         config.IMF_DATAMAPPER_TEMPLATE.format(code=config.IMF_DEBT_PCT_GDP)),
        ("Hipolabs universities", config.HIPOLABS_UNIVERSITIES_URL),
        ("UNODC prisons landing", config.UNODC_PRISON_LANDING),
        ("GeoNames cities15000", config.GEONAMES_CITIES15000_URL),
        ("OurAirports roster", config.OURAIRPORTS_CSV_URL),
        ("Wikipedia REST HTML", config.WIKIPEDIA_NATIONAL_ANIMALS_URL),
    ]
    rev = discover_wpp_revision()
    probes.append((
        f"UN WPP {rev} bulk CSV",
        f"{config.WPP_CSV_BASE}/{config.WPP_FILES[0].filename_template.format(rev=rev)}",
    ))

    failures = 0
    for label, url in probes:
        ok = head_ok(url)
        print(f"  {'OK  ' if ok else 'DEAD'}  {label}", flush=True)
        if not ok:
            failures += 1
    if failures:
        fail(f"{failures} source(s) unreachable")
    return 1 if failures else 0


def discover_wpp_revision() -> int:
    """Find the newest published WPP revision, newest-first.

    Deliberately probes rather than assuming a cadence. WPP 2024 remained the
    current revision well into 2026 because the next revision was postponed to
    2027 -- so this returning 2024 for years on end is correct behaviour, not a
    stalled fetcher.
    """
    template = config.WPP_FILES[0].filename_template
    for rev in sorted(config.WPP_REVISION_PROBE_RANGE, reverse=True):
        url = f"{config.WPP_CSV_BASE}/{template.format(rev=rev)}"
        if head_ok(url):
            return rev
    raise FetchError(
        "No WPP revision found in probe range "
        f"{min(config.WPP_REVISION_PROBE_RANGE)}-"
        f"{max(config.WPP_REVISION_PROBE_RANGE)}. The UN may have moved the "
        "bulk CSV path; check https://population.un.org/wpp/downloads"
    )


def validate_indicators() -> int:
    """Confirm every configured World Bank indicator code still resolves."""
    stage("world bank indicator validation")
    bad: list[str] = []
    for indicator in config.WORLD_BANK_INDICATORS:
        url = f"{config.WORLD_BANK_BASE}/indicator/{indicator.code}?format=json"
        try:
            response = fetch(
                url, subdir="worldbank/catalogue",
                filename=f"{indicator.code}.json", expect_json=True,
            )
            payload = response.read_json()
            resolved = (
                isinstance(payload, list)
                and len(payload) > 1
                and isinstance(payload[1], list)
                and len(payload[1]) > 0
            )
        except FetchError:
            resolved = False
        if resolved:
            print(f"  OK    {indicator.code}  {indicator.label}", flush=True)
        else:
            print(f"  GONE  {indicator.code}  {indicator.label}", flush=True)
            bad.append(indicator.code)
    if bad:
        fail(
            f"{len(bad)} indicator code(s) no longer resolve: {', '.join(bad)}. "
            f"Update WORLD_BANK_INDICATORS in etl/config.py."
        )
        return 1
    info(f"all {len(config.WORLD_BANK_INDICATORS)} indicator codes resolve")
    return 0


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="etl/run.py",
        description="Rebuild /data for the Global Population Dashboard.",
    )
    parser.add_argument("--refresh", action="store_true",
                        help="re-fetch every source, ignoring the raw cache")
    parser.add_argument("--only", metavar="STAGE", action="append",
                        choices=sorted(STAGES), default=None,
                        help="run only this stage (repeatable)")
    parser.add_argument("--check-sources", action="store_true",
                        help="probe every upstream for liveness and exit")
    parser.add_argument("--validate-indicators", action="store_true",
                        help="verify World Bank indicator codes and exit")
    parser.add_argument("--skip-flags", action="store_true",
                        help="skip the Node flag/palette stage (needs npm)")
    parser.add_argument("--fingerprint", action="store_true",
                        help="print the current /data content fingerprint and exit")
    args = parser.parse_args(argv)

    if args.check_sources:
        return check_sources()
    if args.validate_indicators:
        return validate_indicators()
    if args.fingerprint:
        # Used by the monthly workflow to tell a real data change from a
        # manifest that only carries new timestamps.
        print(manifest_mod.content_fingerprint())
        return 0

    ctx: dict[str, Any] = {
        "refresh": args.refresh,
        "manifest": manifest_mod.new_manifest(),
    }

    selected = args.only or list(STAGES)
    if args.skip_flags:
        selected = [name for name in selected if name != "flags"]
    print(f"Global Population Dashboard ETL "
          f"({'refresh' if args.refresh else 'cached'} mode)")
    print(f"stages: {', '.join(selected)}")

    for name in selected:
        try:
            STAGES[name](ctx)
        except (FetchError, crosswalk.CrosswalkError) as exc:
            fail(f"stage '{name}': {exc}")
            return 1
        except Exception as exc:  # noqa: BLE001 - abort loudly either way
            # FlagStageError lives behind a lazy import (it pulls in the Node
            # bridge), so it is matched by name rather than by type. Its
            # message is already actionable, so no traceback is printed.
            if type(exc).__name__ == "FlagStageError":
                fail(f"stage '{name}': {exc}")
                return 1
            fail(f"stage '{name}' raised an unexpected error:")
            traceback.print_exc()
            return 1

    manifest_mod.write(ctx["manifest"])
    print(f"\nwrote {config.MANIFEST_PATH.relative_to(config.REPO_ROOT)}")
    if ctx["manifest"]["warnings"]:
        print(f"{len(ctx['manifest']['warnings'])} warning(s) recorded in the "
              f"manifest; they will surface in the app's freshness panel.")
    print("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
