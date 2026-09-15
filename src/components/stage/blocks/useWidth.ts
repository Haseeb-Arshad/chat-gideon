import { useLayoutEffect, useRef, useState } from 'react'

/**
 * The width a drawing has to fit, in pixels, or null before it is known.
 *
 * Read after every render, before the paint, and whenever an observer says
 * the element changed size. The reads cannot be left to the observer: a page
 * that is not visible (a background tab, a hidden pane) runs no rendering
 * steps, so the observer never reports, and a drawing made at one size would
 * stay at it after its card had grown or shrunk. A read that finds the same
 * width, give or take a pixel, changes nothing and renders nothing. Measure an
 * element that is always there, rather than one that is swapped out.
 */
export function useWidth(fallback: number) {
  const ref = useRef<HTMLElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const settle = useRef((next: number) => {
    const rounded = Math.round(next)
    if (rounded > 0) setWidth((current) => (current !== null && Math.abs(current - rounded) < 2 ? current : rounded))
  }).current

  useLayoutEffect(() => {
    // Nothing laid out yet (no layout engine at all, or an element not yet
    // displayed) measures zero; the drawing uses a likely width until there is
    // something to measure.
    const node = ref.current
    if (node) settle(node.clientWidth || fallback)
  })

  useLayoutEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => settle(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [settle])

  return [ref, width] as const
}
