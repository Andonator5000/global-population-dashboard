import { useEffect, useMemo, useRef, useState } from 'react'

import {
  LAYER_ORDER,
  anatomyModelUrl,
  labelGroups,
  layerAt,
  groupNameOf,
  labelPriority,
  structureSide,
  type DiagramAnchor,
  type DiagramView,
  type DiagramsFile,
  type LayerId,
  type ModelManifest,
  type ModelStructure,
  type Sex,
} from '../../lib/anatomy'
import { LAYER_SHORT } from './BodyStage'

/**
 * The Diagrams tab (round 13): a comprehensive static body built FROM the
 * models. scripts/render-anatomy-diagrams.mjs draws every layer of each
 * sex from one fixed orthographic camera (front and back) to a transparent
 * image, so the images register pixel for pixel and the tab can stack
 * them exactly as the 3-D stage stacks the meshes: skeleton at the bottom,
 * then nerves, organs, vessels, muscles, skin, with the same depth control
 * (the layer at the depth is looked at; see-through peels it to 22 %).
 * The renderer's ID pass gives every structure the centroid of the pixels
 * where it is really visible from that side, which is where its label
 * points. On a desktop the labels sit in two margins with leader lines,
 * packed top to bottom; on a phone they are dots on the body that a tap
 * expands. Density follows the zoom: a structure is labelled once its
 * visible area on screen is large enough, ranked by that area, so at rest
 * the major parts are named and zooming in names progressively everything.
 * Wheel, pinch and the +/- buttons zoom; drag pans; a tap on the body
 * picks the nearest visible structure and opens the same card as the 3-D.
 */

interface Props {
  diagrams: DiagramsFile
  manifest: ModelManifest
  structures: ModelStructure[] | null
  sex: Sex
  onSex: (sex: Sex) => void
  depth: number
  onDepth: (depth: number) => void
  seeThrough: boolean
  onSeeThrough: (value: boolean) => void
  labelsOn: boolean
  onLabelsOn: (value: boolean) => void
  labelQuery: string
  onLabelQuery: (value: string) => void
  selected: ModelStructure | null
  selectedKey: string | null
  onPick: (structure: ModelStructure | null) => void
  highlightOrgan: string | null
  compact: boolean
  reducedMotion: boolean
}

interface Candidate {
  key: string
  label: string
  structure: ModelStructure
  /** Image-pixel anchor. */
  ax: number
  ay: number
  px: number
  bbox: [number, number, number, number] | null
  forced: boolean
  fitted: boolean
}

interface Placed extends Candidate {
  /** Display coordinates. */
  x: number
  y: number
  lx: number
  ly: number
  side: 'left' | 'right'
}

const MIN_ZOOM = 1
const MAX_ZOOM = 8
const LABEL_ROW = 20
const MIN_BLOB = { desktop: 14, compact: 16 }

