import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROFILE,
  displacementField,
  edgeDistance,
  refractionShift,
  squircleHeight,
  surfaceSlope,
} from './liquid-glass'

/**
 * The arithmetic behind the glass, checked without a browser.
 *
 * What matters is not the exact numbers, which are a matter of taste tuned by
 * eye, but the shape of them: the middle of a pane must not move at all, the
 * rim must, and the two must meet without a step between them.
 */

describe('the surface of the glass', () => {
  it('rises from the rim to the flat top', () => {
    expect(squircleHeight(0)).toBe(0)
    expect(squircleHeight(1)).toBe(1)
    for (let t = 0.1; t < 1; t += 0.1) {
      expect(squircleHeight(t)).toBeGreaterThan(squircleHeight(t - 0.1))
    }
  })

  it('leaves the rim steeply and arrives flat', () => {
    // The shape of the whole effect: a bright narrow band at the edge rather
    // than a soft bevel spread across the border.
    expect(surfaceSlope(0.02)).toBeGreaterThan(3)
    expect(surfaceSlope(0.98)).toBeLessThan(0.35)
  })
})

describe('how far the backdrop moves', () => {
  it('does not move where the glass is flat, or beyond it', () => {
    expect(refractionShift(0, DEFAULT_PROFILE)).toBe(0)
    expect(refractionShift(1, DEFAULT_PROFILE)).toBe(0)
    expect(refractionShift(1.4, DEFAULT_PROFILE)).toBe(0)
  })

  /**
   * Where the bending lives. The squircle is steep enough that the glass is
   * already half its thickness a fiftieth of the way in, so the shift peaks
   * against the rim and falls away inwards: a bright compressed strip at the
   * edge, not a wide smear across the border. Measured at the default profile,
   * the peak is about nine pixels and everything above half of it fits inside
   * the outer fifth of the bezel.
   */
  it('bends hardest at the rim and fades inwards to nothing', () => {
    const shifts: number[] = []
    for (let t = 0; t <= 1; t += 0.005) shifts.push(refractionShift(t, DEFAULT_PROFILE))
    const peak = Math.max(...shifts)
    const peakAt = shifts.indexOf(peak) * 0.005
    const strong = shifts.filter((shift) => shift > peak / 2).length * 0.005

    expect(peak).toBeGreaterThan(1)
    expect(peakAt).toBeLessThan(0.1)
    expect(strong).toBeLessThan(0.35)
    // Past the halfway mark it is all but flat, and by the top it is gone.
    expect(refractionShift(0.5, DEFAULT_PROFILE)).toBeLessThan(peak / 5)
    expect(refractionShift(0.95, DEFAULT_PROFILE)).toBeLessThan(0.01)
  })

  it('bends more through denser glass, and not at all through air', () => {
    const air = refractionShift(0.5, { ...DEFAULT_PROFILE, index: 1 })
    const glass = refractionShift(0.5, { ...DEFAULT_PROFILE, index: 1.5 })
    const denser = refractionShift(0.5, { ...DEFAULT_PROFILE, index: 1.8 })
    expect(air).toBe(0)
    expect(denser).toBeGreaterThan(glass)
  })
})

describe('the edge of a rounded rectangle', () => {
  const width = 200
  const height = 120
  const radius = 24

  it('is zero on the edge, negative within, positive without', () => {
    expect(edgeDistance(0, height / 2, width, height, radius)).toBeCloseTo(0, 5)
    expect(edgeDistance(width / 2, height / 2, width, height, radius)).toBeLessThan(-50)
    expect(edgeDistance(-10, height / 2, width, height, radius)).toBeCloseTo(10, 5)
  })

  it('keeps the corners as far away as the sides, which is what rounds them', () => {
    // A point one radius in from both sides of a corner sits on the arc, so it
    // is as far from the edge as a point one radius in from one flat side.
    const corner = edgeDistance(radius, radius, width, height, radius)
    const side = edgeDistance(width / 2, radius, width, height, radius)
    expect(corner).toBeCloseTo(side, 5)
  })

  it('treats a radius larger than the box as the biggest one that fits', () => {
    expect(edgeDistance(0, height / 2, width, height, 9_999)).toBeCloseTo(0, 5)
  })
})

describe('the displacement map', () => {
  const field = displacementField(120, 90, { radius: 18, bezel: 14, index: 1.46 })

  it('leaves the middle of the pane exactly where it is', () => {
    const middle = (45 * 120 + 60) * 4
    expect(field.data[middle]).toBe(128)
    expect(field.data[middle + 1]).toBe(128)
  })

  it('moves the rim, and says how far in pixels', () => {
    const onBezel = (45 * 120 + 4) * 4
    expect(field.data[onBezel]).not.toBe(128)
    expect(field.scale).toBeGreaterThan(0)
    expect(field.scale).toBeLessThan(14)
  })

  it('pushes opposite sides in opposite directions', () => {
    const left = field.data[(45 * 120 + 4) * 4]
    const right = field.data[(45 * 120 + 115) * 4]
    expect(Math.sign(left - 128)).toBe(-Math.sign(right - 128))
  })

  it('writes a blue channel and a solid alpha, which the filter reads as no depth', () => {
    expect(field.data[2]).toBe(128)
    expect(field.data[3]).toBe(255)
  })

  it('is quiet when the glass is air', () => {
    const flat = displacementField(60, 40, { radius: 10, bezel: 8, index: 1 })
    // Air bends nothing; what is left is the last bit of floating point.
    expect(flat.scale).toBeCloseTo(0, 9)
    expect([...flat.data.slice(0, 4)]).toEqual([128, 128, 128, 255])
  })
})
