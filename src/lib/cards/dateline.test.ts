import { describe, expect, it } from 'vitest'
import { mastheadDate, whenPublished } from './dateline'

/**
 * Datelines against a fixed clock, in named timezones, because "yesterday" is
 * not the same day in London as in New York, and the tests may run anywhere.
 */

const HOUR = 3_600_000
// Monday 14 September 2026: 18:30 in London, 13:30 in New York, 02:30 on Tuesday in Tokyo.
const NOW = Date.UTC(2026, 8, 14, 17, 30)
const london = { now: NOW, timeZone: 'Europe/London' }

describe('whenPublished', () => {
  it('counts minutes, then hours, through the last day', () => {
    expect(whenPublished('2026-09-14T17:29:40Z', london)).toBe('Just now')
    expect(whenPublished('2026-09-14T17:18:00Z', london)).toBe('12 min ago')
    expect(whenPublished('2026-09-14T16:30:00Z', london)).toBe('1 hour ago')
    expect(whenPublished('2026-09-13T18:00:00Z', london)).toBe('23 hours ago')
    // A publisher whose clock runs a little ahead of the reader's.
    expect(whenPublished('2026-09-14T17:31:00Z', london)).toBe('Just now')
  })

  it('names the day after that, and gives the date after a week', () => {
    expect(whenPublished('2026-09-13T08:00:00Z', london)).toBe('Yesterday')
    expect(whenPublished('2026-09-11T08:00:00Z', london)).toBe('Friday')
    expect(whenPublished('2026-09-02T08:00:00Z', london)).toBe('2 September')
    expect(whenPublished('2025-12-30T08:00:00Z', london)).toBe('30 December 2025')
  })

  it('says a timestamp that is only a date as a date, never as hours ago', () => {
    expect(whenPublished('2026-09-14T00:00:00.000Z', london)).toBe('Today')
    expect(whenPublished('2026-09-13', london)).toBe('Yesterday')
    expect(whenPublished('2026-09-10T00:00:00Z', london)).toBe('Thursday')
  })

  it("counts days where the reader is", () => {
    // 02:00 UTC on the 15th: three in the morning in London, ten the night before in New York.
    const now = Date.UTC(2026, 8, 15, 2)
    expect(whenPublished('2026-09-13T22:30:00Z', { now, timeZone: 'Europe/London' })).toBe('Sunday')
    expect(whenPublished('2026-09-13T22:30:00Z', { now, timeZone: 'America/New_York' })).toBe('Yesterday')
  })

  it('says nothing for a date it cannot read', () => {
    expect(whenPublished('', london)).toBe('')
    expect(whenPublished('last Tuesday', london)).toBe('')
  })
})

describe('mastheadDate', () => {
  it('dates the page and names its edition by the hour it is read', () => {
    expect(mastheadDate('day', london)).toBe('Monday 14 September · Evening edition')
    expect(mastheadDate('day', { now: NOW, timeZone: 'America/New_York' })).toBe('Monday 14 September · Afternoon edition')
    expect(mastheadDate('day', { now: NOW, timeZone: 'Asia/Tokyo' })).toBe('Tuesday 15 September · Late edition')
    expect(mastheadDate('day', { now: NOW - 10 * HOUR, timeZone: 'Europe/London' })).toBe('Monday 14 September · Morning edition')
  })

  it("dates a week's stories by the day they run to", () => {
    expect(mastheadDate('week', london)).toBe('The week to 14 September')
  })
})
