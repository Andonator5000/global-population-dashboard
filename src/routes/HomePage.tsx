import { memo, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { CountrySearch } from '../components/CountrySearch'
import { EntityTable } from '../components/EntityTable'
import { LiveCounter } from '../components/LiveCounter'
import { MethodInfoLink } from '../components/MethodInfoLink'
import { MapReadout } from '../components/MapReadout'
import { TimeScrubber } from '../components/TimeScrubber'
import { WorldMap, type HoverTarget, type WorldMapHandle } from '../components/WorldMap'
import {
  BASE_VIEWS,
  BASE_VIEW_LABELS,
  DATA_BASE_URL,
  DEFAULT_MAP_PALETTE,
  DEFAULT_PROJECTION,
  MAP_PALETTES,
  MAP_PALETTE_LABELS,
  PROJECTIONS,
  UNINHABITED_CONTINENTS,
  type BaseViewKey,
  type ContinentKey,
  type MapPaletteKey,
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
import { formatExact, formatGrowthRate, formatPopulation } from '../lib/format'
import { PROJECTION_LABELS } from '../lib/projection'
import type { GdpSummary, PopulationRow } from '../types'

/**
 * Round 4 (§51.3): every hover on the map is a HomePage state change, and
 * the 250-row table used to re-render on each one because its `rows`
 * array was rebuilt inline. Memoised props + a memoised table mean a
 * hover (or a tap on a phone) re-renders the readout and the map only.
 */
const MemoEntityTable = memo(EntityTable)

const compactUsd = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
})

/**
 * Popover content for a hovered/tapped country (round-2 §36): the headline
 * figures, each with its vintage, and the client-side route to the full
 * page. The chrome (position, close control) is the map's job.
 */
function CountryPopoverContent({
  target,
  row,
  gdp,
}: {
  target: HoverTarget
  row: PopulationRow | undefined
  gdp: GdpSummary['entities'][string] | undefined
}) {
  // The corner carries the country's flag (Andy's preference once the
  // dev-server MIME fix made flags render locally; the interim fitted
  // country shape is gone).
  return (
    <div className="font-sans">
      <p className="flex items-center gap-2 text-sm font-semibold leading-tight">
        <img
          src={`${DATA_BASE_URL}/flags/svg/${target.iso3}.svg`}
          alt=""
          className="h-4 w-6 shrink-0 rounded-[2px] border object-cover"
          style={{ borderColor: 'var(--border)' }}
          loading="lazy"
        />
        {target.name}
      </p>
      <dl className="mt-1.5 space-y-0.5">
        <div className="flex justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>Population</dt>
          <dd className="text-right tabular-nums">
            {row?.available && row.population != null
              ? `${formatPopulation(row.population)} · ${row.year}`
              : 'not available'}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>GDP</dt>
          <dd className="text-right tabular-nums">
            {gdp ? `${compactUsd.format(gdp.value)} · ${gdp.year}` : 'not available'}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt style={{ color: 'var(--text-muted)' }}>Growth</dt>
          <dd className="text-right tabular-nums">
            {row?.available && row.growthRate != null
              ? `${formatGrowthRate(row.growthRate)} · ${row.year}`
              : 'not available'}
          </dd>
        </div>
      </dl>
      <Link
        to={`/country/${target.iso3}`}
        className="mt-2 inline-block font-medium underline underline-offset-2"
        style={{ color: 'var(--accent)' }}
      >
        More info →
      </Link>
    </div>
  )
}

/**
 * Bottom-sheet content for a tapped country (round 5, §53.2). Collapsed:
 * flag, name, and the two figures a reader wants first. Expanded (swiped
 * up): the popover's full card with its "More info" link, plus the
 * readout panel that the phone layout no longer shows beside the map.
 */
