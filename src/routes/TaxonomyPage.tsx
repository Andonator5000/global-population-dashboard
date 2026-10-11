import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CollapsibleSources } from '../components/CollapsibleSources'
import { Unavailable } from '../components/viz/primitives'
import {
  Chip,
  compactNumber,
  countLabel,
  RankChip,
  TaxonName,
  TaxonThumb,
} from '../components/taxonomy/bits'
import { DetailSheet } from '../components/taxonomy/DetailSheet'
import { RankLegend } from '../components/taxonomy/RankLegend'
import { PlateGallery, TaxonPlate } from '../components/taxonomy/TaxonPlate'
import {
  liveNameSearch,
  loadExtract,
  loadGenera,
  loadLiveChildren,
  rankAccent,
  rankChipStyle,
  RANK_SOURCES,
  useTaxonomyTree,
  type LiveSearchHit,
  type TaxonNode,
} from '../lib/taxonomy'
import { capitalizeFirst } from '../lib/format'

/**
 * /taxonomy — the tree of life (Phase 5 §31; presentation rebuilt round-2
 * §39; on-demand depth, full rank system and the mobile sheet in round 3
 * §44; THE PLATE REDESIGN in round 14 §72).
 *
 * Round 14 shape, top to bottom: a dateline and the lead paragraph; one
 * toolbar (search, Tree/Cards, random); THE PLATE — the selected taxon as a
 * large picture with its lineage, name, description and apparatus, or, when
 * nothing is selected, six well-known groups as picture cards; then the
 * EXPLORER, the tree or the card grid, full width, with a picture on every
 * row; then the rank legend and the collapsed Sources block.
 *
 * What did not change: the data flow. The tree ships to family rank, a
 * family's genera come from its static genera/{id}.json when expanded, and
 * species under a genus load LIVE from ChecklistBank — the documented
 * render-time exception. Search covers the loaded static index and, when
 * that has no hit, a live Catalogue of Life name search, labelled as live.
 * On small viewports the plate also opens as a bottom sheet (§44.4).
 */

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

