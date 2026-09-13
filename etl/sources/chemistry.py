"""Chemistry: the periodic table of the elements (round 3, Phase 7, §47).

One record per element (118), every figure carrying {value, unit, source,
vintage} and, when the value is null, a reason. Sources, all keyless:

- PubChem Periodic Table JSON (NIH): bulk properties — atomic mass,
  electron configuration, electronegativity, van der Waals radius, first
  ionization energy, electron affinity, oxidation states, standard state,
  melting/boiling point, density, group block, year discovered.
- PubChem PUG-View element records: the per-statement-sourced prose
  sections (uses, history, biological role, hazards ...) and the
  references PubChem itself cites for each property. PubChem's PUG-View
  throttles hard (HTTP 503 "ServerBusy"); with CHEMISTRY_PUGVIEW_CACHED_ONLY=1
  the stage uses whatever records are cached and records a manifest
  warning for the rest instead of aborting (the LEADERS_CACHED_ONLY
  pattern).
- NIST Atomic Spectra Database (ASD) ionization energies, tab output:
  the first three ionization energies in eV with uncertainties.
- CIAAW standard atomic weights: IUPAC's own table, with interval and
  bracket notation preserved verbatim.
- Wikidata: P18 image, P373 Commons category, P575/P61/P189 discovery
  date/discoverer/place, P138 named after, P231 CAS number, enwiki title.
- Wikipedia data pages that reproduce CRC Handbook tabulations, named as
  such: crustal abundance (C1 = CRC Handbook) and Solar-System abundance
  (Y2 = Anders & Grevesse 1989) from "Abundances of the elements (data
  page)"; thermal conductivities, heat capacities, electrical
  resistivities and atomic radii from their data pages; group / period /
  block / origin / phase from "List of chemical elements"; name origins
  from "List of chemical element name etymologies"; crystal structure and
  magnetic ordering from each element's infobox template.
- Wikipedia article text (CC BY-SA, attributed): the lead as the
  description; the applications / biological role / precautions sections
  as the fallback when PubChem carries no such section.
- IAEA Nuclear Data Section Live Chart API (NUBASE2020/ENSDF ground
  states): known and stable isotope counts, natural abundances,
  half-lives.
- Wikimedia Commons: element photographs through the licence gate
  (PD / CC0 / CC BY / CC BY-SA / Free Art License; never NC or ND),
  downloaded and served locally with author, licence and file page.

The Royal Society of Chemistry periodic table was inspected and NOT
scraped: periodic-table.rsc.org carries an RSC copyright notice and no
reuse licence. It is linked from the panel as a further reading only.
"""

from __future__ import annotations

import csv
import hashlib
import html
import io
import json
import os
import re
import shutil
import time
import urllib.parse
from typing import Any

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch, is_cached
from . import commons

_SUBDIR = "chemistry"
_GLOSSARY_PATH = config.REFERENCE_DIR / "chemistry_glossary.json"
_SAMPLES_PATH = config.REFERENCE_DIR / "chemistry_samples.json"
_PROPERTIES_PATH = config.REPO_ROOT / "src" / "data" / "chemistry-properties.json"
_PUGVIEW_CACHED_ONLY = os.environ.get("CHEMISTRY_PUGVIEW_CACHED_ONLY") == "1"

# Source URLs live here rather than in etl/config.py: this stage was built
# while other stages were being added to config.py concurrently, and every
# constant is used by this module alone.
PUBCHEM_TABLE_URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/periodictable/JSON"
PUGVIEW_URL = "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/element/{z}/JSON"
NIST_IE_URL = (
    "https://physics.nist.gov/cgi-bin/ASD/ie.pl?spectra=H-Og&submit=Retrieve+Data"
    "&units=1&format=3&order=0&at_num_out=on&sp_name_out=on&ion_charge_out=on"
    "&el_name_out=on&seq_out=on&shells_out=on&conf_out=on&level_out=on"
    "&ion_conf_out=on&e_out=0&unc_out=on&biblio=on"
)
CIAAW_URL = "https://ciaaw.org/atomic-weights.htm"
IAEA_URL = "https://nds.iaea.org/relnsd/v1/data?fields=ground_states&nuclides=all"
WIKIDATA_ELEMENTS_QUERY = """
SELECT ?el ?z ?sym ?img ?cat ?disc ?discPrec ?discoverer ?discovererLabel
       ?place ?placeLabel ?named ?namedLabel ?cas ?enwiki WHERE {
  ?el wdt:P31 wd:Q11344; wdt:P1086 ?z; wdt:P246 ?sym.
  OPTIONAL { ?el wdt:P18 ?img }
  OPTIONAL { ?el wdt:P373 ?cat }
  OPTIONAL { ?el p:P575 ?ds. ?ds psv:P575 ?dv.
             ?dv wikibase:timeValue ?disc; wikibase:timePrecision ?discPrec }
  OPTIONAL { ?el wdt:P61 ?discoverer }
  OPTIONAL { ?el wdt:P189 ?place }
  OPTIONAL { ?el wdt:P138 ?named }
  OPTIONAL { ?el wdt:P231 ?cas }
  OPTIONAL { ?enwiki schema:about ?el; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?z
"""
WIKIDATA_FACILITIES_QUERY = """
SELECT ?i ?iLabel ?img WHERE {{
  VALUES ?i {{ {values} }}
  OPTIONAL {{ ?i wdt:P18 ?img }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
"""
WP_PAGES = {
    "list": "List of chemical elements",
    "abundance": "Abundances of the elements (data page)",
    "thermal": "Thermal conductivities of the elements (data page)",
    "heat": "Heat capacities of the elements (data page)",
    "resistivity": "Electrical resistivities of the elements (data page)",
    "radii": "Atomic radii of the elements (data page)",
    "etymology": "List of chemical element name etymologies",
}
RSC_URL = "https://periodic-table.rsc.org/"

# Licence gate. The famous element photographs on Commons (Alchemist-hp,
# Hi-Res Images of Chemical Elements) are under the Free Art License, a
# copyleft free licence the history/evolution regex did not anticipate; it
# is accepted here explicitly. NC and ND stay out.
_FREE = re.compile(
    r"public domain|cc0|cc[- ]by(?![- ]n[cd])|pd-|\bFAL\b|free art licen[cs]e",
    re.IGNORECASE,
)

CATEGORY_LABELS = {
    "alkaliMetal": "Alkali metal",
    "alkalineEarthMetal": "Alkaline earth metal",
    "transitionMetal": "Transition metal",
    "postTransitionMetal": "Post-transition metal",
    "metalloid": "Metalloid",
    "reactiveNonmetal": "Reactive nonmetal",
    "nobleGas": "Noble gas",
    "lanthanide": "Lanthanide",
    "actinide": "Actinide",
    "unknown": "Unknown properties",
}
_PUBCHEM_CATEGORY = {
    "Alkali metal": "alkaliMetal",
    "Alkaline earth metal": "alkalineEarthMetal",
    "Transition metal": "transitionMetal",
    "Post-transition metal": "postTransitionMetal",
    "Metalloid": "metalloid",
    "Nonmetal": "reactiveNonmetal",
    "Halogen": "reactiveNonmetal",
    "Noble gas": "nobleGas",
    "Lanthanide": "lanthanide",
    "Actinide": "actinide",
}
# Chemistry of 109-118 is unconfirmed: a handful of atoms each, no bulk
# properties measured. PubChem's block label is kept in the note.
_UNKNOWN_FROM_Z = 109

_SHELL_ORDER = "spdf"


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------

def fig(value: Any, unit: str | None, source: str, vintage: str | None,
        *, note: str | None = None, reason: str | None = None) -> dict[str, Any]:
    """The one figure shape: {value, unit, source, vintage[, note][, reason]}."""
    out: dict[str, Any] = {"value": value, "unit": unit, "source": source,
                           "vintage": vintage}
    if note:
        out["note"] = note
    if value is None:
        out["reason"] = reason or "not published by the source"
    return out


def round_sig(value: float | None, sig: int = 4) -> float | None:
    """Round to SIGNIFICANT figures, not decimal places — a fixed-decimal
    round() crushes a real but tiny value (e.g. sulfur's ~5e-16 S/m
    electrical conductivity) to 0.0, which this site's gate treats as a
    dishonest zero standing in for an absent figure. See §47.2."""
    if value is None or value == 0:
        return value
    import math
    digits = sig - int(math.floor(math.log10(abs(value)))) - 1
    return round(value, digits)


def _text(cell: str) -> str:
    t = re.sub(r"<[^>]+>", "", cell)
    t = html.unescape(t).replace("\xa0", " ").replace(" ", " ")
    t = t.replace("⁠", "")
    return re.sub(r"\s+", " ", t).strip()


def _strip_footnotes(t: str) -> str:
    return re.sub(r"\[[^\]]*\]", "", t).strip()


def parse_number(text: str | None) -> tuple[float | None, dict[str, bool]]:
    """(value, flags) from a table cell like '1.40×10−3', '~ 3×10−9',
    '(7.1–7.3)', '92.8 nΩm'. Flags: approx, predicted (parenthesised)."""
    flags = {"approx": False, "predicted": False}
    if text is None:
        return None, flags
    t = _strip_footnotes(_text(text)).replace("−", "-").replace("–", "-")
    if not t or t in ("-", "—", "n/a", "N/A"):
        return None, flags
    if t.startswith("~"):
        flags["approx"] = True
    if t.startswith("(") and ")" in t:
        flags["predicted"] = True
    t = t.replace(",", "")
    m = re.search(r"(-?\d+(?:\.\d+)?)\s*(?:[×x]\s*10\s*\^?\s*(-?\s*\d+))?", t)
    if not m:
        return None, flags
    value = float(m.group(1))
    if m.group(2):
        value *= 10 ** int(m.group(2).replace(" ", ""))
    return value, flags


