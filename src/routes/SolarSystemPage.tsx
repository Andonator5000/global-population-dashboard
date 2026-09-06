import { useEffect, useMemo, useState } from 'react'

import { Unavailable } from '../components/viz/primitives'
import {
  formatDays,
  formatHours,
  formatKg,
  loadMoons,
  useSpaceBodies,
  type MoonRecord,
  type SpaceBody,
} from '../lib/space'

/**
 * /space/solar-system -- an interactive map of the Solar System (Phase 7).
 *
 * Real distances and real sizes cannot share one drawing: at true scale
 * across 70 AU, even the Sun is smaller than a pixel. So the map has two
 * labelled modes -- "compressed" (log distances, enlarged bodies) and
 * "true distance" (linear distances, bodies as minimum-size dots with the
 * caveat stated) -- and nothing is ever silently out of scale. Selecting
 * a planet opens its detail panel; planets with satellites offer a system
 * view whose moon catalogue loads lazily from JPL's full tables.
 */

const VIEW_W = 1000
const VIEW_H = 230
const X0 = 70
const X1 = 975
const MIN_AU = 0.28
const MAX_AU = 72

/** Representative hues for map circles (the portraits live in the panel). */
const BODY_COLORS: Record<string, string> = {
  sun: '#f3c54c', mercury: '#9c9489', venus: '#d9b98a', earth: '#4a7fc1',
  mars: '#b5623c', jupiter: '#c4a077', saturn: '#d9c391', uranus: '#8fc4cc',
  neptune: '#4c6fbf', pluto: '#b9a48e', ceres: '#8f8a82', eris: '#cfcac2',
  haumea: '#c9c3ba', makemake: '#b58d6c', moon: '#a6a6a6',
}

interface Selection {
  bodyId: string
  moon?: MoonRecord
}

function xFor(au: number, mode: 'compressed' | 'true'): number {
  const clamped = Math.max(MIN_AU, Math.min(MAX_AU, au))
  const t =
    mode === 'compressed'
      ? Math.log(clamped / MIN_AU) / Math.log(MAX_AU / MIN_AU)
      : clamped / MAX_AU
  return X0 + (X1 - X0) * t
}

function rFor(radiusKm: number | null | undefined,
              mode: 'compressed' | 'true'): number {
  if (!radiusKm) return 2
  if (mode === 'true') {
    // px per km at 70 AU across the drawing width.
    const pxPerKm = (X1 - X0) / (MAX_AU * 149_597_870.7)
    return Math.max(0.6, radiusKm * pxPerKm)
  }
  return Math.max(2.5, Math.min(22, 0.36 * Math.cbrt(radiusKm)))
}

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b py-1 text-sm"
         style={{ borderColor: 'var(--border)' }}>
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  )
}

function NA({ source }: { source: string | null }) {
  return (
    <span style={{ color: 'var(--text-muted)' }}>
      not available from {source ?? 'the source'}
    </span>
  )
}

