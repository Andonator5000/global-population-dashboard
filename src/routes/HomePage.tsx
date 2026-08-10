import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import { EntityTable } from '../components/EntityTable'
import { MapLegend } from '../components/MapLegend'
import { MapReadout } from '../components/MapReadout'
import { WorldMap, type HoverTarget } from '../components/WorldMap'
import {
  DEFAULT_PROJECTION,
  PROJECTIONS,
  UNINHABITED_CONTINENTS,
  type ContinentKey,
  type ProjectionKey,
} from '../config'
import { useCountryTopology, useMapMarkers, usePopulationSummary } from '../lib/data'
import { formatExact, formatPopulation } from '../lib/format'
import { PROJECTION_LABELS } from '../lib/projection'
import type { PopulationRow } from '../types'

export function HomePage() {
  const summaryState = usePopulationSummary()
  const topologyState = useCountryTopology()
  const markersState = useMapMarkers()
  const navigate = useNavigate()

  const [projectionKey, setProjectionKey] =
    useState<ProjectionKey>(DEFAULT_PROJECTION)
  const [mode, setMode] = useState<'country' | 'continent'>('country')
  const [hovered, setHovered] = useState<HoverTarget | null>(null)
  const [activeContinent, setActiveContinent] = useState<ContinentKey | null>(null)

  const rows: PopulationRow[] =
    summaryState.status === 'ready' ? summaryState.data.entities : []

  const byIso3 = useMemo(
    () => new Map(rows.map((row) => [row.iso3, row])),
    [rows],
  )

  const continentCounts = useMemo(() => {
    const counts = new Map<ContinentKey, number>()
    for (const row of rows) {
      counts.set(row.continent, (counts.get(row.continent) ?? 0) + 1)
    }
    return counts
  }, [rows])

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
    <div className="mx-auto max-w-[110rem] px-6 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          World population
        </h1>
        {summaryState.status === 'ready' && (
          <p className="mt-2">
            <span className="text-3xl font-semibold tracking-tight">
              {formatPopulation(worldTotal)}
            </span>{' '}
            <span style={{ color: 'var(--text-muted)' }}>
              people in {year} — {formatExact(worldTotal)}, summed from{' '}
              {rows.filter((row) => row.available).length} entities.
            </span>
          </p>
        )}
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Source: UN World Population Prospects {revision || '—'}, medium
          variant, {year || '—'} estimate. Equal-area projection, so land areas
          are shown in true relative size. The live-ticking counter arrives in a
          later phase; this is the published annual estimate, not a modelled
          instantaneous figure.
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
                  mode === value ? 'var(--map-accent-fill)' : 'transparent',
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
          Scroll or pinch to zoom, drag to pan. Tab to move between countries,
          Enter to open one.
        </span>
      </div>

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
        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
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
              onSelect={(target) => navigate(`/country/${target.iso3}`)}
              activeContinent={activeContinent}
              onActiveContinentChange={setActiveContinent}
            />
          </div>

          <aside className="space-y-4">
            <MapReadout
              target={hovered}
              row={hovered ? byIso3.get(hovered.iso3) : undefined}
              year={year}
              revision={revision}
            />
            <MapLegend
              mode={mode}
              activeContinent={activeContinent}
              onActiveContinentChange={setActiveContinent}
              continentCounts={continentCounts}
            />
            {UNINHABITED_CONTINENTS.length > 0 && (
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Antarctica has no permanent population and is excluded from
                per-capita and density rankings.
              </p>
            )}
          </aside>
        </div>
      )}

      {summaryState.status === 'ready' && (
        <EntityTable rows={rows} year={year} revision={revision} />
      )}
    </div>
  )
}
