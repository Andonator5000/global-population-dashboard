import { geoPath, type GeoPermissibleObjects } from 'd3-geo'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type D3ZoomEvent } from 'd3-zoom'
import { useEffect, useMemo, useRef, useState } from 'react'
import { feature } from 'topojson-client'

import { CONTINENTS, type ContinentKey, type ProjectionKey } from '../config'
import { createProjection, fitProjection } from '../lib/projection'
import type {
  CountryGeometryProperties,
  CountryTopology,
  MapMarker,
  PopulationRow,
} from '../types'

const VIEW_WIDTH = 1000
const VIEW_HEIGHT = 480

/**
 * Marker radius for entities with no polygon at 110m. The visible dot is small
 * so it does not imply an area it does not have; the transparent hit ring is
 * 12px (24px target) so it is actually clickable and touch-reachable.
 */
const MARKER_RADIUS = 3
const MARKER_HIT_RADIUS = 12

export interface HoverTarget {
  iso3: string
  name: string
  continent: ContinentKey
  contested: boolean
  isMarker: boolean
}

interface WorldMapProps {
  topology: CountryTopology
  markers: MapMarker[]
  populationByIso3: Map<string, PopulationRow>
  projectionKey: ProjectionKey
  /** 'country' outlines each entity; 'continent' groups them. */
  mode: 'country' | 'continent'
  hovered: HoverTarget | null
  onHover: (target: HoverTarget | null) => void
  onSelect: (target: HoverTarget) => void
  /** Continent highlighted in continent mode; null means none. */
  activeContinent: ContinentKey | null
  onActiveContinentChange: (continent: ContinentKey | null) => void
}

interface CountryShape {
  iso3: string
  name: string
  continent: ContinentKey
  contested: boolean
  d: string
  centroid: [number, number]
}

