import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { EyeEmotion } from '../lib/mood'
import {
  Spring,
  breath,
  clamp,
  exponentialInterval,
  fbm,
  minimumJerk,
  ornstein,
  saccadeDuration,
} from '../lib/motion'

/**
 * GIDEON's face: two machine eyes, floating free.
 *
 * They used to sit recessed inside a metal sphere, which meant the housing did
 * the acting and the eyes just rotated inside it. With the housing gone the
 * eyes have to carry the whole performance, so nothing here is a keyframe:
 *
 *  - poses are reached by real second-order springs, so a surprised face
 *    overshoots and settles while a concerned one arrives heavy and late;
 *  - gaze is a saccade generator on the physiological main sequence, layered
 *    over Ornstein–Uhlenbeck drift and fBm tremor, so it never repeats;
 *  - blinks arrive as a Poisson process and close faster than they open,
 *    the way an eyelid actually moves;
 *  - the pair is treated as two points on a turning head, so looking sideways
 *    foreshortens the far eye instead of sliding both the same distance;
 *  - and every few seconds the face performs a small deliberate gesture chosen
 *    to match what it is feeling and doing.
 *
 * The loop writes straight to the DOM. React never re-renders for motion.
 */

export type EyePhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused'
export type { EyeEmotion }

interface EyeShape {
  w: number
  h: number
  r: number
  /** Positive lifts the middle of the top edge. */
  topBow: number
  /** Positive pushes the middle of the bottom edge up into the eye. */
  bottomBow: number
  tilt: number
  dy: number
}

interface Pose {
  left: EyeShape
  right: EyeShape
  /** Halo intensity, 0–1. */
  glow: number
  /** Extra separation between the eyes. */
  spread: number
}

const VIEW_W = 280
const VIEW_H = 156
const CENTER_X = VIEW_W / 2
const CENTER_Y = VIEW_H / 2
/** Wide enough that the eyes read as two lights, not one visor. */
const BASE_GAP = 96

const NEUTRAL: EyeShape = { w: 48, h: 74, r: 21, topBow: 3, bottomBow: 0, tilt: 0, dy: 0 }

function eye(overrides: Partial<EyeShape> = {}): EyeShape {
  return { ...NEUTRAL, ...overrides }
}

function pose(left: Partial<EyeShape>, right: Partial<EyeShape>, glow = 0.4, spread = 0): Pose {
  return { left: eye(left), right: eye(right), glow, spread }
}

/**
 * Emotion first, then the phase layered on top — a happy GIDEON that is
 * currently listening should still read as happy.
 */
const EMOTIONS: Record<EyeEmotion, Pose> = {
  neutral: pose({}, {}, 0.4),
  curious: pose(
    { h: 66, dy: -11, tilt: -15, topBow: 6 },
    { h: 78, dy: 6, tilt: 6, topBow: 1 },
    0.55,
    2,
  ),
  focused: pose(
    { h: 53, w: 52, r: 18, topBow: 0 },
    { h: 53, w: 52, r: 18, topBow: 0 },
    0.5,
    -4,
  ),
  happy: pose(
    { h: 43, r: 19, topBow: 9, bottomBow: 14, dy: -5 },
    { h: 43, r: 19, topBow: 9, bottomBow: 14, dy: -5 },
    0.82,
    7,
  ),
  concerned: pose(
    { h: 55, tilt: 18, dy: 6, topBow: 7 },
    { h: 55, tilt: -18, dy: 6, topBow: 7 },
    0.3,
    -2,
  ),
  surprised: pose(
    { h: 90, w: 54, r: 25, topBow: 3 },
    { h: 90, w: 54, r: 25, topBow: 3 },
    0.78,
    6,
  ),
}

/**
 * Phase nudges applied on top of the emotion pose.
 *
 * Height is a *scale*, not an offset. As a flat subtraction it worked for the
 * neutral eye and quietly destroyed the short ones: a happy face is only 43
 * units tall, so pausing it took 34 of those away and left a slit.
 */
const PHASES: Record<
  EyePhase,
  Partial<EyeShape> & { hScale?: number; glow?: number; gazeY?: number }
