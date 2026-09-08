/**
 * Loaders, types and colour helpers for the Chemistry section
 * (round 3 §47): the periodic table, its element panel and the glossary.
 *
 * The property list the panel renders is NOT declared here — it lives in
 * src/data/chemistry-properties.json so scripts/check-chemistry.mjs reads
 * the identical list and can assert the data and glossary cover it.
 */

import { useEffect, useState } from 'react'

import { DATA_BASE_URL } from '../config'
import properties from '../data/chemistry-properties.json'
import type { AsyncState } from './data'

// ---------------------------------------------------------------------------
// Types (mirror etl/sources/chemistry.py)
// ---------------------------------------------------------------------------

export type FigureValue = number | string | number[] | string[] | null

export interface Figure {
  value: FigureValue
  unit: string | null
  /** Key into ElementsFile.sources. */
  source: string
  vintage: string | null
  note?: string
  /** Present whenever value is null. */
  reason?: string
  /** Extra fields some figures carry. */
  kind?: 'interval' | 'mostStableIsotope' | 'value'
  numeric?: number | null
  predicted?: boolean
  uncertainties?: (number | null)[]
  citations?: { name: string | null; url: string | null }[]
  heading?: string
}

export interface ElementImage {
  file: string
  kind: 'sample' | 'facility' | 'related'
  caption: string | null
  author: string | null
  license: string
  commonsPage: string
  source: string
  width: number | null
  height: number | null
  facility?: string | null
}

export type CategoryKey =
  | 'alkaliMetal'
  | 'alkalineEarthMetal'
  | 'transitionMetal'
  | 'postTransitionMetal'
  | 'metalloid'
  | 'reactiveNonmetal'
  | 'nobleGas'
  | 'lanthanide'
  | 'actinide'
  | 'unknown'

export type PropertyKey = keyof typeof properties.properties

export interface ElementRecord {
  z: number
  symbol: string
  name: string
  category: CategoryKey
  xpos: number
  ypos: number
  wikipedia: string
  pubchem: string
  rsc: string
  image: ElementImage | null
  noSample: boolean
  noSampleReason: string | null
  sampleNote: string | null
  properties: Record<PropertyKey, Figure>
}

export interface SourceRecord {
  title: string
  url: string
  licence: string
  vintage: string
  citation?: string
}

export interface ElementsFile {
  note: string
  sources: Record<string, SourceRecord>
  categories: Record<CategoryKey, string>
  furtherReading: Record<string, { title: string; url: string; note: string }>
  elements: ElementRecord[]
}

export interface GlossaryEntry {
  key: string
  term: string
  definition: string
  unit: string | null
  source: { title: string; url: string; publisher?: string }
  alsoSee?: { title: string; url: string }
}

export interface GlossaryFile {
  source: string
  version: number
  note: string
  entries: GlossaryEntry[]
}

// ---------------------------------------------------------------------------
// Property registry (shared with the check script via the JSON file)
// ---------------------------------------------------------------------------

export type PropertyMeta = {
  label: string
  unit: string | null
  kind: 'integer' | 'number' | 'text' | 'list' | 'prose'
}

export const PROPERTY_SECTIONS = properties.sections as {
  title: string
  keys: PropertyKey[]
}[]
export const PROPERTY_META = properties.properties as Record<PropertyKey, PropertyMeta>
export const PROPERTY_KEYS: PropertyKey[] = PROPERTY_SECTIONS.flatMap((s) => s.keys)

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

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

function useLoaded<T>(path: string): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    load<T>(path)
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
  }, [path])
  return state
}

export const useElements = (): AsyncState<ElementsFile> =>
  useLoaded<ElementsFile>('chemistry/elements.json')

export const useGlossary = (): AsyncState<GlossaryFile> =>
  useLoaded<GlossaryFile>('chemistry/glossary.json')

