import { createHash } from 'node:crypto'

/** Whitespace- and Unicode-normalised text, used for duplicate detection. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Two memories with the same kind and normalised text are the same memory. */
export function canonicalKey(kind: string, text: string): string {
  return sha256(`${kind}\0${normalizeText(text).toLocaleLowerCase('und')}`)
}

const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'am', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'before', 'being', 'but',
  'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here',
  'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our',
  'ours', 'she', 'should', 'so', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'to', 'too', 'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who',
  'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours',
])

/** A plural reduced to its singular, so "dogs" finds "dog" (the same rule the PostgreSQL backend applies). */
export function singular(term: string): string {
  if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`
  if (term.length > 4 && /(?:ch|sh|x|z|ss)es$/u.test(term)) return term.slice(0, -2)
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1)
  return term
}

/** Search terms: lower-cased letters and digits, stopwords dropped, plurals reduced. */
export function terms(text: string): string[] {
  const words = text.normalize('NFKC').toLocaleLowerCase('und').match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  return [...new Set(words.filter((word) => word.length > 1 && !STOPWORDS.has(word)).map(singular))]
}
