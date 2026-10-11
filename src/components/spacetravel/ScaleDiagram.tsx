import { useId } from 'react'

import type {
  Plate,
  ScaleReference,
  Silhouette,
  SilhouetteSection,
  TravelCraft,
} from '../../lib/spacetravel'

/**
 * Scale plates for /space/travel (round 14, DATA_DECISIONS section 74).
 *
 * EVERY OUTLINE HERE IS GENERATED FROM THE DATA. Nothing is traced, hand
 * placed or stretched to fit: a vehicle's profile is built from the stage
 * lengths and diameters recorded in etl/reference/space_travel.json, and
 * its drawn height is a sourced figure (or an explicitly composed one that
 * says so, `heightNote`). Change a number in the reference file and the
 * drawing changes with it; check:spacetravel fails if the geometry stops
 * adding up to the published figure.
 *
 * Two plate kinds:
 *   vertical  nose-up profiles on a common baseline (rockets, capsules --
 *             capsules are drawn nose-up because that is how they launch)
 *   span      broadside plans stacked as rows (stations, satellites)
 *
 * Both are drawn at ONE scale across the plate, with a metre ruler and the
 * two reference figures (a 1.75 m adult, the 46.05 m Statue of Liberty) so
 * the eye has something to hold on to. On a phone the plate scrolls inside
 * a framed scroller rather than shrinking into illegibility -- the scroller
 * is what moves, never the page (`document.documentElement.scrollWidth`
 * must never exceed the viewport).
 */

const PLATE_H = 560 // px available to the tallest item on a vertical plate
const SPAN_W = 920 // px available to the widest item on a span plate
const COL_GAP = 16
const COL_MIN = 70
const LABEL_H = 78
const RULER_W = 54
const ROW_GAP = 26

type Pt = [number, number]

// --------------------------------------------------------------------------
// Vertical profiles
// --------------------------------------------------------------------------

/** Half-widths down one section, in metres, sampled for curved shapes. */
function sampleSection(section: SilhouetteSection): { t: number; half: number }[] {
  const r0 = section.d0 / 2
  const r1 = section.d1 / 2
  if (section.s === 'sphere') {
    const r = Math.max(r0, r1, section.len / 2)
    return Array.from({ length: 13 }, (_, i) => {
      const t = i / 12
      return { t, half: Math.max(r * Math.sin(Math.PI * t), 0.02) }
    })
  }
  if (section.s === 'dome') {
    return Array.from({ length: 9 }, (_, i) => {
      const t = i / 8
      return { t, half: r0 + (r1 - r0) * Math.sin((Math.PI / 2) * t) }
    })
  }
  return [
    { t: 0, half: r0 },
    { t: 1, half: r1 },
  ]
}

interface Profile {
  path: string
  /** Half-width in metres at a height measured from the TOP of the item. */
  halfAt: (fromTopM: number) => number
  maxHalfM: number
}

function buildProfile(sections: SilhouetteSection[], k: number, cx: number, topY: number): Profile {
  const left: Pt[] = []
  const right: Pt[] = []
  const stops: { from: number; to: number; h0: number; h1: number }[] = []
  let cum = 0
  let maxHalfM = 0
  for (const section of sections) {
    for (const { t, half } of sampleSection(section)) {
      const y = topY + (cum + section.len * t) * k
      left.push([cx - half * k, y])
      right.push([cx + half * k, y])
      maxHalfM = Math.max(maxHalfM, half)
    }
    stops.push({
      from: cum,
      to: cum + section.len,
      h0: sampleSection(section)[0]!.half,
      h1: sampleSection(section).at(-1)!.half,
    })
    cum += section.len
  }
  const d =
    `M ${left.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')}` +
    ` L ${[...right].reverse().map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')} Z`
  const halfAt = (fromTopM: number) => {
    for (const stop of stops) {
      if (fromTopM >= stop.from && fromTopM <= stop.to) {
        const f = stop.to === stop.from ? 0 : (fromTopM - stop.from) / (stop.to - stop.from)
        return stop.h0 + (stop.h1 - stop.h0) * f
      }
    }
    return stops.at(-1)?.h1 ?? 0
  }
  return { path: d, halfAt, maxHalfM }
}

/** The core's widest radius, in metres. */
function coreHalfM(sil: Silhouette): number {
  let half = 0
  for (const section of sil.sections ?? []) {
    half = Math.max(half, section.d0 / 2, section.d1 / 2)
  }
  return half
}

