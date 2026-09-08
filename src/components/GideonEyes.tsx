import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/**
 * GIDEON's face: two machine eyes, nothing else.
 *
 * The old presence drew fixed CSS capsules inside a metal sphere, so every
 * "expression" was really just a rotation. These eyes are SVG paths rebuilt
 * every frame from a handful of numbers — width, height, corner radius, how much
 * the top and bottom edges bow, tilt, vertical offset — which is what lets them
 * genuinely curve. Happiness is a real arc, not a tilted pill.
 *
 * Every number is driven by a critically damped spring toward the current pose,
 * so the face eases between emotions instead of snapping, and the whole loop
 * writes straight to the DOM rather than through React state.
 */

export type EyePhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused'
export type EyeEmotion =
  | 'neutral'
  | 'curious'
  | 'focused'
  | 'happy'
  | 'concerned'
  | 'surprised'

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

const VIEW_W = 200
const VIEW_H = 124
const CENTER_X = VIEW_W / 2
const CENTER_Y = VIEW_H / 2
const BASE_GAP = 68

const NEUTRAL: EyeShape = { w: 46, h: 72, r: 20, topBow: 3, bottomBow: 0, tilt: 0, dy: 0 }

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
    { h: 64, dy: -10, tilt: -14, topBow: 5 },
    { h: 76, dy: 5, tilt: 5, topBow: 1 },
    0.55,
  ),
  focused: pose(
    { h: 52, w: 50, r: 17, topBow: 0 },
    { h: 52, w: 50, r: 17, topBow: 0 },
    0.5,
  ),
  happy: pose(
    { h: 42, r: 18, topBow: 8, bottomBow: 13, dy: -4 },
    { h: 42, r: 18, topBow: 8, bottomBow: 13, dy: -4 },
    0.8,
    5,
  ),
  concerned: pose(
    { h: 54, tilt: 17, dy: 5, topBow: 6 },
    { h: 54, tilt: -17, dy: 5, topBow: 6 },
    0.3,
  ),
  surprised: pose(
    { h: 86, w: 52, r: 24, topBow: 3 },
    { h: 86, w: 52, r: 24, topBow: 3 },
    0.75,
    4,
  ),
}

/** Phase nudges applied on top of the emotion pose. */
const PHASES: Record<EyePhase, Partial<EyeShape> & { glow?: number; gazeY?: number }> = {
  idle: {},
  listening: { h: 5, w: 1, topBow: 3, glow: 0.22 },
  thinking: { h: -21, topBow: -3, glow: 0.1, gazeY: -0.55 },
  speaking: { glow: 0.24 },
  paused: { h: -33, topBow: -3, glow: -0.22 },
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
    h: Math.max(8, shape.h + (shift.h ?? 0)),
    r: shape.r,
    topBow: Math.max(0, shape.topBow + (shift.topBow ?? 0)),
    bottomBow: shape.bottomBow,
    tilt: shape.tilt + (shift.tilt ?? 0),
    dy: shape.dy + (shift.dy ?? 0),
  })

  return {
    left: apply(base.left),
    right: apply(base.right),
    glow: Math.max(0, Math.min(1, base.glow + (shift.glow ?? 0))),
    spread: base.spread,
  }
}

const SPRING = 13
const FAST_SPRING = 22

