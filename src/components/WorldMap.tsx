import { geoDistance, geoPath, type GeoPermissibleObjects } from 'd3-geo'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type D3ZoomEvent } from 'd3-zoom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

interface FocusTarget extends HoverTarget {
  x: number
  y: number
}

type Direction = 'up' | 'down' | 'left' | 'right'

/**
 * Nearest target in a compass direction, by centroid.
 *
 * Candidates must lie in the requested direction; among those, the score
 * favours a small step along the axis of travel and penalises drift across it,
 * so pressing Right from Spain reaches France rather than something far north.
 */
function nearestInDirection(
  targets: FocusTarget[],
  fromIndex: number,
  direction: Direction,
): number {
  const origin = targets[fromIndex]
  if (!origin) return fromIndex
  let best = fromIndex
  let bestScore = Infinity

  targets.forEach((candidate, index) => {
    if (index === fromIndex) return
    const dx = candidate.x - origin.x
    const dy = candidate.y - origin.y
    const along =
      direction === 'right' ? dx
      : direction === 'left' ? -dx
      : direction === 'down' ? dy
      : -dy
    if (along <= 0) return
    const across = Math.abs(
      direction === 'left' || direction === 'right' ? dy : dx,
    )
    const score = along + across * 2.5
    if (score < bestScore) {
      bestScore = score
      best = index
    }
  })
  return best
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
  const nodeRefs = useRef(new Map<string, SVGGraphicsElement>())
  const [transform, setTransform] = useState(() => zoomIdentity)

  const isGlobe = projectionKey === 'globe'
  /**
   * Globe orientation: [lambda, phi] in degrees, driven by dragging. A slight
   * initial tilt so the first view is not dead-on the equator/meridian cross.
   */
  const [rotation, setRotation] = useState<[number, number]>([-10, -20])
  /** Active pointers; the globe rotates only under exactly one. */
  const dragPointers = useRef(new Map<number, { x: number; y: number }>())
  /** Set once a drag moves far enough that the trailing click must not select. */
  const dragSuppressesClick = useRef(false)
  /**
   * Roving tabindex.
   *
   * Only ONE country carries tabindex=0 at a time; the rest are -1 and are
   * reached with the arrow keys. Before this, the map exposed 241 tab stops
   * and a keyboard user had to press Tab 241 times to get past it — measured,
   * not estimated. A composite widget is one stop; you navigate inside it.
   */
  const [activeIndex, setActiveIndex] = useState(0)

  const { shapes, sphere, markerPoints } = useMemo(() => {
    const base = createProjection(projectionKey)
    if (isGlobe) base.rotate([rotation[0], rotation[1], 0])
    const projection = fitProjection(base, VIEW_WIDTH, VIEW_HEIGHT)
    const path = geoPath(projection)

    /** On the globe, points past the horizon project onto the near side and
        must be culled by great-circle distance from the view centre. */
    const pointVisible = (coordinates: [number, number]) =>
      !isGlobe ||
      geoDistance(coordinates, [-rotation[0], -rotation[1]]) <= Math.PI / 2

    const collection = feature(
      topology as never,
      topology.objects.countries as never,
    ) as unknown as {
      features: { properties: CountryGeometryProperties; geometry: unknown }[]
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
        if (!pointVisible(marker.coordinates)) return null
        const xy = projection(marker.coordinates)
        return xy ? { marker, x: xy[0], y: xy[1] } : null
      })
      .filter((v): v is { marker: MapMarker; x: number; y: number } => v !== null)

    return {
      shapes: built,
      sphere: path({ type: 'Sphere' }) ?? '',
      markerPoints: points,
    }
  }, [topology, markers, projectionKey, isGlobe, rotation])

  /** Every focusable entity, ordered west-to-east so Tab order is sensible. */
  const focusTargets: FocusTarget[] = useMemo(() => {
    const list: FocusTarget[] = [
      ...shapes.map((shape) => ({
        iso3: shape.iso3,
        name: shape.name,
        continent: shape.continent,
        contested: shape.contested,
        isMarker: false,
        x: shape.centroid[0],
        y: shape.centroid[1],
      })),
      ...markerPoints.map(({ marker, x, y }) => ({
        iso3: marker.iso3,
        name: marker.name,
        continent: marker.continent,
        contested: marker.contested,
        isMarker: true,
        x,
        y,
      })),
    ].filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y))
    list.sort((a, b) => a.x - b.x || a.y - b.y)
    return list
  }, [shapes, markerPoints])

  const indexByIso3 = useMemo(() => {
    const map = new Map<string, number>()
    focusTargets.forEach((target, index) => {
      if (!map.has(target.iso3)) map.set(target.iso3, index)
    })
    return map
  }, [focusTargets])

  /**
   * Set by keyboard navigation, consumed by the effect below.
   *
   * Focusing straight from the handler (even inside requestAnimationFrame)
   * races React's commit: the tabindex moves to the new country but the
   * browser keeps focus on the old one. Deferring to an effect guarantees the
   * DOM is committed before we move focus.
   */
  const pendingFocus = useRef<string | null>(null)

  const moveTo = useCallback(
    (index: number) => {
      const target = focusTargets[index]
      if (!target) return
      setActiveIndex(index)
      pendingFocus.current = target.iso3
      onHover(target)
      if (mode === 'continent') onActiveContinentChange(target.continent)
    },
    [focusTargets, mode, onHover, onActiveContinentChange],
  )

  useEffect(() => {
    const iso3 = pendingFocus.current
    if (!iso3) return
    pendingFocus.current = null
    nodeRefs.current.get(iso3)?.focus()
  })

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const directions: Record<string, Direction> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      }
      const direction = directions[event.key]
      if (direction) {
        event.preventDefault()
        moveTo(nearestInDirection(focusTargets, activeIndex, direction))
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        moveTo(0)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        moveTo(focusTargets.length - 1)
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const target = focusTargets[activeIndex]
        if (target) onSelect(target)
      }
    },
    [activeIndex, focusTargets, moveTo, onSelect],
  )

  // Zoom and pan. d3-zoom owns the gesture; React owns the rendered transform.
  //
  // In GLOBE mode the single-pointer drag is repurposed for rotation (below),
  // so d3-zoom is filtered down to wheel and two-finger pinch only -- it must
  // not also pan while a drag is spinning the sphere.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 12])
      .translateExtent([
        [0, 0],
        [VIEW_WIDTH, VIEW_HEIGHT],
      ])
      .filter((event) => {
        if (!isGlobe) {
          // d3-zoom's default filter.
          return (!event.ctrlKey || event.type === 'wheel') && !event.button
        }
        if (event.type === 'wheel') return true
        if (event.type.startsWith('touch')) {
          return (event as TouchEvent).touches.length >= 2
        }
        return false
      })
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        setTransform(event.transform)
      })
    const selection = select(svg)
    selection.call(behaviour)
    selection.on('dblclick.zoom', null)
    return () => {
      selection.on('.zoom', null)
    }
  }, [isGlobe])

  /**
   * Globe rotation by dragging -- pointer events, so mouse and touch share
   * one code path. Only exactly one active pointer rotates (a second finger
   * hands the gesture to d3-zoom's pinch). A drag that actually moved
   * suppresses the click it releases into, or letting go of the sphere would
   * open whichever country the pointer happened to stop on.
   */
  const handleGlobePointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!isGlobe || !event.isPrimary) {
        if (isGlobe) {
          dragPointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          })
        }
        return
      }
      dragPointers.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      })
      dragSuppressesClick.current = false
    },
    [isGlobe],
  )

  const handleGlobePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!isGlobe) return
      const tracked = dragPointers.current.get(event.pointerId)
      if (!tracked || dragPointers.current.size !== 1) return
      const dx = event.clientX - tracked.x
      const dy = event.clientY - tracked.y
      if (!dragSuppressesClick.current && Math.hypot(dx, dy) < 4) return
      dragSuppressesClick.current = true
      dragPointers.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      })
      // Degrees per CSS pixel, eased down as the zoom tightens.
      const sensitivity = 0.25 / Math.sqrt(transform.k)
      setRotation(([lambda, phi]) => [
        lambda + dx * sensitivity,
        Math.max(-90, Math.min(90, phi - dy * sensitivity)),
      ])
    },
    [isGlobe, transform.k],
  )

  const handleGlobePointerEnd = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      dragPointers.current.delete(event.pointerId)
    },
    [],
  )

  /** Select, unless the pointer was busy spinning the globe. */
  const selectUnlessDragging = useCallback(
    (target: HoverTarget) => {
      if (dragSuppressesClick.current) return
      onSelect(target)
    },
    [onSelect],
  )

  const strokeWidth = 0.5 / transform.k
  const isDimmed = (continent: ContinentKey) =>
    mode === 'continent' && activeContinent !== null && continent !== activeContinent

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

  const activeIso3 = focusTargets[activeIndex]?.iso3
  const tabIndexFor = (iso3: string) =>
    indexByIso3.get(iso3) === activeIndex ? 0 : -1

  /**
   * Where to anchor the hovered/focused country's name label. Polygon labels
   * sit at the shape centroid; marker labels sit just above the dot so the
   * text never covers it.
   */
  const hoveredLabel = useMemo(() => {
    if (!hovered) return null
    const shape = shapes.find((s) => s.iso3 === hovered.iso3)
    if (shape) {
      return { name: shape.name, x: shape.centroid[0], y: shape.centroid[1] }
    }
    const point = markerPoints.find(({ marker }) => marker.iso3 === hovered.iso3)
    if (point) {
      return { name: point.marker.name, x: point.x, y: point.y - 6 }
    }
    return null
  }, [hovered, shapes, markerPoints])

  const registerNode = (iso3: string) => (node: SVGGraphicsElement | null) => {
    if (node) nodeRefs.current.set(iso3, node)
    else nodeRefs.current.delete(iso3)
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      className="h-auto w-full touch-none"
      role="group"
      aria-label={
        `World map, equal-area projection, ${focusTargets.length} entities. ` +
        `Use the arrow keys to move between countries and Enter to open one. ` +
        `Home and End jump to the westernmost and easternmost.`
      }
      style={{
        background: 'var(--map-water)',
        cursor: isGlobe ? 'grab' : undefined,
      }}
      onPointerLeave={(event) => {
        dragPointers.current.delete(event.pointerId)
        onHover(null)
      }}
      onPointerDown={handleGlobePointerDown}
      onPointerMove={handleGlobePointerMove}
      onPointerUp={handleGlobePointerEnd}
      onPointerCancel={handleGlobePointerEnd}
      onKeyDown={handleKeyDown}
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
            x1="0" y1="0" x2="0" y2="6"
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
          const target: HoverTarget = {
            iso3: shape.iso3,
            name: shape.name,
            continent: shape.continent,
            contested: shape.contested,
            isMarker: false,
          }
          return (
            <path
              key={`${shape.iso3}-${shape.d.length}`}
              ref={registerNode(shape.iso3)}
              d={shape.d}
              fill={fillFor(shape)}
              stroke="var(--map-land-stroke)"
              strokeWidth={strokeWidth}
              strokeLinejoin="round"
              opacity={dimmed ? 0.45 : 1}
              tabIndex={tabIndexFor(shape.iso3)}
              role="link"
              aria-label={
                row?.available
                  ? `${shape.name}. Open country page.`
                  : `${shape.name}. No population data available. Open country page.`
              }
              className="map-target"
              onPointerEnter={() => onHover(target)}
              onFocus={() => {
                const index = indexByIso3.get(shape.iso3)
                if (index !== undefined) setActiveIndex(index)
                onHover(target)
                if (mode === 'continent') onActiveContinentChange(shape.continent)
              }}
              onClick={() => selectUnlessDragging(target)}
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
          const target: HoverTarget = {
            iso3: marker.iso3,
            name: marker.name,
            continent: marker.continent,
            contested: marker.contested,
            isMarker: true,
          }
          return (
            <g
              key={marker.iso3}
              ref={registerNode(marker.iso3)}
              transform={`translate(${x},${y})`}
              tabIndex={tabIndexFor(marker.iso3)}
              role="link"
              aria-label={`${marker.name}. Too small to draw at this scale; shown as a marker. Open country page.`}
              className="map-target"
              onPointerEnter={() => onHover(target)}
              onFocus={() => {
                const index = indexByIso3.get(marker.iso3)
                if (index !== undefined) setActiveIndex(index)
                onHover(target)
              }}
              onClick={() => selectUnlessDragging(target)}
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

        {/* Name label for the hovered or keyboard-focused entity, drawn on the
            map itself. The side readout panel remains the accessible surface
            (aria-live, keyboard parity); this text is a visual duplicate and
            is aria-hidden so screen readers do not announce the name twice. */}
        {hoveredLabel && (
          <text
            x={hoveredLabel.x}
            y={hoveredLabel.y}
            textAnchor="middle"
            pointerEvents="none"
            aria-hidden="true"
            fontSize={13 / transform.k}
            style={{
              fill: 'var(--text)',
              paintOrder: 'stroke',
              stroke: 'var(--map-water)',
              strokeWidth: 3.5 / transform.k,
              strokeLinejoin: 'round',
              fontWeight: 600,
            }}
          >
            {hoveredLabel.name}
          </text>
        )}

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

      <title>{`World map with ${focusTargets.length} entities. Currently focused: ${activeIso3 ?? 'none'}.`}</title>
    </svg>
  )
}
