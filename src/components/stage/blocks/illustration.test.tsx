// @vitest-environment jsdom
import { cleanup, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Illustration } from './Illustration'
import type { IllustrationBlock } from '../../../lib/cards/schema'
const block: IllustrationBlock = { id: 'drawing', slot: 'body', type: 'illustration', title: 'Balance', summary: 'Illustrative model', html: '<svg viewBox="0 0 600 380"></svg>' }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('uses an opaque origin, no referrer and a source-checked render receipt', () => {
  const view = render(<Illustration block={block} front />)
  const frame = view.container.querySelector('iframe')!
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(screen.getByRole('button', { name: 'Save HTML' }).hasAttribute('disabled')).toBe(true)
  const channel = frame.srcdoc.match(/const channel="([^"]+)"/)![1]
  act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'gideon-illustration', channel, state: 'ready' } })))
  expect(screen.getByRole('status')).toBeTruthy()
  act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data: { type: 'gideon-illustration', channel, state: 'ready' } })))
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('button', { name: 'Save HTML' }).hasAttribute('disabled')).toBe(false)
  view.rerender(<Illustration block={block} front={false} />)
  expect(view.container.querySelector('iframe')).toBeNull()
})
it('removes a failed document, attempts one refinement and presents recovery when that fails', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn(async () => new Response('{}', { status: 503 }))
  vi.stubGlobal('fetch', fetcher)
  const view = render(<Illustration block={block} front />)
  await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve() })
  expect(screen.getByRole('alert').textContent).toContain('could not run')
  expect(view.container.querySelector('iframe')).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('reopens a corrected fragment and limits automatic refinement to one attempt', async () => {
  const fetcher = vi.fn(async () => Response.json({ block: { ...block, html: '<svg><circle r="2"/></svg>' } }))
  vi.stubGlobal('fetch', fetcher)
  const view = render(<Illustration block={block} front />)
  const fail = () => {
    const frame = view.container.querySelector('iframe')!
    const channel = frame.srcdoc.match(/const channel="([^"]+)"/)![1]
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow!, data: { type: 'gideon-illustration', channel, state: 'error', detail: 'Geometry error' } }))
  }
  await act(async () => { fail(); await Promise.resolve() })
  expect(view.container.querySelector('iframe')!.srcdoc).toContain('<circle r="2"/>')
  act(fail)
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(fetcher).toHaveBeenCalledTimes(1)
})
