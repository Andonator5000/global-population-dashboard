import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { EntityTable } from '../components/EntityTable'
import { LiveCounter } from '../components/LiveCounter'
import { MapReadout } from '../components/MapReadout'
import { TimeScrubber } from '../components/TimeScrubber'
import { WorldMap, type HoverTarget } from '../components/WorldMap'
import {
  DEFAULT_PROJECTION,
  PROJECTIONS,
  UNINHABITED_CONTINENTS,
  type ContinentKey,
  type ProjectionKey,
} from '../config'
import {
  useCountryTopology,
  useMapMarkers,
  useGdpSummary,
  useMapPalette,
  usePopulationSummary,
  usePopulationTimeline,
} from '../lib/data'
import { formatExact, formatPopulation } from '../lib/format'
import { PROJECTION_LABELS } from '../lib/projection'
import type { PopulationRow } from '../types'

export function HomePage() {
  const summaryState = usePopulationSummary()
  const paletteState = useMapPalette()
  const gdpState = useGdpSummary()
  const topologyState = useCountryTopology()
  const markersState = useMapMarkers()
  const navigate = useNavigate()

  const [projectionKey, setProjectionKey] =
    useState<ProjectionKey>(DEFAULT_PROJECTION)
  const [mode, setMode] = useState<'country' | 'continent'>('country')
  const [hovered, setHovered] = useState<HoverTarget | null>(null)
  const [activeContinent, setActiveContinent] = useState<ContinentKey | null>(null)

  // null means "now" -- the live counter runs. A number pins every figure to
  // that year and stops the ticking, because a running count only means
  // anything for the present.
  const [scrubYear, setScrubYear] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const timelineState = usePopulationTimeline(true)
  const timeline =
    timelineState.status === 'ready' ? timelineState.data : null

  /** Present calendar year, clamped into the published range. */
  const liveYear = useMemo(() => {
    if (!timeline) return new Date().getFullYear()
    const first = timeline.years[0] ?? 1950
    const last = timeline.years[timeline.years.length - 1] ?? 2100
    return Math.min(Math.max(new Date().getFullYear(), first), last)
  }, [timeline])

  /** World series converted from WPP thousands to persons. */
  const worldSeriesPersons = useMemo(
    () => (timeline ? timeline.world.map((v) => v * 1000) : []),
    [timeline],
  )

  const worldComponentSeries = useMemo(() => {
    if (!timeline?.worldComponents) return undefined
    const out: Record<string, (number | null)[]> = {}
    for (const [key, values] of Object.entries(timeline.worldComponents)) {
      out[key] = values.map((v) => v * 1000)
    }
    return out
  }, [timeline])

  const worldAtScrubYear = useMemo(() => {
    if (!timeline || scrubYear === null) return null
    const index = timeline.years.indexOf(scrubYear)
    return index >= 0 ? (timeline.world[index] ?? 0) * 1000 : null
  }, [timeline, scrubYear])

  /** Per-entity population for the scrubbed year, in persons. */
  const scrubPopulation = useMemo(() => {
    if (!timeline || scrubYear === null) return null
    const index = timeline.years.indexOf(scrubYear)
    if (index < 0) return null
    const map = new Map<string, number | null>()
    for (const [iso3, values] of Object.entries(timeline.entities)) {
      const value = values[index]
      map.set(iso3, value === null || value === undefined ? null : value * 1000)
    }
    return map
  }, [timeline, scrubYear])

  const rows: PopulationRow[] =
    summaryState.status === 'ready' ? summaryState.data.entities : []

  /**
   * Population rows for whatever year is displayed.
   *
   * When the scrubber is engaged, the population figure is swapped for that
   * year's value and the rate fields are cleared. Leaving a 2023 growth rate
   * beside a 1960 population would silently mix vintages, which is exactly
   * what this project refuses to do elsewhere.
   */
  const byIso3 = useMemo(() => {
    const base = new Map(rows.map((row) => [row.iso3, row]))
    if (!scrubPopulation || scrubYear === null) return base
    const merged = new Map<string, PopulationRow>()
    for (const [iso3, row] of base) {
      const population = scrubPopulation.get(iso3) ?? null
      merged.set(iso3, {
        ...row,
        year: scrubYear,
        available: population !== null,
        population,
        growthRate: null,
        density: null,
        medianAge: null,
        fertilityRate: null,
        lifeExpectancy: null,
        births: null,
        deaths: null,
        netMigration: null,
        ...(population === null
          ? {
              unavailableReason: `UN WPP publishes no ${scrubYear} figure for this entity.`,
            }
          : {}),
      })
    }
    return merged
  }, [rows, scrubPopulation, scrubYear])

  const worldTotal = useMemo(
    () =>
      rows.reduce(
        (sum, row) =>
          row.available && row.population ? sum + row.population : sum,
        0,
      ),
    [rows],
  )

  const loading =
    summaryState.status === 'loading' ||
    topologyState.status === 'loading' ||
    markersState.status === 'loading'

  const error =
    summaryState.status === 'error'
      ? summaryState.error
      : topologyState.status === 'error'
        ? topologyState.error
        : markersState.status === 'error'
          ? markersState.error
          : null

  const year = summaryState.status === 'ready' ? summaryState.data.year : 0
  const revision =
    summaryState.status === 'ready' ? summaryState.data.revision : 0

  return (
    // Maintainer ruling (2026-08-24): the home page washes VERDANT GREEN in
    // both themes -- a rich light green in light mode, deep forest green in
    // dark -- replacing the neutral blue tint. Country pages keep their
    // flag-derived tints. light-dark() follows the root's color-scheme.
    // Both greens hold AA against the theme's own text tokens (light: 22%L
    // text on 87%L green; dark: 94%L text on 30%L green), so every card and
    // control inside keeps its normal polarity.
    <div
      className="min-h-full"
      style={{
        background:
          'light-dark(oklch(87% 0.10 148), oklch(30% 0.07 150))',
      }}
    >
    <div className="mx-auto max-w-[110rem] px-6 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          World population
        </h1>

        {timeline ? (
          scrubYear === null ? (
            <div className="mt-2">
              <LiveCounter
                years={timeline.years}
                values={worldSeriesPersons}
                {...(worldComponentSeries ? { series: worldComponentSeries } : {})}
                estimatesThrough={timeline.estimatesThrough}
                revision={timeline.revision}
                label="World population"
              />
            </div>
          ) : (
            <div className="mt-2">
              <span className="text-4xl font-semibold tracking-tight">
                {formatExact(worldAtScrubYear)}
              </span>
              <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                World population in {scrubYear} —{' '}
                {scrubYear > timeline.estimatesThrough
                  ? `medium-variant projection from UN WPP ${timeline.revision}`
                  : `estimate from UN WPP ${timeline.revision}`}
                . Summed from {timeline.worldEntityCount[
                  timeline.years.indexOf(scrubYear)
                ] ?? 0}{' '}
                entities.
              </p>
            </div>
          )
        ) : (
          summaryState.status === 'ready' && (
            <p className="mt-2">
              <span className="text-3xl font-semibold tracking-tight">
                {formatPopulation(worldTotal)}
              </span>{' '}
              <span style={{ color: 'var(--text-muted)' }}>
                people in {year} — {formatExact(worldTotal)}, summed from{' '}
                {rows.filter((row) => row.available).length} entities.
              </span>
            </p>
          )
        )}

        <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          {projectionKey === 'globe'
            ? 'Globe view — drag to spin it. Shapes foreshorten toward the horizon as on a physical globe; the flat views use equal-area projections.'
            : 'Equal-area projection, so land areas are shown in true relative size.'}{' '}
          Source: UN World Population Prospects {revision || '—'}, medium
          variant.
        </p>
      </header>

      <div className="mt-6 flex flex-wrap items-center gap-4 text-sm">
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">Map fill mode</legend>
          {(['country', 'continent'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value)
                setActiveContinent(null)
              }}
              className="rounded border px-2.5 py-1"
              style={{
                borderColor: 'var(--border)',
                background:
                  mode === value ? 'var(--control-selected-bg)' : 'transparent',
                color:
                  mode === value ? 'var(--control-selected-text)' : 'inherit',
              }}
            >
              {value === 'country' ? 'Country' : 'Continent'}
            </button>
          ))}
        </fieldset>

        <label className="flex items-center gap-2">
          <span style={{ color: 'var(--text-muted)' }}>Projection</span>
          <select
            value={projectionKey}
            onChange={(event) =>
              setProjectionKey(event.target.value as ProjectionKey)
            }
            className="rounded border px-2 py-1"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface-raised)',
              color: 'var(--text)',
            }}
          >
            {PROJECTIONS.map((key) => (
              <option key={key} value={key}>
                {PROJECTION_LABELS[key]}
              </option>
            ))}
          </select>
        </label>

        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {projectionKey === 'globe'
            ? 'Drag to spin the globe; scroll or pinch to zoom.'
            : 'Scroll or pinch to zoom, drag to pan.'}{' '}
          Tab into the map, then use the arrow keys to move between countries
          and Enter to open one.
        </span>
      </div>

      {timeline && (
        <div
          className="mt-4 rounded-lg border px-4 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <TimeScrubber
            years={timeline.years}
            // In live mode the slider rests on the CURRENT year, so it agrees
            // with the counter above it. Resting it on the last estimate year
            // instead made the header read 2026 while the slider said 2023.
            value={scrubYear ?? liveYear}
            onChange={setScrubYear}
            estimatesThrough={timeline.estimatesThrough}
            playing={playing}
            onPlayingChange={setPlaying}
          />
          {scrubYear !== null && (
            <button
              type="button"
              className="mt-2 text-xs underline underline-offset-2"
              style={{ color: 'var(--text-muted)' }}
              onClick={() => {
                setPlaying(false)
                setScrubYear(null)
              }}
            >
              Return to the live estimate
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="mt-8" style={{ color: 'var(--text-muted)' }}>
          {error.message}
        </p>
      )}

      {loading && !error && (
        <p className="mt-8" style={{ color: 'var(--text-muted)' }}>
          Loading map and population data…
        </p>
      )}

      {!loading && !error && topologyState.status === 'ready' && (
        <div className="map-layout mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
          {/* Escape hatch for keyboard users. The map is a single tab stop
              with arrow-key navigation inside, but someone who tabs INTO it
              still wants a one-key way back out to the table. */}
          <a
            href="#all-entities"
            className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:px-3 focus:py-2"
            style={{ background: 'var(--surface-raised)', color: 'var(--text)' }}
          >
            Skip the map and go to the entity table
          </a>
          <div
            className="overflow-hidden rounded-lg border"
            style={{ borderColor: 'var(--border)' }}
          >
            <WorldMap
              topology={topologyState.data}
              markers={
                markersState.status === 'ready' ? markersState.data.markers : []
              }
              populationByIso3={byIso3}
              projectionKey={projectionKey}
              mode={mode}
              hovered={hovered}
              onHover={setHovered}
              onSelect={(target) =>
                // In continent mode a click opens the CONTINENT the country
                // belongs to, not the country under the pointer.
                navigate(
                  mode === 'continent'
                    ? `/continent/${target.continent}`
                    : `/country/${target.iso3}`,
                )
              }
              activeContinent={activeContinent}
              onActiveContinentChange={setActiveContinent}
            />
            {UNINHABITED_CONTINENTS.length > 0 && (
              <p
                className="border-t px-4 py-2 text-xs"
                style={{
                  color: 'var(--text-muted)',
                  borderColor: 'var(--border)',
                  background: 'var(--surface-raised)',
                }}
              >
                <strong style={{ fontWeight: 600 }}>Note:</strong> Antarctica
                has no permanent population and is excluded from per-capita and
                density rankings.
              </p>
            )}
          </div>

          <aside className="space-y-4">
            <MapReadout
              target={hovered}
              row={hovered ? byIso3.get(hovered.iso3) : undefined}
              year={scrubYear ?? year}
              revision={revision}
              topology={topologyState.data}
              palette={
                paletteState.status === 'ready' ? paletteState.data : null
              }
            />
          </aside>
        </div>
      )}

      {summaryState.status === 'ready' && (
        <EntityTable
          rows={[...byIso3.values()]}
          year={scrubYear ?? year}
          revision={revision}
          gdp={gdpState.status === 'ready' ? gdpState.data : null}
          note={
            scrubYear === null
              ? undefined
              : `Only population varies with the selected year. Growth rate and density are left blank rather than carried over from ${year}, which would pair a ${year} rate with a ${scrubYear} population.`
          }
        />
      )}
    </div>
    </div>
  )
}
