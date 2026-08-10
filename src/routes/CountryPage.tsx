import { Link, useParams } from 'react-router'

import { useEntities, useMapPalette } from '../lib/data'

const SECTIONS = [
  ['Population', 'Phase 2 (UN WPP) and Phase 7 (interpolating counter)'],
  ['Land', 'Phase 6 (biome breakdown)'],
  ['People', 'Phase 5 (Factbook: ethnicity, religion, language)'],
  ['Education', 'Phase 2 (World Bank)'],
  ['Economy', 'Phase 2 (World Bank) and Phase 5 (Factbook industries)'],
  ['Government', 'Phase 5 (Factbook)'],
] as const

/** Phase 1 stub. Sections land across Phases 2, 5, 6, and 7. */
export function CountryPage() {
  const { iso3 } = useParams<{ iso3: string }>()
  const state = useEntities()
  const paletteState = useMapPalette()

  const entity =
    state.status === 'ready'
      ? state.data.find((row) => row.iso3 === iso3?.toUpperCase())
      : undefined

  /**
   * The country page gets the UNCLAMPED flag palette, per the brief: here a
   * colour has room to breathe and no neighbours to clash with.
   *
   * `accent.raw` is used as a rule/marker only. For text we use the safe step,
   * because 91 of 250 raw flag colours fail AA on the light surface -- yellows
   * and light blues especially. Colour that cannot carry text never carries
   * text.
   */
  const palette =
    paletteState.status === 'ready' && entity
      ? paletteState.data.entities[entity.iso3]
      : undefined

  if (state.status === 'ready' && !entity) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-12">
        <h1 className="text-2xl font-semibold">Unknown country</h1>
        <p className="mt-2" style={{ color: 'var(--text-muted)' }}>
          No entity with ISO 3166-1 alpha-3 code “{iso3}”.{' '}
          <Link to="/" className="underline underline-offset-2">
            Back to the index
          </Link>
          .
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-12">
      {palette?.flag && (
        <div
          className="mb-4 flex gap-1"
          aria-hidden="true"
          title="Colours extracted from this country's flag"
        >
          {palette.flag.accents.map((hex, index) => (
            <span
              key={`${hex}-${index}`}
              className="h-1.5 flex-1 rounded-full"
              style={{ background: hex }}
            />
          ))}
        </div>
      )}

      <h1 className="text-2xl font-semibold tracking-tight">
        {entity?.name_common ?? iso3}
      </h1>
      {entity && (
        <>
          <p className="mt-1" style={{ color: 'var(--text-muted)' }}>
            {entity.name_official ?? entity.name_common} · {entity.iso3} ·{' '}
            <Link
              to={`/continent/${entity.continent}`}
              className="underline underline-offset-2"
            >
              {entity.continent_name}
            </Link>
          </p>

          {entity.status_label && (
            <p
              className="mt-4 rounded-lg border px-4 py-3 text-sm"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface-raised)',
              }}
            >
              <strong>{entity.status_label}.</strong>{' '}
              {entity.editorial_note}
            </p>
          )}

          {entity.continent_note && (
            <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
              Continent assignment: {entity.continent_note}
            </p>
          )}
        </>
      )}

      <div className="mt-10 space-y-4">
        {SECTIONS.map(([title, when]) => (
          <section
            key={title}
            className="rounded-lg border border-l-4 px-4 py-3"
            style={{
              borderColor: 'var(--border)',
              // Accent-only use of the raw flag colour: a rule, never a text
              // or fill background, so an AA-failing colour stays harmless.
              borderLeftColor: palette?.accent?.raw ?? 'var(--border)',
            }}
          >
            <h2 className="font-medium">{title}</h2>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Not available yet — {when}.
            </p>
          </section>
        ))}
      </div>
    </div>
  )
}
