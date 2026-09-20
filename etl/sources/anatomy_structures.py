"""A sourced description for every named structure in the 3-D anatomy models.

Round 13. The 3-D body (DATA_DECISIONS.md section 65) carries ~4,200 labelled
meshes across the two sexes -- bones, muscles, nerves, arteries, veins, lymph
nodes, brain regions, body-surface regions -- but only the sixty editorial
ORGAN entries had prose, so most clicks on the model answered "detailed entry
not available for this structure". This stage gives the viewer a description
for the structure NAME itself.

Where the prose comes from
--------------------------
English Wikipedia, through the batched Action API (`prop=extracts`,
`exintro=1`, `explaintext=1`, twenty titles a call, the same pattern as the
inventions/dishes blurbs in section 27 and the lead images in
`sources/history.py`). The lead paragraph is kept VERBATIM and trimmed to
about ninety words at a sentence boundary; nothing is rewritten, summarised or
invented, and no "function" line is synthesised from it -- the extract is the
description. Wikipedia text is CC BY-SA 4.0, so every entry ships the article
title, its URL and the licence, and the document carries the licence block.

Resolving a name to an article (the ladder)
-------------------------------------------
Structure names are Terminologia Anatomica 2 English terms (the male,
Z-Anatomy set) or Human Reference Atlas labels (the female, HRA set). They are
keyed by NORMALISED NAME, never by node id: the same structure appears twice
(left/right), in several layers, and the viewer may fit male meshes into the
female set under the same names. `normalise()` below is the exact contract the
viewer mirrors in TypeScript.

For each normalised name, candidate titles are tried in this order, and the
first candidate that passes the acceptance test wins:

1. `override`  -- the editorial table `etl/reference/anatomy_structure_titles.json`
                  (built by `build_anatomy_structure_titles.py`, never hand-edited),
                  which also holds explicit REJECTIONS for names that have no
                  article and should stop costing requests.
2. `ontology` -- the female set's ontology term -> Wikidata -> English
                  sitelink, batched SPARQL (UBERON id via P1554, Foundational
                  Model of Anatomy id via P1402; the HRA uses both).
3. `name`      -- the normalised name itself.
4. `stripped`  -- the name with a leading "Left "/"Right ", a trailing
                  parenthetical qualifier, or wrapping parentheses removed.
5. `singular`  -- the last word singularised ("nodes" -> "node").
6. `ofthe`     -- " of the " collapsed to " of ".

Rungs 1-6 are EXACT: the article is about that structure (a redirect counts).
Most of a TA2 name list has no article of its own, though -- English Wikipedia
has no "Bursa of the piriformis muscle", no "Ascending part of duodenum" and
no "Costal cartilage of fifth rib" -- and the strict ladder alone described
under half of them. Two further rungs answer with the nearest article that is
genuinely ABOUT something, flagged `"scope": "broader"` so the viewer says so:

7. `head`      -- the kind of structure the name opens with ("Bursa of the
                  piriformis muscle" -> "Bursa"); skipped when the head only
                  says which part ("Ascending part", "Middle third").
8. `parent`    -- the structure the name hangs off ("Ascending part of
                  duodenum" -> "Duodenum"); skipped for parents too general to
                  say anything ("... of hand").

9. `shortened` -- the qualifiers dropped a word at a time, from the end and
                  then from the front ("Paracentral lobule caudal part" ->
                  "Paracentral lobule"; "Upper medial incisor" -> "Incisor");
                  a bare last word is only tried when it names a KIND of
                  structure (nerve, bursa, enthesis...), never a stray
                  adjective.

`override-broader` is the editorial equivalent of rungs 7-9 (the vertebra,
rib, tooth and spinal-segment families, which are numbered members of a series
Wikipedia documents collectively).

Acceptance test. A page is ACCEPTED only when it exists, is not a
disambiguation page (neither `pageprops.disambiguation` nor "may refer to" in
the lead), its lead mentions at least one anatomical keyword in the first 400
characters, and the trimmed extract is at least twenty words. A lead that is
only a clause long (anatomy stubs often are) is re-read beyond the intro --
the first six sentences of the article -- before being given up on. Anything
else is REJECTED with a reason and the next rung is tried. A name that exhausts the
ladder ships as `{"title": null, "reason": ...}` -- the viewer then says the
structure has no sourced description, which is the honest answer. Nothing is
guessed.

Output: `data/anatomy/structures-wiki.json` (keyed by normalised name) plus
`etl/logs/anatomy_structures.log` (per-rung counts, rejects with reasons, the
uncovered names by group). Every HTTP call is cached under
`.cache/anatomy_structures/` by a hash of the request URL (section 21: batch
caches are NEVER named positionally).
"""

from __future__ import annotations

import json
import re
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any, Iterable

from .. import config, manifest as manifest_mod
from ..crosswalk import Entity
from ..fetch import CachedResponse, FetchError, fetch

_SUBDIR = "anatomy_structures"
_MODEL_DIR = config.DATA_DIR / "anatomy" / "models"
_OUT = config.DATA_DIR / "anatomy" / "structures-wiki.json"
_OVERRIDES = config.REFERENCE_DIR / "anatomy_structure_titles.json"
_SEXES = ("male", "female")

WIKIPEDIA_LICENCE = "CC BY-SA 4.0"
WIKIPEDIA_LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"

