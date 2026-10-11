/**
 * Loader and types for /space/travel (round 14, DATA_DECISIONS section 74).
 *
 * The payload is a committed artifact (data/space/travel/travel.json) built
 * by the `spacetravel` ETL stage from the editorial reference file. Images
 * are served from /data, never hotlinked; a figure a source does not
 * publish arrives as `{ v: null, why }` and must render as that reason, not
 * as a blank or a zero.
 */

import { useEffect, useState } from 'react'

import { DATA_BASE_URL } from '../config'
import type { AsyncState } from './data'

export interface TravelSource {
  title: string
  url: string
  year?: number
}

/** A figure: a value WITH a source, or null WITH a reason. Never zero. */
export interface Spec {
  v: number | string | null
  u?: string
  src?: string
  url?: string
  year?: number
  note?: string
  why?: string
}

export interface TravelImage {
  file: string
  width: number
  height: number
  title: string
  credit: string
  licence: string
  source: string
  page: string
}

export interface TravelEra {
  id: string
  label: string
  dateLabel: string
  from: number
  to: number
  hue: number
  summary: string
  sources: TravelSource[]
}

export interface TravelEvent {
  id: string
  era: string
  year: number
  dateDisplay: string
  title: string
  text: string
  craft: string[]
  people: string[]
  vintage: string | null
  wikipedia: string
  image: TravelImage | null
  imageNote: string | null
  sources: TravelSource[]
}

export type CraftType = 'rocket' | 'crewed' | 'satellite' | 'probe' | 'station'

/** One section of a nose-up profile: lengths and diameters in metres. */
export interface SilhouetteSection {
  s: 'cone' | 'cyl' | 'taper' | 'sphere' | 'dome'
  len: number
  d0: number
  d1: number
}

export interface SilhouetteFin {
  /** Fraction of the vehicle's height, measured from the bottom. */
  at: number
  len: number
  span: number
  count: number
  role?: string
}

export interface SilhouettePart {
  s: 'rect' | 'cyl' | 'disc' | 'rod' | 'cone' | 'kite'
  x: number
  y: number
  w: number
  h: number
  r: 'body' | 'panel' | 'truss' | 'dish' | 'antenna' | 'radiator' | 'mirror' | 'shield'
  rot?: number
}

export interface Silhouette {
  axis: 'vertical' | 'span'
  /** Vertical: the drawn height in metres. */
  heightM?: number
  heightNote?: string
  sections?: SilhouetteSection[]
  fins?: SilhouetteFin[]
  wings?: { from: number; to: number; spanM: number }
  panels?: { spanM: number; at: number; widthM: number }
  strapOns?: {
    count: number
    len: number
    dTop: number
    dBot: number
    baseAt: number
    spanM: number
    nose?: boolean
  }
  attached?: {
    kind: 'orbiter'
    lenM: number
    spanM: number
    bodyDiaM: number
    fromBottomM: number
  }
  /** Span: the drawn extent in metres. */
  spanM?: number
  depthM?: number
  spanNote?: string
  parts?: SilhouettePart[]
}

export interface TravelCraft {
  id: string
  name: string
  type: CraftType
  country: string
  organisation: string
  designers: string[]
  people: string[]
  firstFlight: string | null
  lastFlight: string | null
  status: string
  summary: string
  specs: Record<string, Spec>
  silhouette: Silhouette | null
  drawing: { title: string; url: string } | null
  wikipedia: string
  sources: TravelSource[]
}

export interface TravelPerson {
  id: string
  name: string
  born: number
  died: number | null
  lifeDisplay: string
  nationality: string
  role: string
  bio: string
  knownFor: string[]
  craft: string[]
  wikipedia: string
  portrait: TravelImage | null
  portraitNote: string | null
  sources: TravelSource[]
}

export interface Callout {
  /** Our own numbered mark, or the key the source drawing already prints. */
  n?: number
  key?: string
  x?: number
  y?: number
  label: string
  note: string
}

