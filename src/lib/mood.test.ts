import { describe, expect, it } from 'vitest'
import {
  ANCHORS,
  NEUTRAL_MOOD,
  SPEAKER_WEIGHT,
  blendMood,
  deriveEmotion,
  emotionForTurn,
  moodPalette,
  moodToEmotion,
  nudgeMood,
  scoreText,
} from './mood'

const converse = (turns: [string, number][]) =>
  turns.reduce((mood, [text, weight]) => blendMood(mood, scoreText(text), weight), NEUTRAL_MOOD)

describe('scoreText', () => {
  it('reads delight as pleasant and activated', () => {
    const scored = scoreText('haha that is wonderful, I love this')
    expect(scored.valence).toBeGreaterThan(0.6)
    expect(scored.arousal).toBeGreaterThan(0.5)
  })

  it('reads difficulty as unpleasant', () => {
    expect(scoreText('sorry, this has been really hard').valence).toBeLessThan(-0.4)
  })

  it('weighs mixed signals instead of taking the first match', () => {
    const mixed = scoreText('sorry, but that is hilarious and wonderful and I love it')
    const sad = scoreText('sorry, this is hard')
    expect(mixed.valence).toBeGreaterThan(sad.valence)
  })

  it('hears arousal in punctuation with no lexicon hit at all', () => {
    expect(scoreText('the thing on the shelf!!!').arousal).toBeGreaterThan(
      scoreText('the thing on the shelf').arousal,
    )
  })

  it('does not let repetition run away with the score', () => {
    const once = scoreText('great')
    const many = scoreText('great great great great great great')
    expect(many.valence).toBeCloseTo(once.valence, 5)
    expect(many.confidence).toBeLessThan(1.01)
  })

  it('treats empty input as saying nothing', () => {
    expect(scoreText('   ').confidence).toBe(0)
  })
})

describe('blendMood', () => {
  it('carries the feeling of a conversation past a single message', () => {
    const warm = converse([['haha that is wonderful, I love this, amazing work!', 0.9]])
    const after = blendMood(warm, scoreText('the file is at line forty'), 1)
    // A flat message cools the room; it does not reset it.
    expect(after.valence).toBeLessThan(warm.valence)
    expect(after.valence).toBeGreaterThan(warm.valence * 0.6)
  })

  it('drifts back toward rest across low-confidence small talk', () => {
    const warm = blendMood(NEUTRAL_MOOD, scoreText('wonderful, amazing, I love it'), 1)
    let cooled = warm
    for (let i = 0; i < 25; i += 1) cooled = blendMood(cooled, scoreText('the shelf is there'), 1)
    expect(cooled.valence).toBeLessThan(warm.valence)
    expect(Math.abs(cooled.valence)).toBeLessThan(0.25)
  })

  it('never leaves the plane', () => {
    let mood = NEUTRAL_MOOD
    for (let i = 0; i < 200; i += 1) {
      mood = blendMood(mood, scoreText('WOW AMAZING INCREDIBLE!!!'), 1)
    }
    expect(mood.valence).toBeLessThanOrEqual(1)
    expect(mood.arousal).toBeLessThanOrEqual(1)
    expect(mood.arousal).toBeGreaterThanOrEqual(0)
  })
})

describe('deriveEmotion', () => {
  it.each([
    ['haha that is wonderful, I love it', 'happy'],
    ['sorry, this is hard and I am worried', 'concerned'],
    ['why does it do that?', 'curious'],
  ])('reads %j as %s', (text, expected) => {
    expect(deriveEmotion(text)).toBe(expected)
  })

  it('falls back to neutral when a message says nothing in particular', () => {
    expect(deriveEmotion('the shelf')).toBe('neutral')
  })
})

