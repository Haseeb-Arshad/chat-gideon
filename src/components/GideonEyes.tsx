import { useEffect, useId, useRef } from 'react'
import type { RefObject } from 'react'
import type { EyeEmotion } from '../lib/mood'
import { EYE_KEYS, eyeOutline, keepOpen, type EyeShape } from '../lib/eye-shape'
import { PHASES, targetPose, type EyePhase, type Pose } from '../lib/eye-poses'
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
 *  - each eye is a soft body cut by two lids (`eye-shape.ts`), so a feeling
 *    changes the silhouette itself: crescents for a smile, a slant for worry
 *    or resolve, a circle for surprise;
 *  - poses are reached by real second-order springs, so a surprised face
 *    overshoots and settles while a concerned one arrives heavy and late;
 *  - gaze is a saccade generator on the physiological main sequence, layered
 *    over Ornstein–Uhlenbeck drift and fBm tremor, so it never repeats;
 *  - blinks arrive as a Poisson process and close faster than they open,
 *    the way an eyelid actually moves;
 *  - the pair is treated as two points on a turning head, so looking sideways
 *    foreshortens the far eye instead of sliding both the same distance;
 *  - and now and then the face makes a small deliberate gesture chosen to
 *    match what it is feeling and doing.
 *
 * Restraint is the rule. A face that answers every word with a move reads as
 * a toy: it used to throb taller on each syllable of its own voice, swap
 * expressions on every partial transcript and gesture every four seconds. Now
 * a feeling has to last before the face takes it up and is held once taken,
 * the voice moves the eyes only with the swell of a phrase, gestures are rare
 * and mostly a change of lid rather than a jump, and the gaze rests longer.
 *
 * The loop writes straight to the DOM. React never re-renders for motion.
 */

export type { EyeEmotion, EyePhase }

const VIEW_W = 280
const VIEW_H = 156
const CENTER_X = VIEW_W / 2
const CENTER_Y = VIEW_H / 2
/** Wide enough that the eyes read as two lights, not one visor. */
const BASE_GAP = 96

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
  neutral: { frequency: 1.3, damping: 1, blink: 4.2, gesture: 14, vergence: 0 },
  curious: { frequency: 1.6, damping: 0.88, blink: 3.6, gesture: 12, vergence: 1 },
  focused: { frequency: 1.7, damping: 1, blink: 6, gesture: 13, vergence: 2.2 },
  happy: { frequency: 1.9, damping: 0.78, blink: 3.4, gesture: 10, vergence: -0.6 },
  concerned: { frequency: 1, damping: 1.12, blink: 5.4, gesture: 14, vergence: 1.2 },
  surprised: { frequency: 2.4, damping: 0.7, blink: 7, gesture: 12, vergence: -1.6 },
}

/** A new feeling must hold this long before the face takes it up. */
const EMOTION_SETTLE_S = 0.8
/** And once taken up, it is kept at least this long, so the face is not a meter. */
const EMOTION_HOLD_S = 3

/** How much of the pointer the eyes actually give you, per phase. */
const FOLLOW: Record<EyePhase, number> = {
  idle: 0.8,
  listening: 0.95,
  thinking: 0.22,
  speaking: 0.66,
  paused: 0.4,
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
  /** 0 to 1: the lower lids rise and curve into the crescents of a smile. */
  smile?: number
  /** 0 to 1: both lids close in, narrowing the eye without blinking. */
  squint?: number
  /** Degrees added to the upper lid's slant: positive frowns, negative worries. */
  slant?: number
  /** 0 to 1: one eye closes on its own. Which one follows the mirror. */
  wink?: number
  /** Added to the body's squareness: negative goes round, positive squares up. */
  round?: number
  /** Repeats the whole envelope this many times inside the duration. */
  beats?: number
}

