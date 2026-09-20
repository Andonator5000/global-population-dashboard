/**
 * Versor (unit quaternion) helpers for globe dragging (round 12,
 * DATA_DECISIONS.md section 62).
 *
 * The globe used to turn by a fixed number of degrees per pixel. Google
 * Earth does something different, and it is what a finger expects: the
 * place under the finger STAYS under the finger. That is a rotation of the
 * sphere carrying the point first touched onto the point now touched,
 * composed with the orientation the drag started from -- Mike Bostock's
 * and Fil's "versor dragging". Quaternions make the composition exact and
 * free of gimbal trouble at the poles, and they give the third Euler angle
 * (gamma, the roll about the line of sight) for free, which is what a
 * two-finger twist changes when a reader turns north away from the top of
 * the screen.
 *
 * Conventions follow d3-geo: an orientation is the Euler triple
 * [lambda, phi, gamma] in degrees that `projection.rotate()` takes, a
 * quaternion is [w, x, y, z], and `cartesian` maps [lon, lat] in degrees to
 * the unit sphere. After versor.js (Fil, ISC), rewritten here in TypeScript.
 */

export type Quaternion = [number, number, number, number]
export type Vec3 = [number, number, number]
export type Euler = [number, number, number]

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

/** Unit quaternion for the Euler rotation [lambda, phi, gamma] (degrees). */
export function fromEuler(e: Euler): Quaternion {
  const l = (e[0] / 2) * RAD
  const p = (e[1] / 2) * RAD
  const g = (e[2] / 2) * RAD
  const sl = Math.sin(l)
  const cl = Math.cos(l)
  const sp = Math.sin(p)
  const cp = Math.cos(p)
  const sg = Math.sin(g)
  const cg = Math.cos(g)
  return [
    cl * cp * cg + sl * sp * sg,
    sl * cp * cg - cl * sp * sg,
    cl * sp * cg + sl * cp * sg,
    cl * cp * sg - sl * sp * cg,
  ]
}

/** Euler rotation [lambda, phi, gamma] (degrees) of a unit quaternion. */
export function toEuler(q: Quaternion): Euler {
  return [
    Math.atan2(2 * (q[0] * q[1] + q[2] * q[3]), 1 - 2 * (q[1] * q[1] + q[2] * q[2])) * DEG,
    Math.asin(Math.max(-1, Math.min(1, 2 * (q[0] * q[2] - q[3] * q[1])))) * DEG,
    Math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] * q[2] + q[3] * q[3])) * DEG,
  ]
}