export interface TravelCutaway {
  id: string
  title: string
  craft: string
  note: string
  overlay: boolean
  sourceLabelled: boolean
  callouts: Callout[]
  image: TravelImage
  sources: TravelSource[]
}

export interface ScaleReference {
  id: string
  label: string
  heightM: number
  note: string
  source: TravelSource
}

export interface Plate {
  id: string
  title: string
  kind: 'vertical' | 'span'
  intro: string
  note: string
  items: string[]
  scaleRefs: string[]
}

export interface TravelFile {
  source: string
  version: number
  note: string
  sourcingPolicy: string
  imageNote: string
  eraNote: string
  eras: TravelEra[]
  scaleReferences: ScaleReference[]
  plates: Plate[]
  craft: TravelCraft[]
  people: TravelPerson[]
  events: TravelEvent[]
  cutaways: TravelCutaway[]
  counts: {
    eras: number
    events: number
    craft: number
    people: number
    cutaways: number
    plates: number
    eventsByEra: Record<string, number>
    craftByType: Record<string, number>
    images: number
  }
}

/** data/space/travel/images/<file>.jpg is served from /data; build its URL. */
export const travelImageUrl = (image: TravelImage): string =>
  `${DATA_BASE_URL}/${image.file}`

export const CRAFT_TYPE_LABELS: Record<CraftType, string> = {
  rocket: 'Launch vehicles',
  crewed: 'Crewed spacecraft',
  satellite: 'Satellites & telescopes',
  probe: 'Robotic explorers',
  station: 'Space stations',
}

/** Spec keys in the order a panel should read them, with their labels. */
export const SPEC_LABELS: Record<string, string> = {
  heightM: 'Height',
  lengthM: 'Length',
  diameterM: 'Diameter',
  widthM: 'Width',
  spanM: 'Span',
  mirrorM: 'Primary mirror',
  massKg: 'Mass',
  payloadLeoKg: 'Payload to low Earth orbit',
  payloadGtoKg: 'Payload to geostationary transfer',
  payloadTliKg: 'Payload to the Moon',
  thrustKN: 'Thrust at liftoff',
  crew: 'Crew',
  pressurisedVolumeM3: 'Pressurised volume',
  sampleG: 'Sample returned',
  distanceKm: 'Distance from Earth',
  designLifeYears: 'Design life',
  enginesText: 'Engines',
  flights: 'Flight record',
}

const SPEC_ORDER = Object.keys(SPEC_LABELS)

export function orderedSpecs(specs: Record<string, Spec>): [string, Spec][] {
  const known = SPEC_ORDER.filter((k) => k in specs).map(
    (k) => [k, specs[k]!] as [string, Spec],
  )
  const rest = Object.entries(specs).filter(([k]) => !SPEC_LABELS[k])
  return [...known, ...rest]
}

/** Render a figure the way the site renders figures: value + unit, or the
    source's own reason for not publishing it. Never a bare blank. */
export function formatSpec(spec: Spec): string {
  if (spec.v === null || spec.v === undefined) return 'not available'
  if (typeof spec.v === 'string') return spec.v
  const unit = spec.u ?? ''
  const value =
    Math.abs(spec.v) >= 1000
      ? spec.v.toLocaleString('en', { maximumFractionDigits: 0 })
      : spec.v.toLocaleString('en', { maximumFractionDigits: 3 })
  return unit ? `${value} ${unit}` : value
}

export function formatFlightDate(value: string | null): string {
  if (!value) return 'not available'
  const [y, m, d] = value.split('-')
  if (!m) return y ?? value
  const month = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString(
    'en',
    { month: 'long', timeZone: 'UTC' },
  )
  return d ? `${Number(d)} ${month} ${y}` : `${month} ${y}`
}

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

export function useSpaceTravel(): AsyncState<TravelFile> {
  const [state, setState] = useState<AsyncState<TravelFile>>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    load<TravelFile>('space/travel/travel.json')
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
