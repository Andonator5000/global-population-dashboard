import { useState } from 'react'

import { useManifest } from '../lib/data'

/**
 * Data-freshness footer.
 *
 * Renders the three provenance dates SEPARATELY and never collapses them:
 *
 *   vintage          what year the observations describe
 *   upstream_release when the publisher cut the release
 *   fetched_at       when we downloaded it — not a data date
 *
 * Conflating those is the usual way a dashboard implies its numbers are
 * fresher than they are. Where a publisher states none, that is said in words
 * rather than filled in with our fetch date.
 *
 * Also surfaces the ETL's non-fatal warnings. There are ten of them, and they
 * name real limitations — entities with no population series, biome coverage
 * gaps, the Morocco/Western Sahara boundary. Burying those in a build log
 * would leave readers to discover them by being surprised.
 */
/**
 * Render an upstream release identifier for humans.
 *
 * Servers offer one of two things and they are not equally useful. A
 * Last-Modified date is meaningful and shown as-is. An ETag is an opaque cache
 * token — `W/"1a4f1-8dtjGzlGpmC8r8Twr0B+StMP8nE"` tells a reader nothing and
 * looks like a rendering bug — so it is described rather than dumped, with the
 * raw value kept in the title for anyone who wants to compare builds.
 */
function ReleaseCell({ value }: { value: string | null }) {
  if (!value) {
    return (
      <span style={{ fontStyle: 'italic' }}>no release date published</span>
    )
  }
  const looksLikeEtag = value.startsWith('W/') || value.startsWith('"')
  if (looksLikeEtag) {
    return (
      <span title={value} style={{ fontStyle: 'italic' }}>
        version tag only, no date
      </span>
    )
  }
  return <span>{value}</span>
}

export function FreshnessPanel() {
  const state = useManifest()
  const [showWarnings, setShowWarnings] = useState(false)

  return (
    <footer
      className="mt-16 border-t text-xs"
      style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
    >
      <div className="mx-auto max-w-7xl px-6 py-8">
        <h2 className="mb-3 font-medium" style={{ color: 'var(--text)' }}>
          Data freshness
        </h2>

        {state.status === 'loading' && <p>Loading provenance…</p>}

        {state.status === 'error' && (
          <p>Provenance manifest unavailable — {state.error.message}</p>
        )}

        {state.status === 'ready' && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <caption className="sr-only">
                  Sources, the vintage of their observations, their release
                  date, and when this build retrieved them.
                </caption>
                <thead>
                  <tr className="border-b" style={{ borderColor: 'var(--border)' }}>
                    <th scope="col" className="py-1.5 pr-4 text-left font-medium">
                      Source
                    </th>
                    <th scope="col" className="py-1.5 pr-4 text-left font-medium">
                      Observations describe
                    </th>
                    <th scope="col" className="py-1.5 pr-4 text-left font-medium">
                      Publisher released
                    </th>
                    <th scope="col" className="py-1.5 pr-4 text-left font-medium">
                      We retrieved
                    </th>
                    <th scope="col" className="py-1.5 text-left font-medium">
                      Licence
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(state.data.sources).map(([key, source]) => (
                    <tr
                      key={key}
                      className="border-b align-top"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                        <a
                          href={source.url}
                          className="underline underline-offset-2"
                          style={{ color: 'var(--text)' }}
                        >
                          {source.title}
                        </a>
                      </th>
                      <td className="py-1.5 pr-4">
                        {source.vintage ?? (
                          <span style={{ fontStyle: 'italic' }}>
                            not stated by the publisher
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-4">
                        <ReleaseCell value={source.upstream_release} />
                      </td>
                      <td className="py-1.5 pr-4">
                        {source.fetched_at.slice(0, 10)}
                      </td>
                      <td className="py-1.5">{source.licence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {state.data.warnings.length > 0 && (
              <div className="mt-4">
                <button
                  type="button"
                  className="underline underline-offset-2"
                  style={{ color: 'var(--text)' }}
                  aria-expanded={showWarnings}
                  onClick={() => setShowWarnings((value) => !value)}
                >
                  {showWarnings ? 'Hide' : 'Show'} known data-quality notes (
                  {state.data.warnings.length})
                </button>
                {showWarnings && (
                  <ul className="mt-2 list-disc space-y-1.5 pl-5">
                    {state.data.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <p className="mt-4 max-w-3xl">
              “Observations describe” is the year of the underlying measurement;
              “we retrieved” is only when this build downloaded the file. They
              are different things and are never merged.
            </p>

            {state.data.refresh_policy && (
              <p className="mt-2 max-w-3xl">{state.data.refresh_policy}</p>
            )}

            <p className="mt-2">
              Pipeline v{state.data.pipeline_version}, generated{' '}
              {state.data.generated_at.slice(0, 10)}
              {state.data.content_fingerprint && (
                <>
                  {' '}
                  · data fingerprint{' '}
                  <code>{state.data.content_fingerprint.slice(0, 12)}</code>
                </>
              )}
              . Editorial rules are documented in{' '}
              {state.data.editorial_decisions_doc}.
            </p>
          </>
        )}
      </div>
    </footer>
  )
}
