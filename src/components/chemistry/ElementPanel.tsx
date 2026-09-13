import { Suspense, lazy, useEffect, useMemo, useRef } from 'react'

import { CollapsibleSources } from '../CollapsibleSources'
import {
  PROPERTY_META,
  PROPERTY_SECTIONS,
  categoryAccent,
  categoryFill,
  formatFigure,
  imageUrl,
  type ElementRecord,
  type ElementsFile,
  type Figure,
  type GlossaryEntry,
  type PropertyKey,
} from '../../lib/chemistry'
import { InfoTip } from './InfoTip'

// three.js only loads when a panel opens (§47.3).
const AtomModel = lazy(() => import('./AtomModel'))

const SHORT_SOURCE: Record<string, string> = {
  pubchem: 'PubChem',
  pugview: 'PubChem record',
  nist_asd: 'NIST ASD',
  ciaaw: 'IUPAC/CIAAW',
  wikidata: 'Wikidata',
  wp_list: 'Wikipedia list (CRC)',
  crc_crust: 'CRC via Wikipedia',
  anders_grevesse: 'Anders & Grevesse 1989',
  wp_thermal: 'CRC via Wikipedia',
  wp_heat: 'CRC via Wikipedia',
  wp_resistivity: 'CRC via Wikipedia',
  wp_radii: 'Wikipedia data page',
  wp_infobox: 'Wikipedia infobox',
  wp_etymology: 'Wikipedia etymologies',
  wikipedia: 'Wikipedia',
  iaea: 'IAEA/NUBASE',
  commons: 'Wikimedia Commons',
  editorial: 'editorial',
}

const PROSE_KEYS: PropertyKey[] = ['description', 'uses', 'biologicalRole', 'hazards']

function SourceTag({ figure, file }: { figure: Figure; file: ElementsFile }) {
  const source = file.sources[figure.source]
  const label = SHORT_SOURCE[figure.source] ?? figure.source
  return (
    <span
      className="whitespace-nowrap text-[10px]"
      style={{ color: 'var(--text-muted)' }}
      title={source ? `${source.title} · ${source.vintage}` : figure.source}
    >
      {label}
    </span>
  )
}

function Row({
  propertyKey,
  figure,
  file,
  glossary,
}: {
  propertyKey: PropertyKey
  figure: Figure
  file: ElementsFile
  glossary: Map<string, GlossaryEntry>
}) {
  const meta = PROPERTY_META[propertyKey]
  const entry = glossary.get(propertyKey)
  const missing = figure.value === null
  return (
    <div className="grid grid-cols-[minmax(7rem,9rem)_1fr] gap-x-2 border-t py-1.5 text-sm" style={{ borderColor: 'var(--border)' }}>
      <dt className="flex items-start gap-1 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
        <span>{meta.label}</span>
        {entry && (
          <InfoTip term={entry.term} definition={entry.definition} unit={entry.unit} glossaryKey={entry.key} />
        )}
      </dt>
      <dd className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className={missing ? 'text-xs italic' : 'tabular-nums'} style={missing ? { color: 'var(--text-muted)' } : undefined}>
            {missing ? 'not available' : formatFigure(propertyKey, figure)}
          </span>
          <SourceTag figure={figure} file={file} />
        </div>
        {missing && figure.reason && (
          <p className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            {figure.reason}
          </p>
        )}
        {!missing && figure.note && (
          <p className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            {figure.note}
          </p>
        )}
      </dd>
    </div>
  )
}

