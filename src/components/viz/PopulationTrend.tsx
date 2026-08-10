import { area, line } from 'd3-shape'
import { scaleLinear } from 'd3-scale'
import { useMemo } from 'react'

import { formatPopulation } from '../../lib/format'
import type { CountrySeries } from '../../types'

const WIDTH = 720
const HEIGHT = 260
const MARGIN = { top: 12, right: 12, bottom: 26, left: 56 }

/**
 * Population 1950-2100: estimates, then the medium projection with a low/high
 * band.
 *
 * ONE axis. The estimate and projection segments are the SAME series on the
 * same scale -- they are distinguished by a visible boundary rule and by the
 * band appearing only after it, never by a second y-scale.
 *
 * The estimate/projection boundary is drawn explicitly because the difference
 * matters more than any styling nicety: everything left of it is measured,
 * everything right is modelled.
 */
export function PopulationTrend({ series }: { series: CountrySeries }) {
  const geometry = useMemo(() => {
    const years = series.years
    const values = series.series.population ?? []
    const points = years
      .map((year, index) => ({ year, value: values[index] ?? null }))
      .filter((p): p is { year: number; value: number } => p.value !== null)

    const first = points[0]
    const last = points[points.length - 1]
    if (!first || !last) return null

    const band = series.bands
    const bandPoints = band
      ? band.years
          .map((year, index) => ({
            year,
            low: band.low[index],
            high: band.high[index],
          }))
          .filter(
            (p): p is { year: number; low: number; high: number } =>
              p.low !== null && p.high !== null,
          )
      : []

    const maxValue = Math.max(
      ...points.map((p) => p.value),
      ...bandPoints.map((p) => p.high),
    )

    const x = scaleLinear()
      .domain([years[0] ?? 1950, years[years.length - 1] ?? 2100])
      .range([MARGIN.left, WIDTH - MARGIN.right])
    const y = scaleLinear()
      .domain([0, maxValue * 1.05])
      .range([HEIGHT - MARGIN.bottom, MARGIN.top])
      .nice()

    const estimates = points.filter((p) => p.year <= series.estimatesThrough)
    const projection = points.filter((p) => p.year >= series.estimatesThrough)

    const lineOf = line<{ year: number; value: number }>()
      .x((d) => x(d.year))
      .y((d) => y(d.value))

    const bandPath = area<{ year: number; low: number; high: number }>()
      .x((d) => x(d.year))
      .y0((d) => y(d.low))
      .y1((d) => y(d.high))

    return {
      x,
      y,
      estimatePath: lineOf(estimates) ?? '',
      projectionPath: lineOf(projection) ?? '',
      bandPath: bandPoints.length ? (bandPath(bandPoints) ?? '') : '',
      boundaryX: x(series.estimatesThrough),
      ticksX: x.ticks(6),
      ticksY: y.ticks(5),
      last,
      peak: points.reduce((a, b) => (b.value > a.value ? b : a), first),
    }
  }, [series])

  if (!geometry) {
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        No population series available for this entity.
      </p>
    )
  }

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={
          `Population from ${series.years[0]} to ${series.years[series.years.length - 1]}. ` +
          `Estimates through ${series.estimatesThrough}, then the medium projection ` +
          `with a low-to-high variant band. Peaks at ${formatPopulation(geometry.peak.value)} ` +
          `in ${geometry.peak.year}.`
        }
      >
        {geometry.ticksY.map((tick) => (
          <g key={tick}>
            {/* Solid hairline grid, one shade off the surface. Never dashed. */}
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={geometry.y(tick)}
              y2={geometry.y(tick)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={MARGIN.left - 8}
              y={geometry.y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              style={{ fill: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}
            >
              {formatPopulation(tick)}
            </text>
          </g>
        ))}

        {geometry.ticksX.map((tick) => (
          <text
            key={tick}
            x={geometry.x(tick)}
            y={HEIGHT - 8}
            textAnchor="middle"
            fontSize={11}
            style={{ fill: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}
          >
            {tick}
          </text>
        ))}

        {geometry.bandPath && (
          <path
            d={geometry.bandPath}
            fill="var(--series-1)"
            opacity={0.16}
          />
        )}

        <path
          d={geometry.estimatePath}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        <path
          d={geometry.projectionPath}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth={2}
          strokeDasharray="5 4"
          strokeLinejoin="round"
        />

        <line
          x1={geometry.boundaryX}
          x2={geometry.boundaryX}
          y1={MARGIN.top}
          y2={HEIGHT - MARGIN.bottom}
          stroke="var(--text-muted)"
          strokeWidth={1}
        />
        <text
          x={geometry.boundaryX + 4}
          y={MARGIN.top + 10}
          fontSize={10}
          style={{ fill: 'var(--text-muted)' }}
        >
          projection →
        </text>
      </svg>

      <figcaption className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
        Solid line: estimates through {series.estimatesThrough}. Dashed line:
        medium-variant projection. Shaded band: low to high variant. Source: UN
        World Population Prospects {series.revision}.
      </figcaption>
    </figure>
  )
}
