"""CIA World Factbook ingestion (factbook.json mirror).

Supplies the qualitative country facts: government type, ethnic groups,
religions, languages, industries, agricultural products, trade partners.

THE JOIN
--------
The mirror names files by **GEC code**, a two-letter scheme that is NOT ISO
3166-1 alpha-2: `ch` is China (not Switzerland, which is `sz`), `ja` is Japan
(not Jamaica, which is `jm`), `gm` is Germany (not the Gambia, which is `ga`).
A hardcoded GEC table written from memory would be confidently wrong, so we
read each file's own `Government > Country name` block and match that against
the registry. Every unmatched file is reported, never dropped silently.

PARSING PROSE PERCENTAGES
-------------------------
Composition fields are free text with percentages embedded:

    "White 61.6%, Black or African American 12.4%, ... (2020 est.)"

Splitting on commas naively breaks on labels that contain their own commas
inside parentheses, so the splitter is paren-aware. A segment with no
percentage yields a label with `percent: None` rather than a guessed number.

If NO segment in a field carries a percentage, the field is marked
`chartable: false` and the app renders it as prose. Inventing a breakdown from
an unquantified list is precisely the fabrication the brief forbids.

THE SECTION 0 RULES, ENFORCED HERE
----------------------------------
- Every composition field carries its OWN vintage year, extracted from the
  source text. The three People fields routinely differ by a decade (the US
  is ethnicity 2020, languages 2017, religions 2014), so a single "as of"
  date for the section would be a lie.
- A field the Factbook does not publish emits `available: false` with a
  reason. Never zero, never an empty chart, never an inferred value.
- Percentages are passed through EXACTLY as published. They are never
  normalised to sum to 100, never interpolated, never projected. Where the
  published figures do not sum to ~100 we record that fact and let the app say
  so, because the gap is usually real (overlapping categories, "not stated",
  or a genuinely incomplete census).
- The Factbook's own `note` is preserved verbatim. It frequently carries the
  caveat that makes the numbers interpretable -- for the US, that Hispanic is
  not counted as a separate category.
"""

from __future__ import annotations

import html
import json
import re
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import (
    Entity,
    build_name_index,
    load_factbook_index,
    normalise_name,
    normalise_name_strict,
)
from ..fetch import FetchError, fetch

# Factbook names that do not match any registry name even strictly.
# Keys are STRICT-normalised (accents, case and punctuation only -- no word
# dropping), because the aggressive fold merges distinct countries.
NAME_OVERRIDES: dict[str, str] = {
    "burma": "MMR",
    "turkey": "TUR",                       # registry uses "Turkiye"
    "korea south": "KOR",
    "korea north": "PRK",
    "congo democratic republic of the": "COD",
    "congo republic of the": "COG",
    "gambia the": "GMB",
    "bahamas the": "BHS",
    "micronesia federated states of": "FSM",
    "macau": "MAC",
    "holy see vatican city": "VAT",
    "cote d ivoire": "CIV",
    "falkland islands islas malvinas": "FLK",
    "virgin islands": "VIR",               # the US territory; 'vi' is British
    "british virgin islands": "VGB",
    "west bank": "PSE",
    "gaza strip": "PSE",
    "saint helena ascension and tristan da cunha": "SHN",
    "sint maarten": "SXM",
    "curacao": "CUW",
    "bonaire sint eustatius and saba": "BES",
    "wallis and futuna": "WLF",
    "french southern and antarctic lands": "ATF",
    # SJM is "Svalbard and Jan Mayen". The Factbook splits them into two files;
    # Svalbard holds essentially the whole population, so it wins the entity
    # and Jan Mayen is reported unmatched rather than overwriting it.
    "svalbard": "SJM",
}

# Prefixes used when a Factbook name is a long descriptive phrase. Matched
# against the START of the strict-normalised name.
PREFIX_OVERRIDES: tuple[tuple[str, str], ...] = (
    ("svalbard", "SJM"),
    ("falkland islands", "FLK"),
    ("saint helena", "SHN"),
)

# Files in the mirror that are not countries and must not be joined.
NON_COUNTRY_STEMS = {"xx", "zz", "oo", "ee", "world"}

_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")
# Trailing vintage: "(2020 est.)", "(2023)", "(2014 est.)"
_VINTAGE = re.compile(r"\((\d{4})(?:\s*(est\.?|census))?\s*\)", re.IGNORECASE)
# A segment ending in a percentage, e.g. "Roman Catholic 20.8%".
#
# Matched against a segment with its parentheticals already removed. The
# original pattern anchored the '%' to end-of-segment, which silently dropped
# any category carrying a trailing qualifier -- "Muslim 97.1% (official;
# predominantly Sunni)" parsed as a label with NO percentage, so Jordan lost
# its 97.1% majority, Mozambique its 99%, and Comoros its 98.1%. Always the
# largest group, because that is the one editors annotate.
_PERCENT = re.compile(
    r"^(?P<label>.*?)[\s,]*"
    r"(?P<lt>less than\s+|<\s*)?"
    r"(?P<value>\d+(?:\.\d+)?)\s*%$",
    re.IGNORECASE,
)
_ANY_PERCENT = re.compile(r"\d+(?:\.\d+)?\s*%")
_PARENTHETICAL = re.compile(r"\(([^()]*(?:\([^()]*\)[^()]*)*)\)")