/** Unit vector for [lon, lat] in degrees. */
export function cartesian(lonLat: [number, number]): Vec3 {
  const l = lonLat[0] * RAD
  const p = lonLat[1] * RAD
  const cp = Math.cos(p)
  return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

/**
 * The rotation that carries unit vector v0 onto v1 (scaled by `alpha`,
 * 1 = all the way). Identity when the two coincide.
 */
export function delta(v0: Vec3, v1: Vec3, alpha = 1): Quaternion {
  const w = cross(v0, v1)
  const l = Math.sqrt(dot(w, w))
  if (!l) return [1, 0, 0, 0]
  const t = (alpha * Math.acos(Math.max(-1, Math.min(1, dot(v0, v1))))) / 2
  const s = Math.sin(t)
  return [Math.cos(t), (w[2] / l) * s, (-w[1] / l) * s, (w[0] / l) * s]
}

/** q0 * q1 (apply q1, then q0). */
export function multiply(q0: Quaternion, q1: Quaternion): Quaternion {
  return [
    q0[0] * q1[0] - q0[1] * q1[1] - q0[2] * q1[2] - q0[3] * q1[3],
    q0[0] * q1[1] + q0[1] * q1[0] + q0[2] * q1[3] - q0[3] * q1[2],
    q0[0] * q1[2] - q0[1] * q1[3] + q0[2] * q1[0] + q0[3] * q1[1],
    q0[0] * q1[3] + q0[1] * q1[2] - q0[2] * q1[1] + q0[3] * q1[0],
  ]
}

/** The inverse (conjugate) of a unit quaternion. */
export function conjugate(q: Quaternion): Quaternion {
  return [q[0], -q[1], -q[2], -q[3]]
}

/** Renormalise; the products above drift by float rounding over a long spin. */
export function normalize(q: Quaternion): Quaternion {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/** Rotation angle of a unit quaternion, in degrees (0..360). */
export function angle(q: Quaternion): number {
  const w = Math.max(-1, Math.min(1, q[0]))
  return 2 * Math.acos(Math.abs(w)) * DEG
}

/**
 * q raised to a real power: the same axis, the angle scaled by `t`. This is
 * what makes momentum work -- the last frame's rotation, shrunk a little
 * each frame, applied again and again.
 */
export function pow(q: Quaternion, t: number): Quaternion {
  const w = Math.max(-1, Math.min(1, q[0]))
  // Take the short way round: a quaternion and its negative are the same
  // rotation, and the half-angle must stay in [0, pi/2] for pow to shrink
  // the rotation rather than grow its complement.
  const sign = w < 0 ? -1 : 1
  const half = Math.acos(Math.abs(w))
  const s = Math.sin(half)
  if (s < 1e-9) return [1, 0, 0, 0]
  const scale = (Math.sin(half * t) / s) * sign
  return [Math.cos(half * t), q[1] * scale, q[2] * scale, q[3] * scale]
}

/** Roll about the line of sight by `degrees` (a two-finger twist). */
export function roll(degrees: number): Quaternion {
  return fromEuler([0, 0, degrees])
}

/**
 * One-finger dragging with north held (round 12): the orientation
 * [lambda, phi, gamma0] that puts the geographic anchor `g0` (degrees)
 * under the screen point `t` (unit vector in the view frame: depth toward
 * the viewer, right, up), keeping the roll `gamma0` fixed. Google Earth's
 * rule -- a drag never turns north away from where it is; only a
 * two-finger twist does that. Two orientations satisfy the constraint;
 * the one with the tilt (phi) inside +-90 and nearer the previous
 * orientation keeps the motion continuous and the map right way up. Near
 * a pole, or when the finger asks for a place the anchor cannot reach
 * without rolling, the nearest reachable orientation is returned (the map
 * stops at the pole, as Google Earth's does).
 */
export function withFixedRoll(
  g0: [number, number],
  t: Vec3,
  gamma0: number,
  prev: [number, number],
): Euler {
  const g = gamma0 * RAD
  const cg = Math.cos(g)
  const sg = Math.sin(g)
  // Undo the roll: the target in the frame where only lambda and phi act.
  const ux = t[0]
  const uy = t[1] * cg + t[2] * sg
  const uz = t[2] * cg - t[1] * sg
  const lon0 = g0[0] * RAD
  const lat0 = g0[1] * RAD
  const c0 = Math.cos(lat0)
  const s0 = Math.sin(lat0)
  const wrap = (d: number) => {
    let w = d % (2 * Math.PI)
    if (w > Math.PI) w -= 2 * Math.PI
    if (w < -Math.PI) w += 2 * Math.PI
    return w
  }
  const lambdaPrev = prev[0] * RAD
  const phiPrev = prev[1] * RAD
  const solve = (lambda: number): [number, number] => {
    const x = c0 * Math.cos(lon0 + lambda)
    const phi = wrap(Math.atan2(uz, ux) - Math.atan2(s0, x))
    return [wrap(lambda), phi]
  }
  const HALF = Math.PI / 2
  let candidates: [number, number][]
  if (c0 < 1e-6) {
    candidates = [solve(lambdaPrev)]
  } else {
    const v = Math.max(-1, Math.min(1, uy / c0))
    const a = Math.asin(v)
    candidates = [solve(a - lon0), solve(Math.PI - a - lon0)]
  }
  // Prefer a right-way-up solution (|phi| <= 90); among those, the one
  // nearest the previous orientation.
  let best = candidates[0]!
  let bestScore = Infinity
  for (const c of candidates) {
    const upright = Math.abs(c[1]) <= Math.PI / 2 + 1e-9
    const score =
      (upright ? 0 : 1000) + Math.abs(wrap(c[0] - lambdaPrev)) + Math.abs(wrap(c[1] - phiPrev))
    if (score < bestScore) {
      bestScore = score
      best = c
    }
  }
  // Past a pole the map stops (the tilt is clamped): the finger asked for
  // a place the anchor cannot reach right way up.
  return [best[0] * DEG, Math.max(-HALF, Math.min(HALF, best[1])) * DEG, gamma0]
}
