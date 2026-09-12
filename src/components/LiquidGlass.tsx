import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import {
  DEFAULT_PROFILE,
  displacementMapUrl,
  supportsBackdropFilterUrl,
  type GlassProfile,
} from '../lib/liquid-glass'

/**
 * The filter that makes a pane behave like glass rather than like frost.
 *
 * A displacement map is an image of a particular size, and SVG will not resize
 * one to suit the thing it is filtering, so every pane needs its own map cut
 * to its own dimensions and cut again whenever it changes. That is the whole
 * reason this is a hook and not a line of CSS.
 *
 * It is deliberately free to do nothing. Only Chromium honours an SVG filter
 * inside `backdrop-filter`; everywhere else the property parses, renders
 * nothing through it, and would leave a card as a clear sheet with its text
 * unreadable over whatever is behind. Where that is the case no filter is
 * built and no id is returned, and the plain frosted blur in the stylesheet is
 * left to do the job it has always done.
 */

/** Measurements this close together are the same pane, and reuse its map. */
const SNAP = 12

const snap = (value: number) => Math.round(value / SNAP) * SNAP

export interface LiquidGlass {
  /** The element to measure: the glass itself. */
  ref: (node: HTMLElement | null) => void
  /** The filter markup to render, or null when this browser cannot refract. */
  defs: ReactElement | null
  /**
   * What to put in `backdrop-filter`, or undefined to leave the stylesheet's
   * own blur alone.
   */
  backdropFilter: string | undefined
}

export function useLiquidGlass(
  enabled: boolean,
  profile: GlassProfile = DEFAULT_PROFILE,
): LiquidGlass {
  const id = useId().replace(/[^a-zA-Z0-9-]/g, '')
  const [map, setMap] = useState<{ url: string; scale: number } | null>(null)
  const [supported, setSupported] = useState(false)
  /**
   * How much of the bend is in force. Ramped from nothing the first time a
   * pane gets its map, so the glass thickens as the card arrives rather than
   * snapping into focus fully formed. The article this is built from notes
   * that `scale` is the one thing that can be animated without rebuilding the
   * map, which is exactly why the arrival is animated through it and nothing
   * else is animated at all.
   */
  const [depth, setDepth] = useState(0)
  const node = useRef<HTMLElement | null>(null)
  const size = useRef('')
  const arrived = useRef(false)

  // Asked once, after mount, because it reads the user agent and the server
  // has no opinion on what the browser can do.
  useEffect(() => setSupported(supportsBackdropFilterUrl()), [])

  useEffect(() => {
    const element = node.current
    if (!supported || !enabled || !element) return

    const measure = () => {
      const box = element.getBoundingClientRect()
      const width = snap(box.width)
      const height = snap(box.height)
      if (width < 40 || height < 40) return
      const key = `${width}x${height}`
      if (key === size.current) return
      size.current = key
      setMap(displacementMapUrl(width, height, profile))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [enabled, profile, supported])

  useEffect(() => {
    if (!map) return
    // Only the first map a pane is given is worth arriving; the rest are the
    // same glass measured again after a resize, and should not re-form.
    if (arrived.current) {
      setDepth(1)
      return
    }
    arrived.current = true

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setDepth(1)
      return
    }

    let frame = 0
    const started = performance.now()
    const span = 620
    const step = () => {
      const t = Math.min(1, (performance.now() - started) / span)
      // Out, not in-out: the glass gathers quickly and settles, which is how
      // the rest of the card arrives.
      setDepth(1 - Math.pow(1 - t, 3))
      if (t < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    /*
     * A card in a window nobody is looking at is never painted, and a frame
     * that is never painted never arrives: the ramp would sit at nothing and
     * the glass would still be flat when the window came forward. The arrival
     * is worth animating, but it is not worth the effect existing only for
     * people who watched it happen.
     */
    const settled = setTimeout(() => setDepth(1), span + 160)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(settled)
    }
  }, [map])

  const live = supported && enabled && map !== null

  return {
    ref: (next) => {
      node.current = next
    },
    defs: live ? (
      <svg className="glass-defs" aria-hidden="true" focusable="false">
        <filter
          id={id}
          // The map is in the pane's own pixels, not a fraction of them, and
          // sRGB keeps the encoded directions from being gamma-corrected into
          // something that means a different direction.
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
          x="0"
          y="0"
          width="100%"
          height="100%"
        >
          <feImage href={map.url} preserveAspectRatio="none" result="bend" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="bend"
            scale={map.scale * depth}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>
    ) : null,
    // Bent first and softened after: blurring before the bend would leave
    // nothing sharp enough for the bend to be visible in.
    backdropFilter: live ? `url(#${id}) blur(14px) saturate(180%)` : undefined,
  }
}