# Fields where shares legitimately exceed 100 because respondents can be
# counted more than once. Sri Lanka's languages sum to 139% (Sinhala 87,
# Tamil 28.5, English 23.8) and that is correct -- people speak several.
OVERLAPPING_BY_NATURE = {"languages"}


def strip_html(text: str) -> str:
    """Remove markup and unescape entities.

    Factbook notes contain <strong>, <b>, <em> and <br>. The app inserts these
    strings as text nodes, but stripping here keeps the artifact clean and
    means no consumer is tempted to render it as HTML.
    """
    return _WS.sub(" ", html.unescape(_TAG.sub(" ", text))).strip()


def extract_vintage(text: str) -> tuple[int | None, str | None]:
    """Pull the observation year out of the prose. Returns (year, qualifier)."""
    matches = _VINTAGE.findall(text)
    if not matches:
        return None, None
    year, qualifier = matches[-1]
    normalised = (qualifier or "").lower().rstrip(".")
    return int(year), (normalised or None)


def split_segments(text: str) -> list[str]:
    """Split on top-level commas and semicolons, ignoring those in brackets."""
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    for char in text:
        if char in "([":
            depth += 1
        elif char in ")]":
            depth = max(0, depth - 1)
        if char in ",;" and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return [p.strip() for p in parts if p.strip()]


def parse_composition(raw_text: str, *, kind: str = "generic") -> dict[str, Any]:
    """Parse a composition field into structured items plus provenance.

    Parentheticals are lifted off each segment before matching. They serve two
    different purposes in the source and both break naive parsing:

      - a qualifier after the figure:  "Muslim 97.1% (official; ...)"
      - a nested breakdown:            "Protestant 5% (Evangelical 4.6%, ...)"

    The first hid the largest category from the parser; the second would be
    double-counted as extra top-level items. Removing them fixes both, and the
    text is preserved on the item as `qualifier`.
    """
    text = strip_html(raw_text)
    year, qualifier = extract_vintage(text)
    body = _VINTAGE.sub("", text).strip().rstrip(",;").strip()

    items: list[dict[str, Any]] = []
    concatenated_segments: list[str] = []

    for segment in split_segments(body):
        notes = [m.group(1).strip() for m in _PARENTHETICAL.finditer(segment)]
        cleaned = _WS.sub(" ", _PARENTHETICAL.sub(" ", segment)).strip(" ,;:")

        # More than one percentage left in a single segment means the source
        # text ran two datasets together without a separator. Uruguay's
        # religions field concatenates two surveys: "...unspecified 3.4% Roman
        # Catholic 42%, Protestant 15%...". Parsing it yields nonsense
        # ("unspecified 3.4% Roman Catholic" = 42%), so the field is flagged
        # and never charted -- this is exactly the "do not blend categories
        # from different sources" rule, tripped inside the source itself.
        if len(_ANY_PERCENT.findall(cleaned)) > 1:
            concatenated_segments.append(segment.strip())

        match = _PERCENT.match(cleaned)
        if match:
            label = match.group("label").strip(" ,;:")
            items.append({
                "label": label or "unspecified",
                "percent": float(match.group("value")),
                # "less than 1%" is an upper bound, not a measurement.
                "isUpperBound": bool(match.group("lt")),
                "official": "official" in segment.lower(),
                "qualifier": "; ".join(notes) or None,
            })
        else:
            # A named category with no published share. Recorded with a null
            # percent so the app can list it without inventing a number.
            items.append({
                "label": cleaned or segment.strip(" ,;:"),
                "percent": None,
                "isUpperBound": False,
                "official": "official" in segment.lower(),
                "qualifier": "; ".join(notes) or None,
            })

    quantified = [i for i in items if i["percent"] is not None]
    total = round(sum(i["percent"] for i in quantified), 2) if quantified else None
    overlapping = kind in OVERLAPPING_BY_NATURE
    malformed = bool(concatenated_segments)

    return {
        "available": bool(items),
        "text": text,
        "vintageYear": year,
        "vintageQualifier": qualifier,
        # Without at least two percentages this is a prose list, and a chart
        # would imply quantities that do not exist. A field whose source text
        # is malformed is likewise never charted.
        "chartable": len(quantified) >= 2 and not malformed,
        "items": items,
        "quantifiedCount": len(quantified),
        "percentTotal": total,
        # Published figures are never rescaled to 100. A gap or overlap is
        # usually real, and the app says so rather than hiding it.
        "sumsToApprox100": (
            None if total is None else bool(97.0 <= total <= 103.0)
        ),
        # Language shares routinely exceed 100 because respondents speak more
        # than one; that is not an error and must not be reported as one.
        "sharesMayOverlap": overlapping,
        "sourceTextMalformed": malformed,
        "malformedReason": (
            "The published text runs two separate surveys together without a "
            "separator, so a breakdown cannot be derived from it reliably. The "
            "original wording is shown instead."
            if malformed
            else None
        ),
        "concatenatedSegments": concatenated_segments or None,
    }


