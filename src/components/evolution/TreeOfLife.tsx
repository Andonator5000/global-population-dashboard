import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { select } from 'd3-selection'
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom'

import {
  formatAgeShort,
  type EvolutionChart,
  type EvolutionTreeFile,
  type TreeBand,
  type TreeNode,
} from '../../lib/evolution'
import { LineageCard } from './LineageCard'
import {
  ancestorsOf,
  autoCollapse,
  indexTree,
  layoutTree,
  textWidth,
  timeFraction,
  TIME_START_MA,
  visibleBranchFor,
  type LaidBranch,
} from './treeLayout'

/**
 * The tree of life through time (round 14, DATA_DECISIONS §73).
 *
 * One SVG rendered from data/biology/evolution/tree.json: time along the
 * main axis from 4 billion years ago to today (piecewise-linear, see
 * treeLayout.ts), one row per visible lineage, smooth branches peeling off
 * their parent stem at the age the lineage arose, extinct lines ending in
 * a bar at their last appearance, the two endosymbioses drawn as dashed
 * merges, the five mass extinctions and the Great Oxidation Event as
 * bands, and the ICS eons and eras as colour strips under the axis.
 *
 * On a wide stage time runs left to right inside a fixed-height viewport
 * with wheel/pinch zoom and drag pan (d3-zoom on the svg, the transform
 * written straight to the plot group -- no React render per frame). On a
 * phone the same layout turns on its side: time runs DOWN the page, rows
 * run across it, and the svg is in flow so the page scrolls as usual;
 * there is no horizontal scroll, because the tree opens collapsed to the
 * major groups and every tip expands on tap.
 *
 * Nothing here is hand-placed. Which clades start collapsed is decided
 * by the row budget the stage can show legibly (autoCollapse), and the
 * reader can open or fold any clade.
 */

/** Row pitch: 22 px for horizontal rows (11 px text), 17 px for the rotated labels of the phone layout. */
const ROW_H = 22
const ROW_V = 17
// The label side of each margin (right / bottom) is measured from the
// visible tip labels at layout time; these are the fixed parts.
const MARGIN_H = { left: 14, right: 24, top: 60, bottom: 62 }
const MARGIN_V = { left: 52, right: 12, top: 18, bottom: 24 }
const VERTICAL_PLOT_LENGTH = 1040
const ELBOW_PX = 26
const TIP_FONT = 11
const STEM_FONT = 9.5
const TICKS_MA = [4000, 3000, 2500, 2000, 1000, 541, 252, 66, 0]

type Orientation = 'horizontal' | 'vertical'

interface Props {
  tree: EvolutionTreeFile
  chart: EvolutionChart | null
  reducedMotion: boolean
}

interface PlotFrame {
  orientation: Orientation
  width: number
  height: number
  /** Axis length in px and the row offset of the first row. */
  axisLength: number
  margin: { left: number; right: number; top: number; bottom: number }
  rows: number
  row: number
}

/** Plot-space point from an axis fraction and a row lane. */
function point(frame: PlotFrame, t: number, lane: number): [number, number] {
  if (frame.orientation === 'horizontal') {
    return [frame.margin.left + t * frame.axisLength, frame.margin.top + lane * frame.row]
  }
  return [frame.margin.left + lane * frame.row, frame.margin.top + t * frame.axisLength]
}

function branchPath(frame: PlotFrame, b: LaidBranch): string {
  const [x1, y1] = point(frame, b.t1, b.lane)
  if (b.parentLane === null) {
    const [x0, y0] = point(frame, b.t0, b.lane)
    return `M${x0},${y0}L${x1},${y1}`
  }
  const [sx, sy] = point(frame, b.t0, b.parentLane)
  const elbow = Math.min(ELBOW_PX, Math.max(2, ((b.t1 - b.t0) * frame.axisLength) / 2))
  const tElbow = b.t0 + elbow / frame.axisLength
  const [ex, ey] = point(frame, tElbow, b.lane)
  if (frame.orientation === 'horizontal') {
    const mx = (sx + ex) / 2
    return `M${sx},${sy}C${mx},${sy} ${mx},${ey} ${ex},${ey}L${x1},${y1}`
  }
  const my = (sy + ey) / 2
  return `M${sx},${sy}C${sx},${my} ${ex},${my} ${ex},${ey}L${x1},${y1}`
}

function useStageWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setWidth(Math.max(0, el.clientWidth))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

function viewportHeightFor(): number {
  if (typeof window === 'undefined') return 640
  return Math.round(Math.min(820, Math.max(440, window.innerHeight * 0.78)))
}

export default function TreeOfLife({ tree, chart, reducedMotion }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const plotRef = useRef<SVGGElement | null>(null)
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)
  const transformRef = useRef(zoomIdentity)
  const width = useStageWidth(stageRef)
  const orientation: Orientation = width >= 720 ? 'horizontal' : 'vertical'
  const [viewportH, setViewportH] = useState(viewportHeightFor)
  useEffect(() => {
    const onResize = () => setViewportH(viewportHeightFor())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const index = useMemo(() => indexTree(tree.nodes, tree.root), [tree])

  // ---- collapse state ------------------------------------------------------
  const margin = orientation === 'horizontal' ? MARGIN_H : MARGIN_V
  const rowBudget =
    orientation === 'horizontal'
      ? Math.max(8, Math.floor((viewportH - margin.top - margin.bottom) / ROW_H))
      : Math.max(6, Math.floor((width - margin.left - margin.right) / ROW_V))
  const autoSet = useMemo(() => autoCollapse(index, tree.root, rowBudget), [index, tree.root, rowBudget])
  const [userCollapsed, setUserCollapsed] = useState<Set<string> | null>(null)
  const collapsed = userCollapsed ?? autoSet

  const toggle = useCallback(
    (id: string) => {
      setUserCollapsed((prev) => {
        const next = new Set(prev ?? autoSet)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    [autoSet],
  )
  const revealPathTo = useCallback(
    (id: string) => {
      setUserCollapsed((prev) => {
        const next = new Set(prev ?? autoSet)
        for (const a of ancestorsOf(index, id)) next.delete(a.id)
        return next
      })
    },
    [autoSet, index],
  )
  const expandAll = useCallback(() => setUserCollapsed(new Set()), [])
  const resetCollapse = useCallback(() => setUserCollapsed(null), [])

  // ---- layout --------------------------------------------------------------
  const layout = useMemo(() => layoutTree(index, tree.root, collapsed), [index, tree.root, collapsed])
  const rows = Math.max(layout.rows, 1)
  /** Room the extant tip labels need beyond the axis end, measured. */
  const labelRoom = useMemo(() => {
    let room = 0
    for (const b of layout.branches) {
      if (!b.tip || b.node.status === 'extinct') continue
      const text = `${b.node.name}${b.collapsed ? ` +${b.hidden}` : ''}`
      room = Math.max(room, 12 + (b.node.image ? 22 : 0) + textWidth(text, TIP_FONT))
    }
    return Math.ceil(room) + 14
  }, [layout])
  const frame: PlotFrame = useMemo(() => {
    if (orientation === 'horizontal') {
      const margin = { ...MARGIN_H, right: MARGIN_H.right + labelRoom }
      const axisLength = Math.max(200, width - margin.left - margin.right)
      return {
        orientation,
        width,
        height: margin.top + rows * ROW_H + margin.bottom,
        axisLength,
        margin,
        rows,
        row: ROW_H,
      }
    }
    // Vertical: when the reader opens more clades than the width holds,
    // the row pitch tightens first (down to 12 px, the rotated 11 px
    // labels' floor) and only then does the stage scroll sideways.
    const margin = { ...MARGIN_V, bottom: MARGIN_V.bottom + labelRoom }
    const row = Math.max(12, Math.min(ROW_V, (width - margin.left - margin.right) / rows))
    return {
      orientation,
      width: Math.max(width, Math.ceil(margin.left + rows * row + margin.right)),
      height: margin.top + VERTICAL_PLOT_LENGTH + margin.bottom,
      axisLength: VERTICAL_PLOT_LENGTH,
      margin,
      rows,
      row,
    }
  }, [orientation, width, rows, labelRoom])
  const svgHeight = orientation === 'horizontal' ? viewportH : frame.height
  const rowExtent = rows * frame.row

  // ---- selection, hover, search -------------------------------------------
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const focusId = hovered ?? selected
  const pathSet = useMemo(() => {
    if (!focusId) return new Set<string>()
    const set = new Set<string>([focusId])
    for (const a of ancestorsOf(index, focusId)) set.add(a.id)
    return set
  }, [focusId, index])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    return tree.nodes
      .filter((n) => n.name.toLowerCase().includes(q) || (n.scientific ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.name.length - b.name.length)
      .slice(0, 8)
  }, [query, tree.nodes])

  // ---- zoom (horizontal only) ----------------------------------------------
  const applyTransform = useCallback(() => {
    const g = plotRef.current
    if (!g) return
    const t = transformRef.current
    g.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`)
  }, [])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    if (orientation !== 'horizontal') {
      transformRef.current = zoomIdentity
      applyTransform()
      zoomRef.current = null
      select(svg).on('.zoom', null)
      return
    }
    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.35, 5])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        transformRef.current = event.transform
        applyTransform()
      })
    zoomRef.current = behaviour
    select(svg).call(behaviour)
    return () => {
      select(svg).on('.zoom', null)
    }
  }, [orientation, applyTransform])

  useEffect(() => {
    const svg = svgRef.current
    const behaviour = zoomRef.current
    if (!svg || !behaviour || orientation !== 'horizontal') return
    const pad = 160
    behaviour.translateExtent([
      [-pad, -pad],
      [width + pad, frame.height + pad],
    ])
    behaviour.extent([
      [0, 0],
      [width, viewportH],
    ])
  }, [width, frame.height, viewportH, orientation])

  const fit = useCallback(() => {
    const svg = svgRef.current
    const behaviour = zoomRef.current
    if (!svg || !behaviour) return
    const k = Math.min(1, viewportH / frame.height)
    const ty = (viewportH - frame.height * k) / 2
    const tx = (width - width * k) / 2
    select(svg).call(behaviour.transform, zoomIdentity.translate(tx, ty).scale(k))
  }, [viewportH, frame.height, width])

  const zoomBy = useCallback((factor: number) => {
    const svg = svgRef.current
    const behaviour = zoomRef.current
    if (!svg || !behaviour) return
    select(svg).call(behaviour.scaleBy, factor)
  }, [])

  /** Pan so a lineage sits in view (horizontal mode). */
  const panTo = useCallback(
    (id: string) => {
      const svg = svgRef.current
      const behaviour = zoomRef.current
      if (!svg || !behaviour || orientation !== 'horizontal') return
      const branch = visibleBranchFor(index, layout, id)
      if (!branch) return
      const [, y] = point(frame, branch.t1, branch.lane)
      const k = Math.max(transformRef.current.k, 1)
      const ty = viewportH / 2 - y * k
      const tx = (width - width * k) / 2
      select(svg).call(behaviour.transform, zoomIdentity.translate(tx, ty).scale(k))
    },
    [frame, index, layout, orientation, viewportH, width],
  )

  // When the stage fits again after a fold, settle back to identity.
  const prevRows = useRef(rows)
  useEffect(() => {
    if (prevRows.current !== rows) {
      prevRows.current = rows
      if (orientation === 'horizontal' && frame.height <= viewportH) {
        const svg = svgRef.current
        const behaviour = zoomRef.current
        if (svg && behaviour) select(svg).call(behaviour.transform, zoomIdentity)
      }
    }
  }, [rows, frame.height, viewportH, orientation])

  const pendingPan = useRef<string | null>(null)
  useEffect(() => {
    if (pendingPan.current) {
      const id = pendingPan.current
      pendingPan.current = null
      panTo(id)
    }
  }, [layout, panTo])

  const choose = useCallback(
    (id: string, reveal: boolean) => {
      setSelected(id)
      if (reveal) {
        revealPathTo(id)
        pendingPan.current = id
      }
    },
    [revealPathTo],
  )

  const onBranchActivate = useCallback(
    (b: LaidBranch) => {
      setSelected(b.node.id)
      // A collapsed tip opens on activation: one tap, one step deeper.
      if (b.collapsed) toggle(b.node.id)
    },
    [toggle],
  )

  // ---- derived drawing data ------------------------------------------------
  const eons = useMemo(
    () => (chart?.intervals ?? []).filter((i) => i.rank === 'Eon' && i.endMa < TIME_START_MA),
    [chart],
  )
  const eras = useMemo(
    () => (chart?.intervals ?? []).filter((i) => i.rank === 'Era' && i.endMa < TIME_START_MA),
    [chart],
  )

  const bandLabels = useMemo(() => {
    // Band captions alternate between two label rows when they would collide.
    const placed: { band: TreeBand; row: number; a: number }[] = []
    const ends: number[] = [-Infinity, -Infinity, -Infinity]
    const sorted = [...tree.bands].sort((a, b) => b.startMa - a.startMa)
    for (const band of sorted) {
      const a = timeFraction(band.startMa) * frame.axisLength
      const w = textWidth(band.name, 10) + 8
      let row = 0
      while (row < 2 && ends[row]! > a) row += 1
      ends[row] = a + w
      placed.push({ band, row, a })
    }
    return placed
  }, [tree.bands, frame.axisLength])

  const merges = useMemo(() => {
    const out: { from: LaidBranch; to: LaidBranch; label: string; key: string }[] = []
    for (const b of layout.branches) {
      for (const m of b.node.merges ?? []) {
        const donor = visibleBranchFor(index, layout, m.from)
        if (!donor || donor.node.id === b.node.id) continue
        out.push({ from: donor, to: b, label: m.label, key: `${m.from}->${b.node.id}` })
      }
    }
    return out
  }, [layout, index])

  const selectedNode: TreeNode | null = selected ? (index.byId.get(selected) ?? null) : null
  const groupKeys = Object.keys(tree.groups) as (keyof typeof tree.groups)[]
  const horizontal = orientation === 'horizontal'

  // ---- render helpers ------------------------------------------------------
  const stemLabelX = useMemo(() => {
    const placed = new Map<string, number>()
    if (!horizontal) return placed
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = []
    const half = TIP_FONT * 0.7
    for (const b of layout.branches) {
      if (!b.tip || b.node.status !== 'extinct') continue
      const [ex, ey] = point(frame, b.t1, b.lane)
      const w = 9 + (b.node.image ? 20 : 0) + textWidth(`\u2020 ${b.node.name}`, TIP_FONT)
      boxes.push({ x0: ex, x1: ex + w, y0: ey - half, y1: ey + half })
    }
    const stems = layout.branches
      .filter((b) => !b.tip)
      .sort((a, b) => a.t0 - b.t0 || a.depth - b.depth)
    const axisEnd = frame.margin.left + frame.axisLength
    for (const b of stems) {
      const start = (b.parentLane === null ? 0 : ELBOW_PX * 0.6) + 6
      const w = textWidth(b.node.name, STEM_FONT)
      const y = point(frame, 0, b.lane)[1]
      const y0 = y - STEM_FONT * 0.6
      const y1 = y + STEM_FONT * 0.6
      let x = point(frame, b.t0, b.lane)[0] + start
      let ok = false
      while (x + w <= axisEnd - 4) {
        const hit = boxes.find((bx) => x < bx.x1 + 4 && x + w + 4 > bx.x0 && y0 < bx.y1 && y1 > bx.y0)
        if (!hit) {
          ok = true
          break
        }
        x = hit.x1 + 6
      }
      if (!ok) continue
      boxes.push({ x0: x, x1: x + w, y0, y1 })
      placed.set(b.node.id, x)
    }
    return placed
  }, [layout, frame, horizontal])

  const renderBranch = (b: LaidBranch) => {
    const inPath = pathSet.has(b.node.id)
    const dimmed = focusId !== null && !inPath
    const colour = `var(--tol-${b.node.group})`
    const [ex, ey] = point(frame, b.t1, b.lane)
    const [ox, oy] = point(frame, b.t0, b.parentLane ?? b.lane)
    const extinct = b.node.status === 'extinct'
    const d = branchPath(frame, b)
    const label = b.node.name
    // A clade's name rides ON its stem (a halo masks the line beneath it,
    // the way a river label sits on a river) and may run on past a short
    // stem along the empty lane between its children's blocks, as long as
    // it ends before the axis does. Horizontal stages only: on a phone the
    // rows are 22 px columns and the card's breadcrumb carries the names.
    const stemLabelAt = stemLabelX.get(b.node.id)
    const ariaLabel =
      `${b.node.name}, ${b.node.status === 'extinct' ? 'extinct' : 'living'} lineage, arose ${formatAgeShort(b.node.originMa)}` +
      (b.collapsed ? `, ${b.hidden} lineages folded inside, activate to open` : '')
    return (
      <g
        key={b.node.id}
        className={`tol-branch${inPath ? ' is-path' : ''}${dimmed ? ' is-dimmed' : ''}${b.tip ? ' is-tip' : ''}`}
        data-id={b.node.id}
      >
        {inPath && <path d={d} className="tol-path-glow" />}
        <path d={d} className="tol-line" style={{ stroke: colour }} strokeWidth={inPath ? 3 : 1.7} />
        {/* The split point: where this lineage leaves its parent. */}
        {b.parentLane !== null && (
          <circle cx={ox} cy={oy} r={inPath ? 3.2 : 2.2} className="tol-split" style={{ fill: colour }} />
        )}
        {b.tip && extinct && (
          horizontal ? (
            <line x1={ex} x2={ex} y1={ey - 5} y2={ey + 5} className="tol-end" style={{ stroke: colour }} />
          ) : (
            <line x1={ex - 5} x2={ex + 5} y1={ey} y2={ey} className="tol-end" style={{ stroke: colour }} />
          )
        )}
        {b.tip && b.collapsed && (
          horizontal ? (
            <path d={`M${ex},${ey - 5}L${ex + 7},${ey}L${ex},${ey + 5}Z`} className="tol-fold" style={{ fill: colour }} />
          ) : (
            <path d={`M${ex - 5},${ey}L${ex},${ey + 7}L${ex + 5},${ey}Z`} className="tol-fold" style={{ fill: colour }} />
          )
        )}
        {b.tip && renderTipLabel(b, ex, ey, extinct)}
        {stemLabelAt !== undefined && (
          <text
            x={stemLabelAt}
            y={point(frame, 0, b.lane)[1]}
            dominantBaseline="middle"
            fontSize={STEM_FONT}
            className="tol-stem-label"
          >
            {label}
          </text>
        )}
        <path
          d={d}
          className="tol-hit"
          role="button"
          tabIndex={0}
          aria-label={ariaLabel}
          aria-pressed={selected === b.node.id}
          onClick={() => onBranchActivate(b)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onBranchActivate(b)
            }
          }}
          onMouseEnter={() => setHovered(b.node.id)}
          onMouseLeave={() => setHovered((h) => (h === b.node.id ? null : h))}
          onFocus={() => setHovered(b.node.id)}
          onBlur={() => setHovered((h) => (h === b.node.id ? null : h))}
        >
          <title>
            {b.node.name} — arose {formatAgeShort(b.node.originMa)}
            {extinct && b.node.extinctMa !== null ? `, extinct ${formatAgeShort(b.node.extinctMa)}` : ''}
          </title>
        </path>
      </g>
    )
  }

  const renderTipLabel = (b: LaidBranch, ex: number, ey: number, extinct: boolean) => {
    const img = b.node.image
    const text = `${extinct ? '† ' : ''}${b.node.name}`
    const foldText = b.collapsed ? ` +${b.hidden}` : ''
    const offset = b.collapsed ? 12 : extinct ? 9 : 6
    if (horizontal) {
      const imgW = img ? 20 : 0
      return (
        <g className={`tol-tip-label${extinct ? ' is-extinct' : ''}`}>
          {img && (
            <image
              href={img.url}
              x={ex + offset}
              y={ey - 9}
              width={18}
              height={18}
              preserveAspectRatio="xMidYMid meet"
              className="tol-silhouette"
              aria-hidden="true"
            />
          )}
          <text x={ex + offset + imgW} y={ey} dominantBaseline="middle" fontSize={TIP_FONT}>
            {text}
            {foldText && <tspan className="tol-fold-count">{foldText}</tspan>}
          </text>
        </g>
      )
    }
    // Vertical: the label hangs below the tip, reading downward.
    const imgH = img ? 22 : 0
    return (
      <g className={`tol-tip-label${extinct ? ' is-extinct' : ''}`} transform={`translate(${ex},${ey + offset})`}>
        {img && (
          <image
            href={img.url}
            x={-9}
            y={0}
            width={18}
            height={18}
            preserveAspectRatio="xMidYMid meet"
            className="tol-silhouette"
            aria-hidden="true"
          />
        )}
        <text transform={`translate(0,${imgH}) rotate(90)`} dominantBaseline="middle" fontSize={TIP_FONT}>
          {text}
          {foldText && <tspan className="tol-fold-count">{foldText}</tspan>}
        </text>
      </g>
    )
  }

  const renderBands = () =>
    bandLabels.map(({ band, row }) => {
      const a0 = timeFraction(band.startMa) * frame.axisLength
      const a1 = Math.max(timeFraction(band.endMa) * frame.axisLength, a0 + 3)
      const extinction = band.kind === 'extinction'
      if (horizontal) {
        const x = frame.margin.left + a0
        return (
          <g key={band.id} className={`tol-band${extinction ? ' is-extinction' : ''}`}>
            <rect x={x} y={frame.margin.top - 6} width={a1 - a0} height={rowExtent + 12} />
            <text x={x + (a1 - a0) / 2} y={frame.margin.top - 14 - row * 12} textAnchor="middle" fontSize={10}>
              {band.name}
            </text>
            <title>{band.summary}</title>
          </g>
        )
      }
      const y = frame.margin.top + a0
      return (
        <g key={band.id} className={`tol-band${extinction ? ' is-extinction' : ''}`}>
          <rect x={frame.margin.left - 6} y={y} width={rowExtent + 12} height={a1 - a0} />
          <text x={frame.margin.left + rowExtent + 4} y={y - 3} textAnchor="end" fontSize={9}>
            {band.name}
          </text>
          <title>{band.summary}</title>
        </g>
      )
    })

  const renderAxis = () => {
    const strip = (intervals: typeof eons, offset: number, thickness: number, font: number) =>
      intervals.map((iv) => {
        const a0 = timeFraction(Math.min(iv.startMa, TIME_START_MA)) * frame.axisLength
        const a1 = timeFraction(iv.endMa) * frame.axisLength
        const len = a1 - a0
        const fits = textWidth(iv.name, font) + 6 <= len
        if (horizontal) {
          const x = frame.margin.left + a0
          const y = frame.margin.top + rowExtent + offset
          return (
            <g key={iv.id}>
              <rect x={x} y={y} width={len} height={thickness} fill={iv.color ?? 'var(--border)'} />
              {fits && (
                <text x={x + len / 2} y={y + thickness / 2} textAnchor="middle" dominantBaseline="middle" fontSize={font} className="tol-ics-label">
                  {iv.name}
                </text>
              )}
              <title>{`${iv.name} (${iv.rank}): ${formatAgeShort(iv.startMa)} to ${formatAgeShort(iv.endMa)}`}</title>
            </g>
          )
        }
        const y = frame.margin.top + a0
        const x = frame.margin.left - offset - thickness
        return (
          <g key={iv.id}>
            <rect x={x} y={y} width={thickness} height={len} fill={iv.color ?? 'var(--border)'} />
            {fits && (
              <text
                transform={`translate(${x + thickness / 2},${y + len / 2}) rotate(-90)`}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={font}
                className="tol-ics-label"
              >
                {iv.name}
              </text>
            )}
            <title>{`${iv.name} (${iv.rank}): ${formatAgeShort(iv.startMa)} to ${formatAgeShort(iv.endMa)}`}</title>
          </g>
        )
      })
    const ticks = TICKS_MA.map((ma) => {
      const a = timeFraction(ma) * frame.axisLength
      if (horizontal) {
        const x = frame.margin.left + a
        const y = frame.margin.top + rowExtent + 36
        return (
          <g key={ma} className="tol-tick">
            <line x1={x} x2={x} y1={y} y2={y + 4} />
            <text x={x} y={y + 14} textAnchor={ma === 0 ? 'end' : ma === TIME_START_MA ? 'start' : 'middle'} fontSize={9}>
              {formatAgeShort(ma)}
            </text>
          </g>
        )
      }
      const y = frame.margin.top + a
      const x = frame.margin.left - 50
      return (
        <g key={ma} className="tol-tick">
          <text x={x} y={y} textAnchor="start" dominantBaseline={ma === 0 ? 'auto' : ma === TIME_START_MA ? 'hanging' : 'middle'} fontSize={8}>
            {formatAgeShort(ma)}
          </text>
        </g>
      )
    })
    return (
      <g className="tol-axis">
        {horizontal ? (
          <>
            {strip(eons, 10, 12, 9)}
            {strip(eras, 24, 10, 8)}
          </>
        ) : (
          <>
            {strip(eons, 24, 10, 8)}
            {strip(eras, 12, 8, 7)}
          </>
        )}
        {ticks}
      </g>
    )
  }

  const renderMerges = () =>
    merges.map(({ from, to, label, key }) => {
      const [tx, ty] = point(frame, to.t0, to.lane)
      const [fx, fy] = point(frame, to.t0, from.lane)
      const highlighted = pathSet.has(to.node.id) || pathSet.has(from.node.id)
      const d = horizontal
        ? `M${fx},${fy}C${fx + 40},${fy} ${tx - 40},${ty} ${tx},${ty}`
        : `M${fx},${fy}C${fx},${fy + 40} ${tx},${ty - 40} ${tx},${ty}`
      return (
        <g key={key} className={`tol-merge${highlighted ? ' is-path' : ''}`}>
          <path d={d} />
          <circle cx={tx} cy={ty} r={3.5} />
          {horizontal ? (
            <text x={fx + 8} y={(fy + ty) / 2} fontSize={9}>
              {label}
            </text>
          ) : (
            <text x={fx} y={(fy + ty) / 2} fontSize={8} textAnchor="middle">
              {label}
            </text>
          )}
          <title>{label}</title>
        </g>
      )
    })

  const stemFirst = [...layout.branches].sort((a, b) => Number(a.tip) - Number(b.tip))

  // Stem labels ride their lane and may run past a short stem; nested
  // clades can have lanes one row apart, so the labels are placed in
  // plot order and each one slides right along its lane until it clears
  // every label already placed (stem or extinct tip). One that cannot
  // clear before the axis ends is dropped -- the name stays in the card.

  return (
    <div className="tol" data-orientation={orientation} data-reduced-motion={reducedMotion ? 'true' : undefined}>
      <div className="tol-toolbar">
        <div className="tol-search">
          <label className="sr-only" htmlFor="tol-search">
            Find a lineage
          </label>
          <input
            id="tol-search"
            type="search"
            placeholder="Find a lineage (mammals, insects, ferns…)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          {matches.length > 0 && (
            <ul className="tol-matches" role="listbox" aria-label="Matching lineages">
              {matches.map((m) => (
                <li key={m.id} role="option" aria-selected={selected === m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      choose(m.id, true)
                      setQuery('')
                    }}
                  >
                    <span style={{ background: `var(--tol-${m.group})` }} className="tol-dot" aria-hidden="true" />
                    {m.name}
                    {m.scientific && m.scientific !== m.name ? <em> {m.scientific}</em> : null}
                    <span className="tol-match-age">{formatAgeShort(m.originMa)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="tol-buttons" role="group" aria-label="Tree controls">
          {horizontal && (
            <>
              <button type="button" className="tol-button" onClick={() => zoomBy(1.4)} aria-label="Zoom in">
                +
              </button>
              <button type="button" className="tol-button" onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out">
                −
              </button>
              <button type="button" className="tol-button" onClick={fit}>
                Fit
              </button>
            </>
          )}
          <button type="button" className="tol-button" onClick={expandAll}>
            Open every clade
          </button>
          <button type="button" className="tol-button" onClick={resetCollapse} disabled={userCollapsed === null}>
            Reset
          </button>
        </div>
      </div>

      <div className="tol-legend" aria-label="Key">
        {groupKeys.map((g) => (
          <span key={g} className="tol-legend-item">
            <span className="tol-swatch" style={{ background: `var(--tol-${g})` }} aria-hidden="true" />
            {tree.groups[g]}
          </span>
        ))}
        <span className="tol-legend-item">
          <span className="tol-swatch tol-swatch--extinct" aria-hidden="true" />
          extinct (line ends in a bar)
        </span>
        <span className="tol-legend-item">
          <span className="tol-swatch tol-swatch--fold" aria-hidden="true" />
          folded clade (tap to open)
        </span>
        <span className="tol-legend-item">
          <span className="tol-swatch tol-swatch--merge" aria-hidden="true" />
          endosymbiosis (one lineage joins another)
        </span>
        <span className="tol-legend-item">
          <span className="tol-swatch tol-swatch--band" aria-hidden="true" />
          mass extinction
        </span>
      </div>

      <div className={`tol-layout${selectedNode ? ' has-card' : ''}`}>
        <div className="tol-stage" ref={stageRef}>
          {width > 0 && (
            <svg
              ref={svgRef}
              className="tol-svg"
              width={frame.width}
              height={svgHeight}
              viewBox={`0 0 ${frame.width} ${svgHeight}`}
              role="group"
              aria-label={`Tree of life through time: ${layout.branches.length} lineages shown of ${tree.nodes.length}; time runs ${horizontal ? 'left to right' : 'top to bottom'} from 4 billion years ago to today.`}
              style={{ touchAction: horizontal ? 'none' : 'auto' }}
            >
              <g ref={plotRef} className="tol-plot">
                {renderBands()}
                {renderAxis()}
                <g className="tol-branches">{stemFirst.map(renderBranch)}</g>
                {renderMerges()}
              </g>
            </svg>
          )}
          <p className="tol-scale-note">
            {horizontal
              ? 'Time runs left to right and is compressed, not linear: the Precambrian (left third) covers 3.5 billion years, the Phanerozoic (right two-thirds) 541 million. '
              : 'Time runs down the page and is compressed, not linear: the Precambrian (top third) covers 3.5 billion years, the Phanerozoic (lower two-thirds) 541 million. '}
            Each line starts at the lineage’s origin as sourced in its card; ICS eons and eras under the axis in the chart’s own colours.
          </p>
        </div>
        <aside className="tol-aside" aria-live="polite">
          {selectedNode ? (
            <LineageCard
              node={selectedNode}
              tree={tree}
              index={index}
              collapsed={collapsed.has(selectedNode.id)}
              canCollapse={(index.children.get(selectedNode.id)?.length ?? 0) > 0}
              onSelect={(id) => choose(id, true)}
              onToggle={toggle}
            />
          ) : (
            <div className="tol-card tol-card--empty">
              <h3 className="font-display m-0 text-lg">How to read the tree</h3>
              <p className="mt-1 text-sm leading-snug">
                Every line is a lineage. It begins where it splits from its parent, at the age the
                evidence supports, and runs to today — or ends in a bar where it died out. Select any
                line for what it is, how its date is known and the sources behind it. Triangles mark
                folded clades: open them to see what is inside.
              </p>
              <p className="mt-2 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                {tree.nodes.length} lineages, every date sourced; topology follows current phylogenomics (eukaryotes arise within
                the Asgard archaea, comb jellies are the sister of all other animals, turtles sit beside the archosaurs, whales
                inside the even-toed ungulates). {tree.imageNote}
              </p>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
