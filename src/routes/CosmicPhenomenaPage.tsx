import { useState } from 'react'

import { Unavailable } from '../components/viz/primitives'
import { usePhenomena, type PhenomenaFile } from '../lib/space'

/**
 * /space/phenomena — Cosmic Phenomena (round-2 §41.4): structured,
 * illustrated, sourced entries on the universe beyond the Solar System.
 * Editorial text from etl/reference/cosmic_phenomena.json; images from
 * the NASA Image and Video Library, credited per item; theoretical
 * objects (wormholes) say so in their own text.
 */

type Entry = PhenomenaFile['entries'][number]

function PhenomenonCard({ entry }: { entry: Entry }) {
  const [open, setOpen] = useState(false)
  return (
    <article
      className="overflow-hidden rounded-xl border"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface-raised)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {entry.image && (
        <img
          src={entry.image.url}
          alt={entry.image.title ?? entry.title}
          loading="lazy"
          className="h-44 w-full object-cover"
        />
      )}
      <div className="px-4 py-3">
        <h2 className="text-lg">{entry.title}</h2>
        <p className="mt-1 text-sm">{entry.description}</p>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="mt-2 rounded border px-2 py-0.5 text-xs"
          style={{ borderColor: 'var(--border)' }}
        >
          {open ? 'Hide key facts' : 'Key facts'}
        </button>
        {open && (
          <ul
            className="mt-2 list-disc space-y-1 pl-5 text-sm"
            style={{ color: 'var(--text)' }}
          >
            {entry.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
          <a
            className="underline underline-offset-2"
            href={entry.nasa}
            target="_blank"
            rel="noreferrer"
          >
            NASA
          </a>
          <a
            className="underline underline-offset-2"
            href={entry.wikipedia}
            target="_blank"
            rel="noreferrer"
          >
            Wikipedia
          </a>
        </p>
        {entry.image && (
          <p
            className="mt-2 text-[10px] leading-snug"
            style={{ color: 'var(--text-muted)' }}
          >
            {entry.image.title} — {entry.image.credit} ·{' '}
            <a
              className="underline underline-offset-2"
              href={entry.image.page}
              target="_blank"
              rel="noreferrer"
            >
              NASA Image Library
            </a>
          </p>
        )}
      </div>
    </article>
  )
}

export function CosmicPhenomenaPage() {
  const state = usePhenomena()
  const file = state.status === 'ready' ? state.data : null
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header>
        <p
          className="font-sans text-xs font-medium uppercase tracking-widest"
          style={{ color: 'var(--text-muted)' }}
        >
          Space
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Cosmic Phenomena
        </h1>
        <p
          className="mt-2 max-w-3xl text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          The universe beyond the Solar System — stars and their deaths,
          black holes, galaxies, the dark sector, and the afterglow of the
          Big Bang. Every entry links its NASA and Wikipedia references;
          theoretical objects are labelled as exactly that.
        </p>
      </header>

      {state.status === 'error' && (
        <div className="mt-6">
          <Unavailable what="Cosmic Phenomena" source="the editorial entries file" />
        </div>
      )}
      {state.status === 'loading' && (
        <p className="mt-6" style={{ color: 'var(--text-muted)' }}>
          Loading…
        </p>
      )}

      {file && (
        <>
          <div className="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {file.entries.map((entry) => (
              <PhenomenonCard key={entry.id} entry={entry} />
            ))}
          </div>
          <p className="mt-6 text-xs" style={{ color: 'var(--text-muted)' }}>
            {file.imageNote}
          </p>
        </>
      )}
    </div>
  )
}

export default CosmicPhenomenaPage