export function WorldMap({
  topology,
  markers,
  populationByIso3,
  projectionKey,
  mode,
  hovered,
  onHover,
  onSelect,
  activeContinent,
  onActiveContinentChange,
}: WorldMapProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [transform, setTransform] = useState(() => zoomIdentity)

  const { shapes, sphere, markerPoints } = useMemo(() => {
    const projection = fitProjection(
      createProjection(projectionKey),
      VIEW_WIDTH,
      VIEW_HEIGHT,
    )
    const path = geoPath(projection)

    const collection = feature(
      topology as never,
      topology.objects.countries as never,
    ) as unknown as {
      features: {
        properties: CountryGeometryProperties
        geometry: unknown
      }[]
    }

    const built: CountryShape[] = []
    for (const item of collection.features) {
      const d = path(item as unknown as GeoPermissibleObjects)
      if (!d) continue
      const centroid = path.centroid(item as unknown as GeoPermissibleObjects)
      built.push({
        iso3: item.properties.iso3,
        name: item.properties.name,
        continent: item.properties.continent,
        contested: item.properties.contested,
        d,
        centroid: [centroid[0], centroid[1]],
      })
    }

    const points = markers
      .map((marker) => {
        const xy = projection(marker.coordinates)
        return xy ? { marker, x: xy[0], y: xy[1] } : null
      })
      .filter((v): v is { marker: MapMarker; x: number; y: number } => v !== null)

    return {
      shapes: built,
      sphere: path({ type: 'Sphere' }) ?? '',
      markerPoints: points,
    }
  }, [topology, markers, projectionKey])

  // Zoom and pan. d3-zoom owns the gesture; React owns the rendered transform.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 12])
      .translateExtent([
        [0, 0],
        [VIEW_WIDTH, VIEW_HEIGHT],
      ])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        setTransform(event.transform)
      })
    const selection = select(svg)
    selection.call(behaviour)
    // The SVG is keyboard-navigable through its child paths; d3-zoom's own
    // dblclick handler would otherwise swallow a double activation.
    selection.on('dblclick.zoom', null)
    return () => {
      selection.on('.zoom', null)
    }
  }, [])

  const strokeWidth = 0.5 / transform.k
  const isDimmed = (continent: ContinentKey) =>
    mode === 'continent' && activeContinent !== null && continent !== activeContinent

  /**
   * Country fill.
   *
   * `--fill-<ISO3>` comes from src/generated/flag-fills.css: the flag's hue at
   * a graph-coloured lightness tier. Reading it as a CSS variable rather than
   * an inline colour means the light/dark swap costs no re-render and cannot
   * flash the wrong palette on first paint.
   *
   * Continent mode deliberately drops the flag fills and returns to neutral
   * land: showing 250 flag hues while trying to read seven continental blocks
   * is two encodings fighting for the same channel.
   */
  function fillFor(shape: CountryShape): string {
    const row = populationByIso3.get(shape.iso3)
    if (!row?.available) return 'var(--map-no-data)'
    if (hovered?.iso3 === shape.iso3) return 'var(--map-accent-fill)'
    if (mode === 'continent') {
      return activeContinent === shape.continent
        ? 'var(--map-accent-fill)'
        : 'var(--map-land)'
    }
    return `var(--fill-${shape.iso3}, var(--map-land))`
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      className="h-auto w-full touch-none"
      role="group"
      aria-label={
        mode === 'country'
          ? 'World map, equal-area projection. Each country is focusable; press Enter to open its page.'
          : 'World map, equal-area projection, grouped by continent.'
      }
      style={{ background: 'var(--map-water)' }}
      onPointerLeave={() => onHover(null)}
    >
      <defs>
        {/* Hatch marks contested entities so their status is never carried by
            colour alone -- required for CVD readers and forced-colors mode. */}
        <pattern
          id="contested-hatch"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="6" height="6" fill="transparent" />
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="6"
            stroke="var(--map-land-stroke)"
            strokeWidth="1.6"
            opacity="0.75"
          />
        </pattern>
      </defs>

      <path d={sphere} fill="var(--map-water)" />

      <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
        {shapes.map((shape) => {
          const row = populationByIso3.get(shape.iso3)
          const dimmed = isDimmed(shape.continent)
          return (
            <path
              key={`${shape.iso3}-${shape.d.length}`}
              d={shape.d}
              fill={fillFor(shape)}
              stroke="var(--map-land-stroke)"
              strokeWidth={strokeWidth}
              strokeLinejoin="round"
              opacity={dimmed ? 0.45 : 1}
              tabIndex={0}
              role="link"
              aria-label={
                row?.available
                  ? `${shape.name}. Open country page.`
                  : `${shape.name}. No population data available. Open country page.`
              }
              className="map-target"
              onPointerEnter={() =>
                onHover({
                  iso3: shape.iso3,
                  name: shape.name,
                  continent: shape.continent,
                  contested: shape.contested,
                  isMarker: false,
                })
              }
              onFocus={() => {
                onHover({
                  iso3: shape.iso3,
                  name: shape.name,
                  continent: shape.continent,
                  contested: shape.contested,
                  isMarker: false,
                })
                if (mode === 'continent') onActiveContinentChange(shape.continent)
              }}
              onBlur={() => onHover(null)}
              onClick={() =>
                onSelect({
                  iso3: shape.iso3,
                  name: shape.name,
                  continent: shape.continent,
                  contested: shape.contested,
                  isMarker: false,
                })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect({
                    iso3: shape.iso3,
                    name: shape.name,
                    continent: shape.continent,
                    contested: shape.contested,
                    isMarker: false,
                  })
                }
              }}
            />
          )
        })}

        {/* Contested overlay, drawn above fills and inert to pointer events so
            it never steals the hit target from the country beneath it. */}
        {shapes
          .filter((shape) => shape.contested)
          .map((shape) => (
            <path
              key={`hatch-${shape.iso3}-${shape.d.length}`}
              d={shape.d}
              fill="url(#contested-hatch)"
              stroke="none"
              pointerEvents="none"
              opacity={isDimmed(shape.continent) ? 0.4 : 1}
            />
          ))}

        {markerPoints.map(({ marker, x, y }) => {
          const focused = hovered?.iso3 === marker.iso3
          return (
            <g
              key={marker.iso3}
              transform={`translate(${x},${y})`}
              tabIndex={0}
              role="link"
              aria-label={`${marker.name}. Too small to draw at this scale; shown as a marker. Open country page.`}
              className="map-target"
              onPointerEnter={() =>
                onHover({
                  iso3: marker.iso3,
                  name: marker.name,
                  continent: marker.continent,
                  contested: marker.contested,
                  isMarker: true,
                })
              }
              onFocus={() =>
                onHover({
                  iso3: marker.iso3,
                  name: marker.name,
                  continent: marker.continent,
                  contested: marker.contested,
                  isMarker: true,
                })
              }
              onBlur={() => onHover(null)}
              onClick={() =>
                onSelect({
                  iso3: marker.iso3,
                  name: marker.name,
                  continent: marker.continent,
                  contested: marker.contested,
                  isMarker: true,
                })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect({
                    iso3: marker.iso3,
                    name: marker.name,
                    continent: marker.continent,
                    contested: marker.contested,
                    isMarker: true,
                  })
                }
              }}
            >
              <circle
                r={MARKER_HIT_RADIUS / transform.k}
                fill="transparent"
                stroke="none"
              />
              <circle
                r={(focused ? MARKER_RADIUS + 1.5 : MARKER_RADIUS) / transform.k}
                fill={focused ? 'var(--map-accent-fill)' : 'var(--map-land)'}
                stroke="var(--map-land-stroke)"
                strokeWidth={strokeWidth}
              />
            </g>
          )
        })}

        {/* Continent labels. Identity comes from label + position, never hue --
            seven categorical fills cannot clear the all-pairs CVD floors, so
            the map uses emphasis plus text instead. */}
        {mode === 'continent' &&
          (Object.keys(CONTINENTS) as ContinentKey[]).map((key) => {
            const members = shapes.filter((shape) => shape.continent === key)
            if (members.length === 0) return null
            const x =
              members.reduce((sum, s) => sum + s.centroid[0], 0) / members.length
            const y =
              members.reduce((sum, s) => sum + s.centroid[1], 0) / members.length
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null
            return (
              <text
                key={`label-${key}`}
                x={x}
                y={y}
                textAnchor="middle"
                pointerEvents="none"
                fontSize={11 / transform.k}
                style={{
                  fill: 'var(--text)',
                  paintOrder: 'stroke',
                  stroke: 'var(--map-water)',
                  strokeWidth: 3 / transform.k,
                  strokeLinejoin: 'round',
                  fontWeight: 500,
                }}
              >
                {CONTINENTS[key]}
              </text>
            )
          })}
      </g>
    </svg>
  )
}
