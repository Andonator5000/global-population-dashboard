/**
 * Loaders, types and the rank system for the Taxonomy page
 * (Phase 5 §31, round-2 §39, round-3 phase 3 §44).
 *
 * The tree artifact holds Life down to family rank in one document — the
 * page renders it lazily, so the DOM only ever carries expanded branches.
 * Below family the data is ON-DEMAND (§44.5): one static file per family
 * lists its genera (with the intermediate subfamily/tribe/subgenus levels
 * exactly as Catalogue of Life records them), fetched when the family is
 * expanded; species under a genus come from LIVE ChecklistBank calls — a
 * documented render-time exception, like the Trek tiles of §41.2 — because
 * one file per genus (~200k files) is impractical for the repository.
 */

import { useEffect, useState } from 'react'

import { DATA_BASE_URL } from '../config'
import type { AsyncState } from './data'

export interface TaxonImage {
  url: string
  license: string
  author: string | null
  page: string
  /** Set when the photo is borrowed from a photographed member: the name
      of that descendant taxon (round-2 representative-photo pass). */
  rep?: string
}

/** Where a node's description came from (§44.3): the ETL fills them in
    this order and records the winner; `generated` is composed from
    Catalogue of Life facts and is ALWAYS labelled as such in the UI. */
export type DescSource = 'wikipedia' | 'wikidata' | 'col' | 'generated'

export interface TaxonNode {
  id: string
  name: string
  rank: string
  /** Accepted descendant taxa recorded beneath this node in Catalogue of
      Life (counted from the bulk export; synonyms excluded). */
  names: number
  auth?: string
  /** English Wikipedia title, or null meaning "checked, none recorded"
      (for a `pending` genus: not yet looked up — see below). */
  wiki: string | null
  common?: string
  /** Short inline description (Wikidata description or COL remark). For
      `wikipedia`/`generated` sources the text lives in the extract shards
      (tree) or is composed from facts (genera/live nodes). */
  desc?: string
  descSrc?: DescSource
  /** Licence-gated Commons photo, or null = "checked, none free" (§39). */
  img: TaxonImage | null
  /** NCBI taxid (Wikidata P685) — powers the Lifemap link. */
  ncbi?: string
  /** Open Tree of Life id (P9157). */
  ott?: string
  /** Stated start of the taxon's temporal range, Ma (Wikidata P523). */
  firstMa?: number
  /** Contested-placement annotation (etl/reference/taxonomy_notes.json). */
  note?: string
  provisional?: boolean
  /** COL marks the taxon extinct. */
  extinct?: boolean
  /** Children were capped at fetch time; the list is knowingly incomplete. */
  truncated?: boolean
  /** Editorial focus family: its genera file carries species inline,
      enriched at build time (etl/reference/taxonomy_focus.json). */
  focus?: boolean
  /** Number of genera in this family's on-demand genera/{id}.json file. */
  gen?: number
  /** Species recorded beneath this node in COL. */
  spp?: number
  /** Direct accepted children in COL that are NOT shipped statically —
      they load live from ChecklistBank when the node is expanded. */
  kids?: number
  /** Genus not yet reached by the incremental Wikipedia/Wikidata
      enrichment (§44.5): wiki/img are null because nothing was looked up
      yet, not because nothing exists. */
  pending?: boolean
  /** Built at render time from a live ChecklistBank response. */
  live?: boolean
  children?: TaxonNode[]
}

export interface TaxonomyFile {
  source: string
  release: string
  rank_floor: string
  col_dataset_url: string
  extractShards?: number
  extractsRetrieved?: string
  imageNote?: string
  /** §44.5 build facts, for the page's own "how this works" copy. */
  generaFiles?: number
  generaTotal?: number
  generaEnriched?: number
  tree: TaxonNode
}

// ---------------------------------------------------------------------------
// The rank system (§44.1).
//
// One record per rank the page can meet: the principal ranks of the codes
// plus every intermediate and lower rank that Catalogue of Life's rank
// vocabulary (https://api.checklistbank.org/vocab/rank) can attach to a
// node. Each rank has its OWN colour (an oklch hue with a shade step so a
// tier reads as a family of colours), a tier for ordering, the codes that
// govern it, and a definition. Sources are listed in RANK_SOURCES and
// rendered in the legend.
// ---------------------------------------------------------------------------

export type RankTier =
  | 'root'
  | 'domain'
  | 'kingdom'
  | 'phylum'
  | 'class'
  | 'cohort'
  | 'order'
  | 'family'
  | 'genus'
  | 'species'

export type NomenclaturalCode = 'ICZN' | 'ICN' | 'ICNP' | 'ICTV' | 'ICNCP'

export interface RankInfo {
  /** Ordering within the ladder, top (0) to bottom. */
  order: number
  tier: RankTier
  /** oklch hue of the chip. Principal ranks are the tier's anchor hue;
      intermediate ranks shift the hue a little and step the shade. */
  hue: number
  /** −2 … +2: negative = darker/deeper (sub-, infra-, parv-), positive =
      lighter (super-, mega-, giga-). 0 = the principal rank. */
  shade: number
  principal?: boolean
  codes: NomenclaturalCode[]
  def: string
}

const TIER_HUE: Record<RankTier, number> = {
  root: 250,
  domain: 300,
  kingdom: 155,
  phylum: 200,
  class: 250,
  cohort: 100,
  order: 70,
  family: 35,
  genus: 320,
  species: 120,
}

const ALL_CELLULAR_AND_VIRAL: NomenclaturalCode[] = ['ICZN', 'ICN', 'ICNP', 'ICTV']

type RankSeed = [
  name: string,
  tier: RankTier,
  shade: number,
  codes: NomenclaturalCode[],
  def: string,
  principal?: boolean,
]

