import { useEffect, useRef, useState } from 'react'
import type { LngLat, MapBlock } from '../../../lib/cards/schema'
import { rise } from '../stagger'

/**
 * A map on a card: a picture of it at once, and the live map over the picture
 * on the card in front, when the browser can draw one.
 *
 * The picture is Mapbox's own static image of the same view, so a card behind
 * the front one, a phone without WebGL, and the moment before the live map has
 * loaded all show the same place the same way. Only the front card gets a live
 * map: each holds a WebGL context, and a browser allows only a few.
 *
 * Mapbox GL is loaded from Mapbox's CDN the first time a map is in front,
 * rather than bundled, so a conversation that never asks where anything is
 * never downloads it.
 */

const VERSION = '3.30.0'
const BASE = `https://api.mapbox.com/mapbox-gl-js/v${VERSION}`
/** How long the library gets to arrive before the picture is left to stand alone. */
const LOAD_WAIT_MS = 12_000

interface LiveMap {
  on(event: string, listener: () => void): void
  addSource(id: string, source: Record<string, unknown>): void
  addLayer(layer: Record<string, unknown>): void
  remove(): void
}

interface Marker {
  setLngLat(at: LngLat): Marker
  addTo(map: LiveMap): Marker
}

interface MapboxGl {
  Map: new (options: Record<string, unknown>) => LiveMap
  Marker: new (options: { element: HTMLElement; anchor?: string }) => Marker
  supported?: () => boolean
}

let loading: Promise<MapboxGl | null> | null = null

/** Mapbox GL, once, or null when it cannot be had: no browser, no network, or too slow. */
export function loadMapbox(): Promise<MapboxGl | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(null)
  const ready = (window as { mapboxgl?: MapboxGl }).mapboxgl
  if (ready) return Promise.resolve(ready)
  loading ??= new Promise<MapboxGl | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (library: MapboxGl | null) => {
      clearTimeout(timer)
      // A failed load may be tried again by the next map.
      if (!library) loading = null
      resolve(library)
    }
    timer = setTimeout(() => done(null), LOAD_WAIT_MS)
    if (!document.querySelector(`link[href="${BASE}/mapbox-gl.css"]`)) {
      const sheet = document.createElement('link')
      sheet.rel = 'stylesheet'
      sheet.href = `${BASE}/mapbox-gl.css`
      document.head.appendChild(sheet)
    }
    const script = document.createElement('script')
    script.src = `${BASE}/mapbox-gl.js`
    script.async = true
    script.onload = () => done((window as { mapboxgl?: MapboxGl }).mapboxgl ?? null)
    script.onerror = () => done(null)
    document.head.appendChild(script)
  })
  return loading
}

const letter = (index: number) => String.fromCharCode(65 + index)

function describe(block: MapBlock): string {
  const names = block.pins.map((pin) => pin.label)
  if (block.view === 'route' && names.length === 2) return `Map of the way from ${names[0]} to ${names[1]}`
  return `Map of ${names.join(', ') || 'a place'}`
}

export function MapView({ block, start, front, said }: { block: MapBlock; start: number; front: boolean; said?: Set<string> }) {
  const holder = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState(false)
  const [failed, setFailed] = useState(false)
  const picture = useRef<HTMLImageElement>(null)
  const lettered = block.pins.length > 1
  // A new view is a new map; the same view arriving again in a patch is not.
  const view = JSON.stringify([block.center, block.zoom, block.bounds, block.pins, block.line?.length ?? 0, block.token])

  useEffect(() => {
    const container = holder.current
    if (!front || !container) return
    let map: LiveMap | null = null
    let gone = false
    void loadMapbox().then((gl) => {
      if (gone || !gl || (gl.supported && !gl.supported())) return
      const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      map = new gl.Map({
        container,
        accessToken: block.token,
        style: 'mapbox://styles/mapbox/standard',
        // Night, and without colour, so the map sits in the card rather than shouting over it.
        config: { basemap: { lightPreset: 'night', theme: 'monochrome', showPointOfInterestLabels: false } },
        center: block.center,
        zoom: block.zoom,
        ...(block.bounds ? { bounds: block.bounds, fitBoundsOptions: { padding: 36 } } : {}),
        // A scroll through the card scrolls the card; panning the map takes two fingers or a modifier key.
        cooperativeGestures: true,
        dragRotate: false,
        pitchWithRotate: false,
        fadeDuration: calm ? 0 : 300,
      })
      const drawn = map
      block.pins.forEach((pin, index) => {
        const element = document.createElement('div')
        element.className = 'map-pin'
        element.dataset.pin = pin.id
        const dot = document.createElement('span')
        dot.className = 'map-pin-dot'
        if (lettered) dot.textContent = letter(index)
        element.appendChild(dot)
        element.setAttribute('aria-hidden', 'true')
        new gl.Marker({ element }).setLngLat(pin.at).addTo(drawn)
      })
      drawn.on('load', () => {
        if (gone) return
        if (block.line && block.line.length >= 2) {
          drawn.addSource('route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: block.line } } })
          const layout = { 'line-join': 'round', 'line-cap': 'round' }
          drawn.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout, paint: { 'line-color': '#05070b', 'line-width': 8, 'line-opacity': 0.7, 'line-emissive-strength': 1 } })
          drawn.addLayer({ id: 'route-line', type: 'line', source: 'route', layout, paint: { 'line-color': '#bfe9ff', 'line-width': 4, 'line-emissive-strength': 1 } })
        }
        setLive(true)
      })
    })
    return () => {
      gone = true
      map?.remove()
      setLive(false)
    }
    // The view stands for every part of the block the map is drawn from.
  }, [front, view])

  // A picture that failed before the page was hydrated has already fired the error nobody was listening for.
  useEffect(() => {
    const image = picture.current
    if (image?.complete && !image.naturalWidth) setFailed(true)
  }, [block.still])

  // The markers belong to Mapbox, not React, so what has been said is marked on them by hand.
  useEffect(() => {
    holder.current?.querySelectorAll<HTMLElement>('.map-pin').forEach((element) => {
      if (said?.has(element.dataset.pin ?? '')) element.dataset.said = 'true'
      else delete element.dataset.said
    })
  })

  return (
    <figure className="card-map" style={rise(start)} data-live={live ? 'true' : undefined}>
      <div className="card-map-frame" role="img" aria-label={describe(block)}>
        {!failed ? (
          <img ref={picture} className="card-map-still" src={block.still} alt="" decoding="async" onError={() => setFailed(true)} />
        ) : null}
        <div className="card-map-live" ref={holder} aria-hidden="true" />
      </div>
      {lettered ? (
        <figcaption>
          <ol className="card-map-pins">
            {block.pins.map((pin, index) => (
              <li key={pin.id} data-said={said?.has(pin.id) ? 'true' : undefined}>
                <b aria-hidden="true">{letter(index)}</b>
                {pin.label}
              </li>
            ))}
          </ol>
        </figcaption>
      ) : null}
    </figure>
  )
}
