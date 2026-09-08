import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  CATEGORY_ORDER,
  NO_DATA_FILL,
  PHASE_HUES,
  VIEWS,
  categoryAccent,
  categoryFill,
  formatNumber,
  scaleColour,
  viewDomain,
  viewPosition,
  viewValue,
  type CategoryKey,
  type ElementRecord,
  type ElementsFile,
  type ViewKey,
  type ViewSpec,
} from '../../lib/chemistry'

/**
 * The 18-column IUPAC table with the f-block as two footer rows (§47.2).
 *
 * Keyboard: the grid uses a roving tabindex — Tab lands on the selected
 * (or first) element, arrow keys move between elements (skipping the
 * table's empty cells), Home/End jump along the period, Enter or Space
 * opens the panel. Every cell is a real <button>, so pointer, touch and
 * screen-reader users get the same target.
 *
 * Colour: the category view tints each cell with its category hue; a
 * property view fills cells from one sequential hue ramp with lightness
 * as the data channel; a cell with no value is HATCHED and says so in
 * its label — never a colour that could be mistaken for a value.
 */

const COLS = 18
const ROWS = 10 // periods 1-7, a spacer, lanthanides, actinides

function phaseFill(phase: string | null): string {
  const hue = phase ? PHASE_HUES[phase] : undefined
  if (hue === undefined) return NO_DATA_FILL
  return `oklch(var(--chem-tint-l) var(--chem-tint-c) ${hue})`
}

