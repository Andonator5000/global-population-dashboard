import { useEffect } from 'react'
import { Link } from 'react-router'

import { Unavailable } from '../components/viz/primitives'
import { useGlossary } from '../lib/chemistry'

/**
 * /chemistry/glossary — plain-language definitions, with units and a cited
 * source, for every property the element panel shows (§47.4). The entries
 * are data (data/chemistry/glossary.json, produced by the ETL from
 * etl/reference/chemistry_glossary.json), not component copy, so the
 * check gate can prove the panel and the glossary agree.
 */
export function ChemistryGlossaryPage() {
  const state = useGlossary()
  const file = state.status === 'ready' ? state.data : null

  useEffect(() => {
    if (!file) return
    const hash = window.location.hash.replace('#', '')
    if (!hash) return
    const target = document.getElementById(hash)
    if (target) {
      target.scrollIntoView({ block: 'start' })
      const heading = target.querySelector('h2')
      if (heading instanceof HTMLElement) heading.focus()
    }
  }, [file])

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header>
        <p className="font-sans text-xs font-medium uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
          Chemistry
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Chemistry glossary</h1>
        <p className="mt-2 max-w-3xl text-sm" style={{ color: 'var(--text-muted)' }}>
          Every property shown on the{' '}
          <Link className="underline underline-offset-2" to="/chemistry">
            periodic table
          </Link>{' '}
          defined in plain language, with its unit and the reference the definition follows —
          the IUPAC Gold Book where it has the term, otherwise an open textbook, NIST, CAS or
          the IAEA.
        </p>
      </header>

      {state.status === 'error' && (
        <div className="mt-6">
          <Unavailable what="Glossary" source="the chemistry artifacts" reason={state.error.message} />
        </div>
      )}
      {state.status === 'loading' && (
        <p className="mt-6 text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading…
        </p>
      )}

      {file && (
        <>
          <nav aria-label="Glossary terms" className="mt-5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {file.entries.map((entry) => (
              <a key={entry.key} href={`#${entry.key}`} className="underline underline-offset-2">
                {entry.term}
              </a>
            ))}
          </nav>

          <dl className="mt-6">
            {file.entries.map((entry) => (
              <div
                key={entry.key}
                id={entry.key}
                className="scroll-mt-4 border-t py-4"
                style={{ borderColor: 'var(--border)' }}
              >
                <dt>
                  <h2 tabIndex={-1} className="text-lg outline-none">
                    {entry.term}
                    {entry.unit && (
                      <span className="ml-2 font-sans text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                        unit: {entry.unit}
                      </span>
                    )}
                  </h2>
                </dt>
                <dd className="mt-1 text-sm leading-relaxed">{entry.definition}</dd>
                <dd className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  Source:{' '}
                  <a className="underline underline-offset-2" href={entry.source.url} target="_blank" rel="noreferrer">
                    {entry.source.title}
                  </a>
                  {entry.source.publisher ? ` (${entry.source.publisher})` : ''}
                  {entry.alsoSee && (
                    <>
                      {' '}· see also{' '}
                      <a className="underline underline-offset-2" href={entry.alsoSee.url} target="_blank" rel="noreferrer">
                        {entry.alsoSee.title}
                      </a>
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 text-xs" style={{ color: 'var(--text-muted)' }}>
            {file.entries.length} terms · glossary version {file.version}. {file.note}
          </p>
        </>
      )}
    </div>
  )
}

export default ChemistryGlossaryPage
