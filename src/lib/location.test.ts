import { describe, expect, it } from 'vitest'
import { LOCATION_HEADER, decodeLocation, encodeLocation, locationFromCf, readLocation, withLocation } from './location'

/**
 * Where the user roughly is. What matters: it is coarse, it is whole or
 * nothing, and a client cannot claim to be somewhere by sending a header.
 */

/** Cloudflare's `request.cf`, as a Worker sees it, for a request from Lisbon. */
const cf = {
  city: 'Lisbon',
  region: 'Lisbon',
  country: 'PT',
  latitude: '38.71667',
  longitude: '-9.13333',
  timezone: 'Europe/Lisbon',
  postalCode: '1100-000',
  asOrganization: 'Example Telecom',
}

describe('the location a request comes from', () => {
  it('keeps the city, its country by name, coordinates to a kilometre and the timezone, and nothing else', () => {
    expect(locationFromCf(cf)).toEqual({ city: 'Lisbon', region: 'Lisbon', country: 'Portugal', latitude: 38.72, longitude: -9.13, timezone: 'Europe/Lisbon' })
  })

  it('is no location without a city or real coordinates, or outside Cloudflare', () => {
    expect(locationFromCf({ ...cf, city: '' })).toBeNull()
    expect(locationFromCf({ ...cf, latitude: 'north' })).toBeNull()
    expect(locationFromCf({ ...cf, longitude: '200' })).toBeNull()
    expect(locationFromCf(undefined)).toBeNull()
    // Cloudflare's code for a Tor exit names no country.
    expect(locationFromCf({ ...cf, country: 'T1' })?.country).toBe('')
  })
})

describe('carrying it to the session', () => {
  it('survives the header, accents and all, and a tampered header reads as none', () => {
    const zurich = readLocation({ city: 'Zürich', region: 'Zurich', country: 'Switzerland', latitude: 47.3769, longitude: 8.5417, timezone: 'Europe/Zurich' })!
    expect(decodeLocation(encodeLocation(zurich))).toEqual({ ...zurich, latitude: 47.38, longitude: 8.54 })
    expect(decodeLocation('%7Bnot json')).toBeNull()
    expect(decodeLocation(encodeURIComponent(JSON.stringify({ city: 'Lisbon' })))).toBeNull()
    expect(decodeLocation(null)).toBeNull()
  })

  it("replaces whatever location a client sent with the edge's own, and sends none when the edge has none", () => {
    const forged = encodeLocation({ city: 'Nowhere', region: '', country: '', latitude: 0, longitude: 0, timezone: 'UTC' })
    const request = new Request('https://example.com/realtime', { headers: { Upgrade: 'websocket', [LOCATION_HEADER]: forged } })

    const forwarded = withLocation(request, cf)
    expect(decodeLocation(forwarded.headers.get(LOCATION_HEADER))?.city).toBe('Lisbon')
    expect(forwarded.headers.get('Upgrade')).toBe('websocket')

    expect(withLocation(request, undefined).headers.get(LOCATION_HEADER)).toBeNull()
  })
})
