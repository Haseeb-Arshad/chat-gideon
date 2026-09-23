/**
 * Edge-safe content screens shared by retrieval and background learning.
 *
 * These are deliberately simple, deterministic and conservative. A match means
 * "do not send this anywhere remote and do not learn it implicitly"; it never
 * means the text is safe when nothing matches.
 */

const SECRET_LIKE = /(?:\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{28,}|AKIA[0-9A-Z]{16})\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/iu

/** Card-like digit runs, Pakistani CNIC, and "my password is" style disclosures. */
const PERSONAL_SECRET = /(?:\b(?:\d[ -]?){13,19}\b|\b\d{5}-\d{7}-\d\b|\b(?:my\s+)?(?:password|passcode|pin|otp|cvv)\s+(?:is|was|:)\s*\S+|\bmera\s+(?:password|pin)\s+\S+)/iu

export function containsSecretLikeMaterial(text: string): boolean {
  return SECRET_LIKE.test(text) || PERSONAL_SECRET.test(text)
}

export type SensitiveCategory =
  | 'health'
  | 'religion'
  | 'sexuality'
  | 'politics'
  | 'ethnicity'
  | 'criminal_record'
  | 'immigration'
  | 'finances'

/**
 * Special-category topics that background learning never infers or stores on
 * its own. The user can still ask for one to be remembered explicitly.
 * English and Roman Urdu terms; matched on word starts.
 */
const SENSITIVE: ReadonlyArray<readonly [SensitiveCategory, RegExp]> = [
  ['health', /\b(?:diagnos|pregnan|depress|anxiety|adhd|autis|bipolar|schizo|cancer|diabet|hiv|aids\b|std\b|therap|medicat|antidepress|disabilit|illness|disease|surgery|chemo|miscarri|bimar|dawai|dawa\b)/iu],
  ['religion', /\b(?:religio|muslim|christian|hindu|jewish|sikh|atheis|agnostic|namaz|mosque|masjid|church|temple|synagogue|fasting for|roza)/iu],
  ['sexuality', /\b(?:gay\b|lesbian|bisexual|transgender|queer|sexual orientation|asexual|nonbinary|non-binary)/iu],
  ['politics', /\b(?:vote[sd]? for|voting for|political party|pti\b|pml|ppp\b|democrat|republican|tory|labour party|leftist|right-wing)/iu],
  ['ethnicity', /\b(?:ethnicit|my race\b|caste|tribe\b)/iu],
  ['criminal_record', /\b(?:arrested|criminal record|convicted|jail|prison|parole)/iu],
  ['immigration', /\b(?:visa status|undocumented|asylum|deport|green card|refugee status)/iu],
  ['finances', /\b(?:salary|my income|debt\b|debts\b|loan\b|loans\b|bankrupt|tankhwah|qarz)/iu],
]

export function sensitiveCategories(text: string): SensitiveCategory[] {
  return SENSITIVE.filter(([, pattern]) => pattern.test(text)).map(([category]) => category)
}
