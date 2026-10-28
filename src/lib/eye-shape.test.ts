import { describe, expect, it } from 'vitest'
import { NEUTRAL_EYE, eyeOutline, keepOpen, type EyeShape } from './eye-shape'
import { EMOTIONS, PHASES, targetPose, type EyePhase } from './eye-poses'
import type { EyeEmotion } from './mood'

const eye = (overrides: Partial<EyeShape> = {}): EyeShape => ({ ...NEUTRAL_EYE, ...overrides })

/** The outline's points, read back out of its path. */
function points(d: string): [number, number][] {
  return d.slice(1, -1).split('L').map((pair) => pair.split(' ').map(Number) as [number, number])
}

function bounds(d: string) {
  const all = points(d)
  const xs = all.map(([x]) => x)
  const ys = all.map(([, y]) => y)
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
}

/** Shoelace area, for telling a sliver from an open eye. */
function area(d: string): number {
  const all = points(d)
  let sum = 0
  for (let i = 0; i < all.length; i += 1) {
    const [x0, y0] = all[i]
    const [x1, y1] = all[(i + 1) % all.length]
    sum += x0 * y1 - x1 * y0
  }
  return Math.abs(sum) / 2
}

describe('the outline of an eye', () => {
  it('is one closed path that fills the box it was given', () => {
    const { d } = eyeOutline(eye(), 1)
    expect(d).toMatch(/^M-?[\d.]+ -?[\d.]+(L-?[\d.]+ -?[\d.]+)+Z$/)
    const box = bounds(d)
    expect(box.right - box.left).toBeGreaterThan(46)
    expect(box.right - box.left).toBeLessThanOrEqual(48.01)
    expect(box.bottom - box.top).toBeGreaterThan(72)
    expect(box.bottom - box.top).toBeLessThanOrEqual(74.01)
  })

  it('never writes a negative zero, which the server and the browser disagree about', () => {
    for (const shape of [eye(), eye({ n: 2 }), eye({ upperLid: 0.3 }), eye({ lowerLid: 0.22, lowerBend: 0.86 })]) {
      for (const side of [-1, 1] as const) expect(eyeOutline(shape, side).d).not.toContain('-0.00')
    }
  })

  it('goes from an ellipse to nearly a rectangle as it squares up', () => {
    const box = 48 * 74
    const round = area(eyeOutline(eye({ n: 2 }), 1).d) / box
    const panel = area(eyeOutline(eye({ n: 3.4 }), 1).d) / box
    const square = area(eyeOutline(eye({ n: 9 }), 1).d) / box
    // An ellipse fills pi/4 of its box.
    expect(round).toBeCloseTo(Math.PI / 4, 1)
    expect(panel).toBeGreaterThan(round)
    expect(square).toBeGreaterThan(panel)
    expect(square).toBeGreaterThan(0.93)
  })

  it('leaves an open eye untouched by lids that are not on it', () => {
    const open = eyeOutline(eye(), 1)
    expect(open.top).toBeCloseTo(-37, 1)
    expect(open.bottom).toBeCloseTo(37, 1)
  })

  it('lowers its top with the upper lid and raises its bottom with the lower one', () => {
    const upper = eyeOutline(eye({ upperLid: 0.4 }), 1)
    expect(upper.top).toBeCloseTo(-37 + 0.4 * 74, 0)
    expect(upper.bottom).toBeCloseTo(37, 1)
    const lower = eyeOutline(eye({ lowerLid: 0.3 }), 1)
    expect(lower.bottom).toBeCloseTo(37 - 0.3 * 74, 0)
    expect(lower.top).toBeCloseTo(-37, 1)
  })

  it('slants the upper lid down towards the nose on both eyes alike', () => {
    const shape = eye({ upperLid: 0.2, upperAngle: 15 })
    const highest = (d: string, inner: 1 | -1) => Math.min(...points(d).filter(([x]) => x * inner > 12).map(([, y]) => y))
    const left = eyeOutline(shape, -1).d
    const right = eyeOutline(shape, 1).d
    // The left eye's inner side is on its right, and the right eye's on its left.
    expect(highest(left, 1)).toBeGreaterThan(highest(left, -1) + 4)
    expect(highest(right, -1)).toBeGreaterThan(highest(right, 1) + 4)
    // And the two are mirror images.
    const mirrored = points(right).map(([x, y]) => [-x, y] as [number, number])
    expect(bounds(left).top).toBeCloseTo(bounds(right).top, 1)
    expect(Math.min(...mirrored.map(([x]) => x))).toBeCloseTo(bounds(left).left, 1)
  })

  it('becomes a crescent when the lower lid is pushed up in the middle', () => {
    const moon = eyeOutline(eye({ w: 58, h: 60, n: 2.3, lowerLid: 0.22, lowerBend: 0.86 }), 1)
    // The middle of its underside is above the centre line, and its tips hang below it.
    expect(moon.bottom).toBeLessThan(-6)
    expect(bounds(moon.d).bottom).toBeGreaterThan(4)
    expect(moon.bottom - moon.top).toBeGreaterThan(8)
  })

  it('closes to a line of light when it blinks, and never to nothing', () => {
    for (const shape of [eye(), eye({ upperLid: 0.3, upperAngle: -16 }), eye({ lowerLid: 0.22, lowerBend: 0.86, n: 2.3 })]) {
      const open = area(eyeOutline(shape, 1, 1).d)
      const half = area(eyeOutline(shape, 1, 0.5).d)
      const shut = eyeOutline(shape, 1, 0)
      expect(half).toBeLessThan(open)
      expect(area(shut.d)).toBeLessThan(open * 0.12)
      expect(area(shut.d)).toBeGreaterThan(10)
      expect(shut.bottom - shut.top).toBeGreaterThan(0.8)
      expect(shut.bottom - shut.top).toBeLessThan(3)
    }
  })

  it('leans with a glance and grows on the side a turned head brings nearer', () => {
    const upright = bounds(eyeOutline(eye(), 1).d)
    const leaning = points(eyeOutline(eye(), 1, 1, { lean: 0.2 }).d)
    const topmost = leaning.reduce((best, point) => (point[1] < best[1] ? point : best))
    expect(topmost[0]).toBeGreaterThan(4)
    expect(bounds(eyeOutline(eye(), 1, 1, { lean: 0.2 }).d).right).toBeGreaterThan(upright.right)

    const turned = points(eyeOutline(eye({ n: 2.4 }), 1, 1, { turn: 0.3 }).d)
    const tall = (side: 1 | -1) => {
      const ys = turned.filter(([x]) => x * side > 8 && x * side < 16).map(([, y]) => y)
      return Math.max(...ys) - Math.min(...ys)
    }
    expect(tall(1)).toBeGreaterThan(tall(-1) + 3)
  })

  it('stays finite and inside its box whatever it is asked for', () => {
    let seed = 7
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const span = (min: number, max: number) => min + random() * (max - min)
    for (let i = 0; i < 400; i += 1) {
      const shape = eye({
        w: span(4, 90), h: span(4, 120), n: span(0.5, 20), taper: span(-2, 2),
        upperLid: span(-0.5, 1.5), upperAngle: span(-80, 80), upperBend: span(-2, 2),
        lowerLid: span(-0.5, 1.5), lowerAngle: span(-80, 80), lowerBend: span(-2, 2),
      })
      const outline = eyeOutline(shape, random() < 0.5 ? -1 : 1, span(-0.5, 1.5), { lean: span(-1, 1), turn: span(-1, 1) })
      const all = points(outline.d)
      expect(all.length).toBe(120)
      expect(all.flat().every(Number.isFinite)).toBe(true)
      const box = bounds(outline.d)
      // Taper can add up to 40% to one side; a lean carries the top sideways by half the height at most.
      expect(box.bottom - box.top).toBeLessThanOrEqual(shape.h * 1.4 + 0.5)
      expect(box.right - box.left).toBeLessThanOrEqual(shape.w + shape.h * 1.4 * 0.5 + 0.5)
      expect(outline.bottom).toBeGreaterThan(outline.top)
    }
  })
})

