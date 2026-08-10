import { useEffect, useRef, useState } from 'react'

import {
  anchorYearFor,
  componentRates,
  interpolatePopulation,
  type ComponentRates,
  type InterpolatedPopulation,
} from '../lib/interpolate'
import { formatExact } from '../lib/format'

const TICK_MS = 100

/**
 * The "live" population counter.
 *
 * Reads as a running count, and is labelled everywhere as a modelled estimate,
 * because that is what it is. See src/lib/interpolate.ts for why it anchors on
 * the published annual figures rather than ticking on birth and death rates.
 *
 * Respects prefers-reduced-motion by holding a static figure: a digit changing
 * ten times a second is exactly the kind of motion that setting exists to
 * suppress.
 */
export function LiveCounter({
  years,
  values,
  series,
  estimatesThrough,
  revision,
  label,
}: {
  years: number[]
  values: (number | null)[]
  series?: Record<string, (number | null)[]>
  estimatesThrough: number
  revision: number
  label: string
}) {
  const [now, setNow] = useState(() => Date.now())
  const reducedMotion = useRef(false)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion.current = query.matches
    if (query.matches) return

    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  const interpolated: InterpolatedPopulation | null = interpolatePopulation(
    years,
    values,
    now,
    estimatesThrough,
  )

  if (!interpolated) {
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        No population figure available for the present date.
      </p>
    )
  }

  const anchorYear = anchorYearFor(now, years)
  const rates: ComponentRates | null =
    series && anchorYear !== null
      ? componentRates(years, series, anchorYear)
      : null

  const perDay = interpolated.perSecond * 86400

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span
          className="text-4xl font-semibold tracking-tight"
          // aria-live would re-announce ten times a second, which is unusable
          // with a screen reader. The static figure and its date are announced
          // through the description below instead.
          aria-hidden="true"
        >
          {formatExact(interpolated.value)}
        </span>
        <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
          {interpolated.perSecond >= 0 ? '+' : '−'}
          {Math.abs(interpolated.perSecond).toFixed(2)} per second
        </span>
      </div>

      <p className="sr-only">
        {label}: approximately {formatExact(interpolated.value)} people, a
        modelled estimate interpolated between the {interpolated.previous.year}{' '}
        and {interpolated.next.year} figures from UN World Population Prospects{' '}
        {revision}. Changing by about {Math.round(Math.abs(perDay))} people per
        day.
      </p>

      <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <strong style={{ fontWeight: 500 }}>
          Modelled estimate, interpolated from UN WPP {revision}
          {interpolated.isProjection ? ' medium-variant projection' : ''}.
        </strong>{' '}
        No source publishes live population. This figure is interpolated
        between the published {interpolated.previous.year} and{' '}
        {interpolated.next.year} annual figures (each dated 1 July) and advanced
        continuously at the rate those two imply
        {interpolated.isProjection && (
          <>
            {' '}
            — and because UN WPP {revision} carries estimates only through{' '}
            {estimatesThrough}, <strong>both ends of that interpolation are
            projections, not measurements</strong>
          </>
        )}
        .
      </p>

      {rates && rates.birthsPerSecond !== null && rates.deathsPerSecond !== null && (
        <details className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          <summary className="cursor-pointer underline underline-offset-2">
            How this number moves
          </summary>
          <div className="mt-2 space-y-1">
            <p>
              For {rates.year}, UN WPP publishes these annual totals, shown here
              per second:
            </p>
            <ul className="ml-4 list-disc">
              <li>
                births {rates.birthsPerSecond.toFixed(2)}/s
              </li>
              <li>
                deaths {rates.deathsPerSecond.toFixed(2)}/s
              </li>
              {rates.netMigrationPerSecond !== null && (
                <li>
                  net migration{' '}
                  {rates.netMigrationPerSecond >= 0 ? '+' : '−'}
                  {Math.abs(rates.netMigrationPerSecond).toFixed(2)}/s
                </li>
              )}
            </ul>
            <p>
              Those components imply{' '}
              {rates.componentNetPerSecond !== null
                ? `${rates.componentNetPerSecond >= 0 ? '+' : '−'}${Math.abs(rates.componentNetPerSecond).toFixed(2)}/s`
                : 'an unknown rate'}
              , while the two annual figures imply{' '}
              {interpolated.perSecond >= 0 ? '+' : '−'}
              {Math.abs(interpolated.perSecond).toFixed(2)}/s. They differ
              because population is a 1 July snapshot whereas births and deaths
              are calendar-year totals. <strong>The counter follows the annual
              figures</strong>, so it stays consistent with the published series
              rather than drifting away from it.
            </p>
          </div>
        </details>
      )}
    </div>
  )
}