_BATCH = 20                 # Action API cap for prop=extracts (exlimit=20)
_ONTOLOGY_BATCH = 60        # ontology ids per SPARQL query (300 times out)
_PAUSE_SECONDS = 0.6        # between UNCACHED calls only
_MAX_WORDS = 90
_MIN_WORDS = 20             # the gate's floor; short leads take a 2nd paragraph
_KEYWORD_WINDOW = 400

# --------------------------------------------------------------------------
# Normalisation -- THE CONTRACT WITH THE VIEWER
# --------------------------------------------------------------------------
#
# Z-Anatomy suffixes a side ("(left)", "(right)") and, when one TA2 term is
# modelled as several meshes, a part ("Adductor pollicis - part e1", em dash).
# Both can appear, part first. Nothing else about the name is touched: no case
# folding, no de-parenthesising, no punctuation stripping -- the key stays a
# human-readable anatomical term, and the viewer can reproduce it with the two
# regexes below.
_SIDE_RE = re.compile(r"\s*\((?:left|right)(?:\s*,\s*[^)]*)?\)\s*$", re.IGNORECASE)
_PART_RE = re.compile(r"\s*[—–-]\s*part\s+\S+\s*$", re.IGNORECASE)


def normalise(name: str | None) -> str:
    """The key a structure's description is filed under.

    Collapse whitespace, then strip a trailing side suffix and a trailing
    part suffix, repeatedly, until neither matches.
    """
    text = " ".join((name or "").split())
    previous = None
    while previous != text:
        previous = text
        text = _PART_RE.sub("", _SIDE_RE.sub("", text)).strip()
    return text


# --------------------------------------------------------------------------
# Acceptance
# --------------------------------------------------------------------------

# A lead that mentions none of these is not describing a body part.
# Deliberately broad -- a brain gyrus, a bursa and a body region have little
# vocabulary in common -- since its job is to catch the "Concha is a Mexican
# sweet bread" class of mistake, not to grade anatomical writing. Matching is
# on WORD BOUNDARIES: the first cut of this net matched "ear" inside
# "appearance" and duly accepted the sweet bread.
_ANATOMY_WORDS = """
bone bones muscle muscles nerve nerves nervous artery arteries arterial vein
veins venous organ organs gland glands ligament ligaments cartilage
cartilages joint joints tissue tissues body skin brain lymph lymphatic vessel
vessels blood tendon tendons membrane membranes cavity cavities region
regions limb limbs human humans mammal mammals mammalian vertebrate
vertebrates cortex neuron neurons sinus sinuses duct ducts spinal spine
abdomen abdominal thorax thoracic pelvis pelvic skeleton skeletal fascia
sulcus sulci gyrus gyri nucleus nuclei plexus node nodes bursa bursae septum
fossa canal ventricle ventricles atrium capsule marrow lobe lobes lobule
meninges hormone hormones eye eyes ear ears tooth teeth viscera dorsal
ventral lateral medial posterior anterior superior inferior proximal distal
hand foot feet head neck arm forearm leg thigh knee hip shoulder elbow wrist
ankle heart lung lungs liver kidney kidneys stomach intestine intestinal
aorta aortic trachea tracheal bronchus bronchi oesophagus esophagus pharynx
larynx renal hepatic pulmonary cardiac gastric dermis epidermis follicle
cranium mandible maxilla femur tibia fibula humerus radius ulna scapula
clavicle sternum rib ribs vertebra vertebrae vertebral ganglion ganglia
retina cornea iris eyelid tongue lip lips nostril nose ovary uterus testis
testes prostate bladder ureter urethra colon rectum ileum jejunum caecum
cecum duodenum pancreas spleen thymus tonsil thyroid adrenal breast areola
nipple placenta embryo embryonic foetal fetal synovial articular capillary
capillaries arteriole venule sac lumen anastomosis sphincter fibres fibers
cell cells lobar segmental innervat supplies drains
auricle auricular pinna tubercle tubercles cochlea ossicle ossicles tympanic
meatus cerebellum brainstem medulla pons midbrain thalamus hypothalamus
hippocampus amygdala peduncle commissure fasciculus operculum insula
striatum papilla papillae alveolus alveoli glomerulus nephron villi villus
pleura peritoneum pericardium mesentery omentum diaphragm epiglottis uvula
gingiva enamel dentine follicles sebaceous sweat nail hair
""".split()
_ANATOMY_STEMS = (
    "anatom", "muscul", "skelet", "cartilag", "epitheli", "cerebr",
    "physiolog", "vascul", "neuro", "cortic", "lymphat", "osteo", "myo",
    "arthro", "derma", "visceral", "cutaneous", "subcutaneous",
)
_ANATOMY_RE = re.compile(
    r"\b(?:" + "|".join(sorted(set(_ANATOMY_WORDS), key=len, reverse=True))
    + r")\b|\b(?:" + "|".join(_ANATOMY_STEMS) + r")\w*",
    re.IGNORECASE,
)
_DISAMBIGUATION_RE = re.compile(r"may refer to|may also refer to", re.IGNORECASE)
# The keyword net alone lets a few famous homonyms through: "Bursa" is a city
# in Turkey, "Atlas" a Greek titan, "Iris" a genus. A lead that opens by
# declaring itself one of these is refused whatever words follow. ("band" is
# NOT on this list: half the fasciae and retinacula are "a band of ...".)
_NOT_ANATOMY_RE = re.compile(
    r"\bis (?:a|an|the) (?:city|town|village|municipality|commune|province|"
    r"district|county|country|river|mountain|island|genus|"
    r"species|family of|surname|given name|masculine|feminine|company|brand|"
    r"film|movie|album|song|novel|video game|television|deity|god|"
    r"goddess|titan|constellation|crater|star|asteroid|comet|"
    r"sweet bread|dish|food|drink)\b",
    re.IGNORECASE,
)
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")
_HEADING_RE = re.compile(r"^=+\s")
# An article about a CONDITION is not a description of the structure, however
# much anatomy it names: "Trochanteric bursa" redirects to "Greater
# trochanteric pain syndrome", which is a form of bursitis, not a bursa.
_PATHOLOGY_RE = re.compile(
    r"\b(?:is|are) (?:a |an |the )?[^.]{0,40}?(?:syndrome|disease|disorder|"
    r"inflammation|infection|injury|medical condition|carcinoma|cancer|"
    r"tumou?r|surgical procedure|operation|surgery|fracture)\b",
    re.IGNORECASE,
)