describe('keeping an eye open', () => {
  it('leaves a pose with room alone, and eases back one whose lids would shut it', () => {
    const roomy = eye({ upperLid: 0.2, lowerLid: 0.1 })
    expect(keepOpen(roomy)).toBe(roomy)

    const stacked = eye({ upperLid: 0.5, lowerLid: 0.5, lowerBend: 0.9, upperAngle: 12 })
    const eased = keepOpen(stacked, 0.2)
    const open = eyeOutline(eased, 1)
    expect((open.bottom - open.top) / eased.h).toBeGreaterThan(0.17)
    // Scaled back together, so it is the same eye, shallower.
    expect(eased.upperLid / eased.lowerLid).toBeCloseTo(1)
    expect(eased.lowerBend).toBeLessThan(0.9)
    expect(eased.upperAngle).toBe(12)
    // A blink still closes it.
    const shut = eyeOutline(eased, 1, 0)
    expect(shut.bottom - shut.top).toBeLessThan(3)
  })
})

describe('the poses', () => {
  const emotions = Object.keys(EMOTIONS) as EyeEmotion[]
  const phases = Object.keys(PHASES) as EyePhase[]
  const silhouette = (emotion: EyeEmotion, phase: EyePhase = 'idle') => {
    const pose = targetPose(phase, emotion)
    return { left: eyeOutline(pose.left, -1), right: eyeOutline(pose.right, 1), pose }
  }

  it('give every feeling in every phase an eye that is open enough to read', () => {
    for (const emotion of emotions) {
      for (const phase of phases) {
        const { left, right } = silhouette(emotion, phase)
        for (const outline of [left, right]) {
          expect(outline.bottom - outline.top, `${emotion} ${phase}`).toBeGreaterThan(6)
          expect(area(outline.d), `${emotion} ${phase}`).toBeGreaterThan(200)
        }
      }
    }
  })

  it('tell the feelings apart by silhouette, not by size alone', () => {
    const happy = silhouette('happy').left
    const surprised = silhouette('surprised').left
    const neutral = silhouette('neutral').left
    // A smile is a crescent: its underside is above the centre.
    expect(happy.bottom).toBeLessThan(0)
    expect(neutral.bottom).toBeGreaterThan(30)
    // Surprise is the roundest and the largest.
    expect(area(surprised.d)).toBeGreaterThan(area(neutral.d))

    const slope = (emotion: EyeEmotion) => {
      // Height of the top edge near the outer side minus near the inner side, on the left eye.
      const all = points(silhouette(emotion).left.d)
      const topAt = (from: number, to: number) => Math.min(...all.filter(([x]) => x > from && x < to).map(([, y]) => y))
      return topAt(-20, -10) - topAt(10, 20)
    }
    // Resolve slants down towards the nose; worry slants down away from it.
    expect(slope('focused')).toBeLessThan(-3)
    expect(slope('concerned')).toBeGreaterThan(3)
    expect(Math.abs(slope('neutral'))).toBeLessThan(0.5)
  })

  it('show curiosity as one eye a little raised and rounder, not a lopsided glitch', () => {
    const { left, right, pose } = silhouette('curious')
    expect(area(left.d)).toBeGreaterThan(area(right.d) * 1.05)
    expect(area(left.d)).toBeLessThan(area(right.d) * 1.25)
    expect(pose.left.dy).toBeLessThan(pose.right.dy)
  })

  it('rest heavy-lidded when paused, without shutting', () => {
    for (const emotion of emotions) {
      const paused = silhouette(emotion, 'paused').left
      const idle = silhouette(emotion).left
      expect(area(paused.d), emotion).toBeLessThan(area(idle.d) * 0.8)
      expect(paused.bottom - paused.top, emotion).toBeGreaterThan(6)
    }
  })
})
