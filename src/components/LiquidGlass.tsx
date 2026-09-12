import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import {
  displacementMapUrl,
  supportsBackdropFilterUrl,
  type GlassProfile,
} from '../lib/liquid-glass'

/**
 * Every pane of glass in the room, and the filters that bend the light through
 * them.
 *
 * A displacement map is an image of one particular size, and SVG will not
 * stretch one to fit whatever it is filtering, so a surface can only use a map
 * cut to its own dimensions. Made naively that is one map, one filter and one
 * canvas per button, and the three controls in the corner are the same button
 * three times over. So the filters live here instead: a surface asks for one
 * by its size and shape, identical surfaces are handed the same one, and they
 * are all rendered once in a single hidden svg.
 *
 * The whole thing is free to do nothing. Only Chromium honours an SVG filter
 * inside `backdrop-filter`; Safari accepts the syntax and renders nothing
 * through it, which would leave every panel in the interface a clear sheet
 * with its text over whatever is behind. Where that is the case no filter is
 * built and no style is returned, and the frosted blur in the stylesheet is
 * left to do the job it has always done.
 */

interface Filter {
  id: string
  url: string
  scale: number
  /** How many surfaces are using it; at none it is taken down. */
  holders: number
}

interface Registry {
  supported: boolean
  /** Hands back the filter for a surface of this size and shape, building it once. */
  claim: (key: string, width: number, height: number, profile: GlassProfile) => Filter | null
  /** Said when a surface stops using one, so the last one out takes it down. */
  release: (key: string) => void
}

const GlassContext = createContext<Registry | null>(null)

export function GlassFilters({ children }: { children: ReactNode }) {
  /*
   * The filters live in a ref and are mirrored into a render, rather than
   * living in state. A surface asks for its filter while it is measuring
   * itself and needs the answer there and then; a state updater is free to run
   * later, or twice, and would hand back either nothing or a second filter for
   * glass that already had one.
   */
  const store = useRef(new Map<string, Filter>())
  const [, redraw] = useState(0)
  const [supported, setSupported] = useState(false)
  const seq = useRef(0)

  // Asked after mount: it reads the user agent, and the server has no opinion
  // on what the browser can do.
  useEffect(() => setSupported(supportsBackdropFilterUrl()), [])

  const claim = useCallback<Registry['claim']>((key, width, height, profile) => {
    const existing = store.current.get(key)
    if (existing) {
      existing.holders += 1
      return existing
    }
    const map = displacementMapUrl(width, height, profile)
    if (!map) return null
    seq.current += 1
    const filter: Filter = { id: `glass-${seq.current}`, url: map.url, scale: map.scale, holders: 1 }
    store.current.set(key, filter)
    redraw((n) => n + 1)
    return filter
  }, [])

  /*
   * Counted rather than cached forever. A composer grows as it is typed into
   * and a card is resized whenever the stage opens, and each new size is a new
   * map: left alone, a long conversation accumulated twenty filters and a
   * hundred kilobytes of images for the six surfaces actually on screen. A map
   * nobody is using any more is a map worth forgetting.
   */
  const release = useCallback<Registry['release']>((key) => {
    const filter = store.current.get(key)
    if (!filter) return
    filter.holders -= 1
    if (filter.holders > 0) return
    store.current.delete(key)
    redraw((n) => n + 1)
  }, [])

  const registry = useMemo(() => ({ supported, claim, release }), [supported, claim, release])
  const filters = store.current

  return (
    <GlassContext.Provider value={registry}>
      {children}
      {filters.size ? (
        <svg className="glass-defs" aria-hidden="true" focusable="false">
          <defs>
            {[...filters.values()].map((filter) => (
              <filter
                key={filter.id}
                id={filter.id}
                // The map is in the surface's own pixels rather than a fraction
                // of them, and sRGB keeps the encoded directions from being
                // gamma-corrected into meaning a different direction.
                filterUnits="userSpaceOnUse"
                primitiveUnits="userSpaceOnUse"
                colorInterpolationFilters="sRGB"
                x="0"
                y="0"
                width="100%"
                height="100%"
              >
                <feImage href={filter.url} preserveAspectRatio="none" result="bend" />
                <feDisplacementMap
                  in="SourceGraphic"
                  in2="bend"
                  scale={filter.scale}
                  xChannelSelector="R"
                  yChannelSelector="G"
                />
              </filter>
            ))}
          </defs>
        </svg>
      ) : null}
    </GlassContext.Provider>
  )
}

