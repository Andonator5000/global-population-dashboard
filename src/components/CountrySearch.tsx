import { useEffect, useId, useMemo, useRef, useState } from 'react'

/**
 * "Search countries" above the map (round 5, DATA_DECISIONS.md §53.4).
 *
 * Finding a small country on a phone should not require a precise tap on
 * a three-pixel island: type a few letters, pick the match, and the map
 * flies to it and opens its details. A plain text input with a listbox
 * (combobox pattern: arrow keys move the highlight, Enter picks, Escape
 * closes), no library. Matching is a case- and accent-insensitive prefix
 * on any word of the name, then a substring, so "ivo" finds Côte d'Ivoire
 * and "congo" finds both Congos.
 */
export interface SearchEntity {
  iso3: string
  name: string
}

const MAX_RESULTS = 8

function fold(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function CountrySearch({
  entities,
  onPick,
  placeholder = 'Search countries',
}: {
  entities: SearchEntity[]
  onPick: (iso3: string) => void
  placeholder?: string
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listId = useId()
  const root = useRef<HTMLDivElement>(null)

  const folded = useMemo(
    () => entities.map((entity) => ({ entity, key: fold(entity.name) })),
    [entities],
  )

  const results = useMemo(() => {
    const q = fold(query.trim())
    if (!q) return []
    const starts: SearchEntity[] = []
    const contains: SearchEntity[] = []
    for (const { entity, key } of folded) {
      if (key.startsWith(q) || key.split(/[\s\-']/).some((word) => word.startsWith(q))) {
        starts.push(entity)
      } else if (key.includes(q)) {
        contains.push(entity)
      }
    }
    return [...starts, ...contains].slice(0, MAX_RESULTS)
  }, [folded, query])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const choose = (entity: SearchEntity) => {
    setQuery('')
    setOpen(false)
    onPick(entity.iso3)
  }

  const expanded = open && results.length > 0

  return (
    <div ref={root} className="relative">
      <label className="sr-only" htmlFor={`${listId}-input`}>
        Search countries
      </label>
      <input
        id={`${listId}-input`}
        type="search"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
        autoComplete="off"
        enterKeyHint="search"
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            setActive((i) => Math.min(results.length - 1, i + 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActive((i) => Math.max(0, i - 1))
          } else if (event.key === 'Enter') {
            const hit = results[active]
            if (hit) {
              event.preventDefault()
              choose(hit)
            }
          } else if (event.key === 'Escape') {
            setOpen(false)
          }
        }}
        className="w-full rounded-lg border px-3 py-2.5 text-base sm:py-2 sm:text-sm"
        style={{
          borderColor: 'var(--border)',
          background: 'var(--surface)',
          color: 'var(--text)',
        }}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="Matching countries"
        hidden={!expanded}
        className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border py-1 text-sm shadow-md"
        style={{
          borderColor: 'var(--border-strong)',
          background: 'var(--surface-raised)',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        {results.map((entity, index) => (
          <li
            key={entity.iso3}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === active}
            className="cursor-pointer px-3 py-2.5 sm:py-1.5"
            style={{
              background: index === active ? 'var(--control-selected-bg)' : undefined,
              color: index === active ? 'var(--control-selected-text)' : 'var(--text)',
            }}
            onPointerEnter={() => setActive(index)}
            // pointerdown, not click: the input's blur would close the list
            // before a click could land.
            onPointerDown={(event) => {
              event.preventDefault()
              choose(entity)
            }}
          >
            {entity.name}
          </li>
        ))}
      </ul>
    </div>
  )
}
