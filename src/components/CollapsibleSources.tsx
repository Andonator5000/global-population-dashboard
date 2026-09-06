/**
 * Shared collapsible Sources wrapper (round-2 design pass, §34).
 *
 * Every page's provenance block sits inside one of these, COLLAPSED by
 * default behind a compact "Sources (N)" row — the maintainer's ruling
 * that the always-open freshness table cost too much page on every
 * viewport. Discoverability is preserved by the count in the summary row
 * and by the panel sitting in the same place on every page.
 *
 * Built on <details>/<summary> so keyboard and screen-reader semantics
 * come from the platform: Enter/Space toggles, the expanded state is
 * announced, and expansion only ever grows the page downward from the
 * bottom, so nothing above shifts.
 */
export function CollapsibleSources({
  count,
  label = 'Sources & data freshness',
  children,
}: {
  /** Number shown in the toggle row; omit while it is still loading. */
  count?: number | undefined
  label?: string
  children: React.ReactNode
}) {
  return (
    <details className="sources-disclosure group">
      <summary>
        <span aria-hidden="true" className="sources-chevron inline-block">
          ▸
        </span>
        {label}
        {count !== undefined && (
          <span style={{ color: 'var(--text-muted)' }}>({count})</span>
        )}
      </summary>
      <div className="pb-2">{children}</div>
    </details>
  )
}
