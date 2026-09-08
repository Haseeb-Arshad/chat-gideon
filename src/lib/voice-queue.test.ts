import { describe, expect, it } from 'vitest'
import { splitSpeakable } from './voice-queue'

const texts = (value: string, options?: { flush?: boolean; first?: boolean }) =>
  splitSpeakable(value, options).chunks.map((chunk) => chunk.text)

describe('splitSpeakable', () => {
  it('holds an incomplete sentence back until it can be spoken well', () => {
    const result = splitSpeakable('The ocean is', { first: true })
    expect(result.chunks).toEqual([])
    expect(result.remainder).toBe('The ocean is')
  })

  it('releases a sentence as soon as it closes', () => {
    expect(texts('The ocean is deep. And it is', { first: true })).toEqual([
      'The ocean is deep.',
    ])
  })

  it('cuts the opening chunk at a clause so speech can start sooner', () => {
    const opening =
      'There is something genuinely strange about the deep ocean, and it took decades to understand why that is.'
    const [first] = texts(opening, { first: true })
    expect(first.length).toBeLessThanOrEqual(96)
    expect(first.endsWith(',')).toBe(true)
  })

  it('gives later chunks a longer budget than the opening one', () => {
    const long = `${'word '.repeat(70)}end`
    const opening = texts(long, { first: true })[0]
    const later = texts(long)[0]
    expect(later.length).toBeGreaterThan(opening.length)
  })

  it('reports where each chunk ends so captions can track the voice', () => {
    const value = 'One. Two. Three.'
    const { chunks } = splitSpeakable(value, { flush: true })
    expect(chunks.map((chunk) => chunk.text)).toEqual(['One.', 'Two.', 'Three.'])
    expect(chunks.at(-1)?.end).toBe(value.length)
  })

  it('flushes the trailing fragment when the reply is complete', () => {
    expect(texts('All done', { flush: true })).toEqual(['All done'])
    expect(splitSpeakable('All done', { flush: true }).remainder).toBe('')
  })

  it('always consumes input so a chunkless buffer cannot spin', () => {
    const value = 'x'.repeat(600)
    const { chunks, remainder } = splitSpeakable(value)
    expect(chunks.length).toBeGreaterThan(0)
    expect(remainder.length).toBeLessThan(value.length)
  })

  it('treats whitespace-only input as nothing to say', () => {
    expect(texts('   \n  ', { flush: true })).toEqual([])
  })
})