def _rows(table_html: str) -> list[list[str]]:
    out = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table_html, re.S):
        cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.S)
        out.append([_text(c) for c in cells])
    return out


def _tables(page_html: str) -> list[str]:
    """Top-level wikitables, with BALANCED table tags: the etymology list
    nests tables inside cells, which a non-greedy `<table>.*?</table>`
    silently truncates to its first nested table (11 of 118 rows)."""
    out: list[str] = []
    for start in re.finditer(r'<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>', page_html):
        depth = 0
        pos = start.start()
        for tag in re.finditer(r"<table\b|</table\s*>", page_html[pos:]):
            depth += 1 if tag.group(0).startswith("<table") else -1
            if depth == 0:
                out.append(page_html[start.end():pos + tag.start()])
                break
    return out


def _rows_top(table_html: str) -> list[list[str]]:
    """Rows of a table whose cells may contain nested tables: nested
    <table> blocks are removed before the cell split."""
    stripped = re.sub(r"<table\b.*?</table\s*>", "", table_html, flags=re.S)
    return _rows(stripped)


def _ymd(iso: str) -> str:
    return iso[:10]


def clean_wikitext(s: str) -> str:
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    s = re.sub(r"<ref[^>]*/\s*>", "", s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"\{\{val\|([^|}]+)(?:\|[^}]*)?\}\}", r"\1", s)
    s = re.sub(r"\{\{nowrap\|([^}]*)\}\}", r"\1", s)
    s = re.sub(r"\{\{e\|([^}]*)\}\}", r"×10^\1", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[https?://\S+\s*([^\]]*)\]", r"\1", s)
    s = s.replace("'''", "").replace("''", "")
    s = re.sub(r"<br\s*/?>", "; ", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s).replace("\xa0", " ").replace(" ", " ")
    return re.sub(r"\s+", " ", s).strip(" ;")


def parse_infobox_fields(wikitext: str) -> dict[str, str]:
    """`|key=value` pairs of an infobox template, splitting only at a
    line-leading pipe OUTSIDE {{ }} and <ref> (cite templates inside refs
    have their own pipes on their own lines)."""
    body_start = wikitext.find("{{infobox element")
    if body_start == -1:
        body_start = wikitext.lower().find("{{infobox element")
    text = wikitext[body_start:] if body_start != -1 else wikitext
    fields: dict[str, str] = {}
    depth = 0
    in_ref = False
    current: list[str] = []
    pieces: list[str] = []
    i = 0
    lower = text.lower()
    while i < len(text):
        two = text[i:i + 2]
        if two == "{{":
            depth += 1
            current.append(two)
            i += 2
            continue
        if two == "}}":
            depth = max(0, depth - 1)
            current.append(two)
            i += 2
            continue
        if lower.startswith("<ref", i) and not lower.startswith("<ref", i + 1):
            close = text.find(">", i)
            in_ref = close != -1 and not text[i:close + 1].rstrip(">").endswith("/")
        elif lower.startswith("</ref>", i):
            in_ref = False
        if text[i] == "\n" and text[i + 1:i + 2] == "|" and depth <= 1 and not in_ref:
            pieces.append("".join(current))
            current = []
            i += 2
            continue
        current.append(text[i])
        i += 1
    pieces.append("".join(current))
    for piece in pieces[1:]:
        if "=" not in piece:
            continue
        key, _, value = piece.partition("=")
        fields[key.strip().lower()] = value.strip()
    return fields


def _first_sentences(text: str, limit: int = 480, max_sentences: int = 3) -> str | None:
    t = " ".join((text or "").split())
    if not t:
        return None
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])", t)
    out = ""
    for part in parts[:max_sentences]:
        candidate = f"{out} {part}".strip()
        if len(candidate) > limit and out:
            break
        out = candidate
        if len(out) > limit:
            break
    if len(out) > limit:
        out = out[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return out or None


# --------------------------------------------------------------------------
# PubChem
# --------------------------------------------------------------------------

def _pubchem_table(refresh: bool) -> tuple[dict[int, dict[str, str]], CachedResponse]:
    response = fetch(PUBCHEM_TABLE_URL, refresh=refresh, subdir=_SUBDIR,
                     filename="pubchem-periodictable.json", expect_json=True)
    table = response.read_json()["Table"]
    columns = table["Columns"]["Column"]
    out: dict[int, dict[str, str]] = {}
    for row in table["Row"]:
        record = dict(zip(columns, row["Cell"]))
        out[int(record["AtomicNumber"])] = record
    if len(out) != 118:
        raise FetchError(f"PubChem periodic table has {len(out)} rows, expected 118")
    return out, response


def _pugview_record(z: int, refresh: bool) -> tuple[dict[str, Any] | None, CachedResponse | None]:
    url = PUGVIEW_URL.format(z=z)
    name = f"pugview-{z:03d}.json"
    cached = is_cached(url, subdir=_SUBDIR, filename=name)
    if _PUGVIEW_CACHED_ONLY and not cached:
        return None, None
    try:
        response = fetch(url, refresh=refresh, subdir=_SUBDIR, filename=name,
                         expect_json=True)
    except FetchError as exc:
        if _PUGVIEW_CACHED_ONLY:
            return None, None
        raise FetchError(
            f"PubChem PUG-View element {z}: {exc}. PubChem answers HTTP 503 "
            f"'PUGVIEW.ServerBusy' when it throttles; re-run later, or set "
            f"CHEMISTRY_PUGVIEW_CACHED_ONLY=1 to build from cached records "
            f"with the gaps recorded as manifest warnings."
        ) from exc
    if not cached:
        time.sleep(0.4)  # ~2.5 req/s, half PubChem's stated ceiling
    return response.read_json(), response


def _pv_walk(section: dict[str, Any]):
    yield section
    for child in section.get("Section", []) or []:
        yield from _pv_walk(child)


def _pv_strings(info: dict[str, Any]) -> list[str]:
    value = info.get("Value") or {}
    out: list[str] = []
    for item in value.get("StringWithMarkup", []) or []:
        s = item.get("String")
        if s:
            out.append(s)
    for key in ("Number",):
        if key in value:
            nums = value[key]
            unit = value.get("Unit", "")
            out.append(" ".join(f"{n} {unit}".strip() for n in nums))
    return out


def _pv_extract(record: dict[str, Any]) -> dict[str, Any]:
    """Sourced prose sections and per-property references from a PUG-View
    element record. Heading names are matched by keyword so a renamed
    section degrades to 'absent' rather than crashing."""
    refs = {r.get("ReferenceNumber"): r for r in record.get("Reference", []) or []}
    prose: dict[str, dict[str, Any]] = {}
    property_refs: dict[str, list[str]] = {}
    wanted_prose = {
        "uses": ("uses", "use and manufacturing", "applications"),
        "biologicalRole": ("biolog",),
        "hazards": ("hazard", "toxic", "safety", "health"),
        "history": ("history",),
        "etymology": ("name origin", "etymolog", "origin of name"),
        "description": ("description",),
    }
    wanted_props = {
        "Atomic Mass": "atomicMass", "Electron Configuration": "electronConfiguration",
        "Electronegativity": "electronegativity", "Atomic Radius": "atomicRadius",
        "Ionization Energy": "ionizationEnergy", "Electron Affinity": "electronAffinity",
        "Oxidation States": "oxidationStates", "Standard State": "standardState",
        "Melting Point": "meltingPoint", "Boiling Point": "boilingPoint",
        "Density": "density", "Year Discovered": "yearDiscovered",
        "Atomic Weight": "atomicMass",
    }
    for section in _pv_walk({"Section": record.get("Section", [])}):
        heading = (section.get("TOCHeading") or "").strip()
        if not heading:
            continue
        low = heading.lower()
        infos = section.get("Information", []) or []
        if heading in wanted_props:
            names = []
            for info in infos:
                ref = refs.get(info.get("ReferenceNumber"))
                if ref and ref.get("SourceName"):
                    names.append(ref["SourceName"])
            if names:
                property_refs.setdefault(wanted_props[heading], [])
                for n in names:
                    if n not in property_refs[wanted_props[heading]]:
                        property_refs[wanted_props[heading]].append(n)
        for key, needles in wanted_prose.items():
            if key in prose or not any(n in low for n in needles):
                continue
            texts: list[str] = []
            sources: list[dict[str, str | None]] = []
            for info in infos:
                strings = _pv_strings(info)
                if not strings:
                    continue
                texts.extend(strings)
                ref = refs.get(info.get("ReferenceNumber"))
                if ref:
                    entry = {"name": ref.get("SourceName"), "url": ref.get("URL")}
                    if entry not in sources:
                        sources.append(entry)
            if texts:
                prose[key] = {
                    "text": _first_sentences(" ".join(texts), 520, 4),
                    "heading": heading,
                    "sources": sources,
                }
    return {"prose": prose, "propertyRefs": property_refs}


# --------------------------------------------------------------------------
# NIST ASD ionization energies
# --------------------------------------------------------------------------

def _nist_ionization(refresh: bool) -> tuple[dict[int, list[dict[str, Any]]], CachedResponse]:
    response = fetch(NIST_IE_URL, refresh=refresh, subdir=_SUBDIR,
                     filename="nist-asd-ionization.tsv")
    text = response.read_text()
    out: dict[int, list[dict[str, Any]]] = {}
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    header = next(reader)
    idx = {name.strip(): i for i, name in enumerate(header)}
    col_z = idx.get("At. num")
    col_charge = idx.get("Ion Charge")
    col_e = next((i for n, i in idx.items() if n.startswith("Ionization Energy")), None)
    col_u = next((i for n, i in idx.items() if n.startswith("Uncertainty")), None)
    col_prefix = idx.get("Prefix")
    if None in (col_z, col_charge, col_e):
        raise FetchError(f"NIST ASD tab output has unexpected columns: {header}")
    for row in reader:
        if len(row) <= col_e:
            continue
        try:
            z = int(row[col_z].strip('"'))
            charge = int(row[col_charge].strip('"').replace("+", "") or 0)
            energy = float(row[col_e].strip('"'))
        except ValueError:
            continue
        if charge > 2:
            continue
        unc = row[col_u].strip('"') if col_u is not None and col_u < len(row) else ""
        prefix = row[col_prefix].strip('"') if col_prefix is not None else ""
        entry: dict[str, Any] = {"charge": charge, "eV": energy}
        if unc:
            try:
                entry["uncertainty"] = float(unc)
            except ValueError:
                pass
        if prefix in ("(", "["):
            # ASD's own convention: ( ) interpolated/extrapolated, [ ] theoretical.
            entry["qualifier"] = "interpolated" if prefix == "(" else "theoretical"
        out.setdefault(z, []).append(entry)
    for z, entries in out.items():
        entries.sort(key=lambda e: e["charge"])
    if len(out) < 100:
        raise FetchError(f"NIST ASD returned ionization energies for only {len(out)} elements")
    return out, response


# --------------------------------------------------------------------------
# CIAAW
# --------------------------------------------------------------------------

def _ciaaw(refresh: bool) -> tuple[dict[int, dict[str, Any]], str | None, CachedResponse]:
    response = fetch(CIAAW_URL, refresh=refresh, subdir=_SUBDIR, filename="ciaaw-atomic-weights.html")
    page = response.read_text(encoding="utf-8")
    table = re.search(r'<table id="mytable".*?</table>', page, re.S)
    if not table:
        raise FetchError("CIAAW atomic-weights page: table not found; layout changed")
    out: dict[int, dict[str, Any]] = {}
    for row in _rows(table.group(0)):
        if len(row) < 4 or not row[0].isdigit():
            continue
        z = int(row[0])
        raw = row[3].strip()
        compact = re.sub(r"(?<=\d) (?=\d)", "", raw)  # "1.007 84" -> "1.00784"
        entry: dict[str, Any] = {"text": compact, "notes": row[4] if len(row) > 4 else ""}
        interval = re.match(r"\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]", compact)
        bracket = re.match(r"\[\s*(\d+)\s*\]", compact)
        unc = re.match(r"([\d.]+)\((\d+)\)", compact)
        if interval:
            entry["kind"] = "interval"
            entry["low"], entry["high"] = float(interval.group(1)), float(interval.group(2))
        elif bracket:
            entry["kind"] = "mostStableIsotope"
            entry["massNumber"] = int(bracket.group(1))
        elif unc:
            entry["kind"] = "value"
            entry["numeric"] = float(unc.group(1))
        else:
            plain = re.match(r"([\d.]+)$", compact)
            if plain:
                entry["kind"] = "value"
                entry["numeric"] = float(plain.group(1))
            else:
                entry["kind"] = "none"
        out[z] = entry
    if len(out) < 110:
        raise FetchError(f"CIAAW table parsed {len(out)} rows, expected ~118")
    text = _text(page)
    m = re.search(r"(20\d\d) and these revisions are included", text)
    vintage = m.group(1) if m else None
    return out, vintage, response


# --------------------------------------------------------------------------
# Wikidata
# --------------------------------------------------------------------------

def _sparql(query: str, *, refresh: bool, name: str) -> tuple[list[dict[str, Any]], CachedResponse]:
    digest = hashlib.sha256(query.encode("utf-8")).hexdigest()[:12]
    url = f"{config.WIKIDATA_SPARQL}?format=json&query={urllib.parse.quote(query)}"
    response = fetch(url, refresh=refresh, subdir=_SUBDIR,
                     filename=f"{name}-{digest}.json", expect_json=True,
                     headers={"Accept": "application/sparql-results+json"})
    return response.read_json()["results"]["bindings"], response


def _wikidata_elements(refresh: bool) -> tuple[dict[int, dict[str, Any]], CachedResponse]:
    rows, response = _sparql(WIKIDATA_ELEMENTS_QUERY, refresh=refresh, name="wikidata-elements")
    out: dict[int, dict[str, Any]] = {}
    for r in rows:
        z = int(r["z"]["value"])
        if z > 118:
            continue  # Wikidata also has items for hypothetical elements 119+
        rec = out.setdefault(z, {
            "qid": r["el"]["value"].rsplit("/", 1)[-1], "images": [], "categories": set(),
            "discovery": [], "discoverers": [], "places": [], "named": [], "cas": [],
            "enwiki": None,
        })
        if "img" in r:
            name = commons.filename_from_special_path(r["img"]["value"])
            if name and name not in rec["images"]:
                rec["images"].append(name)
        if "cat" in r:
            rec["categories"].add(r["cat"]["value"])
        if "disc" in r:
            entry = (r["disc"]["value"], int(r["discPrec"]["value"]))
            if entry not in rec["discovery"]:
                rec["discovery"].append(entry)
        for key, target in (("discoverer", "discoverers"), ("place", "places"), ("named", "named")):
            if key in r and "genid" not in r[key]["value"]:
                label = r.get(f"{key}Label", {}).get("value")
                if label and not label.startswith("Q") and label not in rec[target]:
                    rec[target].append(label)
        if "cas" in r and r["cas"]["value"] not in rec["cas"]:
            rec["cas"].append(r["cas"]["value"])
        if "enwiki" in r and not rec["enwiki"]:
            rec["enwiki"] = urllib.parse.unquote(r["enwiki"]["value"].rsplit("/", 1)[-1]).replace("_", " ")
    if len(out) < 118:
        raise FetchError(f"Wikidata returned {len(out)} elements, expected 118")
    return out, response


def _wikidata_facilities(qids: list[str], refresh: bool) -> tuple[dict[str, dict[str, Any]], CachedResponse | None]:
    if not qids:
        return {}, None
    query = WIKIDATA_FACILITIES_QUERY.format(values=" ".join(f"wd:{q}" for q in sorted(qids)))
    rows, response = _sparql(query, refresh=refresh, name="wikidata-facilities")
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        qid = r["i"]["value"].rsplit("/", 1)[-1]
        rec = out.setdefault(qid, {"label": r.get("iLabel", {}).get("value"), "image": None})
        if "img" in r and not rec["image"]:
            rec["image"] = commons.filename_from_special_path(r["img"]["value"])
    return out, response


# --------------------------------------------------------------------------
# Wikipedia pages
# --------------------------------------------------------------------------

def _wp_parse(title: str, refresh: bool) -> tuple[str, CachedResponse]:
    url = (
        f"{config.WIKIPEDIA_API_URL}?action=parse&format=json&prop=text"
        f"&redirects=1&page={urllib.parse.quote(title)}"
    )
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    response = fetch(url, refresh=refresh, subdir=_SUBDIR,
                     filename=f"wp-{slug}.json", expect_json=True)
    if not response.from_cache:
        time.sleep(1.0)
    return response.read_json()["parse"]["text"]["*"], response


def _wp_list(page: str) -> dict[int, dict[str, Any]]:
    """List of chemical elements: Z, group, period, block, origin, phase,
    crust abundance (mg/kg), specific heat (J/g·K) for every element."""
    tables = _tables(page)
    if not tables:
        raise FetchError("List of chemical elements: no wikitable")
    out: dict[int, dict[str, Any]] = {}
    for row in _rows(tables[0]):
        if len(row) < 16 or not row[0].isdigit():
            continue
        z = int(row[0])
        group, _ = parse_number(row[4])
        period, _ = parse_number(row[5])
        crust, crust_flags = parse_number(row[13])
        heat, _ = parse_number(row[11])
        out[z] = {
            "group": int(group) if group else None,
            "period": int(period) if period else None,
            "block": _strip_footnotes(row[6]).replace("-block", "").strip() or None,
            "origin": _strip_footnotes(row[14]).strip() or None,
            "phase": _strip_footnotes(row[15]).strip() or None,
            "crust_mgkg": crust,
            "crust_flags": crust_flags,
            "specificHeat": heat,
        }
    if len(out) != 118:
        raise FetchError(f"List of chemical elements parsed {len(out)} rows, expected 118")
    return out


def _wp_abundance(page: str) -> dict[int, dict[str, Any]]:
    tables = _tables(page)
    crust_table = solar_table = None
    for t in tables:
        rows = _rows(t)
        if rows and "C1" in rows[0] and "U2" in rows[0]:
            crust_table = rows
        elif rows and "Y2" in rows[0]:
            solar_table = rows
    if crust_table is None or solar_table is None:
        raise FetchError("Abundances data page: crust (C1) or solar-system (Y2) table not found")
    out: dict[int, dict[str, Any]] = {}
    c1 = crust_table[0].index("C1")
    for row in crust_table[1:]:
        m = re.match(r"(\d+)\s", row[0]) if row else None
        if not m:
            continue
        value, flags = parse_number(row[c1]) if len(row) > c1 else (None, {})
        out.setdefault(int(m.group(1)), {})["crust_kgkg"] = value
    y2 = solar_table[0].index("Y2")
    for row in solar_table[1:]:
        m = re.match(r"(\d+)\s", row[0]) if row else None
        if not m:
            continue
        cell = row[y2] if len(row) > y2 else ""
        cell = re.sub(r"\([^)]*\)", "", cell).replace("*", "")
        value, _ = parse_number(cell)
        out.setdefault(int(m.group(1)), {})["solar_si"] = value
    return out


def _wp_thermal(page: str) -> dict[int, float]:
    out: dict[int, float] = {}
    for row in _rows(_tables(page)[0]):
        if len(row) < 4 or not row[0].isdigit():
            continue
        cell = _strip_footnotes(row[3])
        value, _ = parse_number(cell)
        if value is None:
            continue
        if re.search(r"\bmW", cell):
            value /= 1000.0
        elif re.search(r"\bkW", cell):
            value *= 1000.0
        out[int(row[0])] = value
    return out


def _wp_grouped(page: str, use_index: int, kind: str) -> dict[int, tuple[float, str]]:
    """Heat-capacity and resistivity pages: an element header row, then a
    'use' row of values. Returns Z -> (value, raw cell)."""
    out: dict[int, tuple[float, str]] = {}
    current: int | None = None
    for row in _rows(_tables(page)[0]):
        if not row:
            continue
        head = re.match(r"(\d+)\s+[A-Z][a-z]?\s", row[0])
        if head and len(row) == 1:
            current = int(head.group(1))
            continue
        if current is None or row[0].lower() != "use":
            continue
        if kind == "resistivity":
            # Columns: T, 80 K, 273 K, 293 K, 298 K, 300 K, 500 K. Prefer 293 K.
            for index in (3, 2, 4, 5):
                cell = row[index] if index < len(row) else ""
                value, _ = parse_number(cell)
                if value is not None:
                    prefix = re.search(r"([numμµkMGTP]?)\s*Ω", cell)
                    scale = {"n": 1e-9, "u": 1e-6, "μ": 1e-6, "µ": 1e-6, "m": 1e-3,
                             "k": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15,
                             "": 1.0}.get(prefix.group(1) if prefix else "", 1.0)
                    out[current] = (value * scale, cell)
                    break
        else:
            cell = row[use_index] if use_index < len(row) else ""
            value, _ = parse_number(cell)
            if value is not None:
                out[current] = (value, cell)
        current = None
    return out


def _wp_radii(page: str) -> dict[int, dict[str, float | None]]:
    out: dict[int, dict[str, float | None]] = {}
    for row in _rows(_tables(page)[0]):
        if len(row) < 7 or not row[0].isdigit():
            continue
        vdw, _ = parse_number(_strip_footnotes(row[5]).split(" or ")[0])
        cov, _ = parse_number(_strip_footnotes(row[6]))
        out[int(row[0])] = {"vdw": vdw, "covalent": cov}
    return out


def _wp_etymology(page: str) -> dict[int, dict[str, str | None]]:
    out: dict[int, dict[str, str | None]] = {}
    table = re.sub(r"<table\b.*?</table\s*>", "", _tables(page)[0], flags=re.S)
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S)
    pending: int | None = None
    for row in rows:
        cells = re.findall(r"<(t[hd])([^>]*)>(.*?)</t[hd]>", row, re.S)
        texts = [_text(c[2]) for c in cells]
        if len(cells) >= 5 and "rowspan" in cells[0][1] and re.match(r"\d+$", texts[1] or ""):
            z = int(texts[1])
            out[z] = {
                "word": _strip_footnotes(texts[2]) or None,
                "language": _strip_footnotes(texts[3]) or None,
                "meaning": _strip_footnotes(texts[4]) or None,
                "nature": _strip_footnotes(texts[5]) if len(texts) > 5 else None,
                "description": None,
            }
            pending = z
        elif pending is not None and len(cells) == 1:
            out[pending]["description"] = _first_sentences(_strip_footnotes(texts[0]), 360, 2)
            pending = None
    if len(out) < 110:
        raise FetchError(f"Etymology list parsed {len(out)} elements, expected ~118")
    return out


