import { useEffect, useRef, useState } from 'react'

import {
  interpolatePopulation,
  type InterpolatedPopulation,
} from '../lib/interpolate'
import { formatExact } from '../lib/format'
import { MethodInfoLink } from './MethodInfoLink'

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

  // `series` fed the on-page components breakdown that now lives on the
  // Methodology page in prose; the prop is kept so callers need not change.
  void series
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

      {/* Round-2 §36.4: the method paragraphs moved to /methodology; the
          figure keeps a compact, honest label and the ⓘ. The sr-only
          description above still states the modelled nature in words. */}
      <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        UN WPP {revision} ·{' '}
        {interpolated.isProjection ? 'projected' : 'modelled estimate'}{' '}
        <MethodInfoLink
          anchor="live-population"
          label="How the live counter is computed"
        />
      </p>
    </div>
  )
}
