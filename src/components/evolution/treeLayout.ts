/**
 * Layout for the tree of life through time (round 14, DATA_DECISIONS §73).
 *
 * Pure functions, no DOM: the component hands in the nodes, the set of
 * collapsed lineages and the stage size, and gets back every branch as
 * coordinates. Nothing here is hand-placed -- change the reference file
 * and the picture follows.
 *
 * TIME SCALE. A linear axis for four billion years would squeeze the whole
 * Phanerozoic -- every animal, plant and fungus a reader recognises --
 * into the right-hand sixth of the chart. The axis is therefore
 * PIECEWISE LINEAR between the ICS eon/era boundaries, each segment given
 * a share of the axis roughly in proportion to how much of the tree it
 * carries: Archean 14%, Proterozoic 22%, Palaeozoic 16%, Mesozoic 24%,
 * Cenozoic 24%. The ICS eon and era strips drawn under the axis make the
 * compression visible, and the chart says so in words.
 *
 * ROWS. Each visible tip (an extant or extinct lineage, or a collapsed
 * clade) takes one row. A lineage with visible children is drawn as a
 * STEM from its origin to its last split, lying between the rows of its
 * children; the children peel off the stem at their own origin ages. To
 * keep branches from crossing, the children of a stem are ordered by age
 * with the OLDEST SPLIT OUTERMOST, alternating above and below the stem
 * (a split that happens earlier must reach a row farther away, or a
 * later split's curve would cut through its line). This is the only
 * ordering rule; sibling groups therefore stay adjacent automatically.
 */

import type { TreeNode } from '../../lib/evolution'

/** Breakpoints (Ma -> axis fraction); older on the left. */
export const TIME_BREAKS: ReadonlyArray<readonly [number, number]> = [
  [4000, 0],
  [2500, 0.14],
  [541, 0.36],
  [252, 0.52],
  [66, 0.76],
  [0, 1],
]

export const TIME_START_MA = TIME_BREAKS[0]![0]

/** Fraction of the axis length for an age, 0 = 4 Ga, 1 = today. */
export function timeFraction(ma: number): number {
  const clamped = Math.min(TIME_START_MA, Math.max(0, ma))
  for (let i = 1; i < TIME_BREAKS.length; i++) {
    const [ma0, f0] = TIME_BREAKS[i - 1]!
    const [ma1, f1] = TIME_BREAKS[i]!
    if (clamped <= ma0 && clamped >= ma1) {
      return f0 + ((ma0 - clamped) / (ma0 - ma1)) * (f1 - f0)
    }
  }
  return 1
}

export interface TreeIndex {
  byId: Map<string, TreeNode>
  children: Map<string, TreeNode[]>
  depth: Map<string, number>
  /** Leaves beneath each node with nothing collapsed. */
  leafCount: Map<string, number>
}

export function indexTree(nodes: TreeNode[], rootId: string): TreeIndex {
  const byId = new Map<string, TreeNode>()
  const children = new Map<string, TreeNode[]>()
  for (const node of nodes) byId.set(node.id, node)
  for (const node of nodes) {
    if (node.parent === null) continue
    const list = children.get(node.parent) ?? []
    list.push(node)
    children.set(node.parent, list)
  }
  const depth = new Map<string, number>()
  const leafCount = new Map<string, number>()
  const walk = (id: string, d: number): number => {
    depth.set(id, d)
    const kids = children.get(id) ?? []
    let leaves = 0
    for (const kid of kids) leaves += walk(kid.id, d + 1)
    const count = kids.length === 0 ? 1 : leaves
    leafCount.set(id, count)
    return count
  }
  if (byId.has(rootId)) walk(rootId, 0)
  return { byId, children, depth, leafCount }
}

/** Ancestors from the root down to (and excluding) the node. */
export function ancestorsOf(index: TreeIndex, id: string): TreeNode[] {
  const out: TreeNode[] = []
  let current = index.byId.get(id)?.parent ?? null
  while (current !== null) {
    const node = index.byId.get(current)
    if (!node) break
    out.unshift(node)
    current = node.parent
  }
  return out
}

/**
 * The default collapse for a row budget: start with only the root
 * expanded and keep opening the folded clade that hides the MOST lineages
 * (ties: the shallower one) while its children still fit the budget.
 * Opening costs (children - 1) rows, so a chain of single-child clades
 * costs nothing and the big groups -- animals, plants -- open first; the
 * small deep-branching groups stay folded as one row each. Deterministic,
 * so the same stage always opens the same way.
 */
export function autoCollapse(index: TreeIndex, rootId: string, rowBudget: number): Set<string> {
  const collapsed = new Set<string>()
  for (const [id, kids] of index.children) if (kids.length > 0) collapsed.add(id)
  if (!index.byId.has(rootId)) return collapsed
  let rows = 1
  collapsed.delete(rootId)
  rows += (index.children.get(rootId)?.length ?? 0) - 1
  const queue = [...(index.children.get(rootId) ?? [])]
  const order = (a: TreeNode, b: TreeNode) =>
    (index.leafCount.get(b.id) ?? 0) - (index.leafCount.get(a.id) ?? 0) ||
    (index.depth.get(a.id) ?? 0) - (index.depth.get(b.id) ?? 0)
  while (queue.length > 0) {
    queue.sort(order)
    const next = queue.shift()!
    const kids = index.children.get(next.id) ?? []
    if (kids.length === 0) continue
    const delta = kids.length - 1
    if (rows + delta > rowBudget) continue
    rows += delta
    collapsed.delete(next.id)
    queue.push(...kids)
  }
  return collapsed
}

