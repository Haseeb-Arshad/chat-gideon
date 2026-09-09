/**
 * What the conversation feels like.
 *
 * Two different consumers want two different answers. The eyes want a single
 * discrete pose for the thing that was just said. The background wants the
 * shape of the whole conversation, because a room's light does not snap back to
 * neutral the moment someone stops talking.
 *
 * So a message is scored once into valence (pleasant to unpleasant) and arousal
 * (calm to activated) — Russell's circumplex — and both answers are read off
 * that plane: the nearest anchor gives the pose, and a running average of the
 * point gives the light.
 */

export type EyeEmotion =
  | 'neutral'
  | 'curious'
  | 'focused'
  | 'happy'
  | 'concerned'
  | 'surprised'

export interface Mood {
  /** -1 unpleasant … 1 pleasant. */
  valence: number
  /** 0 calm … 1 activated. */
  arousal: number
}

export const NEUTRAL_MOOD: Mood = { valence: 0, arousal: 0.26 }

/** Where each pose sits on the plane. */
export const ANCHORS: Record<EyeEmotion, Mood> = {
  concerned: { valence: -0.7, arousal: 0.4 },
  neutral: { valence: 0, arousal: 0.25 },
  focused: { valence: 0.05, arousal: 0.65 },
  curious: { valence: 0.3, arousal: 0.45 },
  surprised: { valence: 0.2, arousal: 0.95 },
  happy: { valence: 0.7, arousal: 0.6 },
}

interface Lexeme {
  words: RegExp
  valence: number
  arousal: number
}

/**
 * Weighted rather than first-match-wins: "sorry, that is hilarious" should land
 * somewhere between the two, not on whichever branch happened to be tested
 * first.
 */
const LEXICON: Lexeme[] = [
  {
    words:
      /\b(ha|haha|hehe|lol|lmao|love|lovely|delight|delighted|wonderful|amazing|awesome|brilliant|great|good|glad|happy|funny|joy|joke|laugh|laughing|smile|flattered|beautiful|perfect|thanks|excited|yay)\b/g,
    valence: 0.82,
    arousal: 0.66,
  },
  {
    words: /\b(calm|quiet|rest|peace|peaceful|gentle|slow|easy|fine|okay|alright|sure|steady)\b/g,
    valence: 0.3,
    arousal: 0.12,
  },
  {
    words:
      /\b(sorry|sad|hurt|hurting|hard|difficult|afraid|scared|worried|worry|anxious|loss|lost|unfortunately|struggling|tired|exhausted|alone|lonely|failed|failing|broken|stuck|hate|awful|terrible|angry|frustrated)\b/g,
    valence: -0.78,
    arousal: 0.42,
  },
  {
    words:
      // "really" and "seriously" are intensifiers, not surprise: scoring them
      // as pleasant was cancelling out the sentence they intensify, so "this
      // has been really hard" came back barely negative.
      /\b(whoa|woah|wow|incredible|unbelievable|insane|huge|massive|suddenly)\b/g,
    valence: 0.34,
    arousal: 0.9,
  },
  {
    words: /\b(why|how|wonder|wondering|curious|maybe|perhaps|suppose|imagine|guess|question)\b/g,
    valence: 0.34,
    arousal: 0.5,
  },
  {
    words:
      /\b(build|building|fix|fixing|solve|solving|plan|planning|work|working|figure|debug|design|code|ship|deploy|analyse|analyze|check|test)\b/g,
    valence: 0.1,
    arousal: 0.64,
  },
]

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0
  let count = 0
  while (pattern.exec(text) !== null) {
    count += 1
    if (count > 12) break
  }
  return count
}

export interface Scored extends Mood {
  /** 0–1: how much this message should be trusted to move the mood. */
  confidence: number
}

function clampRange(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value
}