export function imageUrl(image: ElementImage): string {
  return `${DATA_BASE_URL}/chemistry/${image.file}`
}

// ---------------------------------------------------------------------------
// Colour: categories as tints, properties as one-hue ramps (§47.2)
// ---------------------------------------------------------------------------

/**
 * Nine hues ~40° apart plus a neutral for "unknown". The dataviz method
 * caps a categorical palette at eight slots; the periodic table's ten
 * categories are a domain convention every reader already knows, and
 * colour is never the only carrier: position in the table, the legend
 * chips, the cell's tooltip and the panel all name the category. Tints
 * sit at --chem-tint-l / --chem-tint-c so body text clears AA on all of
 * them (gated in check-contrast.mjs at the worst-case hue).
 */
export const CATEGORY_HUES: Record<CategoryKey, number | null> = {
  alkaliMetal: 20,
  alkalineEarthMetal: 60,
  transitionMetal: 100,
  postTransitionMetal: 140,
  metalloid: 180,
  reactiveNonmetal: 220,
  nobleGas: 260,
  lanthanide: 300,
  actinide: 340,
  unknown: null,
}

export const CATEGORY_ORDER: CategoryKey[] = [
  'alkaliMetal',
  'alkalineEarthMetal',
  'transitionMetal',
  'postTransitionMetal',
  'metalloid',
  'reactiveNonmetal',
  'nobleGas',
  'lanthanide',
  'actinide',
  'unknown',
]

export function categoryFill(category: CategoryKey): string {
  const hue = CATEGORY_HUES[category]
  if (hue === null) return 'var(--surface-sunken)'
  return `oklch(var(--chem-tint-l) var(--chem-tint-c) ${hue})`
}

/** Strong swatch of a category hue for legend dots and panel accents. */
export function categoryAccent(category: CategoryKey): string {
  const hue = CATEGORY_HUES[category]
  if (hue === null) return 'var(--text-muted)'
  return `light-dark(oklch(55% 0.13 ${hue}), oklch(72% 0.12 ${hue}))`
}

/**
 * Sequential ramp, t in [0, 1]: interpolates lightness and chroma between
 * --chem-scale-lo and --chem-scale-hi (one hue, 250). The endpoints are
 * gated; interpolation is linear in oklch so every intermediate step sits
 * between two passing values on both channels.
 */
export function scaleColour(t: number): string {
  const clamped = Math.max(0, Math.min(1, t))
  return `color-mix(in oklch, var(--chem-scale-hi) ${Math.round(clamped * 100)}%, var(--chem-scale-lo))`
}

/** Hatch for cells with no value — texture, never a colour (§47.2). */
export const NO_DATA_FILL =
  'repeating-linear-gradient(45deg, var(--surface-sunken) 0 3px, var(--border-strong) 3px 4px)'

// ---------------------------------------------------------------------------
// Property views
// ---------------------------------------------------------------------------

export type ViewKey =
  | 'category'
  | 'electronegativity'
  | 'vanDerWaalsRadius'
  | 'meltingPoint'
  | 'density'
  | 'abundanceCrust'
  | 'discoveryYear'
  | 'phaseAtStp'

export interface ViewSpec {
  key: ViewKey
  label: string
  /** 'category' and 'phase' are categorical; the rest are sequential. */
  scale: 'category' | 'phase' | 'linear' | 'log'
  unit?: string
}

export const VIEWS: ViewSpec[] = [
  { key: 'category', label: 'Category', scale: 'category' },
  { key: 'electronegativity', label: 'Electronegativity', scale: 'linear' },
  { key: 'vanDerWaalsRadius', label: 'Atomic radius', scale: 'linear', unit: 'pm' },
  { key: 'meltingPoint', label: 'Melting point', scale: 'linear', unit: 'K' },
  { key: 'density', label: 'Density', scale: 'log', unit: 'g/cm³' },
  { key: 'abundanceCrust', label: 'Crustal abundance', scale: 'log', unit: 'mg/kg' },
  { key: 'discoveryYear', label: 'Discovery year', scale: 'linear' },
  { key: 'phaseAtStp', label: 'Phase at STP', scale: 'phase' },
]