> = {
  idle: {},
  listening: { hScale: 1.09, w: 1, topBow: 3, glow: 0.22 },
  thinking: { hScale: 0.72, topBow: -3, glow: 0.1, gazeY: -0.55 },
  speaking: { glow: 0.24 },
  paused: { hScale: 0.56, topBow: -3, glow: -0.22 },
}

/**
 * How each feeling *moves*, independent of what it looks like.
 *
 * This is the half the old build had no way to express. Two poses can be the
 * same shape and still read as different creatures depending on whether they
 * snap and wobble into place or sink into it.
 */
interface Dynamics {
  /** Natural frequency in hertz: how quickly it gets there. */
  frequency: number
  /** Damping ratio: below 1 overshoots, 1 is critical, above 1 is heavy. */
  damping: number
  /** Mean seconds between blinks. */
  blink: number
  /** Mean seconds between deliberate gestures. */
  gesture: number
  /** Inward convergence, in view units — the eyes crossing toward a thought. */
  vergence: number
}

const DYNAMICS: Record<EyeEmotion, Dynamics> = {
  neutral: { frequency: 1.5, damping: 0.95, blink: 4.2, gesture: 6.5, vergence: 0 },
  curious: { frequency: 2.05, damping: 0.7, blink: 3.4, gesture: 4.4, vergence: 1.5 },
  focused: { frequency: 2.4, damping: 1, blink: 6.4, gesture: 5.4, vergence: 3.4 },
  happy: { frequency: 2.7, damping: 0.52, blink: 3, gesture: 3.8, vergence: -1 },
  concerned: { frequency: 1.05, damping: 1.12, blink: 5.4, gesture: 5.8, vergence: 1.8 },
  surprised: { frequency: 3.5, damping: 0.42, blink: 7.5, gesture: 6.2, vergence: -3 },
}

/** How much of the pointer the eyes actually give you, per phase. */
const FOLLOW: Record<EyePhase, number> = {
  idle: 0.8,
  listening: 0.95,
  thinking: 0.22,
  speaking: 0.66,
  paused: 0.4,
}

function eyePath(shape: EyeShape, blink: number) {
  const hw = shape.w / 2
  const hh = Math.max(1.4, (shape.h * blink) / 2)
  const r = Math.max(0, Math.min(shape.r, hw, hh))
  const bow = Math.min(blink, 1)
  const top = shape.topBow * bow
  const bottom = shape.bottomBow * bow
  const x0 = -hw
  const x1 = hw
  const y0 = -hh
  const y1 = hh

  return [
    `M${x0} ${y0 + r}`,
    `Q${x0} ${y0} ${x0 + r} ${y0}`,
    `Q0 ${y0 - top * 2} ${x1 - r} ${y0}`,
    `Q${x1} ${y0} ${x1} ${y0 + r}`,
    `L${x1} ${y1 - r}`,
    `Q${x1} ${y1} ${x1 - r} ${y1}`,
    `Q0 ${y1 - bottom * 2} ${x0 + r} ${y1}`,
    `Q${x0} ${y1} ${x0} ${y1 - r}`,
    'Z',
  ].join(' ')
}

function targetPose(phase: EyePhase, emotion: EyeEmotion): Pose {
  const base = EMOTIONS[emotion] ?? EMOTIONS.neutral
  const shift = PHASES[phase] ?? {}
  const apply = (shape: EyeShape): EyeShape => ({
    w: shape.w + (shift.w ?? 0),
    h: Math.max(8, shape.h * (shift.hScale ?? 1) + (shift.h ?? 0)),
    r: shape.r,
    topBow: Math.max(0, shape.topBow + (shift.topBow ?? 0)),
    bottomBow: shape.bottomBow,
    tilt: shape.tilt + (shift.tilt ?? 0),
    dy: shape.dy + (shift.dy ?? 0),
  })

  return {
    left: apply(base.left),
    right: apply(base.right),
    glow: clamp(base.glow + (shift.glow ?? 0), 0, 1),
    spread: base.spread,
  }
}

