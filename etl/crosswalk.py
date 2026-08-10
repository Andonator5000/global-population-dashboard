"""The ISO 3166-1 alpha-3 crosswalk: one canonical entity registry.

Every source in this pipeline keys its rows differently:

  - UN WPP          -> M49 numeric ('LocID'), plus its own 'ISO3_code' column
  - World Bank      -> 'countryiso3code', mixed with regional aggregates
  - CIA Factbook    -> 2-letter GEC codes, which are NOT ISO 3166-1 alpha-2
                       (uk=United Kingdom is actually 'uk' for the UK but
                       'ch'=China, 'sw'=Sweden, 'sz'=Switzerland, 'ja'=Japan)
  - REST Countries  -> cca2 / cca3 / ccn3
  - Natural Earth   -> ISO_A3, which is '-99' for several entities

This module resolves all of them onto ISO3.

Deliberate design choice: the registry is DERIVED, not hardcoded. Typing ~250
rows of codes by hand invites exactly the kind of confident-but-wrong data the
brief warns against, and the Factbook GEC map in particular is a well-known
trap. So we build from authoritative sources at ETL time and keep only genuine
editorial rulings in reference/editorial_overrides.json.

Factbook mapping is done by name matching against REST Countries, with every
unmatched file reported loudly rather than silently dropped.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

from . import config
from .fetch import FetchError, fetch


# --------------------------------------------------------------------------
# Entity model
# --------------------------------------------------------------------------


@dataclass
class Entity:
    """One row of the canonical registry -- one thing we may render."""

    iso3: str
    iso2: str | None
    m49: int | None
    name_common: str
    name_official: str | None
    continent: str                      # key into config.CONTINENTS
    un_member: bool
    independent: bool | None
    area_km2: float | None
    capital: str | None
    # [lat, lon] centroid. Used to place a point marker for entities too small
    # to appear in the 110m geometry -- Singapore, Malta, Hong Kong and 70-odd
    # others -- so a populated country is never silently absent from the map.
    latlng: list[float] | None = None
    borders: list[str] = field(default_factory=list)
    # Editorial
    render: str = "separate"            # 'separate' | 'merged' | 'hidden'
    status_label: str | None = None     # e.g. 'Partially recognised'
    editorial_note: str | None = None
    continent_note: str | None = None
    # Source keys
    factbook_path: str | None = None    # e.g. 'europe/uk.json'
    factbook_gec: str | None = None

    @property
    def is_contested(self) -> bool:
        return self.status_label is not None

    def to_dict(self) -> dict[str, Any]:
        return {
            "iso3": self.iso3,
            "iso2": self.iso2,
            "m49": self.m49,
            "name_common": self.name_common,
            "name_official": self.name_official,
            "continent": self.continent,
            "continent_name": config.CONTINENTS[self.continent],
            "un_member": self.un_member,
            "independent": self.independent,
            "area_km2": self.area_km2,
            "capital": self.capital,
            "latlng": self.latlng,
            "borders": self.borders,
            "render": self.render,
            "status_label": self.status_label,
            "editorial_note": self.editorial_note,
            "continent_note": self.continent_note,
            "factbook_path": self.factbook_path,
            "factbook_gec": self.factbook_gec,
            "is_contested": self.is_contested,
        }


class CrosswalkError(RuntimeError):
    """Raised when the registry cannot be built consistently."""


# --------------------------------------------------------------------------
# Name normalisation, used for fuzzy joins against Factbook
# --------------------------------------------------------------------------

_PUNCT = re.compile(r"[^a-z0-9]+")
_WS = re.compile(r"\s+")
_NOISE_WORDS = {
    "the", "of", "and", "republic", "kingdom", "state", "states",
    "democratic", "people", "peoples", "federal", "federation",
    "islamic", "socialist", "union", "commonwealth", "principality",
    "sultanate", "grand", "duchy", "plurinational", "bolivarian",
}


def normalise_name_strict(name: str) -> str:
    """Fold a name for comparison, WITHOUT discarding any words.

    Accents, case and punctuation only. This is the primary matching key.
    """
    decomposed = unicodedata.normalize("NFKD", name)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    return _WS.sub(" ", _PUNCT.sub(" ", ascii_only.lower())).strip()


def normalise_name(name: str) -> str:
    """Fold a name aggressively, dropping constitutional boilerplate.

    DANGEROUS ON ITS OWN -- it is lossy enough to merge distinct countries:

        "United States"  -> "united"   }  collide
        "United Kingdom" -> "united"   }
        "Democratic Republic of the Congo" -> "congo"  }  collide
        "Republic of the Congo"            -> "congo"  }

    Both collisions were real: an early Factbook join silently gave the United
    States' entry to the United Kingdom's ISO3 and left the US with no
    qualitative data at all. Only ever use this as a FALLBACK, and only when
    the resulting key maps to exactly one entity -- `build_name_index` below
    enforces that.
    """
    stripped = normalise_name_strict(name)
    tokens = [t for t in stripped.split() if t not in _NOISE_WORDS]
    return " ".join(tokens) if tokens else stripped


def build_name_index(
    registry: dict[str, Entity],
) -> tuple[dict[str, str], dict[str, str]]:
    """Return (strict index, unambiguous loose index) of name -> ISO3.

    The loose index deliberately EXCLUDES any key that more than one entity
    folds onto, so an ambiguous match is a miss rather than a wrong answer.
    """
    strict: dict[str, str] = {}
    loose_candidates: dict[str, set[str]] = {}

    for iso3, entity in registry.items():
        names = [entity.name_common]
        if entity.name_official:
            names.append(entity.name_official)
        for name in names:
            strict.setdefault(normalise_name_strict(name), iso3)
            loose_candidates.setdefault(normalise_name(name), set()).add(iso3)

    loose = {
        key: next(iter(owners))
        for key, owners in loose_candidates.items()
        if len(owners) == 1
    }
    return strict, loose


# --------------------------------------------------------------------------
# Overrides
# --------------------------------------------------------------------------


def load_overrides() -> dict[str, Any]:
    path = config.REFERENCE_DIR / "editorial_overrides.json"
    if not path.exists():
        raise CrosswalkError(
            f"Missing editorial overrides at {path}. This file encodes the "
            f"project's editorial rulings and the pipeline will not run "
            f"without it."
        )
    return json.loads(path.read_text("utf-8"))


# --------------------------------------------------------------------------
# Continent derivation
# --------------------------------------------------------------------------

# REST Countries 'region' -> our continent key. The Americas are split by
# subregion, per the seven-continent decision (DATA_DECISIONS.md #2).
_REGION_TO_CONTINENT = {
    "Africa": "AF",
    "Asia": "AS",
    "Europe": "EU",
    "Oceania": "OC",
    "Antarctic": "AN",
}

_SOUTH_AMERICAN_SUBREGIONS = {"South America"}


def derive_continent(region: str | None, subregion: str | None) -> str | None:
    if region in _REGION_TO_CONTINENT:
        return _REGION_TO_CONTINENT[region]
    if region == "Americas":
        if subregion in _SOUTH_AMERICAN_SUBREGIONS:
            return "SA"
        # North America, Central America, Caribbean all fold to NA.
        return "NA"
    return None


# --------------------------------------------------------------------------
# Registry construction
# --------------------------------------------------------------------------


def _fetch_country_metadata(refresh: bool) -> list[dict[str, Any]]:
    """Fetch the country metadata dataset (mledoze/countries).

    Asserts on shape rather than trusting the HTTP status. The API this
    replaced (REST Countries v3.1) served its deprecation notice under a 200,
    and GitHub raw will happily 200 a rate-limit or LFS-pointer body too, so
    status alone proves nothing.
    """
    response = fetch(
        config.COUNTRIES_DATASET_URL,
        refresh=refresh,
        subdir="countries",
        filename="countries.json",
        expect_json=True,
    )
    payload = response.read_json()
    if not isinstance(payload, list):
        preview = str(payload)[:200]
        raise CrosswalkError(
            f"Country metadata source returned {type(payload).__name__}, not a "
            f"list (preview: {preview!r}). Refusing to build a registry from it."
        )
    if len(payload) < config.COUNTRIES_DATASET_MIN_ENTITIES:
        raise CrosswalkError(
            f"Country metadata source returned {len(payload)} entities; "
            f"expected at least {config.COUNTRIES_DATASET_MIN_ENTITIES}. "
            f"Refusing to build a registry from a truncated response."
        )
    return payload


def _fetch_factbook_index(refresh: bool) -> dict[str, str]:
    """Map normalised country name -> 'region/xx.json' path in the mirror.

    Uses the GitHub tree API to enumerate the mirror rather than assuming a
    hardcoded GEC table.
    """
    url = (
        "https://api.github.com/repos/factbook/factbook.json/git/trees/"
        "master?recursive=1"
    )
    response = fetch(
        url,
        refresh=refresh,
        subdir="factbook",
        filename="tree.json",
        expect_json=True,
    )
    tree = response.read_json().get("tree", [])
    paths = [
        node["path"]
        for node in tree
        if node.get("type") == "blob"
        and node["path"].endswith(".json")
        and "/" in node["path"]
        and node["path"].split("/")[0] in config.FACTBOOK_REGIONS
    ]
    if len(paths) < 150:
        raise CrosswalkError(
            f"Factbook mirror tree yielded only {len(paths)} country files; "
            f"expected 250+. The mirror layout may have changed."
        )
    return {p.rsplit("/", 1)[-1].removesuffix(".json"): p for p in paths}


def build_registry(
    *, refresh: bool = False, warnings: list[str] | None = None
) -> dict[str, Entity]:
    """Build the canonical ISO3 -> Entity registry.

    Non-fatal data-quality observations are appended to `warnings`, which the
    caller forwards into the manifest so they surface in the app's freshness
    panel rather than dying in a console scrollback.
    """
    sink = warnings if warnings is not None else []
    overrides = load_overrides()
    countries = _fetch_country_metadata(refresh)

    # Upstream codes that are not our canonical ISO3 (e.g. Kosovo ships as
    # 'UNK' in this dataset; we canonicalise on 'XKX', the code the World Bank
    # and IMF use).
    code_aliases = {
        k.upper(): v
        for k, v in overrides["iso3_aliases"].items()
        if not k.startswith("_")
    }

    registry: dict[str, Entity] = {}
    unassigned_continent: list[str] = []

    for row in countries:
        raw_code = (row.get("cca3") or "").upper()
        if not raw_code or len(raw_code) != 3:
            continue
        iso3 = code_aliases.get(raw_code, raw_code)

        names = row.get("name") or {}
        m49_raw = row.get("ccn3")
        capitals = row.get("capital") or []

        continent = derive_continent(row.get("region"), row.get("subregion"))
        if continent is None:
            unassigned_continent.append(iso3)
            continue

        registry[iso3] = Entity(
            iso3=iso3,
            iso2=(row.get("cca2") or "").upper() or None,
            m49=int(m49_raw) if m49_raw and str(m49_raw).isdigit() else None,
            name_common=names.get("common") or iso3,
            name_official=names.get("official"),
            continent=continent,
            un_member=bool(row.get("unMember")),
            independent=row.get("independent"),
            area_km2=row.get("area"),
            capital=capitals[0] if capitals else None,
            latlng=(
                [float(v) for v in row["latlng"]]
                if isinstance(row.get("latlng"), list) and len(row["latlng"]) == 2
                else None
            ),
            # Borders arrive as upstream codes and must be canonicalised too,
            # or Kosovo's neighbours would point at a 'UNK' node that does not
            # exist in the registry and the Phase 4 adjacency colouring would
            # silently drop those constraints.
            borders=[
                code_aliases.get(b.upper(), b.upper())
                for b in (row.get("borders") or [])
            ],
        )

    # --- correct known upstream data errors --------------------------------
    # Each entry here is a documented bug in the metadata source, not a matter
    # of editorial taste. Applied before the contested-entity rulings so those
    # can still override on top.
    _FIELD_SETTERS: dict[str, str] = {
        "un_member": "un_member",
        "independent": "independent",
        "area_km2": "area_km2",
        "capital": "capital",
        "continent": "continent",
    }
    for correction in overrides.get("source_corrections", []):
        target = registry.get(correction["iso3"])
        if target is None:
            continue
        attr = _FIELD_SETTERS.get(correction["field"])
        if attr is None:
            raise CrosswalkError(
                f"source_corrections names unknown field "
                f"{correction['field']!r} for {correction['iso3']}."
            )
        current = getattr(target, attr)
        if current != correction["upstream_value"]:
            # The upstream fixed it, or changed it to a third value. Either
            # way the correction is now stale and silently applying it could
            # introduce the very error it was written to fix.
            raise CrosswalkError(
                f"Stale source correction for {correction['iso3']}.{attr}: "
                f"expected upstream value {correction['upstream_value']!r} but "
                f"found {current!r}. Upstream may have fixed this; re-verify "
                f"and update reference/editorial_overrides.json."
            )
        setattr(target, attr, correction["corrected_value"])

    # --- apply contested-entity rulings -----------------------------------
    for entry in overrides["contested_entities"]:
        iso3 = entry["iso3"]
        existing = registry.get(iso3)
        if existing is None:
            registry[iso3] = Entity(
                iso3=iso3,
                iso2=None,
                m49=entry.get("m49"),
                name_common=entry["name_common"],
                name_official=entry.get("name_formal"),
                continent=entry["continent"],
                un_member=entry.get("un_member", False),
                independent=None,
                area_km2=None,
                capital=None,
            )
            existing = registry[iso3]
        existing.continent = entry["continent"]
        existing.un_member = entry.get("un_member", existing.un_member)
        existing.render = entry.get("render", "separate")
        existing.status_label = entry.get("status_label")
        existing.editorial_note = entry.get("note")
        if entry.get("m49") is not None:
            existing.m49 = entry["m49"]

    # --- apply continent rulings ------------------------------------------
    for entry in overrides["continent_assignments"]:
        target = registry.get(entry["iso3"])
        if target is None:
            # Not fatal: the override may name an entity REST Countries has
            # dropped. Surfaced by validate() rather than silently ignored.
            continue
        target.continent = entry["continent"]
        target.continent_note = entry["note"]

    for asymmetry in _symmetrise_borders(registry):
        sink.append(
            f"crosswalk: border asymmetry in country metadata ({asymmetry}); "
            f"resolved by union so the adjacency colouring stays safe."
        )

    if unassigned_continent:
        raise CrosswalkError(
            "No continent could be derived for: "
            f"{', '.join(sorted(unassigned_continent))}. Add an explicit "
            "continent_assignments entry for each in "
            "reference/editorial_overrides.json."
        )

    return registry


def _symmetrise_borders(registry: dict[str, Entity]) -> list[str]:
    """Make the border graph undirected by UNION, returning any asymmetries.

    Adjacency feeds the Phase 4 graph-colouring pass, whose acceptance
    criterion is that no country shares a fill with a country it borders. The
    two failure directions are not equally bad:

      - a MISSING edge lets two real neighbours collide -> criterion violated
      - an EXTRA edge merely over-constrains the colouring -> visually harmless

    So we take the union rather than the intersection. Known upstream quirk
    (2026-08-09): Sri Lanka lists India as a neighbour though it is an island
    with no land border. Under union that becomes a spurious LKA-IND
    constraint, which costs nothing, so it is reported rather than hand-edited.
    """
    asymmetries: list[str] = []
    known = set(registry)

    for iso3, entity in registry.items():
        for neighbour in list(entity.borders):
            if neighbour not in known:
                continue
            other = registry[neighbour]
            if iso3 not in other.borders:
                asymmetries.append(f"{iso3}->{neighbour} not mirrored")
                other.borders.append(iso3)

    for entity in registry.values():
        entity.borders = sorted(set(entity.borders))

    return asymmetries


def load_factbook_index(*, refresh: bool = False) -> dict[str, str]:
    """Return {GEC code -> 'region/xx.json'} for the Factbook mirror.

    Deliberately does NOT attempt an ISO3 join. The mirror's filenames are GEC
    codes -- 'ch' is China, 'sw' is Sweden, 'sz' is Switzerland, 'ja' is Japan
    -- so they carry no name information to match on, and a hardcoded GEC table
    is exactly the kind of from-memory data this project refuses to ship.

    The authoritative join lives in sources/factbook.py (Phase 5), which reads
    each file's own 'Government > Country name' block and matches that against
    the registry, reporting every unmatched file rather than dropping it.
    """
    try:
        return _fetch_factbook_index(refresh=refresh)
    except FetchError as exc:
        raise CrosswalkError(
            f"Could not enumerate the Factbook mirror: {exc}"
        ) from exc


# --------------------------------------------------------------------------
# Resolution helpers used by the source modules
# --------------------------------------------------------------------------


def build_alias_map(registry: dict[str, Entity]) -> dict[str, str]:
    """Every string we might see upstream -> canonical ISO3."""
    overrides = load_overrides()
    aliases: dict[str, str] = {}

    strict, loose = build_name_index(registry)

    for iso3, entity in registry.items():
        aliases[iso3.upper()] = iso3
        if entity.iso2:
            aliases[f"ISO2:{entity.iso2.upper()}"] = iso3
        if entity.m49 is not None:
            aliases[f"M49:{entity.m49}"] = iso3

    # Strict names first, then only the loose keys that are unambiguous. The
    # loose folding merges United States with United Kingdom and the two
    # Congos, so an ambiguous key is omitted entirely rather than guessed.
    for key, iso3 in strict.items():
        aliases[f"NAME:{key}"] = iso3
    for key, iso3 in loose.items():
        aliases.setdefault(f"NAMELOOSE:{key}", iso3)

    for raw, canonical in overrides["iso3_aliases"].items():
        if raw.startswith("_"):
            continue
        aliases[raw.upper()] = canonical

    return aliases


def excluded_aggregate_codes() -> set[str]:
    return set(load_overrides()["excluded_aggregates"]["codes"])


def resolve_iso3(
    aliases: dict[str, str],
    *,
    code: str | None = None,
    m49: int | None = None,
    name: str | None = None,
) -> str | None:
    """Resolve an upstream key to canonical ISO3, or None if unknown."""
    if code:
        hit = aliases.get(code.strip().upper())
        if hit:
            return hit
        if len(code.strip()) == 2:
            hit = aliases.get(f"ISO2:{code.strip().upper()}")
            if hit:
                return hit
    if m49 is not None:
        hit = aliases.get(f"M49:{int(m49)}")
        if hit:
            return hit
    if name:
        hit = aliases.get(f"NAME:{normalise_name_strict(name)}")
        if hit:
            return hit
        hit = aliases.get(f"NAMELOOSE:{normalise_name(name)}")
        if hit:
            return hit
    return None


def validate(registry: dict[str, Entity]) -> list[str]:
    """Return a list of human-readable problems. Empty means clean."""
    problems: list[str] = []
    overrides = load_overrides()

    if len(registry) < 240:
        problems.append(
            f"Registry has only {len(registry)} entities; expected 240+."
        )

    un_members = sum(1 for e in registry.values() if e.un_member)
    if un_members != 193:
        problems.append(
            f"UN member count is {un_members}, expected 193. Either REST "
            f"Countries changed its unMember flags or an override is wrong."
        )

    for key in config.CONTINENTS:
        count = sum(1 for e in registry.values() if e.continent == key)
        if count == 0:
            problems.append(f"Continent {key} has no member entities.")

    # Borders must reference entities we actually have, or the adjacency
    # graph-colouring pass in Phase 4 will silently skip constraints.
    known = set(registry)
    for entity in registry.values():
        for neighbour in entity.borders:
            if neighbour not in known:
                problems.append(
                    f"{entity.iso3} lists border {neighbour}, which is not in "
                    f"the registry."
                )

    for entry in overrides["continent_assignments"]:
        if entry["iso3"] not in registry:
            problems.append(
                f"continent_assignments references {entry['iso3']}, which is "
                f"not in the registry (stale override?)."
            )

    for entry in overrides["contested_entities"]:
        if entry["iso3"] not in registry:
            problems.append(
                f"contested_entities references {entry['iso3']}, which failed "
                f"to materialise in the registry."
            )

    return problems


def registry_to_records(registry: dict[str, Entity]) -> list[dict[str, Any]]:
    return [registry[k].to_dict() for k in sorted(registry)]


__all__ = [
    "Entity",
    "CrosswalkError",
    "build_registry",
    "load_factbook_index",
    "build_alias_map",
    "excluded_aggregate_codes",
    "resolve_iso3",
    "normalise_name",
    "normalise_name_strict",
    "build_name_index",
    "validate",
    "registry_to_records",
]
