/**
 * Pictures from the web, for "show me".
 *
 * Measured on 11 September 2026. Exa reports each page's own lead picture once
 * any contents are asked for, and a query that ends in "photos" finds photo
 * pages — Unsplash, Pexels, Wikimedia — whose lead picture is the photograph
 * itself. Asking for the pages' image links was the fastest way to get that,
 * at about 0.7 seconds. Openverse, which needs no key, backs it up with openly
 * licensed photos, mostly from Flickr. Wikimedia Commons would be the obvious
 * third source, but it did not resolve from here, so nothing depends on it.
 *
 * What comes back is filtered hard, because a gallery is judged by its worst
 * tile: no site logos, icons or placeholders, nothing from stock libraries,
 * whose previews are watermarked, and never the same photograph twice.
 */

import { cleanText, hostOf, type Card, type CardPicture, type CardSource } from '../cards'
import type { EnvReader } from './research'

const EXA_URL = 'https://api.exa.ai/search'
const OPENVERSE_URL = 'https://api.openverse.org/v1/images/'
const USER_AGENT = 'GIDEON/1.0 (voice companion; pictures)'

export const MAX_PICTURES = 9
/** Fewer than this is not a gallery, it is a search that did not work. */
export const MIN_PICTURES = 3
/** With fewer than this from the web, the open library is asked as well. */
const TOP_UP_BELOW = 6
const SEARCH_TIMEOUT_MS = 6_000
const TILE_WIDTH = 720
const FULL_WIDTH = 1600

export interface ImageDeps {
  fetch: typeof fetch
  exaKey: string
}

export function imageDeps(env: EnvReader): ImageDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    exaKey: env('EXA_API_KEY') ?? '',
  }
}

/** Libraries whose previews are watermarked, and Canva, whose pages are template sales. */
const UNWANTED_HOSTS =
  /(^|\.)(istockphoto|shutterstock|gettyimages|alamy|dreamstime|123rf|depositphotos|bigstockphoto|vecteezy|agefotostock|canva)\.[a-z.]+$|(^|\.)stock\.adobe\.com$/i

/** A site's furniture rather than a picture of anything. Tested against the path only. */
const FURNITURE =
  /logo|favicon|sprite|avatar|placeholder|opengraph|\/icons?\/|icon[-_.]|blank\.|default[-_.]|share[-_]?(image|card)|social[-_]?(image|card)|badge|1x1|\.svg$|\.gif$/i

/** Photo libraries, where more than one picture from a page is still on topic. */
const PHOTO_LIBRARIES = /(^|\.)(pexels|unsplash|wikimedia|wikipedia|flickr|pixabay)\.(com|org)$/i

/**
 * A picture's tile and full-size addresses, or null for anything unusable.
 *
 * Unsplash and Pexels serve any size of a photo from one address, so their
 * sharing previews — cropped, and stamped with a logo — are traded for the
 * photograph at the size each place needs.
 */
export function pictureUrls(raw: string): { tile: string; full: string } | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null

  if (url.hostname === 'images.unsplash.com') {
    if (!url.pathname.startsWith('/photo-')) return null
    const base = `https://images.unsplash.com${url.pathname}`
    return {
      tile: `${base}?w=${TILE_WIDTH}&q=80&auto=format&fit=max`,
      full: `${base}?w=${FULL_WIDTH}&q=85&auto=format&fit=max`,
    }
  }
  if (url.hostname === 'images.pexels.com') {
    if (!url.pathname.startsWith('/photos/')) return null
    const base = `https://images.pexels.com${url.pathname}`
    return {
      tile: `${base}?auto=compress&cs=tinysrgb&w=${TILE_WIDTH}`,
      full: `${base}?auto=compress&cs=tinysrgb&w=${FULL_WIDTH}`,
    }
  }
  if (UNWANTED_HOSTS.test(url.hostname) || FURNITURE.test(url.pathname)) return null
  return { tile: url.toString(), full: url.toString() }
}