function approach(current: number, target: number, dt: number, rate = SPRING) {
  return current + (target - current) * (1 - Math.exp(-rate * dt))
}

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
  const haloRef = useRef<SVGCircleElement>(null)
  const auraRef = useRef<SVGGElement>(null)

  // Live inputs, read by the animation loop without restarting it.
  const input = useRef({ phase, emotion })
  input.current = { phase, emotion }

  useEffect(() => {
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    // The eyes follow the pointer themselves; routing it through props would
    // re-render the page on every mouse move.
    const pointer = { x: 0, y: 0 }
    const onPointerMove = (event: PointerEvent) => {
      pointer.x = Math.max(-1, Math.min(1, (event.clientX / window.innerWidth - 0.5) * 2))
      pointer.y = Math.max(-1, Math.min(1, (event.clientY / window.innerHeight - 0.5) * 2))
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

    const gaze = { x: 0, y: 0 }
    const saccade = { x: 0, y: 0, next: 900 }
    let blink = 1
    let blinkTarget = 1
    let blinkAt = 1_400
    let blinkQueue = 0
    let amplitude = 0
    let elapsed = 0
    let previous = performance.now()
    let frame = 0

    const render = (now: number) => {
      const dt = Math.min(0.05, (now - previous) / 1000)
      previous = now
      elapsed += dt * 1000

      const { phase: p, emotion: e } = input.current
      const rm = reducedMotion
      const l = levelRef?.current ?? 0
      const gx = pointer.x
      const gy = pointer.y
      const target = targetPose(p, e)
      const rate = rm ? 60 : SPRING

      for (const side of ['left', 'right'] as const) {
        const from = current[side]
        const to = target[side]
        from.w = approach(from.w, to.w, dt, rate)
        from.h = approach(from.h, to.h, dt, rate)
        from.r = approach(from.r, to.r, dt, rate)
        from.topBow = approach(from.topBow, to.topBow, dt, rate)
        from.bottomBow = approach(from.bottomBow, to.bottomBow, dt, rate)
        from.tilt = approach(from.tilt, to.tilt, dt, rate)
        from.dy = approach(from.dy, to.dy, dt, rate)
      }
      current.glow = approach(current.glow, target.glow, dt, rate)
      current.spread = approach(current.spread, target.spread, dt, rate)

      // Blinking: an occasional double blink reads far more alive than a metronome.
      if (rm) {
        blink = 1
      } else {
        blinkAt -= dt * 1000
        if (blinkAt <= 0) {
          blinkTarget = 0.06
          blinkQueue = Math.random() < 0.22 ? 1 : 0
          blinkAt = 2_600 + Math.random() * 4_200
          window.setTimeout(() => {
            blinkTarget = 1
            if (blinkQueue > 0) {
              blinkQueue -= 1
              window.setTimeout(() => {
                blinkTarget = 0.06
                window.setTimeout(() => {
                  blinkTarget = 1
                }, 82)
              }, 110)
            }
          }, 88)
        }
        blink = approach(blink, blinkTarget, dt, FAST_SPRING * 2.4)
      }

      // Gaze: pointer plus small involuntary saccades.
      saccade.next -= dt * 1000
      if (saccade.next <= 0 && !rm) {
        saccade.x = (Math.random() - 0.5) * 0.36
        saccade.y = (Math.random() - 0.5) * 0.24
        saccade.next = 700 + Math.random() * 2_100
      }
      const thinkingBias = p === 'thinking' ? (PHASES.thinking.gazeY ?? 0) : 0
      const wander = p === 'thinking' && !rm ? Math.sin(elapsed / 620) * 0.42 : 0
      gaze.x = approach(gaze.x, gx * 0.85 + saccade.x + wander, dt, 9)
      gaze.y = approach(gaze.y, gy * 0.8 + saccade.y + thinkingBias, dt, 9)

      amplitude = approach(amplitude, p === 'speaking' ? l : 0, dt, 26)

      const gapShift = current.spread
      const write = (nodes: EyeNodes, shape: EyeShape, sign: number, parallax: number) => {
        if (!nodes.group || !nodes.core) return
        // Speech makes the eyes breathe vertically with the voice.
        const speech = 1 + amplitude * 0.16
        const shaped: EyeShape = { ...shape, h: shape.h * speech, w: shape.w * (1 - amplitude * 0.03) }
        const d = eyePath(shaped, blink)
        nodes.core.setAttribute('d', d)
        nodes.glow?.setAttribute('d', d)
        nodes.scan?.setAttribute('d', d)

        const x = CENTER_X + sign * (BASE_GAP / 2 + gapShift) + gaze.x * (7 + parallax)
        const y = CENTER_Y + shape.dy + gaze.y * (5 + parallax * 0.6)
        const transform = `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${shape.tilt.toFixed(2)})`
        nodes.group.setAttribute('transform', transform)
        nodes.glowGroup?.setAttribute('transform', transform)

        if (nodes.spark) {
          nodes.spark.setAttribute('cx', (gaze.x * 3.2 - shaped.w * 0.16).toFixed(2))
          nodes.spark.setAttribute('cy', (gaze.y * 2.4 - (shaped.h * blink) / 2 + 9).toFixed(2))
          nodes.spark.setAttribute('rx', (shaped.w * 0.2).toFixed(2))
          nodes.spark.setAttribute('ry', Math.max(0.6, shaped.h * blink * 0.09).toFixed(2))
          nodes.spark.setAttribute('opacity', (0.5 * blink).toFixed(3))
        }
      }

      write(leftNodes.current, current.left, -1, 0)
      write(rightNodes.current, current.right, 1, 1.6)

      const glow = current.glow + amplitude * 0.3
      auraRef.current?.setAttribute('opacity', Math.min(1, 0.28 + glow * 0.72).toFixed(3))
      if (haloRef.current) {
        const breathe = rm ? 0 : Math.sin(elapsed / (p === 'listening' ? 900 : 2_400)) * 0.5 + 0.5
        haloRef.current.setAttribute('opacity', (0.05 + glow * 0.16 + breathe * 0.06).toFixed(3))
        haloRef.current.setAttribute('r', (72 + glow * 5 + breathe * 4 + amplitude * 7).toFixed(2))
      }

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

  const bind =
    <K extends keyof EyeNodes>(store: RefObject<EyeNodes>, key: K) =>
    (node: EyeNodes[K]) => {
      store.current[key] = node
    }
  const bindLeft = <K extends keyof EyeNodes>(key: K) => bind(leftNodes, key)
  const bindRight = <K extends keyof EyeNodes>(key: K) => bind(rightNodes, key)

  return (
    <div className="gideon-face" data-phase={phase} data-emotion={emotion}>
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
            <rect width="3" height="1" fill="#0b1017" fillOpacity="0.5" />
          </pattern>
        </defs>

        <circle
          ref={haloRef}
          className="eye-halo"
          cx={CENTER_X}
          cy={CENTER_Y}
          r={72}
          fill="url(#eye-halo)"
        />

        <g ref={auraRef} className="eye-aura">
          <g ref={bindLeft('glowGroup')}>
            <path ref={bindLeft('glow')} className="eye-glow" />
          </g>
          <g ref={bindRight('glowGroup')}>
            <path ref={bindRight('glow')} className="eye-glow" />
          </g>
        </g>

        <g>
          <g ref={bindLeft('group')}>
            <path ref={bindLeft('core')} className="eye-core" fill="url(#eye-core)" />
            <path ref={bindLeft('scan')} className="eye-scan" fill="url(#eye-scan)" />
            <ellipse ref={bindLeft('spark')} className="eye-spark" />
          </g>
          <g ref={bindRight('group')}>
            <path ref={bindRight('core')} className="eye-core" fill="url(#eye-core)" />
            <path ref={bindRight('scan')} className="eye-scan" fill="url(#eye-scan)" />
            <ellipse ref={bindRight('spark')} className="eye-spark" />
          </g>
        </g>
      </svg>
    </div>
  )
}