def _text_of(node: Any) -> str | None:
    if isinstance(node, dict):
        value = node.get("text")
        if isinstance(value, str):
            return value
    return None


def _note_of(node: Any) -> str | None:
    if isinstance(node, dict):
        note = node.get("note")
        if isinstance(note, str):
            return strip_html(note)
    return None


def _unavailable(field: str) -> dict[str, Any]:
    return {
        "available": False,
        "unavailableReason": (
            f"The CIA World Factbook does not publish {field} for this entity."
        ),
    }


def _composition_field(
    section: dict[str, Any], key: str, label: str, *, kind: str = "generic"
) -> dict[str, Any]:
    node = section.get(key)
    raw = _text_of(node)
    if not raw:
        return _unavailable(label)
    parsed = parse_composition(raw, kind=kind)
    parsed["note"] = _note_of(node)
    return parsed


def _plain_field(section: dict[str, Any], key: str, label: str) -> dict[str, Any]:
    node = section.get(key)
    raw = _text_of(node)
    if not raw:
        return _unavailable(label)
    text = strip_html(raw)
    year, qualifier = extract_vintage(text)
    return {
        "available": True,
        "text": text,
        "vintageYear": year,
        "vintageQualifier": qualifier,
        "note": _note_of(node),
    }


def _list_field(section: dict[str, Any], key: str, label: str) -> dict[str, Any]:
    """A comma-separated prose list (industries, crops, commodities)."""
    node = section.get(key)
    raw = _text_of(node)
    if not raw:
        return _unavailable(label)
    text = strip_html(raw)
    year, qualifier = extract_vintage(text)
    body = _VINTAGE.sub("", text).strip().rstrip(",;").strip()
    return {
        "available": True,
        "text": text,
        "items": split_segments(body),
        "vintageYear": year,
        "vintageQualifier": qualifier,
        "note": _note_of(node),
    }


