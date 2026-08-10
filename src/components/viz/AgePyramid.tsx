import { useMemo, useState } from 'react'

import { formatExact, formatPopulation } from '../../lib/format'
import type { CountryPyramid } from '../../types'

const ROW_HEIGHT = 11
const GAP = 2
const CENTRE_GUTTER = 46

/**
 * Age and sex pyramid.
 *
 * A diverging horizontal bar chart, mirrored about a centre gutter that
 * carries the age-group labels. Male and female are two categories, not a
 * ramp, so they take two categorical slots.
 *
 * Bars are drawn as shares of total population rather than absolute counts, so
 * the shape is comparable across a country's own history and across countries
 * of wildly different size.
 */
export function AgePyramid({
  pyramid,
  defaultYear,
}: {
  pyramid: CountryPyramid
  defaultYear: number
}) {
  const years = pyramid.years
  // Frames exist every fifth year, so the requested year is usually absent.
  // Fall back to the NEAREST year rather than the last one -- defaulting a
  // "current population" pyramid to the 2100 projection would be badly
  // misleading.
  const initial =
    years.length === 0
      ? 0
      : (years.includes(defaultYear)
          ? defaultYear
          : years.reduce((best, candidate) =>
              Math.abs(candidate - defaultYear) < Math.abs(best - defaultYear)
                ? candidate
                : best,
            ))
  const [year, setYear] = useState(initial)

  const frame = pyramid.frames[String(year)]

  const geometry = useMemo(() => {
    if (!frame) return null
    const male = frame.male.map((v) => v ?? 0)
    const female = frame.female.map((v) => v ?? 0)
    const total = male.reduce((a, b) => a + b, 0) + female.reduce((a, b) => a + b, 0)
    if (total === 0) return null
    const maxShare = Math.max(
      ...male.map((v) => v / total),
      ...female.map((v) => v / total),
    )
    return { male, female, total, maxShare }
  }, [frame])

  if (!frame || !geometry) {
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        No age structure available for this entity.
      </p>
    )
  }

  const rows = pyramid.ageGroups.length
  const height = rows * (ROW_HEIGHT + GAP)
  const halfWidth = 260
  const width = halfWidth * 2 + CENTRE_GUTTER
  const scale = (share: number) =>
    geometry.maxShare > 0 ? (share / geometry.maxShare) * halfWidth : 0

  return (
    <figure className="m-0">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
          <span className="sr-only">Year for the age pyramid</span>
          <select
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
            className="rounded border px-1.5 py-0.5"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface-raised)',
              color: 'var(--text)',
            }}
          >
            {years.map((option) => (
              <option key={option} value={option}>
                {option}
                {option > 2023 ? ' (projected)' : ''}
              </option>
            ))}
          </select>
        </label>
        <span className="flex items-center gap-1.5 text-xs">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: 'var(--series-1)' }}
            aria-hidden="true"
          />
          Male
          <span
            className="ml-3 inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: 'var(--series-2)' }}
            aria-hidden="true"
          />
          Female
        </span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-2 h-auto w-full"
        role="img"
        aria-label={
          `Population by five-year age group and sex, ${year}. ` +
          `Total ${formatPopulation(geometry.total)}.`
        }
      >
        {pyramid.ageGroups.map((group, index) => {
          const y = index * (ROW_HEIGHT + GAP)
          const maleCount = geometry.male[index] ?? 0
          const femaleCount = geometry.female[index] ?? 0
          const maleShare = maleCount / geometry.total
          const femaleShare = femaleCount / geometry.total
          const maleWidth = scale(maleShare)
          const femaleWidth = scale(femaleShare)
          return (
            <g key={group}>
              <rect
                x={halfWidth - maleWidth}
                y={y}
                width={maleWidth}
                height={ROW_HEIGHT}
                rx={2}
                fill="var(--series-1)"
              >
                <title>
                  {`Male, age ${group}, ${year}: ${formatExact(maleCount)} (${(maleShare * 100).toFixed(2)}%)`}
                </title>
              </rect>
              <rect
                x={halfWidth + CENTRE_GUTTER}
                y={y}
                width={femaleWidth}
                height={ROW_HEIGHT}
                rx={2}
                fill="var(--series-2)"
              >
                <title>
                  {`Female, age ${group}, ${year}: ${formatExact(femaleCount)} (${(femaleShare * 100).toFixed(2)}%)`}
                </title>
              </rect>
              <text
                x={halfWidth + CENTRE_GUTTER / 2}
                y={y + ROW_HEIGHT / 2}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={9}
                style={{
                  fill: 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {group}
              </text>
            </g>
          )
        })}
      </svg>

      <figcaption className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
        Bars are each group's share of the total population, so the shape stays
        comparable across years. Total {formatPopulation(geometry.total)} in{' '}
        {year}
        {year > 2023 ? ' (medium-variant projection)' : ''}. Source: UN World
        Population Prospects {pyramid.revision}.
      </figcaption>
    </figure>
  )
}