/** Ladder order = array order. */
const RANK_SEEDS: RankSeed[] = [
  ['root', 'root', 0, [], 'The root of the tree: all life, plus viruses as a contested guest.'],
  // ---- above kingdom ----------------------------------------------------
  ['superdomain', 'domain', 1, [], 'A grouping above domain, used in a few proposals that unite domains sharing a cell type; not a rank of any code.'],
  ['domain', 'domain', 0, ['ICNP'], 'A domain is the broadest rank of cellular life — Bacteria, Archaea and Eukarya — based on fundamental cell architecture (from Latin dominium, "ownership, realm"; proposed by Carl Woese in 1990). Not itself governed by the ICZN or ICN; the ICNP has validly published the two prokaryote domains (2024).', true],
  ['subdomain', 'domain', -1, [], 'A division immediately below domain, rarely used.'],
  ['infradomain', 'domain', -2, [], 'A division below subdomain, rarely used.'],
  ['empire', 'domain', 1, [], 'An old term for the very top of the hierarchy (Prokaryota / Eukaryota), equivalent to superkingdom; not a rank of any code.'],
  ['realm', 'domain', 0, ['ICTV'], 'A realm is the highest rank used for VIRUSES — which sit outside the tree of cellular life — grouping them by the deep ancestry of their replication machinery (ICTV Code Rule 3.22, adopted 2018; from Old French reaume, "kingdom"). Riboviria, the RNA viruses, is the largest.', true],
  ['subrealm', 'domain', -1, ['ICTV'], 'A division of a virus realm, immediately below realm (ICTV Code Rule 3.22).'],
  ['superkingdom', 'kingdom', 1, [], 'A superkingdom groups kingdoms; in Ruggiero et al. (2015), the classification Catalogue of Life follows, the two superkingdoms are Prokaryota and Eukaryota.'],
  ['kingdom', 'kingdom', 0, ALL_CELLULAR_AND_VIRAL, 'A kingdom is a major division within a domain, such as animals, plants or fungi — the oldest rank in use, from Linnaeus\'s regnum, "royal realm". A principal rank of the botanical code (ICN Art. 3.1) and a rank of the virus code (ICTV Rule 3.22).', true],
  ['subkingdom', 'kingdom', -1, ['ICN', 'ICTV'], 'A division immediately below kingdom (ICN Art. 4.2 subregnum; ICTV Rule 3.22).'],
  ['infrakingdom', 'kingdom', -2, [], 'A division below subkingdom, used in Ruggiero et al. (2015) and Cavalier-Smith\'s classifications.'],
  // ---- phylum tier ------------------------------------------------------
  ['superphylum', 'phylum', 1, [], 'A superphylum groups phyla; used for the animal clades Ecdysozoa and Lophotrochozoa in Ruggiero et al. (2015).'],
  ['phylum', 'phylum', 0, ALL_CELLULAR_AND_VIRAL, 'A phylum groups organisms sharing a basic body plan — chordates, arthropods, molluscs (from Greek phylon, "tribe, stock"; coined by Haeckel in 1866). Botany calls the same rank DIVISION (ICN Art. 3.1: "division or phylum"); the prokaryote code added phylum only in 2021 (Oren & Garrity 2021; ICNP 2022 revision, Rule 5b).', true],
  ['division botany', 'phylum', 0, ['ICN'], 'A division is the botanical name for the rank of phylum (ICN Art. 3.1, divisio); the two words are alternatives for one rank.'],
  ['subphylum', 'phylum', -1, ['ICN', 'ICTV'], 'A division immediately below phylum — Vertebrata within Chordata (ICN Art. 4.2 subdivisio or subphylum; ICTV Rule 3.22).'],
  ['subdivision', 'phylum', -1, ['ICN'], 'The botanical name for subphylum (ICN Art. 4.2 subdivisio).'],
  ['infraphylum', 'phylum', -2, [], 'A division below subphylum — Gnathostomata, the jawed vertebrates, is an infraphylum in Ruggiero et al. (2015).'],
  ['infradivision', 'phylum', -2, [], 'The botanical spelling of infraphylum.'],
  ['parvphylum', 'phylum', -2, [], 'A small division below infraphylum (from Latin parvus, "small"); used in the higher classification of fishes.'],
  ['microphylum', 'phylum', -2, [], 'A division below infraphylum (or parvphylum), used in a few vertebrate classifications.'],
  ['nanophylum', 'phylum', -2, [], 'A division below microphylum; the lowest of the phylum-tier prefixes.'],
  // ---- class tier -------------------------------------------------------
  ['gigaclass', 'class', 2, [], 'The largest grouping of the class tier, above megaclass; used for the deepest vertebrate splits (Actinopterygii vs. Sarcopterygii) in fish classification.'],
  ['megaclass', 'class', 2, [], 'A grouping above superclass; used in the classification of ray-finned fishes.'],
  ['superclass', 'class', 1, [], 'A superclass groups classes — Tetrapoda, the four-limbed vertebrates, is a superclass.'],
  ['class', 'class', 0, ALL_CELLULAR_AND_VIRAL, 'A class is a major division of a phylum, such as mammals or birds within the chordates (from Latin classis, a summoned division of the Roman people). A principal rank of the ICN (Art. 3.1 classis) and the ICNP (Rule 5b).', true],
  ['subclass', 'class', -1, ['ICN', 'ICNP', 'ICTV'], 'A division immediately below class — Theria within Mammalia (ICN Art. 4.2 subclassis; ICNP Rule 5b; ICTV Rule 3.22).'],
  ['infraclass', 'class', -2, [], 'A division below subclass — Placentalia within Theria.'],
  ['subterclass', 'class', -2, [], 'A division below infraclass (from Latin subter, "beneath"), used in fish classification.'],
  ['parvclass', 'class', -2, [], 'A small division below infraclass (or subterclass), used in fish classification.'],
  ['superdivision', 'class', 1, [], 'In zoology, a grouping above "division" used between class and cohort in some vertebrate classifications (distinct from the botanical division = phylum).'],
  ['division zoology', 'class', -1, [], 'In zoology, a division is an informal-feeling rank between class and cohort used in some fish and reptile classifications — NOT the botanical division, which equals phylum.'],
  ['claudius', 'class', -2, [], 'A rare rank slotted between class and legion in a few fossil-vertebrate classifications.'],
  // ---- legion / cohort tier --------------------------------------------
  ['superlegion', 'cohort', 1, [], 'A grouping above legion (McKenna & Bell 1997, mammal classification).'],
  ['legion', 'cohort', 0, [], 'A legion is a rank between class and cohort used mainly in McKenna & Bell\'s (1997) classification of mammals — e.g. Cladotheria; from Latin legio.', true],
  ['sublegion', 'cohort', -1, [], 'A division immediately below legion (McKenna & Bell 1997).'],
  ['infralegion', 'cohort', -2, [], 'A division below sublegion (McKenna & Bell 1997).'],
  ['megacohort', 'cohort', 2, [], 'A grouping above supercohort, used in a few vertebrate classifications.'],
  ['supercohort', 'cohort', 1, [], 'A grouping of cohorts (McKenna & Bell 1997).'],
  ['cohort', 'cohort', 0, [], 'A cohort is a rank between class (or legion) and order used in mammal classification — Placentalia is a cohort in McKenna & Bell (1997); from Latin cohors, a Roman military unit.', true],
  ['subcohort', 'cohort', -1, [], 'A division immediately below cohort.'],
  ['infracohort', 'cohort', -2, [], 'A division below subcohort.'],
  // ---- order tier -------------------------------------------------------
  ['gigaorder', 'order', 2, [], 'The largest grouping of the order tier, above magnorder.'],
  ['magnorder', 'order', 2, [], 'A grouping above superorder (from Latin magnus, "great"); Boreoeutheria is a magnorder in some mammal classifications.'],
  ['superorder', 'order', 1, [], 'A superorder groups orders — Laurasiatheria among placental mammals.'],
  ['grandorder', 'order', 1, [], 'A grouping between superorder and mirorder introduced by McKenna & Bell (1997) for mammals.'],
  ['mirorder', 'order', 1, [], 'A grouping between grandorder and order (McKenna & Bell 1997; from Latin mirus, "wonderful").'],
  ['order', 'order', 0, ALL_CELLULAR_AND_VIRAL, 'An order groups related families — primates, beetles, roses (from Latin ordo, "row, rank"). A principal rank of every code (ICN Art. 3.1 ordo; ICNP Rule 5b; ICTV Rule 3.22).', true],
  ['nanorder', 'order', -2, [], 'A minor division below parvorder (from Greek nanos, "dwarf").'],
  ['hypoorder', 'order', -2, [], 'A division below order used in a few insect classifications (from Greek hypo, "under").'],
  ['minorder', 'order', -2, [], 'A minor division of an order, below hypoorder.'],
  ['suborder', 'order', -1, ['ICN', 'ICNP', 'ICTV'], 'A division immediately below order — Serpentes (snakes) within Squamata (ICN Art. 4.2 subordo; ICNP Rule 5b; ICTV Rule 3.22).'],
  ['infraorder', 'order', -2, [], 'A division below suborder — Simiiformes, the monkeys and apes, within Haplorhini.'],
  ['parvorder', 'order', -2, [], 'A small division below infraorder (from Latin parvus) — Catarrhini, the Old World monkeys and apes.'],
  ['supersection zoology', 'order', -2, [], 'In zoology, a grouping of "sections" used between infraorder and superfamily in some insect classifications (e.g. Coleoptera).'],
  ['section zoology', 'order', -2, ['ICZN'], 'In zoology, a section is a governed rank that appears in two places: between infraorder and superfamily in some insect classifications, and — as a division of a genus — between subgenus and species, where the ICZN treats its names as subgeneric (Art. 10.4). From Latin sectio, "a cutting".'],
  ['subsection zoology', 'order', -2, ['ICZN'], 'A division of a zoological section (ICZN Art. 10.4 treats infra-generic uses as subgeneric names).'],
  ['superseries zoology', 'order', -2, [], 'In zoology, a grouping of "series" within a section, used in some insect classifications.'],
  ['series zoology', 'order', -2, ['ICZN'], 'In zoology, a series is a division below section (or subsection), used both between infraorder and superfamily in insects and within very large genera (ICZN Art. 10.4).'],
  ['subseries zoology', 'order', -2, ['ICZN'], 'A division of a zoological series.'],
  ['falanx', 'order', -2, [], 'A rare rank (phalanx) used below parvorder in a few arthropod classifications.'],
  // ---- family tier ------------------------------------------------------
  ['gigafamily', 'family', 2, [], 'The largest grouping of the family tier, above megafamily; very rarely used.'],
  ['megafamily', 'family', 2, [], 'A grouping above grandfamily, very rarely used.'],
  ['grandfamily', 'family', 2, [], 'A grouping above superfamily, very rarely used.'],
  ['superfamily', 'family', 1, ['ICZN'], 'A superfamily groups families — Hominoidea, the apes (ICZN Art. 35.1; zoological names end in -oidea).'],
  ['epifamily', 'family', 1, [], 'A grouping between superfamily and family (from Greek epi, "upon"), used in a few insect and mollusc classifications; zoological names end in -oidae.'],
  ['family', 'family', 0, ALL_CELLULAR_AND_VIRAL, 'A family groups closely related genera that usually share an evident likeness — cats, grasses, orchids (from Latin familia, "household"). Family names end in -idae for animals (ICZN Art. 29), -aceae for plants, fungi and prokaryotes (ICN Art. 18; ICNP), -viridae for viruses. A principal rank of every code.', true],
  ['subfamily', 'family', -1, ['ICZN', 'ICN', 'ICNP', 'ICTV'], 'A division immediately below family — Pantherinae, the big cats, within Felidae (ICZN Art. 35.1, names in -inae; ICN Art. 4.2 subfamilia, -oideae; ICNP Rule 5b; ICTV Rule 3.22).'],
  ['infrafamily', 'family', -2, [], 'A division below subfamily, rarely used (ICZN Art. 35.1 permits any rank between superfamily and genus).'],
  ['supertribe', 'family', -1, [], 'A grouping of tribes within a subfamily (ICZN Art. 35.1 permits it; names in -itae).'],
  ['tribe', 'family', -1, ['ICZN', 'ICN', 'ICNP'], 'A tribe is a rank between subfamily and genus, used where a large family needs finer structure — Hominini for humans and chimpanzees (ICZN Art. 35.1, names in -ini; ICN Art. 4.1 tribus, -eae; ICNP Rule 5b). From Latin tribus, a division of the Roman people.'],
  ['subtribe', 'family', -2, ['ICZN', 'ICN', 'ICNP'], 'A division of a tribe (ICZN Art. 35.1, names in -ina; ICN Art. 4.2 subtribus, -inae; ICNP Rule 5b).'],
  ['infratribe', 'family', -2, [], 'A division below subtribe, rarely used.'],
  ['suprageneric name', 'family', -2, [], 'A name above genus whose exact rank the source did not state.'],
  // ---- genus tier -------------------------------------------------------
  ['supergenus', 'genus', 1, [], 'A grouping of genera below tribe, occasionally used in botany and entomology; not a rank of any code.'],
  ['genus', 'genus', 0, ALL_CELLULAR_AND_VIRAL, 'A genus is a group of closely related species and the first half of every scientific name (from Latin genus, "birth, kind"; Panthera in Panthera leo). A principal rank of every code (ICZN Art. 42; ICN Art. 3.1; ICNP Rule 5b; ICTV Rule 3.22).', true],
  ['subgenus', 'genus', -1, ['ICZN', 'ICN', 'ICTV'], 'A subgenus divides a large genus; it is written in parentheses between genus and species — Apis (Apis) mellifera (ICZN Art. 42 genus group; ICN Art. 4.2; ICTV Rule 3.22).'],
  ['infragenus', 'genus', -2, [], 'A division below subgenus whose exact rank the source did not state.'],
  ['supersection botany', 'genus', -1, [], 'In botany, a grouping of sections within a subgenus.'],
  ['section botany', 'genus', -2, ['ICN'], 'In botany, a section is a secondary rank between subgenus and species (ICN Art. 4.1 sectio) — Quercus sect. Lobatae, the red oaks.'],
  ['subsection botany', 'genus', -2, ['ICN'], 'A division of a botanical section (ICN Art. 4.2 subsectio).'],
  ['superseries botany', 'genus', -2, [], 'In botany, a grouping of series within a section.'],
  ['series botany', 'genus', -2, ['ICN'], 'In botany, a series is a secondary rank between section and species (ICN Art. 4.1 series).'],
  ['subseries botany', 'genus', -2, ['ICN'], 'A division of a botanical series (ICN Art. 4.2 subseries).'],
  ['infrageneric name', 'genus', -2, [], 'A name between genus and species whose exact rank the source did not state.'],
  ['species aggregate', 'genus', -2, [], 'A species aggregate (species group or species complex) is an informal bundle of very similar species treated together — Rubus fruticosus agg. The codes give it no formal rank (ICZN Art. 6.2 allows interpolated names for such aggregates).'],
  // ---- species tier -----------------------------------------------------
  ['species', 'species', 0, ALL_CELLULAR_AND_VIRAL, 'A species is the basic unit of classification — in sexual organisms, roughly a population that interbreeds (from Latin species, "appearance, kind"). Its two-part name is unique. A principal rank of every code (ICZN Art. 45; ICN Art. 3.1; ICNP Rule 5b; ICTV Rule 3.22).', true],
  ['infraspecific name', 'species', -1, [], 'A name below species whose exact rank the source did not state.'],
  ['grex', 'species', -1, ['ICNCP'], 'In orchid horticulture, a grex is the set of all offspring of one cross (ICNCP); from Latin grex, "flock".'],
  ['klepton', 'species', -1, [], 'A klepton is a hybrid lineage that needs another species to reproduce (some water frogs); an informal taxonomic category, not a code rank.'],
  ['subspecies', 'species', -1, ['ICZN', 'ICN', 'ICNP', 'ICTV'], 'A subspecies is a geographically or morphologically distinct population within a species, named with a third word added to the binomial (ICZN Art. 45 species group; ICN Art. 4.2 subspecies; ICNP Rule 5b).'],
  ['cultivar group', 'species', -2, ['ICNCP'], 'A cultivar group assembles cultivars with shared characters — Brassica oleracea Capitata Group, the cabbages (ICNCP).'],
  ['convariety', 'species', -2, ['ICNCP'], 'An older term for a cultivar group (ICNCP).'],
  ['infrasubspecific name', 'species', -2, [], 'A name below subspecies whose exact rank the source did not state.'],
  ['proles', 'species', -2, [], 'A proles is an obsolete botanical rank below subspecies (from Latin proles, "offspring").'],
  ['natio', 'species', -2, [], 'A natio is an obsolete rank for a local race below subspecies, mostly in older entomology and botany.'],
  ['aberration', 'species', -2, [], 'An aberration is an individual colour or pattern variant, mostly in older entomology; names at this rank are not regulated by the ICZN (Art. 45.6).'],
  ['morph', 'species', -2, [], 'A morph is a discrete variant form within a population; informal, not a code rank.'],
  ['supervariety', 'species', -2, [], 'A grouping of varieties, very rarely used.'],
  ['variety', 'species', -2, ['ICN'], 'A variety (varietas) is a botanical rank below subspecies for a recognisable variant within a species (ICN Art. 4.1) — Brassica oleracea var. italica, broccoli. In zoology "variety" has no standing since 1961 (ICZN Art. 45.6).'],
  ['subvariety', 'species', -2, ['ICN'], 'A division of a variety (ICN Art. 4.2 subvarietas).'],
  ['superform', 'species', -2, [], 'A grouping of forms, very rarely used.'],
  ['form', 'species', -2, ['ICN'], 'A form (forma) is the lowest botanical rank, for minor variants such as flower colour (ICN Art. 4.1).'],
  ['subform', 'species', -2, ['ICN'], 'A division of a form (ICN Art. 4.2 subforma), the lowest rank the botanical code provides for.'],
  ['pathovar', 'species', -2, ['ICNP'], 'A pathovar is a strain or set of strains of a bacterium distinguished by the plant hosts it infects (infrasubspecific, outside ICNP rules proper — Appendix 10).'],
  ['biovar', 'species', -2, ['ICNP'], 'A biovar is a bacterial variant distinguished by biochemical or physiological properties (infrasubspecific).'],
  ['chemovar', 'species', -2, [], 'A chemovar is a variant distinguished by its chemical profile (mostly in plants).'],
  ['morphovar', 'species', -2, ['ICNP'], 'A morphovar is a bacterial variant distinguished by morphology (infrasubspecific).'],
  ['phagovar', 'species', -2, ['ICNP'], 'A phagovar is a bacterial variant distinguished by its reaction to bacteriophages (infrasubspecific).'],
  ['serovar', 'species', -2, ['ICNP'], 'A serovar is a bacterial variant distinguished by its antigens — Salmonella enterica serovar Typhi (infrasubspecific).'],
  ['chemoform', 'species', -2, [], 'A chemoform is a chemically distinguished form, mostly in lichens.'],
  ['forma specialis', 'species', -2, [], 'A forma specialis (f. sp.) is a parasite variant defined by its host, used for fungi and other pathogens; the ICN (Art. 4 Note 4) leaves it unregulated.'],
  ['lusus', 'species', -2, [], 'A lusus is an obsolete rank for a sport or freak variant (from Latin lusus, "a game").'],
  ['cultivar', 'species', -2, ['ICNCP'], 'A cultivar is a cultivated plant variant selected and named by people — Malus domestica \'Granny Smith\' — governed by the separate International Code of Nomenclature for Cultivated Plants (ICNCP), not the ICN.'],
  ['mutatio', 'species', -2, [], 'A mutatio is an obsolete rank for a mutant variant.'],
  ['strain', 'species', -2, [], 'A strain is a genetic variant or culture of a microorganism (or virus); strains sit below the species and have no formal rank in the codes.'],
  ['other', 'root', 0, [], 'A rank the source recorded that maps onto none of the standard ranks.'],
  ['unranked', 'root', 0, [], 'An unranked node is a clade — a genuine branch of the tree of life — that the Linnaean rank ladder has no free rung for; modern classifications keep it rather than force a rank onto it.'],
]