def _reads_as_anatomy(extract: str) -> bool:
    return bool(_ANATOMY_RE.search(extract[:_KEYWORD_WINDOW]))


def trim_extract(extract: str) -> str:
    """The lead paragraph, verbatim, trimmed to ~90 words at a sentence end.

    A one-line lead ("The habenula is a small structure...") would fail the
    twenty-word floor, so paragraphs are accumulated until the floor is met;
    sentences are then dropped from the end until the text fits the ceiling.
    Only whitespace is altered.
    """
    # A beyond-the-intro read carries the article's section headings as plain
    # "== Structure ==" lines. They are not prose -- the heading LINES are
    # dropped and the paragraphs around them run together; the sentences
    # themselves are still quoted word for word.
    paragraphs = [
        block.strip() for block in (extract or "").split("\n")
        if block.strip() and not _HEADING_RE.match(block.strip())
    ]
    kept: list[str] = []
    words = 0
    for paragraph in paragraphs:
        kept.append(paragraph)
        words += len(paragraph.split())
        if words >= _MIN_WORDS + 5:
            break
    text = " ".join(" ".join(kept).split())
    if not text:
        return ""
    # SPLIT, never findall: a findall of "sentence-like" spans silently DROPS
    # a lead whose first full stop is not followed by a space -- Wikipedia's
    # "A bronchus ( BRONG-kəs; pl.: bronchi ...)" opened a dozen extracts
    # mid-word before this was caught.
    sentences = [s for s in _SENTENCE_RE.split(text) if s.strip()]
    out: list[str] = []
    count = 0
    for sentence in sentences:
        length = len(sentence.split())
        if out and count + length > _MAX_WORDS:
            break
        out.append(sentence.strip())
        count += length
    return " ".join(" ".join(out).split())


def _judge(page: dict[str, Any]) -> tuple[str | None, str, str | None]:
    """(trimmed extract, reason, article title). A reason means rejected.

    The third value is the title the page actually LIVES at, which is not
    always the title asked for: "Sixth rib" redirects to "Rib cage" and
    "Gracile fasciculus" to "Dorsal column-medial lemniscus pathway". The
    attribution has to name the article it quotes, so the redirect target is
    what ships.
    """
    title = page.get("title") or None
    if page.get("missing") or page.get("invalid"):
        return None, "no article", None
    if "disambiguation" in (page.get("pageprops") or {}):
        return None, "disambiguation", title
    extract = page.get("extract") or ""
    if not extract.strip():
        return None, "no extract", title
    if _DISAMBIGUATION_RE.search(extract[:600]):
        return None, "disambiguation", title
    if _NOT_ANATOMY_RE.search(extract[:300]):
        return None, "not anatomy (other subject)", title
    # Only the FIRST sentence says what the article is about. Reading further
    # rejected the septum pellucidum for mentioning, three sentences down, the
    # syndrome in which it is absent.
    if _PATHOLOGY_RE.search(_SENTENCE_RE.split(extract.strip())[0][:200]):
        return None, "a condition, not a structure", title
    if not _reads_as_anatomy(extract):
        return None, "not anatomy", title
    trimmed = trim_extract(extract)
    if len(trimmed.split()) < _MIN_WORDS:
        return None, "extract too short", title
    return trimmed, "", title


# --------------------------------------------------------------------------
# Candidate titles
# --------------------------------------------------------------------------

# Rungs whose article describes the KIND of structure, or the structure it
# belongs to, rather than the structure itself. Their entries are flagged
# `"scope": "broader"` and the viewer must say so.
BROADER_RUNGS = frozenset({"override-broader", "head", "parent", "shortened"})

_QUALIFIER_RE = re.compile(r"\s*\([^()]*\)\s*$")
_LEADING_SIDE_RE = re.compile(r"^(?:left|right)\s+", re.IGNORECASE)
_BAD_TITLE_CHARS = ("|", "#", "[", "]", "{", "}", "<", ">")


def _upper_first(text: str) -> str:
    return text[:1].upper() + text[1:] if text else text


def _stripped_variant(name: str) -> str | None:
    """The name with wrapping parens, a trailing qualifier or a leading side off.

    Z-Anatomy wraps INCONSTANT structures in parentheses ("(Adductor minimus)")
    and qualifies homonyms with a trailing bracket ("Abducens nerve (VI)",
    "Anterior meniscotibial ligament (Lateral meniscus)"); the HRA prefixes a
    side onto the term itself ("Right nipple"). None of those belong in an
    article title.
    """
    text = name
    if text.startswith("(") and text.endswith(")") and "(" not in text[1:-1]:
        text = text[1:-1].strip()
    text = _QUALIFIER_RE.sub("", text).strip()
    text = _LEADING_SIDE_RE.sub("", text).strip()
    text = _upper_first(text)
    return text if text and text != name else None


