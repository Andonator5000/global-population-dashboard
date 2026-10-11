/**
 * The BODY of a taxon's entry: description with its source stated, the
 * flags, the contested note, the counts, the rank definition and the links.
 *
 * Round 2 (§39) and round 3 (§44.3-5) built this as one slab that also owned
 * the photo and the heading. Round 14 (§72) split it: `TaxonPlate` owns the
 * picture, the heading and the lineage rail and lays them out as an
 * editorial plate; this file is the prose and the apparatus underneath, so
 * the same body can sit beside a large picture on a desktop and under one in
 * the phone sheet without a second implementation.
 *
 * Unchanged rules: a generated summary is ALWAYS labelled; every other
 * description names its source; a live-loaded or not-yet-enriched taxon says
 * so in its own words rather than claiming nothing exists.
 */

import {
  colTaxonUrl,
  DESC_SOURCE_LABEL,
  generatedSummary,
  lifemapUrl,
  oneZoomUrl,
  rankDefinition,
  wikipediaSearchUrl,
  wikipediaUrl,
  type TaxonNode,
  type TaxonomyFile,
} from '../../lib/taxonomy'
import { capitalizeFirst } from '../../lib/format'
import { exactNumber } from './bits'

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
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading description…
      </p>
    ) : null
  }
  const shown = text.length > 760 ? `${text.slice(0, 740).trimEnd()}…` : text
  return (
    <div className="text-[0.95rem] leading-relaxed">
      {source === 'generated' && (
        <p
          className="mb-1.5 inline-block rounded-sm border px-1.5 py-0.5 font-sans text-[10px] leading-tight"
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="min-w-0 rounded-sm px-2.5 py-1.5"
      style={{ background: 'var(--surface-sunken)' }}
    >
      <dt
        className="font-sans text-[10px] uppercase leading-tight tracking-[0.12em]"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </dt>
      <dd className="mt-0.5 text-base tabular-nums">{value}</dd>
    </div>
  )
}

export function TaxonDetail({
  node,
  parent,
  file,
  extract,
  extractLoading,
  onLoadLive,
  liveLoaded,
}: DetailProps) {
  const selected = node
  const stats: { label: string; value: string }[] = []
  if (selected.spp !== undefined && selected.spp > 0 && selected.rank !== 'species') {
    stats.push({ label: 'Species', value: exactNumber.format(selected.spp) })
  }
  if (selected.gen !== undefined && selected.gen > 0) {
    stats.push({ label: 'Genera', value: exactNumber.format(selected.gen) })
  }
  if (selected.names > 0) {
    stats.push({ label: 'Taxa beneath', value: exactNumber.format(selected.names) })
  }
  if (selected.firstMa !== undefined) {
    stats.push({ label: 'First appearance', value: `~${selected.firstMa} Ma` })
  }

  return (
    <div className="flex flex-col gap-3">
      <Description
        node={selected}
        parent={parent}
        file={file}
        extract={extract}
        extractLoading={extractLoading}
      />

      {selected.pending && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Wikipedia and Wikidata have not been consulted for this taxon yet:
          the ~204k genera are enriched incrementally, a batch per monthly
          run.
        </p>
      )}
      {selected.live && (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Loaded live from the Catalogue of Life API (ChecklistBank); no
          Wikipedia or picture lookup happens at render time.
        </p>
      )}

      {selected.note && (
        <p
          className="rounded-sm border-l-4 px-3 py-2 text-sm"
          style={{
            borderColor: 'var(--supernova)',
            background: 'var(--surface-sunken)',
          }}
        >
          <strong style={{ fontWeight: 600 }}>Contested: </strong>
          {selected.note}
        </p>
      )}

      {stats.length > 0 && (
        <dl className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {stats.map((stat) => (
            <Stat key={stat.label} label={stat.label} value={stat.value} />
          ))}
        </dl>
      )}

      {selected.truncated && onLoadLive && !liveLoaded && (
        <button
          type="button"
          className="self-start rounded-sm border px-2.5 py-1.5 text-sm"
          style={{ borderColor: 'var(--border-strong)', minHeight: 36 }}
          onClick={() => onLoadLive(selected)}
        >
          Static list capped — load the full list live from Catalogue of Life
        </button>
      )}

      <p
        className="rounded-sm px-3 py-2 text-xs leading-snug"
        style={{ background: 'var(--surface-sunken)', color: 'var(--text-muted)' }}
      >
        {rankDefinition(selected.rank)}
      </p>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {selected.wiki ? (
          <a
            className="underline underline-offset-2"
            href={wikipediaUrl(selected.wiki)}
            target="_blank"
            rel="noreferrer"
          >
            Wikipedia
          </a>
        ) : selected.live || selected.pending ? (
          <a
            className="underline underline-offset-2"
            href={wikipediaSearchUrl(selected.name)}
            target="_blank"
            rel="noreferrer"
          >
            Search Wikipedia (not looked up
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
            Catalogue of Life record
          </a>
        )}
        <a
          className="underline underline-offset-2"
          href={oneZoomUrl(selected.name)}
          target="_blank"
          rel="noreferrer"
        >
          OneZoom
        </a>
        {selected.ncbi && (
          <a
            className="underline underline-offset-2"
            href={lifemapUrl(selected.ncbi)}
            target="_blank"
            rel="noreferrer"
          >
            Lifemap
          </a>
        )}
      </div>
    </div>
  )
}
