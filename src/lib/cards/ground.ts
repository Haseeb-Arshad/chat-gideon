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

/**
 * The numbers a piece of text states, normalised so "1,879" and "1879" are the
 * same number and "17°C" is 17. Ordinary spaces are deliberately not part of a
 * number: "in 2023 42 people" is two numbers, not 202342. The spaces that are
 * part of one ("1 879" set with a no-break or narrow no-break space) are
 * written as escapes, because the characters themselves look exactly like the
 * ordinary space that must not match, and did not survive being copied once.
 */
export function numbersIn(text: string): string[] {
  const found = text.match(/\d(?:[\d,.\u00a0\u202f]*\d)?/g) ?? []
  return found.map((number) => number.replace(/[,\u00a0\u202f]/g, ''))
}

/**
 * Every number in `source`, in full and by its whole part.
 *
 * The whole part is there so a card may round: "$67,420" is fair from a source
 * that says "$67,420.50". It never works the other way, so a decimal the source
 * does not contain is still caught.
 */
export function knownNumbers(source: string): Set<string> {
  const known = new Set<string>()
  for (const number of numbersIn(source)) {
    known.add(number)
    known.add(number.split('.')[0])
  }
  return known
}

export function grounded(text: string, known: Set<string>): boolean {
  return numbersIn(text).every((number) => known.has(number))
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
