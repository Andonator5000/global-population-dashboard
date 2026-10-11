/**
 * Small shared pieces of the Taxonomy page: names, rank chips, flags, the
 * picture-or-placeholder thumb, and the credit line under every picture.
 *
 * Round 3 §44 built these; round 14 (§72) made the page photo-led, so they
 * grew up:
 * - pictures are CROPPED CONSISTENTLY (one aspect ratio per slot) instead of
 *   being squeezed into a fixed pixel height, which is what made the old
 *   card grid read as a ragged list;
 * - the "no photo" state is a DESIGNED placeholder in the taxon's own rank
 *   colour carrying its initial and the words "No free photograph found" --
 *   honest, never blank (the old neutral silhouette said nothing and, worse,
 *   looked like it might BE the organism);
 * - a picture that is a PhyloPic silhouette says so on its own chip, and is
 *   never cropped like a photograph (it is drawn to fit, on a plain ground);
 * - every picture carries author, licence and a link to its source, with the
 *   source NAMED (Commons, GBIF, iNaturalist, PhyloPic) rather than always
 *   claiming Commons.
 */

import { useEffect, useState } from 'react'

import {
  IMAGE_SOURCE_LABEL,
  ITALIC_RANKS,
  rankChipStyle,
  rankPlaceholderStyle,
  type TaxonImage,
  type TaxonNode,
} from '../../lib/taxonomy'

export const compactNumber = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
export const exactNumber = new Intl.NumberFormat('en')

export function TaxonName({ node }: { node: TaxonNode }) {
  return ITALIC_RANKS.has(node.rank) ? <i>{node.name}</i> : <>{node.name}</>
}

export function RankChip({
  rank,
  onInfo,
  size = 'xs',
}: {
  rank: string
  /** When set, the chip is a real button that shows the rank's
      definition. Omit inside row/card buttons — nested buttons are
      invalid HTML. */
  onInfo?: (rank: string) => void
  size?: 'xs' | 'sm'
}) {
  const classes = `rounded-sm border px-1.5 py-px font-sans leading-tight ${
    size === 'sm' ? 'text-xs' : 'text-[10px]'
  }`
  if (onInfo) {
    // An interactive chip clears the WCAG 2.5.8 web target size (24 CSS px)
    // even at the 10px legend type — the static chips beside it are labels,
    // not targets, so only this branch grows (round 14).
    return (
      <button
        type="button"
        className={`${classes} inline-flex cursor-pointer items-center px-2`}
        style={{
          ...rankChipStyle(rank),
          color: 'var(--text)',
          minHeight: 26,
        }}
        onClick={() => onInfo(rank)}
        title={`What is a ${rank}?`}
      >
        {rank}
      </button>
    )
  }
  return (
    <span className={classes} style={{ ...rankChipStyle(rank), color: 'var(--text)' }}>
      {rank}
    </span>
  )
}