export const RANKS: Record<string, RankInfo> = Object.fromEntries(
  RANK_SEEDS.map(([name, tier, shade, codes, def, principal], order) => [
    name,
    {
      order,
      tier,
      hue: TIER_HUE[tier] + shade * 9,
      shade,
      codes,
      def,
      ...(principal ? { principal: true } : {}),
    } satisfies RankInfo,
  ]),
)

/** The principal ranks, in ladder order — the persistent legend. */
export const PRINCIPAL_RANKS = RANK_SEEDS.filter((seed) => seed[5]).map(
  (seed) => seed[0],
)

/** Tier labels for the grouped rank legend. */
export const RANK_TIER_LABELS: Record<RankTier, string> = {
  root: 'Root and unranked',
  domain: 'Domain and realm',
  kingdom: 'Kingdom',
  phylum: 'Phylum (division)',
  class: 'Class',
  cohort: 'Legion and cohort',
  order: 'Order',
  family: 'Family',
  genus: 'Genus',
  species: 'Species and below',
}

export const RANK_TIERS: RankTier[] = [
  'domain',
  'kingdom',
  'phylum',
  'class',
  'cohort',
  'order',
  'family',
  'genus',
  'species',
  'root',
]

/** Where the rank system comes from (§44.1) — rendered under the legend. */
export const RANK_SOURCES: { label: string; url: string }[] = [
  {
    label: 'ICZN, International Code of Zoological Nomenclature (4th ed.), Art. 35 (family group), 42 (genus group), 45 (species group), 10.4 (divisions of genera)',
    url: 'https://code.iczn.org/family-group-nominal-taxa-and-their-names/article-35-the-family-group/',
  },
  {
    label: 'ICN, International Code of Nomenclature for algae, fungi, and plants (Shenzhen Code), Art. 3 (principal ranks) and Art. 4 (secondary and sub- ranks)',
    url: 'https://www.iapt-taxon.org/nomen/pages/main/art_3.html',
  },
  {
    label: 'ICNP, International Code of Nomenclature of Prokaryotes (2022 revision), Rule 5; phylum added by Oren & Garrity 2021 (IJSEM 71:005056)',
    url: 'https://doi.org/10.1099/ijsem.0.005585',
  },
  {
    label: 'ICTV, International Code of Virus Classification and Nomenclature, Rule 3.22 (fifteen ranks, realm to species)',
    url: 'https://ictv.global/about/code',
  },
  {
    label: 'Ruggiero et al. 2015, A Higher Level Classification of All Living Organisms (PLOS ONE) — the superkingdom-to-order backbone Catalogue of Life follows',
    url: 'https://doi.org/10.1371/journal.pone.0119248',
  },
  {
    label: 'McKenna & Bell 1997, Classification of Mammals Above the Species Level (Columbia University Press) — legion, cohort, grandorder, mirorder, parvorder',
    url: 'https://cup.columbia.edu/book/classification-of-mammals/9780231110136/',
  },
  {
    label: 'ICNCP, International Code of Nomenclature for Cultivated Plants (9th ed.) — cultivar, cultivar group, grex',
    url: 'https://www.ishs.org/scripta-horticulturae/international-code-nomenclature-cultivated-plants-ninth-edition',
  },
  {
    label: 'ChecklistBank rank vocabulary — every rank string Catalogue of Life can attach to a node',
    url: 'https://api.checklistbank.org/vocab/rank',
  },
]

