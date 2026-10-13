import { describe, expect, it } from 'vitest'
import { cloudOutline } from './cloud-shape'

/** Where each puff ends, which is a valley of the cloud. */
function valleys(d: string): [number, number][] {
  return [...d.matchAll(/A[\d.]+ [\d.]+ 0 0 1 (-?[\d.]+) (-?[\d.]+)/gu)].map((arc) => [Number(arc[1]), Number(arc[2])])
}

function radii(d: string): number[] {
  return [...d.matchAll(/A([\d.]+) /gu)].map((arc) => Number(arc[1]))
}

describe('the outline of a thought cloud', () => {
  it('is one closed ring of puffs, each swelling outward', () => {
    const cloud = cloudOutline(220, 76)
    expect(cloud.d.startsWith('M')).toBe(true)
    expect(cloud.d.endsWith('Z')).toBe(true)
    expect(valleys(cloud.d)).toHaveLength(cloud.puffs)
    expect(cloud.d).not.toMatch(/NaN|Infinity/u)
    // Every arc turns the same way, the way that bulges out of a clockwise ring.
    expect(cloud.d.match(/ 0 0 1 /gu)).toHaveLength(cloud.puffs)
    expect(cloud.d).not.toMatch(/ 0 [01] 0 | 0 1 1 /u)
  })

  it('keeps its valleys on the box, so the words inside are never crossed', () => {
    for (const [width, height] of [[220, 76], [160, 57], [58, 52], [300, 40]]) {
      for (const [x, y] of valleys(cloudOutline(width, height).d)) {
        expect(x).toBeGreaterThanOrEqual(-0.05)
        expect(x).toBeLessThanOrEqual(width + 0.05)
        expect(y).toBeGreaterThanOrEqual(-0.05)
        expect(y).toBeLessThanOrEqual(height + 0.05)
      }
    }
  })

  it('has puffs of uneven size, and none that overwhelms the words', () => {
    const cloud = cloudOutline(220, 76)
    const sizes = radii(cloud.d)
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeGreaterThan(1.25)
    expect(cloud.reach).toBeGreaterThan(6)
    expect(cloud.reach).toBeLessThan(76 / 2)
  })

  it('is still a cloud round three dots, and grows more puffs round more words', () => {
    const small = cloudOutline(58, 52)
    const wide = cloudOutline(240, 76)
    expect(small.puffs).toBeGreaterThanOrEqual(7)
    expect(wide.puffs).toBeGreaterThan(small.puffs)
  })

  it('gives the same words the same cloud', () => {
    expect(cloudOutline(220, 76)).toEqual(cloudOutline(220, 76))
  })

  it('draws nothing round a box that has not been laid out yet', () => {
    expect(cloudOutline(0, 0)).toEqual({ d: '', reach: 0, puffs: 0 })
    expect(cloudOutline(Number.NaN, 40).d).toBe('')
  })
})
