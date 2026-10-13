import { NEUTRAL_EYE, keepOpen, type EyeShape } from './eye-shape'
import type { EyeEmotion } from './mood'

/**
 * What each feeling looks like, and what each phase of a turn does to it.
 *
 * The feelings are told apart by silhouette before anything moves: a smile is
 * two crescents, worry slants out and down, attention slants in, surprise goes
 * round. A face that only changed size between them would have to be watched
 * for a while to be read; these can be read in a glance.
 */

export type EyePhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused'

export interface Pose {
  left: EyeShape
  right: EyeShape
  /** Halo intensity, 0–1. */
  glow: number
  /** Extra separation between the eyes. */
  spread: number
}

function eye(overrides: Partial<EyeShape> = {}): EyeShape {
  return { ...NEUTRAL_EYE, ...overrides }
}

function pose(left: Partial<EyeShape>, right: Partial<EyeShape>, glow = 0.4, spread = 0): Pose {
  return { left: eye(left), right: eye(right), glow, spread }
}

/** The same eye on both sides; the outline mirrors inner and outer by itself. */
function both(shape: Partial<EyeShape>, glow = 0.4, spread = 0): Pose {
  return pose(shape, shape, glow, spread)
}

/**
 * Emotion first, then the phase layered on top: a happy GIDEON that is
 * currently listening should still read as happy.
 */
export const EMOTIONS: Record<EyeEmotion, Pose> = {
  neutral: both({}, 0.4),
  // One brow up, one down: the raised eye rounder and taller, the other
  // narrowed under a level lid.
  curious: pose(
    { h: 80, w: 50, n: 2.7, dy: -9, tilt: -7, taper: 0.1 },
    { h: 66, upperLid: 0.2, upperAngle: 5, lowerLid: 0.06, dy: 4, tilt: 4 },
    0.55,
    2,
  ),
  // Squared and slanted in: the look of someone working something out.
  focused: both({ h: 62, w: 54, n: 4.6, upperLid: 0.2, upperAngle: 11, lowerLid: 0.1, taper: 0.1 }, 0.5, -4),
  // Two crescents, the lower lid pushed up into the eye.
  happy: both({ h: 60, w: 58, n: 2.3, lowerLid: 0.22, lowerBend: 0.86, dy: -6 }, 0.82, 7),
  // Slanted out and down, a little heavy, with the lower lid rising to meet it.
  concerned: both({ h: 66, n: 2.9, upperLid: 0.2, upperAngle: -16, upperBend: 0.08, lowerLid: 0.08, lowerBend: 0.1, dy: 6, taper: -0.1 }, 0.3, -2),
  // Round, wide and unguarded.
  surprised: both({ h: 86, w: 62, n: 2.15 }, 0.78, 6),
}

type PhaseShift = Partial<EyeShape> & { hScale?: number; glow?: number; gazeY?: number }

/**
 * Phase nudges applied on top of the emotion pose.
 *
 * Height is a *scale*, not an offset. As a flat subtraction it worked for the
 * neutral eye and quietly destroyed the short ones: a happy face is not tall,
 * so pausing it took most of it away and left a slit.
 */
export const PHASES: Record<EyePhase, PhaseShift> = {
  idle: {},
  // Open and a touch rounder: all attention.
  listening: { hScale: 1.08, w: 1, n: -0.5, glow: 0.22 },
  // Narrowed from below and looking up and away.
  thinking: { hScale: 0.9, upperLid: 0.08, lowerLid: 0.17, lowerBend: 0.07, glow: 0.1, gazeY: -0.55 },
  speaking: { glow: 0.24 },
  // Heavy-lidded, not shut: resting, and easy to wake.
  paused: { hScale: 0.86, upperLid: 0.44, upperBend: 0.14, glow: -0.22 },
}

const within = (value: number, min: number, max: number) => (value < min ? min : value > max ? max : value)

export function targetPose(phase: EyePhase, emotion: EyeEmotion): Pose {
  const base = EMOTIONS[emotion] ?? EMOTIONS.neutral
  const shift = PHASES[phase] ?? {}
  // A resting pose keeps a fifth of the eye open, so a phase can narrow a
  // feeling without closing it: a smile that is thinking is still a smile.
  const apply = (shape: EyeShape): EyeShape => keepOpen({
    w: shape.w + (shift.w ?? 0),
    h: Math.max(8, shape.h * (shift.hScale ?? 1) + (shift.h ?? 0)),
    n: within(shape.n + (shift.n ?? 0), 2, 9),
    taper: shape.taper + (shift.taper ?? 0),
    upperLid: within(shape.upperLid + (shift.upperLid ?? 0), 0, 0.8),
    upperAngle: shape.upperAngle + (shift.upperAngle ?? 0),
    upperBend: within(shape.upperBend + (shift.upperBend ?? 0), -1, 1),
    lowerLid: within(shape.lowerLid + (shift.lowerLid ?? 0), 0, 0.7),
    lowerAngle: shape.lowerAngle + (shift.lowerAngle ?? 0),
    lowerBend: within(shape.lowerBend + (shift.lowerBend ?? 0), -1, 1),
    tilt: shape.tilt + (shift.tilt ?? 0),
    dy: shape.dy + (shift.dy ?? 0),
  }, 0.2)

  return {
    left: apply(base.left),
    right: apply(base.right),
    glow: within(base.glow + (shift.glow ?? 0), 0, 1),
    spread: base.spread,
  }
}
