/**
 * The face looking at what it is talking about.
 *
 * When something on the card in front lights up because GIDEON has just said
 * it, the stage announces where it is on the screen, and the face, docked in
 * its corner, glances there for a moment before settling back on the card. An
 * event rather than a prop, because the stage and the face are far apart in
 * the page and a glance is a moment, not state either of them keeps.
 */

export const GLANCE_EVENT = 'gideon:glance'

export interface Glance {
  /** Where to look, in viewport pixels. */
  x: number
  y: number
}

export function glanceAt(element: Element) {
  const box = element.getBoundingClientRect()
  if (!box.width && !box.height) return
  window.dispatchEvent(new CustomEvent<Glance>(GLANCE_EVENT, { detail: { x: box.left + box.width / 2, y: box.top + box.height / 2 } }))
}

/**
 * Where to look, in the eyes' gaze space, from a face at `face` to a point.
 * The divisors are chosen so that a card in the middle of a wide screen, seen
 * from the corner, lands where the docked face already looks at cards.
 */
export function gazeToward(face: DOMRect, point: Glance, viewport: { width: number; height: number }) {
  const clamp = (value: number) => Math.max(-1.2, Math.min(1.2, value))
  return {
    x: clamp((point.x - (face.left + face.width / 2)) / (viewport.width * 0.55)),
    y: clamp((point.y - (face.top + face.height / 2)) / (viewport.height * 0.9)),
  }
}