/**
 * Where a strap-on booster's axis sits, in metres from the vehicle's axis.
 * Boosters are mounted ON the core, so the drawing hugs them against it;
 * the published overall diameter (which usually includes flared engine
 * fairings) is the outer bound, never a reason to float them in space.
 */
function strapOffsetM(sil: Silhouette): number {
  if (!sil.strapOns) return 0
  const { spanM, dBot } = sil.strapOns
  return Math.min(spanM / 2 - dBot / 2, coreHalfM(sil) + dBot / 2)
}

/** A side-mounted orbiter clears the boosters, in metres from the axis. */
function attachedCxM(sil: Silhouette): number {
  if (!sil.attached) return 0
  const outer = sil.strapOns
    ? strapOffsetM(sil) + sil.strapOns.dBot / 2
    : coreHalfM(sil)
  return outer + sil.attached.bodyDiaM / 2
}

/** Everything a vertical item needs horizontally, in metres each side. */
function verticalHalfExtent(sil: Silhouette): number {
  const core = coreHalfM(sil)
  const widestFin = Math.max(0, ...(sil.fins ?? []).map((f) => f.span))
  let half = core + widestFin
  if (sil.strapOns) half = Math.max(half, strapOffsetM(sil) + sil.strapOns.dBot / 2)
  if (sil.wings) half = Math.max(half, sil.wings.spanM / 2)
  if (sil.panels) half = Math.max(half, sil.panels.spanM / 2)
  if (sil.attached) half = Math.max(half, attachedCxM(sil) + sil.attached.bodyDiaM)
  return half
}

/** A short, wrapped column label: at most two lines of about 14 characters. */
function labelLines(name: string): string[] {
  const base = name.split(' (')[0]!.trim()
  const words = base.split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (!line) line = word
    else if ((line + ' ' + word).length <= 14) line += ' ' + word
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  if (lines.length <= 2) return lines
  return [lines[0]!, `${lines.slice(1).join(' ').slice(0, 13)}…`]
}