def _wp_infoboxes(titles: list[str], refresh: bool) -> tuple[dict[str, dict[str, str]], list[CachedResponse]]:
    out: dict[str, dict[str, str]] = {}
    responses: list[CachedResponse] = []
    ordered = sorted(set(titles))
    for start in range(0, len(ordered), 20):
        batch = ordered[start:start + 20]
        url = (
            f"{config.WIKIPEDIA_API_URL}?action=query&format=json&prop=revisions"
            f"&rvprop=content&rvslots=main&redirects=1"
            f"&titles={urllib.parse.quote('|'.join(batch))}"
        )
        response = fetch(url, refresh=refresh, subdir=_SUBDIR, expect_json=True)
        responses.append(response)
        if not response.from_cache:
            time.sleep(1.0)
        payload = response.read_json().get("query", {})
        back = {r["to"]: r["from"] for r in payload.get("redirects", [])}
        norm = {n["to"]: n["from"] for n in payload.get("normalized", [])}
        for page in payload.get("pages", {}).values():
            if "missing" in page:
                continue
            title = page.get("title") or ""
            wikitext = ((page.get("revisions") or [{}])[0].get("slots") or {}).get("main", {}).get("*", "")
            original = norm.get(back.get(title, title), back.get(title, title))
            fields = parse_infobox_fields(wikitext)
            for key in {title, original}:
                out[key] = fields
    return out, responses