function CountrySheetContent({
  target,
  row,
  gdp,
  expanded,
  readout,
}: {
  target: HoverTarget
  row: PopulationRow | undefined
  gdp: GdpSummary['entities'][string] | undefined
  expanded: boolean
  readout: React.ReactNode
}) {
  if (expanded) {
    return (
      <div className="space-y-3">
        <CountryPopoverContent target={target} row={row} gdp={gdp} />
        {readout}
      </div>
    )
  }
  return (
    <div className="font-sans">
      <p className="flex items-center gap-2 text-base font-semibold leading-tight">
        <img
          src={`${DATA_BASE_URL}/flags/svg/${target.iso3}.svg`}
          alt=""
          className="h-4 w-6 shrink-0 rounded-[2px] border object-cover"
          style={{ borderColor: 'var(--border)' }}
          loading="lazy"
        />
        {target.name}
      </p>
      <p className="mt-1 text-sm tabular-nums" style={{ color: 'var(--text-muted)' }}>
        {row?.available && row.population != null
          ? `${formatPopulation(row.population)} people`
          : 'population not available'}
        {row?.available && row.growthRate != null
          ? ` · ${formatGrowthRate(row.growthRate)} growth`
          : ''}
        {' · '}
        <Link
          to={`/country/${target.iso3}`}
          className="underline underline-offset-2"
          style={{ color: 'var(--accent)' }}
        >
          More info
        </Link>
      </p>
    </div>
  )
}

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
  // Palette and base view persist across visits (round-2 §37) — they are
  // presentation preferences, not data state, so localStorage is right.
  const [paletteDirection, setPaletteDirection] = useState<MapPaletteKey>(
    () => {
      try {
        const stored = localStorage.getItem('map-palette')
        return MAP_PALETTES.includes(stored as MapPaletteKey)
          ? (stored as MapPaletteKey)
          : DEFAULT_MAP_PALETTE
      } catch {
        return DEFAULT_MAP_PALETTE
      }
    },
  )
  const [baseView, setBaseView] = useState<BaseViewKey>(() => {
    try {
      const stored = localStorage.getItem('map-base-view')
      return BASE_VIEWS.includes(stored as BaseViewKey)
        ? (stored as BaseViewKey)
        : 'political'
    } catch {
      return 'political'
    }
  })
  const pickPalette = (value: MapPaletteKey) => {
    setPaletteDirection(value)
    try {
      localStorage.setItem('map-palette', value)
    } catch {
      /* preference only */
    }
  }
  const pickBaseView = (value: BaseViewKey) => {
    setBaseView(value)
    try {
      localStorage.setItem('map-base-view', value)
    } catch {
      /* preference only */
    }
  }
  const [hovered, setHovered] = useState<HoverTarget | null>(null)
  const [activeContinent, setActiveContinent] = useState<ContinentKey | null>(null)
  const mapRef = useRef<WorldMapHandle>(null)
  /** Phone toolbar (§53.5): the settings panel is collapsed by default. */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** The flat projection the Globe/Map toggle returns to. */
  const lastFlat = useRef<ProjectionKey>('equalEarth')
  if (projectionKey !== 'globe') lastFlat.current = projectionKey

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

  const tableRows = useMemo(() => [...byIso3.values()], [byIso3])
  const searchEntities = useMemo(
    () =>
      tableRows
        .map((row) => ({ iso3: row.iso3, name: row.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [tableRows],
  )

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
    // Layout and colour reworked 2026-08-30 with the UI UX Pro Max
    // database (DATA_DECISIONS 27): the verdant-green wash of 2026-08-24 is
    // replaced by the site's neutral page tint, and the page is composed of
    // three raised cards -- hero (title, live counter, time scrubber), map
    // (toolbar, map, readout) and the entity table -- so the eye has three
    // things to find instead of one green field. Every colour is a gated
    // theme token; no new colour was introduced.
    <div className="min-h-full" style={{ background: 'var(--page-tint)' }}>
    {/* Round 5 (§53.1) made this a flex column so the phone order could
        differ; round 7 (§57.5, Andy) puts the year controls directly under
        the World population box on EVERY width, so the order is the same
        everywhere and the column simply keeps the cards stacked. */}
    <div className="mx-auto flex max-w-[110rem] flex-col px-4 py-6 sm:px-6 sm:py-8">
      {/* Round 12: a supernova rule across the top of each raised card. It is
          the card's own top border re-coloured and thickened, so nothing
          shifts in the layout and the rounded corner still clips it. */}
      <header
        className="order-1 rounded-xl border px-4 py-4 sm:px-6 sm:py-6"
        style={{
          borderColor: 'var(--border)',
          borderTopColor: 'var(--supernova)',
          borderTopWidth: '3px',
          background: 'var(--surface-raised)',
        }}
      >
        <p
          className="font-sans text-xs font-medium uppercase tracking-widest"
          style={{ color: 'var(--text-muted)' }}
        >
          Global Data
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
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

        {/* Round-2 §36.4: the projection explainer moved to /methodology;
            the page keeps the compact source label. */}
        <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          UN World Population Prospects {revision || '—'}, medium variant ·{' '}
          <MethodInfoLink anchor="projections" label="About the map projections" />
        </p>

      </header>

      {timeline && (
        <div
          className="order-2 mt-3 rounded-xl border px-4 py-3"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
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

      <div className="order-3 mt-4 sm:mt-6">
      {/* Phone toolbar (§53.5): Globe / Map and a Map settings disclosure
          with generous tap areas; the full control set below is the
          settings panel on a phone and the toolbar on wider screens. */}
      <div
        className="flex items-center gap-2 rounded-t-xl border border-b-0 px-3 py-2.5 text-sm sm:hidden"
        style={{
          borderColor: 'var(--border)',
          borderTopColor: 'var(--supernova)',
          borderTopWidth: '3px',
          background: 'var(--surface-raised)',
        }}
      >
        <fieldset className="flex flex-1 items-center gap-1">
          <legend className="sr-only">Globe or flat map</legend>
          {(['globe', 'flat'] as const).map((value) => {
            const active = value === 'globe' ? projectionKey === 'globe' : projectionKey !== 'globe'
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  setProjectionKey(value === 'globe' ? 'globe' : lastFlat.current)
                }
                className="min-h-11 flex-1 rounded-lg border px-3 py-2 font-medium"
                style={{
                  borderColor: 'var(--border)',
                  background: active ? 'var(--control-selected-bg)' : 'transparent',
                  color: active ? 'var(--control-selected-text)' : 'inherit',
                }}
              >
                {value === 'globe' ? 'Globe' : 'Map'}
              </button>
            )
          })}
        </fieldset>
        <button
          type="button"
          aria-expanded={settingsOpen}
          aria-controls="map-settings"
          onClick={() => setSettingsOpen((open) => !open)}
          className="min-h-11 rounded-lg border px-3 py-2 font-medium"
          style={{
            borderColor: 'var(--border)',
            background: settingsOpen ? 'var(--control-selected-bg)' : 'transparent',
            color: settingsOpen ? 'var(--control-selected-text)' : 'inherit',
          }}
        >
          Map settings
        </button>
      </div>

      {/* Map toolbar: fill mode, projection, colours, and the interaction hint. */}
      <div
        id="map-settings"
        className={`${settingsOpen ? 'flex' : 'hidden'} map-settings-panel flex-wrap items-center gap-4 border border-b-0 px-4 py-3 text-sm sm:flex sm:rounded-t-xl`}
        style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
      >
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

        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">Base view</legend>
          {BASE_VIEWS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={baseView === value}
              // Continent mode paints whole-region fills; the imagery base
              // only applies to the country view, so the control locks
              // rather than silently doing nothing.
              disabled={mode === 'continent'}
              onClick={() => pickBaseView(value)}
              className="rounded border px-2.5 py-1 disabled:opacity-45"
              style={{
                borderColor: 'var(--border)',
                background:
                  baseView === value && mode === 'country'
                    ? 'var(--control-selected-bg)'
                    : 'transparent',
                color:
                  baseView === value && mode === 'country'
                    ? 'var(--control-selected-text)'
                    : 'inherit',
              }}
            >
              {BASE_VIEW_LABELS[value]}
            </button>
          ))}
        </fieldset>

        <label className="flex w-full items-center gap-2 sm:w-auto">
          <span style={{ color: 'var(--text-muted)' }}>Projection</span>
          <select
            value={projectionKey}
            onChange={(event) =>
              setProjectionKey(event.target.value as ProjectionKey)
            }
            className="min-w-0 flex-1 rounded border px-2 py-1 sm:flex-none"
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

        <label className="flex w-full items-center gap-2 sm:w-auto">
          <span style={{ color: 'var(--text-muted)' }}>Map colours</span>
          <select
            value={paletteDirection}
            onChange={(event) =>
              pickPalette(event.target.value as MapPaletteKey)
            }
            className="min-w-0 flex-1 rounded border px-2 py-1 sm:flex-none"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface-raised)',
              color: 'var(--text)',
            }}
          >
            {MAP_PALETTES.map((key) => (
              <option key={key} value={key}>
                {MAP_PALETTE_LABELS[key]}
              </option>
            ))}
          </select>
        </label>

        <span className="hidden text-xs sm:inline" style={{ color: 'var(--text-muted)' }}>
          {projectionKey === 'globe'
            ? 'Drag to spin the globe; scroll or pinch to zoom; twist with two fingers (or Shift+drag) to turn north.'
            : 'Scroll or pinch to zoom, drag to pan.'}{' '}
          Tab into the map, then use the arrow keys to move between countries
          and Enter to open one.
        </span>
      </div>

      {/* Search countries (§53.4), directly above the map: a result flies
          the map to the country and opens its details. */}
      {!loading && !error && (
        <div
          className="border border-b-0 px-3 py-2.5 sm:px-4"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
        >
          <CountrySearch
            entities={searchEntities}
            onPick={(iso3) => mapRef.current?.flyTo(iso3)}
          />
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
        <div
          className="map-layout grid gap-6 rounded-b-xl border border-t-0 p-2 sm:p-4 lg:grid-cols-[minmax(0,1fr)_17rem]"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
        >
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
              ref={mapRef}
              topology={topologyState.data}
              markers={
                markersState.status === 'ready' ? markersState.data.markers : []
              }
              populationByIso3={byIso3}
              projectionKey={projectionKey}
              mode={mode}
              paletteDirection={paletteDirection}
              baseView={baseView}
              renderPopover={(target) => (
                <CountryPopoverContent
                  target={target}
                  row={byIso3.get(target.iso3)}
                  gdp={
                    gdpState.status === 'ready'
                      ? (gdpState.data.entities[target.iso3] ?? undefined)
                      : undefined
                  }
                />
              )}
              renderSheet={(target, expanded) => (
                <CountrySheetContent
                  target={target}
                  row={byIso3.get(target.iso3)}
                  gdp={
                    gdpState.status === 'ready'
                      ? (gdpState.data.entities[target.iso3] ?? undefined)
                      : undefined
                  }
                  expanded={expanded}
                  readout={
                    <MapReadout
                      target={target}
                      row={byIso3.get(target.iso3)}
                      year={scrubYear ?? year}
                      revision={revision}
                      topology={topologyState.data}
                      palette={
                        paletteState.status === 'ready' ? paletteState.data : null
                      }
                    />
                  }
                />
              )}
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

          {/* On a phone the bottom sheet is the readout (§53.2). */}
          <aside className="hidden space-y-4 sm:block">
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
      </div>

      {summaryState.status === 'ready' && (
        <div className="order-5">
        <MemoEntityTable
          rows={tableRows}
          year={scrubYear ?? year}
          revision={revision}
          gdp={gdpState.status === 'ready' ? gdpState.data : null}
          note={
            scrubYear === null
              ? undefined
              : `Only population varies with the selected year. Growth rate and density are left blank rather than carried over from ${year}, which would pair a ${year} rate with a ${scrubYear} population.`
          }
        />
        </div>
      )}
    </div>
    </div>
  )
}
