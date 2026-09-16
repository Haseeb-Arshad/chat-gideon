import { describe, expect, it } from 'vitest'
import { grounded, knownNumbers } from './ground'

describe('quantity grounding', () => {
  it.each([
    ['-5°C', '5°C'], ['5°C', '-5°C'], ['−5°C', '+5°C'],
    ['$5 million', '$5 billion'], ['$5 million', '$5'],
    ['5 kg', '5 mg'], ['17°C', '17°F'], ['5%', '5'],
    ['$5', '€5'], ['700K vectors per second', '700K tokens per second'],
    ['700K vectors per second', '700K vectors per minute'],
  ])('rejects a changed quantity: %s -> %s', (source, candidate) => {
    expect(grounded(candidate, knownNumbers(source))).toBe(false)
  })

  it.each([
    ['−5°C', '-5°C'], ['$67,420.50', '$67,420'],
    ['700K vectors per second', '700 thousand vectors/s'],
    ['1\u202f879 people', '1,879 people'], ['1879–1955', '1879–1955'],
    ['2026-09-17', '2026-09-17'], ['5 percent', '5%'],
  ])('retains supported formatting and rounding: %s -> %s', (source, candidate) => {
    expect(grounded(candidate, knownNumbers(source))).toBe(true)
  })
})
