/**
 * The outline of one of GIDEON's eyes.
 *
 * An eye used to be a rounded rectangle with a bow on its top and bottom edge,
 * which is one shape that can only get taller, shorter or tilted. Faces that
 * act are built differently: a soft body, and two lids that cut into it. The
 * body says what kind of eye it is, from a round one to a squared panel. The
 * lids say what it feels: lowered they are tired, slanted in they are
 * determined, slanted out they are worried, and a lower lid pushed up in the
 * middle leaves the crescent of a smile.
 *
 * Everything here is a number that can be sprung, so one shape flows into the
 * next rather than being swapped for it.
 */

export interface EyeShape {
  w: number
  h: number
  /**
   * How square the body is. 2 is a true ellipse, about 3.4 the soft panel the
   * eyes have always been, 8 nearly a rectangle, and below 2 it leans towards
   * a diamond.
   */
  n: number
  /** -1 to 1. Positive makes the outer side taller than the inner one. */
  taper: number
  /** 0 to 1: how far the upper lid has come down the eye. */
  upperLid: number
  /** Degrees. Positive lowers the inner end, the slant of a frown. */
  upperAngle: number
  /** -1 to 1. Positive sags in the middle; negative arches. */
  upperBend: number
  /** 0 to 1: how far the lower lid has come up the eye. */
  lowerLid: number
  /** Degrees. Positive raises the inner end. */
  lowerAngle: number
  /** -1 to 1. Positive pushes the middle up, which is what makes a crescent. */
  lowerBend: number
  tilt: number
  dy: number
}

export const NEUTRAL_EYE: EyeShape = {
  w: 48, h: 74, n: 3.4, taper: 0,
  upperLid: 0, upperAngle: 0, upperBend: 0,
  lowerLid: 0, lowerAngle: 0, lowerBend: 0,
  tilt: 0, dy: 0,
}

export const EYE_KEYS = Object.keys(NEUTRAL_EYE) as (keyof EyeShape)[]

/** What the moment adds to a pose: the lean of a fast glance, the lids following the gaze. */
export interface EyeLive {
  /** Shear, as a fraction: positive carries the top of the eye to the right. */
  lean?: number
  /** Added to the pose's taper, but not mirrored: positive makes the right side taller. */
  turn?: number
}

export interface EyeOutline {
  d: string
  /** Where the visible eye starts and ends on its own centre line. */
  top: number
  bottom: number
}

const clamp = (value: number, min: number, max: number) => (value < min ? min : value > max ? max : value)
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const RAD = Math.PI / 180
/** Points along half an edge. Ninety around the whole eye is smooth at any size it is drawn. */
const STEPS = 22
/** A closed eye is still a line of light, never nothing. */
const HAIRLINE = 1.5
/** How far a full bend carries the middle of a lid, as a share of half the height. */
const UPPER_REACH = 0.9
const LOWER_REACH = 1.1
/** A blink is mostly the upper lid coming down to meet the lower. */
const UPPER_SHARE = 0.78
/** A shut eye settles into a slight downward curve, the way a lid lies. */
const SHUT_SAG = 0.1

/**
 * The larger of two edges, with the corner where they cross rounded off over
 * a distance of `k`. Away from the crossing it is exactly the larger one, so a lid that is
 * not touching the eye does not change it at all.
 */
function smoothMax(p: number, q: number, k: number): number {
  const h = clamp(0.5 + (0.5 * (p - q)) / k, 0, 1)
  return mix(q, p, h) + k * h * (1 - h)
}

/**
 * Eases the lids back until at least `least` of the eye's height is open at
 * its middle.
 *
 * Lids stack: a pose lowers them, a phase lowers them further, a gesture and a
 * look downwards further still, and a crescent has little room to begin with.
 * Left alone the sum shuts the eye, which reads as a blink that never ends.
 * Everything is scaled back together, so the eye keeps its character and only
 * loses depth. A blink is separate and still closes it completely.
 */
