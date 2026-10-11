/**
 * The PLATE (round 14 §72): one taxon presented the way a natural-history
 * atlas presents one — a large picture with its credit, the lineage it sits
 * in, the name set in the publication serif, and the apparatus underneath.
 *
 * It replaces the round-3 sticky 24rem aside, which was a column of
 * small type with a 160px-tall cropped photo wedged into it: the picture was
 * the point of the page and it was the smallest thing on it. The plate runs
 * the full content width above the explorer, so the same component serves
 * the desktop (picture left, text right) and the phone (picture, then text)
 * without a second layout, and the bottom sheet renders the same thing
 * stacked.
 *
 * Identity: a 3px Supernova rule across the top (the same mark the home
 * cards and the map toolbar carry), the rank's own hue as a keyline under
 * the picture and on the chips, never as text on a light ground.
 */

import {
  rankAccent,
  rankChipStyle,
  type TaxonNode,
} from '../../lib/taxonomy'
import { capitalizeFirst } from '../../lib/format'
import { Chip, ImageCredit, RankChip, TaxonName, TaxonThumb } from './bits'
import { TaxonDetail, type DetailProps } from './TaxonDetail'

export function LineageRail({
  lineage,
  onReveal,
  selectedId,
}: {
  lineage: TaxonNode[]
  onReveal: (node: TaxonNode) => void
  selectedId: string
}) {
  if (lineage.length < 2) return null
  return (
    <nav
      aria-label="Lineage"
      className="tax-rail -mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1"
    >
      {lineage.map((ancestor, position) => (
        <span key={ancestor.id || 'root'} className="flex shrink-0 items-center gap-1">
          {position > 0 && (
            <span aria-hidden="true" className="text-xs" style={{ color: 'var(--text-muted)' }}>
              ›
            </span>
          )}
          <button
            type="button"
            className="whitespace-nowrap rounded-sm border px-2 py-1 font-sans text-xs"
            style={{
              ...rankChipStyle(ancestor.rank),
              color: 'var(--text)',
              minHeight: 32,
            }}
            onClick={() => onReveal(ancestor)}
            aria-current={ancestor.id === selectedId ? 'true' : undefined}
          >
            <TaxonName node={ancestor} />
          </button>
        </span>
      ))}
    </nav>
  )
}