function VerticalItem({
  sil,
  k,
  cx,
  baseY,
}: {
  sil: Silhouette
  k: number
  cx: number
  baseY: number
}) {
  const height = sil.heightM ?? 0
  const topY = baseY - height * k
  const profile = buildProfile(sil.sections ?? [], k, cx, topY)
  const shapes: React.ReactNode[] = []

  // Strap-on boosters, drawn behind the core.
  if (sil.strapOns) {
    const { len, dTop, dBot, baseAt, nose } = sil.strapOns
    const yB = baseY - baseAt * k
    const yT = yB - len * k
    const wTop = (dTop / 2) * k
    const wBot = (dBot / 2) * k
    // Hug the boosters against the core AT THEIR OWN HEIGHT: a vehicle's
    // widest point is often the payload fairing, far above the boosters.
    const coreHereM = profile.halfAt(Math.max(0, height - (baseAt + len * 0.5)))
    const offset = Math.min(strapOffsetM(sil), coreHereM + dBot / 2) * k
    for (const sign of [-1, 1]) {
      const c = cx + sign * offset
      shapes.push(
        <polygon
          key={`strap-${sign}`}
          className="st-shape st-shape-strap"
          points={`${c - wTop},${yT} ${c + wTop},${yT} ${c + wBot},${yB} ${c - wBot},${yB}`}
        />,
      )
      if (nose) {
        shapes.push(
          <polygon
            key={`strapnose-${sign}`}
            className="st-shape st-shape-strap"
            points={`${c - wTop},${yT} ${c},${yT - wTop * 2.4} ${c + wTop},${yT}`}
          />,
        )
      }
    }
  }

  // Wings (Shuttle orbiter, Starship-era deltas).
  if (sil.wings) {
    const { from, to, spanM } = sil.wings
    const yFrom = baseY - from * height * k
    const yTo = baseY - to * height * k
    const hwTo = profile.halfAt(height - to * height) * k
    const hwFrom = profile.halfAt(height - from * height) * k
    for (const sign of [-1, 1]) {
      shapes.push(
        <polygon
          key={`wing-${sign}`}
          className="st-shape st-shape-wing"
          points={`${cx + sign * hwTo},${yTo} ${cx + sign * (spanM / 2) * k},${yFrom} ${cx + sign * hwFrom},${yFrom}`}
        />,
      )
    }
  }

  // Solar arrays.
  if (sil.panels) {
    const { spanM, at, widthM } = sil.panels
    const y = baseY - at * height * k
    const hw = profile.halfAt(height - at * height) * k
    const h = widthM * k
    for (const sign of [-1, 1]) {
      const x0 = cx + sign * hw
      const x1 = cx + sign * (spanM / 2) * k
      shapes.push(
        <rect
          key={`panel-${sign}`}
          className="st-shape st-shape-panel"
          x={Math.min(x0, x1)}
          y={y - h / 2}
          width={Math.abs(x1 - x0)}
          height={h}
        />,
      )
    }
  }

  // The core outline.
  shapes.push(<path key="core" className="st-shape st-shape-body" d={profile.path} />)

  // Fins, grid fins, flaps and landing legs.
  for (const [i, fin] of (sil.fins ?? []).entries()) {
    const yB = baseY - fin.at * height * k
    const yT = yB - fin.len * k
    const hw = profile.halfAt(Math.max(0, height - fin.at * height)) * k
    for (const sign of [-1, 1]) {
      if (fin.role === 'legs') {
        // Landing gear is a strut and a footpad, not a fin-shaped wedge.
        const toeX = cx + sign * (hw + fin.span * k)
        const hipX = cx + sign * hw
        shapes.push(
          <polygon
            key={`leg-${i}-${sign}`}
            className="st-shape st-shape-fin"
            points={`${hipX},${yT} ${hipX + sign * 1.5},${yT} ${toeX},${yB} ${toeX - sign * 1.5},${yB}`}
          />,
          <rect
            key={`pad-${i}-${sign}`}
            className="st-shape st-shape-fin"
            x={toeX - Math.max(fin.span * k * 0.18, 2)}
            y={yB - 2}
            width={Math.max(fin.span * k * 0.36, 4)}
            height={2.5}
          />,
        )
        continue
      }
      shapes.push(
        <polygon
          key={`fin-${i}-${sign}`}
          className="st-shape st-shape-fin"
          points={`${cx + sign * hw},${yT} ${cx + sign * (hw + fin.span * k)},${yB} ${cx + sign * hw},${yB}`}
        />,
      )
    }
  }

  // A side-mounted orbiter (the Shuttle stack, Energia-Buran), drawn in
  // SIDE ELEVATION: on the stack you see the orbiter's profile, so its
  // wings are edge-on. The full wingspan is on the crewed-spacecraft plate,
  // where the orbiter is drawn in plan.
  if (sil.attached) {
    const { lenM, bodyDiaM, fromBottomM } = sil.attached
    const ox = cx + attachedCxM(sil) * k
    const yB = baseY - fromBottomM * k
    const L = lenM * k
    const yT = yB - L
    const hw = (bodyDiaM / 2) * k
    shapes.push(
      <polygon
        key="orbiter-body"
        className="st-shape st-shape-body"
        points={`${ox - hw * 0.1},${yT} ${ox + hw},${yT + L * 0.22} ${ox + hw},${yB} ${ox - hw},${yB} ${ox - hw},${yT + L * 0.3}`}
      />,
      <polygon
        key="orbiter-fin"
        className="st-shape st-shape-wing"
        points={`${ox - hw},${yB - L * 0.3} ${ox - hw - hw * 0.85},${yB - L * 0.02} ${ox - hw},${yB - L * 0.02}`}
      />,
      <polygon
        key="orbiter-wing"
        className="st-shape st-shape-wing"
        points={`${ox + hw},${yB - L * 0.4} ${ox + hw + hw * 0.5},${yB - L * 0.03} ${ox + hw},${yB - L * 0.03}`}
      />,
    )
  }

  return <g>{shapes}</g>
}

// --------------------------------------------------------------------------
// Reference figures (their HEIGHTS are sourced; the outlines are ours)
// --------------------------------------------------------------------------

function HumanFigure({ cx, baseY, h }: { cx: number; baseY: number; h: number }) {
  const s = h / 100
  const tx = cx - 50 * s
  const ty = baseY - h
  return (
    <g transform={`translate(${tx} ${ty}) scale(${s})`}>
      <circle className="st-shape st-shape-ref" cx={50} cy={9} r={8} />
      <path
        className="st-shape st-shape-ref"
        d="M50 18 C43 18 39 23 39 28 L39 48 C39 51 43 51 43 48 L44 38 L44 62 L40 97 C40 100 46 100 46.5 97 L50 71 L53.5 97 C54 100 60 100 60 97 L56 62 L56 38 L57 48 C57 51 61 51 61 48 L61 28 C61 23 57 18 50 18 Z"
      />
    </g>
  )
}

