// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Lightbox } from './stage/Lightbox'
import { StageShelf } from './StageShelf'
import type { StageEntry } from './stage/Stage'
import { fromLegacy } from '../lib/cards/legacy'

vi.mock('@posthog/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }))
afterEach(cleanup)

it('contains lightbox focus, preserves interior tabbing and restores the opener', () => {
  const opener = document.createElement('button')
  document.body.appendChild(opener)
  opener.focus()
  const picture = { url: 'https://example.com/a.jpg', thumb: 'https://example.com/t.jpg', alt: 'Picture', host: 'example.com', pageUrl: 'https://example.com' }
  const onClose = vi.fn()
  const view = render(<Lightbox pictures={[picture, { ...picture, alt: 'Second' }]} index={0} onStep={vi.fn()} onClose={onClose} />)
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Close picture' }))
  expect(opener.inert).toBe(true)
  const interior = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  document.activeElement!.dispatchEvent(interior)
  expect(interior.defaultPrevented).toBe(false)
  view.getByRole('button', { name: 'Next picture' }).focus()
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
  expect(document.activeElement).toBe(view.getByRole('link'))
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Next picture' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
  view.unmount()
  expect(opener.inert).toBeFalsy()
  expect(document.activeElement).toBe(opener)
  opener.remove()
})

it('makes every retained card reachable through the shelf overflow', () => {
  const entries: StageEntry[] = Array.from({ length: 9 }, (_, index) => ({
    id: String(index), query: 'test', hint: 'web', leaving: false,
    card: fromLegacy({ kind: 'entity', query: 'test', title: `Card ${index}`, subtitle: '', summary: 'A fact', figure: null, kicker: '', facts: [], image: null, pictures: [], sources: [] }),
  }))
  const onShow = vi.fn()
  const view = render(<StageShelf entries={entries} onShow={onShow} />)
  expect(view.queryByRole('button', { name: 'Bring back Card 0' })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Show 4 older cards' }))
  for (const entry of entries) {
    fireEvent.click(view.getByRole('button', { name: `Bring back Card ${entry.id}` }))
    expect(onShow).toHaveBeenLastCalledWith(entry.id)
  }
})
