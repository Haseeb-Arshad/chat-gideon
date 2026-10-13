import { expect, it } from 'vitest'
import { illustrationRequested } from './intent'
it('accepts explicit drawings, accepted offers and revisions without treating narrative imagery as a request', () => {
  const user = (content: string) => [{ role: 'user', content }]
  expect(illustrationRequested(user('Draw a lock opening'))).toBe(true)
  expect(illustrationRequested(user('/anatomy explain a thermostat'))).toBe(true)
  expect(illustrationRequested(user('Picture this: a quiet island'))).toBe(false)
  expect(illustrationRequested(user('Explain a thermostat'))).toBe(false)
  expect(illustrationRequested([{ role: 'assistant', content: 'Would an interactive drawing help?' }, ...user('Yes please')])).toBe(true)
  expect(illustrationRequested(user('Make the spring red'), { front: 'spring', cards: [{ id: 'spring', kind: 'illustration' }] })).toBe(true)
})
