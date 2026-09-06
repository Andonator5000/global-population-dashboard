/**
 * Loaders and types for the Taxonomy page (Phase 5, DATA_DECISIONS.md §31).
 *
 * The tree artifact holds Life down to family rank in one document -- the
 * page renders it lazily, so the DOM only ever carries expanded branches.
 * Focus families (genus/species depth) live in per-family artifacts
 * fetched on expand.
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

export interface TaxonNode {
  id: string
  name: string
  rank: string
  /** Descendant names recorded beneath this taxon in Catalogue of Life. */
  names: number
  auth?: string
  /** English Wikipedia title, or null meaning "checked, none recorded". */
  wiki: string | null
  common?: string
  desc?: string
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
  /** Children were capped at fetch time; the list is knowingly incomplete. */
  truncated?: boolean
  /** A focus family: genus/species depth exists in focus/{id}.json. */
  focus?: boolean
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
  tree: TaxonNode
}

/**
 * Rank colour system (round-2 §39): one hue per canonical rank, used for
 * chips, the panel header and the legend. Chips are TINTED backgrounds
 * with the ordinary text token on top (light-dark aware), so text
 * contrast never depends on the hue; the hue is identity, not meaning.
 * Intermediate ranks (subphylum, infraorder, …) inherit their base rank.
 */
export const RANK_HUES: Record<string, number> = {
  root: 250,
  realm: 0,
  domain: 300,
  kingdom: 155,
  phylum: 200,
  class: 250,
  order: 70,
  family: 35,
  tribe: 15,
  genus: 320,
  species: 120,
}

/** COL rank names that are neither canonical nor prefix-derived map onto
    the nearest canonical hue/definition family. */
const RANK_ALIASES: Record<string, string> = {
  'section zoology': 'genus',
  'subsection zoology': 'genus',
  'series zoology': 'genus',
  'section botany': 'genus',
  'series botany': 'genus',
  unranked: 'root',
}

export function baseRank(rank: string): string {
  const lower = rank.toLowerCase()
  const alias = RANK_ALIASES[lower]
  if (alias) return alias
  // "ter" only ever occurs after "sub" (subterclass); the + lets stacked
  // prefixes strip in sequence.
  const stripped = lower.replace(
    /^(sub|ter|super|infra|parv|mega|giga|grand|mir|nan|hypo|epi)+/,
    '',
  )
  return stripped in RANK_HUES ? stripped : 'root'
}

export const rankChipStyle = (rank: string): React.CSSProperties => {
  const hue = RANK_HUES[baseRank(rank)] ?? 250
  return {
    background: `light-dark(oklch(92% 0.05 ${hue}), oklch(32% 0.05 ${hue}))`,
    borderColor: `light-dark(oklch(70% 0.09 ${hue}), oklch(55% 0.09 ${hue}))`,
  }
}

