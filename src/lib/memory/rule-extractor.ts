import type { Condition, ValidTime } from './contracts'
import {
  LEARNING_SCHEMA_VERSION,
  type ExtractionCandidate,
  type ExtractionWindow,
  type LearnableKind,
  type MemoryExtractor,
  type SpeechAct,
} from './learning'

/**
 * Deterministic, local, conservative extractor.
 *
 * It only proposes durable memory from a clause that is plainly the user's own
 * first-person claim, and labels quotes, hypotheticals, jokes, questions and
 * per-task instructions so the reconciler can refuse or downgrade them. It is
 * the default because it costs nothing, never leaves the process and cannot
 * invent a claim: every candidate cites the exact clause it came from.
 * English and Roman Urdu (including code switching) are covered by patterns;
 * anything it does not recognise is left for recall's source-evidence fallback.
 */

const UNKNOWN_TIME: ValidTime = { from: null, until: null, precision: 'unknown', sourceTimeZone: null }

interface Clause {
  start: number
  end: number
  text: string
}

const CONTRAST = /^(?:baqi|baaki|baki|otherwise|but otherwise|generally|in general|warna|lekin|but)\b/iu

/** Sentences, then comma clauses that open with a contrast ("…, baqi casual hi theek hai"). */
export function splitClauses(text: string): Clause[] {
  const clauses: Clause[] = []
  const sentence = /[^.!?\n;]+[.!?]*/gu
  for (const match of text.matchAll(sentence)) {
    const base = match.index ?? 0
    const body = match[0]
    const parts = body.split(/,/u)
    let offset = 0
    const pieces: { start: number; end: number }[] = []
    for (const part of parts) {
      pieces.push({ start: offset, end: offset + part.length })
      offset += part.length + 1
    }
    // Merge comma pieces unless the next piece starts with a contrast marker.
    let current = pieces[0]!
    for (let index = 1; index < pieces.length; index += 1) {
      const next = pieces[index]!
      if (CONTRAST.test(body.slice(next.start, next.end).trim())) {
        clauses.push(trimmed(text, base + current.start, base + current.end))
        current = next
      } else {
        current = { start: current.start, end: next.end }
      }
    }
    clauses.push(trimmed(text, base + current.start, base + current.end))
  }
  return clauses.filter((clause) => clause.text.length >= 3)
}

function trimmed(text: string, start: number, end: number): Clause {
  let from = start
  let to = end
  while (from < to && /[\s,]/u.test(text[from]!)) from += 1
  while (to > from && /[\s,.!;]/u.test(text[to - 1]!)) to -= 1
  return { start: from, end: to, text: text.slice(from, to) }
}

