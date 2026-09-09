import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientToolRunner, describeDuration, safeUrl, type Timer } from './client-tools'

describe('safeUrl', () => {
  it('accepts http and https', () => {
    expect(safeUrl('https://example.com/page')).toBe('https://example.com/page')
    expect(safeUrl('http://example.com')).toBe('http://example.com/')
  })

  it('refuses schemes that execute or embed', () => {
    // The whole reason this is a whitelist: a rendered link carries GIDEON's
    // apparent endorsement, so anything but plain web navigation is refused.
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeUrl('file:///etc/passwd')).toBeNull()
    expect(safeUrl('vbscript:msgbox')).toBeNull()
  })

  it('refuses anything that is not an absolute URL', () => {
    expect(safeUrl('example.com')).toBeNull()
    expect(safeUrl('/relative/path')).toBeNull()
    expect(safeUrl('   ')).toBeNull()
  })
})

describe('describeDuration', () => {
  it('speaks a duration the way a person would', () => {
    expect(describeDuration(30)).toBe('30 seconds')
    expect(describeDuration(60)).toBe('1 minute')
    expect(describeDuration(600)).toBe('10 minutes')
    expect(describeDuration(3_600)).toBe('1 hour')
    expect(describeDuration(5_400)).toBe('1 hour and 30 minutes')
  })
})

describe('ClientToolRunner', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sets a timer and fires it once the time has passed', async () => {
    const fired: Timer[] = []
    const runner = new ClientToolRunner({ onTimerFired: (timer) => fired.push(timer) })

    const result = await runner.run('set_timer', { seconds: 120, label: 'the pasta' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('2 minutes')
    expect(result.content).toContain('the pasta')

    vi.advanceTimersByTime(119_000)
    expect(fired).toHaveLength(0)
    vi.advanceTimersByTime(2_000)
    expect(fired).toHaveLength(1)
    expect(fired[0].label).toBe('the pasta')
  })

  it('refuses a timer that is absurd in either direction', async () => {
    const runner = new ClientToolRunner()
    expect((await runner.run('set_timer', { seconds: 0 })).ok).toBe(false)
    expect((await runner.run('set_timer', { seconds: 900_000 })).ok).toBe(false)
    expect((await runner.run('set_timer', {})).ok).toBe(false)
  })

  it('coerces a numeric string, since arguments arrive as loose JSON', async () => {
    const runner = new ClientToolRunner()
    expect((await runner.run('set_timer', { seconds: '90' })).ok).toBe(true)
  })

  it('offers a valid link and reports what is on screen', async () => {
    const offered: string[] = []
    const runner = new ClientToolRunner({ onLinkOffered: (link) => offered.push(link.url) })
    const result = await runner.run('offer_link', {
      url: 'https://example.com/docs',
      title: 'The docs',
    })
    expect(result.ok).toBe(true)
    expect(offered).toEqual(['https://example.com/docs'])
  })

  it('falls back to the hostname when no title is given', async () => {
    const offered: Array<{ title: string }> = []
    const runner = new ClientToolRunner({ onLinkOffered: (link) => offered.push(link) })
    await runner.run('offer_link', { url: 'https://example.com/docs' })
    expect(offered[0].title).toBe('example.com')
  })

  it('shows nothing at all for an unsafe link', async () => {
    const offered: string[] = []
    const runner = new ClientToolRunner({ onLinkOffered: (link) => offered.push(link.url) })
    const result = await runner.run('offer_link', { url: 'javascript:alert(1)', title: 'Click me' })
    expect(result.ok).toBe(false)
    expect(offered).toEqual([])
  })

  it('reports an unknown tool rather than throwing', async () => {
    expect((await new ClientToolRunner().run('rm_rf', {})).ok).toBe(false)
  })

  it('cancels outstanding timers when disposed', async () => {
    const fired: Timer[] = []
    const runner = new ClientToolRunner({ onTimerFired: (timer) => fired.push(timer) })
    await runner.run('set_timer', { seconds: 10 })
    expect(runner.pendingTimers).toBe(1)

    runner.dispose()
    vi.advanceTimersByTime(60_000)
    expect(fired).toHaveLength(0)
    expect(runner.pendingTimers).toBe(0)
  })

  it('refuses to run anything after disposal', async () => {
    const runner = new ClientToolRunner()
    runner.dispose()
    expect((await runner.run('set_timer', { seconds: 30 })).ok).toBe(false)
  })
})