// Mostly the lids at work, the way a real face changes: a smile gathers, a
// look narrows, the brows draw up. Movement of the whole eye is small and
// slow, and nothing repeats in beats or winks.
const GESTURES: Record<EyeEmotion, Gesture[]> = {
  neutral: [
    { duration: 2.4, rise: 0.4, hold: 0.25, gazeX: 0.22, roll: 1 },
    { duration: 2.6, rise: 0.4, hold: 0.3, open: 0.95, squint: 0.12 },
    // A small private smile, there and gone.
    { duration: 2.8, rise: 0.4, hold: 0.3, smile: 0.3 },
  ],
  curious: [
    // The peer: the head tips a little and one lid lifts.
    { duration: 2.6, rise: 0.35, hold: 0.4, roll: 3, gazeX: 0.16, open: 1.04 },
    { duration: 2.4, rise: 0.35, hold: 0.35, squint: 0.18, slant: 3 },
  ],
  focused: [
    { duration: 2.4, rise: 0.4, hold: 0.3, open: 0.92, squint: 0.2 },
    // Bearing down on it: the slant deepens and the lids close in a little.
    { duration: 2.6, rise: 0.35, hold: 0.4, slant: 4, squint: 0.3 },
  ],
  happy: [
    // The smile: the crescents thin and lift.
    { duration: 2.6, rise: 0.35, hold: 0.4, smile: 0.7, lift: -1 },
    { duration: 2.2, rise: 0.35, hold: 0.3, open: 0.94, spread: 1.5, smile: 0.3 },
  ],
  concerned: [
    // Aversion: down and away, slowly, and slow to come back.
    { duration: 3, rise: 0.42, hold: 0.34, gazeY: 0.24, gazeX: -0.16, open: 0.92 },
    // The brows draw up further in the middle, and hold.
    { duration: 2.8, rise: 0.4, hold: 0.36, slant: -5, squint: 0.15 },
  ],
  surprised: [
    { duration: 1.4, rise: 0.25, hold: 0.25, open: 1.06, spread: 2 },
    // Rounding out for a moment.
    { duration: 1.6, rise: 0.25, hold: 0.3, round: -0.5, open: 1.05 },
  ],
}

/** Gestures fired by an event rather than by the idle timer. */
const REACTIONS: Record<string, Gesture> = {
  // Acknowledgement when the microphone opens: the eyes open a touch.
  listening: { duration: 1, rise: 0.35, hold: 0.2, open: 1.04, round: -0.3 },
  // Turning inward to think: a glance up and away, and the lids narrow.
  thinking: { duration: 2.4, rise: 0.35, hold: 0.4, gazeX: -0.24, gazeY: -0.2, open: 0.94, squint: 0.2 },
  // Settling in to talk.
  speaking: { duration: 1, rise: 0.4, hold: 0.15, open: 1.02, smile: 0.15 },
  paused: { duration: 1.4, rise: 0.5, hold: 0.2, open: 0.9, gazeY: 0.15 },
  // Something to look at has appeared: a small widening.
  attend: { duration: 1.1, rise: 0.35, hold: 0.2, open: 1.05, spread: 1 },
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
  /** The same outline once more, so the catchlight never shows outside a lid. */
  clip: SVGPathElement | null
  spark: SVGEllipseElement | null
}

function emptyNodes(): EyeNodes {
  return { group: null, glowGroup: null, core: null, glow: null, scan: null, clip: null, spark: null }
}

/** One spring per shape parameter, so each can carry its own momentum. */
class ShapeSprings {
  private readonly springs: Record<keyof EyeShape, Spring>

  constructor(shape: EyeShape) {
    this.springs = Object.fromEntries(
      EYE_KEYS.map((key) => [key, new Spring(shape[key], 1.6, key === 'n' ? 1 : 0.95)]),
    ) as Record<keyof EyeShape, Spring>
  }

  tune(frequency: number, damping: number) {
    for (const key of EYE_KEYS) {
      const spring = this.springs[key]
      spring.frequency = frequency
      // Squareness has no business wobbling; it would ripple the whole silhouette.
      spring.damping = key === 'n' ? Math.max(1, damping) : damping
    }
  }

