import { useEffect, useId, useRef } from 'react'

const PLAY_INTERVAL_MS = 260

/**
 * Year scrubber for the map.
 *
 * A native range input rather than a custom-drawn track, because the native
 * control already gives arrow-key stepping, Home/End, page-up/down and screen
 * reader value announcements for free — all of which a bespoke slider has to
 * reimplement and usually reimplements badly.
 *
 * The estimate/projection boundary is drawn on the track and named in the
 * label, so the reader always knows whether the year they have selected is
 * measured or modelled.
 *
 * Playback stops at the end rather than looping: a loop makes it easy to watch
 * the projection replay and lose track of where measurement ended.
 */
export function TimeScrubber({
  years,
  value,
  onChange,
  estimatesThrough,
  playing,
  onPlayingChange,
}: {
  years: number[]
  value: number
  onChange: (year: number) => void
  estimatesThrough: number
  playing: boolean
  onPlayingChange: (playing: boolean) => void
}) {
  const id = useId()
  const first = years[0] ?? 1950
  const last = years[years.length - 1] ?? 2100
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!playing) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onPlayingChange(false)
      return
    }
    const timer = window.setInterval(() => {
      onChangeRef.current(value >= last ? last : value + 1)
      if (value >= last) onPlayingChange(false)
    }, PLAY_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [playing, value, last, onPlayingChange])

  const isProjection = value > estimatesThrough
  const boundaryPercent =
    last > first ? ((estimatesThrough - first) / (last - first)) * 100 : 0

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => onPlayingChange(!playing)}
          aria-pressed={playing}
          className="rounded border px-2.5 py-1 text-sm"
          style={{
            borderColor: 'var(--border)',
            background: playing ? 'var(--map-accent-fill)' : 'transparent',
          }}
        >
          {playing ? 'Pause' : 'Play'}
        </button>

        <label htmlFor={id} className="flex items-center gap-2 text-sm">
          <span style={{ color: 'var(--text-muted)' }}>Year</span>
          <span
            className="font-medium"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {value}
          </span>
          <span
            className="rounded px-1.5 py-0.5 text-xs"
            style={{
              border: '1px solid var(--border)',
              color: 'var(--text-muted)',
            }}
          >
            {isProjection ? 'projection' : 'estimate'}
          </span>
        </label>

        <button
          type="button"
          onClick={() => onChange(estimatesThrough)}
          className="text-xs underline underline-offset-2"
          style={{ color: 'var(--text-muted)' }}
        >
          Jump to last estimate ({estimatesThrough})
        </button>
      </div>

      <div className="relative mt-2">
        <input
          id={id}
          type="range"
          min={first}
          max={last}
          step={1}
          value={value}
          onChange={(event) => {
            onPlayingChange(false)
            onChange(Number(event.target.value))
          }}
          className="w-full"
          aria-valuetext={`${value}, ${isProjection ? 'medium-variant projection' : 'estimate'}`}
          style={{ accentColor: 'var(--accent)' }}
        />
        {/* Boundary marker on the track. Decorative: the same information is
            in the label and in aria-valuetext. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-full"
        >
          <div
            className="absolute top-0 h-full border-l"
            style={{
              left: `${boundaryPercent}%`,
              borderColor: 'var(--text-muted)',
            }}
          />
        </div>
      </div>

      <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
        {first}–{estimatesThrough} are UN WPP estimates; {estimatesThrough + 1}–
        {last} are the medium-variant projection. The marked line on the track
        is the boundary.
      </p>
    </div>
  )
}