def _singular_variant(name: str) -> str | None:
    """Singularise the last word: "Anterior axillary nodes" -> "... node"."""
    words = name.split()
    if not words:
        return None
    last = words[-1]
    core = last.rstrip(")")
    tail = last[len(core):]
    lowered = core.lower()
    if lowered.endswith("ies") and len(core) > 4:
        singular = core[:-3] + "y"
    elif lowered.endswith(("ches", "shes", "sses", "xes", "zes")):
        singular = core[:-2]
    elif lowered.endswith("ae") and len(core) > 3:          # bursae, fasciae
        singular = core[:-1]
    elif lowered.endswith("a") and lowered.endswith(("ia", "ata")) and len(core) > 4:
        singular = core[:-1] + "on" if lowered.endswith("ia") else core[:-2]
    elif lowered.endswith("s") and not lowered.endswith(("ss", "us", "is", "as")):
        singular = core[:-1]
    else:
        return None
    if len(singular) < 3:
        return None
    candidate = " ".join(words[:-1] + [singular + tail])
    return candidate if candidate != name else None


def _ofthe_variant(name: str) -> str | None:
    if " of the " not in name:
        return None
    return name.replace(" of the ", " of ")


# A head word that only says WHERE or WHICH PART, never WHAT the structure is,
# describes nothing on its own ("Ascending part of duodenum" -> "Ascending
# part"), so the head rung skips it and the parent rung answers instead.
_EMPTY_HEADS = frozenset("""
part parts portion portions segment segments division divisions branch
branches head heads body bodies root roots trunk trunks region regions area
areas surface surfaces border borders margin margins angle angles wall walls
side sides level levels group groups half third layer layers zone zones end
ends base bases apex cavity cavities lumen opening openings aperture
""".split())
# A parent so general that its article would say nothing about the structure.
# Kept deliberately short: "Anterior region of thigh" and "Lateral border of
# foot" are TA2 SURFACE REGIONS, and Wikipedia's "Thigh" and "Foot" are the
# best articles that exist for them.
_EMPTY_PARENTS = frozenset({"body", "human body", "side", "digit", "part"})


def _head_variant(name: str) -> str | None:
    """The kind of structure a compound name names: "Bursa of X" -> "Bursa".

    TA2 composes most names as "<what it is> of <where it is>", and the
    "where" half usually has no article of its own. The generic head is a
    BROADER article: it describes the kind of structure accurately, which is
    what a reader who clicked an unnamed bursa actually needs.
    """
    if " of " not in name:
        return None
    head = name.split(" of ", 1)[0].strip()
    head = _upper_first(_LEADING_SIDE_RE.sub("", head).strip())
    if not head or len(head.split()) > 4:
        return None
    if head.split()[-1].lower() in _EMPTY_HEADS:
        return None
    return _singular_variant(head) or head


# The last word of a name is the kind of thing it is. A name whose modifiers
# have all been dropped is only worth asking about when what is left is one of
# these -- "Nerve" describes a nerve, "Colli" describes nothing.
_KIND_WORDS = frozenset("""
nerve nerves artery arteries vein veins muscle muscles ligament ligaments
tendon tendons bone bones cartilage joint joints bursa node nodes gland glands
sinus sinuses vertebra vertebrae rib ribs incisor canine molar premolar
enthesis fascia aponeurosis retinaculum sheath capsule gyrus sulcus nucleus
ganglion plexus lobule lobe meniscus disc canal foramen tubercle trochlea
condyle epicondyle ramus septum valve ventricle atrium duct tract fissure
cistern membrane epiphysis diaphysis metaphysis periosteum tonsil thymus
""".split())


def _shortened_variants(name: str) -> list[str]:
    """Progressively broader titles: drop the qualifiers, keep the kind.

    "Paracentral lobule caudal part" -> "Paracentral lobule" (trailing words
    off); "Upper medial incisor" -> "Medial incisor" -> "Incisor" (leading
    words off). The single-word end of the walk is only offered when the word
    names a kind of structure.
    """
    words = name.split()
    if len(words) < 2 or " of " in name:
        return []
    out: list[str] = []
    # Every contiguous span that still ENDS on a kind word, the nearest kind
    # word first and the longest span first, so "Mammalian cervical vertebra 3"
    # asks about "Mammalian cervical vertebra", then "Cervical vertebra", then
    # "Vertebra" -- and never about "Superior labial" or "Cervical vertebra 3",
    # which name nothing.
    for end in range(len(words), 0, -1):
        if words[end - 1].lower().strip(".,;") not in _KIND_WORDS:
            continue
        for start in range(0, end):
            if start == 0 and end == len(words):
                continue
            out.append(" ".join(words[start:end]))
    # Longest first: the most specific article that could exist is asked for
    # before the generic one ("Cingulate gyrus" before "Sulcus").
    out.sort(key=lambda candidate: -len(candidate.split()))
    seen: set[str] = set()
    unique: list[str] = []
    for candidate in out:
        candidate = _upper_first(candidate.strip())
        if candidate and candidate != name and candidate.lower() not in seen:
            seen.add(candidate.lower())
            unique.append(candidate)
    return unique[:4]