def _wp_full_text(title: str, refresh: bool) -> tuple[str, CachedResponse | None]:
    url = (
        f"{config.WIKIPEDIA_API_URL}?action=query&format=json&prop=extracts"
        f"&explaintext=1&exsectionformat=wiki&redirects=1"
        f"&titles={urllib.parse.quote(title)}"
    )
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    try:
        response = fetch(url, refresh=refresh, subdir=f"{_SUBDIR}/articles",
                         filename=f"{slug}.json", expect_json=True)
    except FetchError:
        return "", None
    if not response.from_cache:
        time.sleep(1.0)
    pages = response.read_json().get("query", {}).get("pages", {})
    for page in pages.values():
        return page.get("extract") or "", response
    return "", response


def _sections(full_text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    current = "lead"
    buf: list[str] = []
    for line in full_text.split("\n"):
        m = re.match(r"^(={2,})\s*(.+?)\s*\1$", line)
        if m:
            out[current] = out.get(current, "") + "\n".join(buf)
            buf = []
            level = len(m.group(1))
            title = m.group(2).strip().lower()
            current = title if level == 2 else f"{current}"
            continue
        buf.append(line)
    out[current] = out.get(current, "") + "\n".join(buf)
    return out


def _section_text(sections: dict[str, str], needles: tuple[str, ...]) -> str | None:
    for title, body in sections.items():
        if any(n in title for n in needles):
            text = _first_sentences(body.strip(), 480, 3)
            if text:
                return text
    return None


# --------------------------------------------------------------------------
# IAEA nuclides
# --------------------------------------------------------------------------

def _format_half_life(seconds: float) -> str:
    year = 365.25 * 86400
    if seconds >= 1e9 * year:
        return f"{seconds / (1e9 * year):.3g} billion years"
    if seconds >= 1e6 * year:
        return f"{seconds / (1e6 * year):.3g} million years"
    if seconds >= year:
        return f"{seconds / year:.3g} years"
    if seconds >= 86400:
        return f"{seconds / 86400:.3g} days"
    if seconds >= 3600:
        return f"{seconds / 3600:.3g} hours"
    if seconds >= 60:
        return f"{seconds / 60:.3g} minutes"
    if seconds >= 1:
        return f"{seconds:.3g} s"
    if seconds >= 1e-3:
        return f"{seconds * 1e3:.3g} ms"
    if seconds >= 1e-6:
        return f"{seconds * 1e6:.3g} µs"
    return f"{seconds:.2g} s"


def _iaea(refresh: bool) -> tuple[dict[int, dict[str, Any]], str | None, CachedResponse]:
    response = fetch(IAEA_URL, refresh=refresh, subdir=_SUBDIR, filename="iaea-ground-states.csv")
    rows = list(csv.DictReader(io.StringIO(response.read_text())))
    by_z: dict[int, list[dict[str, str]]] = {}
    extraction: str | None = None
    for row in rows:
        try:
            z = int(row["z"])
        except (KeyError, ValueError):
            continue
        if z < 1:
            continue
        by_z.setdefault(z, []).append(row)
        extraction = extraction or row.get("Extraction_date") or None
    out: dict[int, dict[str, Any]] = {}
    for z, nuclides in by_z.items():
        stable = [n for n in nuclides if n.get("half_life") == "STABLE"]
        notable: list[str] = []
        with_abundance = sorted(
            (n for n in stable if n.get("abundance")),
            key=lambda n: -float(n["abundance"]),
        )
        for n in with_abundance[:4]:
            a = int(n["n"]) + z
            notable.append(f"{a}{n['symbol']} ({float(n['abundance']):.4g}%)")
        if not with_abundance:
            radio = []
            for n in nuclides:
                try:
                    radio.append((float(n["half_life_sec"]), n))
                except (ValueError, TypeError):
                    continue
            radio.sort(key=lambda t: -t[0])
            for secs, n in radio[:3]:
                a = int(n["n"]) + z
                notable.append(f"{a}{n['symbol']} (half-life {_format_half_life(secs)})")
        out[z] = {"known": len(nuclides), "stable": len(stable), "notable": notable}
    if len(out) < 118:
        raise FetchError(f"IAEA ground-state list covers {len(out)} elements, expected 118")
    return out, extraction, response


# --------------------------------------------------------------------------
# Electron configuration
# --------------------------------------------------------------------------

def expand_configuration(short: str, by_symbol: dict[str, str]) -> str:
    text = short
    seen = 0
    while True:
        m = re.match(r"\s*\[([A-Z][a-z]?)\]\s*(.*)$", text)
        if not m:
            break
        core = by_symbol.get(m.group(1))
        if core is None or seen > 8:
            break
        text = f"{core} {m.group(2)}"
        seen += 1
    return re.sub(r"\s+", " ", text).strip()


def shells_from_configuration(full: str) -> list[int]:
    counts: dict[int, int] = {}
    for n, sub, count in re.findall(r"(\d)([spdf])(\d+)", full):
        counts[int(n)] = counts.get(int(n), 0) + int(count)
    if not counts:
        return []
    return [counts.get(n, 0) for n in range(1, max(counts) + 1)]


def _configuration_note(raw: str) -> str | None:
    if "predicted" in raw.lower():
        return "predicted"
    return None


# --------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------

def _num(text: str | None) -> float | None:
    if text is None:
        return None
    t = text.strip()
    if not t:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _wikidata_discovery_year(entries: list[tuple[str, int]]) -> tuple[int | str | None, str | None]:
    """(year or 'ancient', note). Wikidata precision 9 = year, 10 = month,
    11 = day; <= 8 (decade, century, millennium) for the ancient metals."""
    if not entries:
        return None, None
    best = min(entries, key=lambda e: e[0])
    iso, precision = best
    m = re.match(r"(-?)(\d{4,})", iso)
    if not m:
        return None, None
    year = int(m.group(2)) * (-1 if m.group(1) else 1)
    if precision <= 8 or year <= 0:
        return "ancient", f"Wikidata dates it to about {abs(year)} {'BC' if year < 0 else 'AD'} (precision {precision})"
    return year, None


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry  # the periodic table is not keyed by entity
    started = time.time()
    out_dir = config.DATA_DIR / "chemistry"
    images_dir = out_dir / "images"
    out_dir.mkdir(parents=True, exist_ok=True)
    images_dir.mkdir(parents=True, exist_ok=True)

    properties = json.loads(_PROPERTIES_PATH.read_text("utf-8"))
    property_keys: list[str] = [k for s in properties["sections"] for k in s["keys"]]
    glossary_src = json.loads(_GLOSSARY_PATH.read_text("utf-8"))
    samples_src = json.loads(_SAMPLES_PATH.read_text("utf-8"))
    glossary_keys = {e["key"] for e in glossary_src["entries"]}
    missing_glossary = [k for k in property_keys if k not in glossary_keys]
    if missing_glossary:
        raise FetchError(
            "chemistry_glossary.json lacks entries for property keys: "
            + ", ".join(missing_glossary)
        )
    for entry in glossary_src["entries"]:
        for key in ("key", "term", "definition", "source"):
            if not entry.get(key):
                raise FetchError(f"glossary entry {entry.get('key')!r} missing {key}")
        if not entry["source"].get("url", "").startswith("http"):
            raise FetchError(f"glossary entry {entry['key']} has no source URL")

    # ---- fetch everything ------------------------------------------------
    pubchem, pubchem_resp = _pubchem_table(refresh)
    print(f"    PubChem periodic table: {len(pubchem)} elements", flush=True)
    nist, nist_resp = _nist_ionization(refresh)
    print(f"    NIST ASD: ionization energies for {len(nist)} elements", flush=True)
    ciaaw, ciaaw_vintage, ciaaw_resp = _ciaaw(refresh)
    print(f"    CIAAW: {len(ciaaw)} atomic weights (revisions to {ciaaw_vintage})", flush=True)
    wikidata, wikidata_resp = _wikidata_elements(refresh)
    print(f"    Wikidata: {len(wikidata)} elements", flush=True)
    iaea, iaea_extraction, iaea_resp = _iaea(refresh)
    print(f"    IAEA: nuclides for {len(iaea)} elements (extraction {iaea_extraction})", flush=True)

    wp_pages: dict[str, str] = {}
    wp_responses: dict[str, CachedResponse] = {}
    for key, title in WP_PAGES.items():
        wp_pages[key], wp_responses[key] = _wp_parse(title, refresh)
    wp_list = _wp_list(wp_pages["list"])
    wp_abundance = _wp_abundance(wp_pages["abundance"])
    wp_thermal = _wp_thermal(wp_pages["thermal"])
    wp_heat = _wp_grouped(wp_pages["heat"], 2, "heat")
    wp_resist = _wp_grouped(wp_pages["resistivity"], 3, "resistivity")
    wp_radii = _wp_radii(wp_pages["radii"])
    wp_etym = _wp_etymology(wp_pages["etymology"])
    print(f"    Wikipedia data pages: abundance {len(wp_abundance)}, thermal "
          f"{len(wp_thermal)}, heat {len(wp_heat)}, resistivity {len(wp_resist)}, "
          f"radii {len(wp_radii)}, etymology {len(wp_etym)}", flush=True)

    enwiki = {z: (wikidata[z].get("enwiki") or pubchem[z]["Name"]) for z in range(1, 119)}
    infobox_titles = [f"Template:Infobox {enwiki[z].lower()}" for z in range(1, 119)]
    infoboxes, infobox_resps = _wp_infoboxes(infobox_titles, refresh)
    print(f"    Wikipedia infobox templates: {len(infoboxes)}", flush=True)

    leads = commons.wikipedia_extracts([enwiki[z] for z in range(1, 119)],
                                       refresh=refresh, subdir=_SUBDIR)
    article_sections: dict[int, dict[str, str]] = {}
    article_dates: list[str] = []
    for z in range(1, 119):
        text, resp = _wp_full_text(enwiki[z], refresh)
        article_sections[z] = _sections(text) if text else {}
        if resp:
            article_dates.append(resp.fetched_at)
    print(f"    Wikipedia articles: {sum(1 for s in article_sections.values() if s)} with text", flush=True)

    pugview: dict[int, dict[str, Any]] = {}
    pugview_missing: list[int] = []
    pugview_dates: list[str] = []
    for z in range(1, 119):
        record, resp = _pugview_record(z, refresh)
        if record is None:
            pugview_missing.append(z)
            continue
        pugview[z] = _pv_extract(record["Record"])
        if resp:
            pugview_dates.append(resp.fetched_at)
    print(f"    PubChem PUG-View: {len(pugview)} records"
          + (f", {len(pugview_missing)} not retrieved" if pugview_missing else ""),
          flush=True)
    if pugview_missing:
        manifest_mod.add_warning(
            manifest,
            f"chemistry: PubChem PUG-View element records not retrieved for "
            f"{len(pugview_missing)} element(s) "
            f"({', '.join(str(z) for z in pugview_missing[:12])}"
            f"{'…' if len(pugview_missing) > 12 else ''}); uses / biological "
            f"role / hazards for those fall back to Wikipedia sections and "
            f"PubChem's per-property references are absent. The monthly "
            f"refresh retries them.",
        )

    # ---- images ------------------------------------------------------------
    samples = {int(k): v for k, v in samples_src["elements"].items()}
    facility_qids = sorted({v["facility"] for v in samples.values() if v.get("facility")})
    facilities, facilities_resp = _wikidata_facilities(facility_qids, refresh)
    candidates: dict[int, tuple[str, str]] = {}  # z -> (filename, kind)
    for z in range(1, 119):
        rule = samples.get(z, {})
        files = [f for f in wikidata[z]["images"] if not f.lower().endswith(".svg")]
        if rule.get("file"):
            # An editorial pick (chemistry_samples.json) overrides the
            # automatic Wikidata P18 choice — used where P18 fails the
            # licence gate but a properly-licensed alternative exists.
            candidates[z] = (rule["file"], rule.get("imageKind") or "sample")
        elif files and not rule.get("dropWikidataImage"):
            kind = rule.get("imageKind") or ("sample" if not rule.get("noSample") else "related")
            candidates[z] = (files[0], kind)
        elif rule.get("facility") and facilities.get(rule["facility"], {}).get("image"):
            candidates[z] = (facilities[rule["facility"]]["image"], "facility")
    metadata, meta_resps = commons.fetch_metadata(
        sorted({f for f, _ in candidates.values()}), refresh=refresh, subdir=_SUBDIR,
    )
    images: dict[int, dict[str, Any]] = {}
    rejected: list[dict[str, Any]] = []
    for z, (filename, kind) in sorted(candidates.items()):
        meta = metadata.get(filename)
        if not meta:
            rejected.append({"z": z, "file": filename, "reason": "not on Commons"})
            continue
        licence = meta.get("license") or ""
        if not _FREE.search(licence):
            rejected.append({"z": z, "file": filename, "reason": f"licence {licence!r}"})
            continue
        mime = meta.get("mime") or ""
        ext = "png" if "png" in mime else "jpg"
        symbol = pubchem[z]["Symbol"]
        local_name = f"{z:03d}-{symbol}.{ext}"
        url = commons.image_url_for(filename, 640)
        try:
            response = fetch(url, refresh=refresh, subdir=f"{_SUBDIR}/images",
                             filename=local_name)
        except FetchError as exc:
            rejected.append({"z": z, "file": filename, "reason": f"download failed: {exc}"})
            continue
        if not response.from_cache:
            time.sleep(0.5)
        shutil.copyfile(response.path, images_dir / local_name)
        caption = None
        if meta.get("description"):
            caption = _first_sentences(meta["description"], 200, 1)
        images[z] = {
            "file": f"images/{local_name}",
            "kind": kind,
            "caption": caption,
            "author": meta.get("author"),
            "license": licence,
            "commonsPage": commons.file_page_for(filename),
            "source": "Wikimedia Commons",
            "width": meta.get("width"),
            "height": meta.get("height"),
        }
        if kind == "facility":
            rule = samples[z]
            images[z]["facility"] = (facilities.get(rule["facility"], {}).get("label")
                                     or samples_src["facilities"].get(rule["facility"]))
    for stale in images_dir.glob("*"):
        if stale.name not in {img["file"].split("/")[-1] for img in images.values()}:
            stale.unlink()
    print(f"    images: {len(images)} kept, {len(rejected)} rejected", flush=True)

    # ---- source registry (short ids used by every figure) ----------------
    fetched = _ymd(pubchem_resp.fetched_at)
    wp_date = _ymd(max(r.fetched_at for r in wp_responses.values()))
    sources = {
        "pubchem": {
            "title": "PubChem Periodic Table (NIH/NCBI)",
            "url": "https://pubchem.ncbi.nlm.nih.gov/periodic-table/",
            "licence": "Public domain (US Government work)",
            "vintage": f"retrieved {fetched}",
            "citation": "Kim S. et al. (2021) PubChem Periodic Table and Element pages, J. Cheminform. 13:3",
        },
        "pugview": {
            "title": "PubChem element records (PUG-View), per-statement references",
            "url": "https://pubchem.ncbi.nlm.nih.gov/docs/pug-view",
            "licence": "Public domain compilation; each statement cites its own source",
            "vintage": f"retrieved {_ymd(max(pugview_dates)) if pugview_dates else 'not retrieved'}",
        },
        "nist_asd": {
            "title": "NIST Atomic Spectra Database — ionization energies",
            "url": "https://physics.nist.gov/PhysRefData/ASD/ionEnergy.html",
            "licence": "Public domain (NIST)",
            "vintage": f"retrieved {_ymd(nist_resp.fetched_at)}",
        },
        "ciaaw": {
            "title": "IUPAC/CIAAW Standard Atomic Weights",
            "url": CIAAW_URL,
            "licence": "IUPAC; reproduced as data with attribution",
            "vintage": f"revisions to {ciaaw_vintage}" if ciaaw_vintage else f"retrieved {_ymd(ciaaw_resp.fetched_at)}",
        },
        "wikidata": {
            "title": "Wikidata (P18, P61, P138, P189, P231, P373, P575)",
            "url": "https://www.wikidata.org/",
            "licence": "CC0",
            "vintage": f"retrieved {_ymd(wikidata_resp.fetched_at)}",
        },
        "wp_list": {
            "title": "Wikipedia: List of chemical elements (CRC-cited columns)",
            "url": "https://en.wikipedia.org/wiki/List_of_chemical_elements",
            "licence": "CC BY-SA 4.0",
            "vintage": f"retrieved {wp_date}",
        },
        "crc_crust": {
            "title": "CRC Handbook, Abundance of elements in the Earth's crust — via Wikipedia 'Abundances of the elements (data page)', column C1",
            "url": "https://en.wikipedia.org/wiki/Abundances_of_the_elements_(data_page)",
            "licence": "CC BY-SA 4.0 (tabulation); CRC values",
            "vintage": f"CRC Handbook 85th ed. (2005) as tabulated; retrieved {wp_date}",
        },
        "anders_grevesse": {
            "title": "Anders & Grevesse (1989) Solar-System abundances — via Wikipedia 'Abundances of the elements (data page)', column Y2",
            "url": "https://en.wikipedia.org/wiki/Abundances_of_the_elements_(data_page)",
            "licence": "CC BY-SA 4.0 (tabulation)",
            "vintage": f"1989 compilation; retrieved {wp_date}",
        },
        "wp_thermal": {
            "title": "Wikipedia: Thermal conductivities of the elements (data page), CRC-based usable value",
            "url": "https://en.wikipedia.org/wiki/Thermal_conductivities_of_the_elements_(data_page)",
            "licence": "CC BY-SA 4.0", "vintage": f"retrieved {wp_date}",
        },
        "wp_heat": {
            "title": "Wikipedia: Heat capacities of the elements (data page), CRC-based usable value",
            "url": "https://en.wikipedia.org/wiki/Heat_capacities_of_the_elements_(data_page)",
            "licence": "CC BY-SA 4.0", "vintage": f"retrieved {wp_date}",
        },
        "wp_resistivity": {
            "title": "Wikipedia: Electrical resistivities of the elements (data page), CRC-based value at 293 K",
            "url": "https://en.wikipedia.org/wiki/Electrical_resistivities_of_the_elements_(data_page)",
            "licence": "CC BY-SA 4.0", "vintage": f"retrieved {wp_date}",
        },
        "wp_radii": {
            "title": "Wikipedia: Atomic radii of the elements (data page) — covalent (Cordero 2008) and van der Waals (Bondi/Mantina)",
            "url": "https://en.wikipedia.org/wiki/Atomic_radii_of_the_elements_(data_page)",
            "licence": "CC BY-SA 4.0", "vintage": f"retrieved {wp_date}",
        },
        "wp_infobox": {
            "title": "Wikipedia element infobox templates (crystal structure, magnetic ordering)",
            "url": "https://en.wikipedia.org/wiki/Template:Infobox_element",
            "licence": "CC BY-SA 4.0",
            "vintage": f"retrieved {_ymd(max(r.fetched_at for r in infobox_resps))}",
        },
        "wp_etymology": {
            "title": "Wikipedia: List of chemical element name etymologies",
            "url": "https://en.wikipedia.org/wiki/List_of_chemical_element_name_etymologies",
            "licence": "CC BY-SA 4.0", "vintage": f"retrieved {wp_date}",
        },
        "wikipedia": {
            "title": "Wikipedia article text (lead; applications / biological role / precautions sections)",
            "url": "https://en.wikipedia.org/",
            "licence": "CC BY-SA 4.0 (verbatim, attributed, linked)",
            "vintage": f"retrieved {_ymd(max(article_dates)) if article_dates else wp_date}",
        },
        "iaea": {
            "title": "IAEA Nuclear Data Section, Live Chart of Nuclides API (NUBASE2020 / ENSDF ground states)",
            "url": "https://nds.iaea.org/relnsd/vcharthtml/VChartHTML.html",
            "licence": "IAEA open data",
            "vintage": f"IAEA extraction {iaea_extraction}" if iaea_extraction else f"retrieved {_ymd(iaea_resp.fetched_at)}",
        },
        "commons": {
            "title": "Wikimedia Commons (per-file licence and author)",
            "url": "https://commons.wikimedia.org/",
            "licence": "per file: PD / CC0 / CC BY / CC BY-SA / FAL",
            "vintage": f"retrieved {_ymd(max(r.fetched_at for r in meta_resps)) if meta_resps else fetched}",
        },
        "editorial": {
            "title": "Editorial (etl/reference/chemistry_samples.json)",
            "url": "https://github.com/Andonator5000/global-population-dashboard",
            "licence": "CC0", "vintage": f"v{samples_src['version']}",
        },
    }

    # ---- per element ---------------------------------------------------------
    by_symbol_config = {rec["Symbol"]: re.sub(r"\s*\(predicted\)", "", rec["ElectronConfiguration"])
                        for rec in pubchem.values()}
    elements: list[dict[str, Any]] = []
    null_counts: dict[str, int] = {k: 0 for k in property_keys}
    for z in range(1, 119):
        pc = pubchem[z]
        wd = wikidata[z]
        lst = wp_list[z]
        pv = pugview.get(z, {"prose": {}, "propertyRefs": {}})
        prefs = pv["propertyRefs"]

        def pc_note(field: str, extra: str | None = None) -> str | None:
            names = prefs.get(field)
            parts = []
            if names:
                parts.append("PubChem cites " + "; ".join(names))
            if extra:
                parts.append(extra)
            return ". ".join(parts) or None

        symbol = pc["Symbol"]
        name = pc["Name"]
        category = _PUBCHEM_CATEGORY.get(pc["GroupBlock"], "unknown")
        category_note = None
        if z >= _UNKNOWN_FROM_Z:
            category_note = (f"Chemistry unconfirmed — only a few atoms have ever "
                             f"been made; PubChem's block label is '{pc['GroupBlock']}'")
            category = "unknown"

        raw_config = pc["ElectronConfiguration"]
        short_config = re.sub(r"\s*\(predicted\)", "", raw_config).strip()
        full_config = expand_configuration(short_config, by_symbol_config)
        shells = shells_from_configuration(full_config)
        config_note = pc_note("electronConfiguration", _configuration_note(raw_config))

        # Standard atomic weight: CIAAW verbatim, PubChem's conventional value
        # alongside for sorting and scales.
        cw = ciaaw.get(z)
        numeric = _num(pc["AtomicMass"])
        if cw and cw["kind"] != "none":
            saw_note = {
                "interval": "IUPAC gives an interval because isotope ratios vary between natural sources",
                "mostStableIsotope": "square brackets: mass number of the longest-lived isotope — the element has no stable isotope",
                "value": None,
            }[cw["kind"]]
            saw = fig(cw["text"], "Da", "ciaaw", sources["ciaaw"]["vintage"], note=saw_note)
            saw["kind"] = cw["kind"]
            saw["numeric"] = numeric
        else:
            saw = fig(pc["AtomicMass"], "Da", "pubchem", sources["pubchem"]["vintage"],
                      note="CIAAW lists no standard atomic weight; PubChem's value shown")
            saw["kind"] = "value"
            saw["numeric"] = numeric

        state_raw = pc["StandardState"].strip()
        phase_predicted = state_raw.lower().startswith("expected")
        phase = state_raw.split()[-1].lower() if state_raw else None
        if phase and phase not in ("gas", "solid", "liquid"):
            phase = None
        phase_fig = fig(phase, None, "pubchem", sources["pubchem"]["vintage"],
                        note=pc_note("standardState", "predicted, not measured" if phase_predicted else None),
                        reason="PubChem gives no standard state")
        if phase_predicted:
            phase_fig["predicted"] = True

        ies = nist.get(z, [])
        ie_values = [e for e in ies if e["charge"] in (0, 1, 2)]
        ie_fig = fig(
            [round(e["eV"], 4) for e in ie_values] or None, "eV", "nist_asd",
            sources["nist_asd"]["vintage"],
            note=("; ".join(f"{e['charge'] + 1}{'st' if e['charge'] == 0 else 'nd' if e['charge'] == 1 else 'rd'}: {e['qualifier']}"
                           for e in ie_values if e.get("qualifier")) or None),
            reason="NIST ASD lists no ionization energy",
        )
        if ie_values:
            ie_fig["uncertainties"] = [e.get("uncertainty") for e in ie_values]

        radii = wp_radii.get(z, {})
        vdw_pc = _num(pc["AtomicRadius"])
        vdw_value = vdw_pc if vdw_pc is not None else radii.get("vdw")
        vdw_fig = fig(vdw_value, "pm", "pubchem" if vdw_pc is not None else "wp_radii",
                      sources["pubchem"]["vintage"] if vdw_pc is not None else sources["wp_radii"]["vintage"],
                      note=pc_note("atomicRadius") if vdw_pc is not None else None,
                      reason="neither PubChem nor the radii data page tabulates a van der Waals radius")

        thermal = wp_thermal.get(z)
        heat = wp_heat.get(z)
        heat_value = heat[0] if heat else lst.get("specificHeat")
        resist = wp_resist.get(z)
        conductivity = (1.0 / resist[0]) if resist and resist[0] else None

        ib = infoboxes.get(f"Template:Infobox {enwiki[z].lower()}", {})
        crystal = clean_wikitext(ib.get("crystal structure", ""))
        crystal_prefix = clean_wikitext(ib.get("crystal structure prefix", ""))
        crystal_comment = clean_wikitext(ib.get("crystal structure comment", ""))
        pearson = clean_wikitext(ib.get("crystal structure pearson symbol", ""))
        crystal_text = crystal or None
        if crystal_text and pearson:
            crystal_text += f" ({pearson})"
        crystal_note_parts = [p for p in (crystal_prefix.rstrip(":"), crystal_comment.strip("()")) if p]
        magnetic = clean_wikitext(ib.get("magnetic ordering", "")) or None

        ab = wp_abundance.get(z, {})
        crust_kgkg = ab.get("crust_kgkg")
        crust_mgkg = crust_kgkg * 1e6 if crust_kgkg is not None else None
        crust_source = "crc_crust"
        crust_note = None
        if crust_mgkg is None and lst.get("crust_mgkg") is not None:
            crust_mgkg = lst["crust_mgkg"]
            crust_source = "wp_list"
            crust_note = "from the List of chemical elements column (CRC-based)" + (
                "; approximate" if lst["crust_flags"].get("approx") else "")

        year_wd, year_note = _wikidata_discovery_year(wd["discovery"])
        year_pc = pc["YearDiscovered"].strip()
        year_value: int | str | None = year_wd
        if year_value is None:
            year_value = "ancient" if year_pc.lower() == "ancient" else (int(year_pc) if year_pc.isdigit() else None)
        disc_source = "wikidata" if year_wd is not None else "pubchem"
        if year_wd is not None and year_pc and str(year_wd) != year_pc and not (year_wd == "ancient" and year_pc.lower() == "ancient"):
            year_note = (year_note + "; " if year_note else "") + f"PubChem gives {year_pc}"

        et = wp_etym.get(z, {})
        etym_text = et.get("description")
        if not etym_text and et.get("word"):
            etym_text = f"From {et.get('language') or 'the'} {et['word']}" + (
                f", {et['meaning']}" if et.get("meaning") else "")
        etym_source = "wp_etymology"
        if not etym_text and wd["named"]:
            etym_text = "Named after " + ", ".join(wd["named"])
            etym_source = "wikidata"
        if not etym_text and pv["prose"].get("etymology"):
            etym_text = pv["prose"]["etymology"]["text"]
            etym_source = "pugview"

        secs = article_sections.get(z, {})
        lead = leads.get(enwiki[z], {}).get("extract") or ""
        description = _first_sentences(lead, 520, 3)

        def prose_fig(key: str, needles: tuple[str, ...]) -> dict[str, Any]:
            entry = pv["prose"].get(key)
            if entry and entry.get("text"):
                f = fig(entry["text"], None, "pugview", sources["pugview"]["vintage"])
                f["citations"] = entry["sources"]
                f["heading"] = entry["heading"]
                return f
            text = _section_text(secs, needles)
            if text:
                return fig(text, None, "wikipedia", sources["wikipedia"]["vintage"],
                           note=f"Wikipedia article section; PubChem carries no such section for {name}")
            return fig(None, None, "pugview" if pugview.get(z) else "wikipedia", None,
                       reason=(f"neither PubChem's element record nor the Wikipedia article has a {key} section"
                               if pugview.get(z) else
                               f"PubChem record not retrieved in this run and the Wikipedia article has no matching section"))

        iso = iaea.get(z, {})
        wiki_url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(enwiki[z].replace(" ", "_"))
        cas_values = wd["cas"] or ([clean_wikitext(ib["cas number"])] if ib.get("cas number") else [])

        record: dict[str, Any] = {
            "z": z, "symbol": symbol, "name": name,
            "category": category,
            "xpos": None, "ypos": None,
            "wikipedia": wiki_url,
            "pubchem": f"https://pubchem.ncbi.nlm.nih.gov/element/{z}",
            "rsc": f"{RSC_URL}element/{z}/{name.lower()}",
            "image": images.get(z),
            "noSample": bool(samples.get(z, {}).get("noSample")),
            "noSampleReason": samples.get(z, {}).get("reason"),
            "sampleNote": samples.get(z, {}).get("sampleNote"),
            "properties": {
                "atomicNumber": fig(z, None, "pubchem", sources["pubchem"]["vintage"]),
                "symbol": fig(symbol, None, "pubchem", sources["pubchem"]["vintage"]),
                "name": fig(name, None, "pubchem", sources["pubchem"]["vintage"]),
                "standardAtomicWeight": saw,
                "group": fig(lst["group"], None, "wp_list", sources["wp_list"]["vintage"],
                             reason="lanthanides and actinides sit outside the 18 numbered groups"),
                "period": fig(lst["period"], None, "wp_list", sources["wp_list"]["vintage"]),
                "block": fig(lst["block"], None, "wp_list", sources["wp_list"]["vintage"]),
                "category": fig(CATEGORY_LABELS[category], None, "pubchem", sources["pubchem"]["vintage"],
                                note=category_note or f"PubChem block label: {pc['GroupBlock']}"),
                "casNumber": fig(cas_values[0] if cas_values else None, None,
                                 "wikidata" if wd["cas"] else "wp_infobox",
                                 sources["wikidata"]["vintage"] if wd["cas"] else sources["wp_infobox"]["vintage"],
                                 reason="no CAS Registry Number recorded in Wikidata or the infobox"),
                "electronConfiguration": fig(short_config, None, "pubchem", sources["pubchem"]["vintage"], note=config_note),
                "electronConfigurationFull": fig(full_config, None, "pubchem", sources["pubchem"]["vintage"],
                                                 note="expanded from PubChem's noble-gas shorthand" + (f"; {config_note}" if config_note else "")),
                "electronShells": fig(shells or None, None, "pubchem", sources["pubchem"]["vintage"],
                                      note="counted per principal quantum number from the full configuration",
                                      reason="configuration could not be parsed"),
                "electronegativity": fig(_num(pc["Electronegativity"]), None, "pubchem", sources["pubchem"]["vintage"],
                                         note=pc_note("electronegativity"),
                                         reason="no Pauling electronegativity — the element forms no bonds whose energies could define one, or none has been measured"),
                "ionizationEnergies": ie_fig,
                "electronAffinity": fig(_num(pc["ElectronAffinity"]), "eV", "pubchem", sources["pubchem"]["vintage"],
                                        note=pc_note("electronAffinity"),
                                        reason="no measured electron affinity (the anion is unbound or unmeasured)"),
                "oxidationStates": fig(pc["OxidationStates"].strip() or None, None, "pubchem", sources["pubchem"]["vintage"],
                                       note=pc_note("oxidationStates"),
                                       reason="no oxidation states listed by PubChem"),
                "phaseAtStp": phase_fig,
                "meltingPoint": fig(_num(pc["MeltingPoint"]), "K", "pubchem", sources["pubchem"]["vintage"],
                                    note=pc_note("meltingPoint"), reason="no measured melting point"),
                "boilingPoint": fig(_num(pc["BoilingPoint"]), "K", "pubchem", sources["pubchem"]["vintage"],
                                    note=pc_note("boilingPoint"), reason="no measured boiling point"),
                "density": fig(_num(pc["Density"]), "g/cm³", "pubchem", sources["pubchem"]["vintage"],
                               note=pc_note("density", "gases at STP" if phase == "gas" else None),
                               reason="no measured density"),
                "covalentRadius": fig(radii.get("covalent"), "pm", "wp_radii", sources["wp_radii"]["vintage"],
                                      note="single-bond covalent radius (Cordero et al. 2008)",
                                      reason="no tabulated covalent radius"),
                "vanDerWaalsRadius": vdw_fig,
                "crystalStructure": fig(crystal_text, None, "wp_infobox", sources["wp_infobox"]["vintage"],
                                        note="; ".join(crystal_note_parts) or None,
                                        reason="no crystal structure in the element's infobox (never observed as a solid in bulk)"),
                "thermalConductivity": fig(thermal, "W/(m·K)", "wp_thermal", sources["wp_thermal"]["vintage"],
                                           reason="no tabulated thermal conductivity"),
                "electricalConductivity": fig(round_sig(conductivity) if conductivity is not None else None, "S/m", "wp_resistivity",
                                              sources["wp_resistivity"]["vintage"],
                                              note=f"computed as 1/ρ from resistivity {resist[1]}" if resist else None,
                                              reason="no tabulated resistivity"),
                "specificHeat": fig(heat_value, "J/(g·K)", "wp_heat" if heat else "wp_list",
                                    sources["wp_heat"]["vintage"] if heat else sources["wp_list"]["vintage"],
                                    reason="no tabulated specific heat capacity"),
                "magneticOrdering": fig(magnetic, None, "wp_infobox", sources["wp_infobox"]["vintage"],
                                        reason="no magnetic ordering in the element's infobox (not measured)"),
                "stableIsotopes": fig(iso.get("stable") or None, None, "iaea", sources["iaea"]["vintage"],
                                      reason="no stable isotopes — every known isotope is radioactive"
                                      if iso.get("stable") == 0 else None),
                "knownIsotopes": fig(iso.get("known"), None, "iaea", sources["iaea"]["vintage"],
                                     note="ground states in the IAEA evaluation"),
                "notableIsotopes": fig(iso.get("notable") or None, None, "iaea", sources["iaea"]["vintage"],
                                       note="stable isotopes with natural abundance, else the longest-lived",
                                       reason="no isotope with a listed abundance or half-life"),
                "abundanceCrust": fig(crust_mgkg, "mg/kg", crust_source, sources[crust_source]["vintage"],
                                      note=crust_note,
                                      reason="not present in the crust in measurable amounts (synthetic or transient)"),
                "abundanceUniverse": fig(ab.get("solar_si") * 1e6 if ab.get("solar_si") is not None else None,
                                         "atoms per 10⁶ Si atoms", "anders_grevesse", sources["anders_grevesse"]["vintage"],
                                         reason="not part of the Anders & Grevesse solar-system compilation (no stable isotope)"),
                "naturalOccurrence": fig(lst["origin"], None, "wp_list", sources["wp_list"]["vintage"]),
                "discoveryYear": fig(year_value, None, disc_source, sources[disc_source]["vintage"], note=year_note,
                                     reason="no discovery date recorded"),
                "discoverers": fig(wd["discoverers"] or None, None, "wikidata", sources["wikidata"]["vintage"],
                                   reason="known since antiquity — no discoverer" if year_value == "ancient" else "no discoverer recorded in Wikidata (P61)"),
                "discoveryPlace": fig(wd["places"][0] if wd["places"] else None, None, "wikidata", sources["wikidata"]["vintage"],
                                      reason="no place of discovery recorded in Wikidata (P189)"),
                "etymology": fig(etym_text, None, etym_source, sources[etym_source]["vintage"],
                                 note=(f"named after: {', '.join(wd['named'])}" if wd["named"] and etym_source != "wikidata" else None),
                                 reason="no etymology recorded"),
                "description": fig(description, None, "wikipedia", sources["wikipedia"]["vintage"],
                                   note="opening of the Wikipedia article, verbatim",
                                   reason="Wikipedia lead not retrieved"),
                "uses": prose_fig("uses", ("application", "uses")),
                "biologicalRole": prose_fig("biologicalRole", ("biolog", "nutrition", "physiolog")),
                "hazards": prose_fig("hazards", ("precaution", "toxic", "safety", "hazard", "health")),
            },
        }
        for key in property_keys:
            if record["properties"][key]["value"] is None:
                null_counts[key] += 1
        elements.append(record)

    # Layout: the 18-column IUPAC table with the f-block as two footer rows.
    for record in elements:
        z = record["z"]
        period = record["properties"]["period"]["value"]
        group = record["properties"]["group"]["value"]
        if 57 <= z <= 71:
            record["xpos"], record["ypos"] = 3 + (z - 57), 9
        elif 89 <= z <= 103:
            record["xpos"], record["ypos"] = 3 + (z - 89), 10
        else:
            record["xpos"], record["ypos"] = group, period
        if record["xpos"] is None or record["ypos"] is None:
            raise FetchError(f"element {z} has no table position (group {group}, period {period})")

    # ---- write -----------------------------------------------------------------
    elements_file = {
        "note": (
            "One record per element. Every property is {value, unit, source, "
            "vintage[, note]} and a null value carries a reason. `source` keys "
            "into `sources`. Images are served from data/chemistry/images with "
            "the Commons author and licence; noSample elements say why no "
            "photograph of the element can exist. Editorial rulings: "
            "DATA_DECISIONS.md §47."
        ),
        "sources": sources,
        "categories": CATEGORY_LABELS,
        "furtherReading": {
            "rsc": {"title": "Royal Society of Chemistry periodic table", "url": RSC_URL,
                    "note": "Consulted for cross-checks only; the RSC pages carry no reuse licence, so nothing was scraped."},
        },
        "elements": elements,
    }
    (out_dir / "elements.json").write_text(
        json.dumps(elements_file, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    (out_dir / "glossary.json").write_text(
        json.dumps({
            "source": "editorial",
            "version": glossary_src["version"],
            "note": glossary_src["note"],
            "entries": sorted(glossary_src["entries"], key=lambda e: e["term"].lower()),
        }, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    with_image = sum(1 for e in elements if e["image"])
    facility_images = sum(1 for e in elements if e["image"] and e["image"]["kind"] == "facility")
    related_images = sum(1 for e in elements if e["image"] and e["image"]["kind"] == "related")
    no_sample = sum(1 for e in elements if e["noSample"])
    licences: dict[str, int] = {}
    for e in elements:
        if e["image"]:
            licences[e["image"]["license"]] = licences.get(e["image"]["license"], 0) + 1
    log = {
        "elements": len(elements),
        "images": {"total": with_image, "sample": with_image - facility_images - related_images,
                   "facility": facility_images, "related": related_images,
                   "noSampleFlagged": no_sample, "licences": licences,
                   "rejected": rejected,
                   "withoutAnyImage": [e["z"] for e in elements if not e["image"]]},
        "pugviewRecords": len(pugview),
        "pugviewMissing": pugview_missing,
        "nullCounts": {k: v for k, v in null_counts.items() if v},
        "elapsedSeconds": round(time.time() - started, 1),
    }
    config.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    (config.LOGS_DIR / "chemistry.log").write_text(
        json.dumps(log, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n",
    )

    for sid, src in sources.items():
        if sid == "editorial":
            continue
        manifest_mod.record_source(
            manifest, f"chemistry_{sid}",
            title=src["title"], url=src["url"], licence=src["licence"],
            fetched_at=pubchem_resp.fetched_at, upstream_release=None,
            vintage=src["vintage"], citation=src.get("citation") or src["title"],
        )
    manifest_mod.record_artifact(
        manifest, "chemistry/elements.json",
        description="Periodic table: 118 elements, every figure sourced and dated; licence-gated photographs served locally.",
        sources=[f"chemistry_{sid}" for sid in sources if sid != "editorial"],
        row_count=len(elements),
    )
    manifest_mod.record_artifact(
        manifest, "chemistry/glossary.json",
        description="Chemistry glossary: plain-language definitions with units and a cited source for every property the panel shows.",
        sources=["editorial"], row_count=len(glossary_src["entries"]),
    )
    print(f"    wrote {len(elements)} elements, {with_image} images "
          f"({facility_images} facility, {related_images} related), "
          f"{no_sample} no-sample flags, {len(glossary_src['entries'])} glossary entries "
          f"in {log['elapsedSeconds']}s", flush=True)


__all__ = ["ingest", "expand_configuration", "shells_from_configuration"]
