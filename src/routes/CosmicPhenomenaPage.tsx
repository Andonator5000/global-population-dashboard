import { useId, useMemo, useState } from 'react'

import { Unavailable } from '../components/viz/primitives'
import {
  phenomenonImageUrl,
  usePhenomena,
  type PhenomenaFile,
  type PhenomenonEntry,
  type PhenomenonStatus,
} from '../lib/space'

/**
 * /space/phenomena — Cosmic Phenomena (round-2 §41.3, expanded round-3
 * phase 6, DATA_DECISIONS §46): a categorised, searchable catalogue of the
 * universe beyond the Solar System. Editorial text and facts come from
 * etl/reference/cosmic_phenomena.json; every image is downloaded at build
 * time and served from data/space/phenomena/ (never hotlinked), credited
 * per item. Non-observed entries (theoretical, hypothesis) say so plainly
 * in their own text as well as carrying the status flag rendered here.
 *
 * Filtering (category) and search (title/description/facts) are both
 * client-side over the ~60-entry catalogue -- no server round trip, so
 * results update on every keystroke. Both controls are keyboard operable
 * (native <button aria-pressed> and <input type="search">) and a live
 * region announces the result count for screen-reader users.
 */

// Text-safe AA tokens only (checked against --surface and --surface-raised
// by scripts/check-contrast.mjs); status is never the only signal — the
// label is always printed, and non-observed entries say so in their prose.
const STATUS_TONE: Record<PhenomenonStatus, string> = {
  observed: 'var(--text-muted)',
  theoretical: 'var(--accent)',
  hypothesis: 'var(--negative)',
}

function StatusBadge({
  status,
  statuses,
}: {
  status: PhenomenonStatus
  statuses: PhenomenaFile['statuses']
}) {
  const info = statuses.find((s) => s.id === status)
  const label = info?.label ?? status
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide"
      style={{ borderColor: STATUS_TONE[status], color: STATUS_TONE[status] }}
      title={info?.note}
    >
      {label}
    </span>
  )
}

function PhenomenonCard({
  entry,
  categoryLabel,
  statuses,
}: {
  entry: PhenomenonEntry
  categoryLabel: string
  statuses: PhenomenaFile['statuses']
}) {
  const [open, setOpen] = useState(false)
  const factsId = useId()
  return (
    <article
      className="flex flex-col overflow-hidden rounded-xl border"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface-raised)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <div className="relative">
        <img
          src={phenomenonImageUrl(entry.image)}
          alt={entry.image.title}
          loading="lazy"
          decoding="async"
          width={entry.image.width}
          height={entry.image.height}
          className="aspect-[4/3] w-full object-cover"
        />
        <span
          className="absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ background: 'var(--surface-raised)', color: 'var(--text-muted)' }}
        >
          {categoryLabel}
        </span>
      </div>
      <div className="flex flex-1 flex-col px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-medium leading-snug">{entry.title}</h2>
          <StatusBadge status={entry.status} statuses={statuses} />
        </div>
        <p className="mt-1 text-sm" style={{ color: 'var(--text)' }}>
          {entry.description}
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={factsId}
          onClick={() => setOpen((value) => !value)}
          className="mt-2 self-start rounded border px-2 py-0.5 text-xs"
          style={{ borderColor: 'var(--border)' }}
        >
          {open ? 'Hide key facts' : `Key facts (${entry.facts.length})`}
        </button>
        {open && (
          <ul id={factsId} className="mt-2 space-y-1.5 text-sm">
            {entry.facts.map((fact) => (
              <li key={fact.value}>
                {fact.value}
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {' — '}
                  <a
                    className="underline underline-offset-2"
                    href={fact.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {fact.source}
                  </a>
                  {`, ${fact.year}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-auto pt-2 flex flex-wrap gap-x-4 text-sm">
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
        <p
          className="mt-2 text-[10px] leading-snug"
          style={{ color: 'var(--text-muted)' }}
        >
          {entry.image.title} — {entry.image.credit} · {entry.image.licence}{' '}
          ·{' '}
          <a
            className="underline underline-offset-2"
            href={entry.image.page}
            target="_blank"
            rel="noreferrer"
          >
            source
          </a>
        </p>
      </div>
    </article>
  )
}

function CatalogueBody({ file }: { file: PhenomenaFile }) {
  const [category, setCategory] = useState<string>('all')
  const [query, setQuery] = useState('')
  const searchId = useId()

  const categoryLabels = useMemo(
    () => new Map(file.categories.map((c) => [c.id, c.label])),
    [file.categories],
  )

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of file.entries) {
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1)
    }
    return counts
  }, [file.entries])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return file.entries.filter((entry) => {
      if (category !== 'all' && entry.category !== category) return false
      if (!q) return true
      const haystack = [
        entry.title,
        entry.description,
        categoryLabels.get(entry.category) ?? '',
        ...entry.facts.map((f) => f.value),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [file.entries, category, query, categoryLabels])

  const clearFilters = () => {
    setCategory('all')
    setQuery('')
  }

  return (
    <>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="min-w-48 flex-1 sm:max-w-xs">
          <span className="sr-only" id={searchId}>
            Search phenomena by name, description or fact
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-labelledby={searchId}
            placeholder="Search name, description or fact…"
            className="w-full rounded border px-3 py-1.5 text-sm"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface-raised)',
              color: 'var(--text)',
            }}
          />
        </label>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }} aria-live="polite">
          {filtered.length} of {file.entries.length} entries
        </p>
      </div>

      <div
        className="mt-3 flex flex-wrap gap-1.5"
        role="group"
        aria-label="Filter by category"
      >
        <button
          type="button"
          aria-pressed={category === 'all'}
          onClick={() => setCategory('all')}
          className="rounded-full border px-2.5 py-1 text-xs"
          style={{
            borderColor: 'var(--border)',
            background: category === 'all' ? 'var(--control-selected-bg)' : 'transparent',
            color: category === 'all' ? 'var(--control-selected-text)' : 'inherit',
          }}
        >
          All ({file.entries.length})
        </button>
        {file.categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            aria-pressed={category === cat.id}
            onClick={() => setCategory(cat.id)}
            className="rounded-full border px-2.5 py-1 text-xs"
            style={{
              borderColor: 'var(--border)',
              background: category === cat.id ? 'var(--control-selected-bg)' : 'transparent',
              color: category === cat.id ? 'var(--control-selected-text)' : 'inherit',
            }}
          >
            {cat.label} ({categoryCounts.get(cat.id) ?? 0})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="mt-6">
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No phenomena match{query.trim() ? ` "${query.trim()}"` : ''}
            {category !== 'all' ? ` in ${categoryLabels.get(category)}` : ''}. Try a
            different term, or{' '}
            <button
              type="button"
              onClick={clearFilters}
              className="underline underline-offset-2"
            >
              clear the filters
            </button>{' '}
            to see all {file.entries.length}.
          </p>
        </div>
      ) : (
        <div className="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((entry) => (
            <PhenomenonCard
              key={entry.id}
              entry={entry}
              categoryLabel={categoryLabels.get(entry.category) ?? entry.category}
              statuses={file.statuses}
            />
          ))}
        </div>
      )}

      <p className="mt-6 text-xs" style={{ color: 'var(--text-muted)' }}>
        {file.imageNote}
      </p>
    </>
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
          Big Bang. Every entry links its NASA and Wikipedia references and
          carries a status flag: theoretical and hypothesis entries say so
          in their own text too, never presented as observation.
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

      {file && <CatalogueBody file={file} />}
    </div>
  )
}

export default CosmicPhenomenaPage
