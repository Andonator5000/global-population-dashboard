import { useCallback, useMemo, useState } from 'react'

import { Unavailable } from '../components/viz/primitives'
import {
  colTaxonUrl,
  ITALIC_RANKS,
  loadFocusFamily,
  useTaxonomyTree,
  wikipediaUrl,
  type TaxonNode,
} from '../lib/taxonomy'
import { capitalizeFirst } from '../lib/format'

/**
 * /biology/taxonomy -- the interactive tree of life (Phase 5).
 *
 * The artifact holds Life to family rank; branches mount in the DOM only
 * when expanded, so tens of thousands of nodes never exist at once. Focus
 * families fetch their genus/species subtree on first expand. One button
 * per row: activating it selects the taxon (detail panel) AND toggles its
 * branch -- one tab stop per visible row, following the map's lesson that
 * composite widgets must not multiply tab stops.
 */

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const exactNumber = new Intl.NumberFormat('en')

interface TreeIndex {
  byId: Map<string, TaxonNode>
  parents: Map<string, string>
}

function indexTree(node: TaxonNode, index: TreeIndex): void {
  index.byId.set(node.id, node)
  for (const child of node.children ?? []) {
    index.parents.set(child.id, node.id)
    indexTree(child, index)
  }
}

function TaxonName({ node }: { node: TaxonNode }) {
  return ITALIC_RANKS.has(node.rank) ? <i>{node.name}</i> : <>{node.name}</>
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: 'flag' }) {
  return (
    <span
      className="rounded border px-1 py-px font-sans text-[10px] leading-tight"
      style={{
        borderColor: 'var(--border)',
        color: tone === 'flag' ? 'var(--text)' : 'var(--text-muted)',
        background: tone === 'flag' ? 'var(--control-selected-bg)' : 'transparent',
      }}
    >
      {children}
    </span>
  )
}

