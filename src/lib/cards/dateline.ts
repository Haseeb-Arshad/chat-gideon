/**
 * When a story happened, the way a front page says it.
 *
 * Said against the reader's own clock, in the browser, never the server's: "2
 * hours ago" and "Yesterday" depend on where the person reading is. A news
 * search sometimes knows only the day a story ran, and gives it as midnight UTC
 * to the millisecond; that is a date, not a time, and it is said as one, since
 * "9 hours ago" would be a guess.
 */

export interface Clock {
  now: number
  /** The reader's own when left out; set in tests, which may run anywhere. */
  timeZone?: string
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

interface LocalTime {
  year: number
  month: number
  day: number
  hour: number
}

/** The calendar date and hour at an instant, where the reader is. */
function localTime(at: number, timeZone?: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((each) => each.type === type)?.value)
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour') % 24 }
}

/** Days since 1970 for a calendar date, so two dates subtract to the days between them. */
function dayNumber(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day) / DAY
}

/** The date of a timestamp that is only a date: no time at all, or exactly midnight UTC. */
function dateOnly(published: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00))?$/.exec(published.trim())
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null
}

/** "Just now", "12 min ago", "3 hours ago", "Yesterday", "Friday", "2 September", "30 December 2025". */
export function whenPublished(published: string, clock: Clock): string {
  if (!published) return ''
  const today = localTime(clock.now, clock.timeZone)
  let date = dateOnly(published)
  if (!date) {
    const at = Date.parse(published)
    if (!Number.isFinite(at)) return ''
    // A clock a little behind the publisher's makes a story from the future; it is new, not early.
    const ago = Math.max(0, clock.now - at)
    if (ago < MINUTE) return 'Just now'
    if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`
    if (ago < DAY) {
      const hours = Math.floor(ago / HOUR)
      return `${hours} hour${hours === 1 ? '' : 's'} ago`
    }
    date = localTime(at, clock.timeZone)
  }
  const day = dayNumber(date.year, date.month, date.day)
  const behind = dayNumber(today.year, today.month, today.day) - day
  if (behind <= 0) return 'Today'
  if (behind === 1) return 'Yesterday'
  if (behind < 7) return WEEKDAYS[new Date(day * DAY).getUTCDay()]
  return `${date.day} ${MONTHS[date.month - 1]}${date.year === today.year ? '' : ` ${date.year}`}`
}

/** Which edition a front page is, by the hour it is read. */
function edition(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Morning edition'
  if (hour >= 12 && hour < 17) return 'Afternoon edition'
  if (hour >= 17 && hour < 22) return 'Evening edition'
  return 'Late edition'
}

/** The line under a masthead: "Monday 14 September · Evening edition", or "The week to 14 September". */
export function mastheadDate(since: 'day' | 'week', clock: Clock): string {
  const today = localTime(clock.now, clock.timeZone)
  const date = `${today.day} ${MONTHS[today.month - 1]}`
  if (since === 'week') return `The week to ${date}`
  const weekday = WEEKDAYS[new Date(dayNumber(today.year, today.month, today.day) * DAY).getUTCDay()]
  return `${weekday} ${date} · ${edition(today.hour)}`
}