function Prose({
  propertyKey,
  figure,
  file,
  glossary,
}: {
  propertyKey: PropertyKey
  figure: Figure
  file: ElementsFile
  glossary: Map<string, GlossaryEntry>
}) {
  const meta = PROPERTY_META[propertyKey]
  const entry = glossary.get(propertyKey)
  const source = file.sources[figure.source]
  return (
    <section className="mt-3">
      <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {meta.label}
        {entry && (
          <InfoTip term={entry.term} definition={entry.definition} unit={entry.unit} glossaryKey={entry.key} />
        )}
      </h3>
      {figure.value === null ? (
        <p className="mt-1 text-xs italic" style={{ color: 'var(--text-muted)' }}>
          Not available — {figure.reason}
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm leading-snug">{String(figure.value)}</p>
          <p className="mt-0.5 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            {source ? source.title : figure.source}
            {figure.citations && figure.citations.length > 0 && (
              <>
                {' '}
                — cites{' '}
                {figure.citations.map((c, i) => (
                  <span key={`${c.name}-${i}`}>
                    {i > 0 ? '; ' : ''}
                    {c.url ? (
                      <a className="underline underline-offset-2" href={c.url} target="_blank" rel="noreferrer">
                        {c.name ?? c.url}
                      </a>
                    ) : (
                      c.name
                    )}
                  </span>
                ))}
              </>
            )}
            {source?.vintage ? ` · ${source.vintage}` : ''}
          </p>
        </>
      )}
    </section>
  )
}

