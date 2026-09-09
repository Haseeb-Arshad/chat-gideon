/**
 * Punctuation nobody should have to listen to.
 *
 * The system prompt asks for no em dashes. It does not get them: the models
 * reach for one every few sentences regardless, and the ones that survive are
 * the ones the user reads in the caption and the voice renders as an odd gap.
 * So the rule is enforced here as well, where it cannot be talked out of.
 *
 * The awkward part is that this runs on a token stream. A dash can arrive as
 * its own token, long after the word it followed has already been sent on, so
 * substituting per chunk loses the context that decides what the dash meant.
 * Holding back the trailing run that a following token could still change costs
 * nothing perceptible and makes the substitution exact however the stream is
 * chopped up.
 */

/** Em, en, figure and horizontal bar. The plain hyphen is left alone. */
const DASHES = '‒–—―'
/**
 * A suffix of digits, spaces and dashes could still turn out to be a numeric
 * range, so it waits for the next token. Any other character resolves it.
 */
const UNSETTLED = new RegExp(`[\\d\\s${DASHES}]+$`)
const RANGE = new RegExp(`(\\d)\\s*[${DASHES}]\\s*(\\d)`, 'g')
const RUN = new RegExp(`\\s*[${DASHES}]+\\s*`, 'g')

/** Punctuation that already does the job the comma would have done. */
const CLOSED = /[,.!?;:]$/

/** `previous` is the last character already sent on, or '' at the very start. */
function clean(text: string, previous: string): string {
  // A dash between numbers is a range, and a range is spoken as "to".
  const ranged = text.replace(RANGE, '$1 to $2')

  const out = ranged.replace(RUN, (match, offset: number) => {
    // A dash sitting alone between blank lines is layout, not punctuation.
    if (match.includes('\n')) return match
    const before = offset === 0 ? previous : ranged.slice(0, offset)
    // Nothing in front of it, or punctuation that already closed the clause:
    // the dash was doing no work, so it leaves without a trace.
    if (!before.trim() || CLOSED.test(before.trimEnd())) return ' '
    return ', '
  })

  return out.replace(/ {2,}/g, ' ').replace(/ ([,.])/g, '$1')
}

/**
 * Rewrites a token stream so nothing dashed reaches the caption or the voice.
 * Feed every delta through `push`, then `flush` once the stream ends.
 */
export class SpokenText {
  private held = ''
  private previous = ''

  push(chunk: string): string {
    if (!chunk) return ''
    const text = this.held + chunk

    const unsettled = UNSETTLED.exec(text)
    this.held = unsettled ? unsettled[0] : ''
    const body = this.held ? text.slice(0, text.length - this.held.length) : text
    if (!body) return ''

    return this.emit(body)
  }

  /** Whatever was being held back, cleaned and released. */
  flush(): string {
    const held = this.held
    this.held = ''
    if (!held) return ''
    return this.emit(held).trimEnd()
  }

  private emit(body: string): string {
    let out = clean(body, this.previous)
    // The stream should not open on the space a stripped leading dash left.
    if (!this.previous) out = out.trimStart()
    if (out) this.previous = out.slice(-1)
    return out
  }
}

/** One-shot form, for text that is not being streamed. */
export function spokenText(text: string): string {
  const stream = new SpokenText()
  return `${stream.push(text)}${stream.flush()}`
}
