import { describe, expect, it, vi } from 'vitest'
import { TimedCache } from './cache'

describe('shared cache lifecycle', () => {
  it('first caller abort cancels only its wait; second and later callers keep the result', async () => {
    const cache = new TimedCache<number>(1000)
    let finish!: (value: number) => void
    let upstream!: AbortSignal
    const load = vi.fn((signal: AbortSignal) => { upstream = signal; return new Promise<number>((resolve) => { finish = resolve }) })
    const first = new AbortController()
    const second = new AbortController()
    const a = cache.getShared('key', load, first.signal, 1000)
    const b = cache.getShared('key', load, second.signal, 1000)
    const aborted = expect(a).rejects.toMatchObject({ name: 'AbortError' })
    first.abort()
    await aborted
    expect(upstream.aborted).toBe(false)
    finish(42)
    expect(await b).toBe(42)
    expect(await cache.getShared('key', load, second.signal, 1000)).toBe(42)
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('does not load for an already-aborted caller and evicts failures for retry', async () => {
    const cache = new TimedCache<number>(1000)
    const load = vi.fn(async () => { throw new Error('failed') })
    await expect(cache.getShared('key', load, AbortSignal.abort(), 1000)).rejects.toBeDefined()
    expect(load).not.toHaveBeenCalled()
    await expect(cache.getShared('key', load, new AbortController().signal, 1000)).rejects.toThrow('failed')
    expect(await cache.getShared('key', async () => 42, new AbortController().signal, 1000)).toBe(42)
  })
})