function LibertyFigure({ cx, baseY, h }: { cx: number; baseY: number; h: number }) {
  const s = h / 100
  const tx = cx - 50 * s
  const ty = baseY - h
  const rays = Array.from({ length: 7 }, (_, i) => {
    const a = Math.PI * (1.08 + (i * 0.84) / 6)
    return (
      <line
        key={i}
        className="st-ray"
        x1={50 + Math.cos(a) * 7}
        y1={34 + Math.sin(a) * 7}
        x2={50 + Math.cos(a) * 14}
        y2={34 + Math.sin(a) * 14}
      />
    )
  })
  return (
    <g transform={`translate(${tx} ${ty}) scale(${s})`}>
      <path className="st-shape st-shape-ref" d="M34 100 L40 54 L46 41 L54 41 L58 54 L66 100 Z" />
      <path className="st-shape st-shape-ref" d="M46 100 L48 72 L52 72 L54 100 Z" />
      <circle className="st-shape st-shape-ref" cx={50} cy={34} r={6.5} />
      {rays}
      <path className="st-shape st-shape-ref" d="M54 44 L62 18 L66 19 L58 46 Z" />
      <path className="st-shape st-shape-ref" d="M60 11 L69 11 L67 19 L62 19 Z" />
      <circle className="st-shape st-shape-ref" cx={64.5} cy={6} r={4.5} />
      <path className="st-shape st-shape-ref" d="M46 46 L38 58 L43 62 L49 51 Z" />
      <rect className="st-shape st-shape-ref" x={31} y={55} width={10} height={15} rx={1} />
    </g>
  )
}

// --------------------------------------------------------------------------
// Span plans
// --------------------------------------------------------------------------

function SpanItem({ sil, k, cx, cy }: { sil: Silhouette; k: number; cx: number; cy: number }) {
  return (
    <g>
      {(sil.parts ?? []).map((part, i) => {
        const x = cx + part.x * k
        const y = cy + part.y * k
        const w = part.w * k
        const h = part.h * k
        const cls = `st-shape st-shape-${part.r}`
        const transform = part.rot ? `rotate(${part.rot} ${x} ${y})` : undefined
        if (part.s === 'disc') {
          return (
            <ellipse
              key={i}
              className={cls}
              cx={x + w / 2}
              cy={y + h / 2}
              rx={w / 2}
              ry={h / 2}
              transform={transform}
            />
          )
        }
        if (part.s === 'cone') {
          return (
            <polygon
              key={i}
              className={cls}
              points={`${x},${y} ${x + w},${y + h / 2} ${x},${y + h}`}
              transform={transform}
            />
          )
        }
        if (part.s === 'kite') {
          return (
            <polygon
              key={i}
              className={cls}
              points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
              transform={transform}
            />
          )
        }
        return (
          <rect
            key={i}
            className={cls}
            x={x}
            y={y}
            width={Math.max(w, 1)}
            height={Math.max(h, 1)}
            rx={part.s === 'cyl' ? Math.min(h, w) / 2.6 : 0}
            transform={transform}
          />
        )
      })}
    </g>
  )
}

// --------------------------------------------------------------------------
// The plate
// --------------------------------------------------------------------------

function metreStep(maxM: number): number {
  const raw = maxM / 7
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const mult of [1, 2, 2.5, 5, 10]) {
    if (raw <= pow * mult) return pow * mult
  }
  return pow * 10
}

/**
 * One craft's outline on its own, for the catalogue's detail panel: the
 * same generated geometry as the plates, scaled to fit a card, with the
 * vehicle's own size printed beside it.
 */