/** A prose note on how the codes differ (rendered with the legend). */
export const RANK_CODE_NOTE =
  'The four codes agree on the principal ranks but not on the words: ' +
  'botany (ICN) says "division" where zoology says "phylum" (ICN Art. 3.1 ' +
  'accepts both); the prokaryote code (ICNP) governed only class to ' +
  'subspecies until phylum was added in 2021, and treats domain names ' +
  'separately; the virus code (ICTV) has its own fifteen-rung ladder from ' +
  'realm to species and no infraspecific ranks; and only botany regulates ' +
  'variety and form (the ICZN dropped "variety" for names published after ' +
  '1960, Art. 45.6). Cultivars follow yet another code (ICNCP). Ranks ' +
  'without a code — legion, cohort, parvorder, gigaclass — come from ' +
  'individual classifications (McKenna & Bell 1997; Ruggiero et al. 2015) ' +
  'that Catalogue of Life carries as its sources use them.'

/** Fallback for rank strings the table has never met (a new COL vocabulary
    entry): the prefix glossary composes a definition from the base rank. */
const RANK_PREFIXES: [RegExp, string][] = [
  [/^subter/, 'below infra{base}'],
  [/^sub/, 'immediately below {base}'],
  [/^super/, 'immediately above {base}'],
  [/^infra/, 'below sub{base}'],
  [/^parv/, 'below infra{base}, as a small division'],
  [/^nan[o]?/, 'below parv{base}, as a minor division'],
  [/^mega/, 'above super{base}, as a large grouping'],
  [/^giga/, 'above mega{base}, as the largest grouping of the {base} tier'],
  [/^grand/, 'in the upper levels of the {base} tier'],
  [/^mir/, 'in the upper levels of the {base} tier'],
  [/^epi/, 'just above {base}'],
  [/^hypo/, 'just below {base}'],
  [/^magn/, 'above super{base}'],
]

