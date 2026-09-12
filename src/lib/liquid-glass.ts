/**
 * Glass that bends the room behind it.
 *
 * A blur alone is frosted plastic. Real glass has a thickness, and near its
 * edge that thickness is curved, so light passing through is bent before it
 * reaches your eye: the wall behind the card appears to squeeze and slide as
 * it approaches the rim, and the rim itself carries a bright compressed strip
 * of whatever is behind it. That bending is the whole effect, and a blur
 * cannot fake it because it destroys the detail the bending is visible in.
 *
 * The bend is computed here rather than drawn. For every pixel of a pane, the
 * distance to the nearest edge says how far up the curved bezel it sits, the
 * slope there gives the surface normal, Snell's law turns that normal into a
 * refracted ray, and the ray's sideways travel through the glass is how far
 * the backdrop appears to move. Those offsets are written into an image — red
 * carries the sideways shift, green the vertical one — which SVG's
 * feDisplacementMap then applies to the backdrop itself.
 *
 * Nothing here touches the DOM, so the arithmetic can be tested on its own.
 * The parts that need a canvas or a browser live at the bottom and are the
 * only parts that cannot.
 *
 * The method is from Artur Bień's write-up on building Apple's liquid glass
 * with CSS and SVG (kube.io/blog/liquid-glass-css-svg), adapted from circles
 * to the rounded rectangles a card is actually shaped like.
 */

export interface GlassProfile {
  /** Corner radius of the pane, so the bezel follows its shape. */
  radius: number
  /**
   * How far in from the edge the glass is still curved. Past this it is flat,
   * and flat glass bends nothing: the middle of a card stays honest and only
   * its rim distorts, which is what makes the shape read as thick.
   */
  bezel: number
  /**
   * How much the glass slows light. 1 is air and does nothing; 1.5 is window
   * glass. Above about 1.8 the rim stops looking like glass and starts
   * looking like a bug.
   */
  index: number
}

/**
 * The glass a card is made of. The radius is the pane's own, so the bezel
 * follows the corners it actually has.
 *
 * Tuned against a striped test pattern behind a real card, because the effect
 * is invisible over a plain wall and its strength cannot be judged there. At
 * a 22-pixel bezel the bending was real but too polite to notice at a glance;
 * 34 puts the peak shift near fifteen pixels and leaves a band about eleven
 * wide, which reads as a thick pane rather than a drawn outline. Past about
 * fifty the rim starts to smear and the card looks broken rather than solid.
 */
export const DEFAULT_PROFILE: GlassProfile = { radius: 30, bezel: 34, index: 1.52 }

/**
 * How tall the glass is, across its bezel, as a fraction of full thickness.
 *
 * `t` runs from 0 at the outer edge to 1 where the bezel meets the flat top.
 * A quarter circle would do, and looks like a bevel someone applied. The
 * fourth-power squircle is the one Apple's glass uses: it leaves the edge
 * steeply and flattens early, so the distortion is concentrated in a narrow
 * bright band at the rim instead of smeared across the whole border.
 */
export function squircleHeight(t: number): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  const u = 1 - t
  return Math.pow(1 - u * u * u * u, 0.25)
}

/**
 * The slope of that surface, found by measuring it rather than differentiating
 * it. The profile's derivative is unbounded at the very edge — the glass
 * leaves the rim vertically — and a formula returns infinity there while a
 * difference over a small step returns something large and usable.
 */
export function surfaceSlope(t: number, step = 0.001): number {
  const low = squircleHeight(Math.max(0, t - step))
  const high = squircleHeight(Math.min(1, t + step))
  const span = Math.min(1, t + step) - Math.max(0, t - step)
  return span > 0 ? (high - low) / span : 0
}

/**
 * How far the backdrop appears to shift, in pixels, at a point on the bezel.
 *
 * A ray arrives perpendicular to the wall behind the card. It meets the
 * curved top, where the surface normal is tilted by the slope, and Snell's law
 * bends it by the difference between the angle it arrived at and the angle it
 * continues at. It then crosses the thickness of glass beneath that point, and
 * the sideways distance it covers on the way is how far the wall behind
 * appears to move. Thickness is what makes the edge quiet and the middle of
 * the bezel loud: at the rim the glass is steep but paper-thin, so a sharply
 * bent ray has no room to travel.
 */
export function refractionShift(t: number, profile: GlassProfile): number {
  if (t <= 0 || t >= 1) return 0
  const slope = surfaceSlope(t)
  // The normal leans away from vertical by exactly the surface's own angle, so
  // a ray falling straight down meets it at that same angle.
  const incidence = Math.atan(slope)
  const refracted = Math.asin(Math.min(1, Math.sin(incidence) / profile.index))
  const thickness = squircleHeight(t) * profile.bezel
  return Math.tan(incidence - refracted) * thickness
}

/**
 * Distance from a point to the edge of a rounded rectangle, negative inside.
 *
 * The standard trick: fold the point into one quadrant, pull the box in by its
 * corner radius, and measure to that smaller box. Along the straight sides the
 * answer is the distance to the side; around a corner it becomes the distance
 * to the corner's arc, which is what keeps the bezel an even width all the way
 * round instead of pooling in the corners.
 */
export function edgeDistance(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): number {
  const halfWidth = width / 2
  const halfHeight = height / 2
  const limit = Math.min(radius, halfWidth, halfHeight)
  const dx = Math.abs(x - halfWidth) - (halfWidth - limit)
  const dy = Math.abs(y - halfHeight) - (halfHeight - limit)
  const outsideX = Math.max(dx, 0)
  const outsideY = Math.max(dy, 0)
  const outside = Math.hypot(outsideX, outsideY)
  const inside = Math.min(Math.max(dx, dy), 0)
  return outside + inside - limit
}