/** Score one message onto the plane. */
export function scoreText(text: string): Scored {
  const value = text.toLowerCase()
  if (!value.trim()) return { ...NEUTRAL_MOOD, confidence: 0 }

  let weight = 0
  let valence = 0
  let arousal = 0

  for (const lexeme of LEXICON) {
    const hits = countMatches(value, lexeme.words)
    if (!hits) continue
    // Diminishing returns: the fourth "great" says little the first did not.
    const w = Math.sqrt(hits)
    weight += w
    valence += lexeme.valence * w
    arousal += lexeme.arousal * w
  }

  // Punctuation and shouting carry arousal even with no lexicon hit at all.
  const exclaims = Math.min(3, (value.match(/!/g) ?? []).length)
  const questions = Math.min(3, (value.match(/\?/g) ?? []).length)
  const letters = text.replace(/[^a-zA-Z]/g, '')
  const shout = letters.length > 6 ? (text.match(/[A-Z]/g) ?? []).length / letters.length : 0

  if (exclaims || questions || shout > 0.6) {
    const w = 0.5 * exclaims + 0.4 * questions + (shout > 0.6 ? 1 : 0)
    weight += w
    valence += (questions ? 0.3 : 0.25) * w
    arousal += (0.75 + shout * 0.2) * w
  }

  if (weight === 0) {
    // Long, flat text still reads as engaged rather than as nothing said.
    const engaged = Math.min(1, value.length / 240)
    return { valence: 0.04, arousal: 0.28 + engaged * 0.18, confidence: 0.18 }
  }

  return {
    valence: clampRange(valence / weight, -1, 1),
    arousal: clampRange(arousal / weight, 0, 1),
    confidence: Math.min(1, 0.32 + weight * 0.22),
  }
}

/** Nearest anchor on the plane, weighting valence a little above arousal. */
export function moodToEmotion(mood: Mood): EyeEmotion {
  let best: EyeEmotion = 'neutral'
  let bestDistance = Infinity
  for (const [name, anchor] of Object.entries(ANCHORS) as [EyeEmotion, Mood][]) {
    const dv = (mood.valence - anchor.valence) * 1.25
    const da = mood.arousal - anchor.arousal
    const distance = dv * dv + da * da
    if (distance < bestDistance) {
      bestDistance = distance
      best = name
    }
  }
  return best
}

/** The pose for a single utterance. */
export function deriveEmotion(text: string): EyeEmotion {
  const scored = scoreText(text)
  if (scored.confidence < 0.25) return 'neutral'
  return moodToEmotion(scored)
}

/**
 * How much of a turn's feeling comes from the person rather than from GIDEON.
 *
 * Scoring both sides equally has a specific failure: a good reply to "today has
 * been hard" is warm and calming, so it scores as pleasant and cancels the
 * distress out, and the room comes back to neutral at exactly the moment it
 * should not. The person in the room sets the mood; the reply only tempers it.
 */
export const SPEAKER_WEIGHT = { user: 1, assistant: 0.45 } as const

/**
 * The pose for a whole turn: what was said, tempered by how it was answered.
 *
 * Concatenating the two strings and scoring once — which is what this replaces
 * — merges both sides' lexicon hits with no weighting at all, so a long reply
 * simply outvotes a short, heavy sentence.
 */
export function emotionForTurn(userText: string, replyText: string): EyeEmotion {
  const user = scoreText(userText)
  const reply = scoreText(replyText)
  const wu = user.confidence * 0.62
  const wr = reply.confidence * 0.38
  const total = wu + wr
  if (total < 0.2) return 'neutral'
  return moodToEmotion({
    valence: (user.valence * wu + reply.valence * wr) / total,
    arousal: (user.arousal * wu + reply.arousal * wr) / total,
  })
}

/**
 * Fold a message into the running mood. Low-confidence messages barely move it
 * and let it drift home instead, so a long stretch of small talk cools the room
 * down rather than freezing it on whatever was said an hour ago.
 */