const PREFIXES = [
  'sub', 'ter', 'super', 'infra', 'parv', 'mega', 'giga', 'grand', 'mir',
  'nano', 'nan', 'hypo', 'epi', 'magn', 'min', 'micro', 'supra',
]

/** The principal rank a rank string belongs to ('root' when unknown).
    Unknown strings shed stacked prefixes one at a time, trying every
    alternative ("nanorder" is nan+order, "nanophylum" is nano+phylum). */
export function baseRank(rank: string): string {
  const lower = rank.toLowerCase().replace(/ (zoology|botany)$/, '')
  const info = RANKS[lower]
  if (info) return info.tier
  for (const prefix of PREFIXES) {
    if (lower.startsWith(prefix) && lower.length > prefix.length) {
      const base = baseRank(lower.slice(prefix.length))
      if (base !== 'root') return base
    }
  }
  return 'root'
}

export function rankInfo(rank: string): RankInfo {
  const lower = rank.toLowerCase()
  const exact = RANKS[lower]
  if (exact) return exact
  const base = baseRank(lower)
  const baseInfo = RANKS[base] ?? RANKS.root!
  const prefix = RANK_PREFIXES.find(([re]) => re.test(lower))
  const shade = prefix
    ? /^(super|mega|giga|grand|mir|epi|magn|supra)/.test(lower)
      ? 1
      : -1
    : 0
  return {
    ...baseInfo,
    hue: baseInfo.hue + shade * 9,
    shade,
    principal: false,
    codes: [],
    def:
      prefix && base !== 'root'
        ? `A ${lower} is an intermediate rank ${prefix[1].replaceAll('{base}', base)}, ` +
          `used where a group's diversity needs finer structure than the main ` +
          `ranks provide. ${baseInfo.def}`
        : baseInfo.def,
  }
}