function findInSubtree(node: TaxonNode, id: string): TaxonNode | undefined {
  if (node.id === id) return node
  for (const child of node.children ?? []) {
    const found = findInSubtree(child, id)
    if (found) return found
  }
  return undefined
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    const list = window.matchMedia(query)
    const onChange = () => setMatches(list.matches)
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export function TaxonomyPage() {
  const state = useTaxonomyTree()
  const [view, setView] = useState<'tree' | 'cards'>('tree')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [cardRootId, setCardRootId] = useState<string>('')
  const [rankInfo, setRankInfo] = useState<string | null>(null)
  const [generaLoaded, setGeneraLoaded] = useState<Map<string, TaxonNode>>(
    () => new Map(),
  )
  const [liveLoaded, setLiveLoaded] = useState<Map<string, TaxonNode[]>>(
    () => new Map(),
  )
  const [loadErrors, setLoadErrors] = useState<Map<string, string>>(() => new Map())
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const [liveSearch, setLiveSearch] = useState<{
    query: string
    status: 'idle' | 'searching' | 'ready' | 'error'
    hits: LiveSearchHit[]
  }>({ query: '', status: 'idle', hits: [] })
  const [extract, setExtract] = useState<{
    id: string
    text: string | null
    loading: boolean
  }>({ id: '', text: null, loading: false })
  const isNarrow = useMediaQuery('(max-width: 1023px)')

  const file = state.status === 'ready' ? state.data : null

  const index = useMemo<TreeIndex>(() => {
    const built: TreeIndex = { byId: new Map(), parents: new Map() }
    if (file) {
      indexTree(file.tree, built)
      // Genera files: the family node itself stays the tree's; the file's
      // nested subfamilies/tribes/genera hang beneath it.
      for (const subtree of generaLoaded.values()) {
        for (const child of subtree.children ?? []) {
          built.parents.set(child.id, subtree.id)
          indexTree(child, built)
        }
      }
      for (const [parentId, children] of liveLoaded) {
        for (const child of children) {
          built.parents.set(child.id, parentId)
          indexTree(child, built)
        }
      }
    }
    return built
  }, [file, generaLoaded, liveLoaded])

  const selected = selectedId !== null ? index.byId.get(selectedId) : undefined

  const rankCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of index.byId.values()) {
      counts.set(node.rank, (counts.get(node.rank) ?? 0) + 1)
    }
    return counts
  }, [index])

  /** The children a node currently shows: static file children for a
      loaded family, live children when loaded, else the inline list.
      `gen` marks "this family has an on-demand genera file" even when
      the file holds zero genus-rank rows (§44.6 finding 6) — a family
      with accepted descendants but none at genus rank still expands to
      whatever its genera file holds. */
  const childrenOf = useCallback(
    (node: TaxonNode): TaxonNode[] => {
      if (node.gen !== undefined) {
        return generaLoaded.get(node.id)?.children ?? []
      }
      const live = liveLoaded.get(node.id)
      if (live) return live
      return node.children ?? []
    },
    [generaLoaded, liveLoaded],
  )

  const isExpandable = useCallback(
    (node: TaxonNode): boolean =>
      (node.children?.length ?? 0) > 0 ||
      node.gen !== undefined ||
      (node.kids !== undefined && node.kids > 0),
    [],
  )

  const needsLoad = useCallback(
    (node: TaxonNode): 'genera' | 'live' | null => {
      if (node.gen !== undefined) {
        return generaLoaded.has(node.id) ? null : 'genera'
      }
      if (liveLoaded.has(node.id)) return null
      // Static children already shipped (focus-family species, inline
      // genera) are shown as-is even when the list is capped — the
      // explicit "load all live" affordance handles the cap, not an
      // automatic live fetch that would replace the shipped list.
      if ((node.children?.length ?? 0) > 0) return null
      if (node.kids !== undefined && node.kids > 0) return 'live'
      return null
    },
    [generaLoaded, liveLoaded],
  )

  /** Drop a stale load error once its node loads successfully — a failed
      fetch, collapse, re-expand success must not keep showing the old
      error paragraph (or, in cards view, keep the retry gate shut). */
  const clearLoadError = useCallback((id: string) => {
    setLoadErrors((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  /** Resolve a node's children, loading its genera file or live list as
      needed, and commit the result to state. Returns the children. */
  const ensureChildren = useCallback(
    async (node: TaxonNode, force?: 'live'): Promise<TaxonNode[]> => {
      const kind = force ?? needsLoad(node)
      if (kind === null) return childrenOf(node)
      setLoadingIds((prev) => new Set(prev).add(node.id))
      try {
        if (kind === 'genera') {
          const subtree = await loadGenera(node.id)
          setGeneraLoaded((prev) => new Map(prev).set(node.id, subtree))
          clearLoadError(node.id)
          return subtree.children ?? []
        }
        // `truncated` describes THIS node's live list, not any one child
        // (§44.6 finding 3) — carried on the node object itself, the same
        // slot a statically-capped focus genus already uses.
        const { children, truncated } = await loadLiveChildren(node.id)
        node.truncated = truncated
        setLiveLoaded((prev) => new Map(prev).set(node.id, children))
        clearLoadError(node.id)
        return children
      } catch (error) {
        setLoadErrors((prev) =>
          new Map(prev).set(
            node.id,
            kind === 'genera'
              ? 'Could not load this family’s genera. Reload the page to retry.'
              : 'Could not reach Catalogue of Life for the live list. Check your connection and try again.',
          ),
        )
        throw error
      } finally {
        setLoadingIds((prev) => {
          const next = new Set(prev)
          next.delete(node.id)
          return next
        })
      }
    },
    [needsLoad, childrenOf, clearLoadError],
  )

  // Description text for the selected taxon, from its shard (tree nodes
  // carry Wikipedia intros and generated summaries there).
  useEffect(() => {
    if (!selected || !file?.extractShards) return
    const source = selected.descSrc
    if (selected.live || selected.pending || (source !== 'wikipedia' && source !== 'generated')) {
      setExtract({ id: selected.id, text: null, loading: false })
      return
    }
    let cancelled = false
    setExtract({ id: selected.id, text: null, loading: true })
    loadExtract(selected.id, file.extractShards)
      .then((text) => {
        if (!cancelled) setExtract({ id: selected.id, text, loading: false })
      })
      .catch(() => {
        if (!cancelled) setExtract({ id: selected.id, text: null, loading: false })
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

  const parentOf = useCallback(
    (node: TaxonNode): TaxonNode | undefined => {
      const parentId = index.parents.get(node.id)
      return parentId === undefined ? undefined : index.byId.get(parentId)
    },
    [index],
  )

  const select = useCallback(
    (node: TaxonNode) => {
      setSelectedId(node.id)
      if (isNarrow) setSheetOpen(true)
    },
    [isNarrow],
  )

  const toggle = useCallback(
    (node: TaxonNode) => {
      if (!isExpandable(node)) return
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(node.id)) next.delete(node.id)
        else next.add(node.id)
        return next
      })
      if (!expanded.has(node.id)) void ensureChildren(node).catch(() => undefined)
    },
    [isExpandable, expanded, ensureChildren],
  )

  /** Row click: select AND open (as before) — the caret alone toggles. */
  const activate = useCallback(
    (node: TaxonNode) => {
      select(node)
      if (!isExpandable(node)) return
      if (!expanded.has(node.id)) {
        setExpanded((prev) => new Set(prev).add(node.id))
        void ensureChildren(node).catch(() => undefined)
      }
    },
    [select, isExpandable, expanded, ensureChildren],
  )

  /** Select a node AND reveal it: expand every ancestor (quick-start,
      search results, random button, breadcrumbs). */
  const reveal = useCallback(
    (node: TaxonNode) => {
      select(node)
      setExpanded((prev) => {
        const next = new Set(prev)
        let cursor: string | undefined = node.id
        while (cursor !== undefined) {
          next.add(cursor)
          cursor = index.parents.get(cursor)
        }
        return next
      })
      if (isExpandable(node)) void ensureChildren(node).catch(() => undefined)
      if (view === 'cards') {
        setCardRootId(
          isExpandable(node) ? node.id : (index.parents.get(node.id) ?? ''),
        )
      }
      setQuery('')
    },
    [index, select, isExpandable, ensureChildren, view],
  )

  /** A live search hit: walk its classification from the deepest ancestor
      the static index knows, loading genera files and live children down
      to the hit, then reveal it. */
  const revealLive = useCallback(
    async (hit: LiveSearchHit) => {
      const chain = hit.classification
      if (chain.length === 0 || chain[chain.length - 1]?.id !== hit.id) {
        chain.push({ id: hit.id, name: hit.name, rank: hit.rank })
      }
      let position = chain.length - 1
      while (position >= 0 && !index.byId.has(chain[position]!.id)) position -= 1
      if (position < 0) return
      let current = index.byId.get(chain[position]!.id)!
      const opened: string[] = [current.id]
      for (let step = position; step < chain.length - 1; step += 1) {
        const nextId = chain[step + 1]!.id
        let children = await ensureChildren(current)
        let next = children.find((child) => child.id === nextId)
        if (!next && current.truncated) {
          children = await ensureChildren(current, 'live')
          next = children.find((child) => child.id === nextId)
        }
        if (!next) {
          // The file nests intermediate ranks the classification may
          // skip. Search the subtree THIS load just returned — not
          // `generaLoaded` state, which on a first-reveal (the genera
          // file load a few lines up) is still the pre-click snapshot
          // this closure captured, not the load that just landed.
          for (const candidate of children) {
            next = findInSubtree(candidate, nextId)
            if (next) break
          }
        }
        if (!next) break
        opened.push(next.id)
        current = next
      }
      setExpanded((prev) => {
        const next = new Set(prev)
        let cursor: string | undefined = opened[0]
        while (cursor !== undefined) {
          next.add(cursor)
          cursor = index.parents.get(cursor)
        }
        for (const id of opened) next.add(id)
        return next
      })
      setSelectedId(current.id)
      if (isNarrow) setSheetOpen(true)
      setQuery('')
    },
    [index, ensureChildren, isNarrow],
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

  // Live Catalogue of Life name search, debounced, for names the static
  // index does not hold (species and below).
  const searchAbort = useRef<AbortController | null>(null)
  useEffect(() => {
    const needle = query.trim()
    searchAbort.current?.abort()
    if (needle.length < 3 || (results?.length ?? 0) >= 60) {
      setLiveSearch({ query: needle, status: 'idle', hits: [] })
      return
    }
    const controller = new AbortController()
    searchAbort.current = controller
    setLiveSearch({ query: needle, status: 'searching', hits: [] })
    const timer = window.setTimeout(() => {
      liveNameSearch(needle, controller.signal)
        .then((hits) => {
          if (controller.signal.aborted) return
          setLiveSearch({
            query: needle,
            status: 'ready',
            hits: hits.filter((hit) => !index.byId.has(hit.id)),
          })
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setLiveSearch({ query: needle, status: 'error', hits: [] })
          }
        })
    }, 350)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
    // The static index is only consulted to drop duplicates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, results?.length])

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

  const loadLiveList = useCallback(
    (node: TaxonNode) => {
      void ensureChildren(node, 'live').catch(() => undefined)
      setExpanded((prev) => new Set(prev).add(node.id))
    },
    [ensureChildren],
  )

  /**
   * The plate sits ABOVE the explorer, so selecting a taxon forty rows down
   * a desktop tree would change a panel the reader cannot see — the same
   * complaint §44.4 fixed on phones with the bottom sheet, and the one
   * thing the old sticky aside did better. If the plate is less than half
   * in view when the selection changes, bring it to the reader (and honour
   * prefers-reduced-motion by jumping instead of gliding). On compact
   * viewports the sheet already does this, so the effect stands down.
   */
  const plateRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selectedId === null || isNarrow) return
    const element = plateRef.current
    if (!element) return
    const box = element.getBoundingClientRect()
    const shown =
      Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0)
    if (shown > Math.min(box.height, window.innerHeight) * 0.5) return
    element.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
      block: 'start',
    })
  }, [selectedId, isNarrow])

  const quickStart = useMemo(() => {
    if (!file) return []
    const wanted = new Map<string, string>(
      QUICK_START.map(([label, name]) => [name, label]),
    )
    const found = new Map<string, TaxonNode>()
    for (const node of index.byId.values()) {
      const label = wanted.get(node.name)
      if (label !== undefined && !found.has(node.name)) found.set(node.name, node)
      if (found.size === wanted.size) break
    }
    return QUICK_START.flatMap(([label, name]) => {
      const node = found.get(name)
      return node ? [{ label, node }] : []
    })
  }, [file, index])

  /** One tree row: a picture, the name, its rank and counts. The caret
      alone toggles; the row selects and opens. Rows are >=44px tall and
      the carets >=44px wide on touch — Andy reads this on a phone. */
  function renderNode(node: TaxonNode, depth: number): React.ReactNode {
    const children = childrenOf(node)
    const expandable = isExpandable(node)
    const isOpen = expanded.has(node.id)
    const isSelected = selectedId === node.id
    const loading = loadingIds.has(node.id)
    const error = loadErrors.get(node.id)
    const pendingKind = isOpen && children.length === 0 && !error ? needsLoad(node) : null
    const liveList = liveLoaded.has(node.id)
    const count = countLabel(node)

    return (
      <li key={node.id || 'root'}>
        <div
          className="tax-row flex items-stretch rounded-sm"
          style={{
            background: isSelected ? 'var(--control-selected-bg)' : 'transparent',
            color: isSelected ? 'var(--control-selected-text)' : 'var(--text)',
          }}
        >
          <button
            type="button"
            onClick={() => toggle(node)}
            aria-expanded={expandable ? isOpen : undefined}
            aria-label={expandable ? `${isOpen ? 'Collapse' : 'Expand'} ${node.name}` : undefined}
            tabIndex={expandable ? 0 : -1}
            className="flex w-8 shrink-0 items-center justify-center self-stretch font-sans text-xs"
            style={{
              color: isSelected ? 'var(--control-selected-text)' : 'var(--text-muted)',
              visibility: expandable ? 'visible' : 'hidden',
              minHeight: 44,
            }}
          >
            <span
              aria-hidden="true"
              className="inline-block"
              style={{
                transform: isOpen ? 'rotate(90deg)' : 'none',
                transition: 'transform 150ms ease',
              }}
            >
              ▸
            </span>
          </button>
          <button
            type="button"
            onClick={() => activate(node)}
            aria-current={isSelected ? 'true' : undefined}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm py-1 pr-2 text-left text-sm"
            style={{ minHeight: 44 }}
          >
            <span
              className="shrink-0 overflow-hidden rounded-sm"
              style={{ boxShadow: `0 0 0 1px ${rankAccent(node.rank)}` }}
            >
              <TaxonThumb node={node} slot="row" />
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="min-w-0 break-words font-medium">
                <TaxonName node={node} />
              </span>
              {node.common && (
                <span
                  style={{
                    color: isSelected
                      ? 'var(--control-selected-text)'
                      : 'var(--text-muted)',
                  }}
                >
                  {capitalizeFirst(node.common)}
                </span>
              )}
              <RankChip rank={node.rank} />
              {count && (
                <span
                  className="font-sans text-xs tabular-nums"
                  style={{
                    color: isSelected
                      ? 'var(--control-selected-text)'
                      : 'var(--text-muted)',
                  }}
                >
                  {count}
                </span>
              )}
              {node.note && <Chip tone="flag">contested</Chip>}
              {node.provisional && <Chip>provisional</Chip>}
              {node.extinct && <Chip title="Catalogue of Life marks this taxon extinct">extinct</Chip>}
              {node.truncated && !liveList && <Chip>list capped</Chip>}
              {node.live && <Chip title="Loaded live from Catalogue of Life">live</Chip>}
              {node.pending && <Chip title="Wikipedia not looked up yet">not yet enriched</Chip>}
            </span>
          </button>
        </div>
        {isOpen && (
          <ul className={`tax-branch${depth >= 7 ? ' tax-branch-flat' : ''}`}>
            {(loading || pendingKind) && !error && (
              <li className="py-1.5 pl-2 text-xs" style={{ color: 'var(--text-muted)' }} aria-live="polite">
                {pendingKind === 'live' || (loading && !liveLoaded.has(node.id) && node.gen === undefined)
                  ? 'Loading live from Catalogue of Life…'
                  : 'Loading genera…'}
              </li>
            )}
            {error && (
              <li className="py-1.5 pl-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                {error}
              </li>
            )}
            {children.map((child) => renderNode(child, depth + 1))}
            {children.length > 0 && node.truncated && !liveList && (
              <li className="py-1.5 pl-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                Static list capped at {children.length}.{' '}
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => loadLiveList(node)}
                >
                  Load all {node.kids ?? ''} live from Catalogue of Life
                </button>
              </li>
            )}
            {children.length > 0 && node.truncated && liveList && (
              <li className="py-1.5 pl-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                Live list capped at {children.length}; the rest is on the
                Catalogue of Life record.
              </li>
            )}
            {!loading && !pendingKind && !error && children.length === 0 && (
              <li className="py-1.5 pl-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                No genus-rank children recorded in Catalogue of Life for this
                taxon.
              </li>
            )}
          </ul>
        )}
      </li>
    )
  }

  function renderCards() {
    const root = index.byId.get(cardRootId) ?? file?.tree
    if (!root) return null
    const children = childrenOf(root)
    const pendingKind = children.length === 0 ? needsLoad(root) : null
    if (pendingKind && !loadingIds.has(root.id) && !loadErrors.has(root.id)) {
      void ensureChildren(root).catch(() => undefined)
    }
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
        <nav
          aria-label="Explorer path"
          className="tax-rail -mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1 text-sm"
        >
          {crumbs.map((node, position) => (
            <span key={node.id || 'root'} className="flex shrink-0 items-center gap-1">
              {position > 0 && (
                <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>
                  ›
                </span>
              )}
              <button
                type="button"
                className="whitespace-nowrap rounded-sm border px-2 py-1 font-sans text-xs"
                style={{ ...rankChipStyle(node.rank), color: 'var(--text)', minHeight: 32 }}
                onClick={() => {
                  setCardRootId(node.id)
                  select(node)
                }}
              >
                <TaxonName node={node} />
              </button>
            </span>
          ))}
        </nav>
        {pendingKind && !loadErrors.has(root.id) && (
          <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }} aria-live="polite">
            {pendingKind === 'live' ? 'Loading live from Catalogue of Life…' : 'Loading genera…'}
          </p>
        )}
        {loadErrors.has(root.id) && (
          <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
            {loadErrors.get(root.id)}{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => void ensureChildren(root).catch(() => undefined)}
            >
              Retry
            </button>
          </p>
        )}
        <ul className="mt-3 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {children.map((child) => {
            const expandableChild = isExpandable(child)
            const label = countLabel(child)
            const isSelected = selectedId === child.id
            return (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => {
                    select(child)
                    if (expandableChild) {
                      setCardRootId(child.id)
                      void ensureChildren(child).catch(() => undefined)
                    }
                  }}
                  className="tax-card block w-full overflow-hidden rounded-sm border text-left"
                  style={{
                    borderColor: isSelected ? 'var(--supernova)' : 'var(--border)',
                    boxShadow: isSelected ? '0 0 0 2px var(--supernova)' : 'var(--shadow-card)',
                    background: 'var(--surface-raised)',
                  }}
                >
                  <TaxonThumb node={child} slot="card" />
                  <div
                    aria-hidden="true"
                    className="h-[2px] w-full"
                    style={{ background: rankAccent(child.rank) }}
                  />
                  <div className="px-2.5 py-2">
                    <p className="truncate text-sm font-medium">
                      <TaxonName node={child} />
                    </p>
                    <p className="mt-0.5 truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                      {child.common ? capitalizeFirst(child.common) : ' '}
                    </p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <RankChip rank={child.rank} />
                      {label && (
                        <span
                          className="font-sans text-[11px] tabular-nums"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {label}
                        </span>
                      )}
                      {child.live && <Chip>live</Chip>}
                    </p>
                  </div>
                </button>
              </li>
            )
          })}
          {children.length === 0 && !pendingKind && (
            <li className="col-span-full text-sm" style={{ color: 'var(--text-muted)' }}>
              No further subdivisions here — see the plate above.
            </li>
          )}
        </ul>
      </div>
    )
  }

  const detailProps =
    file && selected
      ? {
          node: selected,
          parent: parentOf(selected),
          lineage,
          file,
          extract: extract.id === selected.id ? extract.text : null,
          extractLoading: extract.id === selected.id && extract.loading,
          onReveal: reveal,
          onRankInfo: setRankInfo,
          onLoadLive: loadLiveList,
          liveLoaded: liveLoaded.has(selected.id),
        }
      : null

  const sourceCount =
    (file?.imageSources?.length ?? 0) + 4 + RANK_SOURCES.length

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <p
          className="font-sans text-[10px] uppercase tracking-[0.18em]"
          style={{ color: 'var(--text-muted)' }}
        >
          The tree of life
          {file ? ` · Catalogue of Life, release ${file.release}` : ''}
        </p>
        <h1 className="mt-1 tracking-tight">Taxonomy</h1>
        <p className="mt-3 max-w-3xl text-[0.95rem] leading-relaxed">
          Every described organism, as the{' '}
          <a
            className="underline underline-offset-2"
            href={file?.col_dataset_url ?? 'https://www.checklistbank.org/'}
            target="_blank"
            rel="noreferrer"
          >
            Catalogue of Life
          </a>{' '}
          records it: the three domains down to family in one tree,
          {file?.generaTotal
            ? ` ${compactNumber.format(file.generaTotal)} genera in ${compactNumber.format(file.generaFiles ?? 0)} family files loaded on demand,`
            : ''}{' '}
          and species fetched live when a genus is opened.
        </p>
        <p
          className="mt-1.5 max-w-3xl text-xs leading-snug"
          style={{ color: 'var(--text-muted)' }}
        >
          Disputed placements are marked <em>contested</em> — the tree
          follows its source rather than settling arguments the source has
          not settled. Every picture is freely licensed and credited; a
          taxon with none says so.
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

      {/* `taxonomy-main` wraps everything the bottom sheet makes inert while
          it is open (§44.4) — it must be the whole page body, not one strip
          of it. */}
      {file && (
        <div id="taxonomy-main">
          {/* ---- toolbar ------------------------------------------------ */}
          <div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
            <label className="order-first min-w-0 flex-1 basis-full sm:order-none sm:max-w-md sm:basis-72">
              <span className="sr-only">Search taxa</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by scientific or common name…"
                className="w-full rounded-sm border px-3 text-sm"
                style={{
                  borderColor: 'var(--border-strong)',
                  background: 'var(--surface-raised)',
                  color: 'var(--text)',
                  minHeight: 40,
                }}
              />
            </label>
            <fieldset className="flex items-center gap-1.5">
              <legend className="sr-only">View</legend>
              {(['tree', 'cards'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={view === value}
                  onClick={() => {
                    setView(value)
                    if (value === 'cards') {
                      const node = selectedId !== null ? index.byId.get(selectedId) : undefined
                      setCardRootId(
                        node && isExpandable(node)
                          ? node.id
                          : (index.parents.get(selectedId ?? '') ?? ''),
                      )
                    }
                  }}
                  className="rounded-sm border px-3"
                  style={{
                    borderColor: view === value ? 'var(--supernova)' : 'var(--border-strong)',
                    background: view === value ? 'var(--control-selected-bg)' : 'transparent',
                    color: view === value ? 'var(--control-selected-text)' : 'inherit',
                    minHeight: 40,
                  }}
                >
                  {value === 'tree' ? 'Tree' : 'Cards'}
                </button>
              ))}
            </fieldset>
            <button
              type="button"
              onClick={randomTaxon}
              className="rounded-sm border px-3"
              style={{ borderColor: 'var(--border-strong)', minHeight: 40 }}
            >
              Random taxon
            </button>
          </div>

          {/* ---- the plate ---------------------------------------------- */}
          <div ref={plateRef} className="mt-5 scroll-mt-4">
            {detailProps ? (
              <TaxonPlate layout="plate" {...detailProps} />
            ) : (
              <PlateGallery
                entries={quickStart}
                onPick={reveal}
                note={
                  'Pictures are free-licensed only — the taxon’s own Wikidata or Wikipedia photo first, then its Wikimedia Commons category, then GBIF occurrence media, iNaturalist, and finally a PhyloPic silhouette, always labelled as a silhouette. A taxon with no picture of its own borrows a photographed member’s, labelled “Representative”; a taxon with none at all says so. Nothing here is AI-generated.'
                }
              />
            )}
          </div>

          {/* ---- the explorer ------------------------------------------- */}
          <section className="mt-8">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="font-display text-xl">
                {results ? 'Search results' : view === 'tree' ? 'The tree' : 'Explorer'}
              </h2>
              {!results && (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {view === 'tree'
                    ? 'Tap a caret to open a branch, a name to open its plate.'
                    : 'Tap a card to go a level deeper.'}
                </p>
              )}
            </div>
            <div
              className="mt-3 rounded-lg border px-2 py-2 sm:px-4 sm:py-3"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface-raised)',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              {results ? (
                <div>
                  <ul aria-label="Search results" className="list-none p-0">
                    {results.length === 0 && liveSearch.status !== 'searching' && liveSearch.hits.length === 0 && (
                      <li className="px-1 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                        No taxon matches “{query.trim()}” in the loaded tree
                        {liveSearch.status === 'ready' ? ' or in the live Catalogue of Life search.' : '.'}
                      </li>
                    )}
                    {results.map((node) => (
                      <li key={node.id}>
                        <button
                          type="button"
                          onClick={() => reveal(node)}
                          className="tax-row flex w-full items-center gap-2.5 rounded-sm px-1 py-1 text-left text-sm"
                          style={{ minHeight: 44 }}
                        >
                          <span
                            className="shrink-0 overflow-hidden rounded-sm"
                            style={{ boxShadow: `0 0 0 1px ${rankAccent(node.rank)}` }}
                          >
                            <TaxonThumb node={node} slot="row" />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                            <span className="font-medium">
                              <TaxonName node={node} />
                            </span>
                            {node.common && (
                              <span style={{ color: 'var(--text-muted)' }}>
                                {capitalizeFirst(node.common)}
                              </span>
                            )}
                            <RankChip rank={node.rank} />
                            <span className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                              {lineageOf(node)}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {liveSearch.status !== 'idle' && (
                    <section className="mt-3" aria-label="Live Catalogue of Life search">
                      <h3
                        className="font-sans text-[10px] font-medium uppercase tracking-widest"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Live from Catalogue of Life
                        {liveSearch.status === 'searching' ? ' — searching…' : ''}
                      </h3>
                      {liveSearch.status === 'error' && (
                        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                          The live search could not reach ChecklistBank.
                        </p>
                      )}
                      {liveSearch.status === 'ready' && liveSearch.hits.length === 0 && results.length > 0 && (
                        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
                          No further matches beyond the loaded tree.
                        </p>
                      )}
                      <ul className="mt-1 list-none p-0">
                        {liveSearch.hits.map((hit) => (
                          <li key={hit.id}>
                            <button
                              type="button"
                              onClick={() => void revealLive(hit)}
                              className="tax-row flex w-full flex-wrap items-baseline gap-x-2 rounded-sm px-1.5 py-1 text-left text-sm"
                              style={{ minHeight: 44 }}
                            >
                              <span className="font-medium">
                                {hit.rank === 'species' || hit.rank === 'subspecies' || hit.rank === 'genus' ? (
                                  <i>{hit.name}</i>
                                ) : (
                                  hit.name
                                )}
                              </span>
                              {hit.common && (
                                <span style={{ color: 'var(--text-muted)' }}>
                                  {capitalizeFirst(hit.common)}
                                </span>
                              )}
                              <RankChip rank={hit.rank} />
                              <Chip>live</Chip>
                              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {hit.classification
                                  .slice(0, -1)
                                  .map((ancestor) => ancestor.name)
                                  .join(' › ')}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </div>
              ) : view === 'tree' ? (
                <ul className="list-none p-0" aria-label="Tree of life">
                  {renderNode(file.tree, 0)}
                </ul>
              ) : (
                renderCards()
              )}
            </div>
          </section>

          {/* ---- rank legend -------------------------------------------- */}
          <section className="mt-6">
            <RankLegend
              rankCounts={rankCounts}
              rankInfoOpen={rankInfo}
              onRankInfo={setRankInfo}
            />
          </section>

          {/* ---- sources, collapsed ------------------------------------- */}
          <div className="mt-8">
            <CollapsibleSources
              count={sourceCount}
              label="Sources — the tree, the pictures and the rank system"
            >
              <p className="mb-2 max-w-3xl text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                {file.imageNote}
              </p>
              <ul className="list-none space-y-1 p-0 text-xs">
                <li>
                  <a className="underline underline-offset-2" href={file.col_dataset_url} target="_blank" rel="noreferrer">
                    {file.source}
                  </a>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}· release {file.release} · CC BY 4.0 — the backbone,
                    the counts and the live species lists
                  </span>
                </li>
                <li>
                  <a className="underline underline-offset-2" href="https://www.wikidata.org/wiki/Property:P10585" target="_blank" rel="noreferrer">
                    Wikidata (P10585 Catalogue of Life ID, P225 taxon name)
                  </a>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}· CC0 — Wikipedia links, common names, NCBI/OTT ids,
                    first appearance
                  </span>
                </li>
                <li>
                  <a className="underline underline-offset-2" href="https://en.wikipedia.org/" target="_blank" rel="noreferrer">
                    English Wikipedia intro extracts
                  </a>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}· CC BY-SA 4.0
                    {file.extractsRetrieved ? ` · retrieved ${file.extractsRetrieved}` : ''}
                  </span>
                </li>
                {(file.imageSources ?? []).map((source) => (
                  <li key={source.url}>
                    <a className="underline underline-offset-2" href={source.url} target="_blank" rel="noreferrer">
                      {source.label}
                    </a>
                    <span style={{ color: 'var(--text-muted)' }}> · {source.licence}</span>
                  </li>
                ))}
                <li>
                  <a className="underline underline-offset-2" href="https://api.checklistbank.org" target="_blank" rel="noreferrer">
                    ChecklistBank API (live species lists and name search)
                  </a>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {' '}· CC BY 4.0 · the one render-time fetch on this page
                  </span>
                </li>
                {RANK_SOURCES.map((source) => (
                  <li key={source.url}>
                    <a className="underline underline-offset-2" href={source.url} target="_blank" rel="noreferrer">
                      {source.label}
                    </a>
                  </li>
                ))}
              </ul>
            </CollapsibleSources>
          </div>
        </div>
      )}

      {file && selected && detailProps && (
        <DetailSheet
          open={isNarrow && sheetOpen}
          title={`${selected.rank} · ${selected.name}`}
          rank={selected.rank}
          onClose={() => setSheetOpen(false)}
        >
          <TaxonPlate layout="sheet" {...detailProps} />
        </DetailSheet>
      )}
    </div>
  )
}
