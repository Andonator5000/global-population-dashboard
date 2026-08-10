/**
 * The interpolation model behind the "live" counter.
 *
 * NOTHING HERE IS A MEASUREMENT
 * -----------------------------
 * No authoritative source publishes live population. UN WPP publishes one
 * figure per year, dated 1 July. This module interpolates between the two
 * nearest annual points and advances the number continuously so it reads as a
 * running count. Every figure it produces is a MODELLED ESTIMATE, and the UI
 * that renders it is required to say so.
 *
 * WHY WE ANCHOR ON THE ANNUAL POINTS RATHER THAN TICK ON THE COMPONENTS
 * ---------------------------------------------------------------------
 * The obvious approach is to take the 1 July figure and add
 * (births - deaths + net migration) per second. It does not work: those
 * components do NOT reconcile with the year-on-year change in the published
 * series. Measured across large countries the median gap is ~1.4% of the
 * annual change, and Germany 2023 is off by a factor of 70 (published net
 * change 4,011; components imply 294,662). The reason is that population is a
 * 1 July snapshot while births and deaths are calendar-year totals, so the two
 * are measured over different intervals.
 *
 * Ticking on the components would therefore drift steadily away from the next
 * published anchor and quietly contradict the UN's own figure. Instead we
 * interpolate BETWEEN anchors, which is exact at both ends by construction,
 * and derive the per-second rate from that same interpolation. The component
 * flows are still shown — they are the demographic explanation of the
 * movement — but they are labelled as annual totals, not as the thing driving
 * the counter.
 *
 * ESTIMATE vs PROJECTION
 * ----------------------
 * WPP 2024 carries estimates only through 2023. Every later year, including
 * today, is the medium-variant PROJECTION. A counter running now is
 * interpolating inside a projection, not extrapolating from a measurement, and
 * `isProjection` exists so the UI can never imply otherwise.
 */

/** WPP population figures are dated 1 July. */
const ANCHOR_MONTH = 6 // July, zero-indexed
const ANCHOR_DAY = 1

export interface InterpolationAnchor {
  year: number
  value: number
}

export interface InterpolatedPopulation {
  /** The modelled figure at `at`. Never a measurement. */
  value: number
  /** Net persons per second implied by the two anchors. */
  perSecond: number
  previous: InterpolationAnchor
  next: InterpolationAnchor
  /** True when the surrounding anchors are projections, not estimates. */
  isProjection: boolean
  /** Fraction travelled between the anchors, 0–1. */
  fraction: number
}

/** UTC timestamp of 1 July in `year`. */
export function anchorTime(year: number): number {
  return Date.UTC(year, ANCHOR_MONTH, ANCHOR_DAY)
}

/**
 * Interpolate a population series at an instant.
 *
 * Returns null when `at` falls outside the series — we do not extrapolate past
 * the published range. WPP stops at 2100 and so do we.
 */
export function interpolatePopulation(
  years: number[],
  values: (number | null)[],
  at: number,
  estimatesThrough: number,
): InterpolatedPopulation | null {
  const points: InterpolationAnchor[] = []
  for (let i = 0; i < years.length; i += 1) {
    const value = values[i]
    const year = years[i]
    if (value !== null && value !== undefined && year !== undefined) {
      points.push({ year, value })
    }
  }
  if (points.length < 2) return null

  const first = points[0]!
  const last = points[points.length - 1]!
  if (at < anchorTime(first.year) || at > anchorTime(last.year)) return null

  let previous = first
  let next = points[1]!
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!
    const b = points[i + 1]!
    if (at >= anchorTime(a.year) && at <= anchorTime(b.year)) {
      previous = a
      next = b
      break
    }
  }

  const start = anchorTime(previous.year)
  const end = anchorTime(next.year)
  const span = end - start
  if (span <= 0) return null

  const fraction = (at - start) / span
  const value = previous.value + (next.value - previous.value) * fraction
  const perSecond = (next.value - previous.value) / (span / 1000)

  return {
    value,
    perSecond,
    previous,
    next,
    // If the earlier anchor is already past the estimate cut-off, both ends of
    // the interpolation are modelled.
    isProjection: previous.year > estimatesThrough,
    fraction,
  }
}

/** Component flows for the year containing `at`, as persons per second. */
export interface ComponentRates {
  year: number
  birthsPerSecond: number | null
  deathsPerSecond: number | null
  netMigrationPerSecond: number | null
  /**
   * Net implied by the components. Deliberately exposed alongside the anchor
   * rate so the UI can show that the two differ rather than pretending they
   * agree.
   */
  componentNetPerSecond: number | null
}

const SECONDS_PER_YEAR = 365.2425 * 24 * 60 * 60

export function componentRates(
  years: number[],
  series: Record<string, (number | null)[]>,
  year: number,
): ComponentRates | null {
  const index = years.indexOf(year)
  if (index < 0) return null

  const per = (key: string): number | null => {
    const value = series[key]?.[index]
    return value === null || value === undefined ? null : value / SECONDS_PER_YEAR
  }

  const births = per('births')
  const deaths = per('deaths')
  const migration = per('netMigration')
  const net =
    births !== null && deaths !== null
      ? births - deaths + (migration ?? 0)
      : null

  return {
    year,
    birthsPerSecond: births,
    deathsPerSecond: deaths,
    netMigrationPerSecond: migration,
    componentNetPerSecond: net,
  }
}

/** The WPP year whose 1 July anchor most recently preceded `at`. */
export function anchorYearFor(at: number, years: number[]): number | null {
  let best: number | null = null
  for (const year of years) {
    if (anchorTime(year) <= at) best = year
    else break
  }
  return best
}
