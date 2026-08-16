import { geoPath, type GeoPermissibleObjects } from 'd3-geo'
import { useMemo } from 'react'
import { feature } from 'topojson-client'

import { CONTINENTS } from '../config'
import {
  NOT_AVAILABLE,
  formatExact,
  formatGrowthRate,
  formatPopulation,
  growthDirection,
} from '../lib/format'
import { createProjection } from '../lib/projection'
import type {
  CountryTopology,
  MapPalette,
  PopulationRow,
} from '../types'
import type { HoverTarget } from './WorldMap'

const THUMB_WIDTH = 200
const THUMB_HEIGHT = 110

interface MapReadoutProps {
  target: HoverTarget | null
  row: PopulationRow | undefined
  year: number
  revision: number
  /** For the country-shape thumbnail; null while still loading. */
  topology?: CountryTopology | null
  /** For the flag-hue background tint; null while still loading. */
  palette?: MapPalette | null
}

/**
 * The map's hover/focus readout.
 *
 * Rendered as a fixed panel beside the map rather than a floating tooltip, for
 * two reasons: a pointer-following tooltip is unreachable by keyboard users
 * (who get the same content on focus, in the same place), and a panel that
 * holds its position does not shift the layout as the pointer moves.
 *
 * Values lead, labels follow -- the reader already knows which country they are
 * pointing at and wants the number.
 *
 * The panel also draws the hovered country's own shape (equal-area, fitted to
 * a thumbnail) and tints its background with a light shade of the country's
 * flag hue -- same lightness/chroma band as the contrast-gated --page-tint.
 */
export function MapReadout({
  target,
  row,
  year,
  revision,
  topology,
  palette,
}: MapReadoutProps) {
  const thumb = useMemo(() => {
    if (!target || target.isMarker || !topology) return null
    const collection = feature(
      topology as never,
      topology.objects.countries as never,
    ) as unknown as {
      features: { properties: { iso3: string }; geometry: unknown }[]
    }
    const item = collection.features.find(
      (f) => f.properties.iso3 === target.iso3,
    )
    if (!item) return null
    const projection = createProjection('equalEarth').fitExtent(
      [
        [4, 4],
        [THUMB_WIDTH - 4, THUMB_HEIGHT - 4],
      ],
      item as unknown as GeoPermissibleObjects,
    )
    return geoPath(projection)(item as unknown as GeoPermissibleObjects)
  }, [target, topology])

  const flagHue = target ? (palette?.entities[target.iso3]?.flagHue ?? null) : null
  const tint =
    flagHue !== null
      ? `light-dark(oklch(96.5% 0.03 ${flagHue}), oklch(20% 0.02 ${flagHue}))`
      : 'var(--surface-raised)'

  if (!target) {
    return (
      <div
        className="rounded-lg border px-4 py-3 text-sm"
        style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
      >
        Hover or focus a country for its population and growth rate.
      </div>
    )
  }

  const direction = growthDirection(row?.growthRate)

  return (
    <div
      className="rounded-lg border px-4 py-3"
      style={{
        borderColor: 'var(--border)',
        background: tint,
      }}
      aria-live="polite"
    >
      <div className="flex items-baseline justify-between gap-3">
        {/* h2, not h3: this sits at section level beside the map, and jumping
            h1 -> h3 breaks heading-based screen reader navigation. */}
        <h2 className="font-medium">{target.name}</h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {CONTINENTS[target.continent]}
        </span>
      </div>

      {thumb && (
        <svg
          viewBox={`0 0 ${THUMB_WIDTH} ${THUMB_HEIGHT}`}
          className="mt-2 h-auto w-full"
          aria-hidden="true"
        >
          <path
            d={thumb}
            fill="var(--map-accent-fill)"
            fillOpacity={0.35}
            stroke="var(--text-muted)"
            strokeWidth={1}
            strokeLinejoin="round"
          />
        </svg>
      )}

      {target.contested && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Contested or special status — see the country page.
        </p>
      )}

      {target.isMarker && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Shown as a marker: too small to draw at this scale. Its size on the
          map is not to scale.
        </p>
      )}

      {row?.available ? (
        <dl className="mt-3 space-y-2">
          <div>
            <dd className="text-2xl font-semibold tracking-tight">
              {formatPopulation(row.population)}
            </dd>
            <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
              population, {year} · {formatExact(row.population)}
            </dt>
          </div>
          <div>
            <dd className="text-sm">
              {formatGrowthRate(row.growthRate)}
              {direction !== 'unknown' && (
                <span style={{ color: 'var(--text-muted)' }}> ({direction})</span>
              )}
            </dd>
            <dt className="text-xs" style={{ color: 'var(--text-muted)' }}>
              growth rate
            </dt>
          </div>
        </dl>
      ) : (
        <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
          Population {NOT_AVAILABLE} —{' '}
          {row?.unavailableReason ??
            `UN World Population Prospects ${revision} publishes no separate series for this entity.`}
        </p>
      )}

      <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        Source: UN World Population Prospects {revision}, medium variant,{' '}
        {year} estimate.
      </p>
    </div>
  )
}