export function PeriodicTable({
  file,
  view,
  selected,
  onSelect,
  highlight,
}: {
  file: ElementsFile
  view: ViewKey
  selected: number | null
  onSelect: (z: number) => void
  /** Category to emphasise (others dim); null = all. */
  highlight: CategoryKey | null
}) {
  const spec = useMemo(() => VIEWS.find((v) => v.key === view) ?? VIEWS[0]!, [view])
  const domain = useMemo(
    () => (spec.scale === 'linear' || spec.scale === 'log' ? viewDomain(file.elements, spec) : null),
    [file, spec],
  )
  const byPosition = useMemo(() => {
    const map = new Map<string, ElementRecord>()
    for (const element of file.elements) map.set(`${element.xpos},${element.ypos}`, element)
    return map
  }, [file])

  const [focusZ, setFocusZ] = useState<number>(selected ?? 1)
  useEffect(() => {
    if (selected) setFocusZ(selected)
  }, [selected])
  const buttons = useRef(new Map<number, HTMLButtonElement>())

  const move = useCallback(
    (from: ElementRecord, dx: number, dy: number, edge = false) => {
      let x = from.xpos
      let y = from.ypos
      let target: ElementRecord | undefined
      if (edge) {
        const row = file.elements.filter((e) => e.ypos === y)
        target = dx < 0
          ? row.reduce((a, b) => (b.xpos < a.xpos ? b : a))
          : row.reduce((a, b) => (b.xpos > a.xpos ? b : a))
      } else {
        for (let step = 0; step < Math.max(COLS, ROWS); step += 1) {
          x += dx
          y += dy
          if (x < 1 || x > COLS || y < 1 || y > ROWS) break
          target = byPosition.get(`${x},${y}`)
          if (target) break
        }
      }
      if (target) {
        setFocusZ(target.z)
        buttons.current.get(target.z)?.focus()
      }
    },
    [byPosition, file.elements],
  )

  const onKeyDown = (event: React.KeyboardEvent, element: ElementRecord) => {
    const keys: Record<string, [number, number]> = {
      ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1],
    }
    const delta = keys[event.key]
    if (delta) {
      event.preventDefault()
      move(element, delta[0], delta[1])
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      move(element, event.key === 'Home' ? -1 : 1, 0, true)
    }
  }

  const cellStyle = (element: ElementRecord): { background: string; noData: boolean; label: string } => {
    if (spec.scale === 'category') {
      return { background: categoryFill(element.category), noData: false, label: file.categories[element.category] }
    }
    if (spec.scale === 'phase') {
      const phase = element.properties.phaseAtStp.value as string | null
      return { background: phaseFill(phase), noData: phase === null, label: phase ?? 'no data' }
    }
    const value = viewValue(element, spec.key)
    if (value === null || !domain || (spec.scale === 'log' && value <= 0)) {
      return { background: NO_DATA_FILL, noData: true, label: 'no data' }
    }
    const t = viewPosition(value, domain, spec)
    const text = spec.key === 'discoveryYear'
      ? (value === -3000 ? 'ancient' : String(value))
      : formatNumber(value, spec.unit ?? null)
    return { background: scaleColour(t), noData: false, label: text }
  }

  const cells: React.ReactNode[] = []
  for (let y = 1; y <= ROWS; y += 1) {
    for (let x = 1; x <= COLS; x += 1) {
      const element = byPosition.get(`${x},${y}`)
      const key = `${x}-${y}`
      if (!element) {
        if (y === 6 && x === 3) {
          cells.push(<Marker key={key} x={x} y={y} text="57–71" />)
        } else if (y === 7 && x === 3) {
          cells.push(<Marker key={key} x={x} y={y} text="89–103" />)
        }
        continue
      }
      const { background, noData, label } = cellStyle(element)
      const dimmed = highlight !== null && element.category !== highlight
      const isSelected = selected === element.z
      cells.push(
        <button
          key={key}
          type="button"
          ref={(node) => {
            if (node) buttons.current.set(element.z, node)
            else buttons.current.delete(element.z)
          }}
          tabIndex={focusZ === element.z ? 0 : -1}
          aria-pressed={isSelected}
          aria-label={`${element.name}, ${element.symbol}, atomic number ${element.z}, ${spec.label.toLowerCase()} ${label}`}
          title={`${element.name} — ${spec.label}: ${label}`}
          onClick={() => onSelect(element.z)}
          onFocus={() => setFocusZ(element.z)}
          onKeyDown={(event) => onKeyDown(event, element)}
          className="ptable-cell relative flex flex-col items-start justify-between overflow-hidden rounded-[3px] border px-1 py-0.5 text-left leading-none"
          style={{
            gridColumn: x + 1,
            gridRow: y + 1,
            background,
            borderColor: isSelected ? 'var(--text)' : 'var(--border)',
            boxShadow: isSelected ? '0 0 0 2px var(--accent)' : undefined,
            opacity: dimmed ? 0.3 : 1,
            color: 'var(--text)',
            aspectRatio: '1 / 1.08',
            minWidth: 0,
          }}
        >
          <span className="text-[9px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            {element.z}
          </span>
          <span className="text-[clamp(11px,1.45vw,17px)] font-semibold">
            {element.symbol}
          </span>
          <span
            className="ptable-name w-full truncate text-[8px]"
            style={{ color: noData ? 'var(--text-muted)' : 'var(--text-muted)' }}
          >
            {spec.scale === 'category' ? element.name : noData ? 'no data' : label}
          </span>
        </button>,
      )
    }
  }

  return (
    <div>
      <div className="overflow-x-auto pb-2" role="region" aria-label="Periodic table, scrollable">
        <div
          role="grid"
          aria-label="Periodic table of the elements"
          className="grid gap-[3px]"
          style={{
            gridTemplateColumns: `1.4rem repeat(${COLS}, minmax(2.45rem, 1fr))`,
            gridTemplateRows: `1rem repeat(7, auto) 0.6rem repeat(2, auto)`,
            minWidth: '54rem',
          }}
        >
          {Array.from({ length: COLS }, (_, i) => (
            <span
              key={`g${i + 1}`}
              className="self-end text-center text-[9px] tabular-nums"
              style={{ gridColumn: i + 2, gridRow: 1, color: 'var(--text-muted)' }}
              aria-hidden="true"
            >
              {i + 1}
            </span>
          ))}
          {Array.from({ length: 7 }, (_, i) => (
            <span
              key={`p${i + 1}`}
              className="self-center text-center text-[9px] tabular-nums"
              style={{ gridColumn: 1, gridRow: i + 2, color: 'var(--text-muted)' }}
              aria-hidden="true"
            >
              {i + 1}
            </span>
          ))}
          <span
            className="self-center text-[8px] leading-none"
            style={{ gridColumn: 1, gridRow: 10, color: 'var(--text-muted)' }}
            aria-hidden="true"
          >
            La
          </span>
          <span
            className="self-center text-[8px] leading-none"
            style={{ gridColumn: 1, gridRow: 11, color: 'var(--text-muted)' }}
            aria-hidden="true"
          >
            Ac
          </span>
          {cells}
        </div>
      </div>
      <p className="mt-1 text-[11px] sm:hidden" style={{ color: 'var(--text-muted)' }}>
        Scroll sideways to see all 18 groups.
      </p>
    </div>
  )
}

