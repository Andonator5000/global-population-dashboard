import { useManifest } from '../lib/data'

/**
 * Data-freshness footer.
 *
 * Renders the three provenance dates separately and never collapses them --
 * `fetched_at` is when we downloaded a file, which says nothing about how old
 * the observations are. Also surfaces the ETL's non-fatal warnings, so
 * data-quality issues are visible to readers rather than buried in a build log.
 */
export function FreshnessPanel() {
  const state = useManifest()

  return (
    <footer
      className="border-t text-xs"
      style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
    >
      <div className="mx-auto max-w-7xl px-6 py-6">
        <h2 className="mb-3 font-medium" style={{ color: 'var(--text)' }}>
          Data freshness
        </h2>

        {state.status === 'loading' && <p>Loading provenance…</p>}

        {state.status === 'error' && (
          <p>
            Provenance manifest unavailable — {state.error.message}
          </p>
        )}

        {state.status === 'ready' && (
          <>
            <ul className="space-y-2">
              {Object.entries(state.data.sources).map(([key, source]) => (
                <li key={key}>
                  <a
                    href={source.url}
                    className="underline underline-offset-2"
                    style={{ color: 'var(--text)' }}
                  >
                    {source.title}
                  </a>
                  <span>
                    {' '}
                    — observations{' '}
                    {source.vintage ?? 'vintage not stated by publisher'};
                    {' '}released{' '}
                    {source.upstream_release ??
                      'release date not published upstream'};
                    {' '}retrieved {source.fetched_at.slice(0, 10)}
                  </span>
                </li>
              ))}
            </ul>

            {state.data.warnings.length > 0 && (
              <div className="mt-4">
                <h3 className="font-medium" style={{ color: 'var(--text)' }}>
                  Known data-quality notes ({state.data.warnings.length})
                </h3>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {state.data.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <p className="mt-4">
              Pipeline v{state.data.pipeline_version}, generated{' '}
              {state.data.generated_at.slice(0, 10)}. Editorial rules are
              documented in {state.data.editorial_decisions_doc}.
            </p>
          </>
        )}
      </div>
    </footer>
  )
}
