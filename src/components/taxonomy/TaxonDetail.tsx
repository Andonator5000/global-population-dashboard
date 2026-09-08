/**
 * The detail card for one taxon (round 2 §39; round 3 §44.3–5): photo with
 * attribution, description with its SOURCE stated (a generated summary is
 * always labelled), counts, contested note, rank definition, lineage
 * breadcrumbs, and links. Rendered inside the sticky aside on wide
 * viewports and inside the bottom sheet on small ones.
 */

import {
  colTaxonUrl,
  DESC_SOURCE_LABEL,
  generatedSummary,
  lifemapUrl,
  oneZoomUrl,
  rankAccent,
  rankChipStyle,
  rankDefinition,
  wikipediaSearchUrl,
  wikipediaUrl,
  type TaxonNode,
  type TaxonomyFile,
} from '../../lib/taxonomy'
import { capitalizeFirst } from '../../lib/format'
import { exactNumber, RankChip, TaxonName, TaxonThumb } from './bits'

export interface DetailProps {
  node: TaxonNode
  parent: TaxonNode | undefined
  lineage: TaxonNode[]
  file: TaxonomyFile
  /** Shard text for this node when loaded (Wikipedia intro or the
      ETL-generated summary); null while loading or when none. */
  extract: string | null
  extractLoading: boolean
  onReveal: (node: TaxonNode) => void
  onRankInfo: (rank: string) => void
  /** Static list capped at build time: offer the full live list. */
  onLoadLive?: ((node: TaxonNode) => void) | undefined
  liveLoaded?: boolean | undefined
}

function Description({
  node,
  parent,
  file,
  extract,
  extractLoading,
}: Pick<DetailProps, 'node' | 'parent' | 'file' | 'extract' | 'extractLoading'>) {
  const source = node.descSrc ?? (node.desc ? 'wikidata' : 'generated')
  let text: string | null = null
  if (source === 'wikipedia' || source === 'generated') {
    text = extract ?? node.desc ?? null
    if (text === null && source === 'generated') text = generatedSummary(node, parent)
  } else {
    text = node.desc ?? null
  }
  if (text === null) {
    return extractLoading ? (
      <p className="mt-3 text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading description…
      </p>
    ) : null
  }
  const shown = text.length > 620 ? `${text.slice(0, 600).trimEnd()}…` : text
  return (
    <div className="mt-3 text-sm">
      {source === 'generated' && (
        <p
          className="mb-1 inline-block rounded border px-1.5 py-0.5 font-sans text-[10px] leading-tight"
          style={{
            borderColor: 'var(--border-strong)',
            background: 'var(--surface-sunken)',
            color: 'var(--text)',
          }}
        >
          {DESC_SOURCE_LABEL.generated}
        </p>
      )}
      <p>
        {capitalizeFirst(shown)}
        {source !== 'generated' && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {' '}
            — {DESC_SOURCE_LABEL[source]}
            {source === 'wikipedia' && file.extractsRetrieved
              ? `, retrieved ${file.extractsRetrieved}`
              : ''}
          </span>
        )}
      </p>
    </div>
  )
}