export interface DisplacementField {
  /** RGBA bytes, red carrying the sideways shift and green the vertical one. */
  data: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
  /**
   * The largest shift in the field, in pixels. The image can only hold a
   * direction and a fraction, so the size goes here and comes back as the
   * filter's `scale`.
   */
  scale: number
}

/** Neutral: the byte that means "do not move this pixel at all". */
const NEUTRAL = 128

/**
 * The whole field, as an image the browser can displace a backdrop with.
 *
 * Two passes, because a byte can only hold a fraction of something. The first
 * works out where every pixel's backdrop should come from and how far the
 * furthest of them travels; the second writes each one as a fraction of that
 * distance, which is what the filter's `scale` multiplies back out.
 */
export function displacementField(
  width: number,
  height: number,
  profile: GlassProfile = DEFAULT_PROFILE,
): DisplacementField {
  const count = width * height
  const shiftX = new Float32Array(count)
  const shiftY = new Float32Array(count)
  let scale = 0

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Sampled at the middle of the pixel: on the edge itself the distance is
      // zero and the direction it points is undefined.
      const distance = edgeDistance(x + 0.5, y + 0.5, width, height, profile.radius)
      // Outside the pane there is no glass, and past the bezel it is flat.
      if (distance >= 0 || distance <= -profile.bezel) continue

      const depth = -distance / profile.bezel
      const shift = refractionShift(depth, profile)
      if (shift === 0) continue

      // Which way is "out" from here: the direction the distance grows in,
      // measured the same way the slope was, since the shape has corners and
      // an analytic gradient would have to special-case each of them.
      const step = 0.5
      const gradientX =
        edgeDistance(x + 0.5 + step, y + 0.5, width, height, profile.radius) -
        edgeDistance(x + 0.5 - step, y + 0.5, width, height, profile.radius)
      const gradientY =
        edgeDistance(x + 0.5, y + 0.5 + step, width, height, profile.radius) -
        edgeDistance(x + 0.5, y + 0.5 - step, width, height, profile.radius)
      const length = Math.hypot(gradientX, gradientY)
      if (length === 0) continue

      // Outward: the backdrop is gathered from beyond the rim and pulled in,
      // which is what compresses the room into a bright strip at the edge.
      const index = y * width + x
      shiftX[index] = (gradientX / length) * shift
      shiftY[index] = (gradientY / length) * shift
      const magnitude = Math.abs(shift)
      if (magnitude > scale) scale = magnitude
    }
  }

  const data = new Uint8ClampedArray(new ArrayBuffer(count * 4))
  for (let index = 0; index < count; index += 1) {
    const at = index * 4
    data[at] = scale > 0 ? NEUTRAL + (shiftX[index] / scale) * 127 : NEUTRAL
    data[at + 1] = scale > 0 ? NEUTRAL + (shiftY[index] / scale) * 127 : NEUTRAL
    data[at + 2] = NEUTRAL
    data[at + 3] = 255
  }

  return { data, width, height, scale }
}

/**
 * The size the field is actually computed at.
 *
 * The field is smooth, so it survives being computed small and stretched back
 * up, and a card is large enough that computing it pixel for pixel is a
 * visible pause every time the stage opens. The bezel and the radius shrink
 * with it so the shape stays the shape.
 */
export const MAX_FIELD_SIDE = 420

export function fieldScale(width: number, height: number): number {
  const longest = Math.max(width, height)
  return longest > MAX_FIELD_SIDE ? MAX_FIELD_SIDE / longest : 1
}

/**
 * A displacement map for a pane of this size, as a data URL.
 *
 * Browser only: it needs a canvas to turn the bytes into a PNG. Returns null
 * where there is no canvas to be had, which is every server-rendered pass, and
 * the glass falls back to the plain blur it has always had.
 */
export function displacementMapUrl(
  width: number,
  height: number,
  profile: GlassProfile = DEFAULT_PROFILE,
): { url: string; scale: number } | null {
  if (typeof document === 'undefined' || width < 8 || height < 8) return null

  const ratio = fieldScale(width, height)
  const mapWidth = Math.max(8, Math.round(width * ratio))
  const mapHeight = Math.max(8, Math.round(height * ratio))
  const field = displacementField(mapWidth, mapHeight, {
    radius: profile.radius * ratio,
    bezel: profile.bezel * ratio,
    index: profile.index,
  })

  const canvas = document.createElement('canvas')
  canvas.width = mapWidth
  canvas.height = mapHeight
  const context = canvas.getContext('2d')
  if (!context) return null
  context.putImageData(new ImageData(field.data, mapWidth, mapHeight), 0, 0)

  // Back to the pane's own pixels: the map was computed small, so a shift of
  // one of its pixels is worth more than one of the card's.
  return { url: canvas.toDataURL(), scale: field.scale / ratio }
}

/**
 * Whether this browser can refract a backdrop at all.
 *
 * An SVG filter in `backdrop-filter` is Chrome's alone for now. Safari and
 * Firefox parse the property and quietly render nothing through it, which
 * would leave the cards as clear panes with no blur, so they are asked first
 * and given the frosted glass they already had.
 */
export function supportsBackdropFilterUrl(): boolean {
  if (typeof CSS === 'undefined' || !CSS.supports) return false
  if (!CSS.supports('backdrop-filter', 'url(#f)')) return false
  /*
   * Asking is not enough: Safari says yes to the syntax and then renders a
   * backdrop of nothing through it, which would leave a card as a clear sheet
   * with its text over whatever is behind. Chromium is the only engine that
   * both claims this and means it, and its user agent is the only way to tell,
   * so this is a sniff on purpose. Every other engine keeps the frosted blur.
   */
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return /Chrome\/|Chromium\/|Edg\//.test(agent)
}
