import { useCallback, useEffect, useMemo, useState } from 'react'

import { Unavailable } from '../components/viz/primitives'
import {
  baseRank,
  colTaxonUrl,
  ITALIC_RANKS,
  lifemapUrl,
  loadExtract,
  loadFocusFamily,
  oneZoomUrl,
  RANK_HUES,
  rankChipStyle,
  rankDefinition,
  useTaxonomyTree,
  wikipediaUrl,
  type TaxonNode,
} from '../lib/taxonomy'
import { capitalizeFirst } from '../lib/format'

/**
 * /taxonomy — the tree of life (Phase 5; presentation rebuilt round-2 §39).
 *
 * Two views over the same lazily loaded data: the collapsible TREE (one
 * button per visible row) and a CARD EXPLORER (a taxon's children as
 * image cards). Ranks are colour-coded — chips, panel, legend — with the
 * text token on tinted grounds so hue never carries contrast. Photos are
 * licence-gated Commons images resolved in the ETL; taxa without one get
 * a placeholder silhouette. Intro texts load per-shard on selection.
 */

const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const exactNumber = new Intl.NumberFormat('en')

const QUICK_START = [
  ['Mammals', 'Mammalia'],
  ['Birds', 'Aves'],
  ['Insects', 'Insecta'],
  ['Flowering plants', 'Magnoliopsida'],
  ['Fungi', 'Fungi'],
  ['Bacteria', 'Bacteria'],
] as const

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