export function TaxonomyPage() {
  const state = useTaxonomyTree()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusLoaded, setFocusLoaded] = useState<Map<string, TaxonNode>>(
    () => new Map(),
  )
  const [focusErrors, setFocusErrors] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')

  const file = state.status === 'ready' ? state.data : null

  /** id -> node and id -> parent, over the base tree plus loaded subtrees. */
  const index = useMemo<TreeIndex>(() => {
    const built: TreeIndex = { byId: new Map(), parents: new Map() }
    if (file) {
      indexTree(file.tree, built)
      for (const subtree of focusLoaded.values()) {
        const parent = built.parents.get(subtree.id)
        indexTree(subtree, built)
        // indexTree re-set the subtree's own parent entry only for its
        // children; restore the family's own link into the base tree.
        if (parent) built.parents.set(subtree.id, parent)
      }
    }
    return built
  }, [file, focusLoaded])

  const selected = selectedId !== null ? index.byId.get(selectedId) : undefined

  const lineage = useMemo(() => {
    if (!selected) return []
    const chain: TaxonNode[] = []
    let cursor: string | undefined = selected.id
    while (cursor !== undefined) {
      const node = index.byId.get(cursor)
      if (!node) break
      chain.unshift(node)
      cursor = index.parents.get(cursor)
    }
    return chain
  }, [selected, index])

  const activate = useCallback(
    (node: TaxonNode) => {
      setSelectedId(node.id)
      const expandable =
        (node.children?.length ?? 0) > 0 || node.focus === true
      if (!expandable) return
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(node.id)) next.delete(node.id)
        else next.add(node.id)
        return next
      })
      if (node.focus && !focusLoaded.has(node.id)) {
        loadFocusFamily(node.id)
          .then((subtree) =>
            setFocusLoaded((prev) => new Map(prev).set(node.id, subtree)),
          )
          .catch(() =>
            setFocusErrors((prev) => new Set(prev).add(node.id)),
          )
      }
    },
    [focusLoaded],
  )

  /** Search across every indexed node (loaded focus species included). */
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length < 2) return null
    const starts: TaxonNode[] = []
    const contains: TaxonNode[] = []
    for (const node of index.byId.values()) {
      const name = node.name.toLowerCase()
      const common = node.common?.toLowerCase() ?? ''
      if (name.startsWith(needle) || common.startsWith(needle)) {
        starts.push(node)
      } else if (name.includes(needle) || common.includes(needle)) {
        contains.push(node)
      }
      if (starts.length >= 100) break
    }
    return [...starts, ...contains].slice(0, 100)
  }, [query, index])

  const lineageOf = useCallback(
    (node: TaxonNode): string => {
      const names: string[] = []
      let cursor = index.parents.get(node.id)
      while (cursor !== undefined) {
        const ancestor = index.byId.get(cursor)
        if (!ancestor) break
        names.unshift(ancestor.name)
        cursor = index.parents.get(cursor)
      }
      return names.join(' › ')
    },
    [index],
  )

  function renderNode(node: TaxonNode, depth: number): React.ReactNode {
    const subtree = node.focus ? focusLoaded.get(node.id) : undefined
    const children = subtree?.children ?? node.children ?? []
    const expandable = children.length > 0 || node.focus === true
    const isOpen = expanded.has(node.id)
    const isSelected = selectedId === node.id
    const awaitingFocus =
      node.focus === true && isOpen && !subtree && !focusErrors.has(node.id)

    return (
      <li key={node.id || 'root'}>
        <button
          type="button"
          onClick={() => activate(node)}
          {...(expandable ? { 'aria-expanded': isOpen } : {})}
          className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded px-1.5 py-1 text-left text-sm"
          style={{
            paddingLeft: `${6 + depth * 18}px`,
            background: isSelected ? 'var(--control-selected-bg)' : 'transparent',
            color: isSelected ? 'var(--control-selected-text)' : 'var(--text)',
          }}
        >
          <span
            aria-hidden="true"
            className="inline-block w-3 text-center font-sans text-xs"
            style={{
              color: 'var(--text-muted)',
              transform: isOpen ? 'rotate(90deg)' : 'none',
              transition: 'transform 150ms ease',
              visibility: expandable ? 'visible' : 'hidden',
            }}
          >
            ▸
          </span>
          <span className="font-medium">
            <TaxonName node={node} />
          </span>
          {node.common && (
            <span style={{ color: 'var(--text-muted)' }}>
              {capitalizeFirst(node.common)}
            </span>
          )}
          <Chip>{node.rank}</Chip>
          {node.names > 1 && (
            <span
              className="font-sans text-xs tabular-nums"
              style={{ color: 'var(--text-muted)' }}
            >
              {compactNumber.format(node.names)} names
            </span>
          )}
          {node.note && <Chip tone="flag">contested</Chip>}
          {node.provisional && <Chip>provisional</Chip>}
          {(node.truncated || subtree?.truncated) && <Chip>list capped</Chip>}
        </button>
        {isOpen && awaitingFocus && (
          <p
            className="py-1 text-xs"
            style={{ paddingLeft: `${30 + depth * 18}px`, color: 'var(--text-muted)' }}
          >
            Loading genera and species…
          </p>
        )}
        {isOpen && focusErrors.has(node.id) && (
          <p
            className="py-1 text-xs"
            style={{ paddingLeft: `${30 + depth * 18}px`, color: 'var(--text-muted)' }}
          >
            Could not load this family’s genera. Reload the page to retry.
          </p>
        )}
        {isOpen && children.length > 0 && (
          <ul>{children.map((child) => renderNode(child, depth + 1))}</ul>
        )}
      </li>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <header>
        <p
          className="font-sans text-xs font-medium uppercase tracking-widest"
          style={{ color: 'var(--text-muted)' }}
        >
          Biology
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Taxonomy</h1>
        <p
          className="mt-2 max-w-3xl text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          The tree of life as recorded by the{' '}
          <a
            className="underline underline-offset-2"
            href={file?.col_dataset_url ?? 'https://www.checklistbank.org/'}
            target="_blank"
            rel="noreferrer"
          >
            Catalogue of Life
          </a>
          {file ? ` (release ${file.release})` : ''}, from the three domains
          down to every family, with genus and species depth for a selection
          of well-known groups. Placements that are genuinely disputed are
          marked <em>contested</em> with an explanation — the tree follows
          its source, it does not settle arguments the source has not
          settled. Open a taxon for its details and its Wikipedia article.
        </p>
      </header>

      {state.status === 'error' && (
        <div className="mt-6">
          <Unavailable what="Taxonomy tree" source="Catalogue of Life" />
        </div>
      )}
      {state.status === 'loading' && (
        <p className="mt-6" style={{ color: 'var(--text-muted)' }}>
          Loading the tree of life…
        </p>
      )}

      {file && (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div>
            <label className="block max-w-md">
              <span className="sr-only">Search taxa</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by scientific or common name…"
                className="w-full rounded border px-3 py-1.5 text-sm"
                style={{
                  borderColor: 'var(--border)',
                  background: 'var(--surface-raised)',
                  color: 'var(--text)',
                }}
              />
            </label>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              Search covers every loaded taxon; species inside a not-yet-opened
              focus family appear once that family has been expanded.
            </p>

            {results ? (
              <ul className="mt-4" aria-label="Search results">
                {results.length === 0 && (
                  <li className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    No taxon matches “{query.trim()}”.
                  </li>
                )}
                {results.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(node.id)}
                      className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-1.5 py-1 text-left text-sm"
                      style={{
                        background:
                          selectedId === node.id
                            ? 'var(--control-selected-bg)'
                            : 'transparent',
                      }}
                    >
                      <span className="font-medium">
                        <TaxonName node={node} />
                      </span>
                      {node.common && (
                        <span style={{ color: 'var(--text-muted)' }}>
                          {capitalizeFirst(node.common)}
                        </span>
                      )}
                      <Chip>{node.rank}</Chip>
                      <span
                        className="text-xs"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {lineageOf(node)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="mt-4" aria-label="Tree of life">
                {renderNode(file.tree, 0)}
              </ul>
            )}
          </div>

          <aside className="order-first lg:order-none">
            <div
              className="rounded-xl border px-5 py-5 lg:sticky lg:top-4"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface-raised)',
              }}
            >
              {!selected ? (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Select a taxon to see its rank, lineage, name counts, and
                  links to Wikipedia and the source record.
                </p>
              ) : (
                <>
                  <h2 className="text-xl">
                    <TaxonName node={selected} />
                  </h2>
                  {selected.common && (
                    <p className="mt-0.5 text-sm" style={{ color: 'var(--text-muted)' }}>
                      {capitalizeFirst(selected.common)}
                    </p>
                  )}
                  <p className="mt-2 text-sm">
                    {capitalizeFirst(selected.rank)}
                    {selected.auth ? ` · ${selected.auth}` : ''}
                  </p>
                  {selected.desc && (
                    <p className="mt-2 text-sm">
                      {capitalizeFirst(selected.desc)}
                      <span style={{ color: 'var(--text-muted)' }}>
                        {' '}
                        — Wikidata
                      </span>
                    </p>
                  )}
                  {selected.note && (
                    <p
                      className="mt-3 rounded border px-3 py-2 text-sm"
                      style={{
                        borderColor: 'var(--border)',
                        background: 'var(--surface)',
                      }}
                    >
                      <strong style={{ fontWeight: 600 }}>Contested: </strong>
                      {selected.note}
                    </p>
                  )}
                  {selected.names > 1 && (
                    <p className="mt-3 text-sm">
                      <span className="tabular-nums">
                        {exactNumber.format(selected.names)}
                      </span>{' '}
                      <span style={{ color: 'var(--text-muted)' }}>
                        names recorded beneath this taxon in Catalogue of Life
                        {file ? ` (release ${file.release})` : ''}
                      </span>
                    </p>
                  )}
                  {(selected.truncated ||
                    focusLoaded.get(selected.id)?.truncated) && (
                    <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      The child list shown here was capped at fetch time and is
                      knowingly incomplete; the source record is complete.
                    </p>
                  )}
                  {lineage.length > 1 && (
                    <div className="mt-3">
                      <h3
                        className="font-sans text-xs font-medium uppercase tracking-widest"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Lineage
                      </h3>
                      <ol className="mt-1 text-sm">
                        {lineage.map((ancestor) => (
                          <li key={ancestor.id || 'root'}>
                            <button
                              type="button"
                              className="underline-offset-2 hover:underline"
                              onClick={() => setSelectedId(ancestor.id)}
                            >
                              <TaxonName node={ancestor} />
                            </button>{' '}
                            <span
                              className="text-xs"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {ancestor.rank}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  <div className="mt-4 flex flex-col gap-1 text-sm">
                    {selected.wiki ? (
                      <a
                        className="underline underline-offset-2"
                        href={wikipediaUrl(selected.wiki)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Wikipedia: {selected.wiki}
                      </a>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>
                        No English Wikipedia article recorded (via Wikidata).
                      </span>
                    )}
                    {selected.id && file && (
                      <a
                        className="underline underline-offset-2"
                        href={colTaxonUrl(file.col_dataset_url, selected.id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Source record in Catalogue of Life
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
