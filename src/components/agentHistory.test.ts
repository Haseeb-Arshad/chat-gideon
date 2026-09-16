import { describe, expect, it } from 'vitest'
import { INTERRUPTED } from './agentHistory'

describe('literal interrupted history marker', () => {
  it.each(['interrupted', 'read', 'repeat', 'quiet', 'sure', 'yes', 'a result', 'INTERRUPTED'])('preserves ordinary ending %s', (text) => {
    expect(INTERRUPTED.test(text)).toBe(false)
    expect(text.replace(INTERRUPTED, '')).toBe(text)
  })
  it('removes only the literal trailing marker and preceding whitespace', () => {
    expect('Words heard [interrupted]'.replace(INTERRUPTED, '')).toBe('Words heard')
    expect(INTERRUPTED.test('[interrupted]')).toBe(true)
    expect(INTERRUPTED.test('[interrupted] still talking')).toBe(false)
  })
})
