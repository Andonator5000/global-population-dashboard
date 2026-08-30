import { useMemo, useState } from 'react'

import { CATEGORY_LABELS, Timeline } from '../components/history/Timeline'
import { Unavailable } from '../components/viz/primitives'
import { useHistory } from '../lib/data'

/**
 * /history -- the Human History timeline (Phase 3). Global scope, not tied
 * to any one nation: hominin evolution to the present. The event list is
 * editorial and versioned (etl/reference/history_events.json), resolved at
 * build time into data/history/events.json with attributed free images.
 */
export function HistoryPage() {
  const state = useHistory()
  const allCategories = useMemo(() => Object.keys(CATEGORY_LABELS), [])
  const [categories, setCategories] = useState<Set<string>>(() => new Set(allCategories))
  const [query, setQuery] = useState('')

  const toggle = (key: string) =>
    setCategories((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Human History</h1>
        <p className="mt-2 max-w-3xl text-sm" style={{ color: 'var(--text-muted)' }}>
          A global timeline from our earliest ancestors to the present. The axis is
          deliberately <strong style={{ fontWeight: 500 }}>not linear</strong>: each era
          gets its own scale, stated on its band, so the last five centuries are not
          crushed into a sliver beneath seven million years of evolution. Dates are
          shown at the precision the evidence supports; where they are contested,
          the summary says so.
        </p>
      </header>

      {state.status === 'error' || (state.status === 'ready' && !state.data) ? (
        <div className="mt-6">
          <Unavailable what="History timeline" source="the editorial events file" />
        </div>
      ) : null}

      {state.status === 'ready' && state.data && (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
              <legend className="sr-only">Filter by category</legend>
              {allCategories.map((key) => (
                <label key={key} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={categories.has(key)}
                    onChange={() => toggle(key)}
                  />
                  <span>{CATEGORY_LABELS[key]}</span>
                </label>
              ))}
            </fieldset>
            <label className="flex items-center gap-2">
              <span className="sr-only">Search events</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search events…"
                className="rounded border px-2 py-1"
                style={{
                  borderColor: 'var(--border)',
                  background: 'var(--surface-raised)',
                  color: 'var(--text)',
                }}
              />
            </label>
          </div>

          <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
            {state.data.counts.events} events, version {state.data.version}. Hover or
            tap an event for its summary; Escape closes it. {state.data.imageNote}
          </p>

          <div className="mt-6">
            <Timeline data={state.data} categories={categories} query={query} />
          </div>
        </>
      )}
    </div>
  )
}