export function TaxonDetail({
  node,
  parent,
  lineage,
  file,
  extract,
  extractLoading,
  onReveal,
  onRankInfo,
  onLoadLive,
  liveLoaded,
}: DetailProps) {
  const selected = node
  return (
    <>
      <div
        className="-mx-5 -mt-5 mb-3 rounded-t-xl border-b-4 px-5 pb-2 pt-3"
        style={{ borderColor: rankAccent(selected.rank) }}
      >
        <h2 className="pr-8 text-xl">
          <TaxonName node={selected} />
        </h2>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm">
          <RankChip rank={selected.rank} onInfo={onRankInfo} />
          {selected.common && (
            <span style={{ color: 'var(--text-muted)' }}>
              {capitalizeFirst(selected.common)}
            </span>
          )}
          {selected.auth && (
            <span style={{ color: 'var(--text-muted)' }}>{selected.auth}</span>
          )}
          {selected.extinct && (
            <span style={{ color: 'var(--text-muted)' }}>† extinct</span>
          )}
        </p>
      </div>

      <TaxonThumb node={selected} size="panel" />
      {selected.img ? (
        <p className="mt-1 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
          {selected.img.rep && (
            <>
              Representative: <i>{selected.img.rep}</i> ·{' '}
            </>
          )}
          {selected.img.author ?? 'Unknown author'} ·{' '}
          <a
            className="underline underline-offset-2"
            href={selected.img.page}
            target="_blank"
            rel="noreferrer"
          >
            Commons
          </a>{' '}
          · {selected.img.license}
        </p>
      ) : (
        <p className="mt-1 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
          {selected.live
            ? 'Loaded live from Catalogue of Life — no photo lookup at render time.'
            : selected.pending
              ? 'Photo not looked up yet (enrichment is incremental).'
              : 'No free photo found for this taxon or any member.'}
        </p>
      )}

      <Description
        node={selected}
        parent={parent}
        file={file}
        extract={extract}
        extractLoading={extractLoading}
      />

      {selected.pending && (
        <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          Wikipedia and Wikidata have not been consulted for this taxon yet:
          the ~217k genera are enriched incrementally, a batch per monthly
          run.
        </p>
      )}
      {selected.live && (
        <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          Loaded live from the Catalogue of Life API (ChecklistBank); no
          Wikipedia or photo lookup happens at render time.
        </p>
      )}

      {selected.note && (
        <p
          className="mt-3 rounded border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          <strong style={{ fontWeight: 600 }}>Contested: </strong>
          {selected.note}
        </p>
      )}

      <dl className="mt-3 space-y-1 text-sm">
        {selected.names > 0 && (
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--text-muted)' }}>
              Taxa beneath it in Catalogue of Life
            </dt>
            <dd className="tabular-nums">{exactNumber.format(selected.names)}</dd>
          </div>
        )}
        {selected.spp !== undefined && selected.spp > 0 && selected.rank !== 'species' && (
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--text-muted)' }}>Species</dt>
            <dd className="tabular-nums">{exactNumber.format(selected.spp)}</dd>
          </div>
        )}
        {selected.gen !== undefined && selected.gen > 0 && (
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--text-muted)' }}>Genera</dt>
            <dd className="tabular-nums">{exactNumber.format(selected.gen)}</dd>
          </div>
        )}
        {selected.firstMa !== undefined && (
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--text-muted)' }}>First appearance (Wikidata)</dt>
            <dd className="tabular-nums">~{selected.firstMa} Ma</dd>
          </div>
        )}
      </dl>

      {selected.truncated && onLoadLive && !liveLoaded && (
        <button
          type="button"
          className="mt-3 rounded border px-2.5 py-1 text-sm"
          style={{ borderColor: 'var(--border)' }}
          onClick={() => onLoadLive(selected)}
        >
          Static list capped — load the full list live from Catalogue of Life
        </button>
      )}

      <p
        className="mt-3 rounded px-3 py-2 text-xs leading-snug"
        style={{ background: 'var(--surface-sunken)', color: 'var(--text-muted)' }}
      >
        {rankDefinition(selected.rank)}
      </p>

      {lineage.length > 1 && (
        <div className="mt-3">
          <h3
            className="font-sans text-xs font-medium uppercase tracking-widest"
            style={{ color: 'var(--text-muted)' }}
          >
            Lineage
          </h3>
          <nav aria-label="Lineage breadcrumbs" className="mt-1 flex flex-wrap items-center gap-1">
            {lineage.map((ancestor, position) => (
              <span key={ancestor.id || 'root'} className="flex items-center gap-1">
                {position > 0 && (
                  <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>
                    ›
                  </span>
                )}
                <button
                  type="button"
                  className="rounded border px-1.5 py-0.5 font-sans text-xs"
                  style={rankChipStyle(ancestor.rank)}
                  onClick={() => onReveal(ancestor)}
                  aria-current={ancestor.id === selected.id ? 'true' : undefined}
                >
                  <TaxonName node={ancestor} />
                </button>
              </span>
            ))}
          </nav>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-1 text-sm">
        {selected.wiki ? (
          <a
            className="underline underline-offset-2"
            href={wikipediaUrl(selected.wiki)}
            target="_blank"
            rel="noreferrer"
          >
            Wikipedia: {selected.wiki}
          </a>
        ) : selected.live || selected.pending ? (
          <a
            className="underline underline-offset-2"
            href={wikipediaSearchUrl(selected.name)}
            target="_blank"
            rel="noreferrer"
          >
            Search Wikipedia for {selected.name} (not looked up
            {selected.live ? ' for live-loaded taxa' : ' yet'})
          </a>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>
            No English Wikipedia article recorded (via Wikidata).
          </span>
        )}
        {selected.id && (
          <a
            className="underline underline-offset-2"
            href={colTaxonUrl(file.col_dataset_url, selected.id)}
            target="_blank"
            rel="noreferrer"
          >
            Source record in Catalogue of Life
          </a>
        )}
        <a
          className="underline underline-offset-2"
          href={oneZoomUrl(selected.name)}
          target="_blank"
          rel="noreferrer"
        >
          View on OneZoom
        </a>
        {selected.ncbi && (
          <a
            className="underline underline-offset-2"
            href={lifemapUrl(selected.ncbi)}
            target="_blank"
            rel="noreferrer"
          >
            View on Lifemap
          </a>
        )}
      </div>
    </>
  )
}