export function Chip({
  children,
  tone,
  title,
}: {
  children: React.ReactNode
  tone?: 'flag'
  title?: string
}) {
  return (
    <span
      className="rounded-sm border px-1.5 py-px font-sans text-[10px] leading-tight"
      title={title}
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

/** Aspect ratio per picture slot. One ratio per slot is what makes a grid of
    photographs read as a plate rather than a pile (round 14). */
const SLOT_CLASS: Record<TaxonSlot, string> = {
  row: 'h-9 w-9 shrink-0 rounded-sm',
  card: 'aspect-[4/3] w-full',
  // 4:3 while the plate is one column, 4:5 once it splits in two at lg --
  // the ratio lives in index.css (`.tax-plate-img`, round 14) because
  // Tailwind cannot express a breakpoint-dependent aspect-ratio inline.
  plate: 'tax-plate-img w-full',
}

export type TaxonSlot = 'row' | 'card' | 'plate'

/**
 * The designed "no free photograph" state (round 14 §72c).
 *
 * Andy asked for AI-generated pictures where no free photograph exists.
 * Generation is not available here, and an AI picture of an organism
 * presented as a photograph would break the invariant that no flora/fauna
 * image ships unverified against its taxon — so the honest answer is a
 * placeholder that SAYS there is no photograph, in the taxon's own rank
 * colour, carrying its initial. It is a designed state, not an absence.
 */
export function TaxonPlaceholder({
  node,
  slot,
}: {
  node: TaxonNode
  slot: TaxonSlot
}) {
  const style = rankPlaceholderStyle(node.rank)
  const initial = node.name.trim().charAt(0).toUpperCase() || '?'
  return (
    <div
      className={`${SLOT_CLASS[slot]} flex select-none flex-col items-center justify-center overflow-hidden`}
      style={{ background: style.background }}
      role="img"
      aria-label={`No free photograph found for ${node.name}`}
    >
      <span
        aria-hidden="true"
        className="font-display leading-none"
        style={{
          color: style.color,
          fontSize: slot === 'row' ? '1.1rem' : slot === 'card' ? '2.4rem' : '4rem',
        }}
      >
        {initial}
      </span>
      {slot !== 'row' && (
        <span
          aria-hidden="true"
          className="mt-1.5 px-2 text-center font-sans text-[9px] uppercase leading-tight tracking-[0.14em]"
          style={{ color: 'var(--text-muted)' }}
        >
          No free photograph found
        </span>
      )}
    </div>
  )
}

/** A taxon's picture in one of the three slots, or the designed placeholder.
    Silhouettes are CONTAINED on a plain ground, never cropped like a photo.

    Pictures are HOTLINKED from Commons, the iNaturalist open-data bucket,
    GBIF publishers and PhyloPic, and a third party's URL can die between
    one monthly run and the next. A dead one used to render as the browser's
    broken-image box with the alt text spilling out of it; it now falls back
    to the same designed placeholder a taxon with no picture gets (round
    14). The ETL still has the record, so the next run re-checks it. */
export function TaxonThumb({
  node,
  slot,
}: {
  node: TaxonNode
  slot: TaxonSlot
}) {
  const img = node.img ?? null
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [img?.url])
  if (!img || broken) return <TaxonPlaceholder node={node} slot={slot} />
  const silhouette = img.kind === 'silhouette'
  return (
    <div
      className={`${SLOT_CLASS[slot]} overflow-hidden`}
      style={{
        // PhyloPic rasters are BLACK on transparent. On the dark theme's
        // sunken surface that is an invisible picture, so a silhouette gets
        // its own near-white plate ground in both themes — which is also
        // how a silhouette is printed in an atlas (round 14).
        background: silhouette ? 'oklch(96% 0 0)' : 'var(--surface-sunken)',
      }}
    >
      <img
        src={img.url}
        alt={
          silhouette
            ? `Silhouette of ${img.rep ?? node.name}`
            : img.rep
              ? `${img.rep}, a member of ${node.name}`
              : node.name
        }
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className={`h-full w-full ${silhouette ? 'object-contain p-[8%]' : 'object-cover'}`}
      />
    </div>
  )
}

/**
 * The credit line under a picture: what it is, whose it is, where it came
 * from, under what licence. CC licences make attribution a condition of
 * reuse, so this is never optional and never truncated away.
 */
export function ImageCredit({
  img,
  className = '',
}: {
  img: TaxonImage
  className?: string
}) {
  const source = IMAGE_SOURCE_LABEL[img.src ?? 'commons'] ?? 'Wikimedia Commons'
  return (
    <p
      className={`text-[10px] leading-snug ${className}`}
      style={{ color: 'var(--text-muted)' }}
    >
      {img.kind === 'silhouette' && (
        <span
          className="mr-1 rounded-sm border px-1 py-px font-sans uppercase tracking-wider"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}
        >
          Silhouette, not a photograph
        </span>
      )}
      {img.rep && (
        <>
          <span style={{ color: 'var(--text)' }}>Representative:</span>{' '}
          <i>{img.rep}</i> ·{' '}
        </>
      )}
      {img.author ?? 'Unknown author'} ·{' '}
      <a
        className="underline underline-offset-2"
        href={img.page}
        target="_blank"
        rel="noreferrer"
      >
        {source}
      </a>{' '}
      · {img.license}
    </p>
  )
}

/** The one-line count shown on rows and cards: species beneath a node
    where COL counts them, otherwise all recorded taxa beneath it. */
export function countLabel(node: TaxonNode): string | null {
  if (node.rank === 'species' || node.rank === 'subspecies') return null
  if (node.spp !== undefined && node.spp > 0) {
    return `${compactNumber.format(node.spp)} species`
  }
  if (node.names > 1) return `${compactNumber.format(node.names)} taxa`
  return null
}