export function CraftOutline({ craft }: { craft: TravelCraft }) {
  const sil = craft.silhouette
  if (!sil) return null
  const H = 190
  if (sil.axis === 'vertical') {
    const height = sil.heightM ?? 0
    if (!height) return null
    const k = H / height
    const halfM = verticalHalfExtent(sil)
    const w = Math.max(80, halfM * 2 * k + 16)
    return (
      <figure className="st-outline">
        <svg
          className="st-svg"
          width={w}
          height={H + 14}
          viewBox={`0 0 ${w} ${H + 14}`}
          role="img"
          aria-label={`${craft.name} outline, ${height} m tall, generated from its published dimensions`}
        >
          <VerticalItem sil={sil} k={k} cx={w / 2} baseY={H + 4} />
          <line className="st-baseline" x1={0} y1={H + 4} x2={w} y2={H + 4} />
        </svg>
        <figcaption className="st-plate-note">
          Outline generated from the published dimensions; {height} m tall.
          {sil.heightNote ? ` ${sil.heightNote}` : ''}
        </figcaption>
      </figure>
    )
  }
  const span = sil.spanM ?? 0
  const depth = Math.max(sil.depthM ?? 0, 2)
  if (!span) return null
  const k = Math.min(320 / span, H / depth)
  const w = span * k + 16
  const h = depth * k + 16
  return (
    <figure className="st-outline">
      <svg
        className="st-svg"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`${craft.name} plan, ${span} m across, generated from its published dimensions`}
      >
        <SpanItem sil={sil} k={k} cx={w / 2} cy={h / 2} />
      </svg>
      <figcaption className="st-plate-note">
        Plan generated from the published dimensions; {span} m across.
        {sil.spanNote ? ` ${sil.spanNote}` : ''}
      </figcaption>
    </figure>
  )
}