const QUESTION = /(?:\?\s*$|^(?:what|where|when|why|how|who|which|do you|did you|can you|could you|would you|should i|kya|kyun|kaise|kab|kahan|kaun)\b)/iu
const QUOTED_SPEECH = /(?:["“”'‘’].{2,}["“”'‘’]|\b(?:said|says|told me|tells me|according to|quote|kehta hai|kehti hai|kaha|bola|boli)\b)/iu
const THIRD_PARTY = /\b(?:my|his|her|their|our)\s+(?:colleague|coworker|co-worker|friend|boss|manager|wife|husband|partner|mom|mother|dad|father|brother|sister|son|daughter|teacher|client|team|dost|bhai|behen|ammi|abbu)\b/iu
const HYPOTHETICAL = /\b(?:imagine|suppose|supposing|what if|if i (?:were|was|had|moved|lived)|let'?s say|pretend|hypothetically|in a world where|farz karo|maan lo|agar main)\b/iu
const JOKE = /\b(?:just kidding|jk|kidding|joking|lol|lmao|haha+)\b/iu
const ASSISTANT_OFFER = /\b(?:you (?:suggested|recommended|said)|your (?:suggestion|idea)|as you said)\b/iu
const TASK_LOCAL = /\b(?:for this (?:one|email|reply|message|answer|draft|presentation|deck|project|task|trip|meeting)|this time|for now|just (?:for )?today|today only|in this (?:email|reply|message|answer|draft)|(?:is|iss) (?:project|presentation|email|trip|task|kaam|dafa) (?:ke|k) liye|abhi (?:ke|k) liye)\b/iu
const INSTRUCTION = /\b(?:keep it|make it|be (?:more|less)|use (?:a |an )?(?:formal|casual|informal|friendly|professional|simple|short|bullet)|write (?:it )?in|reply in|answer in|(?:formal|casual|short|brief|detailed) (?:tone|hi|rakho|theek)|tone)\b/iu
const CHANGE_CUE = /\b(?:moved to|now live|now work|no longer|not anymore|any ?more|switched (?:to|jobs)|changed (?:jobs|my)|ab main|ab mein)\b/iu

interface SelfPattern {
  kind: LearnableKind
  polarity: 'positive' | 'negative'
  pattern: RegExp
}

const SELF_PATTERNS: readonly SelfPattern[] = [
  { kind: 'preference', polarity: 'negative', pattern: /\bi\s+(?:really\s+|just\s+)?(?:don'?t|do not|never|can'?t stand|cannot stand)\s+(?:like|enjoy|want|stand|love)\b|\bi\s+(?:really\s+)?(?:hate|dislike|detest)\b|\bmujhe\b.*\b(?:pasand|acha|achha|achi|achhi)\b.*\b(?:nahi|nahin)\b|\b(?:nahi|nahin)\s+pasand\b/iu },
  { kind: 'preference', polarity: 'positive', pattern: /\bi\s+(?:really\s+|truly\s+|absolutely\s+|kind of\s+|usually\s+)?(?:like|love|enjoy|prefer|adore)\b|\bmy\s+favou?rite\b|\bi'?d\s+rather\b|\bmujhe\b.*\b(?:pasand|acha|achha|achi|achhi)\b|\bpasand\s+(?:hai|hain|he)\b|\b(?:casual|formal|short|simple)\s+hi\s+theek\b/iu },
  { kind: 'constraint', polarity: 'negative', pattern: /\bi'?m\s+allergic\s+to\b|\bi\s+am\s+allergic\s+to\b|\bi\s+(?:can'?t|cannot|don'?t|do not)\s+(?:eat|drink|have)\b|\bi'?m\s+(?:a\s+)?(?:vegetarian|vegan|pescatarian)\b|\bi\s+am\s+(?:a\s+)?(?:vegetarian|vegan|pescatarian)\b|\bi\s+(?:don'?t|do not|never)\s+(?:work|meet|travel|fly)\s+(?:on|after|before|at)\b|\bmain\b.*\b(?:nahi|nahin)\s+(?:khata|khati|peeta|peeti)\b/iu },
  { kind: 'decision', polarity: 'positive', pattern: /\bi\s+(?:rejected|ruled out|went with|chose|picked|decided\s+(?:on|to|against))\b|\bwe\s+(?:went with|decided\s+(?:on|to|against))\b/iu },
  { kind: 'fact', polarity: 'positive', pattern: /\bi(?:'ve|\s+have)?\s+(?:moved|relocated|switched)\s+(?:to|jobs)\b|\bi\s+now\s+(?:live|work)\b|\bi\s+(?:live|work|study|stay)\s+(?:in|at|for|as|near)\b|\bi'?m\s+(?:from|based\s+in)\b|\bi\s+am\s+(?:from|based\s+in)\b|\bmy\s+name\s+is\b|\bi'?m\s+an?\s+(?!bit\b|little\b|lot\b|huge\b|big\b|fan\b)[a-z-]{3,}\b|\bi\s+am\s+an?\s+(?!bit\b|little\b|lot\b|huge\b|big\b|fan\b)[a-z-]{3,}\b|\bmain\b.*\b(?:mein|me)\s+(?:rehta|rehti|kaam karta|kaam karti|parhta|parhti)\b|\bmera\s+naam\b/iu },
]

function actFor(clause: string): SpeechAct | null {
  if (QUESTION.test(clause)) return 'question'
  if (HYPOTHETICAL.test(clause)) return 'hypothetical'
  if (JOKE.test(clause)) return 'joke'
  if (ASSISTANT_OFFER.test(clause)) return 'assistant_suggestion'
  if (QUOTED_SPEECH.test(clause) || (THIRD_PARTY.test(clause) && !/\b(?:i|main|mujhe)\b/iu.test(clause.replace(THIRD_PARTY, '')))) return 'quoted'
  if (THIRD_PARTY.test(clause) && /\b(?:thinks|believes|likes|loves|hates|wants|prefers)\b/iu.test(clause)) return 'quoted'
  return null
}

const TASK_CONDITION: Condition = { key: 'scope', operator: 'equals', value: 'current_task' }

/** Spoken self-repair: only what follows the last repair is what the user meant (C03). */
const REPAIR = /\b(?:sorry|i mean|i meant|no wait|wait no|scratch that|mera matlab|matlab)\b[\s,:-]*/giu

function afterRepair(clause: Clause): Clause {
  let last: RegExpExecArray | null = null
  for (const match of clause.text.matchAll(REPAIR)) last = match as RegExpExecArray
  if (!last) return clause
  const offset = (last.index ?? 0) + last[0].length
  return { start: clause.start + offset, end: clause.end, text: clause.text.slice(offset) }
}

function candidateFor(original: Clause, window: ExtractionWindow): ExtractionCandidate | null {
  const clause = afterRepair(original)
  const text = clause.text
  if (!text.trim()) return null
  const self = SELF_PATTERNS.find((item) => item.pattern.test(text))
  // A task marker alone ("for this project") is not an instruction; it needs an instruction verb.
  const instruction = INSTRUCTION.test(text)
  if (!self && !instruction) return null
  const refused = actFor(text)
  const local = TASK_LOCAL.test(text)
  const speechAct: SpeechAct = refused ?? (local || (!self && instruction) ? 'temporary_instruction' : 'self_statement')
  const kind: LearnableKind = self?.kind ?? 'preference'
  const change = speechAct === 'self_statement' && CHANGE_CUE.test(text)
  return {
    kind,
    text: `User said: ${text}`,
    speechAct,
    polarity: self?.polarity ?? 'positive',
    scope: speechAct === 'temporary_instruction' ? 'local' : 'general',
    conditions: speechAct === 'temporary_instruction' ? [TASK_CONDITION] : [],
    relation: 'ordinary',
    validTime: UNKNOWN_TIME,
    evidence: { start: clause.start, end: clause.end, quote: window.text.slice(clause.start, clause.end) },
    // A stated change needs the explicit correct path to pick the old value;
    // background learning only records it for review.
    operation: change ? 'transition' : 'add',
    targetAssertionId: null,
  }
}

export function extractWithRules(window: ExtractionWindow): { candidates: ExtractionCandidate[] } {
  const candidates = splitClauses(window.text)
    .map((clause) => candidateFor(clause, window))
    .filter((candidate): candidate is ExtractionCandidate => Boolean(candidate))
  return { candidates: candidates.slice(0, 8) }
}

export const RULE_EXTRACTOR: MemoryExtractor = Object.freeze({
  id: 'gideon-rules',
  version: '1.0.0',
  promptVersion: 'rules-2026-09-23',
  schemaVersion: LEARNING_SCHEMA_VERSION,
  model: null,
  placement: 'local' as const,
  async extract(window: ExtractionWindow) {
    return { output: extractWithRules(window), usage: { inputUnits: window.text.length, outputUnits: 0, costMicros: 0 } }
  },
})