/** The chip colour for a rank: a tinted ground under the ordinary text
    token, so hue never carries contrast. Shade steps the lightness so a
    tier reads as a family (super- lighter, sub-/infra- deeper). */
export const rankChipStyle = (rank: string): React.CSSProperties => {
  const { hue, shade } = rankInfo(rank)
  const light = 92 - shade * 3
  const dark = 32 + shade * 3
  const chroma = (0.05 + Math.abs(shade) * 0.015).toFixed(3)
  return {
    background: `light-dark(oklch(${light}% ${chroma} ${hue}), oklch(${dark}% ${chroma} ${hue}))`,
    borderColor: `light-dark(oklch(${light - 22}% 0.09 ${hue}), oklch(${dark + 23}% 0.09 ${hue}))`,
  }
}

/** The stronger accent for a rank (panel header rule, sheet handle). */
export const rankAccent = (rank: string): string => {
  const { hue } = rankInfo(rank)
  return `light-dark(oklch(70% 0.09 ${hue}), oklch(55% 0.09 ${hue}))`
}

/** A definition for ANY rank string in the data (§42.6): exact entries
    first, then a composed sentence for unseen prefix-derived ranks. */
export function rankDefinition(rank: string): string {
  return rankInfo(rank).def
}

/** Ladder position for sorting rank strings (unknown ranks sort with their
    base rank). */
