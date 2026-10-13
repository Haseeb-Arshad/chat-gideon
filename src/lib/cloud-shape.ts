/**
 * The outline of a thought cloud, drawn around a box of words.
 *
 * A cloud in a comic is a ring of puffs: round bumps of uneven size that meet
 * in small valleys. The valleys sit on a pill the size of the words, so the
 * words are always inside, and each puff swells outward between two of them.
 * The sizes come from a fixed run rather than chance, so the same words always
 * get the same cloud and it does not reshuffle while it is being looked at.
 */

export interface CloudOutline {
  /** An SVG path in the box's own coordinates; the puffs spill outside it. */
  d: string
  /** How far the biggest puff reaches beyond the box. */
  reach: number
  puffs: number
}

/** How long a puff is, against the height of the words it goes round. */
const PUFF = 0.78
const FEWEST = 7
/** Uneven on purpose: a cloud of equal bumps reads as a gear. */
const SIZES = [1.28, 0.84, 1.12, 0.76, 1.2, 0.92, 1.06, 0.8]
/**
 * A puff's radius against the gap it spans. A half is a full half-circle;
 * a little over is the same puff sitting slightly lower, which is softer.
 */
const SWELL = 0.56

const fixed = (value: number) => {
  const text = value.toFixed(1)
  return text === '-0.0' ? '0.0' : text
}

/** Walks clockwise round a pill of this size, starting where the top goes flat. */
function pill(width: number, height: number) {
  const radius = Math.min(width, height) / 2
  const across = width - radius * 2
  const down = height - radius * 2
  const turn = (Math.PI * radius) / 2
  const total = (across + down) * 2 + turn * 4
  const corner = (cx: number, cy: number, from: number, along: number): [number, number] => {
    const angle = from + along / radius
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]
  }
  const at = (distance: number): [number, number] => {
    let left = ((distance % total) + total) % total
    if (left < across) return [radius + left, 0]
    left -= across
    if (left < turn) return corner(width - radius, radius, -Math.PI / 2, left)
    left -= turn
    if (left < down) return [width, radius + left]
    left -= down
    if (left < turn) return corner(width - radius, height - radius, 0, left)
    left -= turn
    if (left < across) return [width - radius - left, height]
    left -= across
    if (left < turn) return corner(radius, height - radius, Math.PI / 2, left)
    left -= turn
    if (left < down) return [0, height - radius - left]
    left -= down
    return corner(radius, radius, Math.PI, left)
  }
  return { total, at }
}

export function cloudOutline(width: number, height: number): CloudOutline {
  if (!(width > 0) || !(height > 0)) return { d: '', reach: 0, puffs: 0 }
  const edge = pill(width, height)
  const puffs = Math.max(FEWEST, Math.round(edge.total / (Math.min(width, height) * PUFF)))
  const sizes = Array.from({ length: puffs }, (_, index) => SIZES[index % SIZES.length])
  const scale = edge.total / sizes.reduce((sum, size) => sum + size, 0)

  // Start a little way in, so no valley lands exactly on a corner.
  let distance = edge.total * 0.035
  const valleys = sizes.map((size) => {
    const point = edge.at(distance)
    distance += size * scale
    return point
  })

  let reach = 0
  let d = `M${fixed(valleys[0][0])} ${fixed(valleys[0][1])}`
  for (let index = 0; index < puffs; index += 1) {
    const from = valleys[index]
    const to = valleys[(index + 1) % puffs]
    const gap = Math.hypot(to[0] - from[0], to[1] - from[1])
    const radius = gap * SWELL
    reach = Math.max(reach, radius - Math.sqrt(radius * radius - (gap * gap) / 4))
    // Clockwise round the pill, so a clockwise arc is the one that swells outward.
    d += `A${fixed(radius)} ${fixed(radius)} 0 0 1 ${fixed(to[0])} ${fixed(to[1])}`
  }
  return { d: `${d}Z`, reach, puffs }
}