export const PHASE_HUES: Record<string, number> = { solid: 60, liquid: 220, gas: 300 }

/** Numeric value of a property for a view, or null when there is none. */
export function viewValue(element: ElementRecord, key: ViewKey): number | null {
  const figure = element.properties[key as PropertyKey]
  if (!figure) return null
  const v = figure.value
  if (key === 'discoveryYear') {
    if (typeof v === 'number') return v
    // "ancient": earlier than any dated discovery; placed at the scale's floor.
    return v === 'ancient' ? -3000 : null
  }
  return typeof v === 'number' ? v : null
}

export function viewDomain(elements: ElementRecord[], spec: ViewSpec): [number, number] | null {
  const values = elements
    .map((e) => viewValue(e, spec.key))
    .filter((v): v is number => v !== null && (spec.scale !== 'log' || v > 0))
  if (values.length === 0) return null
  return [Math.min(...values), Math.max(...values)]
}

export function viewPosition(value: number, domain: [number, number], spec: ViewSpec): number {
  const [lo, hi] = domain
  if (hi === lo) return 1
  if (spec.scale === 'log') {
    return (Math.log10(value) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))
  }
  return (value - lo) / (hi - lo)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 })
const compact = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 })

export function formatNumber(value: number, unit?: string | null): string {
  let text: string
  const abs = Math.abs(value)
  if (abs !== 0 && (abs < 0.001 || abs >= 1e7)) {
    const exponent = Math.floor(Math.log10(abs))
    const mantissa = value / 10 ** exponent
    text = `${mantissa.toFixed(2)}×10${superscript(exponent)}`
  } else if (abs < 1) {
    text = compact.format(value)
  } else {
    text = number.format(value)
  }
  return unit ? `${text} ${unit}` : text
}

export function superscript(n: number): string {
  const digits: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵',
    '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
  }
  return String(n).split('').map((c) => digits[c] ?? c).join('')
}

/** "1s2 2s2 2p6" -> "1s² 2s² 2p⁶" */
export function prettyConfiguration(text: string): string {
  return text.replace(/([spdf])(\d+)/g, (_m, letter: string, count: string) =>
    `${letter}${count.split('').map((d) => superscript(Number(d))).join('')}`,
  )
}

export function formatKelvin(k: number): string {
  return `${formatNumber(k, 'K')} (${formatNumber(k - 273.15, '°C')})`
}

/** One string for a figure's value, honouring kind and unit. */
export function formatFigure(key: PropertyKey, figure: Figure): string {
  const meta = PROPERTY_META[key]
  const v = figure.value
  if (v === null) return 'not available'
  if (key === 'meltingPoint' || key === 'boilingPoint') return formatKelvin(v as number)
  if (key === 'electronConfiguration' || key === 'electronConfigurationFull') {
    return prettyConfiguration(String(v))
  }
  if (key === 'electronShells' && Array.isArray(v)) return v.join(', ')
  if (key === 'ionizationEnergies' && Array.isArray(v)) {
    return (v as number[]).map((e, i) => `${['1st', '2nd', '3rd'][i]} ${formatNumber(e, 'eV')}`).join(' · ')
  }
  if (key === 'discoveryYear') {
    if (v === 'ancient') return 'Known since antiquity'
    return String(v)
  }
  if (Array.isArray(v)) return v.map(String).join(', ')
  if (typeof v === 'number') return formatNumber(v, figure.unit ?? meta.unit)
  if (key === 'phaseAtStp') {
    const s = String(v)
    return (s.charAt(0).toUpperCase() + s.slice(1)) + (figure.predicted ? ' (predicted)' : '')
  }
  return String(v)
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