export interface LaidBranch {
  node: TreeNode
  /** Row lane: tips sit at row centres (n + 0.5), stems on the boundary between their children's blocks. */
  lane: number
  /** Axis fraction of the origin. */
  t0: number
  /** Axis fraction where the drawn line ends: the last visible split, or today / the extinction. */
  t1: number
  /** True when drawn as a tip (a leaf, or a collapsed clade). */
  tip: boolean
  collapsed: boolean
  /** Leaves hidden inside a collapsed tip. */
  hidden: number
  parentLane: number | null
  depth: number
}

export interface TreeLayout {
  branches: LaidBranch[]
  byId: Map<string, LaidBranch>
  rows: number
}

/** Rows and axis fractions for the visible tree. */
export function layoutTree(index: TreeIndex, rootId: string, collapsed: Set<string>): TreeLayout {
  const branches: LaidBranch[] = []
  const byId = new Map<string, LaidBranch>()
  const root = index.byId.get(rootId)
  if (!root) return { branches, byId, rows: 0 }

  const visibleKids = (id: string): TreeNode[] =>
    collapsed.has(id) ? [] : (index.children.get(id) ?? [])

  const place = (node: TreeNode, startRow: number, parentLane: number | null): { rows: number; lane: number } => {
    const kids = visibleKids(node.id)
    const depth = index.depth.get(node.id) ?? 0
    if (kids.length === 0) {
      const lane = startRow + 0.5
      const isCollapsed = collapsed.has(node.id) && (index.children.get(node.id)?.length ?? 0) > 0
      const branch: LaidBranch = {
        node,
        lane,
        t0: timeFraction(node.originMa),
        t1: timeFraction(node.status === 'extinct' && node.extinctMa !== null ? node.extinctMa : 0),
        tip: true,
        collapsed: isCollapsed,
        hidden: isCollapsed ? (index.leafCount.get(node.id) ?? 1) : 0,
        parentLane,
        depth,
      }
      branches.push(branch)
      byId.set(node.id, branch)
      return { rows: 1, lane }
    }
    // Oldest split outermost, alternating sides (see the header comment).
    const ordered = [...kids].sort((a, b) => b.originMa - a.originMa)
    const above: TreeNode[] = []
    const below: TreeNode[] = []
    ordered.forEach((kid, i) => (i % 2 === 0 ? above : below).push(kid))
    below.reverse()
    // The stem is laid out after its children, but its record must come
    // first in the branch order so lines draw parent-before-child.
    const stem: LaidBranch = {
      node,
      lane: 0,
      t0: timeFraction(node.originMa),
      t1: timeFraction(Math.min(...kids.map((k) => k.originMa))),
      tip: false,
      collapsed: false,
      hidden: 0,
      parentLane,
      depth,
    }
    branches.push(stem)
    byId.set(node.id, stem)
    let cursor = startRow
    let lane: number
    if (kids.length === 1) {
      const only = place(kids[0]!, cursor, null)
      cursor += only.rows
      lane = only.lane
      byId.get(kids[0]!.id)!.parentLane = lane
    } else {
      const placedAbove: string[] = []
      for (const kid of above) {
        const r = place(kid, cursor, null)
        cursor += r.rows
        placedAbove.push(kid.id)
      }
      lane = cursor
      const placedBelow: string[] = []
      for (const kid of below) {
        const r = place(kid, cursor, null)
        cursor += r.rows
        placedBelow.push(kid.id)
      }
      for (const id of [...placedAbove, ...placedBelow]) byId.get(id)!.parentLane = lane
    }
    stem.lane = lane
    return { rows: cursor - startRow, lane }
  }

  const { rows } = place(root, 0, null)
  return { branches, byId, rows }
}

/** The visible branch that stands for a node: itself, or its nearest collapsed ancestor. */
export function visibleBranchFor(index: TreeIndex, layout: TreeLayout, id: string): LaidBranch | null {
  let current: string | null = id
  while (current !== null) {
    const branch = layout.byId.get(current)
    if (branch) return branch
    current = index.byId.get(current)?.parent ?? null
  }
  return null
}

/** Approximate rendered width of a label, in px, for the sans at `size` px. */
export function textWidth(text: string, size: number): number {
  let w = 0
  for (const ch of text) {
    if (ch === ' ') w += 0.28
    else if (/[iljtf.,'()]/.test(ch)) w += 0.3
    else if (/[mwMW]/.test(ch)) w += 0.85
    else if (/[A-Z]/.test(ch)) w += 0.68
    else w += 0.55
  }
  return w * size
}