// -- Gestures ---------------------------------------------------------------

/**
 * A gesture is a short, deliberate move on top of everything else: the thing a
 * face does *on purpose*, as opposed to the drift and tremor it cannot help.
 * Amounts are peak values; the envelope takes them out and back.
 */
interface Gesture {
  duration: number
  /** Fraction of the duration spent travelling out, and holding at the peak. */
  rise: number
  hold: number
  gazeX?: number
  gazeY?: number
  roll?: number
  lift?: number
  /** Multiplies eye height at the peak: below 1 narrows, above 1 widens. */
  open?: number
  /** Extra separation at the peak. */
  spread?: number
  /** Repeats the whole envelope this many times inside the duration. */
  beats?: number
}

const GESTURES: Record<EyeEmotion, Gesture[]> = {
  neutral: [
    { duration: 1.5, rise: 0.35, hold: 0.25, gazeX: 0.42, roll: 2 },
    { duration: 1.9, rise: 0.4, hold: 0.3, gazeY: 0.3, lift: 2, open: 0.94 },
  ],
  curious: [
    // The peer: head cocks over and the gaze goes with it.
    { duration: 2.1, rise: 0.3, hold: 0.42, roll: 7.5, gazeX: 0.34, open: 1.05 },
    // The double take: out fast, back fast, twice.
    { duration: 0.9, rise: 0.28, hold: 0.06, gazeX: -0.55, beats: 2, open: 1.06 },
  ],
  focused: [
    { duration: 1.7, rise: 0.45, hold: 0.1, gazeX: 0.5, open: 0.9 },
    { duration: 1.1, rise: 0.3, hold: 0.3, open: 0.82, lift: 1.5 },
  ],
  happy: [
    // Bounce up; the underdamped spring on `lift` does the landing wobble.
    { duration: 1, rise: 0.34, hold: 0.05, lift: -6, spread: 3, beats: 2 },
    { duration: 1.4, rise: 0.3, hold: 0.25, roll: -4, open: 0.9, spread: 4 },
  ],
  concerned: [
    // Aversion: down and away, slowly, and slow to come back.
    { duration: 2.6, rise: 0.42, hold: 0.34, gazeY: 0.52, gazeX: -0.36, lift: 3, open: 0.88 },
  ],
  surprised: [
    { duration: 0.8, rise: 0.16, hold: 0.2, lift: -4, open: 1.12, spread: 4 },
    { duration: 0.7, rise: 0.14, hold: 0.1, gazeX: 0.7, beats: 2 },
  ],
}

/** Gestures fired by an event rather than by the idle timer. */
const REACTIONS: Record<string, Gesture> = {
  // Acknowledgement when the microphone opens: a small nod.
  listening: { duration: 0.85, rise: 0.3, hold: 0.05, lift: 3.5, gazeY: 0.22, beats: 2 },
  // Turning inward to think: look up and away, and hold it.
  thinking: { duration: 2.4, rise: 0.3, hold: 0.45, gazeX: -0.6, gazeY: -0.5, roll: 3, open: 0.9 },
  // Settling in to talk.
  speaking: { duration: 0.7, rise: 0.35, hold: 0.1, lift: -2.5, open: 1.05 },
  paused: { duration: 1.2, rise: 0.5, hold: 0.2, lift: 3, open: 0.86, gazeY: 0.3 },
}

/** Out-and-back envelope with a hold at the peak, minimum-jerk on both legs. */
function envelope(t: number, rise: number, hold: number): number {
  if (t <= 0 || t >= 1) return 0
  const fall = Math.max(0.05, 1 - rise - hold)
  if (t < rise) return minimumJerk(t / rise)
  if (t < rise + hold) return 1
  return 1 - minimumJerk((t - rise - hold) / fall)
}

interface ActiveGesture {
  gesture: Gesture
  elapsed: number
  /** Horizontal gestures are mirrored at random so one never plays twice alike. */
  mirror: 1 | -1
}

// -- DOM plumbing -----------------------------------------------------------

