import {
  formatDays,
  formatHours,
  formatKg,
  type MoonRecord,
  type SpaceBody,
} from '../../lib/space'

/**
 * Detail panels for Solar System bodies (Phase 7; extended round-2 §41
 * with naming, atmosphere, notable features and missions from the
 * editorial notes, and the deep-zoom globe entry point).
 */

export function FactRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div
      className="flex justify-between gap-3 border-b py-1 text-sm"
      style={{ borderColor: 'var(--border)' }}
    >
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  )
}

export function NA({ source }: { source: string | null }) {
  return (
    <span style={{ color: 'var(--text-muted)' }}>
      not available from {source ?? 'the source'}
    </span>
  )
}

function NoteBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="mt-2">
      <h3
        className="font-sans text-xs font-medium uppercase tracking-widest"
        style={{ color: 'var(--text-muted)' }}
      >
        {title}
      </h3>
      <p className="mt-0.5 text-sm">{text}</p>
    </div>
  )
}

export function BodyPanel({
  body,
  onViewGlobe,
}: {
  body: SpaceBody
  onViewGlobe?: (() => void) | undefined
}) {
  const facts = body.facts
  const source = body.source
  const value = (
    figure: number | null | undefined,
    render: (v: number) => React.ReactNode,
  ) =>
    figure === null || figure === undefined ? (
      <NA source={source} />
    ) : (
      render(figure)
    )
  return (
    <>
      <h2 className="text-xl">{body.name}</h2>
      <p className="mt-0.5 text-sm" style={{ color: 'var(--text-muted)' }}>
        {body.kind === 'star'
          ? 'Star'
          : body.kind === 'dwarf'
            ? 'Dwarf planet'
            : body.kind === 'moon'
              ? 'Natural satellite of Earth'
              : 'Planet'}
      </p>
      {onViewGlobe && (
        <button
          type="button"
          onClick={onViewGlobe}
          className="mt-2 rounded border px-2.5 py-1 text-sm"
          style={{ borderColor: 'var(--border)' }}
        >
          Open 3D globe{body.trek ? ' (deep zoom)' : ''}
        </button>
      )}
      {body.image && (
        <figure className="mt-3">
          <img
            src={body.image.url}
            alt={body.image.title ?? `NASA image of ${body.name}`}
            loading="lazy"
            className="max-h-44 w-full rounded-lg object-cover"
          />
          <figcaption
            className="mt-1 text-[10px] leading-snug"
            style={{ color: 'var(--text-muted)' }}
          >
            {body.image.title} — {body.image.credit} ·{' '}
            <a
              className="underline underline-offset-2"
              href={body.image.page}
              target="_blank"
              rel="noreferrer"
            >
              NASA Image Library
            </a>
          </figcaption>
        </figure>
      )}
      <dl className="mt-3">
        {body.primary && (
          <FactRow
            label={
              body.primary === 'sun'
                ? 'Mean distance from Sun'
                : 'Mean distance from Earth'
            }
          >
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
        <FactRow label="Mass">{value(facts.massKg, (v) => formatKg(v))}</FactRow>
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
            <>
              {v} K ({Math.round(v - 273.15)} °C)
            </>
          ))}
        </FactRow>
        {body.moonCount !== null && body.kind !== 'moon' && (
          <FactRow label="Known moons">{body.moonCount}</FactRow>
        )}
        {body.discovery ? (
          <FactRow label="Discovered">
            {body.discovery.year} — {body.discovery.by}
          </FactRow>
        ) : (
          body.kind !== 'star' &&
          body.kind !== 'moon' && (
            <FactRow label="Discovered">
              <span style={{ color: 'var(--text-muted)' }}>
                known since antiquity
              </span>
            </FactRow>
          )
        )}
      </dl>

      {body.notes && (
        <>
          <NoteBlock title="Naming" text={body.notes.naming} />
          <NoteBlock title="Atmosphere" text={body.notes.atmosphere} />
          <NoteBlock title="Notable features" text={body.notes.features} />
          <NoteBlock title="Missions" text={body.notes.missions} />
        </>
      )}

      <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        Source: {body.source}
        {body.vintage ? ` · vintage ${body.vintage}` : ''}. Moon count: JPL
        SSD satellite tables.
        {body.notes ? ' Prose facts follow the cited reference below.' : ''}
      </p>
      <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
        <a
          className="underline underline-offset-2"
          href={body.links.wikipedia}
          target="_blank"
          rel="noreferrer"
        >
          Wikipedia
        </a>
        {body.notes?.source && (
          <a
            className="underline underline-offset-2"
            href={body.notes.source}
            target="_blank"
            rel="noreferrer"
          >
            Reference
          </a>
        )}
      </p>
    </>
  )
}

export function MoonPanel({
  moon,
  planet,
}: {
  moon: MoonRecord
  planet: SpaceBody
}) {
  const value = (
    figure: number | null | undefined,
    render: (v: number) => React.ReactNode,
  ) =>
    figure === null || figure === undefined ? (
      <span style={{ color: 'var(--text-muted)' }}>not measured (JPL SSD)</span>
    ) : (
      render(figure)
    )
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
        <FactRow label="Mass">{value(moon.massKg, (v) => formatKg(v))}</FactRow>
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