def _parent_variant(name: str, *, drop_side: bool = True) -> str | None:
    """The structure a compound name hangs off: "Ascending part of X" -> "X".

    Both spellings are tried, side first: "Ascending branch of left colic
    artery" wants "Left colic artery" (a real article), while "Interlobar
    adipose tissue of left mammary gland" wants "Mammary gland".
    """
    if " of " not in name:
        return None
    parent = name.rsplit(" of ", 1)[1].strip()
    parent = re.sub(r"^the\s+", "", parent, flags=re.IGNORECASE).strip()
    if drop_side:
        parent = _LEADING_SIDE_RE.sub("", parent).strip()
    parent = _QUALIFIER_RE.sub("", parent).strip()
    if not parent or parent.lower() in _EMPTY_PARENTS:
        return None
    return _upper_first(parent)


def _candidate_ladder(
    name: str,
    *,
    override: str | None,
    broader_override: str | None,
    ontology_title: str | None,
) -> list[tuple[str, str]]:
    """[(rung, title)] in trial order, de-duplicated, invalid titles dropped."""
    proposals: list[tuple[str, str | None]] = [
        ("override", override),
        ("ontology", ontology_title),
        ("name", _upper_first(name)),
    ]
    stripped = _stripped_variant(name)
    proposals.append(("stripped", stripped))
    for base in (stripped or name, name):
        proposals.append(("singular", _singular_variant(base)))
        proposals.append(("ofthe", _ofthe_variant(base)))
    # Everything below here is a BROADER article, flagged as such in the
    # output so the viewer can say so rather than passing it off as the
    # structure's own entry.
    proposals.append(("override-broader", broader_override))
    for base in (stripped or name, name):
        proposals.append(("head", _head_variant(base)))
    for base in (stripped or name, name):
        proposals.append(("parent", _parent_variant(base, drop_side=False)))
        proposals.append(("parent", _parent_variant(base)))
    for candidate in _shortened_variants(stripped or name):
        proposals.append(("shortened", candidate))
    ladder: list[tuple[str, str]] = []
    seen: set[str] = set()
    for rung, title in proposals:
        if not title:
            continue
        title = " ".join(title.split())
        if any(ch in title for ch in _BAD_TITLE_CHARS) or len(title) > 250:
            continue
        key = title.lower()
        if key in seen:
            continue
        seen.add(key)
        ladder.append((rung, title))
    return ladder


# --------------------------------------------------------------------------
# Wikipedia
# --------------------------------------------------------------------------

def _extract_batches(
    titles: Iterable[str], *, refresh: bool, responses: list[CachedResponse],
    beyond_intro: bool = False,
) -> dict[str, dict[str, Any]]:
    """{requested title: page record} for many titles, twenty per request.

    Redirects and MediaWiki title normalisation are mapped back so the caller
    can look the page up under the title it asked for. A batch that fails
    outright is retried title-by-title rather than losing twenty names.
    """
    ordered = sorted({t for t in titles if t})
    out: dict[str, dict[str, Any]] = {}
    # TextExtracts only answers MORE THAN ONE title when exintro is set, so a
    # beyond-the-intro read goes one title per request. (Batching them looked
    # fine and silently rescued one stub per twenty.)
    size = 1 if beyond_intro else _BATCH
    for start in range(0, len(ordered), size):
        batch = ordered[start:start + size]
        try:
            payload, response = _extract_call(
                batch, refresh=refresh, beyond_intro=beyond_intro)
        except FetchError:
            if len(batch) == 1:
                continue
            for title in batch:                       # one bad title poisons a batch
                try:
                    payload, response = _extract_call(
                        [title], refresh=refresh, beyond_intro=beyond_intro)
                except FetchError:
                    continue
                responses.append(response)
                out.update(_map_pages(payload))
            continue
        responses.append(response)
        out.update(_map_pages(payload))
    return out


def _extract_call(
    batch: list[str], *, refresh: bool, beyond_intro: bool = False,
) -> tuple[dict[str, Any], CachedResponse]:
    """One Action API call. `beyond_intro` asks for the first sentences of the
    whole article instead of the lead section: plenty of anatomy articles are
    stubs whose lead is a single clause ("The superior labial vein drains the
    upper lip."), too short to ship, while the paragraph under it says the
    rest. Same acceptance test either way."""
    scope = ("&exsentences=6&exlimit=1" if beyond_intro
             else f"&exintro=1&exlimit={_BATCH}")
    url = (
        f"{config.WIKIPEDIA_API_URL}?action=query&format=json&formatversion=2"
        f"&prop=extracts%7Cpageprops&ppprop=disambiguation"
        f"{scope}&explaintext=1&redirects=1"
        f"&titles={urllib.parse.quote('|'.join(batch))}"
    )
    response = fetch(url, refresh=refresh, subdir=_SUBDIR, expect_json=True)
    if not response.from_cache:
        time.sleep(_PAUSE_SECONDS)
    return response.read_json().get("query", {}) or {}, response