def _country_names(document: dict[str, Any]) -> list[str]:
    government = document.get("Government") or {}
    block = government.get("Country name") or {}
    names: list[str] = []
    for key in (
        "conventional short form",
        "conventional long form",
        "local short form",
    ):
        value = _text_of(block.get(key))
        if value and value.lower() not in {"none", "n/a"}:
            names.append(value)
    return names


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    out_dir = config.DATA_DIR / "factbook"
    out_dir.mkdir(parents=True, exist_ok=True)

    index = load_factbook_index(refresh=refresh)

    # Strict index first; the loose index only contains keys that fold onto
    # exactly one entity, so an ambiguous name misses rather than mis-joins.
    strict_index, loose_index = build_name_index(registry)

    matched: dict[str, str] = {}
    unmatched: list[str] = []
    responses = []

    for gec, path in sorted(index.items()):
        if gec in NON_COUNTRY_STEMS:
            continue
        response = fetch(
            f"{config.FACTBOOK_BASE}/{path}",
            refresh=refresh,
            subdir="factbook/countries",
            filename=f"{gec}.json",
            expect_json=True,
        )
        responses.append(response)
        document = response.read_json()

        iso3 = None
        for name in _country_names(document):
            strict = normalise_name_strict(name)
            iso3 = (
                NAME_OVERRIDES.get(strict)
                or strict_index.get(strict)
                or next(
                    (v for p, v in PREFIX_OVERRIDES if strict.startswith(p)),
                    None,
                )
                or loose_index.get(normalise_name(name))
            )
            if iso3:
                break
        if not iso3:
            names = _country_names(document)
            unmatched.append(f"{path} ({names[0] if names else 'no name'})")
            continue
        if iso3 in matched:
            # Two Factbook files map to one entity -- West Bank and Gaza Strip
            # both resolve to Palestine. Keep the first and record the second
            # rather than silently overwriting.
            unmatched.append(f"{path} -> {iso3} already taken by {matched[iso3]}")
            continue
        matched[iso3] = path

        people = document.get("People and Society") or {}
        government = document.get("Government") or {}
        economy = document.get("Economy") or {}
        capital = government.get("Capital") or {}
        executive = government.get("Executive branch") or {}
        legislative = government.get("Legislative branch") or {}

        record = {
            "iso3": iso3,
            "name": registry[iso3].name_common,
            "source": "cia_factbook",
            "factbookGec": gec,
            "factbookPath": path,
            # -- People: each field carries its OWN vintage. They routinely
            #    differ by a decade within one country.
            "people": {
                "ethnicGroups": _composition_field(
                    people, "Ethnic groups", "ethnic group composition",
                    kind="ethnicGroups",
                ),
                "religions": _composition_field(
                    people, "Religions", "religious composition",
                    kind="religions",
                ),
                "languages": _composition_field(
                    people, "Languages", "language composition",
                    kind="languages",
                ),
            },
            "government": {
                "governmentType": _plain_field(
                    government, "Government type", "government type"
                ),
                "capital": (
                    {"available": True, "text": strip_html(_text_of(capital.get("name")) or "")}
                    if _text_of(capital.get("name"))
                    else _unavailable("a capital")
                ),
                "independence": _plain_field(
                    government, "Independence", "an independence date"
                ),
                "legislatureName": _plain_field(
                    legislative, "legislature name", "a legislature name"
                ),
                "legislativeStructure": _plain_field(
                    legislative, "legislative structure", "a legislative structure"
                ),
                "chiefOfState": _plain_field(
                    executive, "chief of state", "a chief of state"
                ),
                "headOfGovernment": _plain_field(
                    executive, "head of government", "a head of government"
                ),
            },
            "economy": {
                "industries": _list_field(economy, "Industries", "major industries"),
                "agriculturalProducts": _list_field(
                    economy, "Agricultural products", "agricultural products"
                ),
                "exportCommodities": _list_field(
                    economy, "Exports - commodities", "export commodities"
                ),
                "exportPartners": _composition_field(
                    economy, "Exports - partners", "export partners"
                ),
                "importPartners": _composition_field(
                    economy, "Imports - partners", "import partners"
                ),
            },
        }

        (out_dir / f"{iso3}.json").write_text(
            json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n",
            encoding="utf-8", newline="\n",
        )

    # Registry entities the Factbook has no file for.
    missing = sorted(set(registry) - set(matched))

    coverage = {
        "matched": len(matched),
        "filesUnmatched": len(unmatched),
        "entitiesWithoutFactbook": missing,
    }
    (out_dir / "coverage.json").write_text(
        json.dumps(
            {
                "note": (
                    "Factbook files are named by GEC code, which is not ISO "
                    "3166-1 alpha-2. The join reads each file's own country "
                    "name rather than relying on a hardcoded code table."
                ),
                **coverage,
                "unmatchedFiles": unmatched,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8", newline="\n",
    )

    latest_fetch = max(r.fetched_at for r in responses) if responses else None
    manifest_mod.record_source(
        manifest,
        "cia_factbook",
        title="CIA World Factbook (factbook.json mirror)",
        url="https://github.com/factbook/factbook.json",
        licence="Public domain (US Government work)",
        fetched_at=latest_fetch or manifest["generated_at"],
        upstream_release=responses[0].upstream_release if responses else None,
        vintage="per field; each composition figure carries its own census or estimate year",
        citation="Central Intelligence Agency, The World Factbook",
        notes=(
            f"Joined to ISO3 by country name read from each file, not by GEC "
            f"code. {len(matched)} entities matched. Composition percentages "
            f"are passed through exactly as published -- never rescaled to 100, "
            f"never interpolated, never projected. Fields with no published "
            f"percentage are marked non-chartable and render as prose."
        ),
    )
    manifest_mod.record_artifact(
        manifest, "factbook/<ISO3>.json",
        description=(
            "Qualitative country facts: government, people composition, "
            "industries and trade, each field with its own vintage."
        ),
        sources=["cia_factbook"], entity_count=len(matched),
    )

    if unmatched:
        manifest_mod.add_warning(
            manifest,
            f"{len(unmatched)} Factbook files could not be joined to a "
            f"registry entity and were skipped: "
            f"{', '.join(unmatched[:12])}"
            + ("..." if len(unmatched) > 12 else "")
        )
    if missing:
        manifest_mod.add_warning(
            manifest,
            f"{len(missing)} entities have no Factbook entry; their People, "
            f"Government and industry sections render as not published: "
            f"{', '.join(missing[:15])}"
            + ("..." if len(missing) > 15 else "")
        )

    print(f"    matched {len(matched)} entities, "
          f"{len(unmatched)} files unmatched, "
          f"{len(missing)} entities without a Factbook entry")


__all__ = ["ingest", "parse_composition", "strip_html", "extract_vintage"]