function RankChip({
  rank,
  onInfo,
}: {
  rank: string
  /** When set, the chip is a real button that shows the rank's
      definition (round-2 feedback). Omit inside row/card buttons —
      nested buttons are invalid HTML. */
  onInfo?: (rank: string) => void
}) {
  if (onInfo) {
    return (
      <button
        type="button"
        className="cursor-pointer rounded border px-1 py-px font-sans text-[10px] leading-tight"
        style={{ ...rankChipStyle(rank), color: 'var(--text)' }}
        onClick={() => onInfo(rank)}
        title={`What is a ${rank}?`}
      >
        {rank}
      </button>
    )
  }
  return (
    <span
      className="rounded border px-1 py-px font-sans text-[10px] leading-tight"
      style={{ ...rankChipStyle(rank), color: 'var(--text)' }}
    >
      {rank}
    </span>
  )
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

/** Placeholder for taxa with no verifiably free photo (§39). */
function PlaceholderSilhouette({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      style={{ color: 'var(--text-muted)' }}
    >
      <g stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round">
        <path d="M24 42V20" />
        <path d="M24 30c-6-2-10-7-10-14" />
        <path d="M24 26c5-2 9-6 9-12" />
        <circle cx="14" cy="14" r="3" fill="currentColor" stroke="none" />
        <circle cx="33" cy="12" r="3" fill="currentColor" stroke="none" />
        <circle cx="24" cy="18" r="3" fill="currentColor" stroke="none" />
      </g>
    </svg>
  )
}

function TaxonThumb({
  node,
  size,
}: {
  node: TaxonNode
  size: 'card' | 'panel'
}) {
  const img = node.img ?? null
  const classes =
    size === 'card'
      ? 'h-24 w-full rounded-t-lg object-cover'
      : 'h-40 w-full rounded-lg object-cover'
  if (!img) {
    return (
      <div
        className={`${classes} flex items-center justify-center`}
        style={{ background: 'var(--surface-sunken)' }}
      >
        <PlaceholderSilhouette className={size === 'card' ? 'h-12 w-12' : 'h-20 w-20'} />
      </div>
    )
  }
  return <img src={img.url} alt={node.name} loading="lazy" className={classes} />
}

export function TaxonomyPage() {
  const state = useTaxonomyTree()
  const [view, setView] = useState<'tree' | 'cards'>('tree')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [cardRootId, setCardRootId] = useState<string>('')
  const [rankInfo, setRankInfo] = useState<string | null>(null)
  const [focusLoaded, setFocusLoaded] = useState<Map<string, TaxonNode>>(
    () => new Map(),
  )
  const [focusErrors, setFocusErrors] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [extract, setExtract] = useState<{ id: string; text: string | null }>({
    id: '',
    text: null,
  })

  const file = state.status === 'ready' ? state.data : null

  const index = useMemo<TreeIndex>(() => {
    const built: TreeIndex = { byId: new Map(), parents: new Map() }
    if (file) {
      indexTree(file.tree, built)
      for (const subtree of focusLoaded.values()) {
        const parent = built.parents.get(subtree.id)
        indexTree(subtree, built)
        if (parent) built.parents.set(subtree.id, parent)
      }
    }
    return built
  }, [file, focusLoaded])

  const selected = selectedId !== null ? index.byId.get(selectedId) : undefined

  /** Every rank present in the loaded data, canonical ladder order first
      (by hue-table position of the base rank), then alphabetical. */
  const allRanks = useMemo(() => {
    const seen = new Set<string>()
    for (const node of index.byId.values()) seen.add(node.rank)
    seen.delete('root')
    const ladder = Object.keys(RANK_HUES)
    return [...seen].sort((a, b) => {
      const da = ladder.indexOf(baseRank(a))
      const db = ladder.indexOf(baseRank(b))
      return da - db || a.localeCompare(b)
    })
  }, [index])

  // Intro text for the selected taxon, from its shard (round-2 §39).
  useEffect(() => {
    if (!selected || !file?.extractShards) return
    let cancelled = false
    setExtract({ id: selected.id, text: null })
    loadExtract(selected.id, file.extractShards)
      .then((text) => {
        if (!cancelled) setExtract({ id: selected.id, text })
      })
      .catch(() => {
        if (!cancelled) setExtract({ id: selected.id, text: null })
      })
    return () => {
      cancelled = true
    }
  }, [selected, file?.extractShards])

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

  const ensureFocus = useCallback(
    (node: TaxonNode) => {
      if (node.focus && !focusLoaded.has(node.id)) {
        loadFocusFamily(node.id)
          .then((subtree) =>
            setFocusLoaded((prev) => new Map(prev).set(node.id, subtree)),
          )
          .catch(() => setFocusErrors((prev) => new Set(prev).add(node.id)))
      }
    },
    [focusLoaded],
  )

  const activate = useCallback(
    (node: TaxonNode) => {
      setSelectedId(node.id)
      const expandable = (node.children?.length ?? 0) > 0 || node.focus === true
      if (!expandable) return
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(node.id)) next.delete(node.id)
        else next.add(node.id)
        return next
      })
      ensureFocus(node)
    },
    [ensureFocus],
  )

  /** Select a node AND reveal it: expand every ancestor (quick-start,
      search results, random button, breadcrumbs). */
  const reveal = useCallback(
    (node: TaxonNode) => {
      setSelectedId(node.id)
      setExpanded((prev) => {
        const next = new Set(prev)
        let cursor: string | undefined = node.id
        while (cursor !== undefined) {
          next.add(cursor)
          cursor = index.parents.get(cursor)
        }
        return next
      })
      ensureFocus(node)
      if (view === 'cards') {
        setCardRootId(index.parents.get(node.id) ?? '')
      }
      setQuery('')
    },
    [index, ensureFocus, view],
  )

  const randomTaxon = useCallback(() => {
    const ids = [...index.byId.keys()]
    const id = ids[Math.floor(Math.random() * ids.length)]
    const node = id !== undefined ? index.byId.get(id) : undefined
    if (node) reveal(node)
  }, [index, reveal])

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
      if (starts.length >= 60) break
    }
    return [...starts, ...contains].slice(0, 60)
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
          <RankChip rank={node.rank} />
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

  function renderCards() {
    const root = index.byId.get(cardRootId) ?? file?.tree
    if (!root) return null
    const subtree = root.focus ? focusLoaded.get(root.id) : undefined
    const children = subtree?.children ?? root.children ?? []
    const crumbs: TaxonNode[] = []
    let cursor: string | undefined = root.id
    while (cursor !== undefined) {
      const node = index.byId.get(cursor)
      if (!node) break
      crumbs.unshift(node)
      cursor = index.parents.get(cursor)
    }
    return (
      <div>
        <nav aria-label="Explorer path" className="flex flex-wrap items-center gap-1 text-sm">
          {crumbs.map((node, position) => (
            <span key={node.id || 'root'} className="flex items-center gap-1">
              {position > 0 && (
                <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>
                  ›
                </span>
              )}
              <button
                type="button"
                className="rounded border px-1.5 py-0.5 font-sans text-xs"
                style={rankChipStyle(node.rank)}
                onClick={() => {
                  setCardRootId(node.id)
                  setSelectedId(node.id)
                }}
              >
                <TaxonName node={node} />
              </button>
            </span>
          ))}
        </nav>
        {root.focus && !subtree && !focusErrors.has(root.id) && (
          <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
            Loading genera and species…
          </p>
        )}
        <ul className="mt-3 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 xl:grid-cols-4">
          {children.map((child) => {
            const expandableChild =
              (child.children?.length ?? 0) > 0 || child.focus === true
            return (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(child.id)
                    ensureFocus(child)
                    if (expandableChild) setCardRootId(child.id)
                  }}
                  className="block w-full rounded-lg border text-left"
                  style={{
                    borderColor:
                      selectedId === child.id
                        ? 'var(--accent)'
                        : 'var(--border)',
                    background: 'var(--surface-raised)',
                    boxShadow: 'var(--shadow-card)',
                  }}
                >
                  <TaxonThumb node={child} size="card" />
                  <div className="px-2.5 py-2">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      <TaxonName node={child} />
                      <RankChip rank={child.rank} />
                    </p>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {child.common
                        ? capitalizeFirst(child.common)
                        : child.names > 1
                          ? `${compactNumber.format(child.names)} names`
                          : ' '}
                    </p>
                  </div>
                </button>
              </li>
            )
          })}
          {children.length === 0 && (
            <li className="col-span-full text-sm" style={{ color: 'var(--text-muted)' }}>
              No further subdivisions here — see the detail panel.
            </li>
          )}
        </ul>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Taxonomy</h1>
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
          down to every family, with genus and species depth for well-known
          groups. Disputed placements are marked <em>contested</em> — the
          tree follows its source rather than settling arguments the source
          has not settled.
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
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <fieldset className="flex items-center gap-2">
                <legend className="sr-only">View</legend>
                {(['tree', 'cards'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={view === value}
                    onClick={() => {
                      setView(value)
                      if (value === 'cards') {
                        setCardRootId(
                          selectedId !== null &&
                            (index.byId.get(selectedId)?.children?.length ||
                              index.byId.get(selectedId)?.focus)
                            ? selectedId
                            : (index.parents.get(selectedId ?? '') ?? ''),
                        )
                      }
                    }}
                    className="rounded border px-2.5 py-1"
                    style={{
                      borderColor: 'var(--border)',
                      background:
                        view === value
                          ? 'var(--control-selected-bg)'
                          : 'transparent',
                      color:
                        view === value
                          ? 'var(--control-selected-text)'
                          : 'inherit',
                    }}
                  >
                    {value === 'tree' ? 'Tree' : 'Cards'}
                  </button>
                ))}
              </fieldset>
              <label className="min-w-48 flex-1">
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
              <button
                type="button"
                onClick={randomTaxon}
                className="rounded border px-2.5 py-1"
                style={{ borderColor: 'var(--border)' }}
              >
                Random taxon
              </button>
            </div>

            {/* Quick-start + persistent rank legend (round-2 §39). */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span style={{ color: 'var(--text-muted)' }}>Start from:</span>
              {QUICK_START.map(([label, name]) => (
                <button
                  key={name}
                  type="button"
                  className="rounded border px-1.5 py-0.5 font-sans"
                  style={{ borderColor: 'var(--border)' }}
                  onClick={() => {
                    for (const node of index.byId.values()) {
                      if (node.name === name) {
                        reveal(node)
                        break
                      }
                    }
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div
              className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]"
              aria-label="Rank colour legend"
            >
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Ranks (click one for its definition):
              </span>
              {Object.keys(RANK_HUES)
                .filter((rank) => rank !== 'root')
                .map((rank) => (
                  <RankChip key={rank} rank={rank} onInfo={setRankInfo} />
                ))}
            </div>
            {rankInfo && (
              <div
                className="mt-2 flex items-start gap-2 rounded border px-3 py-2 text-xs leading-snug"
                style={{
                  borderColor: 'var(--border)',
                  background: 'var(--surface-sunken)',
                }}
                role="note"
              >
                <RankChip rank={rankInfo} />
                <span className="min-w-0 flex-1">{rankDefinition(rankInfo)}</span>
                <button
                  type="button"
                  aria-label="Close rank definition"
                  className="shrink-0 rounded px-1 font-sans"
                  style={{ color: 'var(--text-muted)' }}
                  onClick={() => setRankInfo(null)}
                >
                  ×
                </button>
              </div>
            )}
            <details className="mt-2 text-xs">
              <summary
                className="cursor-pointer font-sans"
                style={{ color: 'var(--text-muted)' }}
              >
                Every rank used on this page ({allRanks.length}), defined
              </summary>
              <dl className="mt-2 space-y-1.5">
                {allRanks.map((rank) => (
                  <div key={rank} className="flex items-start gap-2">
                    <dt className="shrink-0">
                      <RankChip rank={rank} />
                    </dt>
                    <dd className="m-0 leading-snug" style={{ color: 'var(--text-muted)' }}>
                      {rankDefinition(rank)}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>

            {results ? (
              <ul className="mt-4" aria-label="Search results">
                {results.length === 0 && (
                  <li className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    No taxon matches “{query.trim()}”. Species inside focus
                    families appear once that family has been opened.
                  </li>
                )}
                {results.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      onClick={() => reveal(node)}
                      className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-1.5 py-1 text-left text-sm"
                    >
                      <span className="font-medium">
                        <TaxonName node={node} />
                      </span>
                      {node.common && (
                        <span style={{ color: 'var(--text-muted)' }}>
                          {capitalizeFirst(node.common)}
                        </span>
                      )}
                      <RankChip rank={node.rank} />
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {lineageOf(node)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : view === 'tree' ? (
              <ul className="mt-4" aria-label="Tree of life">
                {renderNode(file.tree, 0)}
              </ul>
            ) : (
              <div className="mt-4">{renderCards()}</div>
            )}
          </div>

          <aside className="order-first lg:order-none">
            <div
              className="rounded-xl border px-5 py-5 lg:sticky lg:top-4"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface-raised)',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              {!selected ? (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Select a taxon for its photo, description, rank, lineage and
                  links. {file.imageNote ?? ''}
                </p>
              ) : (
                <>
                  <div
                    className="-mx-5 -mt-5 mb-3 rounded-t-xl border-b-4 px-5 pb-2 pt-3"
                    style={{
                      borderColor: `light-dark(oklch(70% 0.09 ${RANK_HUES[baseRank(selected.rank)] ?? 250}), oklch(55% 0.09 ${RANK_HUES[baseRank(selected.rank)] ?? 250}))`,
                    }}
                  >
                    <h2 className="text-xl">
                      <TaxonName node={selected} />
                    </h2>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm">
                      <RankChip rank={selected.rank} onInfo={setRankInfo} />
                      {selected.common && (
                        <span style={{ color: 'var(--text-muted)' }}>
                          {capitalizeFirst(selected.common)}
                        </span>
                      )}
                      {selected.auth && (
                        <span style={{ color: 'var(--text-muted)' }}>
                          {selected.auth}
                        </span>
                      )}
                    </p>
                  </div>

                  <TaxonThumb node={selected} size="panel" />
                  {selected.img && (
                    <p className="mt-1 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                      {selected.img.rep && (
                        <>
                          Representative: <i>{selected.img.rep}</i> ·{' '}
                        </>
                      )}
                      {selected.img.author ?? 'Unknown author'} ·{' '}
                      <a
                        className="underline underline-offset-2"
                        href={selected.img.page}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Commons
                      </a>{' '}
                      · {selected.img.license}
                    </p>
                  )}

                  {extract.id === selected.id && extract.text ? (
                    <p className="mt-3 text-sm">
                      {extract.text.length > 620
                        ? `${extract.text.slice(0, 600).trimEnd()}…`
                        : extract.text}
                      {file.extractsRetrieved && selected.wiki && (
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {' '}
                          — Wikipedia, retrieved {file.extractsRetrieved}
                        </span>
                      )}
                    </p>
                  ) : selected.desc ? (
                    <p className="mt-3 text-sm">
                      {capitalizeFirst(selected.desc)}
                      <span style={{ color: 'var(--text-muted)' }}> — Wikidata</span>
                    </p>
                  ) : null}

                  {selected.note && (
                    <p
                      className="mt-3 rounded border px-3 py-2 text-sm"
                      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                    >
                      <strong style={{ fontWeight: 600 }}>Contested: </strong>
                      {selected.note}
                    </p>
                  )}

                  <dl className="mt-3 space-y-1 text-sm">
                    {selected.names > 1 && (
                      <div className="flex justify-between gap-3">
                        <dt style={{ color: 'var(--text-muted)' }}>
                          Names in Catalogue of Life
                        </dt>
                        <dd className="tabular-nums">
                          {exactNumber.format(selected.names)}
                        </dd>
                      </div>
                    )}
                    {selected.firstMa !== undefined && (
                      <div className="flex justify-between gap-3">
                        <dt style={{ color: 'var(--text-muted)' }}>
                          First appearance (Wikidata)
                        </dt>
                        <dd className="tabular-nums">
                          ~{selected.firstMa} Ma
                        </dd>
                      </div>
                    )}
                  </dl>

                  <p
                    className="mt-3 rounded px-3 py-2 text-xs leading-snug"
                    style={{ background: 'var(--surface-sunken)', color: 'var(--text-muted)' }}
                  >
                    {rankDefinition(selected.rank)}
                  </p>

                  {lineage.length > 1 && (
                    <div className="mt-3">
                      <h3
                        className="font-sans text-xs font-medium uppercase tracking-widest"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Lineage
                      </h3>
                      <nav
                        aria-label="Lineage breadcrumbs"
                        className="mt-1 flex flex-wrap items-center gap-1"
                      >
                        {lineage.map((ancestor, position) => (
                          <span key={ancestor.id || 'root'} className="flex items-center gap-1">
                            {position > 0 && (
                              <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>
                                ›
                              </span>
                            )}
                            <button
                              type="button"
                              className="rounded border px-1.5 py-0.5 font-sans text-xs"
                              style={rankChipStyle(ancestor.rank)}
                              onClick={() => reveal(ancestor)}
                            >
                              <TaxonName node={ancestor} />
                            </button>
                          </span>
                        ))}
                      </nav>
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
                    {selected.id && (
                      <a
                        className="underline underline-offset-2"
                        href={colTaxonUrl(file.col_dataset_url, selected.id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Source record in Catalogue of Life
                      </a>
                    )}
                    <a
                      className="underline underline-offset-2"
                      href={oneZoomUrl(selected.name)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View on OneZoom
                    </a>
                    {selected.ncbi && (
                      <a
                        className="underline underline-offset-2"
                        href={lifemapUrl(selected.ncbi)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View on Lifemap
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
