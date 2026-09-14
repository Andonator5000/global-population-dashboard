import { useCallback, useState } from 'react'

/**
 * Zoom-in / zoom-out / full-screen buttons with the optional vertical zoom
 * slider (round-2 §36; shared since round 3 §45 between the Global Data
 * maps and the Solar System scene).
 *
 * The buttons are ordinary DOM buttons, so keyboard and screen-reader users
 * get them without touching the canvas/SVG. Each button carries a tooltip
 * that is shown on hover AND focus-within and is itself hoverable, because
 * the "Show slider / Hide slider" link lives inside it. The slider's
 * visibility is a per-session convenience persisted in sessionStorage under
 * `storageKey` (the maps keep their historical 'map-zoom-slider' key).
 *
 * The slider is a 0–100 percentage owned by the caller: `sliderValue` is
 * where the view currently is, `onSliderChange` receives the value the reader
 * dragged to. What 0 and 100 mean (a d3-zoom scale, a camera distance) is the
 * caller's business, so the same control fits both surfaces.
 *
 * Styling: `.map-ctl`, `.map-tooltip`, `.map-tooltip-bubble` and
 * `.map-zoom-slider` in index.css; `buttonStyle` lets a dark viewport (the 3D
 * scene) use white-on-black buttons while the maps keep the theme tokens.
 */
export function ZoomControls({
  onZoomIn,
  onZoomOut,
  sliderValue,
  onSliderChange,
  isFullscreen,
  onToggleFullscreen,
  storageKey = 'map-zoom-slider',
  buttonStyle,
  buttonClassName = '',
  onReset,
  large = false,
  horizontal = false,
}: {
  onZoomIn: () => void
  onZoomOut: () => void
  /** Current zoom as 0–100 (100 = closest / most zoomed in). */
  sliderValue: number
  onSliderChange: (value: number) => void
  isFullscreen: boolean
  onToggleFullscreen: () => void
  storageKey?: string
  buttonStyle?: React.CSSProperties
  buttonClassName?: string
  /** Round 5 (§53.5): a "Reset view" button (initial orientation, zoom 1). */
  onReset?: () => void
  /** Thumb-sized 44 px targets for phones (§53.5). */
  large?: boolean
  /** A row instead of a column — for a short, wide stage (the flat map on
   *  a phone), where a column of four would hang below the map. */
  horizontal?: boolean
}) {
  // 44 px is the touch-target floor; 32 px is fine for a pointer.
  const size = large ? 'h-11 w-11 text-xl' : 'h-8 w-8 text-lg'
  const iconSize = large ? 'h-11 w-11' : 'h-8 w-8'
  const [sliderVisible, setSliderVisible] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) === '1'
    } catch {
      return false
    }
  })
  const toggleSlider = useCallback(() => {
    setSliderVisible((visible) => {
      const next = !visible
      try {
        sessionStorage.setItem(storageKey, next ? '1' : '0')
      } catch {
        /* per-session convenience only */
      }
      return next
    })
  }, [storageKey])

  const sliderLink = (
    <button type="button" className="underline underline-offset-2" onClick={toggleSlider}>
      {sliderVisible ? 'Hide slider' : 'Show slider'}
    </button>
  )

  return (
    <div className={`absolute right-3 top-3 z-10 flex gap-1.5 ${horizontal ? 'flex-row' : 'flex-col'}`}>
      <div className="map-ctl relative">
        <button
          type="button"
          aria-label="Zoom in"
          className={`${size} rounded leading-none ${buttonClassName}`}
          style={buttonStyle}
          onClick={onZoomIn}
        >
          +
        </button>
        <div className="map-tooltip">
          <span className="map-tooltip-bubble">Zoom in · {sliderLink}</span>
        </div>
      </div>
      {sliderVisible && (
        <input
          type="range"
          className="map-zoom-slider self-center"
          min={0}
          max={100}
          step={1}
          value={Math.round(Math.max(0, Math.min(100, sliderValue)))}
          onChange={(event) => onSliderChange(Number(event.target.value))}
          aria-label="Zoom level"
          aria-orientation="vertical"
        />
      )}
      <div className="map-ctl relative">
        <button
          type="button"
          aria-label="Zoom out"
          className={`${size} rounded leading-none ${buttonClassName}`}
          style={buttonStyle}
          onClick={onZoomOut}
        >
          −
        </button>
        <div className="map-tooltip">
          <span className="map-tooltip-bubble">Zoom out · {sliderLink}</span>
        </div>
      </div>
      <div className="map-ctl relative">
        <button
          type="button"
          aria-label={isFullscreen ? 'Exit full screen' : 'View full screen'}
          aria-pressed={isFullscreen}
          className={`flex ${iconSize} items-center justify-center rounded ${buttonClassName}`}
          style={buttonStyle}
          onClick={onToggleFullscreen}
        >
          {/* Inline SVG, not a glyph: the exit icon used to be U+1F87C,
              which most Windows/Android system fonts have no glyph for --
              so the button appeared EMPTY exactly while fullscreen. */}
          <svg
            viewBox="0 0 16 16"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {isFullscreen ? (
              <>
                {/* Arrows pointing inward: leave fullscreen. */}
                <path d="M6 2v4H2" />
                <path d="M10 2v4h4" />
                <path d="M6 14v-4H2" />
                <path d="M10 14v-4h4" />
              </>
            ) : (
              <>
                {/* Corner brackets pointing outward: enter fullscreen. */}
                <path d="M2 6V2h4" />
                <path d="M14 6V2h-4" />
                <path d="M2 10v4h4" />
                <path d="M14 10v4h-4" />
              </>
            )}
          </svg>
        </button>
        <div className="map-tooltip">
          <span className="map-tooltip-bubble">
            {isFullscreen ? 'Exit full screen' : 'Full screen'}
          </span>
        </div>
      </div>
      {onReset && (
        <div className="map-ctl relative">
          <button
            type="button"
            aria-label="Reset view (compass)"
            className={`flex ${iconSize} items-center justify-center rounded ${buttonClassName}`}
            style={buttonStyle}
            onClick={onReset}
          >
            {/* A compass (round 6, section 54.2, Andy's request): a ring
                with a needle, north filled. Reorients the globe or map to
                its default state. */}
            <svg
              viewBox="0 0 16 16"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="6.3" />
              <path d="M8 2.6l2 5.4-2 5.4-2-5.4z" />
              <path d="M8 2.6l2 5.4h-4z" fill="currentColor" />
            </svg>
          </button>
          <div className="map-tooltip">
            <span className="map-tooltip-bubble">Reset view · back to the default orientation</span>
          </div>
        </div>
      )}
    </div>
  )
}