export function ElementPanel({
  element,
  file,
  glossaryEntries,
  onClose,
}: {
  element: ElementRecord
  file: ElementsFile
  glossaryEntries: GlossaryEntry[]
  onClose: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [element.z])
  const glossary = useMemo(
    () => new Map(glossaryEntries.map((entry) => [entry.key, entry])),
    [glossaryEntries],
  )
  const shells = (element.properties.electronShells.value as number[] | null) ?? []
  const weight = element.properties.standardAtomicWeight
  const massNumber = weight.kind === 'mostStableIsotope'
    ? Number(String(weight.value).replace(/[^\d]/g, '')) || null
    : weight.numeric ? Math.round(weight.numeric) : null
  const usedSources = useMemo(() => {
    const ids = new Set<string>()
    for (const key of Object.keys(element.properties) as PropertyKey[]) {
      ids.add(element.properties[key].source)
    }
    if (element.image) ids.add('commons')
    return [...ids].filter((id) => file.sources[id])
  }, [element, file])

  const image = element.image
  return (
    <div
      className="rounded-xl border"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface-raised)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <div
        className="flex items-start justify-between gap-3 rounded-t-xl border-b-4 px-5 pb-3 pt-4"
        style={{ borderColor: categoryAccent(element.category), background: categoryFill(element.category) }}
      >
        <div className="flex items-center gap-4">
          <div className="text-4xl font-semibold leading-none tabular-nums" aria-hidden="true">
            {element.symbol}
          </div>
          <div>
            <h2 ref={heading} tabIndex={-1} className="text-xl leading-tight outline-none">
              {element.name}
            </h2>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Atomic number {element.z} · {file.categories[element.category]}
              {element.properties.group.value !== null && ` · Group ${String(element.properties.group.value)}`}
              {element.properties.period.value !== null && ` · Period ${String(element.properties.period.value)}`}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close element details"
          className="rounded border px-2 py-0.5 text-xs"
          style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-raised)' }}
        >
          Close
        </button>
      </div>

      <div className="px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <figure>
            {image ? (
              <>
                <img
                  src={imageUrl(image)}
                  alt={
                    image.kind === 'sample'
                      ? `Photograph of ${element.name}`
                      : image.kind === 'facility'
                        ? `${image.facility ?? 'Discovering facility'}`
                        : `Image related to ${element.name}`
                  }
                  loading="lazy"
                  className="aspect-square w-full rounded object-cover"
                  style={{ background: 'var(--surface-sunken)' }}
                />
                <figcaption className="mt-1 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                  {image.kind === 'facility' && (
                    <span className="block font-medium" style={{ color: 'var(--text)' }}>
                      Discovering facility: {image.facility}
                    </span>
                  )}
                  {image.kind === 'related' && (
                    <span className="block font-medium" style={{ color: 'var(--text)' }}>
                      Related image, not a sample of the element
                    </span>
                  )}
                  {image.caption && <span className="block">{image.caption}</span>}
                  {image.author ?? 'Unknown author'} ·{' '}
                  <a className="underline underline-offset-2" href={image.commonsPage} target="_blank" rel="noreferrer">
                    Commons
                  </a>{' '}
                  · {image.license}
                </figcaption>
              </>
            ) : (
              <div
                className="flex aspect-square w-full items-center justify-center rounded border border-dashed p-3 text-center text-xs"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}
              >
                {element.noSample ? 'No photograph exists' : 'No free-licensed photograph found'}
              </div>
            )}
            {element.noSample && element.noSampleReason && (
              <p className="mt-1 rounded border px-2 py-1 text-[11px] leading-snug" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
                <strong style={{ fontWeight: 600 }}>No sample: </strong>
                {element.noSampleReason}
              </p>
            )}
            {element.sampleNote && (
              <p className="mt-1 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                {element.sampleNote}
              </p>
            )}
          </figure>

          <figure>
            <div className="rounded" style={{ background: 'var(--surface-sunken)' }}>
              {shells.length > 0 ? (
                <Suspense
                  fallback={
                    <div className="flex aspect-square items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
                      Loading atom model…
                    </div>
                  }
                >
                  <AtomModel z={element.z} symbol={element.symbol} shells={shells} massNumber={massNumber} />
                </Suspense>
              ) : (
                <div className="flex aspect-square items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
                  Electron shells not available
                </div>
              )}
            </div>
            <figcaption className="mt-1 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
              <strong style={{ fontWeight: 600, color: 'var(--text)' }}>Bohr-model schematic</strong> — electrons
              per shell {shells.join(', ') || 'unknown'}
              {element.properties.electronConfiguration.note?.includes('predicted') ? ' (predicted configuration)' : ''}. Not to
              scale; not a depiction of orbitals. Drag to orbit.
            </figcaption>
          </figure>
        </div>

        {PROSE_KEYS.slice(0, 1).map((key) => (
          <Prose key={key} propertyKey={key} figure={element.properties[key]} file={file} glossary={glossary} />
        ))}

        {PROPERTY_SECTIONS.map((section) => {
          const keys = section.keys.filter((key) => !PROSE_KEYS.includes(key))
          if (keys.length === 0) return null
          return (
            <section key={section.title} className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                {section.title}
              </h3>
              <dl className="mt-1">
                {keys.map((key) => (
                  <Row key={key} propertyKey={key} figure={element.properties[key]} file={file} glossary={glossary} />
                ))}
              </dl>
            </section>
          )
        })}

        {PROSE_KEYS.slice(1).map((key) => (
          <Prose key={key} propertyKey={key} figure={element.properties[key]} file={file} glossary={glossary} />
        ))}

        <p className="mt-4 flex flex-wrap gap-x-4 text-sm">
          <a className="underline underline-offset-2" href={element.wikipedia} target="_blank" rel="noreferrer">
            Wikipedia
          </a>
          <a className="underline underline-offset-2" href={element.pubchem} target="_blank" rel="noreferrer">
            PubChem
          </a>
          <a className="underline underline-offset-2" href={element.rsc} target="_blank" rel="noreferrer">
            RSC periodic table
          </a>
        </p>

        <div className="mt-2">
          <CollapsibleSources count={usedSources.length} label="Sources for this element">
            <ul className="space-y-1 text-xs">
              {usedSources.map((id) => {
                const source = file.sources[id]!
                return (
                  <li key={id}>
                    <a className="underline underline-offset-2" href={source.url} target="_blank" rel="noreferrer">
                      {source.title}
                    </a>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' '}· {source.vintage} · {source.licence}
                    </span>
                  </li>
                )
              })}
            </ul>
          </CollapsibleSources>
        </div>
      </div>
    </div>
  )
}