export function ScaleDiagram({
  plate,
  craft,
  refs,
}: {
  plate: Plate
  craft: Map<string, TravelCraft>
  refs: Map<string, ScaleReference>
}) {
  const titleId = useId()
  const items = plate.items
    .map((id) => craft.get(id))
    .filter((c): c is TravelCraft => Boolean(c?.silhouette))
  const scaleRefs = plate.scaleRefs
    .map((id) => refs.get(id))
    .filter((r): r is ScaleReference => Boolean(r))

  if (items.length === 0) return null

  if (plate.kind === 'vertical') {
    const maxM = Math.max(
      ...items.map((c) => c.silhouette!.heightM ?? 0),
      ...scaleRefs.map((r) => r.heightM),
    )
    const k = PLATE_H / maxM
    const baseY = PLATE_H + 12
    const columns: {
      key: string
      name: string
      sub: string
      width: number
      node: React.ReactNode
    }[] = []

    for (const ref of scaleRefs) {
      const w = Math.max(COL_MIN, ref.heightM * k * 0.42 + 18)
      columns.push({
        key: `ref-${ref.id}`,
        name: ref.label,
        sub: `${ref.heightM} m`,
        width: w,
        node:
          ref.id === 'liberty' ? (
            <LibertyFigure cx={w / 2} baseY={baseY} h={ref.heightM * k} />
          ) : (
            <HumanFigure cx={w / 2} baseY={baseY} h={ref.heightM * k} />
          ),
      })
    }
    for (const item of items) {
      const sil = item.silhouette!
      const halfM = verticalHalfExtent(sil)
      const w = Math.max(COL_MIN, halfM * 2 * k + 14)
      columns.push({
        key: item.id,
        name: item.name,
        sub: `${(sil.heightM ?? 0).toLocaleString('en', { maximumFractionDigits: 1 })} m`,
        width: w,
        node: <VerticalItem sil={sil} k={k} cx={w / 2} baseY={baseY} />,
      })
    }

    const totalW =
      RULER_W + columns.reduce((acc, c) => acc + c.width + COL_GAP, 0) + 12
    const totalH = baseY + LABEL_H
    const step = metreStep(maxM)
    const ticks: number[] = []
    for (let m = 0; m <= maxM; m += step) ticks.push(m)

    let x = RULER_W
    return (
      <figure className="st-plate" aria-labelledby={titleId}>
        <figcaption>
          <h3 id={titleId} className="font-display st-plate-title">
            {plate.title}
          </h3>
          <p className="st-plate-intro">{plate.intro}</p>
        </figcaption>
        <div className="st-scroller" tabIndex={0} role="group" aria-label={`${plate.title} (scrolls sideways)`}>
          <svg
            className="st-svg"
            width={totalW}
            height={totalH}
            viewBox={`0 0 ${totalW} ${totalH}`}
            role="img"
            aria-label={`${plate.title}: ${columns.map((c) => `${c.name} ${c.sub}`).join(', ')}`}
          >
            {/* Metre ruler: the plate's single scale, stated. */}
            {ticks.map((m) => {
              const y = baseY - m * k
              return (
                <g key={m}>
                  <line className="st-grid" x1={RULER_W - 6} y1={y} x2={totalW} y2={y} />
                  <text className="st-tick" x={RULER_W - 10} y={y + 3.5} textAnchor="end">
                    {m.toLocaleString('en')}
                  </text>
                </g>
              )
            })}
            <text className="st-tick st-tick-unit" x={RULER_W - 10} y={14} textAnchor="end">
              metres
            </text>
            <line className="st-baseline" x1={0} y1={baseY} x2={totalW} y2={baseY} />
            {columns.map((col) => {
              const left = x
              x += col.width + COL_GAP
              return (
                <g key={col.key} transform={`translate(${left} 0)`}>
                  {col.node}
                  <text className="st-name" x={col.width / 2} y={baseY + 15} textAnchor="middle">
                    {labelLines(col.name).map((line, i) => (
                      <tspan key={line} x={col.width / 2} dy={i === 0 ? 0 : 11}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                  <text
                    className="st-sub"
                    x={col.width / 2}
                    y={baseY + 17 + labelLines(col.name).length * 12}
                    textAnchor="middle"
                  >
                    {col.sub}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
        <p className="st-plate-note">{plate.note}</p>
      </figure>
    )
  }

  // --- span plate -------------------------------------------------------
  const maxSpanM = Math.max(
    ...items.map((c) => Math.max(c.silhouette!.spanM ?? 0, c.silhouette!.depthM ?? 0)),
  )
  const k = SPAN_W / maxSpanM
  const human = scaleRefs.find((r) => r.id === 'human')
  const rows = items.map((item) => {
    const sil = item.silhouette!
    const depth = Math.max(sil.depthM ?? 0, 4)
    return { item, sil, h: Math.max(depth * k, 52) + 34 }
  })
  const totalH = rows.reduce((acc, r) => acc + r.h + ROW_GAP, 0) + 40
  const totalW = SPAN_W + RULER_W + 20
  const step = metreStep(maxSpanM)

  let y = 26
  return (
    <figure className="st-plate" aria-labelledby={titleId}>
      <figcaption>
        <h3 id={titleId} className="font-display st-plate-title">
          {plate.title}
        </h3>
        <p className="st-plate-intro">{plate.intro}</p>
      </figcaption>
      <div className="st-scroller" tabIndex={0} role="group" aria-label={`${plate.title} (scrolls sideways)`}>
        <svg
          className="st-svg"
          width={totalW}
          height={totalH}
          viewBox={`0 0 ${totalW} ${totalH}`}
          role="img"
          aria-label={`${plate.title}: ${items.map((c) => c.name).join(', ')}, all at one scale`}
        >
          {rows.map(({ item, sil, h }) => {
            const top = y
            y += h + ROW_GAP
            const cx = RULER_W + SPAN_W / 2
            const cy = top + (h - 24) / 2
            const spec = item.specs
            const bits = [
              spec.massKg?.v != null ? `${Number(spec.massKg.v).toLocaleString('en')} kg` : null,
              spec.pressurisedVolumeM3?.v != null
                ? `${spec.pressurisedVolumeM3.v} m³`
                : null,
              spec.crew?.v != null ? `crew ${spec.crew.v}` : null,
            ].filter(Boolean)
            return (
              <g key={item.id}>
                <SpanItem sil={sil} k={k} cx={cx} cy={cy} />
                {human && (
                  <HumanFigure
                    cx={RULER_W + 10}
                    baseY={top + h - 26}
                    h={Math.max(human.heightM * k, 9)}
                  />
                )}
                <text className="st-name" x={RULER_W} y={top + h - 8}>
                  {item.name}
                </text>
                <text className="st-sub" x={RULER_W} y={top + h + 6}>
                  {[`${(sil.spanM ?? 0).toLocaleString('en')} m across`, ...bits].join(' · ')}
                </text>
              </g>
            )
          })}
          <g transform={`translate(0 ${totalH - 22})`}>
            <line className="st-baseline" x1={RULER_W} y1={0} x2={RULER_W + maxSpanM * k} y2={0} />
            {Array.from({ length: Math.floor(maxSpanM / step) + 1 }, (_, i) => i * step).map((m) => (
              <g key={m}>
                <line className="st-grid" x1={RULER_W + m * k} y1={-5} x2={RULER_W + m * k} y2={0} />
                <text className="st-tick" x={RULER_W + m * k} y={12} textAnchor="middle">
                  {m.toLocaleString('en')}
                </text>
              </g>
            ))}
            <text className="st-tick st-tick-unit" x={RULER_W + maxSpanM * k + 6} y={12}>
              metres
            </text>
          </g>
        </svg>
      </div>
      <p className="st-plate-note">{plate.note}</p>
    </figure>
  )
}