/** One photograph at any size is one photograph. */
function sameness(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}`.toLowerCase()
  } catch {
    return url
  }
}

interface ExaHit {
  title?: string
  url?: string
  image?: string
  extras?: { imageLinks?: string[] }
}

async function webPictures(query: string, deps: ImageDeps, signal: AbortSignal): Promise<CardPicture[]> {
  const response = await deps.fetch(EXA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': deps.exaKey },
    body: JSON.stringify({
      query: `${query} photos`,
      type: 'auto',
      numResults: 12,
      contents: { extras: { imageLinks: 4 } },
    }),
    signal,
  })
  if (!response.ok) {
    void response.body?.cancel()
    return []
  }
  const body = (await response.json()) as { results?: ExaHit[] }

  // Each page's lead picture first, so the gallery is many pages deep before
  // it is two pictures deep; then more from photo libraries only, where the
  // rest of a page is still pictures of the same thing.
  const leads: CardPicture[] = []
  const more: CardPicture[] = []
  for (const hit of body.results ?? []) {
    const page = (hit.url ?? '').trim()
    const host = hostOf(page)
    if (!/^https?:\/\//.test(page) || !host || UNWANTED_HOSTS.test(host)) continue
    const alt = cleanText(hit.title, 120) || host
    let led = false
    for (const candidate of [hit.image, ...(hit.extras?.imageLinks ?? [])]) {
      if (typeof candidate !== 'string') continue
      const urls = pictureUrls(candidate)
      if (!urls) continue
      const picture = { url: urls.full, thumb: urls.tile, alt, pageUrl: page, host }
      if (!led) {
        leads.push(picture)
        led = true
      } else if (PHOTO_LIBRARIES.test(host)) {
        more.push(picture)
      }
    }
  }
  return [...leads, ...more]
}

interface OpenverseHit {
  title?: string
  url?: string
  thumbnail?: string
  foreign_landing_url?: string
  provider?: string
}

async function openPictures(query: string, deps: ImageDeps, signal: AbortSignal): Promise<CardPicture[]> {
  const params = new URLSearchParams({ q: query, page_size: '12', mature: 'false' })
  const response = await deps.fetch(`${OPENVERSE_URL}?${params}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal,
  })
  if (!response.ok) {
    void response.body?.cancel()
    return []
  }
  const body = (await response.json()) as { results?: OpenverseHit[] }
  return (body.results ?? []).flatMap((hit): CardPicture[] => {
    const thumb = hit.thumbnail ?? ''
    if (!thumb.startsWith('https://')) return []
    const page = /^https?:\/\//.test(hit.foreign_landing_url ?? '') ? hit.foreign_landing_url! : thumb
    return [
      {
        url: (hit.url ?? '').startsWith('https://') ? hit.url! : thumb,
        thumb,
        alt: cleanText(hit.title, 120) || query,
        pageUrl: page,
        host: hostOf(page) || hit.provider || 'openverse.org',
      },
    ]
  })
}

/**
 * Up to nine pictures of `query`, or fewer, possibly none.
 *
 * Never rejects: a search that fails is simply one that found nothing, and the
 * speaking model is told so rather than the turn failing.
 */
export async function findPictures(
  query: string,
  deps: ImageDeps,
  signal: AbortSignal,
): Promise<CardPicture[]> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])
  const seen = new Set<string>()
  const kept: CardPicture[] = []
  const add = (pictures: CardPicture[]) => {
    for (const picture of pictures) {
      if (kept.length === MAX_PICTURES) return
      const key = sameness(picture.thumb)
      if (seen.has(key)) continue
      seen.add(key)
      kept.push(picture)
    }
  }

  if (deps.exaKey) add(await webPictures(query, deps, bounded).catch(() => []))
  if (kept.length < TOP_UP_BELOW && !signal.aborted) {
    add(await openPictures(query, deps, bounded).catch(() => []))
  }
  return kept
}

/** The card a set of pictures is shown on. */
export function galleryCard(query: string, pictures: CardPicture[]): Card {
  const title = cleanText(query, 64)
  const sources: CardSource[] = []
  for (const picture of pictures) {
    if (sources.some((source) => source.host === picture.host)) continue
    sources.push({ title: picture.alt, url: picture.pageUrl, host: picture.host })
    if (sources.length === 4) break
  }
  return {
    kind: 'gallery',
    query: cleanText(query, 200),
    title: title.charAt(0).toUpperCase() + title.slice(1),
    subtitle: `${pictures.length} pictures from the web`,
    summary: '',
    figure: null,
    kicker: '',
    facts: [],
    image: null,
    pictures,
    sources,
  }
}