function Marker({ x, y, text }: { x: number; y: number; text: string }) {
  return (
    <span
      className="flex items-center justify-center rounded-[3px] border border-dashed text-[8px] tabular-nums"
      style={{ gridColumn: x + 1, gridRow: y + 1, borderColor: 'var(--border)', color: 'var(--text-muted)' }}
      aria-hidden="true"
    >
      {text}
    </span>
  )
}

/** Legend for the active view: category chips, phase swatches, or the ramp. */
export function TableLegend({
  file,
  view,
  highlight,
  onHighlight,
}: {
  file: ElementsFile
  view: ViewKey
  highlight: CategoryKey | null
  onHighlight: (category: CategoryKey | null) => void
}) {
  const spec: ViewSpec = VIEWS.find((v) => v.key === view) ?? VIEWS[0]!
  if (spec.scale === 'category') {
    return (
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Category legend">
        {CATEGORY_ORDER.map((category) => (
          <li key={category}>
            <button
              type="button"
              aria-pressed={highlight === category}
              onClick={() => onHighlight(highlight === category ? null : category)}
              className="inline-flex items-center gap-1.5 rounded px-1 py-0.5"
              style={{
                background: highlight === category ? 'var(--control-selected-bg)' : undefined,
                color: highlight === category ? 'var(--control-selected-text)' : 'var(--text)',
              }}
            >
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-sm border"
                style={{ background: categoryFill(category), borderColor: categoryAccent(category) }}
              />
              {file.categories[category]}
            </button>
          </li>
        ))}
      </ul>
    )
  }
  if (spec.scale === 'phase') {
    return (
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Phase legend">
        {(['solid', 'liquid', 'gas'] as const).map((phase) => (
          <li key={phase} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm border" style={{ background: phaseFill(phase), borderColor: 'var(--border-strong)' }} />
            {phase.charAt(0).toUpperCase() + phase.slice(1)}
          </li>
        ))}
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm border" style={{ background: NO_DATA_FILL, borderColor: 'var(--border-strong)' }} />
          No data
        </li>
      </ul>
    )
  }
  const domain = viewDomain(file.elements, spec)
  if (!domain) return null
  const [lo, hi] = domain
  const fmt = (v: number) =>
    spec.key === 'discoveryYear' ? (v === -3000 ? 'ancient' : String(v)) : formatNumber(v, spec.unit ?? null)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-label={`${spec.label} scale`}>
      <span className="tabular-nums">{fmt(lo)}</span>
      <span
        aria-hidden="true"
        className="inline-block h-3 w-40 rounded-sm border"
        style={{
          background: `linear-gradient(to right, var(--chem-scale-lo), var(--chem-scale-hi))`,
          borderColor: 'var(--border-strong)',
        }}
      />
      <span className="tabular-nums">{fmt(hi)}</span>
      {spec.scale === 'log' && (
        <span style={{ color: 'var(--text-muted)' }}>(logarithmic)</span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="inline-block h-3 w-3 rounded-sm border" style={{ background: NO_DATA_FILL, borderColor: 'var(--border-strong)' }} />
        No data
      </span>
    </div>
  )
}
