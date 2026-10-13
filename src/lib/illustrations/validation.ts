export const MAX_ILLUSTRATION_HTML = 60_000

/** A shape check, not a JavaScript verifier. The opaque-origin iframe is the boundary. */
export function readIllustrationHtml(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_ILLUSTRATION_HTML) return null
  const html = value.trim()
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(html)) return null
  if (!/<(?:svg|canvas)\b/i.test(html)) return null
  if (/<(?:html|head|body|meta|base|iframe|frame|object|embed|link|form)\b/i.test(html)) return null
  if (/\b(?:src|href|action)\s*=\s*["']?\s*(?:https?:|\/\/|javascript:)/i.test(html)) return null
  if (/<script\b[^>]*\bsrc\s*=/i.test(html) || /\bimport\s*(?:\(|["'{*])/i.test(html)) return null
  return html
}
