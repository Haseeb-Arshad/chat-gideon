import { MAX_ILLUSTRATION_HTML } from './validation'

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/**
 * The text of one string field of a JSON object that is still being written.
 *
 * The drawing arrives as `{"title":…,"summary":…,"html":"…"}` a few characters
 * at a time, so the html is never valid JSON until the very end. This reads
 * what has arrived of one field: everything up to the last complete character,
 * with `done` set once the closing quote has been seen.
 */
export function partialJsonString(raw: string, key: string): { value: string; done: boolean } | null {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(raw)
  if (!match) return null
  let value = ''
  let index = match.index + match[0].length
  while (index < raw.length) {
    const char = raw[index]
    if (char === '"') return { value, done: true }
    if (char !== '\\') { value += char; index += 1; continue }
    const next = raw[index + 1]
    if (next === undefined) break
    if (next === 'u') {
      const hex = raw.slice(index + 2, index + 6)
      if (hex.length < 4) break
      value += /^[0-9a-fA-F]{4}$/.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : ''
      index += 6
      continue
    }
    value += ESCAPES[next] ?? next
    index += 2
  }
  return { value, done: false }
}

/**
 * What can honestly be shown of a drawing that is half written: the markup and
 * styling so far, with nothing that runs. Scripts are what turns most of a
 * drawing into its final form, and they cannot be run until they are whole, so
 * the preview is the static drawing the model wrote first, growing as it goes.
 * Null until there is an svg to look at.
 */
export function previewOfDraft(html: string): string | null {
  let text = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[\s\S]*$/i, '')
    // A tag cut off mid-word would print its own source.
    .replace(/<[^>]*$/, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
  if (text.length > MAX_ILLUSTRATION_HTML) text = text.slice(0, MAX_ILLUSTRATION_HTML).replace(/<[^>]*$/, '')
  return /<svg\b/i.test(text) ? text : null
}