describe('moodPalette', () => {
  const warmth = (mood: { valence: number; arousal: number }) => {
    const { crest } = moodPalette(mood)
    return crest[0] - crest[2]
  }

  it('lands on the anchor palette when the mood sits on an anchor', () => {
    // The kernel has to be sharp enough that being *at* happy actually looks
    // happy rather than like the average of all six palettes.
    expect(warmth(ANCHORS.happy)).toBeGreaterThan(0.35)
    expect(warmth(ANCHORS.focused)).toBeLessThan(-0.4)
  })

  it('moves continuously between anchors', () => {
    const midpoint = {
      valence: (ANCHORS.happy.valence + ANCHORS.curious.valence) / 2,
      arousal: (ANCHORS.happy.arousal + ANCHORS.curious.arousal) / 2,
    }
    const mid = warmth(midpoint)
    expect(mid).toBeLessThan(warmth(ANCHORS.happy))
    expect(mid).toBeGreaterThan(warmth(ANCHORS.curious))
  })

  it('warms up over a cheerful conversation', () => {
    const mood = converse([
      ['haha that is wonderful, I love this, amazing work!', 0.9],
      ["Thanks so much! That's really kind of you to say.", 1],
      ['yes! brilliant, I love it, so glad, amazing!', 0.9],
    ])
    expect(moodToEmotion(mood)).toBe('happy')
    expect(warmth(mood)).toBeGreaterThan(warmth(NEUTRAL_MOOD))
    expect(warmth(mood)).toBeGreaterThan(0.2)
  })

  it('keeps every channel dark enough to carry white text', () => {
    for (const anchor of Object.values(ANCHORS)) {
      const { body, base } = moodPalette(anchor)
      expect(Math.max(...body)).toBeLessThan(0.42)
      expect(Math.max(...base)).toBeLessThan(0.1)
    }
  })
})

describe('emotionForTurn', () => {
  const heavy = 'I am sorry, today has been really hard and I feel worried and exhausted and lost'
  const comfort =
    "I'm right here with you. That weight you're carrying — it's okay to set it down for a " +
    "moment. You don't have to figure everything out right now. Just breathing is enough."

  it('keeps the weight of what was said when the reply is comforting', () => {
    // Scoring the two strings joined together lets a long, calm reply outvote a
    // short heavy sentence, and the face brightens at the worst moment.
    expect(emotionForTurn(heavy, comfort)).toBe('concerned')
    expect(deriveEmotion(`${heavy} ${comfort}`)).not.toBe('concerned')
  })

  it('still follows the reply when the person said little', () => {
    expect(emotionForTurn('ok', 'That is wonderful news, I love it, so glad!')).toBe('happy')
  })

  it('stays neutral when neither side said anything in particular', () => {
    expect(emotionForTurn('', '')).toBe('neutral')
  })
})

describe('SPEAKER_WEIGHT', () => {
  it('lets the person move the room further than the reply does', () => {
    const sample = scoreText('sorry, this is hard and I feel lost')
    const fromUser = blendMood(NEUTRAL_MOOD, sample, SPEAKER_WEIGHT.user)
    const fromReply = blendMood(NEUTRAL_MOOD, sample, SPEAKER_WEIGHT.assistant)
    expect(fromUser.valence).toBeLessThan(fromReply.valence)
  })

  it('holds a sad turn sad even after a warm answer', () => {
    const heavy = scoreText('sorry, today has been hard, I feel worried and exhausted and lost')
    const warm = scoreText('I am right here with you and it is okay to rest, that is enough')
    const mood = blendMood(
      blendMood(NEUTRAL_MOOD, heavy, SPEAKER_WEIGHT.user),
      warm,
      SPEAKER_WEIGHT.assistant,
    )
    expect(mood.valence).toBeLessThan(-0.15)
  })
})

describe('nudgeMood', () => {
  it('pulls toward a feeling the words never said', () => {
    const nudged = nudgeMood(NEUTRAL_MOOD, 'concerned', 0.5)
    expect(nudged.valence).toBeLessThan(NEUTRAL_MOOD.valence)
    expect(nudged.valence).toBeGreaterThan(ANCHORS.concerned.valence)
  })
})