/**
 * A button made of the same glass as everything else.
 *
 * The controls are the same button several times over — three in the corner,
 * one on every shelf tab — so they measure the same, ask for the same filter,
 * and are handed the one that already exists.
 */
export function GlassButton({
  glass,
  style,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { glass?: GlassOptions }) {
  const surface = useGlass(glass)
  return (
    <button
      {...rest}
      ref={surface.ref as (node: HTMLButtonElement | null) => void}
      style={{ ...style, ...surface.style }}
      data-refracting={surface.refracting ? 'true' : undefined}
    >
      {children}
    </button>
  )
}

/** Measurements this close together are the same surface, and share its map. */
const SNAP = 8

const snap = (value: number) => Math.max(SNAP, Math.round(value / SNAP) * SNAP)

/**
 * The glass a surface is made of, worked out from the surface itself.
 *
 * A bezel tuned for a card would swallow a button whole, so it is derived
 * rather than set: it follows the corner the surface already has, and is never
 * allowed past a third of its shortest side. A card comes out at the
 * thirty-four pixels it was tuned to by hand, and a round button at about
 * fourteen, without either being told.
 */
export function profileFor(width: number, height: number, radius: number, index = 1.52): GlassProfile {
  const shortest = Math.min(width, height)
  const bezel = Math.min(radius * 1.15, shortest / 3.2, 34)
  return { radius, bezel: Math.max(5, bezel), index }
}

/** The corner an element actually has, in pixels, including 50% and 999px. */
function radiusOf(element: HTMLElement, width: number, height: number): number {
  const raw = getComputedStyle(element).borderTopLeftRadius
  const shortest = Math.min(width, height)
  if (raw.endsWith('%')) return (parseFloat(raw) / 100) * shortest
  const value = parseFloat(raw)
  return Number.isFinite(value) ? Math.min(value, shortest / 2) : 0
}

export interface GlassOptions {
  /** Off while a surface is hidden, dimmed, or not worth the work. */
  enabled?: boolean
  /** How much the glass slows light. Thin controls read better a little lower. */
  index?: number
  /** What to soften the bent backdrop with afterwards, matching the surface. */
  blur?: number
  saturate?: number
}

export interface GlassSurface {
  ref: (node: HTMLElement | null) => void
  /** Spread onto the element; empty where this browser cannot refract. */
  style: { backdropFilter?: string; WebkitBackdropFilter?: string }
  /** True once the surface is genuinely bending light, for the rim to answer. */
  refracting: boolean
}

/**
 * Make one element glass.
 *
 * It measures itself, asks the registry for the filter that fits, and keeps
 * measuring: a composer grows as it is typed into, a panel opens, a card is
 * resized by the stage, and each new size is a new map. Sizes are snapped so
 * that a pixel of drift does not rebuild anything.
 */
export function useGlass({
  enabled = true,
  index = 1.52,
  blur = 14,
  saturate = 180,
}: GlassOptions = {}): GlassSurface {
  const registry = useContext(GlassContext)
  const [filter, setFilter] = useState<Filter | null>(null)
  const node = useRef<HTMLElement | null>(null)
  const key = useRef('')
  const id = useId()

  const supported = registry?.supported ?? false

  useEffect(() => {
    const element = node.current
    if (!supported || !enabled || !element || !registry) return

    const measure = () => {
      const box = element.getBoundingClientRect()
      const width = snap(box.width)
      const height = snap(box.height)
      // Too small to have an edge worth bending, or not laid out yet.
      if (width < 24 || height < 24) return
      const radius = Math.round(radiusOf(element, width, height))
      const next = `${width}x${height}r${radius}i${index}`
      if (next === key.current) return
      const previous = key.current
      key.current = next
      setFilter(registry.claim(next, width, height, profileFor(width, height, radius, index)))
      if (previous) registry.release(previous)
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (key.current) {
        registry.release(key.current)
        key.current = ''
      }
      setFilter(null)
    }
  }, [enabled, index, registry, supported, id])

  const live = supported && enabled && filter !== null
  const css = live ? `url(#${filter.id}) blur(${blur}px) saturate(${saturate}%)` : undefined

  return {
    ref: (next) => {
      node.current = next
    },
    style: css ? { backdropFilter: css, WebkitBackdropFilter: css } : {},
    refracting: live,
  }
}
