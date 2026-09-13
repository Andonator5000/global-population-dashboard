/**
 * Bottom sheet for the taxon detail on small viewports (round 3 §44.4).
 *
 * Tapping a row on a phone used to load the card ABOVE the viewport, so
 * the reader had to scroll up to find it. The sheet brings the card to
 * the reader instead: a modal dialog anchored to the bottom, scrolling
 * inside itself, with a scrim. Accessibility: role="dialog" +
 * aria-modal, focus moves to the close button on open and RETURNS to the
 * element that opened it on close, Escape closes, the scrim closes, and
 * the page behind is inert while it is open. The slide-up transition is
 * driven from here (no shared class in index.css to keep in sync) and
 * skips the animation outright under prefers-reduced-motion: the sheet
 * still opens and closes, just without the transform/opacity tween.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

import { rankAccent } from '../../lib/taxonomy'

export function DetailSheet({
  open,
  title,
  rank,
  onClose,
  children,
}: {
  open: boolean
  title: string
  rank: string
  onClose: () => void
  children: ReactNode
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  // Starts below the viewport (or already in place under reduced motion)
  // and is flipped to `true` a frame after mount so the browser has a
  // starting position to transition FROM.
  const [entered, setEntered] = useState(false)
  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement as HTMLElement | null
    // Focus the close button once mounted; the sheet's heading is the
    // dialog's accessible name via aria-labelledby.
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())
    // A second frame so the initial (off-screen) transform paints before
    // flipping the class that transitions it into place.
    const enterFrame = window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => setEntered(true)),
    )
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const main = document.getElementById('taxonomy-main')
    main?.setAttribute('inert', '')
    return () => {
      window.cancelAnimationFrame(frame)
      window.cancelAnimationFrame(enterFrame)
      setEntered(false)
      document.body.style.overflow = previousOverflow
      main?.removeAttribute('inert')
      const opener = openerRef.current
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !sheetRef.current) return
      // Focus trap: cycle within the sheet.
      const focusable = sheetRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
      )
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  // No transition at all under reduced motion (the sheet is simply present
  // or absent); otherwise a 220ms ease-out slide/fade driven by `entered`.
  const transition = reducedMotion ? 'none' : 'transform 220ms ease-out'
  const scrimTransition = reducedMotion ? 'none' : 'opacity 220ms ease-out'

  return (
    <div className="fixed inset-0 z-50 lg:hidden" data-testid="detail-sheet">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background: 'rgb(0 0 0 / 0.45)',
          opacity: reducedMotion || entered ? 1 : 0,
          transition: scrimTransition,
        }}
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-sheet-title"
        className="taxonomy-sheet absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-2xl border-t"
        style={{
          background: 'var(--surface-raised)',
          borderColor: 'var(--border)',
          boxShadow: '0 -8px 24px rgb(0 0 0 / 0.18)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          transform: reducedMotion || entered ? 'translateY(0)' : 'translateY(100%)',
          transition,
        }}
      >
        <div className="flex items-center justify-between gap-3 px-5 pt-2">
          <span
            aria-hidden="true"
            className="mx-auto h-1 w-10 rounded-full"
            style={{ background: rankAccent(rank) }}
          />
        </div>
        <div className="flex items-start justify-between gap-3 px-5 pb-1">
          <p
            id="detail-sheet-title"
            className="font-sans text-[10px] font-medium uppercase tracking-widest"
            style={{ color: 'var(--text-muted)' }}
          >
            {title}
          </p>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close taxon details"
            className="-mr-2 -mt-1 rounded border px-2 py-1 font-sans text-sm"
            style={{ borderColor: 'var(--border)', minWidth: 44, minHeight: 36 }}
          >
            Close
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 pb-5 pt-5">{children}</div>
      </div>
    </div>
  )
}
