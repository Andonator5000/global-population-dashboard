import { CONTINENTS } from '../config'
import {
  NOT_AVAILABLE,
  formatExact,
  formatGrowthRate,
  formatPopulation,
  growthDirection,
} from '../lib/format'
import type { PopulationRow } from '../types'
import type { HoverTarget } from './WorldMap'

interface MapReadoutProps {
  target: HoverTarget | null
  row: PopulationRow | undefined
  year: number
  revision: number
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
 */
export function MapReadout({ target, row, year, revision }: MapReadoutProps) {
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
        background: 'var(--surface-raised)',
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
