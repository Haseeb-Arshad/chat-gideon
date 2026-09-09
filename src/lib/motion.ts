/**
 * The maths behind GIDEON's face.
 *
 * Every "alive" trick in the eyes comes from one of these primitives rather
 * than from a hand-tuned CSS keyframe, which is the difference between motion
 * that loops and motion that never repeats. Nothing here touches the DOM, so
 * it is all directly testable.
 */

/** Deterministic 0–1 hash of an integer lattice point. */
export function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 13.37) * 43758.5453123
  return s - Math.floor(s)
}

/** Value noise: smoothstep-interpolated hash. Continuous, 0–1, never repeats. */
export function valueNoise(x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return hash1(i) * (1 - u) + hash1(i + 1) * u
}

/**
 * Fractal Brownian motion: octaves of value noise at halving amplitude.
 * The 2.03 lacunarity is deliberately off a clean doubling so the octaves
 * never line their peaks up into an audible-looking beat. Returns -1…1.
 */
export function fbm(x: number, octaves = 4): number {
  let sum = 0
  let amplitude = 0.5
  let frequency = 1
  let norm = 0
  for (let i = 0; i < octaves; i += 1) {
    sum += amplitude * (valueNoise(x * frequency + i * 17.3) * 2 - 1)
    norm += amplitude
    amplitude *= 0.5
    frequency *= 2.03
  }
  return norm === 0 ? 0 : sum / norm
}

/**
 * Minimum-jerk position profile, 10t³ − 15t⁴ + 6t⁵.
 *
 * This is the trajectory limbs and eyes actually follow: zero velocity *and*
 * zero acceleration at both ends. An ease-in-out cubic gets close but still
 * starts with a jolt, which is what makes scripted UI motion read as scripted.
 */
export function minimumJerk(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t
  return x * x * x * (10 + x * (-15 + 6 * x))
}

/**
 * Saccadic main sequence: a real saccade's duration rises linearly with its
 * amplitude, roughly 2.2 ms per degree plus 21 ms of fixed cost. Gaze here is
 * normalised, so one unit is treated as ~25° of visual angle.
 */
export function saccadeDuration(amplitude: number): number {
  const degrees = Math.abs(amplitude) * 25
  return Math.min(0.12, Math.max(0.028, 0.021 + 0.0022 * degrees))
}

/** Box–Muller normal deviate. */
export function gaussian(random: () => number = Math.random): number {
  const u = Math.max(1e-9, random())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
}

/**
 * One step of an Ornstein–Uhlenbeck process — a random walk pulled back toward
 * zero. This is the standard model for ocular drift: it wanders, but it never
 * wanders off, so the gaze never needs clamping.
 */
export function ornstein(
  value: number,
  dt: number,
  theta: number,
  sigma: number,
  random: () => number = Math.random,
): number {
  return value - theta * value * dt + sigma * Math.sqrt(dt) * gaussian(random)
}

/**
 * Interval from a Poisson process. Blinks arrive at a rate, not on a beat;
 * sampling the gaps exponentially is what stops them feeling metronomic.
 */
export function exponentialInterval(mean: number, random: () => number = Math.random): number {
  return -mean * Math.log(1 - Math.min(0.999999, random()))
}

/**
 * Breath curve over a 0–1 phase, returning -1…1. `rise` is the fraction of the
 * cycle spent inhaling; humans inhale in about a third of a breath and exhale
 * across the rest, and that asymmetry is most of why it reads as breathing
 * rather than as a sine wave.
 */
export function breath(phase: number, rise = 0.36): number {
  const t = phase - Math.floor(phase)
  const warped = t < rise ? (t / rise) * 0.5 : 0.5 + ((t - rise) / (1 - rise)) * 0.5
  return -Math.cos(warped * Math.PI * 2)
}

/**
 * Second-order spring integrated with semi-implicit Euler, sub-stepped so a
 * dropped frame can never blow it up.
 *
 * The reason this replaces the old exponential ease: an exponential can only
 * ever crawl toward its target. A spring with damping below 1 overshoots and
 * settles back, which is exactly what a face does when it is surprised.
 */
export class Spring {
  value: number
  velocity = 0

  constructor(
    value: number,
    /** Undamped natural frequency, in hertz. */
    public frequency: number,
    /** Damping ratio: 1 is critical, below 1 overshoots, above 1 is sluggish. */
    public damping: number,
  ) {
    this.value = value
  }

  step(target: number, dt: number): number {
    const w = this.frequency * Math.PI * 2
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)))
    const h = dt / steps
    for (let i = 0; i < steps; i += 1) {
      const acceleration = -w * w * (this.value - target) - 2 * this.damping * w * this.velocity
      this.velocity += acceleration * h
      this.value += this.velocity * h
    }
    return this.value
  }

  /** Jump straight to a value, killing any momentum. */
  set(value: number) {
    this.value = value
    this.velocity = 0
  }
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
