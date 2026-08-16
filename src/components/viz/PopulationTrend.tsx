import { area, line } from 'd3-shape'
import { scaleLinear } from 'd3-scale'
import { useMemo, useRef, useState } from 'react'

import { formatExact, formatPopulation } from '../../lib/format'
import type { CountrySeries } from '../../types'

const WIDTH = 720
const HEIGHT = 260
const MARGIN = { top: 12, right: 12, bottom: 26, left: 56 }

interface HoverPoint {
  year: number
  value: number
  low: number | null
  high: number | null
  isProjection: boolean
}

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
 *
 * INTERACTION: pointer events, not mouse events, so hovering with a mouse and
 * dragging a finger are the same code path. The readout snaps to the nearest
 * year. `touch-action: pan-y` keeps vertical page scrolling alive on phones --
 * only horizontal movement is captured for scrubbing. The readout is a visual
 * convenience and is aria-hidden; the chart's aria-label and the figures
 * elsewhere on the page remain the accessible surface.
 */
export function PopulationTrend({ series }: { series: CountrySeries }) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hover, setHover] = useState<HoverPoint | null>(null)

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
    const bandByYear = new Map(bandPoints.map((p) => [p.year, p]))

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
      points,
      bandByYear,
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

  /** Snap a pointer event to the nearest year that has a value. */
  function readoutAt(event: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current
    const g = geometry
    if (!svg || !g) return
    const rect = svg.getBoundingClientRect()
    // Client px -> viewBox units. The SVG scales responsively, so the ratio
    // matters; the y coordinate is not needed because the readout snaps to
    // the series.
    const xView = ((event.clientX - rect.left) / rect.width) * WIDTH
    const targetYear = g.x.invert(xView)
    let nearest = g.points[0]
    if (!nearest) return
    for (const p of g.points) {
      if (Math.abs(p.year - targetYear) < Math.abs(nearest.year - targetYear)) {
        nearest = p
      }
    }
    const band = g.bandByYear.get(nearest.year)
    setHover({
      year: nearest.year,
      value: nearest.value,
      low: band?.low ?? null,
      high: band?.high ?? null,
      isProjection: nearest.year > series.estimatesThrough,
    })
  }

  // Tooltip box geometry, flipped to the left near the right edge so it
  // never leaves the chart.
  const tooltip = hover
    ? (() => {
        const boxWidth = 168
        const boxHeight = hover.low !== null ? 62 : 46
        const px = geometry.x(hover.year)
        const py = geometry.y(hover.value)
        const boxX =
          px + 12 + boxWidth > WIDTH - MARGIN.right ? px - 12 - boxWidth : px + 12
        const boxY = Math.max(
          MARGIN.top,
          Math.min(py - boxHeight / 2, HEIGHT - MARGIN.bottom - boxHeight),
        )
        return { px, py, boxX, boxY, boxWidth, boxHeight }
      })()
    : null

  return (
    <figure className="m-0">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        style={{ touchAction: 'pan-y' }}
        role="img"
        aria-label={
          `Population from ${series.years[0]} to ${series.years[series.years.length - 1]}. ` +
          `Estimates through ${series.estimatesThrough}, then the medium projection ` +
          `with a low-to-high variant band. Peaks at ${formatPopulation(geometry.peak.value)} ` +
          `in ${geometry.peak.year}.`
        }
        onPointerMove={readoutAt}
        onPointerDown={readoutAt}
        onPointerLeave={() => setHover(null)}
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

        {hover && tooltip && (
          <g aria-hidden="true" pointerEvents="none">
            <line
              x1={tooltip.px}
              x2={tooltip.px}
              y1={MARGIN.top}
              y2={HEIGHT - MARGIN.bottom}
              stroke="var(--text-muted)"
              strokeWidth={1}
              opacity={0.5}
            />
            <circle
              cx={tooltip.px}
              cy={tooltip.py}
              r={4}
              fill="var(--series-1)"
              stroke="var(--surface-raised)"
              strokeWidth={1.5}
            />
            <rect
              x={tooltip.boxX}
              y={tooltip.boxY}
              width={tooltip.boxWidth}
              height={tooltip.boxHeight}
              rx={6}
              fill="var(--surface-raised)"
              stroke="var(--border)"
            />
            <text
              x={tooltip.boxX + 10}
              y={tooltip.boxY + 17}
              fontSize={11}
              style={{ fill: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}
            >
              {hover.year}
              {hover.isProjection ? ' · projected' : ''}
            </text>
            <text
              x={tooltip.boxX + 10}
              y={tooltip.boxY + 34}
              fontSize={13}
              fontWeight={600}
              style={{ fill: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}
            >
              {formatExact(hover.value)}
            </text>
            {hover.low !== null && hover.high !== null && (
              <text
                x={tooltip.boxX + 10}
                y={tooltip.boxY + 51}
                fontSize={10}
                style={{ fill: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}
              >
                {formatPopulation(hover.low)} – {formatPopulation(hover.high)}{' '}
                (low–high)
              </text>
            )}
          </g>
        )}
      </svg>

      <figcaption className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
        Solid line: estimates through {series.estimatesThrough}. Dashed line:
        medium-variant projection. Shaded band: low to high variant. Hover or
        touch the chart to read a specific year. Source: UN World Population
        Prospects {series.revision}.
      </figcaption>
    </figure>
  )
}