export function rankOrder(rank: string): number {
  const lower = rank.toLowerCase()
  const exact = RANKS[lower]
  if (exact) return exact.order
  return (RANKS[baseRank(lower)] ?? RANKS.root!).order + 0.5
}

/** Ranks whose names are conventionally italicised. */
export const ITALIC_RANKS = new Set([
  'genus',
  'subgenus',
  'section botany',
  'subsection botany',
  'series botany',
  'species',
  'species aggregate',
  'subspecies',
  'variety',
  'subvariety',
  'form',
  'subform',
  'infraspecific name',
])

// ---------------------------------------------------------------------------
// Generated descriptions (§44.3). The ETL composes the same sentence for
// tree nodes and ships it in the extract shards; genera files and live
// nodes carry the FACTS and this composes the sentence at render time, so
// ~200k near-identical strings need not sit in the repository. Both are
// labelled "Generated from Catalogue of Life facts" wherever shown.
// ---------------------------------------------------------------------------

const plainNumber = new Intl.NumberFormat('en')

function plural(count: number, one: string, many: string): string {
  return `${plainNumber.format(count)} ${count === 1 ? one : many}`
}

export function generatedSummary(
  node: TaxonNode,
  parent: TaxonNode | undefined,
): string {
  const rank = node.rank === 'unranked' ? 'clade' : node.rank
  const article = /^[aeiou]/i.test(rank) ? 'an' : 'a'
  let text = `${node.name} is ${article} ${rank}`
  if (parent && parent.rank !== 'root') {
    text += ` in the ${parent.rank === 'unranked' ? 'clade' : parent.rank} ${parent.name}`
  }
  if (node.auth) text += `, described by ${node.auth}`
  text += '.'
  const facts: string[] = []
  const childCount = node.children?.length ?? node.kids ?? 0
  if (node.spp !== undefined && node.spp > 0 && node.rank !== 'species') {
    facts.push(`Catalogue of Life records ${plural(node.spp, 'species', 'species')} beneath it`)
  } else if (node.names > 0) {
    facts.push(`Catalogue of Life records ${plural(node.names, 'taxon', 'taxa')} beneath it`)
  } else if (childCount > 0) {
    facts.push(`Catalogue of Life records ${plural(childCount, 'direct subdivision', 'direct subdivisions')}`)
  }
  if (node.gen !== undefined && node.gen > 0) {
    facts.push(`in ${plural(node.gen, 'genus', 'genera')}`)
  }
  if (facts.length > 0) text += ` ${facts.join(' ')}.`
  const notable = (node.children ?? [])
    .filter((child) => child.wiki || child.common)
    .slice(0, 3)
    .map((child) => (child.common ? `${child.name} (${child.common})` : child.name))
  if (notable.length > 0) text += ` Members include ${notable.join(', ')}.`
  if (node.firstMa !== undefined) {
    text += ` Its first appearance in the fossil record is put at about ${node.firstMa} million years ago (Wikidata).`
  }
  if (node.extinct) text += ' Catalogue of Life marks it extinct.'
  return text
}

/** Human label for a description source (rendered after every text). */
export const DESC_SOURCE_LABEL: Record<DescSource, string> = {
  wikipedia: 'Wikipedia',
  wikidata: 'Wikidata description',
  col: 'Catalogue of Life remark',
  generated: 'Generated from Catalogue of Life facts',
}

// ---- Extract shards (round-2 §39): intro texts fetched on selection ----

const extractCache = new Map<number, Promise<Record<string, string>>>()

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(text),
  )
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function loadExtract(
  id: string,
  shardCount: number,
): Promise<string | null> {
  const shard =
    parseInt((await sha1Hex(id)).slice(0, 2), 16) % Math.max(shardCount, 1)
  let pending = extractCache.get(shard)
  if (!pending) {
    pending = fetch(
      `${DATA_BASE_URL}/biology/taxonomy/extracts/${String(shard).padStart(2, '0')}.json`,
    ).then((response) => {
      if (!response.ok) {
        extractCache.delete(shard)
        throw new Error(`extract shard ${shard}: HTTP ${response.status}`)
      }
      return response.json()
    })
    extractCache.set(shard, pending)
  }
  const map = await pending
  return map[id] ?? null
}

export const oneZoomUrl = (name: string) =>
  `https://www.onezoom.org/life/@${encodeURIComponent(name.replace(/ /g, '_'))}`

export const lifemapUrl = (ncbi: string) =>
  `https://lifemap.cnrs.fr/?tid=${encodeURIComponent(ncbi)}`

export const wikipediaSearchUrl = (name: string) =>
  `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(name)}`

const cache = new Map<string, Promise<unknown>>()

function load<T>(path: string): Promise<T> {
  let pending = cache.get(path)
  if (!pending) {
    pending = fetch(`${DATA_BASE_URL}/${path}`).then((response) => {
      if (!response.ok) {
        cache.delete(path)
        throw new Error(`${path}: HTTP ${response.status}`)
      }
      return response.json()
    })
    cache.set(path, pending)
  }
  return pending as Promise<T>
}