  step(target: EyeShape, dt: number, out: EyeShape) {
    for (const key of EYE_KEYS) out[key] = this.springs[key].step(target[key], dt)
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
  /**
   * Somewhere to look instead of at the pointer, in the same -1 to 1 gaze
   * space, or null to follow the pointer as usual. A ref for the same reason
   * as `levelRef`: the page steers it several times during one movement.
   */
  attentionRef?: RefObject<{ x: number; y: number } | null>
}

export function GideonEyes({ phase, emotion, levelRef, attentionRef }: GideonEyesProps) {
  const leftNodes = useRef<EyeNodes>(emptyNodes())
  const rightNodes = useRef<EyeNodes>(emptyNodes())
  const haloRef = useRef<SVGEllipseElement>(null)
  const auraRef = useRef<SVGGElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // Ids are per face, so two on one page never borrow each other's clip or gradient.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')

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
    // How fast the gaze is travelling, which is what stretches and leans an eye.
    const glance = { x: 0, y: 0, vx: 0, vy: 0 }

    // Blink timeline. Closing is quicker than opening, which is what makes a
    // blink read as a blink rather than as a wipe.
    const blinkState = { t: Infinity, close: 0.075, hold: 0.02, open: 0.14, queued: 0 }
    let blinkIn = exponentialInterval(4)
    let blink = 1

    let gesture: ActiveGesture | null = null
    let gestureIn = 4 + exponentialInterval(8)
    let lastPhase = input.current.phase
    let attending = false
    // The feeling on the face, which follows the one asked for only once it
    // has lasted, and stays a while once it has changed.
    let shown = input.current.emotion
    let candidate = shown
    let candidateFor = 0
    let shownFor = EMOTION_HOLD_S

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

      const { phase: p, emotion: wanted } = input.current
      const rm = reducedMotion
      if (wanted !== candidate) {
        candidate = wanted
        candidateFor = 0
      }
      candidateFor += dt
      shownFor += dt
      if (candidate !== shown && (rm || (candidateFor >= EMOTION_SETTLE_S && shownFor >= EMOTION_HOLD_S))) {
        shown = candidate
        shownFor = 0
      }
      const e = shown
      const level = levelRef?.current ?? 0
      const dynamics = DYNAMICS[e] ?? DYNAMICS.neutral
      const target = targetPose(p, e)

      // A change of phase is a real event, so the face reacts to it.
      if (p !== lastPhase) {
        const reaction = REACTIONS[p]
        if (reaction && !rm) fire(reaction)
        lastPhase = p
        gestureIn = Math.max(gestureIn, 5)
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
      let gSmile = 0
      let gSquint = 0
      let gSlant = 0
      let gWink = 0
      let gRound = 0
      let winkSide: -1 | 1 = 1

      if (!rm) {
        gestureIn -= dt
        if (gestureIn <= 0) {
          const pool = GESTURES[e] ?? GESTURES.neutral
          if (!gesture && pool.length && p !== 'listening') fire(pool[Math.floor(Math.random() * pool.length)])
          // Never while someone is talking to it: a face that keeps moving
          // while you speak looks like it is not listening.
          const busy = p === 'thinking' ? 0.7 : p === 'listening' ? 2 : 1
          gestureIn = 3 + exponentialInterval(dynamics.gesture * busy)
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
            gSmile = (g.smile ?? 0) * k
            gSquint = (g.squint ?? 0) * k
            gSlant = (g.slant ?? 0) * k
            gWink = (g.wink ?? 0) * k
            gRound = (g.round ?? 0) * k
            winkSide = mirror
          }
        }
      }

      // -- Gaze --------------------------------------------------------------
      // Something to look at outranks the pointer, and is looked at briskly:
      // a glance that trails a second behind the thing it is following reads
      // as distracted rather than interested.
      const attention = attentionRef?.current ?? null
      if ((attention !== null) !== attending) {
        attending = attention !== null
        if (attending && !rm) fire(REACTIONS.attend)
      }
      follow.x.frequency = attention ? 2.2 : 1.1
      follow.y.frequency = attention ? 2.2 : 1.1
      const followAmount = FOLLOW[p] ?? 0.8
      const fx = follow.x.step(
        attention ? clamp(attention.x, -1.2, 1.2) : pointer.x * followAmount,
        dt,
      )
      const fy = follow.y.step(
        attention ? clamp(attention.y, -1.2, 1.2) : pointer.y * followAmount * 0.85,
        dt,
      )

      if (!rm) {
        // Ocular drift: a random walk that is always being pulled back home.
        drift.x = ornstein(drift.x, dt, 2.4, 0.12)
        drift.y = ornstein(drift.y, dt, 2.6, 0.08)

        // Saccades: a jump on the main sequence, then a fixation.
        saccade.t += dt
        if (saccade.t >= saccade.duration) {
          saccade.x = saccade.toX
          saccade.y = saccade.toY
          saccade.wait -= dt
          if (saccade.wait <= 0) {
            // Mostly small refixations, now and then a real look elsewhere.
            const big = Math.random() < 0.08
            const spanX = big ? 0.42 : 0.12
            const spanY = big ? 0.22 : 0.08
            saccade.fromX = saccade.x
            saccade.fromY = saccade.y
            saccade.toX = clamp((Math.random() - 0.5) * 2 * spanX, -0.7, 0.7)
            saccade.toY = clamp((Math.random() - 0.5) * 2 * spanY, -0.45, 0.45)
            const amp = Math.hypot(saccade.toX - saccade.fromX, saccade.toY - saccade.fromY)
            saccade.duration = saccadeDuration(amp)
            saccade.t = 0
            // Fixations run long while thinking and short while listening.
            const dwell = p === 'thinking' ? 0.7 : p === 'listening' ? 1.6 : 1
            saccade.wait = 0.7 + exponentialInterval(2.2 * dwell)
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

      // A glance has speed, and an eye that is moving fast smears along its
      // path the way a drawn one does: longer in the direction of travel,
      // leaning into it, and back to itself the moment it lands.
      const settle = Math.min(1, dt * 16)
      glance.vx += ((rm ? 0 : (gazeX - glance.x) / dt) - glance.vx) * settle
      glance.vy += ((rm ? 0 : (gazeY - glance.y) / dt) - glance.vy) * settle
      glance.x = gazeX
      glance.y = gazeY
      const smearX = clamp(Math.abs(glance.vx) * 0.03, 0, 0.2)
      const smearY = clamp(Math.abs(glance.vy) * 0.03, 0, 0.16)
      const lean = clamp(glance.vx * 0.022, -0.26, 0.26)

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
      // The swell of a phrase, not each syllable: followed over about a third
      // of a second, so the eyes brighten as he speaks rather than pulse.
      amplitude += (((p === 'speaking' ? level : 0) - amplitude) * Math.min(1, dt * 3))
      // Breathing slows when calm and quickens when activated.
      const breathRate = p === 'thinking' ? 0.17 : p === 'listening' ? 0.22 : 0.19
      const breathing = rm ? 0 : breath(elapsed * breathRate)
      const idleFloat = rm ? 0 : fbm(elapsed * 0.31, 3) * 1.4

      const headRoll = roll.step(rm ? 0 : gRoll + gazeX * 1.6 + fbm(elapsed * 0.24 + 9, 2) * 1.1, dt)
      const headLift = lift.step(
        rm ? 0 : gLift + breathing * 1.2 + idleFloat + amplitude * -0.5,
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
        const speech = 1 + amplitude * 0.04
        // Lids travel with the gaze, as real ones do: down with a look down,
        // and the lower one up a little with a look up.
        const lookDown = Math.max(0, gazeY)
        const lookUp = Math.max(0, -gazeY)
        const shaped: EyeShape = keepOpen({
          ...shape,
          h: Math.max(6, shape.h * speech * gOpen * (1 + smearY - smearX * 0.5)),
          w: Math.max(6, shape.w * squeeze * (1 - amplitude * 0.03) * (1 + smearX - smearY * 0.5)),
          n: clamp(shape.n + gRound, 2, 9),
          upperLid: clamp(shape.upperLid + gSquint * 0.2 + lookDown * 0.14, 0, 0.85),
          upperAngle: shape.upperAngle + gSlant,
          lowerLid: clamp(shape.lowerLid + gSquint * 0.16 + gSmile * 0.24 + lookUp * 0.09, 0, 0.8),
          // Talking lifts the lower lids a touch, with the phrase.
          lowerBend: clamp(shape.lowerBend + gSmile * 0.8 + amplitude * 0.06, -1, 1),
        })
        const lid = sign === winkSide ? blink * (1 - gWink * 0.95) : blink
        // The near side of a turned head is the taller one.
        const outline = eyeOutline(shaped, sign, lid, { lean, turn: yaw * 0.22 })
        const d = outline.d
        const open = outline.bottom - outline.top
        nodes.core.setAttribute('d', d)
        nodes.glow?.setAttribute('d', d)
        nodes.scan?.setAttribute('d', d)
        nodes.clip?.setAttribute('d', d)

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
          nodes.spark.setAttribute('cy', (gazeY * 3 + outline.top + Math.max(2, open * 0.15)).toFixed(2))
          nodes.spark.setAttribute('rx', (shaped.w * 0.2).toFixed(2))
          nodes.spark.setAttribute('ry', Math.max(0.6, open * 0.09).toFixed(2))
          nodes.spark.setAttribute('opacity', (0.52 * clamp(open / 24, 0, 1)).toFixed(3))
        }
      }

      write(leftNodes.current, current.left, -1)
      write(rightNodes.current, current.right, 1)

      const glow = current.glow + amplitude * 0.18
      auraRef.current?.setAttribute('opacity', Math.min(1, 0.3 + glow * 0.7).toFixed(3))
      if (haloRef.current) {
        const pulse = rm ? 0 : (breathing + 1) / 2
        haloRef.current.setAttribute('opacity', (0.06 + glow * 0.2 + pulse * 0.07).toFixed(3))
        haloRef.current.setAttribute('rx', (108 + glow * 12 + pulse * 7 + amplitude * 6).toFixed(2))
        haloRef.current.setAttribute('ry', (68 + glow * 8 + pulse * 5 + amplitude * 4).toFixed(2))
      }
      // The page reads this to keep its glow in step with the face.
      rootRef.current?.style.setProperty('--eye-glow', (glow + amplitude * 0.2).toFixed(3))

      frame = requestAnimationFrame(render)
    }

    frame = requestAnimationFrame(render)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('blur', onPointerLeave)
    }
  }, [levelRef, attentionRef])

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
      left: eyeOutline(resting.left, -1).d,
      right: eyeOutline(resting.right, 1).d,
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
          <linearGradient id={`eye-core-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="46%" stopColor="#edf5ff" />
            <stop offset="100%" stopColor="#cbd8e8" />
          </linearGradient>
          <radialGradient id={`eye-halo-${uid}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#bfe9ff" stopOpacity="0.34" />
            <stop offset="62%" stopColor="#bfe9ff" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#bfe9ff" stopOpacity="0" />
          </radialGradient>

          {/* Fine horizontal scanlines read the lights as an emissive panel. */}
          <pattern id={`eye-scan-${uid}`} width="3" height="3" patternUnits="userSpaceOnUse">
            <rect width="3" height="1" fill="#0b1017" fillOpacity="0.4" />
          </pattern>

          <clipPath id={`eye-clip-left-${uid}`}>
            <path ref={bindLeft('clip')} d={rest.left} />
          </clipPath>
          <clipPath id={`eye-clip-right-${uid}`}>
            <path ref={bindRight('clip')} d={rest.right} />
          </clipPath>
        </defs>

        <ellipse
          ref={haloRef}
          className="eye-halo"
          cx={CENTER_X}
          cy={CENTER_Y}
          rx={108}
          ry={68}
          fill={`url(#eye-halo-${uid})`}
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
            <path ref={bindLeft('core')} className="eye-core" fill={`url(#eye-core-${uid})`} d={rest.left} />
            <path ref={bindLeft('scan')} className="eye-scan" fill={`url(#eye-scan-${uid})`} d={rest.left} />
            <ellipse ref={bindLeft('spark')} className="eye-spark" clipPath={`url(#eye-clip-left-${uid})`} />
          </g>
          <g ref={bindRight('group')} transform={rest.rightTransform}>
            <path
              ref={bindRight('core')}
              className="eye-core"
              fill={`url(#eye-core-${uid})`}
              d={rest.right}
            />
            <path
              ref={bindRight('scan')}
              className="eye-scan"
              fill={`url(#eye-scan-${uid})`}
              d={rest.right}
            />
            <ellipse ref={bindRight('spark')} className="eye-spark" clipPath={`url(#eye-clip-right-${uid})`} />
          </g>
        </g>
      </svg>
    </div>
  )
}
