/**
 * The tools only the browser can run.
 *
 * A timer has to live where the page lives, or it stops existing the moment the
 * server forgets about the request. A link has to be offered to whoever is
 * actually looking at the screen. Neither belongs on the server, so the agent
 * loop asks for them over the socket and waits for this to answer.
 *
 * Nothing here navigates, downloads, or writes anything outside the page. A
 * model that has been talked into asking for something alarming gets, at worst,
 * a card the user can ignore — the decision to act on it stays with the person,
 * which is the only safe place to put it when the instruction originated in a
 * language model.
 */

export interface Timer {
  id: string
  label: string
  /** Wall-clock milliseconds. */
  fireAt: number
}

export interface OfferedLink {
  id: string
  url: string
  title: string
}

export interface ClientToolHandlers {
  onTimerSet?: (timer: Timer) => void
  onTimerFired?: (timer: Timer) => void
  onLinkOffered?: (link: OfferedLink) => void
}

export interface ClientToolResult {
  ok: boolean
  /** Goes back to the model, and is about to be spoken, so it stays prose. */
  content: string
}

/** A day is the longest timer worth holding in a page that may be closed. */
const MAX_TIMER_SECONDS = 86_400
const MIN_TIMER_SECONDS = 1

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/**
 * Only ever http or https, and only ever as an absolute URL.
 *
 * `javascript:` and `data:` URLs are the reason this is a whitelist rather than
 * a blacklist: a link is about to be put in front of the user with GIDEON's
 * apparent endorsement, and the set of schemes that are safe to render that way
 * is small and known.
 */
export function safeUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  return url.toString()
}

export function describeDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} seconds`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hourPart = `${hours} hour${hours === 1 ? '' : 's'}`
  return rest ? `${hourPart} and ${rest} minute${rest === 1 ? '' : 's'}` : hourPart
}

export class ClientToolRunner {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(private readonly handlers: ClientToolHandlers = {}) {}

  get pendingTimers() {
    return this.timers.size
  }

  async run(name: string, rawArgs: unknown): Promise<ClientToolResult> {
    if (this.disposed) return { ok: false, content: 'The page is no longer listening.' }
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>

    switch (name) {
      case 'set_timer':
        return this.setTimer(args)
      case 'offer_link':
        return this.offerLink(args)
      default:
        return { ok: false, content: `The browser has no tool called ${name}.` }
    }
  }

  private setTimer(args: Record<string, unknown>): ClientToolResult {
    const raw = typeof args.seconds === 'number' ? args.seconds : Number(args.seconds)
    if (!Number.isFinite(raw)) {
      return { ok: false, content: 'No length was given for the timer.' }
    }
    if (raw < MIN_TIMER_SECONDS) {
      return { ok: false, content: 'That is too short to be a timer.' }
    }
    if (raw > MAX_TIMER_SECONDS) {
      return { ok: false, content: 'Timers cannot be longer than a day.' }
    }

    const seconds = Math.round(raw)
    const label = typeof args.label === 'string' ? args.label.trim().slice(0, 80) : ''
    const timer: Timer = { id: makeId(), label, fireAt: Date.now() + seconds * 1000 }

    this.timers.set(
      timer.id,
      setTimeout(() => {
        this.timers.delete(timer.id)
        if (!this.disposed) this.handlers.onTimerFired?.(timer)
      }, seconds * 1000),
    )

    this.handlers.onTimerSet?.(timer)
    return {
      ok: true,
      content: `Timer set for ${describeDuration(seconds)}${label ? ` for ${label}` : ''}.`,
    }
  }

  private offerLink(args: Record<string, unknown>): ClientToolResult {
    const url = safeUrl(typeof args.url === 'string' ? args.url : '')
    if (!url) {
      return { ok: false, content: 'That was not a usable web address, so nothing was shown.' }
    }
    const title =
      (typeof args.title === 'string' ? args.title.trim().slice(0, 100) : '') || new URL(url).hostname

    this.handlers.onLinkOffered?.({ id: makeId(), url, title })
    return {
      ok: true,
      content: `A link to ${title} is now on screen for the user to open if they want it.`,
    }
  }

  dispose() {
    this.disposed = true
    for (const handle of this.timers.values()) clearTimeout(handle)
    this.timers.clear()
  }
}
