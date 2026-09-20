export type NumberFormat = 'plain' | 'en-US' | 'de-DE' | 'fr-FR'
const SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 }

/** Explicit formats only. Separators and magnitudes are never inferred from a digit string. */
export function sourceNumber(raw: string, header = '', format: NumberFormat = 'plain'): { value: number | null; unit: string; transform?: string } | null {
  const missing = /^(?:|—|–|-|N\/A|NA|null|not available|suppressed)$/i
  if (missing.test(raw.trim())) return { value: null, unit: '' }
  let text = raw.trim().replace(/−/g, '-')
  if (format === 'en-US') {
    if (/,/.test(text) && !/^[+-]?(?:\d{1,3}(?:,\d{3})+)(?:\.\d+)?(?:\s|%|$)/.test(text)) return null
    text = text.replace(/,/g, '')
  } else if (format === 'de-DE') {
    if (!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?(?:\s|%|$)/.test(text)) return null
    text = text.replace(/\./g, '').replace(',', '.')
  } else if (format === 'fr-FR') {
    if (!/^[+-]?(?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:,\d+)?(?:\s|%|$)/.test(text)) return null
    text = text.replace(/[ \u00a0\u202f](?=\d)/g, '').replace(',', '.')
  }
  const match = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(?:(thousand|million|billion|trillion)\s*)?([\p{L}%°µ/$²³0-9 -]{0,32})$/u)
  if (!match) return null
  const parens = header.match(/\(([^)]+)\)/)?.[1]?.trim() ?? ''
  const headerScale = header.match(/\b(thousand|million|billion|trillion)\b/i)?.[1]?.toLowerCase()
  const knownHeaderUnit = header.match(/\b(USD|EUR|GBP|PKR|ms|km|kg|hours|days|years)\b|%|°[CF]/)?.[0]
  const headerUnit = knownHeaderUnit ?? (/^[\p{L}%°µ/$²³ -]+$/u.test(parens) ? parens.replace(/\b(thousand|million|billion|trillion)\b/gi, '').trim() : '')
  const cellUnit = match[3].trim()
  if (cellUnit && headerUnit && cellUnit !== headerUnit) return null
  const scale = match[2] || headerScale
  const value = Number(match[1]) * (scale ? SCALES[scale] : 1)
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return null
  return { value, unit: cellUnit || headerUnit, ...(scale ? { transform: `Converted ${scale} to base units (×${SCALES[scale]}).` } : {}) }
}

/** A version fingerprint, not a cryptographic signature or a publisher-verification claim. */
export function datasetVersion(value: unknown): string {
  let hash = 2166136261
  for (const char of JSON.stringify(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}
