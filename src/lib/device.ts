/**
 * Device tier for the map renderers (round 4, DATA_DECISIONS.md §51).
 *
 * Phones run the same WebGL2 globe as a desktop, but with a fifth of the
 * fill rate and a fraction of the GPU memory. Rather than detect "mobile"
 * from the user agent, the map asks what actually governs the cost:
 * a coarse primary pointer (a touch screen is the strongest signal we
 * have on Apple devices, which expose neither memory nor core count),
 * reported device memory, and the logical core count. Any one of them
 * puts the device in the low-power tier; the renderers then cap the
 * backing-store resolution lower, hold fewer and smaller fine tiles,
 * and ask for less anisotropic filtering. Nothing about the data or
 * layout changes — only how many pixels and bytes the GPU is asked for.
 *
 * Evaluated once per page: a pointer type does not change mid-session,
 * and re-probing per frame would itself be a cost.
 */

let cached: boolean | null = null

export function lowPowerDevice(): boolean {
  if (cached !== null) return cached
  let low = false
  try {
    if (window.matchMedia('(pointer: coarse)').matches) low = true
    const nav = navigator as { deviceMemory?: number; hardwareConcurrency?: number }
    if (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) low = true
    if (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency <= 4) low = true
  } catch {
    low = false
  }
  cached = low
  return low
}

/**
 * Backing-store pixel ratio for the map canvases. Imagery and drag frames
 * are pictures, not text: beyond ~1.75 the extra device pixels cost more
 * than they show, and on a phone (dpr 2.6–3.5 is typical) 1.25 already
 * means ~500k fragments per full-screen pass, each running the inverse
 * projection with four transcendentals. The SVG that returns at rest is
 * resolution-independent, so the cap never touches the map people read.
 */
export function canvasPixelRatio(): number {
  const cap = lowPowerDevice() ? 1.25 : 1.75
  return Math.min(window.devicePixelRatio || 1, cap)
}

/** Test seam. */
export function _resetDeviceTierForTest(): void {
  cached = null
}
