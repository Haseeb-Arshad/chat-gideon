import { describe, expect, it } from 'vitest'
import {
  Spring,
  breath,
  exponentialInterval,
  fbm,
  minimumJerk,
  ornstein,
  saccadeDuration,
  valueNoise,
} from './motion'

/** Deterministic stand-in for Math.random so the stochastic parts are testable. */
function lcg(seed = 1) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

describe('valueNoise', () => {
  it('stays in range and is continuous across the lattice', () => {
    let previous = valueNoise(0)
    for (let x = 0; x < 40; x += 0.01) {
      const value = valueNoise(x)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
      // No jumps, including where the integer lattice points meet.
      expect(Math.abs(value - previous)).toBeLessThan(0.05)
      previous = value
    }
  })

  it('is deterministic', () => {
    expect(valueNoise(12.34)).toBe(valueNoise(12.34))
  })
})

describe('fbm', () => {
  it('stays inside -1…1', () => {
    for (let x = 0; x < 200; x += 0.37) {
      expect(Math.abs(fbm(x))).toBeLessThanOrEqual(1)
    }
  })

  it('does not settle into a repeating cycle', () => {
    // A field that repeated would make the idle drift read as a loop.
    const a = Array.from({ length: 300 }, (_, i) => fbm(i * 0.05))
    const b = Array.from({ length: 300 }, (_, i) => fbm(1000 + i * 0.05))
    const drift = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length
    expect(drift).toBeGreaterThan(0.15)
  })
})

describe('minimumJerk', () => {
  it('spans exactly zero to one', () => {
    expect(minimumJerk(0)).toBe(0)
    expect(minimumJerk(1)).toBe(1)
    expect(minimumJerk(0.5)).toBeCloseTo(0.5, 6)
  })

  it('clamps outside the interval', () => {
    expect(minimumJerk(-3)).toBe(0)
    expect(minimumJerk(4)).toBe(1)
  })

  it('leaves and arrives with no velocity', () => {
    const h = 1e-4
    expect((minimumJerk(h) - minimumJerk(0)) / h).toBeLessThan(1e-6)
    expect((minimumJerk(1) - minimumJerk(1 - h)) / h).toBeLessThan(1e-6)
  })

  it('is monotonic', () => {
    for (let t = 0; t < 1; t += 0.01) {
      expect(minimumJerk(t + 0.01)).toBeGreaterThanOrEqual(minimumJerk(t))
    }
  })
})

describe('saccadeDuration', () => {
  it('follows the main sequence: bigger jumps take longer', () => {
    expect(saccadeDuration(0.5)).toBeGreaterThan(saccadeDuration(0.1))
  })

  it('stays inside plausible human bounds', () => {
    for (const amplitude of [0, 0.05, 0.4, 1, 40]) {
      const d = saccadeDuration(amplitude)
      expect(d).toBeGreaterThanOrEqual(0.028)
      expect(d).toBeLessThanOrEqual(0.12)
    }
  })

  it('ignores the sign of the jump', () => {
    expect(saccadeDuration(-0.4)).toBe(saccadeDuration(0.4))
  })
})

describe('Spring', () => {
  it('reaches its target when critically damped, without passing it', () => {
    const spring = new Spring(0, 2, 1)
    let overshoot = 0
    for (let i = 0; i < 300; i += 1) {
      spring.step(10, 1 / 60)
      overshoot = Math.max(overshoot, spring.value - 10)
    }
    expect(spring.value).toBeCloseTo(10, 3)
    expect(overshoot).toBeLessThan(0.01)
  })

  it('overshoots when underdamped, which is what surprise looks like', () => {
    const spring = new Spring(0, 3, 0.4)
    let peak = 0
    for (let i = 0; i < 300; i += 1) {
      spring.step(10, 1 / 60)
      peak = Math.max(peak, spring.value)
    }
    expect(peak).toBeGreaterThan(11)
    expect(spring.value).toBeCloseTo(10, 2)
  })

  it('stays stable through a dropped frame', () => {
    // A long dt has to be sub-stepped or a stiff spring diverges outright.
    const spring = new Spring(0, 4, 0.5)
    for (let i = 0; i < 120; i += 1) spring.step(10, 0.05)
    expect(Number.isFinite(spring.value)).toBe(true)
    expect(spring.value).toBeCloseTo(10, 1)
  })

  it('set kills momentum', () => {
    const spring = new Spring(0, 2, 0.5)
    spring.step(10, 0.1)
    spring.set(3)
    expect(spring.value).toBe(3)
    expect(spring.velocity).toBe(0)
  })
})

describe('ornstein', () => {
  it('wanders but is always pulled home, so the gaze never needs clamping', () => {
    const random = lcg(7)
    let value = 0
    let peak = 0
    for (let i = 0; i < 20000; i += 1) {
      value = ornstein(value, 1 / 60, 2.4, 0.22, random)
      peak = Math.max(peak, Math.abs(value))
    }
    expect(peak).toBeGreaterThan(0.01)
    expect(peak).toBeLessThan(0.5)
  })

  it('collapses to zero with no noise', () => {
    let value = 1
    for (let i = 0; i < 600; i += 1) value = ornstein(value, 1 / 60, 3, 0, lcg(1))
    expect(Math.abs(value)).toBeLessThan(0.01)
  })
})

describe('exponentialInterval', () => {
  it('averages the requested mean', () => {
    const random = lcg(11)
    let total = 0
    const n = 20000
    for (let i = 0; i < n; i += 1) total += exponentialInterval(4, random)
    expect(total / n).toBeCloseTo(4, 0)
  })

  it('is always positive, so a blink is never scheduled in the past', () => {
    const random = lcg(3)
    for (let i = 0; i < 5000; i += 1) {
      expect(exponentialInterval(4, random)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('breath', () => {
  it('runs a full cycle between -1 and 1', () => {
    expect(breath(0)).toBeCloseTo(-1, 6)
    expect(breath(0.36)).toBeCloseTo(1, 6)
    expect(breath(1)).toBeCloseTo(-1, 6)
  })

  it('inhales faster than it exhales', () => {
    // The asymmetry is the whole reason it reads as breathing.
    const inhale = 0.36
    expect(breath(inhale)).toBeGreaterThan(breath(1 - inhale))
    expect(breath(inhale / 2)).toBeCloseTo(0, 6)
  })

  it('is periodic', () => {
    expect(breath(2.4)).toBeCloseTo(breath(0.4), 6)
  })
})
