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

/**
 * Backing-store pixel ratio for MOTION frames: drag frames and their
 * inertia (round 14, DATA_DECISIONS.md section 70.2).
 *
 * WHY. Every globe frame is a per-pixel inverse projection: four
 * transcendentals and an anisotropic texture fetch for each fragment of
 * the disc and its halo. Full screen on a 2x display asked for
 * 1920x1080 CSS at the 1.75 cap = 3360x1890 = 6.35 MEGAPIXELS per pass,
 * for the imagery, again for the sky canvas, again for the 2-D drag
 * canvas's clear, and then three such layers to composite. Measured on
 * the maintainer's machine: the rAF-to-rAF interval during a coast went
 * from 16.7 ms embedded to 102-183 ms in full screen while the
 * main-thread callback stayed under 3 ms. It was pure fill rate.
 *
 * WHAT. A moving frame gets a PIXEL BUDGET instead of a pixel ratio: at
 * most ~2.0 megapixels of backing store on a desktop, ~1.0 on a
 * low-power device, upscaled by CSS to the element's size. The settled
 * frame (the one anybody reads) is still rendered at the full cap, so
 * nothing anyone looks at is softer than before -- this is the same
 * trade Google Earth makes while the globe is turning.
 *
 * Never above `canvasPixelRatio()`: on a dpr-1 display a moving frame
 * must not be rendered at MORE device pixels than a settled one.
 */
export function motionPixelRatio(cssWidth: number, cssHeight: number): number {
  return budgetedPixelRatio(cssWidth, cssHeight, lowPowerDevice() ? 1.0e6 : 2.0e6)
}

/**
 * The same idea for the SKY canvas behind the globe (round 14). Measured
 * in full screen at 1920x1080 dpr 2, coasting: with the sky drawn at the
 * imagery's 2.0 Mpx motion budget the frame interval was 29 ms; with the
 * sky absent (the antique direction, which has no sky) it was 16.7 ms.
 * The sky is 9,096 star discs, 150 polylines and the constellation
 * lettering on a 2-D canvas, and it is a BACKDROP: a moving starfield at
 * two thirds of a megapixel is indistinguishable from a sharp one, and
 * the settled frame is drawn at the full cap like everything else.
 */
export function skyMotionPixelRatio(cssWidth: number, cssHeight: number): number {
  return budgetedPixelRatio(cssWidth, cssHeight, lowPowerDevice() ? 0.35e6 : 0.7e6)
}

function budgetedPixelRatio(cssWidth: number, cssHeight: number, budget: number): number {
  const cap = canvasPixelRatio()
  const area = Math.max(1, cssWidth * cssHeight)
  // The 0.5 floor keeps a 4K or 5K frame recognisable rather than letting
  // the budget drive the picture into a blur.
  return Math.max(0.5, Math.min(cap, Math.sqrt(budget / area)))
}

/** Test seam. */
export function _resetDeviceTierForTest(): void {
  cached = null
}