interface EyeNodes {
  group: SVGGElement | null
  /** The blurred copy sits in its own layer, so it needs its own transform. */
  glowGroup: SVGGElement | null
  core: SVGPathElement | null
  glow: SVGPathElement | null
  /** Scanline overlay clipped to the eye, drawn from the same path. */
  scan: SVGPathElement | null
  spark: SVGEllipseElement | null
}

function emptyNodes(): EyeNodes {
  return { group: null, glowGroup: null, core: null, glow: null, scan: null, spark: null }
}

/** One spring per shape parameter, so each can carry its own momentum. */
class ShapeSprings {
  private readonly springs: Record<keyof EyeShape, Spring>

  constructor(shape: EyeShape) {
    this.springs = {
      w: new Spring(shape.w, 1.6, 0.95),
      h: new Spring(shape.h, 1.6, 0.95),
      r: new Spring(shape.r, 1.6, 1),
      topBow: new Spring(shape.topBow, 1.6, 0.95),
      bottomBow: new Spring(shape.bottomBow, 1.6, 0.95),
      tilt: new Spring(shape.tilt, 1.6, 0.95),
      dy: new Spring(shape.dy, 1.6, 0.95),
    }
  }

  tune(frequency: number, damping: number) {
    for (const key of Object.keys(this.springs) as (keyof EyeShape)[]) {
      const spring = this.springs[key]
      spring.frequency = frequency
      // Radius has no business wobbling; it would ripple the whole silhouette.
      spring.damping = key === 'r' ? Math.max(1, damping) : damping
    }
  }

  step(target: EyeShape, dt: number, out: EyeShape) {
    out.w = this.springs.w.step(target.w, dt)
    out.h = this.springs.h.step(target.h, dt)
    out.r = this.springs.r.step(target.r, dt)
    out.topBow = this.springs.topBow.step(target.topBow, dt)
    out.bottomBow = this.springs.bottomBow.step(target.bottomBow, dt)
    out.tilt = this.springs.tilt.step(target.tilt, dt)
    out.dy = this.springs.dy.step(target.dy, dt)
  }
}

export interface GideonEyesProps {
  phase: EyePhase
  emotion: EyeEmotion
  /**
   * Live 0–1 voice amplitude. Passed as a ref rather than a value so sixty
   * updates a second never re-render React.
   */
  levelRef?: RefObject<number>
}

