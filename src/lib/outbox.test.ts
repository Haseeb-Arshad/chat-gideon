import { describe, expect, it } from 'vitest'
import { Outbox } from './outbox'

/** What is ready goes out in order, and waiting ends as soon as there is reason to stop. */

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe('Outbox', () => {
  it('sends what is ready in the order it became ready', () => {
    const outbox = new Outbox<string>()
    outbox.push('card')
    outbox.push('patch')
    expect([...outbox.drain()]).toEqual(['card', 'patch'])
    expect([...outbox.drain()]).toEqual([])
  })

  it('stops waiting the moment something is pushed', async () => {
    const outbox = new Outbox<string>()
    const work = deferred()
    outbox.track(work.promise)
    const waited = outbox.next(10_000)
    outbox.push('card')
    await waited
    expect([...outbox.drain()]).toEqual(['card'])
    expect(outbox.busy).toBe(true)
    work.resolve()
  })

  it('stops waiting when the last work settles, including work that failed', async () => {
    const outbox = new Outbox<string>()
    const failing = Promise.reject(new Error('the card could not be drawn'))
    outbox.track(failing)
    await outbox.next(10_000)
    expect(outbox.busy).toBe(false)
  })

  it('stops waiting at the deadline, and does not wait at all with nothing to wait for', async () => {
    const outbox = new Outbox<string>()
    await outbox.next(10_000)
    outbox.track(new Promise(() => undefined))
    const startedAt = Date.now()
    await outbox.next(20)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(outbox.busy).toBe(true)
  })
})
