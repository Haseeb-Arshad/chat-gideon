import { describe, expect, it } from 'vitest'
import { SpokenText, spokenText } from './speech'

/** Feeds text through the streaming path one slice at a time. */
function stream(chunks: string[]): string {
  const s = new SpokenText()
  return `${chunks.map((chunk) => s.push(chunk)).join('')}${s.flush()}`
}

describe('spokenText', () => {
  it('turns an em dash into the comma it was standing in for', () => {
    expect(spokenText('No pressure either way—just wondering.')).toBe(
      'No pressure either way, just wondering.',
    )
  })

  it('handles the spaced form the models actually emit', () => {
    expect(spokenText('That weight you are carrying — it is okay to set it down.')).toBe(
      'That weight you are carrying, it is okay to set it down.',
    )
  })

  it('speaks a numeric range instead of reading a dash', () => {
    expect(spokenText('It takes 3–5 minutes.')).toBe('It takes 3 to 5 minutes.')
  })

  it('drops a dash that follows punctuation rather than doubling it', () => {
    expect(spokenText('Right. — So here is the thing.')).toBe('Right. So here is the thing.')
  })

  it('drops a leading dash', () => {
    expect(spokenText('—Anyway, it works.')).toBe('Anyway, it works.')
  })

  it('leaves ordinary hyphens alone', () => {
    expect(spokenText('It is a well-known state-of-the-art trade-off.')).toBe(
      'It is a well-known state-of-the-art trade-off.',
    )
  })

  it('leaves clean text untouched', () => {
    const text = 'Glad to hear it. What is on your mind?'
    expect(spokenText(text)).toBe(text)
  })

  it('collapses a run of dashes', () => {
    expect(spokenText('wait———what')).toBe('wait, what')
  })
})

describe('SpokenText streaming', () => {
  it('gives the same answer however the tokens are split', () => {
    const whole = 'No pressure either way—just wondering.'
    const splits = [
      ['No pressure either way', '—', 'just wondering.'],
      ['No pressure either way—', 'just wondering.'],
      ['No pressure either way', '—just wondering.'],
      ['No pressure either way ', '— ', 'just wondering.'],
      whole.split(''),
    ]
    for (const chunks of splits) {
      expect(stream(chunks)).toBe(spokenText(whole))
    }
  })

  it('does not lose a space that was held back at the end', () => {
    expect(stream(['Hello ', 'there'])).toBe('Hello there')
    expect(stream(['Hello', ' '])).toBe('Hello')
  })

  it('never drops a character that was not punctuation', () => {
    const text = 'The 1955 letter, formally, is about a 2–3 minute matter—no more than that.'
    const perChar = stream(text.split(''))
    expect(perChar).toBe(spokenText(text))
    expect(perChar).toContain('2 to 3 minute matter, no more')
  })

  it('handles an empty stream', () => {
    expect(stream([])).toBe('')
    expect(stream(['', ''])).toBe('')
  })

  it('keeps paragraph breaks rather than commaing them', () => {
    expect(spokenText('First line.\n\nSecond line.')).toBe('First line.\n\nSecond line.')
  })
})