export function SolarSystemPage() {
  const state = useSpaceBodies()
  const [mode, setMode] = useState<'compressed' | 'true'>('compressed')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [systemViewId, setSystemViewId] = useState<string | null>(null)
  const [moonLists, setMoonLists] = useState<Map<string, MoonRecord[]>>(
    () => new Map(),
  )
  const [moonError, setMoonError] = useState<string | null>(null)

  const file = state.status === 'ready' ? state.data : null
  const bodies = file?.bodies ?? []
  const byId = useMemo(
    () => new Map(bodies.map((body) => [body.id, body])),
    [bodies],
  )

  const selectedBody = selection ? byId.get(selection.bodyId) : undefined
  const systemBody = systemViewId ? byId.get(systemViewId) : undefined

  useEffect(() => {
    if (!systemViewId || moonLists.has(systemViewId)) return
    let cancelled = false
    loadMoons(systemViewId)
      .then((data) => {
        if (!cancelled) {
          setMoonLists((prev) => new Map(prev).set(systemViewId, data.moons))
        }
      })
      .catch(() => {
        if (!cancelled) setMoonError(systemViewId)
      })
    return () => {
      cancelled = true
    }
  }, [systemViewId, moonLists])

  const orbiters = bodies.filter(
    (body) => body.primary === 'sun' && body.facts.semimajorAxisAu,
  )

  const scaleNote =
    mode === 'compressed'
      ? 'Compressed view: distances on a logarithmic scale, bodies enlarged — NOT to scale.'
      : 'True-distance view: distances linear to ~70 AU. At this scale every body is smaller than a pixel (the Sun included), so each is drawn as a minimum-size dot. That is the honest point of this mode.'

  function renderSolarMap() {
    return (
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="h-auto w-full"
        role="group"
        aria-label={`Solar system map, ${mode === 'compressed' ? 'compressed' : 'true distance'} scale. ${orbiters.length + 1} bodies; use the jump list below for keyboard access.`}
        style={{ background: 'var(--map-space)' }}
      >
        {file?.regions.map((region) => {
          const x0 = xFor(region.innerAu, mode)
          const x1 = xFor(region.outerAu, mode)
          return (
            <g key={region.id}>
              <rect
                x={x0}
                y={20}
                width={Math.max(2, x1 - x0)}
                height={VIEW_H - 55}
                fill="rgba(255,255,255,0.07)"
                stroke="rgba(255,255,255,0.18)"
                strokeDasharray="3 3"
              />
              <text
                x={(x0 + x1) / 2}
                y={34}
                textAnchor="middle"
                fontSize={10}
                fill="rgba(255,255,255,0.75)"
              >
                {region.name}
              </text>
            </g>
          )
        })}

        {/* The Sun sits at the left edge; in true mode it is a dot too. */}
        <g
          role="button"
          tabIndex={0}
          aria-label="Sun. Open details."
          className="map-target"
          onClick={() => setSelection({ bodyId: 'sun' })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setSelection({ bodyId: 'sun' })
            }
          }}
        >
          <circle
            cx={X0 - 32}
            cy={(VIEW_H - 35) / 2 + 20}
            r={mode === 'true' ? 1.5 : 30}
            fill={BODY_COLORS.sun}
          />
          <text
            x={X0 - 32}
            y={VIEW_H - 12}
            textAnchor="middle"
            fontSize={10}
            fill="rgba(255,255,255,0.85)"
          >
            Sun
          </text>
        </g>

        {orbiters.map((body, index) => {
          const au = body.facts.semimajorAxisAu ?? MIN_AU
          const x = xFor(au, mode)
          const cy = (VIEW_H - 35) / 2 + 20
          const r = rFor(body.facts.equatorialRadiusKm, mode)
          const selected = selection?.bodyId === body.id && !selection.moon
          // Stagger labels so close-packed dwarf planets stay legible.
          const labelY = cy + r + 12 + (index % 2 === 0 ? 0 : 12)
          return (
            <g
              key={body.id}
              role="button"
              tabIndex={0}
              aria-label={`${body.name}, ${body.kind === 'dwarf' ? 'dwarf planet' : body.kind}. Open details.`}
              className="map-target"
              onClick={() => setSelection({ bodyId: body.id })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setSelection({ bodyId: body.id })
                }
              }}
            >
              {/* Generous invisible hit ring; true-scale dots are tiny. */}
              <circle cx={x} cy={cy} r={Math.max(r + 4, 10)} fill="transparent" />
              <circle
                cx={x}
                cy={cy}
                r={r}
                fill={BODY_COLORS[body.id] ?? '#999'}
                stroke={selected ? 'var(--map-accent-fill)' : 'none'}
                strokeWidth={selected ? 2.5 : 0}
              />
              {body.id === 'saturn' && mode === 'compressed' && (
                <ellipse
                  cx={x}
                  cy={cy}
                  rx={r * 1.9}
                  ry={r * 0.55}
                  fill="none"
                  stroke="rgba(217,195,145,0.8)"
                  strokeWidth={1.4}
                  pointerEvents="none"
                />
              )}
              <text
                x={x}
                y={labelY}
                textAnchor="middle"
                fontSize={body.kind === 'planet' ? 10.5 : 9}
                fill="rgba(255,255,255,0.85)"
              >
                {body.name}
              </text>
            </g>
          )
        })}
      </svg>
    )
  }

  function renderSystemMap(planet: SpaceBody, moons: MoonRecord[]) {
    const withA = moons.filter((moon) => moon.aKm)
    const minA = Math.min(...withA.map((moon) => moon.aKm ?? 1))
    const maxA = Math.max(...withA.map((moon) => moon.aKm ?? 1))
    const xMoon = (aKm: number) =>
      X0 +
      20 +
      (X1 - X0 - 20) *
        (Math.log(aKm / minA) / Math.log(Math.max(maxA / minA, 1.01)))
    const cy = (VIEW_H - 35) / 2 + 20
    const majors = withA.filter((moon) => moon.major)
    return (
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="h-auto w-full"
        role="group"
        aria-label={`${planet.name} system: ${moons.length} known moons, distances on a log scale. Major moons are labelled; the full list is in the panel.`}
        style={{ background: 'var(--map-space)' }}
      >
        <circle cx={X0 - 25} cy={cy} r={26}
                fill={BODY_COLORS[planet.id] ?? '#999'} />
        <text x={X0 - 25} y={VIEW_H - 12} textAnchor="middle" fontSize={10}
              fill="rgba(255,255,255,0.85)">
          {planet.name}
        </text>
        <text x={X1 - 4} y={16} textAnchor="end" fontSize={9}
              fill="rgba(255,255,255,0.6)">
          distances log-scaled — not to scale
        </text>
        {withA.map((moon, index) => {
          const x = xMoon(moon.aKm ?? minA)
          const isMajor = moon.major
          const selected = selection?.moon?.name === moon.name
          const r = isMajor
            ? Math.max(2.5, Math.min(9, 0.5 * Math.cbrt(moon.radiusKm ?? 8)))
            : 1.1
          return (
            <g
              key={moon.name}
              role="button"
              tabIndex={isMajor ? 0 : -1}
              aria-label={`${moon.name}. Open details.`}
              className="map-target"
              onClick={() =>
                setSelection({ bodyId: planet.id, moon })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setSelection({ bodyId: planet.id, moon })
                }
              }}
            >
              <circle cx={x} cy={cy + (isMajor ? 0 : ((index % 7) - 3) * 9)}
                      r={Math.max(r + 3, 6)} fill="transparent" />
              <circle
                cx={x}
                cy={cy + (isMajor ? 0 : ((index % 7) - 3) * 9)}
                r={r}
                fill={isMajor ? '#cfd6dd' : 'rgba(180,190,200,0.55)'}
                stroke={selected ? 'var(--map-accent-fill)' : 'none'}
                strokeWidth={selected ? 2 : 0}
              />
              {isMajor && majors.length <= 30 && (
                <text
                  x={x}
                  y={cy + 18 + (majors.indexOf(moon) % 2) * 11}
                  textAnchor="middle"
                  fontSize={8.5}
                  fill="rgba(255,255,255,0.8)"
                >
                  {moon.name}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    )
  }

  const moonsForSystem = systemViewId ? moonLists.get(systemViewId) : undefined

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <header>
        <p className="font-sans text-xs font-medium uppercase tracking-widest"
           style={{ color: 'var(--text-muted)' }}>
          Space
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Solar System
        </h1>
        <p className="mt-2 max-w-3xl text-sm" style={{ color: 'var(--text-muted)' }}>
          The Sun, the eight planets, the recognised dwarf planets, and every
          known natural satellite — figures from NASA's planetary fact sheets
          and the JPL Solar System Dynamics tables, with each body's source
          and vintage in its panel. A figure the source does not publish says
          so; it is never a zero.
        </p>
      </header>

      {state.status === 'error' && (
        <div className="mt-6">
          <Unavailable what="Solar System data"
                       source="NASA NSSDC and JPL SSD" />
        </div>
      )}
      {state.status === 'loading' && (
        <p className="mt-6" style={{ color: 'var(--text-muted)' }}>
          Loading the Solar System…
        </p>
      )}

      {file && (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {systemViewId ? (
                <button
                  type="button"
                  onClick={() => {
                    setSystemViewId(null)
                    setMoonError(null)
                  }}
                  className="rounded border px-2.5 py-1"
                  style={{ borderColor: 'var(--border)' }}
                >
                  ← Back to the Solar System
                </button>
              ) : (
                <fieldset className="flex items-center gap-2">
                  <legend className="sr-only">Scale mode</legend>
                  <span style={{ color: 'var(--text-muted)' }}>Scale</span>
                  {(['compressed', 'true'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={mode === value}
                      onClick={() => setMode(value)}
                      className="rounded border px-2.5 py-1"
                      style={{
                        borderColor: 'var(--border)',
                        background:
                          mode === value
                            ? 'var(--control-selected-bg)'
                            : 'transparent',
                        color:
                          mode === value
                            ? 'var(--control-selected-text)'
                            : 'inherit',
                      }}
                    >
                      {value === 'compressed' ? 'Compressed' : 'True distance'}
                    </button>
                  ))}
                </fieldset>
              )}
              <label className="flex items-center gap-2">
                <span style={{ color: 'var(--text-muted)' }}>Jump to</span>
                <select
                  value={selection && !selection.moon ? selection.bodyId : ''}
                  onChange={(event) => {
                    if (event.target.value) {
                      setSelection({ bodyId: event.target.value })
                    }
                  }}
                  className="rounded border px-2 py-1"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--surface-raised)',
                    color: 'var(--text)',
                  }}
                >
                  <option value="">a body…</option>
                  {bodies.map((body) => (
                    <option key={body.id} value={body.id}>
                      {body.name}
                      {body.kind === 'dwarf' ? ' (dwarf planet)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              {systemViewId && systemBody
                ? `${systemBody.name} system — ${systemBody.moonCount ?? '?'} known moons (JPL SSD).`
                : scaleNote}
            </p>

            <div className="mt-3 overflow-hidden rounded-lg border"
                 style={{ borderColor: 'var(--border)' }}>
              {systemViewId && systemBody ? (
                moonsForSystem ? (
                  renderSystemMap(systemBody, moonsForSystem)
                ) : moonError === systemViewId ? (
                  <p className="p-6 text-sm" style={{ color: 'var(--text-muted)' }}>
                    Could not load this planet's moon catalogue.
                  </p>
                ) : (
                  <p className="p-6 text-sm" style={{ color: 'var(--text-muted)' }}>
                    Loading the moon catalogue…
                  </p>
                )
              ) : (
                renderSolarMap()
              )}
            </div>
          </div>

          <aside>
            <div className="rounded-xl border px-5 py-5 lg:sticky lg:top-4"
                 style={{
                   borderColor: 'var(--border)',
                   background: 'var(--surface-raised)',
                 }}>
              {!selectedBody && (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Select a body on the map — or from the jump list — for its
                  figures, portrait, moons and sources.
                </p>
              )}
              {selectedBody && selection?.moon && (
                <MoonPanel moon={selection.moon} planet={selectedBody} />
              )}
              {selectedBody && !selection?.moon && (
                <BodyPanel
                  body={selectedBody}
                  onViewSystem={
                    (selectedBody.moonCount ?? 0) > 0 &&
                    selectedBody.kind !== 'star'
                      ? () => setSystemViewId(selectedBody.id)
                      : undefined
                  }
                />
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

function BodyPanel({ body, onViewSystem }: {
  body: SpaceBody
  onViewSystem?: (() => void) | undefined
}) {
  const facts = body.facts
  const source = body.source
  const value = (
    figure: number | null | undefined,
    render: (v: number) => React.ReactNode,
  ) => (figure === null || figure === undefined
    ? <NA source={source} />
    : render(figure))
  return (
    <>
      <h2 className="text-xl">{body.name}</h2>
      <p className="mt-0.5 text-sm" style={{ color: 'var(--text-muted)' }}>
        {body.kind === 'star' ? 'Star'
          : body.kind === 'dwarf' ? 'Dwarf planet'
          : body.kind === 'moon' ? 'Natural satellite of Earth'
          : 'Planet'}
      </p>
      {body.image && (
        <figure className="mt-3">
          <img
            src={body.image.url}
            alt={body.image.title ?? `NASA image of ${body.name}`}
            loading="lazy"
            className="max-h-44 w-full rounded-lg object-cover"
          />
          <figcaption className="mt-1 text-[10px] leading-snug"
                      style={{ color: 'var(--text-muted)' }}>
            {body.image.title} — {body.image.credit} ·{' '}
            <a className="underline underline-offset-2" href={body.image.page}
               target="_blank" rel="noreferrer">
              NASA Image Library
            </a>
          </figcaption>
        </figure>
      )}
      <dl className="mt-3">
        {body.primary && (
          <FactRow label={body.primary === 'sun'
            ? 'Mean distance from Sun'
            : 'Mean distance from Earth'}>
            {value(facts.semimajorAxisKm, (v) => (
              <>
                {v.toLocaleString('en')} km
                {facts.semimajorAxisAu
                  ? ` (${facts.semimajorAxisAu.toFixed(3)} AU)`
                  : ''}
              </>
            ))}
          </FactRow>
        )}
        {body.primary && (
          <FactRow label="Orbital period">
            {value(facts.orbitalPeriodDays, (v) => formatDays(v))}
          </FactRow>
        )}
        <FactRow label="Rotation period">
          {value(facts.rotationPeriodHours, (v) => formatHours(v))}
        </FactRow>
        <FactRow label="Equatorial radius">
          {value(facts.equatorialRadiusKm, (v) => (
            <>{v.toLocaleString('en')} km</>
          ))}
        </FactRow>
        <FactRow label="Mass">
          {value(facts.massKg, (v) => formatKg(v))}
        </FactRow>
        <FactRow label="Mean density">
          {value(facts.densityKgM3, (v) => <>{v.toLocaleString('en')} kg/m³</>)}
        </FactRow>
        <FactRow label="Surface gravity">
          {value(facts.gravityMS2, (v) => <>{v} m/s²</>)}
        </FactRow>
        <FactRow label="Escape velocity">
          {value(facts.escapeKmS, (v) => <>{v} km/s</>)}
        </FactRow>
        <FactRow label="Axial tilt">
          {value(facts.axialTiltDeg, (v) => <>{v}°</>)}
        </FactRow>
        {body.primary && (
          <FactRow label="Orbital eccentricity">
            {value(facts.eccentricity, (v) => <>{v}</>)}
          </FactRow>
        )}
        <FactRow label="Mean temperature">
          {value(facts.meanTempK, (v) => (
            <>{v} K ({Math.round(v - 273.15)} °C)</>
          ))}
        </FactRow>
        {body.moonCount !== null && body.kind !== 'moon' && (
          <FactRow label="Known moons">{body.moonCount}</FactRow>
        )}
        {body.discovery && (
          <FactRow label="Discovered">
            {body.discovery.year} — {body.discovery.by}
          </FactRow>
        )}
      </dl>
      {onViewSystem && (
        <button
          type="button"
          onClick={onViewSystem}
          className="mt-3 rounded border px-2.5 py-1 text-sm"
          style={{ borderColor: 'var(--border)' }}
        >
          View the {body.name} system ({body.moonCount} moons)
        </button>
      )}
      <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        Source: {body.source}
        {body.vintage ? ` · vintage ${body.vintage}` : ''}. Moon count: JPL
        SSD satellite tables.
      </p>
      <p className="mt-2 text-sm">
        <a className="underline underline-offset-2" href={body.links.wikipedia}
           target="_blank" rel="noreferrer">
          Wikipedia
        </a>
      </p>
    </>
  )
}

function MoonPanel({ moon, planet }: { moon: MoonRecord; planet: SpaceBody }) {
  const value = (
    figure: number | null | undefined,
    render: (v: number) => React.ReactNode,
  ) => (figure === null || figure === undefined
    ? <span style={{ color: 'var(--text-muted)' }}>not measured (JPL SSD)</span>
    : render(figure))
  return (
    <>
      <h2 className="text-xl">{moon.name}</h2>
      <p className="mt-0.5 text-sm" style={{ color: 'var(--text-muted)' }}>
        Natural satellite of {planet.name}
        {moon.major ? '' : ' (minor; few measured parameters)'}
      </p>
      <dl className="mt-3">
        <FactRow label={`Mean distance from ${planet.name}`}>
          {value(moon.aKm, (v) => <>{v.toLocaleString('en')} km</>)}
        </FactRow>
        <FactRow label="Orbital period">
          {value(moon.periodDays, (v) => formatDays(Math.abs(v)))}
        </FactRow>
        <FactRow label="Orbital eccentricity">
          {value(moon.e, (v) => <>{v}</>)}
        </FactRow>
        <FactRow label="Inclination">
          {value(moon.iDeg, (v) => <>{v}°</>)}
        </FactRow>
        <FactRow label="Mean radius">
          {value(moon.radiusKm, (v) => <>{v.toLocaleString('en')} km</>)}
        </FactRow>
        <FactRow label="Mass">
          {value(moon.massKg, (v) => formatKg(v))}
        </FactRow>
        <FactRow label="Mean density">
          {value(moon.densityGCm3, (v) => <>{v} g/cm³</>)}
        </FactRow>
        <FactRow label="Discovered">
          {moon.discoveryYear ? (
            <>
              {moon.discoveryYear}
              {moon.discoveredBy ? ` — ${moon.discoveredBy}` : ''}
            </>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>
              not listed (JPL SSD)
            </span>
          )}
        </FactRow>
      </dl>
      <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        Source: JPL Solar System Dynamics satellite tables (elements,
        physical parameters, discovery circumstances).
      </p>
    </>
  )
}