def _map_pages(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Index pages by every title that leads to them (asked, normalised, final)."""
    # A target can be reached from SEVERAL asked-for titles in one batch
    # ("Cingulate gyrus" and "Cingulate cortex" both land on the latter), so
    # the reverse map holds every origin. Keeping one per target silently lost
    # a name per collision -- and a page nobody could look up reads exactly
    # like a page that does not exist.
    back: dict[str, list[str]] = {}
    for hop in (payload.get("normalized") or []) + (payload.get("redirects") or []):
        back.setdefault(hop["to"], []).append(hop["from"])

    def origins(title: str) -> set[str]:
        chain = {title}
        stack = [title]
        while stack:
            cursor = stack.pop()
            for source in back.get(cursor, ()):
                if source not in chain:
                    chain.add(source)
                    stack.append(source)
        return chain

    out: dict[str, dict[str, Any]] = {}
    for page in payload.get("pages") or []:
        title = page.get("title") or ""
        for key in origins(title):
            out[key] = page
    return out


# --------------------------------------------------------------------------
# Wikidata: UBERON id -> English article
# --------------------------------------------------------------------------

_ONTOLOGY_QUERY = """SELECT ?id ?article WHERE {
  VALUES ?id { %s }
  ?item wdt:%s ?id .
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
}"""

# The HRA labels each structure with an ontology term, and it is not always an
# UBERON one: 268 of the female set's 502 are UBERON, 258 are Foundational
# Model of Anatomy, and 111 are a bare "-" (no term). Wikidata files the two
# under different properties, and stores both ids BARE ("0002107", "10951"),
# never prefixed.
_ONTOLOGY_PROPERTIES = {"UBERON": "P1554", "FMA": "P1402"}


def _ontology_titles(
    ids: Iterable[str], *, refresh: bool, responses: list[CachedResponse],
) -> tuple[dict[str, str], list[str]]:
    """{'UBERON:0002107': 'Liver'} via Wikidata, plus the queries that failed.

    Chunks are small on purpose: a VALUES clause of 300 literals times the
    query service out (HTTP 500), and the first cut of this stage swallowed
    that and silently resolved an eighth of the ids.
    """
    parsed: dict[str, list[str]] = {prefix: [] for prefix in _ONTOLOGY_PROPERTIES}
    for identifier in sorted({i for i in ids if i}):
        for prefix in _ONTOLOGY_PROPERTIES:
            if identifier.upper().startswith(prefix):
                bare = identifier.split(":", 1)[-1].strip()
                if bare.isdigit():
                    parsed[prefix].append(identifier)
                break
    out: dict[str, str] = {}
    failures: list[str] = []
    for prefix, identifiers in parsed.items():
        prop = _ONTOLOGY_PROPERTIES[prefix]
        for start in range(0, len(identifiers), _ONTOLOGY_BATCH):
            chunk = identifiers[start:start + _ONTOLOGY_BATCH]
            values = " ".join(f'"{i.split(":", 1)[-1]}"' for i in chunk)
            query = _ONTOLOGY_QUERY % (values, prop)
            url = (f"{config.WIKIDATA_SPARQL}?format=json&query="
                   f"{urllib.parse.quote(query)}")
            try:
                response = fetch(
                    url, refresh=refresh, subdir=_SUBDIR, expect_json=True,
                    headers={"Accept": "application/sparql-results+json"},
                )
            except FetchError as exc:
                failures.append(f"{prefix} {chunk[0]}..{chunk[-1]}: {exc}"[:200])
                continue
            if not response.from_cache:
                time.sleep(_PAUSE_SECONDS)
            responses.append(response)
            by_bare: dict[str, str] = {}
            for row in response.read_json()["results"]["bindings"]:
                article = row["article"]["value"]
                title = urllib.parse.unquote(
                    article.rsplit("/", 1)[-1]).replace("_", " ")
                by_bare.setdefault(row["id"]["value"], title)
            for identifier in chunk:
                title = by_bare.get(identifier.split(":", 1)[-1])
                if title:
                    out[identifier] = title
    return out, failures


# --------------------------------------------------------------------------
# The stage
# --------------------------------------------------------------------------

def _load_structures() -> dict[str, dict[str, Any]]:
    """Group every structure row in both models by normalised name."""
    groups: dict[str, dict[str, Any]] = {}
    for sex in _SEXES:
        path = _MODEL_DIR / f"structures-{sex}.json"
        if not path.exists():
            raise FetchError(
                f"{path} is missing; run `npm run build:anatomy-models` first."
            )
        for row in json.loads(path.read_text("utf-8"))["structures"]:
            key = normalise(row.get("name"))
            if not key:
                continue
            group = groups.setdefault(key, {
                "count": 0, "systems": set(), "layers": set(), "groups": set(),
                "sexes": set(), "latin": None, "ontology": None,
            })
            group["count"] += 1
            group["sexes"].add(sex)
            if row.get("system"):
                group["systems"].add(row["system"])
            if row.get("layer"):
                group["layers"].add(row["layer"])
            if row.get("group"):
                group["groups"].add(row["group"])
            if row.get("latin") and not group["latin"]:
                group["latin"] = row["latin"]
            if row.get("ontology") and not group["ontology"]:
                group["ontology"] = row["ontology"]
    return groups


def _load_overrides() -> tuple[dict[str, str], dict[str, str], dict[str, str], int]:
    if not _OVERRIDES.exists():
        return {}, {}, {}, 0
    document = json.loads(_OVERRIDES.read_text("utf-8"))
    titles = {normalise(k): v for k, v in (document.get("titles") or {}).items() if v}
    broader = {normalise(k): v for k, v in (document.get("broader") or {}).items() if v}
    rejects = {normalise(k): v for k, v in (document.get("rejected") or {}).items()}
    return titles, broader, rejects, document.get("version", 1)


def build(refresh: bool) -> tuple[dict[str, Any], dict[str, Any], list[CachedResponse]]:
    started = time.time()
    groups = _load_structures()
    override_titles, override_broader, override_rejects, override_version = _load_overrides()
    responses: list[CachedResponse] = []

    ontology_ids = {g["ontology"] for g in groups.values() if g["ontology"]}
    ontology, ontology_failures = _ontology_titles(
        ontology_ids, refresh=refresh, responses=responses)
    print(f"    anatomy_structures: {len(groups)} base names, "
          f"{len(ontology)}/{len(ontology_ids)} ontology ids carry an English "
          f"article{' (' + str(len(ontology_failures)) + ' queries failed)' if ontology_failures else ''}",
          flush=True)

    ladders = {
        name: _candidate_ladder(
            name,
            override=override_titles.get(name),
            broader_override=override_broader.get(name),
            ontology_title=(ontology.get(group["ontology"])
                            if group["ontology"] else None),
        )
        for name, group in groups.items()
    }

    resolved: dict[str, dict[str, Any]] = {}
    rejects: dict[str, list[str]] = {}
    judged: dict[str, tuple[str | None, str, str | None]] = {}
    pending = {
        name: 0 for name in groups
        if name not in override_rejects
    }
    for name, reason in override_rejects.items():
        if name in groups:
            rejects.setdefault(name, []).append(f"override: {reason}")

    # Walk every name down its ladder together, so each round is one batched
    # sweep of the titles nobody has judged yet. A title judged for one name is
    # never fetched again for another ("Cancellous bone" is the UBERON answer
    # for a dozen spongy-bone meshes).
    for round_index in range(12):
        if not pending:
            break
        wanted: set[str] = set()
        for name in list(pending):
            index = pending[name]
            ladder = ladders[name]
            while index < len(ladder):
                rung, title = ladder[index]
                verdict = judged.get(title)
                if verdict is None:
                    wanted.add(title)
                    break
                if verdict[0]:
                    resolved[name] = {
                        "title": verdict[2] or title, "asked": title,
                        "rung": rung, "extract": verdict[0]}
                    break
                rejects.setdefault(name, []).append(f"{title}: {verdict[1]}")
                index += 1
            pending[name] = index
            if index >= len(ladder) or name in resolved:
                del pending[name]
        if not wanted:
            break
        titles_to_fetch = sorted(wanted)
        print(f"      round {round_index}: {len(titles_to_fetch)} titles "
              f"({(len(titles_to_fetch) + _BATCH - 1) // _BATCH} batches)",
              flush=True)
        pages = _extract_batches(
            titles_to_fetch, refresh=refresh, responses=responses)
        for title in titles_to_fetch:
            page = pages.get(title)
            judged[title] = _judge(page) if page else (None, "no article", None)
        # Stub leads -- and pages the batch answered with no extract at all,
        # which TextExtracts does now and then when a twenty-title response
        # runs long ("Cingulate gyrus" came back empty in one batch and
        # perfectly well on its own) -- are asked for again, one at a time.
        stubs = sorted(t for t in titles_to_fetch
                       if judged[t][1] in ("extract too short", "no extract"))
        if stubs:
            print(f"        {len(stubs)} stub leads re-read beyond the intro",
                  flush=True)
            pages = _extract_batches(
                stubs, refresh=refresh, responses=responses, beyond_intro=True)
            for title in stubs:
                page = pages.get(title)
                if page:
                    verdict = _judge(page)
                    if verdict[0]:
                        judged[title] = verdict

    # The resolved title is the one we ASKED for; record where the article
    # actually lives so the URL is the article, redirect or not.
    document_structures: dict[str, dict[str, Any]] = {}
    by_rung: dict[str, int] = {}
    for name in sorted(groups):
        group = groups[name]
        shared = {
            "latin": group["latin"],
            "systems": sorted(group["systems"]),
            "layers": sorted(group["layers"]),
            "count": group["count"],
        }
        if group["ontology"]:
            shared["ontology"] = group["ontology"]
        hit = resolved.get(name)
        if hit:
            by_rung[hit["rung"]] = by_rung.get(hit["rung"], 0) + 1
            document_structures[name] = {
                "title": hit["title"],
                "url": "https://en.wikipedia.org/wiki/"
                       + urllib.parse.quote(hit["title"].replace(" ", "_")),
                "extract": hit["extract"],
                "resolvedBy": hit["rung"],
                **({"asked": hit["asked"]}
                   if hit["asked"] != hit["title"] else {}),
                "scope": "broader" if hit["rung"] in BROADER_RUNGS else "exact",
                **shared,
            }
        else:
            tried = rejects.get(name) or []
            reason = tried[-1].split(": ", 1)[-1] if tried else "no candidate title"
            document_structures[name] = {
                "title": None,
                "reason": reason,
                "tried": [t.split(": ", 1)[0] for t in tried][:6],
                **shared,
            }

    covered = sum(1 for v in document_structures.values() if v.get("title"))
    exact = sum(1 for v in document_structures.values() if v.get("scope") == "exact")
    broader = covered - exact
    document = {
        "version": 1,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {
            "title": "Wikipedia",
            "url": "https://en.wikipedia.org/",
            "licence": WIKIPEDIA_LICENCE,
            "licenceUrl": WIKIPEDIA_LICENCE_URL,
            "note": (
                "Each description is the opening of the English Wikipedia "
                "article named in `title`, quoted verbatim and trimmed to about "
                "ninety words at a sentence boundary (where the lead was too "
                "short to stand alone, the sentences under it continue it, "
                "section headings omitted). Text is CC BY-SA 4.0; reuse must "
                "credit the article and share alike."
            ),
        },
        "normalisation": (
            "key = name with whitespace collapsed, then a trailing \" (left)\" / "
            "\" (right)\" / \" (left, a)\" side suffix and a trailing "
            "\" \\u2014 part e1\" part suffix stripped repeatedly until neither "
            "matches. Nothing else is changed."
        ),
        "scopeNote": (
            "scope=\"exact\": the article is about this structure (a redirect "
            "counts). scope=\"broader\": no article exists for the structure "
            "itself, so the article named describes the KIND of structure "
            "(\"Bursa\" for \"Bursa of the piriformis muscle\") or the structure "
            "it belongs to (\"Duodenum\" for \"Ascending part of duodenum\") — "
            "say so when rendering it, never pass it off as the structure's own "
            "entry."
        ),
        "counts": {
            "names": len(document_structures),
            "described": covered,
            "exact": exact,
            "broader": broader,
            "coverage": round(covered / max(len(document_structures), 1), 4),
            "exactCoverage": round(exact / max(len(document_structures), 1), 4),
            "byRung": dict(sorted(by_rung.items())),
        },
        "overrideVersion": override_version,
        "structures": document_structures,
    }

    uncovered_groups: dict[str, int] = {}
    for name, entry in document_structures.items():
        if entry.get("title"):
            continue
        for group_name in sorted(groups[name]["groups"]) or ["(no group)"]:
            uncovered_groups[group_name] = uncovered_groups.get(group_name, 0) + 1
    reason_counts: dict[str, int] = {}
    for entry in document_structures.values():
        if not entry.get("title"):
            reason_counts[entry["reason"]] = reason_counts.get(entry["reason"], 0) + 1

    log = {
        "generated": document["generated"],
        "baseNames": len(document_structures),
        "structureRows": sum(g["count"] for g in groups.values()),
        "described": covered,
        "exact": exact,
        "broader": broader,
        "coverage": document["counts"]["coverage"],
        "exactCoverage": document["counts"]["exactCoverage"],
        "byRung": document["counts"]["byRung"],
        "ontologyIds": len(ontology_ids),
        "ontologyResolved": len(ontology),
        "ontologyQueryFailures": ontology_failures,
        "titlesJudged": len(judged),
        "titlesAccepted": sum(1 for v in judged.values() if v[0]),
        "rejectReasons": dict(sorted(
            reason_counts.items(), key=lambda kv: -kv[1])),
        "uncoveredByGroup": dict(sorted(
            uncovered_groups.items(), key=lambda kv: -kv[1])),
        "uncovered": sorted(
            name for name, entry in document_structures.items()
            if not entry.get("title")),
        "requests": len(responses),
        "elapsedSeconds": round(time.time() - started, 1),
    }
    return document, log, responses


def ingest(
    registry: dict[str, Entity],
    *,
    refresh: bool,
    manifest: dict[str, Any],
) -> None:
    del registry  # the body is not keyed by country
    document, log, responses = build(refresh)

    _OUT.parent.mkdir(parents=True, exist_ok=True)
    _OUT.write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    config.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    (config.LOGS_DIR / "anatomy_structures.log").write_text(
        json.dumps(log, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )

    counts = document["counts"]
    fetched_at = (max(r.fetched_at for r in responses) if responses
                  else manifest["generated_at"])
    manifest_mod.record_source(
        manifest, "anatomy_structures",
        title="English Wikipedia lead extracts for the 3-D anatomy structures",
        url="https://en.wikipedia.org/w/api.php",
        licence=f"{WIKIPEDIA_LICENCE} ({WIKIPEDIA_LICENCE_URL}) — article title "
                f"and URL carried with every extract",
        fetched_at=fetched_at, upstream_release=None,
        vintage=f"fetched {fetched_at[:10]}",
        citation="English Wikipedia contributors; article titles recorded per structure",
        notes=(f"{counts['described']} of {counts['names']} normalised structure "
               f"names described ({counts['coverage'] * 100:.1f}%), of which "
               f"{counts['exact']} name the structure itself and "
               f"{counts['broader']} name a broader article (flagged "
               f"scope=broader); resolution by rung {counts['byRung']}."),
    )
    manifest_mod.record_artifact(
        manifest, "anatomy/structures-wiki.json",
        description="Sourced description for each named structure in the 3-D "
                    "anatomy models, keyed by normalised name; unresolved names "
                    "carry a null title and a reason.",
        sources=["anatomy_structures"], row_count=counts["names"],
    )
    if counts["coverage"] < 0.85:
        manifest_mod.add_warning(
            manifest,
            f"anatomy_structures: only {counts['coverage'] * 100:.1f}% of "
            f"structure names have a sourced description "
            f"(target 85%); see etl/logs/anatomy_structures.log.",
        )
    print(f"    anatomy_structures: {counts['described']}/{counts['names']} names "
          f"described ({counts['coverage'] * 100:.1f}%; {counts['exact']} exact, "
          f"{counts['broader']} broader), {log['requests']} requests, "
          f"{log['elapsedSeconds']}s", flush=True)


__all__ = ["ingest", "build", "normalise", "trim_extract"]
