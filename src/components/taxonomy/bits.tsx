/**
 * Small shared pieces of the Taxonomy page (round 3 §44): names, rank
 * chips, flags, and the photo-or-placeholder thumb.
 */

import {
  ITALIC_RANKS,
  rankChipStyle,
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
  const classes = `rounded border px-1 py-px font-sans leading-tight ${
    size === 'sm' ? 'text-xs' : 'text-[10px]'
  }`
  if (onInfo) {
    return (
      <button
        type="button"
        className={`${classes} cursor-pointer`}
        style={{ ...rankChipStyle(rank), color: 'var(--text)' }}
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
      className="rounded border px-1 py-px font-sans text-[10px] leading-tight"
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

/** Placeholder for taxa with no verifiably free photo (§39). */
export function PlaceholderSilhouette({ className }: { className?: string }) {
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

export function TaxonThumb({
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