export function blendMood(current: Mood, sample: Scored, weight = 1): Mood {
  const alpha = Math.min(0.85, sample.confidence * 0.8 * weight)
  const decay = 0.06 * (1 - alpha)
  return {
    valence:
      current.valence + (sample.valence - current.valence) * alpha - current.valence * decay,
    arousal:
      current.arousal +
      (sample.arousal - current.arousal) * alpha +
      (NEUTRAL_MOOD.arousal - current.arousal) * decay,
  }
}

/**
 * Pull the mood toward a named feeling directly, for the moments the words do
 * not say it — a dropped connection is not a sad sentence, but the room should
 * still register it.
 */
export function nudgeMood(current: Mood, emotion: EyeEmotion, strength = 0.4): Mood {
  const anchor = ANCHORS[emotion] ?? NEUTRAL_MOOD
  const k = Math.max(0, Math.min(1, strength))
  return {
    valence: current.valence + (anchor.valence - current.valence) * k,
    arousal: current.arousal + (anchor.arousal - current.arousal) * k,
  }
}

export type Rgb = [number, number, number]

export interface Palette {
  /** Deep ground the field settles into. */
  base: Rgb
  /** Mid body of the flow. */
  body: Rgb
  /** The bright edge that rides the crests. */
  crest: Rgb
}

/**
 * Kept dark on purpose: this sits behind large white text, so the brightest
 * channel of any `body` stays well under the point where the caption stops
 * carrying itself.
 */
export const PALETTES: Record<EyeEmotion, Palette> = {
  neutral: { base: [0.022, 0.028, 0.045], body: [0.11, 0.15, 0.28], crest: [0.4, 0.55, 0.8] },
  curious: { base: [0.014, 0.038, 0.045], body: [0.06, 0.24, 0.27], crest: [0.3, 0.78, 0.76] },
  focused: { base: [0.014, 0.022, 0.056], body: [0.06, 0.12, 0.36], crest: [0.32, 0.48, 0.98] },
  happy: { base: [0.05, 0.03, 0.026], body: [0.32, 0.16, 0.11], crest: [1, 0.64, 0.34] },
  concerned: { base: [0.03, 0.023, 0.04], body: [0.21, 0.11, 0.22], crest: [0.64, 0.36, 0.58] },
  surprised: { base: [0.036, 0.023, 0.056], body: [0.25, 0.12, 0.4], crest: [0.74, 0.42, 1] },
}

/**
 * Gaussian blend of every anchor palette.
 *
 * Picking the single nearest palette would give six flat looks and a visible
 * jump between them, so all six are mixed — but the kernel has to fall off
 * sharply or the average of six palettes wins every time and the room is
 * permanently the same muddy blue. At this width the nearest anchor dominates
 * and its neighbours tint it, which is what makes the colour a continuous
 * function of the conversation rather than a wash.
 */
const KERNEL = 0.2

export function moodPalette(mood: Mood): Palette {
  const out: Palette = { base: [0, 0, 0], body: [0, 0, 0], crest: [0, 0, 0] }
  let total = 0

  for (const [name, anchor] of Object.entries(ANCHORS) as [EyeEmotion, Mood][]) {
    const dv = mood.valence - anchor.valence
    const da = (mood.arousal - anchor.arousal) * 1.15
    const weight = Math.exp(-(dv * dv + da * da) / (2 * KERNEL * KERNEL))
    total += weight
    const palette = PALETTES[name]
    for (let i = 0; i < 3; i += 1) {
      out.base[i] += palette.base[i] * weight
      out.body[i] += palette.body[i] * weight
      out.crest[i] += palette.crest[i] * weight
    }
  }

  for (let i = 0; i < 3; i += 1) {
    out.base[i] /= total
    out.body[i] /= total
    out.crest[i] /= total
  }
  return out
}

export function rgbToCss(color: Rgb, alpha = 1): string {
  const to255 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255)
  return `rgba(${to255(color[0])}, ${to255(color[1])}, ${to255(color[2])}, ${alpha})`
}
