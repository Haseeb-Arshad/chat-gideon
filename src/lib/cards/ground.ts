/**
 * The rules that keep a card honest, shared by every kind of card.
 *
 * A card is the one place in the interface where words are shown as fact
 * rather than spoken as conversation, so nothing a card carries is trusted as
 * it arrives: text is cleaned and clipped, and a number no source stated is
 * treated as invented. These began inside the first card parser and are used by
 * everything that builds a card now.
 */

/**
 * Plain text, clipped at a word.
 *
 * Only markdown's emphasis and heading marks are removed, not the characters
 * themselves: "C#" and "snake_case" are names, and `**` never is.
 */
export function cleanText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const text = value
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= limit) return text
  const cut = text.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`
}

/** Numeric extraction retained for callers that only need to detect figures. */
export function numbersIn(text: string): string[] {
  return quantities(text).map((quantity) => quantity.number)
}

interface Quantity { number: string; scale: string; unit: string; currency: string }
const UNIT = /^(%|percent\b|percentage points?\b|°\s*[CF]|celsius\b|fahrenheit\b|km\/h\b|mph\b|km\b|kilomet(?:er|re)s?\b|miles?\b|met(?:er|re)s?\b|cm\b|mm\b|kg\b|mg\b|grams?\b|g\b|lbs?\b|pounds?\b|ms\b|milliseconds?\b|seconds?\b|minutes?\b|hours?\b|days?\b|years?\b|watts?\b|kWh\b|MW\b|GB\b|MB\b|bytes?\b|tokens?\b|vectors?\b|people\b|persons?\b|USD\b|EUR\b|GBP\b)/i

function quantities(text: string): Quantity[] {
  const result: Quantity[] = []
  const pattern = /([+\-−]?)\s*([$€£]?)\s*([+\-−]?)((?:\d[\d,\u00a0\u202f]*)(?:\.\d+)?)/g
  for (const match of text.matchAll(pattern)) {
    let sign = match[1] || match[3]
    // A hyphen between digits is a range/date separator, not a negative sign.
    if (sign === '-' && /\d$/.test(text.slice(0, match.index).trimEnd())) sign = ''
    const number = (sign === '−' ? '-' : sign) + match[4].replace(/[,\u00a0\u202f]/g, '')
    let rest = text.slice(match.index! + match[0].length).trimStart()
    const scaleMatch = rest.match(/^(thousand|million|billion|trillion|[kmbt])\b/i)
    const scales: Record<string, string> = { k: 'thousand', m: 'million', b: 'billion', t: 'trillion' }
    const rawScale = scaleMatch?.[0].toLowerCase() ?? ''
    const scale = scales[rawScale] ?? rawScale
    if (scaleMatch) rest = rest.slice(scaleMatch[0].length).trimStart()
    let unit = rest.match(UNIT)?.[0].toLowerCase().replace(/\s+/g, '') ?? ''
    const aliases: Record<string, string> = { percent: '%', celsius: '°c', fahrenheit: '°f', kilometres: 'km', kilometers: 'km', kilometre: 'km', kilometer: 'km', metres: 'm', meters: 'm', metre: 'm', meter: 'm' }
    unit = aliases[unit] ?? unit.replace(/s$/, '')
    if (unit && /^(?:tokens?|vectors?)$/.test(unit)) {
      const rate = rest.match(/^(?:tokens?|vectors?)\s*(?:\/|per\s+)\s*(second|s|minute|hour)\b/i)
      if (rate) unit += '/' + (rate[1].toLowerCase() === 'second' ? 's' : rate[1].toLowerCase())
    }
    result.push({ number, scale, unit, currency: match[2] })
  }
  return result
}

function quantityKey(quantity: Quantity): string {
  return JSON.stringify([quantity.number, quantity.scale, quantity.unit, quantity.currency])
}

/** Rounding may drop a fraction, never a sign, magnitude, currency or unit. */
export function knownNumbers(source: string): Set<string> {
  const known = new Set<string>()
  for (const quantity of quantities(source)) {
    known.add(quantityKey(quantity))
    known.add(quantityKey({ ...quantity, number: quantity.number.split('.')[0] }))
  }
  return known
}

export function grounded(text: string, known: Set<string>): boolean {
  return quantities(text).every((quantity) => known.has(quantityKey(quantity)))
}

/** Keeps only the sentences whose numbers all come from what is known. */
export function groundedSentences(text: string, known: Set<string>): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence && grounded(sentence, known))
    .join(' ')
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** A link a person may be sent to: the web, and nothing that runs. */
export function isWebUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** A picture the page may load: https only, so nothing on a card is fetched in the clear. */
export function isImageUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}