/** The headline block: name, authority, common name, rank and flags. */
function PlateHeading({
  node,
  onRankInfo,
  compact,
}: {
  node: TaxonNode
  onRankInfo: (rank: string) => void
  compact: boolean
}) {
  return (
    <div>
      <h2
        className={`font-display leading-tight ${compact ? 'text-2xl' : 'text-3xl'}`}
      >
        <TaxonName node={node} />
      </h2>
      {(node.common || node.auth) && (
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          {node.common && (
            <span style={{ color: 'var(--text)' }}>
              {capitalizeFirst(node.common)}
            </span>
          )}
          {node.common && node.auth ? ' · ' : ''}
          {node.auth}
        </p>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-1.5">
        <RankChip rank={node.rank} onInfo={onRankInfo} size="sm" />
        {node.extinct && <Chip title="Catalogue of Life marks this taxon extinct">† extinct</Chip>}
        {node.note && <Chip tone="flag">contested</Chip>}
        {node.provisional && <Chip>provisional</Chip>}
        {node.focus && <Chip title="An editorial focus family: its genera and species ship in full">full depth</Chip>}
        {node.live && <Chip title="Loaded live from Catalogue of Life">live</Chip>}
        {node.pending && <Chip title="Wikipedia not looked up yet">not yet enriched</Chip>}
      </p>
    </div>
  )
}

/** The picture, its rank keyline and its credit — the figure of the plate. */
function PlateFigure({ node }: { node: TaxonNode }) {
  return (
    <figure className="m-0">
      <div
        className="overflow-hidden rounded-sm border"
        style={{ borderColor: 'var(--border)' }}
      >
        <TaxonThumb node={node} slot="plate" />
        <div aria-hidden="true" className="h-[3px] w-full" style={{ background: rankAccent(node.rank) }} />
      </div>
      <figcaption className="mt-1.5">
        {node.img ? (
          <ImageCredit img={node.img} />
        ) : (
          <p className="text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            {node.live
              ? 'Loaded live from Catalogue of Life — no picture lookup at render time.'
              : node.pending
                ? 'Not looked up yet — picture enrichment is incremental.'
                : 'Every free source on the ladder was tried: Wikidata, Wikipedia, Wikimedia Commons, GBIF, iNaturalist and PhyloPic. Nothing freely licensed was found for this taxon or any member of it.'}
          </p>
        )}
      </figcaption>
    </figure>
  )
}

export function TaxonPlate({
  layout,
  ...props
}: DetailProps & { layout: 'plate' | 'sheet' }) {
  const { node, lineage, onReveal, onRankInfo } = props
  const compact = layout === 'sheet'
  const body = (
    <div className="flex min-w-0 flex-col gap-4">
      <PlateHeading node={node} onRankInfo={onRankInfo} compact={compact} />
      <TaxonDetail {...props} />
    </div>
  )

  if (compact) {
    return (
      <div className="flex flex-col gap-4">
        <PlateFigure node={node} />
        {body}
        <LineageRail lineage={lineage} onReveal={onReveal} selectedId={node.id} />
      </div>
    )
  }

  return (
    <section
      aria-label={`${node.rank} ${node.name}`}
      data-testid="taxon-plate"
      className="overflow-hidden rounded-lg border"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface-raised)',
        boxShadow: 'var(--shadow-card)',
        borderTop: '3px solid var(--supernova)',
      }}
    >
      <div className="px-4 pt-3 sm:px-6">
        <LineageRail lineage={lineage} onReveal={onReveal} selectedId={node.id} />
      </div>
      <div className="grid gap-5 px-4 pb-5 pt-3 sm:px-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:gap-7">
        <PlateFigure node={node} />
        {body}
      </div>
    </section>
  )
}

/**
 * The plate's resting state: six well-known groups as picture cards. The
 * page used to open on a row of text chips and an empty panel saying
 * "Select a taxon"; a page about life should open with life on it.
 */
export function PlateGallery({
  entries,
  onPick,
  note,
}: {
  entries: { label: string; node: TaxonNode }[]
  onPick: (node: TaxonNode) => void
  note: string | undefined
}) {
  return (
    <section
      aria-label="Start from a well-known group"
      className="overflow-hidden rounded-lg border"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface-raised)',
        boxShadow: 'var(--shadow-card)',
        borderTop: '3px solid var(--supernova)',
      }}
    >
      <div className="px-4 pt-4 sm:px-6">
        <h2 className="font-display text-xl">Start anywhere</h2>
        <p className="mt-1 max-w-2xl text-sm" style={{ color: 'var(--text-muted)' }}>
          Pick a group to open its plate, or search, or walk the tree below.
        </p>
      </div>
      <ul className="mt-3 grid list-none grid-cols-2 gap-3 px-4 pb-4 sm:grid-cols-3 sm:px-6 lg:grid-cols-6">
        {entries.map(({ label, node }) => (
          <li key={node.id || label}>
            <button
              type="button"
              onClick={() => onPick(node)}
              className="tax-card block w-full overflow-hidden rounded-sm border text-left"
              style={{ borderColor: 'var(--border)' }}
            >
              <TaxonThumb node={node} slot="card" />
              <div aria-hidden="true" className="h-[2px] w-full" style={{ background: rankAccent(node.rank) }} />
              <div className="px-2 py-1.5">
                <p className="truncate text-sm font-medium">{label}</p>
                <p className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                  <TaxonName node={node} />
                </p>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {note && (
        <p
          className="border-t px-4 py-2.5 text-[11px] leading-snug sm:px-6"
          style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
        >
          {note}
        </p>
      )}
    </section>
  )
}