export function useTaxonomyTree(): AsyncState<TaxonomyFile> {
  const [state, setState] = useState<AsyncState<TaxonomyFile>>({
    status: 'loading',
  })
  useEffect(() => {
    let cancelled = false
    load<TaxonomyFile>('biology/taxonomy/tree.json')
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

/** A genera-file node flagged `pending` ships the flag ALONE (§44.5,
    ~220k nodes): expand it into the explicit triple the rest of the page
    relies on — wiki null, img null, description generated from facts. */
function expandPending(node: TaxonNode): TaxonNode {
  if (node.pending) {
    node.wiki = null
    node.img = null
    node.descSrc = 'generated'
  }
  for (const child of node.children ?? []) expandPending(child)
  return node
}

const generaCache = new Map<string, Promise<TaxonNode>>()

/** The static genera file of a family (§44.5): the family node with its
    subfamilies/tribes/genera nested as COL records them. Module-level
    cache — a family is fetched once per page lifetime. */
export function loadGenera(familyId: string): Promise<TaxonNode> {
  let pending = generaCache.get(familyId)
  if (!pending) {
    pending = load<TaxonNode>(
      `biology/taxonomy/genera/${encodeURIComponent(familyId)}.json`,
    ).then(expandPending)
    generaCache.set(familyId, pending)
    pending.catch(() => generaCache.delete(familyId))
  }
  return pending
}

export const colTaxonUrl = (datasetUrl: string, id: string) =>
  `${datasetUrl}/taxon/${encodeURIComponent(id)}`

export const wikipediaUrl = (title: string) =>
  `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

// ---------------------------------------------------------------------------
// LIVE ChecklistBank calls (§44.5) — the documented render-time exception.
// Only two endpoints, both keyless and CORS-enabled, both CC BY 4.0:
//   children of a taxon  (species under a genus, subspecies under a species)
//   name search          (species by name when the local index has no hit)
// Nothing else on the page is fetched at render time.
// ---------------------------------------------------------------------------

export const CHECKLISTBANK_API = 'https://api.checklistbank.org'
export const COL_DATASET = '3LR'
/** Children pages are capped; a node with more carries `truncated`. */
export const LIVE_CHILDREN_LIMIT = 500

interface LiveChildRow {
  id: string
  name: string
  rank?: string
  authorship?: string
  status?: string
  count?: number
  childCount?: number
}

const liveChildrenCache = new Map<string, Promise<TaxonNode[]>>()

function liveNode(row: LiveChildRow): TaxonNode {
  const node: TaxonNode = {
    id: row.id,
    name: row.name,
    rank: row.rank ?? 'unranked',
    names: row.count ?? 0,
    wiki: null,
    img: null,
    descSrc: 'generated',
    live: true,
  }
  if (row.authorship) node.auth = row.authorship
  if (row.status === 'provisionally accepted') node.provisional = true
  if (row.childCount !== undefined && row.childCount > 0) node.kids = row.childCount
  return node
}

/** Accepted children of a taxon, live from ChecklistBank; sorted by name.
    A truncated page sets `truncated` on the returned array's marker. */
export function loadLiveChildren(
  id: string,
): Promise<TaxonNode[]> {
  let pending = liveChildrenCache.get(id)
  if (!pending) {
    pending = fetch(
      `${CHECKLISTBANK_API}/dataset/${COL_DATASET}/tree/${encodeURIComponent(id)}/children?limit=${LIVE_CHILDREN_LIMIT}`,
    )
      .then((response) => {
        if (!response.ok) {
          throw new Error(`ChecklistBank children ${id}: HTTP ${response.status}`)
        }
        return response.json() as Promise<{ result?: LiveChildRow[]; total?: number }>
      })
      .then((page) => {
        const rows = (page.result ?? []).filter(
          (row) => row.status === 'accepted' || row.status === 'provisionally accepted',
        )
        const nodes = rows.map(liveNode)
        nodes.sort((a, b) => a.name.localeCompare(b.name))
        if ((page.total ?? 0) > LIVE_CHILDREN_LIMIT && nodes.length > 0) {
          // Flag the LAST node so the caller can show "list capped".
          const last = nodes[nodes.length - 1]
          if (last) last.truncated = true
        }
        return nodes
      })
    liveChildrenCache.set(id, pending)
    pending.catch(() => liveChildrenCache.delete(id))
  }
  return pending
}

export interface LiveSearchHit {
  id: string
  name: string
  rank: string
  auth?: string
  common?: string
  /** Ancestor chain as ChecklistBank returns it: root-most first, ending
      with the hit itself. */
  classification: { id: string; name: string; rank: string }[]
}

interface SearchUsage {
  id: string
  name?: { scientificName?: string; rank?: string; authorship?: string }
  status?: string
}

interface SearchResult {
  usage?: SearchUsage
  classification?: { id: string; name: string; rank: string }[]
  vernacularNames?: { name?: string; language?: string }[]
}

/** Live name search (scientific + English vernacular, prefix match) for
    taxa the static index does not hold — species and below. */
export async function liveNameSearch(
  query: string,
  signal: AbortSignal,
): Promise<LiveSearchHit[]> {
  const url =
    `${CHECKLISTBANK_API}/dataset/${COL_DATASET}/nameusage/search` +
    `?q=${encodeURIComponent(query)}&content=SCIENTIFIC_NAME` +
    `&content=VERNACULAR_NAME&type=PREFIX&status=accepted` +
    `&status=provisionally%20accepted&limit=25`
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`ChecklistBank search: HTTP ${response.status}`)
  const page = (await response.json()) as { result?: SearchResult[] }
  const hits: LiveSearchHit[] = []
  for (const row of page.result ?? []) {
    const usage = row.usage
    if (!usage?.id || !usage.name?.scientificName) continue
    const english = (row.vernacularNames ?? []).find(
      (v) => v.language === 'eng' && v.name,
    )
    const hit: LiveSearchHit = {
      id: usage.id,
      name: usage.name.scientificName,
      rank: usage.name.rank ?? 'unranked',
      classification: [...(row.classification ?? [])],
    }
    if (usage.name.authorship) hit.auth = usage.name.authorship
    if (english?.name) hit.common = english.name
    hits.push(hit)
  }
  return hits
}
