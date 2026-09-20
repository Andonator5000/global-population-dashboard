"""Write `anatomy_structure_titles.json`: the editorial title table for the
3-D anatomy structure descriptions (round 13, DATA_DECISIONS section 66).

The `anatomy_structures` stage resolves ~2,400 structure names to English
Wikipedia articles down a ladder (override -> ontology/Wikidata -> name ->
stripped -> singular -> "of the" -> override-broader -> head -> parent ->
shortened). This file supplies two of those rungs:

* `titles`   -- rung 1, EXACT: the article really is about this structure, but
                the ladder cannot find it (the bare term is a disambiguation
                page, or Wikipedia files it under another name).
* `broader`  -- rung 7, BROADER: no article exists for the structure, and a
                person chose the nearest article that does. Tried only AFTER
                every exact rung has failed, so it never displaces a real
                match. Entries land in the artifact with `"scope": "broader"`
                and the viewer must say so.
* `rejected` -- names a person looked for and did not find, with the reason;
                the run stops spending requests on them.

Most of `broader` is written by the FAMILIES rules below: the model names come
in large, perfectly regular series (seventy-odd lymph nodes, twenty-seven
bronchi, twenty-three nuclei pulposi, twenty-one spinal-cord segments) that
Wikipedia documents collectively, not one article each. A rule is an editorial
decision about the whole series; the builder expands it against the names the
models actually carry, so the JSON stays explicit and reviewable.

Run it after editing:

    .venv\\Scripts\\python etl\\reference\\build_anatomy_structure_titles.py

NEVER hand-edit the JSON -- edit the Python literals below and re-run, exactly
as `build_anatomy.py` writes `anatomy.json`. A wrong title here does not ship:
the stage still applies its acceptance test (exists, not a disambiguation
page, reads as anatomy, twenty words or more), so a bad guess costs coverage,
never correctness.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from etl.sources.anatomy_structures import normalise  # noqa: E402

VERSION = 1
MODELS = pathlib.Path(__file__).resolve().parents[2] / "data" / "anatomy" / "models"

# --------------------------------------------------------------------------
# rung 1 -- EXACT titles the ladder cannot find
# --------------------------------------------------------------------------
TITLES: dict[str, str] = {
    # The bare term is a disambiguation page.
    "Tragus": "Tragus (ear)",
    "Antitragus": "Antitragus",
    "Helix": "Helix (ear)",
    "Palm": "Palm (anatomy)",
    "Axis (C2)": "Axis (anatomy)",
    "Atlas (C1)": "Atlas (anatomy)",
    "Left iris": "Iris (anatomy)",
    "Right iris": "Iris (anatomy)",
    "Left lens": "Lens (vertebrate anatomy)",
    "Right lens": "Lens (vertebrate anatomy)",
    "Meniscus": "Meniscus (anatomy)",
    "Culmen": "Culmen (cerebellum)",
    "Hilum": "Root of the lung",
    "Left cardiac atrium": "Atrium (heart)",
    "Right cardiac atrium": "Atrium (heart)",
    "Inferior frontal sulcus": "Inferior frontal gyrus",
    "Medial geniculate body": "Medial geniculate nucleus",
    "Head of caudate": "Caudate nucleus",
    "Body of caudate": "Caudate nucleus",
    "Base of peduncle": "Cerebral peduncle",
    "Nail plate": "Nail (anatomy)",
    "Nail plate (foot)": "Nail (anatomy)",
    "Perionyx": "Eponychium",
    "Perionyx (foot)": "Eponychium",
    "Labial commissure": "Lip",
    "Mentolabial sulcus": "Chin",
    "Left female areola": "Areola",
    "Right female areola": "Areola",
    "Main lactiferous ducts": "Lactiferous duct",
    "Left corneoscleral junction": "Corneal limbus",
    "Right corneoscleral junction": "Corneal limbus",
    "Spinal dura": "Dura mater",
    "Intermediate bronchus": "Bronchus",
    "Left Main Bronchus": "Main bronchus",
    "Right Main Bronchus": "Main bronchus",
    "Aortic arch": "Aortic arch",
    "Carotid triangle": "Carotid triangle",
    "Anterior fasciculus proprius": "Fasciculus proprius",
    "Posterior fasciculus proprius": "Fasciculus proprius",
    "Cerebral peduncle crus cerebri": "Cerebral crus",
    "Superior cerebellar peduncle brachium conjunctivum": "Superior cerebellar peduncle",
    "Cerebellar deep nuclei": "Deep cerebellar nuclei",
    "Amygdaloid complex": "Amygdala",
    "Anterior amygdaloid area": "Amygdala",
    "Anterior cortical nucleus": "Amygdala",
    "Posterior cortical nucleus": "Amygdala",
    "Limen insula": "Insular cortex",
    "Long insular gyri": "Insular cortex",
    "Short insular gyri": "Insular cortex",
    "Piriform region": "Piriform cortex",
    "Planum polare": "Superior temporal gyrus",
    "Temporal plane": "Planum temporale",
    "Pretectal region": "Pretectal area",
    "Posteroventral putamen": "Putamen",
    "Superior occipital gyri": "Occipital lobe",
    "Areolar tubercles": "Areolar gland",
    "Mammary lobes": "Mammary gland",
    "Cymba conchae": "Auricle (anatomy)",
    "Eminentia conchae": "Auricle (anatomy)",
    "Eminentia scaphae": "Auricle (anatomy)",
    "Eminentia fossae triangularis": "Auricle (anatomy)",
    "Fossa antihelica": "Antihelix",
    "Apex of auricle": "Auricle (anatomy)",
    "Anterior notch of auricle": "Auricle (anatomy)",
    "Posterior auricular groove": "Auricle (anatomy)",
    "Auricular region": "Auricle (anatomy)",
    "Dorsal interossei muscles of foot": "Dorsal interossei of the foot",
    "Flexor digiti minimi of foot": "Flexor digiti minimi brevis muscle (foot)",
    "Lateral head of flexor hallucis brevis": "Flexor hallucis brevis muscle",
    "Medial head of flexor hallucis brevis": "Flexor hallucis brevis muscle",
    "Extensor digitorum longus": "Extensor digitorum longus muscle",
    "Inferior fibular retinaculum": "Inferior fibular retinaculum",
    "Superior fibular retinaculum": "Superior fibular retinaculum",
    "Lateral patellar retinaculum": "Patellar retinaculum",
    "Dorsal carpal anastomosis": "Dorsal carpal arch",
    "Plantar arch": "Plantar arch",
    "Intrarenal arteries of left kidney": "Interlobar arteries",
    "Intrarenal arteries of right kidney": "Interlobar arteries",
    "Dorsal digital arteries of foot": "Dorsal digital arteries of foot",
    "Left coronary leaflet": "Aortic valve",
    "Right coronary leaflet": "Aortic valve",
    "Non-coronary leaflet": "Aortic valve",
    "Distal most point of medial condyle": "Medial condyle of femur",
    # --- second pass, after reading the first run's 113 unresolved names ---
    # Bare terms Wikipedia disambiguates.
    "Diaphragm": "Thoracic diaphragm",
    "Iris": "Iris (anatomy)",
    "Lens": "Lens (vertebrate anatomy)",
    "Talus": "Talus bone",
    "Umbilicus": "Navel",
    "Sole": "Sole (foot)",
    "Olive": "Olivary body",
    "Linea alba": "Linea alba (abdomen)",
    "Upper canine": "Canine tooth",
    "Lower canine": "Canine tooth",
    "Temporal region": "Temple (anatomy)",
    "Interpubic disc": "Pubic symphysis",
    "Aqueduct of midbrain": "Cerebral aqueduct",
    # Z-Anatomy spellings and older names.
    "Bucinator": "Buccinator muscle",
    "Levator nasolabialis": "Levator labii superioris alaeque nasi muscle",
    "Levatores breves costarum": "Levatores costarum muscles",
    "Levatores longi costarum": "Levatores costarum muscles",
    "Free taenia": "Taenia coli",
    "Mesocolic taenia": "Taenia coli",
    "Omental taenia": "Taenia coli",
    "Lymph vasculature": "Lymphatic vessel",
    "Radial foveola": "Anatomical snuff box",
    "Greater supraclavicular fossa": "Supraclavicular fossa",
    "Lesser supraclavicular fossa": "Supraclavicular fossa",
    "Lateral perichondular surface": "Perichondrium",
    "Medial perichondular surface": "Perichondrium",
}

# --------------------------------------------------------------------------
# rung 7 -- BROADER: the nearest real article, chosen by hand
# --------------------------------------------------------------------------
BROADER: dict[str, str] = {
    # The eight Couinaud liver segments; Wikipedia describes them in the
    # liver's own article, not one article each.
    "Left anterolateral segment": "Liver",
    "Left inferomedial segment": "Liver",
    "Left superomedial segment": "Liver",
    "Left superomedial segment1": "Liver",
    "Right anteroinferior segment": "Liver",
    "Right anterosuperior segment": "Liver",
    "Right posteroinferior segment": "Liver",
    "Right posterosuperior segment": "Liver",
    # Femur landmarks the HRA names per side and aspect.
    "Intercondylar fossa of left femur": "Intercondylar fossa of femur",
    "Intercondylar fossa of right femur": "Intercondylar fossa of femur",
    "Lateral condyle of femur frontal": "Lateral condyle of femur",
    "Lateral condyle of femur inf": "Lateral condyle of femur",
    "Lateral condyle of femur sup": "Lateral condyle of femur",
    "Medial condyle of left femur inf": "Medial condyle of femur",
    "Medial condyle of left femur sup": "Medial condyle of femur",
    "Medial condyle of right femur inf": "Medial condyle of femur",
    "Medial condyle of right femur sup": "Medial condyle of femur",
    "Patellar surface of left femur": "Femur",
    "Patellar surface of right femur": "Femur",
    # Lung hilum, sliced three ways by the HRA.
    "Hilum lower": "Root of the lung",
    "Hilum middle": "Root of the lung",
    "Hilum upper": "Root of the lung",
    # Breast.
    "Interlobar adipose tissue of left mammary gland": "Mammary gland",
    "Interlobar adipose tissue of right mammary gland": "Mammary gland",
    # Brain regions the Allen atlas splits finer than Wikipedia does.
    "Central nuclear group": "Thalamus",
    "Midline nuclear complex": "Thalamus",
    "Ingulo parahippocampal isthmus": "Parahippocampal gyrus",
    "Perirhinal gyrus rostral part of FuGt": "Perirhinal cortex",
    "Lateral intermediate substance": "Spinal cord",
    "Spinal reticular process": "Spinal cord",
    "Frenula capsulae": "Internal capsule",
    # --- second pass: TA2 body-surface regions. Wikipedia has an article for
    # the PART, not for the region of skin over it; the region entries say so.
    "Anal region": "Anus",
    "Buccal region": "Cheek",
    "Deltoid region": "Deltoid muscle",
    "Infra-orbital region": "Orbit (anatomy)",
    "Orbital region": "Orbit (anatomy)",
    "Inframammary region": "Breast",
    "Mammary region": "Breast",
    "Presternal region": "Sternum",
    "Infrascapular region": "Scapula",
    "Interscapular region": "Scapula",
    "Scapular region": "Scapula",
    "Vertebral region": "Vertebral column",
    "Sternocleidomastoid region": "Sternocleidomastoid muscle",
    "Parotideomasseteric region": "Parotid gland",
    "Mental region": "Chin",
    "Oral region": "Mouth",
    "Zygomatic region": "Zygomatic bone",
    "Urogenital region": "Perineum",
    "Heel region": "Heel",
    "Metatarsal region": "Metatarsal bones",
    "Hallucial eminence": "Hallux",
    "Lateral bicipital groove": "Arm",
    "Lateral retromalleolar region": "Malleolus",
    "Medial retromalleolar region": "Malleolus",
    "Triangular fossa": "Auricle (anatomy)",
    "Cavity of concha": "Auricle (anatomy)",
    "Concha of auricle": "Auricle (anatomy)",
    # Hypothalamic subdivisions the Allen atlas names, Wikipedia does not.
    "Mammillary region of HTH": "Hypothalamus",
    "Preoptic region of HTH": "Hypothalamus",
    "Supraoptic region of HTH": "Hypothalamus",
    "Tuberal region of HTH": "Hypothalamus",
    "Frontal operculum": "Insular cortex",
    "Parietal operculum": "Insular cortex",
    # Cerebral branches named by Z-Anatomy but not by Wikipedia.
    "Distal lateral striate branches": "Middle cerebral artery",
    "Proximal lateral striate branches": "Middle cerebral artery",
    # Other compounds with no article of their own.
    "Anterior ligament of fibular head": "Superior tibiofibular joint",
    "Posterior ligament of fibular head": "Superior tibiofibular joint",
    "Cervicovaginal junction": "Cervix",
    "External cervical os": "Cervix",
    "Lower uterine segment": "Uterus",
    "Fundus of urinary bladder base": "Urinary bladder",
    "Fundus of urinary bladder dome": "Urinary bladder",
    "Mesocolon": "Mesentery",
    "Vestibule": "Inner ear",
    "Cingulate gyrus and sulcus (Middle anterior part)": "Cingulate gyrus",
    "Cingulate gyrus and sulcus (Middle posterior part)": "Cingulate gyrus",
    "Cingulate gyrus and sulcus (Posterior dorsal part)": "Cingulate gyrus",
    "Insula (Subcentral gyrus and ant. and post. sulci*)": "Insular cortex",
    "Dorsal parts of lateral intertransversarii lumborum muscles": "Intertransversarii muscles",
    "Ventral parts of lateral intertransversarii lumborum muscles": "Intertransversarii muscles",
}

# --------------------------------------------------------------------------
# rung 7 -- BROADER, by family. (regex on the normalised name, the article
# chosen for the whole series, and why.)
# --------------------------------------------------------------------------
FAMILIES: list[tuple[str, str, str]] = [
    (r"\bnodes?\)?$", "Lymph node",
     "TA2 names ~90 named lymph-node groups; Wikipedia documents them in the "
     "lymph-node article and a handful of regional ones."),
    (r"\bbursae?$", "Synovial bursa",
     "68 named bursae, one article."),
    (r"\bbronchus\b", "Bronchus",
     "The segmental bronchi are named individually in TA2 and collectively on "
     "Wikipedia (the qualifier can trail: '... of left lung (BVIII)')."),
    (r"\bbronchopulmonary segment\b", "Bronchopulmonary segment",
     "Likewise the ten segments per lung."),
    (r"^nucleus pulposus\b", "Nucleus pulposus",
     "One nucleus pulposus per disc, one article."),
    (r"\bspinal cord segment$", "Spinal cord",
     "31 segments, described together in the spinal-cord article."),
    (r"\bretinacul(um|a)$", "Retinaculum",
     "The named retinacula share one article."),
    (r"\bconjunctiva\b", "Conjunctiva",
     "Bulbar and palpebral conjunctiva, per eyelid, share one article."),
    (r"^cervical vertebra|^vertebra c\d", "Cervical vertebrae",
     "The seven cervical vertebrae are one article."),
    (r"^thoracic vertebra|^vertebra t\d", "Thoracic vertebrae", "As above."),
    (r"^lumbar vertebra|^vertebra l\d", "Lumbar vertebrae", "As above."),
    (r"^intervertebral disc\b", "Intervertebral disc", "As above."),
    (r"\bpapillary muscle\b", "Papillary muscle",
     "The heart's papillary muscles are named per ventricle, head and cusp in "
     "the models; Wikipedia describes them in one article."),
    (r"^(costal cartilage|rib) ", "Rib cage",
     "Numbered ribs and their cartilages are described in the rib-cage "
     "article."),
]

# --------------------------------------------------------------------------
# Names a person looked for and did not find
# --------------------------------------------------------------------------
REJECTED: dict[str, str] = {
    "Lat_Fis-ant-Horizont": "Allen Human Brain Atlas internal label, not a term",
    "Lat_Fis-ant-Vertical": "Allen Human Brain Atlas internal label, not a term",
    "Lat_Fis-post": "Allen Human Brain Atlas internal label, not a term",
    "Sulcus interm_prim-Jensen": "Allen Human Brain Atlas internal label, not a term",
    "Frontal agranular insular cortex area Fl":
        "Allen Human Brain Atlas cytoarchitectonic area; no Wikipedia article",
    "Temporal agranular insular cortex area Tl":
        "Allen Human Brain Atlas cytoarchitectonic area; no Wikipedia article",
    "Anterior occipital sulcus*":
        "Z-Anatomy marks this label provisional (*); no Wikipedia article",
    "Central canal'": "Z-Anatomy label artefact (trailing apostrophe)",
}


def _model_names() -> list[str]:
    names: set[str] = set()
    for sex in ("male", "female"):
        path = MODELS / f"structures-{sex}.json"
        for row in json.loads(path.read_text("utf-8"))["structures"]:
            key = normalise(row.get("name"))
            if key:
                names.add(key)
    return sorted(names)


def main() -> None:
    out = pathlib.Path(__file__).resolve().parent / "anatomy_structure_titles.json"
    names = _model_names()
    broader = dict(BROADER)
    family_counts: list[dict[str, object]] = []
    for pattern, title, why in FAMILIES:
        matcher = re.compile(pattern, re.IGNORECASE)
        matched = [n for n in names if matcher.search(n)]
        for name in matched:
            broader.setdefault(name, title)
        family_counts.append({"pattern": pattern, "title": title,
                              "matched": len(matched), "why": why})

    unknown = [k for k in (*TITLES, *BROADER, *REJECTED)
               if normalise(k) not in set(names)]
    document = {
        "version": VERSION,
        "note": (
            "Editorial title table for the anatomy_structures stage. Built by "
            "etl/reference/build_anatomy_structure_titles.py -- never hand-edited. "
            "`titles` is rung 1 (exact articles the ladder cannot find); "
            "`broader` is rung 7, tried only after every exact rung fails, and "
            "ships as scope=broader; `rejected` records names with no article."
        ),
        "families": family_counts,
        "titles": dict(sorted(TITLES.items())),
        "broader": dict(sorted(broader.items())),
        "rejected": dict(sorted(REJECTED.items())),
    }
    out.write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8", newline="\n",
    )
    print(f"wrote {out}")
    print(f"  {len(TITLES)} exact titles, {len(broader)} broader "
          f"({len(broader) - len(BROADER)} from {len(FAMILIES)} family rules), "
          f"{len(REJECTED)} rejections")
    for family in family_counts:
        print(f"    {family['matched']:>4}  {family['pattern']} -> {family['title']}")
    if unknown:
        print(f"  ! {len(unknown)} table keys match no name in the models: "
              f"{', '.join(sorted(unknown)[:10])}")


if __name__ == "__main__":
    main()