export function keepOpen(shape: EyeShape, least = 0.16): EyeShape {
  const upperBend = Math.max(0, shape.upperBend) * (UPPER_REACH / 2)
  const lowerBend = Math.max(0, shape.lowerBend) * (LOWER_REACH / 2)
  const closed = Math.max(0, shape.upperLid) + Math.max(0, shape.lowerLid) + upperBend + lowerBend
  const allowed = 1 - least
  if (closed <= allowed) return shape
  const scale = allowed / closed
  return {
    ...shape,
    upperLid: Math.max(0, shape.upperLid) * scale,
    lowerLid: Math.max(0, shape.lowerLid) * scale,
    upperBend: shape.upperBend > 0 ? shape.upperBend * scale : shape.upperBend,
    lowerBend: shape.lowerBend > 0 ? shape.lowerBend * scale : shape.lowerBend,
  }
}

/**
 * Draws the eye: the body, cut by its two lids.
 *
 * `side` is -1 for the left eye and 1 for the right, so that "inner" and
 * "outer" mean the same thing on both. `blink` runs from 1, open, to 0, shut.
 */
export function eyeOutline(shape: EyeShape, side: -1 | 1, blink = 1, live: EyeLive = {}): EyeOutline {
  const a = Math.max(3, shape.w / 2)
  const b = Math.max(3, shape.h / 2)
  const n = clamp(shape.n, 1.3, 12)
  const taper = clamp(shape.taper * side + (live.turn ?? 0), -0.8, 0.8)
  const lean = clamp(live.lean ?? 0, -0.5, 0.5)

  // The lids close the rest of the way as the eye blinks, the upper one doing
  // most of the travelling, and take on one shared line as they meet.
  const shut = 1 - clamp(blink, 0, 1)
  let upper = clamp(shape.upperLid, 0, 0.95)
  let lower = clamp(shape.lowerLid, 0, 0.95)
  const over = upper + lower - 1
  if (over > 0) { upper -= over / 2; lower -= over / 2 }
  const closing = (1 - upper - lower) * shut
  upper += closing * UPPER_SHARE
  lower += closing * (1 - UPPER_SHARE)

  const slopeUpper = -side * Math.tan(clamp(shape.upperAngle, -40, 40) * RAD)
  const slopeLower = side * Math.tan(clamp(shape.lowerAngle, -40, 40) * RAD)
  const curveUpper = clamp(shape.upperBend, -1, 1) * UPPER_REACH * b
  const curveLower = -clamp(shape.lowerBend, -1, 1) * LOWER_REACH * b
  const slopeShared = (slopeUpper + slopeLower) / 2
  const curveShared = (curveUpper + curveLower) / 2 + SHUT_SAG * b
  // How round the corner is where a lid meets the body. A lid at rest waits
  // this far outside the eye, so that rounding never dents an open one.
  const k = clamp(Math.min(a, b) * 0.34, 2, 9)
  const restUpper = k * Math.max(0, 1 - upper * 12)
  const restLower = k * Math.max(0, 1 - lower * 12)
  const sU = mix(slopeUpper, slopeShared, shut)
  const sL = mix(slopeLower, slopeShared, shut)
  const cU = mix(curveUpper, curveShared, shut)
  const cL = mix(curveLower, curveShared, shut)

  const edges = (x: number): [number, number] => {
    const u = Math.min(1, Math.abs(x) / a)
    const body = b * Math.pow(Math.max(0, 1 - Math.pow(u, n)), 1 / n) * (1 + taper * (x / a) * 0.5)
    const arch = 1 - u * u
    const lidTop = -b - restUpper + upper * 2 * b + sU * x + cU * arch
    const lidBottom = b + restLower - lower * 2 * b + sL * x + cL * arch
    let top = smoothMax(-body, lidTop, k)
    let bottom = -smoothMax(-body, -lidBottom, k)
    // Where the lids have met or crossed, the eye is its thinnest line there,
    // and never thicker than the body is at that point.
    const least = Math.min(HAIRLINE, body * 2)
    if (bottom - top < least) {
      const middle = clamp((top + bottom) / 2, -body + least / 2, body - least / 2)
      top = middle - least / 2
      bottom = middle + least / 2
    }
    return [top, bottom]
  }

  // Sampled so the points bunch where the outline turns fastest: at the two
  // sides of a squared body, where even spacing would cut the corners flat.
  const power = Math.max(1, n / 2)
  const xs: number[] = []
  for (let i = 0; i <= STEPS; i += 1) {
    const t = i / STEPS
    const ta = Math.pow(t, power)
    const tb = Math.pow(1 - t, power)
    const phi = (Math.PI / 2) * (ta / (ta + tb))
    xs.push(-a * Math.pow(Math.cos(phi), 2 / n))
  }
  for (let i = STEPS - 1; i >= 0; i -= 1) xs.push(-xs[i])

  const ring: number[] = []
  const under: number[] = []
  for (const x of xs) {
    const [top, bottom] = edges(x)
    ring.push(x - lean * top, top)
    under.push(x - lean * bottom, bottom)
  }
  for (let i = under.length - 2; i >= 0; i -= 2) ring.push(under[i], under[i + 1])

  const points = soften(ring)
  let d = ''
  for (let i = 0; i < points.length; i += 2) d += `${i ? 'L' : 'M'}${fixed(points[i])} ${fixed(points[i + 1])}`
  const [top, bottom] = edges(0)
  return { d: `${d}Z`, top, bottom }
}