export function GideonEyes({ phase, emotion, levelRef }: GideonEyesProps) {
  const leftNodes = useRef<EyeNodes>(emptyNodes())
  const rightNodes = useRef<EyeNodes>(emptyNodes())
  const haloRef = useRef<SVGEllipseElement>(null)
  const auraRef = useRef<SVGGElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Live inputs, read by the animation loop without restarting it.
  const input = useRef({ phase, emotion })
  input.current = { phase, emotion }

  useEffect(() => {
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    // The eyes follow the pointer themselves; routing it through props would
    // re-render the page on every mouse move.
    const pointer = { x: 0, y: 0 }
    const onPointerMove = (event: PointerEvent) => {
      pointer.x = clamp((event.clientX / window.innerWidth - 0.5) * 2, -1, 1)
      pointer.y = clamp((event.clientY / window.innerHeight - 0.5) * 2, -1, 1)
    }
    const onPointerLeave = () => {
      pointer.x = 0
      pointer.y = 0
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('blur', onPointerLeave)

    const start = targetPose(input.current.phase, input.current.emotion)
    const current: Pose = {
      left: { ...start.left },
      right: { ...start.right },
      glow: start.glow,
      spread: start.spread,
    }
    const leftSprings = new ShapeSprings(start.left)
    const rightSprings = new ShapeSprings(start.right)
    const glowSpring = new Spring(start.glow, 1.4, 1)
    const spreadSpring = new Spring(start.spread, 1.5, 0.8)
    const vergeSpring = new Spring(0, 1.2, 1)

    // Gaze is assembled from four independent sources every frame.
    const follow = { x: new Spring(0, 1.5, 1), y: new Spring(0, 1.5, 1) }
    const drift = { x: 0, y: 0 }
    const saccade = {
      fromX: 0,
      fromY: 0,
      toX: 0,
      toY: 0,
      x: 0,
      y: 0,
      t: 1,
      duration: 0.05,
      wait: 0.9,
    }
    const roll = new Spring(0, 1.3, 0.75)
    const lift = new Spring(0, 1.7, 0.55)

    // Blink timeline. Closing is quicker than opening, which is what makes a
    // blink read as a blink rather than as a wipe.
    const blinkState = { t: Infinity, close: 0.075, hold: 0.02, open: 0.14, queued: 0 }
    let blinkIn = exponentialInterval(4)
    let blink = 1

    let gesture: ActiveGesture | null = null
    let gestureIn = exponentialInterval(5)
    let lastPhase = input.current.phase

    let amplitude = 0
    let elapsed = 0
    let previous = performance.now()
    let frame = 0

    const fire = (next: Gesture) => {
      gesture = { gesture: next, elapsed: 0, mirror: Math.random() < 0.5 ? -1 : 1 }
    }

    const render = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.0005, (now - previous) / 1000))
      previous = now
      elapsed += dt

      const { phase: p, emotion: e } = input.current
      const rm = reducedMotion
      const level = levelRef?.current ?? 0
      const dynamics = DYNAMICS[e] ?? DYNAMICS.neutral
      const target = targetPose(p, e)

      // A change of phase is a real event, so the face reacts to it.
      if (p !== lastPhase) {
        const reaction = REACTIONS[p]
        if (reaction && !rm) fire(reaction)
        lastPhase = p
        gestureIn = Math.max(gestureIn, 1.6)
      }

      // -- Pose --------------------------------------------------------------
      const frequency = rm ? 9 : dynamics.frequency
      const damping = rm ? 1 : dynamics.damping
      leftSprings.tune(frequency, damping)
      rightSprings.tune(frequency, damping)
      leftSprings.step(target.left, dt, current.left)
      rightSprings.step(target.right, dt, current.right)
      glowSpring.frequency = frequency
      current.glow = glowSpring.step(target.glow, dt)
      spreadSpring.frequency = frequency
      current.spread = spreadSpring.step(target.spread, dt)
      const verge = vergeSpring.step(rm ? 0 : dynamics.vergence, dt)

      // -- Gestures ----------------------------------------------------------
      let gGazeX = 0
      let gGazeY = 0
      let gRoll = 0
      let gLift = 0
      let gOpen = 1
      let gSpread = 0

      if (!rm) {
        gestureIn -= dt
        if (gestureIn <= 0) {
          const pool = GESTURES[e] ?? GESTURES.neutral
          if (!gesture && pool.length) fire(pool[Math.floor(Math.random() * pool.length)])
          const busy = p === 'thinking' ? 0.55 : p === 'listening' ? 1.25 : 1
          gestureIn = exponentialInterval(dynamics.gesture * busy)
        }
        if (gesture) {
          gesture.elapsed += dt
          const g = gesture.gesture
          const beats = g.beats ?? 1
          const raw = gesture.elapsed / g.duration
          if (raw >= 1) {
            gesture = null
          } else {
            // Beats repeat the envelope, each a little weaker than the last.
            const beat = raw * beats
            const local = beat - Math.floor(beat)
            const decay = 1 - Math.floor(beat) / (beats + 1)
            const k = envelope(local, g.rise, g.hold) * decay
            const mirror = gesture.mirror
            gGazeX = (g.gazeX ?? 0) * k * mirror
            gGazeY = (g.gazeY ?? 0) * k
            gRoll = (g.roll ?? 0) * k * mirror
            gLift = (g.lift ?? 0) * k
            gOpen = 1 + ((g.open ?? 1) - 1) * k
            gSpread = (g.spread ?? 0) * k
          }
        }
      }

      // -- Gaze --------------------------------------------------------------
      const followAmount = FOLLOW[p] ?? 0.8
      const fx = follow.x.step(pointer.x * followAmount, dt)
      const fy = follow.y.step(pointer.y * followAmount * 0.85, dt)

      if (!rm) {
        // Ocular drift: a random walk that is always being pulled back home.
        drift.x = ornstein(drift.x, dt, 2.4, 0.22)
        drift.y = ornstein(drift.y, dt, 2.6, 0.15)

        // Saccades: a jump on the main sequence, then a fixation.
        saccade.t += dt
        if (saccade.t >= saccade.duration) {
          saccade.x = saccade.toX
          saccade.y = saccade.toY
          saccade.wait -= dt
          if (saccade.wait <= 0) {
            // Mostly small refixations, occasionally a real look elsewhere.
            const big = Math.random() < 0.22
            const spanX = big ? 0.62 : 0.2
            const spanY = big ? 0.34 : 0.13
            saccade.fromX = saccade.x
            saccade.fromY = saccade.y
            saccade.toX = clamp((Math.random() - 0.5) * 2 * spanX, -0.7, 0.7)
            saccade.toY = clamp((Math.random() - 0.5) * 2 * spanY, -0.45, 0.45)
            const amp = Math.hypot(saccade.toX - saccade.fromX, saccade.toY - saccade.fromY)
            saccade.duration = saccadeDuration(amp)
            saccade.t = 0
            // Fixations run long while thinking and short while listening.
            const dwell = p === 'thinking' ? 0.55 : p === 'listening' ? 1.5 : 1
            saccade.wait = 0.28 + exponentialInterval(1.15 * dwell)
          }
        } else {
          const k = minimumJerk(saccade.t / saccade.duration)
          saccade.x = saccade.fromX + (saccade.toX - saccade.fromX) * k
          saccade.y = saccade.fromY + (saccade.toY - saccade.fromY) * k
        }
      }

      // Physiological tremor: too small to see, big enough to feel.
      const tremorX = rm ? 0 : fbm(elapsed * 7.3, 2) * 0.018
      const tremorY = rm ? 0 : fbm(elapsed * 6.1 + 40, 2) * 0.014

      const thinkBias = p === 'thinking' ? (PHASES.thinking.gazeY ?? 0) : 0
      const gazeX = clamp(fx + saccade.x + drift.x + tremorX + gGazeX, -1.5, 1.5)
      const gazeY = clamp(fy + saccade.y + drift.y + tremorY + gGazeY + thinkBias, -1.3, 1.3)

      // -- Blink -------------------------------------------------------------
      if (rm) {
        blink = 1
      } else {
        const phaseRate = p === 'thinking' ? 1.7 : p === 'listening' ? 0.85 : 1
        blinkIn -= dt
        if (blinkIn <= 0 && blinkState.t > 1) {
          blinkState.t = 0
          blinkState.queued = Math.random() < 0.18 ? 1 : 0
          // Warm and heavy feelings sometimes close slowly and open slower.
          const slow = (e === 'happy' || e === 'concerned') && Math.random() < 0.25
          blinkState.close = slow ? 0.16 : 0.07 + Math.random() * 0.02
          blinkState.hold = slow ? 0.11 : 0.018
          blinkState.open = slow ? 0.3 : 0.13 + Math.random() * 0.04
          blinkIn = 0.45 + exponentialInterval(dynamics.blink * phaseRate)
        }

        const b = blinkState
        const total = b.close + b.hold + b.open
        if (b.t <= total) {
          b.t += dt
          if (b.t < b.close) {
            blink = 1 - minimumJerk(b.t / b.close) * 0.94
          } else if (b.t < b.close + b.hold) {
            blink = 0.06
          } else {
            blink = 0.06 + minimumJerk((b.t - b.close - b.hold) / b.open) * 0.94
          }
          if (b.t > total) {
            blink = 1
            b.t = Infinity
            if (b.queued > 0) {
              b.queued = 0
              blinkIn = 0.09
            }
          }
        } else {
          blink = 1
        }
      }

      // -- Breath and voice --------------------------------------------------
      amplitude += (((p === 'speaking' ? level : 0) - amplitude) * Math.min(1, dt * 26))
      // Breathing slows when calm and quickens when activated.
      const breathRate = p === 'thinking' ? 0.17 : p === 'listening' ? 0.22 : 0.19
      const breathing = rm ? 0 : breath(elapsed * breathRate)
      const idleFloat = rm ? 0 : fbm(elapsed * 0.31, 3) * 2.4

      const headRoll = roll.step(rm ? 0 : gRoll + gazeX * 1.6 + fbm(elapsed * 0.24 + 9, 2) * 1.1, dt)
      const headLift = lift.step(
        rm ? 0 : gLift + breathing * 1.5 + idleFloat + amplitude * -1.6,
        dt,
      )

      // -- Head turn ---------------------------------------------------------
      // Treating the pair as two points on a turning head is what stops a
      // sideways look from sliding both eyes the same distance like a decal.
      const yaw = clamp(gazeX * 0.55, -0.9, 0.9)
      const cosYaw = Math.cos(yaw * 0.9)
      const halfGap = BASE_GAP / 2 + current.spread + gSpread
      const rollRad = (headRoll * Math.PI) / 180
      const cosRoll = Math.cos(rollRad)
      const sinRoll = Math.sin(rollRad)

      const write = (nodes: EyeNodes, shape: EyeShape, sign: -1 | 1) => {
        if (!nodes.group || !nodes.core) return
        // Far eye foreshortens; near eye barely changes.
        const far = sign * yaw < 0
        const squeeze = 1 - Math.abs(yaw) * (far ? 0.17 : 0.04)
        const speech = 1 + amplitude * 0.17
        const shaped: EyeShape = {
          ...shape,
          h: Math.max(6, shape.h * speech * gOpen),
          w: Math.max(6, shape.w * squeeze * (1 - amplitude * 0.03)),
        }
        const d = eyePath(shaped, blink)
        nodes.core.setAttribute('d', d)
        nodes.glow?.setAttribute('d', d)
        nodes.scan?.setAttribute('d', d)

        // Position on the turning head, then rolled about the midpoint.
        const bx = sign * halfGap * cosYaw - sign * verge
        const by = shape.dy + headLift
        const x = CENTER_X + bx * cosRoll - by * sinRoll + gazeX * (10 + (far ? 0 : 3))
        const y = CENTER_Y + bx * sinRoll + by * cosRoll + gazeY * 8
        const transform = `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${(
          shape.tilt + headRoll
        ).toFixed(2)})`
        nodes.group.setAttribute('transform', transform)
        nodes.glowGroup?.setAttribute('transform', transform)

        if (nodes.spark) {
          // The catchlight sits opposite the gaze, the way a real one would.
          nodes.spark.setAttribute('cx', (gazeX * 4 - shaped.w * 0.17).toFixed(2))
          nodes.spark.setAttribute('cy', (gazeY * 3 - (shaped.h * blink) / 2 + 10).toFixed(2))
          nodes.spark.setAttribute('rx', (shaped.w * 0.2).toFixed(2))
          nodes.spark.setAttribute('ry', Math.max(0.6, shaped.h * blink * 0.09).toFixed(2))
          nodes.spark.setAttribute('opacity', (0.52 * blink).toFixed(3))
        }
      }

      write(leftNodes.current, current.left, -1)
      write(rightNodes.current, current.right, 1)

      const glow = current.glow + amplitude * 0.3
      auraRef.current?.setAttribute('opacity', Math.min(1, 0.3 + glow * 0.7).toFixed(3))
      if (haloRef.current) {
        const pulse = rm ? 0 : (breathing + 1) / 2
        haloRef.current.setAttribute('opacity', (0.06 + glow * 0.2 + pulse * 0.07).toFixed(3))
        haloRef.current.setAttribute('rx', (108 + glow * 12 + pulse * 7 + amplitude * 14).toFixed(2))
        haloRef.current.setAttribute('ry', (68 + glow * 8 + pulse * 5 + amplitude * 9).toFixed(2))
      }
      // The page reads this to keep its glow in step with the face.
      rootRef.current?.style.setProperty('--eye-glow', (glow + amplitude * 0.4).toFixed(3))

      frame = requestAnimationFrame(render)
    }

    frame = requestAnimationFrame(render)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('blur', onPointerLeave)
    }
  }, [levelRef])

  // A resting pose rendered straight into the markup, so the face is already
  // there before the first animation frame — server output and a tab opened in
  // the background both show eyes rather than nothing.
  //
  // Frozen on the first render on purpose. Recomputing it from the live props
  // would make React rewrite `d` and `transform` on every phase change, which
  // snaps the face back to its resting pose for one frame before the loop
  // takes over again.
  const seed = useRef<{
    left: string
    right: string
    leftTransform: string
    rightTransform: string
    aura: number
  } | null>(null)
  if (!seed.current) {
    const resting = targetPose(phase, emotion)
    const transform = (shape: EyeShape, sign: -1 | 1) =>
      `translate(${(CENTER_X + sign * (BASE_GAP / 2 + resting.spread)).toFixed(2)} ${(
        CENTER_Y + shape.dy
      ).toFixed(2)}) rotate(${shape.tilt.toFixed(2)})`
    seed.current = {
      left: eyePath(resting.left, 1),
      right: eyePath(resting.right, 1),
      leftTransform: transform(resting.left, -1),
      rightTransform: transform(resting.right, 1),
      aura: Number((0.3 + resting.glow * 0.7).toFixed(3)),
    }
  }
  const rest = seed.current

  const bind =
    <K extends keyof EyeNodes>(store: RefObject<EyeNodes>, key: K) =>
    (node: EyeNodes[K]) => {
      store.current[key] = node
    }
  const bindLeft = <K extends keyof EyeNodes>(key: K) => bind(leftNodes, key)
  const bindRight = <K extends keyof EyeNodes>(key: K) => bind(rightNodes, key)

  return (
    <div className="gideon-face" data-phase={phase} data-emotion={emotion} ref={rootRef}>
      <svg
        className="gideon-eyes"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`GIDEON is ${phase}`}
      >
        <defs>
          <linearGradient id="eye-core" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="46%" stopColor="#edf5ff" />
            <stop offset="100%" stopColor="#cbd8e8" />
          </linearGradient>
          <radialGradient id="eye-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#bfe9ff" stopOpacity="0.34" />
            <stop offset="62%" stopColor="#bfe9ff" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#bfe9ff" stopOpacity="0" />
          </radialGradient>

          {/* Fine horizontal scanlines read the lights as an emissive panel. */}
          <pattern id="eye-scan" width="3" height="3" patternUnits="userSpaceOnUse">
            <rect width="3" height="1" fill="#0b1017" fillOpacity="0.4" />
          </pattern>
        </defs>

        <ellipse
          ref={haloRef}
          className="eye-halo"
          cx={CENTER_X}
          cy={CENTER_Y}
          rx={108}
          ry={68}
          fill="url(#eye-halo)"
        />

        <g ref={auraRef} className="eye-aura" opacity={rest.aura}>
          <g ref={bindLeft('glowGroup')} transform={rest.leftTransform}>
            <path ref={bindLeft('glow')} className="eye-glow" d={rest.left} />
          </g>
          <g ref={bindRight('glowGroup')} transform={rest.rightTransform}>
            <path ref={bindRight('glow')} className="eye-glow" d={rest.right} />
          </g>
        </g>

        <g>
          <g ref={bindLeft('group')} transform={rest.leftTransform}>
            <path ref={bindLeft('core')} className="eye-core" fill="url(#eye-core)" d={rest.left} />
            <path ref={bindLeft('scan')} className="eye-scan" fill="url(#eye-scan)" d={rest.left} />
            <ellipse ref={bindLeft('spark')} className="eye-spark" />
          </g>
          <g ref={bindRight('group')} transform={rest.rightTransform}>
            <path
              ref={bindRight('core')}
              className="eye-core"
              fill="url(#eye-core)"
              d={rest.right}
            />
            <path
              ref={bindRight('scan')}
              className="eye-scan"
              fill="url(#eye-scan)"
              d={rest.right}
            />
            <ellipse ref={bindRight('spark')} className="eye-spark" />
          </g>
        </g>
      </svg>
    </div>
  )
}