/** Plain-language rank definitions with the name's origin (round-2 §39). */
export const RANK_DEFINITIONS: Record<string, string> = {
  root: 'The root of the tree: all life, plus viruses as a contested guest.',
  domain:
    'A domain is the broadest rank of life — Bacteria, Archaea and ' +
    'Eukarya — based on fundamental cell architecture (from Latin ' +
    'dominium, “ownership, realm”; proposed by Carl Woese in 1990).',
  kingdom:
    'A kingdom is a major division within a domain, such as animals, ' +
    'plants or fungi — the oldest rank in use, from Linnaeus’s regnum, ' +
    '“royal realm”.',
  phylum:
    'A phylum groups organisms sharing a basic body plan — chordates, ' +
    'arthropods, molluscs (from Greek phylon, “tribe, stock”; coined by ' +
    'Haeckel in 1866).',
  class:
    'A class is a major division of a phylum, such as mammals or birds ' +
    'within the chordates (from Latin classis, a summoned division of ' +
    'the Roman people).',
  order:
    'An order groups related families — primates, beetles, roses (from ' +
    'Latin ordo, “row, rank”).',
  family:
    'A family groups closely related genera that usually share an ' +
    'evident likeness — cats, grasses, orchids (from Latin familia, ' +
    '“household”). Family names end in -idae for animals, -aceae for ' +
    'plants and fungi.',
  genus:
    'A genus is a group of closely related species and the first half ' +
    'of every scientific name (from Latin genus, “birth, kind”; Panthera ' +
    'in Panthera leo).',
  species:
    'A species is the basic unit of classification — in sexual ' +
    'organisms, roughly a population that interbreeds (from Latin ' +
    'species, “appearance, kind”). Its two-part name is unique.',
  realm:
    'A realm is the highest rank used for VIRUSES — which sit outside ' +
    'the tree of cellular life — grouping them by the deep ancestry of ' +
    'their replication machinery (adopted by the ICTV in 2018; from Old ' +
    'French reaume, “kingdom”). Riboviria, the RNA viruses, is the ' +
    'largest.',
  tribe:
    'A tribe is a rank between subfamily and genus, used where a large ' +
    'family needs finer structure — Hominini for humans and chimpanzees ' +
    '(from Latin tribus, a division of the Roman people).',
  'section zoology':
    'In zoology, a section (with its sub- and series variants) is an ' +
    'informal-feeling but governed rank slotted between subgenus and ' +
    'species in very large genera (from Latin sectio, “a cutting”).',
  unranked:
    'An unranked node is a clade — a genuine branch of the tree of ' +
    'life — that the Linnaean rank ladder has no free rung for; modern ' +
    'classifications keep it rather than force a rank onto it.',
  subspecies:
    'A subspecies is a geographically or morphologically distinct ' +
    'population within a species, named with a third word added to the ' +
    'binomial.',
}

/** Prefix glossary for the intermediate ranks (round-2 feedback: every
    rank on the page must explain itself, subphylum and gigaclass
    included). {base} is replaced with the canonical rank name. */
const RANK_PREFIXES: [RegExp, string][] = [
  [/^subter/, 'below infra{base}'],
  [/^sub/, 'immediately below {base}'],
  [/^super/, 'immediately above {base}'],
  [/^infra/, 'below sub{base}'],
  [/^parv/, 'below infra{base}, as a small division'],
  [/^nan/, 'below parv{base}, as a minor division'],
  [/^mega/, 'above super{base}, as a large grouping'],
  [/^giga/, 'above mega{base}, as the largest grouping of the {base} tier'],
  [/^grand/, 'in the upper levels of the {base} tier'],
  [/^mir/, 'in the upper levels of the {base} tier'],
  [/^epi/, 'just above {base}'],
  [/^hypo/, 'just below {base}'],
]

/**
 * A definition for ANY rank string in the data: exact entries first, then
 * a composed sentence for prefix-derived ranks (subphylum, gigaclass, …),
 * so no chip is ever a dead end.
 */
export function rankDefinition(rank: string): string {
  const fallback = RANK_DEFINITIONS.root ?? ''
  const lower = rank.toLowerCase()
  const exact = RANK_DEFINITIONS[lower]
  if (exact) return exact
  const alias = RANK_ALIASES[lower]
  const aliased = alias ? RANK_DEFINITIONS[alias] : undefined
  if (aliased) return aliased
  const base = baseRank(lower)
  const baseDef = RANK_DEFINITIONS[base]
  const prefix = RANK_PREFIXES.find(([re]) => re.test(lower))
  if (prefix && base !== 'root' && baseDef) {
    const where = prefix[1].replaceAll('{base}', base)
    return (
      `A ${lower} is an intermediate rank ${where}, used where a ` +
      `group's diversity needs finer structure than the main ranks ` +
      `provide. ` +
      baseDef
    )
  }
  return baseDef ?? fallback
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

export const loadFocusFamily = (id: string) =>
  load<TaxonNode>(`biology/taxonomy/focus/${encodeURIComponent(id)}.json`)

export const colTaxonUrl = (datasetUrl: string, id: string) =>
  `${datasetUrl}/taxon/${encodeURIComponent(id)}`

export const wikipediaUrl = (title: string) =>
  `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

/** Ranks whose names are conventionally italicised. */
export const ITALIC_RANKS = new Set([
  'genus',
  'subgenus',
  'species',
  'subspecies',
  'variety',
])
