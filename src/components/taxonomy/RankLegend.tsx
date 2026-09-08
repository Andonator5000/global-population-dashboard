/**
 * The rank legend (round 3 §44.1–2): the principal ranks as persistent
 * chips (buttons that show a definition), and a collapsible glossary of
 * EVERY rank in the rank system — grouped by tier, each with its own
 * colour, the codes that govern it, how many nodes on the page use it —
 * laid out as a two-column grid (fixed chip column, description column)
 * so every description starts at the same x-position at every width.
 */

import { useMemo } from 'react'

import {
  PRINCIPAL_RANKS,
  RANK_CODE_NOTE,
  RANK_SOURCES,
  RANK_TIER_LABELS,
  RANK_TIERS,
  RANKS,
  rankDefinition,
  rankInfo,
  rankOrder,
  type RankTier,
} from '../../lib/taxonomy'
import { RankChip } from './bits'

export function RankLegend({
  rankCounts,
  rankInfoOpen,
  onRankInfo,
}: {
  /** rank string -> number of loaded nodes carrying it. */
  rankCounts: Map<string, number>
  rankInfoOpen: string | null
  onRankInfo: (rank: string | null) => void
}) {
  const groups = useMemo(() => {
    const byTier = new Map<RankTier, string[]>()
    const names = new Set<string>([...Object.keys(RANKS), ...rankCounts.keys()])
    names.delete('root')
    for (const name of names) {
      const tier = rankInfo(name).tier
      const list = byTier.get(tier) ?? []
      list.push(name)
      byTier.set(tier, list)
    }
    return RANK_TIERS.map((tier) => ({
      tier,
      ranks: (byTier.get(tier) ?? []).sort((a, b) => rankOrder(a) - rankOrder(b)),
    })).filter((group) => group.ranks.length > 0)
  }, [rankCounts])

  const total = groups.reduce((sum, group) => sum + group.ranks.length, 0)
  const inUse = [...rankCounts.keys()].filter((rank) => rank !== 'root').length

  return (
    <>
      <div
        className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]"
        aria-label="Rank colour legend"
      >
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Principal ranks (click one for its definition):
        </span>
        {PRINCIPAL_RANKS.filter((rank) => rank !== 'root').map((rank) => (
          <RankChip key={rank} rank={rank} onInfo={onRankInfo} />
        ))}
      </div>
      {rankInfoOpen && (
        <div
          className="mt-2 grid grid-cols-[7.5rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded border px-3 py-2 text-xs leading-snug"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--surface-sunken)',
          }}
          role="note"
        >
          <span>
            <RankChip rank={rankInfoOpen} size="sm" />
          </span>
          <span className="min-w-0">{rankDefinition(rankInfoOpen)}</span>
          <button
            type="button"
            aria-label="Close rank definition"
            className="rounded px-1 font-sans"
            style={{ color: 'var(--text-muted)' }}
            onClick={() => onRankInfo(null)}
          >
            ×
          </button>
        </div>
      )}
      <details className="mt-2 text-xs">
        <summary
          className="cursor-pointer font-sans"
          style={{ color: 'var(--text-muted)' }}
        >
          Every rank, defined ({total} ranks; {inUse} used by the loaded tree)
        </summary>
        <p className="mt-2 max-w-3xl leading-snug" style={{ color: 'var(--text-muted)' }}>
          {RANK_CODE_NOTE}
        </p>
        {groups.map((group) => (
          <section key={group.tier} className="mt-3">
            <h3
              className="font-sans text-[10px] font-medium uppercase tracking-widest"
              style={{ color: 'var(--text-muted)' }}
            >
              {RANK_TIER_LABELS[group.tier]}
            </h3>
            <dl className="rank-grid mt-1.5 grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5">
              {group.ranks.map((rank) => {
                const info = rankInfo(rank)
                const count = rankCounts.get(rank)
                return (
                  <div key={rank} className="contents">
                    <dt className="min-w-0">
                      <RankChip rank={rank} />
                    </dt>
                    <dd className="m-0 min-w-0 leading-snug" style={{ color: 'var(--text-muted)' }}>
                      {info.def}
                      <span className="ml-1 whitespace-nowrap font-sans text-[10px]">
                        {info.codes.length > 0 ? `[${info.codes.join(', ')}]` : '[no code]'}
                        {count !== undefined && ` · ${count.toLocaleString('en')} on the page`}
                      </span>
                    </dd>
                  </div>
                )
              })}
            </dl>
          </section>
        ))}
        <details className="mt-3">
          <summary
            className="cursor-pointer font-sans"
            style={{ color: 'var(--text-muted)' }}
          >
            Sources for the rank system ({RANK_SOURCES.length})
          </summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 leading-snug">
            {RANK_SOURCES.map((source) => (
              <li key={source.url}>
                <a
                  className="underline underline-offset-2"
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {source.label}
                </a>
              </li>
            ))}
          </ul>
        </details>
      </details>
    </>
  )
}
