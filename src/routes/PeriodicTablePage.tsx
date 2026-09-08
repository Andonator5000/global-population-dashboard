import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { CollapsibleSources } from '../components/CollapsibleSources'
import { ElementPanel } from '../components/chemistry/ElementPanel'
import { PeriodicTable, TableLegend } from '../components/chemistry/PeriodicTable'
import { Unavailable } from '../components/viz/primitives'
import {
  VIEWS,
  useElements,
  useGlossary,
  type CategoryKey,
  type ViewKey,
} from '../lib/chemistry'

/**
 * /chemistry — the interactive periodic table (round 3 §47).
 *
 * 118 elements in the IUPAC 18-column layout with the f-block footer,
 * colour-coded by category or recoloured by a property; clicking (or
 * pressing Enter on) an element opens the detail panel: photograph,
 * Bohr-model schematic, and every property with its source, vintage and
 * a ⓘ definition. The selected element is mirrored into the URL hash so
 * a link like /chemistry#Fe opens on iron.
 */

function readHash(): string | null {
  const hash = window.location.hash.replace('#', '')
  return hash || null
}

export function PeriodicTablePage() {
  const state = useElements()
  const glossary = useGlossary()
  const file = state.status === 'ready' ? state.data : null
  const [view, setView] = useState<ViewKey>('category')
  const [highlight, setHighlight] = useState<CategoryKey | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const panelHost = useRef<HTMLDivElement>(null)
  const lastCell = useRef<Element | null>(null)

  useEffect(() => {
    if (!file) return
    const hash = readHash()
    if (!hash) return
    const match = file.elements.find(
      (e) => e.symbol.toLowerCase() === hash.toLowerCase() || String(e.z) === hash,
    )
    if (match) setSelected(match.z)
  }, [file])

  const select = useCallback(
    (z: number) => {
      lastCell.current = document.activeElement
      setSelected(z)
      const element = file?.elements.find((e) => e.z === z)
      if (element) history.replaceState(null, '', `#${element.symbol}`)
      if (window.innerWidth < 1024) {
        requestAnimationFrame(() => {
          panelHost.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      }
    },
    [file],
  )

  const close = useCallback(() => {
    setSelected(null)
    history.replaceState(null, '', window.location.pathname)
    const target = lastCell.current
    if (target instanceof HTMLElement) target.focus()
  }, [])

  const element = file && selected ? file.elements.find((e) => e.z === selected) ?? null : null

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <header>
        <p className="font-sans text-xs font-medium uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
          Chemistry
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Periodic Table of the Elements</h1>
        <p className="mt-2 max-w-3xl text-sm" style={{ color: 'var(--text-muted)' }}>
          All 118 elements in the IUPAC layout. Select an element for its photograph, a
          Bohr-model schematic built from its electron configuration, and every property
          with its source and vintage — a figure no source publishes says so. Definitions for
          each property are one ⓘ away and collected on the{' '}
          <Link className="underline underline-offset-2" to="/chemistry/glossary">
            Chemistry glossary
          </Link>
          .
        </p>
      </header>

      {state.status === 'error' && (
        <div className="mt-6">
          <Unavailable what="Periodic table" source="the chemistry artifacts" reason={state.error.message} />
        </div>
      )}
      {state.status === 'loading' && (
        <p className="mt-6 text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading the periodic table…
        </p>
      )}

      {file && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Colour the table by">
              {VIEWS.map((spec) => {
                const active = spec.key === view
                return (
                  <button
                    key={spec.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setView(spec.key)
                      setHighlight(null)
                    }}
                    className="rounded border px-2 py-1 text-xs"
                    style={{
                      borderColor: active ? 'transparent' : 'var(--border)',
                      background: active ? 'var(--control-selected-bg)' : 'var(--surface-raised)',
                      color: active ? 'var(--control-selected-text)' : 'var(--text)',
                    }}
                  >
                    {spec.label}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="mt-3">
            <TableLegend file={file} view={view} highlight={highlight} onHighlight={setHighlight} />
          </div>

          <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
            <div className="min-w-0">
              <PeriodicTable
                file={file}
                view={view}
                selected={selected}
                onSelect={select}
                highlight={highlight}
              />
              <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                Keyboard: Tab to the table, arrow keys move between elements, Enter opens the
                panel, Escape closes it. Categories follow the common convention; elements
                109–118 are marked “unknown properties” because too few atoms have been made
                to test their chemistry.
              </p>
            </div>
            <div ref={panelHost} className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
              {element ? (
                <div
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') close()
                  }}
                >
                  <ElementPanel
                    element={element}
                    file={file}
                    glossaryEntries={glossary.status === 'ready' ? glossary.data.entries : []}
                    onClose={close}
                  />
                </div>
              ) : (
                <div
                  className="rounded-xl border px-5 py-5 text-sm"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--surface-raised)',
                    boxShadow: 'var(--shadow-card)',
                    color: 'var(--text-muted)',
                  }}
                >
                  Select an element for its photograph, atom model and forty sourced
                  properties. Photographs are Wikimedia Commons images under free licences,
                  served from this site with their author and licence; elements that have
                  never been seen in bulk say so and show the facility that made them.
                </div>
              )}
            </div>
          </div>

          <div className="mt-8">
            <CollapsibleSources count={Object.keys(file.sources).length}>
              <ul className="space-y-1 text-xs">
                {Object.entries(file.sources).map(([id, source]) => (
                  <li key={id}>
                    <a className="underline underline-offset-2" href={source.url} target="_blank" rel="noreferrer">
                      {source.title}
                    </a>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' '}· {source.vintage} · {source.licence}
                    </span>
                  </li>
                ))}
                <li style={{ color: 'var(--text-muted)' }}>
                  {file.furtherReading.rsc?.title}: {file.furtherReading.rsc?.note}
                </li>
              </ul>
            </CollapsibleSources>
          </div>
        </>
      )}
    </div>
  )
}

export default PeriodicTablePage
