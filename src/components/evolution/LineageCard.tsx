import type { EvolutionTreeFile, TreeNode } from '../../lib/evolution'
import { formatAge } from '../../lib/evolution'
import { ancestorsOf, type TreeIndex } from './treeLayout'

const ORIGIN_KIND_COPY: Record<TreeNode['originKind'], string> = {
  divergence: 'molecular-clock divergence estimate',
  fossil: 'oldest accepted fossil',
  estimate: 'estimate from clocks and fossils together',
}

/**
 * The side card for one lineage (round 14, §73): what it is, when it
 * arose and how that date is known, how it ended if it did, the merger it
 * records if any, its silhouette with attribution, and every source. The
 * lineage breadcrumb and the expand/collapse control live here too, so a
 * phone reader can navigate the whole tree from the card.
 */
export function LineageCard({
  node,
  tree,
  index,
  collapsed,
  canCollapse,
  onSelect,
  onToggle,
}: {
  node: TreeNode
  tree: EvolutionTreeFile
  index: TreeIndex
  collapsed: boolean
  canCollapse: boolean
  onSelect: (id: string) => void
  onToggle: (id: string) => void
}) {
  const ancestors = ancestorsOf(index, node.id)
  const children = index.children.get(node.id) ?? []
  const leaves = index.leafCount.get(node.id) ?? 1
  const groupLabel = tree.groups[node.group]
  const merges = node.merges ?? []
  return (
    <div className="tol-card" data-group={node.group}>
      <nav aria-label="Lineage" className="tol-breadcrumb">
        {ancestors.map((a) => (
          <button key={a.id} type="button" className="tol-crumb" onClick={() => onSelect(a.id)}>
            {a.name}
          </button>
        ))}
      </nav>
      <div className="flex items-start gap-3">
        {node.image && (
          <figure className="tol-card-figure m-0">
            <img
              className="tol-silhouette"
              src={node.image.url}
              alt={`Silhouette of ${node.image.matched ?? node.name}`}
              loading="lazy"
              width={72}
              height={72}
            />
          </figure>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="font-display m-0 text-lg leading-tight">{node.name}</h3>
          {node.scientific && node.scientific !== node.name && (
            <p className="m-0 text-sm italic" style={{ color: 'var(--text-muted)' }}>
              {node.scientific}
            </p>
          )}
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="tol-chip" style={{ ['--chip' as string]: `var(--tol-${node.group})` }}>
              {groupLabel}
            </span>
            <span className="tol-chip tol-chip--plain">
              {node.status === 'extinct' ? 'extinct' : 'living'}
            </span>
            {children.length > 0 && (
              <span className="tol-chip tol-chip--plain">
                {leaves} lineage{leaves === 1 ? '' : 's'} shown beneath
              </span>
            )}
          </p>
        </div>
      </div>

      <dl className="tol-facts">
        <div>
          <dt>Arose</dt>
          <dd>
            <strong>{formatAge(node.originMa)}</strong>
            <span style={{ color: 'var(--text-muted)' }}>
              {' '}
              ({ORIGIN_KIND_COPY[node.originKind]}
              {node.ageRange
                ? `; the literature ranges from ${formatAge(node.ageRange[0])} to ${formatAge(node.ageRange[1])}`
                : ''}
              )
            </span>
          </dd>
        </div>
        {node.status === 'extinct' && node.extinctMa !== null && (
          <div>
            <dt>Died out</dt>
            <dd>
              <strong>{formatAge(node.extinctMa)}</strong>
            </dd>
          </div>
        )}
        {merges.map((merge) => {
          const donor = index.byId.get(merge.from)
          return (
            <div key={merge.from}>
              <dt>{merge.label}</dt>
              <dd>
                {merge.note}{' '}
                {donor && (
                  <button type="button" className="tol-link" onClick={() => onSelect(donor.id)}>
                    See {donor.name}
                  </button>
                )}
              </dd>
            </div>
          )
        })}
      </dl>

      <p className="mt-2 text-sm leading-snug">{node.summary}</p>

      {children.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {canCollapse && (
            <button type="button" className="tol-button" onClick={() => onToggle(node.id)}>
              {collapsed ? `Expand ${children.length} branch${children.length === 1 ? '' : 'es'}` : 'Collapse this clade'}
            </button>
          )}
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Branches: {children.map((c) => c.name).join(' · ')}
          </span>
        </div>
      )}

      <p className="mt-2 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
        <a className="underline underline-offset-2" href={node.wikipedia} target="_blank" rel="noreferrer">
          Wikipedia
        </a>
        {node.sources.map((s) => (
          <span key={s.url}>
            {' · '}
            <a className="underline underline-offset-2" href={s.url} target="_blank" rel="noreferrer">
              {s.title}
            </a>
          </span>
        ))}
      </p>
      {node.image && (
        <p className="mt-1 text-[10px] leading-snug" style={{ color: 'var(--text-muted)' }}>
          Silhouette: {node.image.attribution ?? 'unknown author'} ·{' '}
          <a className="underline underline-offset-2" href={node.image.page} target="_blank" rel="noreferrer">
            PhyloPic
          </a>
          {' · '}
          {/^https?:/.test(node.image.license) ? (
            <a className="underline underline-offset-2" href={node.image.license} target="_blank" rel="noreferrer">
              licence
            </a>
          ) : (
            node.image.license
          )}
          {node.image.matched && node.image.matched.toLowerCase() !== (node.scientific ?? node.name).toLowerCase()
            ? ` · matched ${node.image.matched}`
            : ''}
        </p>
      )}
    </div>
  )
}
