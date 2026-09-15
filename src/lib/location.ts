/**
 * Where the user roughly is, for "the weather here".
 *
 * Coarse, and never asked for: Cloudflare looks up the city a request comes
 * from, and the Worker hands that to the conversation, so the one question that
 * needs a place and does not name one can be answered without a permission
 * prompt. It is a city and its coordinates to two decimal places, about a
 * kilometre, which is as close as an address lookup gets anyway. It is used for
 * the forecast of a turn that named no place and is never stored.
 *
 * A lookup by address can be wrong (a VPN, a mobile network's exit in another
 * city), so whatever uses it says which place it used. It can also be missing:
 * Cloudflare names no city for many networks. Then a tool that needs the place
 * asks the browser instead, which asks the user once whether to say.
 */

export interface CoarseLocation {
  city: string
  region: string
  country: string
  latitude: number
  longitude: number
  timezone: string
  /** Where it came from: the connection's address, or the user's own device, which is far surer. */
  from?: 'network' | 'device'
}

/** "Lisbon, Portugal" rather than "Lisbon, Lisbon, Portugal", when a city and its region share a name. */
export function nameOf(location: CoarseLocation): string {
  return [...new Set([location.city, location.region, location.country].filter(Boolean))].join(', ')
}

/** How a brief names where a forecast or a route starting "here" is for, with the doubt it deserves. */
export function whereWords(location: CoarseLocation): string {
  const named = nameOf(location)
  return location.from === 'device'
    ? `where the user's device places them: ${named}`
    : `where the user's connection places them, roughly: ${named}. Say which place it is, in case that is wrong`
}

/** The position in a browser's answer to `get_location`, or null when it gave none. */
export function positionIn(text: string): { latitude: number; longitude: number } | null {
  const match = /(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/.exec(text)
  if (!match) return null
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude: round(latitude), longitude: round(longitude) }
}

/**
 * The header a Worker carries the location in when it hands a socket to a
 * Durable Object. The Worker removes any a client sent before setting its own,
 * so the object can believe it.
 */
export const LOCATION_HEADER = 'x-gideon-location'

const round = (value: number) => Math.round(value * 100) / 100
const clip = (value: unknown, limit: number) => (typeof value === 'string' ? value.trim().slice(0, limit) : '')

/** A country's English name from its ISO code, or nothing for Cloudflare's codes for unknown and Tor. */
function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return ''
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

/** A location read back from anything, or null when it is not a whole one. */
export function readLocation(value: unknown): CoarseLocation | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const latitude = Number(input.latitude)
  const longitude = Number(input.longitude)
  const city = clip(input.city, 80)
  if (!city || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return {
    city,
    region: clip(input.region, 80),
    country: clip(input.country, 80),
    latitude: round(latitude),
    longitude: round(longitude),
    timezone: clip(input.timezone, 64) || 'UTC',
  }
}

/**
 * The location Cloudflare gives a request (`request.cf`), or null outside
 * Cloudflare. Without a city its region stands in, a province's worth of
 * doubt that the brief names; without either there is nothing worth a forecast.
 */
export function locationFromCf(cf: unknown): CoarseLocation | null {
  if (!cf || typeof cf !== 'object') return null
  const input = cf as Record<string, unknown>
  const located = readLocation({ ...input, city: clip(input.city, 80) || clip(input.region, 80), country: countryName(clip(input.country, 2).toUpperCase()) })
  return located ? { ...located, from: 'network' } : null
}

export function encodeLocation(location: CoarseLocation): string {
  // A header carries Latin-1 at most, and a city can be Zürich.
  return encodeURIComponent(JSON.stringify(location))
}

export function decodeLocation(header: string | null): CoarseLocation | null {
  if (!header) return null
  try {
    return readLocation(JSON.parse(decodeURIComponent(header)))
  } catch {
    return null
  }
}

/** The request as a Durable Object should see it: with the edge's location, and never a client's. */
export function withLocation(request: Request, cf: unknown): Request {
  const headers = new Headers(request.headers)
  headers.delete(LOCATION_HEADER)
  const location = locationFromCf(cf)
  if (location) headers.set(LOCATION_HEADER, encodeLocation(location))
  return new Request(request, { headers })
}