/**
 * Two decimals, and never a negative zero. A coordinate that lands on zero
 * comes out as 1e-17 on the server and -1e-17 in the browser, and the two
 * renderings of the same eye must be the same string or React reports the
 * page as mismatched.
 */
function fixed(value: number): string {
  const text = value.toFixed(2)
  return text === '-0.00' ? '0.00' : text
}

/** Points around the finished outline, and how many times it is relaxed. */
const RING = 120
const PASSES = 3

/**
 * Rounds every corner of a closed outline by the same small amount.
 *
 * A lid meeting the side of the eye leaves a hard corner that no amount of
 * rounding along one axis removes. Walking the outline at an even pace and
 * relaxing each point towards its neighbours rounds them all alike, a couple of
 * units deep, and leaves the long smooth runs where they were.
 */
function soften(ring: number[]): number[] {
  const count = ring.length / 2
  const lengths = new Array<number>(count)
  let perimeter = 0
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count
    lengths[i] = Math.hypot(ring[j * 2] - ring[i * 2], ring[j * 2 + 1] - ring[i * 2 + 1])
    perimeter += lengths[i]
  }
  if (!(perimeter > 0)) return ring

  let even = new Array<number>(RING * 2)
  let segment = 0
  let passed = 0
  for (let i = 0; i < RING; i += 1) {
    const at = (i / RING) * perimeter
    while (segment < count - 1 && passed + lengths[segment] < at) { passed += lengths[segment]; segment += 1 }
    const next = (segment + 1) % count
    const t = lengths[segment] > 0 ? (at - passed) / lengths[segment] : 0
    even[i * 2] = mix(ring[segment * 2], ring[next * 2], t)
    even[i * 2 + 1] = mix(ring[segment * 2 + 1], ring[next * 2 + 1], t)
  }

  for (let pass = 0; pass < PASSES; pass += 1) {
    const relaxed = new Array<number>(RING * 2)
    for (let i = 0; i < RING; i += 1) {
      const before = ((i + RING - 1) % RING) * 2
      const after = ((i + 1) % RING) * 2
      relaxed[i * 2] = even[i * 2] * 0.5 + (even[before] + even[after]) * 0.25
      relaxed[i * 2 + 1] = even[i * 2 + 1] * 0.5 + (even[before + 1] + even[after + 1]) * 0.25
    }
    even = relaxed
  }
  return even
}