export function DiagramStage({
  diagrams,
  manifest,
  structures,
  sex,
  onSex,
  depth,
  onDepth,
  seeThrough,
  onSeeThrough,
  labelsOn,
  onLabelsOn,
  labelQuery,
  onLabelQuery,
  selected,
  selectedKey,
  onPick,
  highlightOrgan,
  compact,
  reducedMotion,
}: Props) {
  const [view, setView] = useState<DiagramView>('front')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointers: Map<number, { x: number; y: number }>; moved: number; startZoom: number; startDist: number; last: { x: number; y: number } } | null>(null)

  const record = diagrams.sexes[sex]
  const modelRecord = manifest.sexes[sex]
  const image = (layer: LayerId) => record.images.find((i) => i.layer === layer && i.view === view) ?? null
  const first = record.images[0]
  const imgW = first?.width ?? 1
  const imgH = first?.height ?? 1
  const labelledLayer = layerAt(seeThrough && depth > 0 ? depth - 1 : depth)
  const layerLabel = manifest.layers.find((l) => l.id === layerAt(depth))?.label ?? ''

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const measure = () => setSize({ w: box.clientWidth, h: box.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setExpanded(null)
  }, [depth, view, sex, seeThrough])

  // Display geometry: the image is fitted to the box height, centred, with
  // margins for the label columns on a desktop.
  const margin = compact ? 0 : Math.min(0.22, Math.max(0.16, 1 - (imgW / imgH) * (size.h / Math.max(1, size.w)) - 0.02))
  const baseScale = size.h > 0 ? Math.min(size.h / imgH, (size.w * (1 - 2 * margin)) / imgW) : 0
  const scale = baseScale * zoom
  const originX = (size.w - imgW * baseScale) / 2
  const originY = (size.h - imgH * baseScale) / 2
  const offsetX = originX + pan.x
  const offsetY = originY + pan.y
  const toDisplay = (x: number, y: number) => [offsetX + x * scale, offsetY + y * scale] as const

  // Candidates for the labelled layer in this view.
  const groups = useMemo(() => (structures ? labelGroups(structures, labelledLayer) : []), [structures, labelledLayer])
  const anchors = record.anchors[`${labelledLayer}-${view}`] ?? {}
  const candidates = useMemo<Candidate[]>(() => {
    const q = labelQuery.trim().toLowerCase()
    const out: Candidate[] = []
    const make = (key: string, label: string, nodes: ModelStructure[], group: { organ: string | null; key: string; fitted: boolean }) => {
      let px = 0
      let sx = 0
      let sy = 0
      let bbox: [number, number, number, number] | null = null
      for (const s of nodes) {
        const a: DiagramAnchor | undefined = anchors[s.node]
        if (!a) continue
        const [n, cx, cy, x0, y0, x1, y1] = a
        px += n
        sx += cx * n
        sy += cy * n
        bbox = bbox ? [Math.min(bbox[0], x0), Math.min(bbox[1], y0), Math.max(bbox[2], x1), Math.max(bbox[3], y1)] : [x0, y0, x1, y1]
      }
      const forced = selectedKey !== null && group.key === selectedKey
      const boosted = highlightOrgan !== null && group.organ === highlightOrgan
      // Hidden from this side: no anchor, so no label here even when forced
      // (the coverage note says to turn the body or use the 3-D view).
      if (px === 0) return
      if (q && !label.toLowerCase().includes(q) && !forced) return
      if (!labelsOn && !q && !forced && !boosted) return
      out.push({ key, label, structure: nodes[0]!, ax: sx / px, ay: sy / px, px: boosted ? px * 4 : px, bbox, forced, fitted: group.fitted })
    }
    for (const g of groups) {
      const left = g.nodes.filter((s) => structureSide(s.name) === 'left')
      const right = g.nodes.filter((s) => structureSide(s.name) === 'right')
      const unsided = g.nodes.filter((s) => structureSide(s.name) === null)
      if (left.length && right.length && unsided.length === 0) {
        const bb = (nodes: ModelStructure[]) => {
          let b: [number, number, number, number] | null = null
          for (const s of nodes) {
            const a = anchors[s.node]
            if (!a) continue
            b = b ? [Math.min(b[0], a[3]), Math.min(b[1], a[4]), Math.max(b[2], a[5]), Math.max(b[3], a[6])] : [a[3], a[4], a[5], a[6]]
          }
          return b
        }
        const lb = bb(left)
        const rb = bb(right)
        if (lb && rb) {
          const gap = Math.max(lb[0] - rb[2], rb[0] - lb[2])
          if (gap > imgW * 0.04) {
            make(`${g.key}:left`, `${g.name} (left)`, left, g)
            make(`${g.key}:right`, `${g.name} (right)`, right, g)
            continue
          }
        }
      }
      make(g.key, g.name, g.nodes, g)
    }
    return out
  }, [groups, anchors, labelQuery, labelsOn, selectedKey, highlightOrgan, imgW])

  // Layout: rank by visible area on screen, then pack into the margins
  // (desktop) or place as dots (compact).
  const placed = useMemo<Placed[]>(() => {
    if (size.w === 0 || scale === 0) return []
    const q = labelQuery.trim().length > 0
    const minBlob = compact ? MIN_BLOB.compact : MIN_BLOB.desktop
    const ranked = candidates
      .map((c) => ({ c, blob: Math.sqrt(c.px) * scale, tier: labelPriority(labelledLayer, c.label, c.structure.organ) }))
      .filter(({ c, blob, tier }) => c.forced || q || blob >= minBlob * (tier === 0 ? 0.5 : 1))
      .sort((a, b) => (a.c.forced !== b.c.forced ? (a.c.forced ? -1 : 1) : a.tier !== b.tier ? a.tier - b.tier : b.blob - a.blob))
      .map(({ c }) => c)
    const inView = ranked.filter((c) => {
      const [x, y] = toDisplay(c.ax, c.ay)
      return c.forced || (x >= -4 && x <= size.w + 4 && y >= -4 && y <= size.h + 4)
    })
    if (compact) {
      const cap = q ? 60 : 18
      const out: Placed[] = []
      const boxes: { x0: number; y0: number; x1: number; y1: number }[] = []
      for (const c of inView) {
        if (out.length >= cap && !c.forced) break
        const [x, y] = toDisplay(c.ax, c.ay)
        const box = { x0: x - 14, y0: y - 14, x1: x + 14, y1: y + 14 }
        if (!c.forced && boxes.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue
        boxes.push(box)
        out.push({ ...c, x, y, lx: x, ly: y, side: x < size.w / 2 ? 'left' : 'right' })
      }
      return out
    }
    const rows = Math.max(1, Math.floor((size.h - 8) / LABEL_ROW))
    const cap = q ? rows * 2 : Math.min(rows * 2, 56)
    const columns: { left: Placed[]; right: Placed[] } = { left: [], right: [] }
    const imageCentre = offsetX + (imgW * scale) / 2
    for (const c of inView) {
      if (columns.left.length + columns.right.length >= cap && !c.forced) break
      const [x, y] = toDisplay(c.ax, c.ay)
      const side: 'left' | 'right' = x < imageCentre ? 'left' : 'right'
      const column = columns[side]
      if (column.length >= rows && !c.forced) continue
      column.push({ ...c, x, y, lx: 0, ly: y, side })
    }
    const out: Placed[] = []
    for (const side of ['left', 'right'] as const) {
      const column = columns[side].sort((a, b) => a.y - b.y)
      // Pack top to bottom, then pull the tail back up if it ran off the bottom.
      let last = -Infinity
      for (const item of column) {
        item.ly = Math.max(item.y, last + LABEL_ROW, 10)
        last = item.ly
      }
      let limit = size.h - 10
      for (let i = column.length - 1; i >= 0; i -= 1) {
        const item = column[i]!
        if (item.ly > limit) item.ly = limit
        limit = item.ly - LABEL_ROW
      }
      for (const item of column) {
        item.lx = side === 'left' ? Math.max(8, offsetX - 12) : Math.min(size.w - 8, offsetX + imgW * scale + 12)
        if (item.ly >= 4 && item.ly <= size.h - 4) out.push(item)
      }
    }
    return out
  }, [candidates, size, scale, offsetX, offsetY, imgW, compact, labelQuery])

  // ---- Zoom and pan ----------------------------------------------------------
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor))
    if (next === zoom) return
    if (next === MIN_ZOOM) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
      return
    }
    // Keep the point under the cursor fixed.
    const ratio = next / zoom
    setPan({ x: cx - (cx - offsetX) * ratio - originX, y: cy - (cy - offsetY) * ratio - originY })
    setZoom(next)
  }
  // React registers wheel listeners passive; the zoom must prevent the page
  // scroll, so it is a native listener.
  const zoomAtRef = useRef(zoomAt)
  zoomAtRef.current = zoomAt
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = box.getBoundingClientRect()
      zoomAtRef.current(event.deltaY < 0 ? 1.25 : 1 / 1.25, event.clientX - rect.left, event.clientY - rect.top)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [])
  const onPointerDown = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('.anatomy-pin, .anatomy-button')) return
    const box = boxRef.current!
    box.setPointerCapture(event.pointerId)
    const p = { x: event.clientX, y: event.clientY }
    if (!drag.current) drag.current = { pointers: new Map(), moved: 0, startZoom: zoom, startDist: 0, last: p }
    drag.current.pointers.set(event.pointerId, p)
    if (drag.current.pointers.size === 2) {
      const [a, b] = [...drag.current.pointers.values()]
      drag.current.startDist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
      drag.current.startZoom = zoom
    }
  }
  const onPointerMove = (event: React.PointerEvent) => {
    const d = drag.current
    if (!d || !d.pointers.has(event.pointerId)) return
    const prev = d.pointers.get(event.pointerId)!
    const now = { x: event.clientX, y: event.clientY }
    d.pointers.set(event.pointerId, now)
    d.moved += Math.hypot(now.x - prev.x, now.y - prev.y)
    if (d.pointers.size === 1) {
      if (zoom > 1) setPan((p) => ({ x: p.x + now.x - prev.x, y: p.y + now.y - prev.y }))
    } else if (d.pointers.size === 2) {
      const [a, b] = [...d.pointers.values()]
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
      if (d.startDist > 0) {
        const rect = boxRef.current!.getBoundingClientRect()
        const mid = { x: (a!.x + b!.x) / 2 - rect.left, y: (a!.y + b!.y) / 2 - rect.top }
        const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, d.startZoom * (dist / d.startDist)))
        zoomAt(target / zoom, mid.x, mid.y)
      }
    }
  }
  const onPointerUp = (event: React.PointerEvent) => {
    const d = drag.current
    if (!d || !d.pointers.has(event.pointerId)) return
    d.pointers.delete(event.pointerId)
    const tap = d.moved < 6 && d.pointers.size === 0
    if (d.pointers.size === 0) drag.current = null
    if (!tap) return
    // A tap on the body picks the nearest visible structure.
    const rect = boxRef.current!.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    let best: { c: Candidate; d: number } | null = null
    for (const c of candidates) {
      if (c.px === 0) continue
      const [cx, cy] = toDisplay(c.ax, c.ay)
      const dist = Math.hypot(cx - x, cy - y)
      if (dist < 28 && (!best || dist < best.d)) best = { c, d: dist }
    }
    if (best) onPick(best.c.structure)
    else onPick(null)
  }

  const zoomed = zoom > 1.02
  const selectedAnchor = selected ? anchors[selected.node] : undefined
  const selectedBox: [number, number, number, number] | null = selectedAnchor ? [selectedAnchor[3], selectedAnchor[4], selectedAnchor[5], selectedAnchor[6]] : null

  return (
    <div className="anatomy-stage3d">
      <div className="anatomy-toolbar">
        <div className="anatomy-segmented" role="group" aria-label="Model">
          {(['male', 'female'] as Sex[]).map((option) => (
            <button key={option} type="button" aria-pressed={sex === option} className={sex === option ? 'is-selected' : ''} onClick={() => onSex(option)}>
              {option === 'male' ? 'Male' : 'Female'}
            </button>
          ))}
        </div>
        <div className="anatomy-segmented" role="group" aria-label="View">
          {(['front', 'back'] as DiagramView[]).map((option) => (
            <button key={option} type="button" aria-pressed={view === option} className={view === option ? 'is-selected' : ''} onClick={() => setView(option)}>
              {option === 'front' ? 'Front' : 'Back'}
            </button>
          ))}
        </div>
        <label className="anatomy-toggle">
          <input type="checkbox" checked={seeThrough} onChange={(event) => onSeeThrough(event.target.checked)} disabled={depth === 0} />
          <span>See through {LAYER_SHORT[layerAt(depth)].toLowerCase()}</span>
        </label>
        <label className="anatomy-toggle">
          <input type="checkbox" checked={labelsOn} onChange={(event) => onLabelsOn(event.target.checked)} />
          <span>Labels</span>
        </label>
        <label className="anatomy-search">
          <span className="sr-only">Find a structure in this layer</span>
          <input type="search" value={labelQuery} placeholder="Find a structure…" onChange={(event) => onLabelQuery(event.target.value)} aria-label="Find a structure in this layer" enterKeyHint="search" />
        </label>
      </div>

      <div
        ref={boxRef}
        className={`anatomy-diagram${zoomed ? ' is-zoomed' : ''}`}
        style={{ aspectRatio: compact ? '4 / 5' : '3 / 4', maxHeight: compact ? '72vh' : 'min(78vh, 46rem)' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="img"
        aria-label={`${sex === 'male' ? 'Male' : 'Female'} body, ${view} view, ${layerLabel} layer`}
      >
        <div className="anatomy-diagram-stack" style={{ width: imgW * scale, height: imgH * scale, transform: `translate(${offsetX}px, ${offsetY}px)` }}>
          {LAYER_ORDER.map((layer, index) => {
            if (index > depth) return null
            // Under an opaque skin the deeper layers are invisible in the body
            // and only their slivers would show past the silhouette: not drawn.
            if (!seeThrough && depth === LAYER_ORDER.length - 1 && index < depth) return null
            const img = image(layer)
            if (!img) return null
            const opacity = seeThrough && index === depth && depth > 0 ? 0.22 : 1
            return <img key={`${sex}-${layer}-${view}`} src={anatomyModelUrl(img.file)} alt="" draggable={false} style={{ opacity, zIndex: index }} />
          })}
        </div>
        <svg className="anatomy-diagram-leaders" width={size.w} height={size.h} aria-hidden="true">
          {!compact && placed.map((p) => <line key={p.key} x1={p.lx} y1={p.ly} x2={p.x} y2={p.y} />)}
          {selectedBox && (() => {
            const [x0, y0] = toDisplay(selectedBox[0], selectedBox[1])
            const [x1, y1] = toDisplay(selectedBox[2], selectedBox[3])
            return <rect x={x0 - 3} y={y0 - 3} width={Math.max(6, x1 - x0 + 6)} height={Math.max(6, y1 - y0 + 6)} rx={3} />
          })()}
        </svg>
        <div className="anatomy-pins" aria-label="Labels of the current layer">
          {placed.map((p) => {
            const active = selectedKey !== null && p.key.startsWith(selectedKey)
            const isExpanded = !compact || expanded === p.key || active
            return (
              <button
                key={p.key}
                type="button"
                className={`anatomy-pin${isExpanded ? ' is-expanded' : ''}${active ? ' is-active' : ''}${p.fitted ? ' is-fitted' : ''}${!compact && p.side === 'left' ? ' is-margin-left' : ''}`}
                style={{ transform: `translate(${p.lx.toFixed(1)}px, ${p.ly.toFixed(1)}px)` }}
                aria-label={p.label}
                title={p.label}
                onClick={(event) => {
                  event.stopPropagation()
                  if (compact && expanded !== p.key && !active) {
                    setExpanded(p.key)
                    return
                  }
                  onPick(p.structure)
                }}
              >
                <span className="anatomy-pin-dot" aria-hidden="true" />
                <span className="anatomy-pin-label">{p.label}</span>
              </button>
            )
          })}
        </div>
        <div className="anatomy-diagram-zoom">
          <button type="button" className="anatomy-button" aria-label="Zoom in" onClick={() => zoomAt(1.5, size.w / 2, size.h / 2)}>+</button>
          <button type="button" className="anatomy-button" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.5, size.w / 2, size.h / 2)}>−</button>
          {zoomed && (
            <button type="button" className="anatomy-button" aria-label="Reset zoom" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>Reset</button>
          )}
        </div>
        {!compact && (
          <p className="anatomy-hint" aria-hidden="true">
            Scroll to zoom · drag to pan · click a label or the body
          </p>
        )}
      </div>
      {compact && (
        <p className="m-0 text-xs" style={{ color: 'var(--text-muted)' }} aria-hidden="true">
          Pinch to zoom · drag to pan · tap a dot or the body
        </p>
      )}

      {/* Depth control, the same as the 3-D stage */}
      <div className="anatomy-depth">
        <label className="anatomy-depth-label" htmlFor="anatomy-diagram-depth">
          Depth: <strong>{layerLabel}</strong>
          <span className="anatomy-depth-hint"> bone → flesh</span>
        </label>
        <input id="anatomy-diagram-depth" className="anatomy-slider" type="range" min={0} max={LAYER_ORDER.length - 1} step={1} value={depth} aria-valuetext={layerLabel} onChange={(event) => onDepth(Number(event.target.value))} />
        <ol
          className="anatomy-chips"
          aria-label="Layers, bone to flesh"
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
              event.preventDefault()
              onDepth(Math.min(LAYER_ORDER.length - 1, depth + 1))
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
              event.preventDefault()
              onDepth(Math.max(0, depth - 1))
            }
          }}
        >
          {LAYER_ORDER.map((id, index) => {
            const info = modelRecord.layers.find((l) => l.id === id)
            const active = index === depth
            return (
              <li key={id}>
                <button type="button" aria-current={active ? 'step' : undefined} className={`anatomy-chip${active ? ' is-active' : ''}${index < depth ? ' is-below' : ''}`} onClick={() => onDepth(index)} title={info?.note ?? ''}>
                  <span className="anatomy-chip-n">{index + 1}</span>
                  {LAYER_SHORT[id]}
                  {info?.coverage === 'partial' && <span className="anatomy-chip-flag" aria-label="partly fitted from the male model">◐</span>}
                </button>
              </li>
            )
          })}
        </ol>
      </div>

      <p className="anatomy-coverage">
        Rendered from the same models as the 3-D body, from one fixed camera per sex, so the layers sit flush; {' '}
        {(record.images.length / 2).toFixed(0)} layer images per view, {(record.totalBytes / 1e6).toFixed(1)} MB in all. Labels point at the
        centre of the pixels where a structure is visible from this side; structures hidden from this side have no label
        here (turn the body or use the 3-D view). {sex === 'female' ? 'Structures fitted from the male model are marked "fitted".' : ''}
        {reducedMotion ? '' : ''}
      </p>
    </div>
  )
}

export function selectedKeyOf(structure: ModelStructure | null): string | null {
  return structure ? `${structure.layer}:${groupNameOf(structure.name)}` : null
}
