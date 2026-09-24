// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { InspectorItem, InspectorOverview } from '../lib/memory/controls'
import { MemoryInspector } from './MemoryInspector'

vi.mock('../lib/backend', () => ({ ensureAccount: vi.fn(async () => 'ready') }))
afterEach(cleanup)

const settings = { revision: 1, learningEnabled: true, temporaryUntil: null, temporaryActive: false, evidenceRetentionDays: null }

function item(overrides: Partial<InspectorItem> = {}): InspectorItem {
  return {
    assertionId: 'assertion/cmd/1', revision: 1, kind: 'preference', text: 'I prefer tea', status: 'accepted', basis: 'explicit',
    basisDetail: 'explicit_user_statement', producer: 'explicit-command', polarity: 'positive',
    scope: { kind: 'general', label: 'everywhere', conditions: [] }, relation: 'ordinary',
    validTime: { from: null, until: null, precision: 'unknown', sourceTimeZone: null }, freshness: 'current',
    receivedAt: '2026-09-20T10:00:00.000Z', interpretedAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
    proposedReason: null, sources: { count: 1, shown: [], gap: null }, conflict: { disputed: false, contradicting: 0 }, revisions: 1,
    ...overrides,
  }
}

function overview(extra: Partial<InspectorOverview> = {}): InspectorOverview {
  return {
    counts: { accepted: 1, proposed: 1, disputed: 0, topics: 0 },
    preferences: [item()], facts: [], decisions: [], topics: [],
    proposed: [item({ assertionId: 'assertion/learned/2', text: 'Keep it short', status: 'candidate', basis: 'inferred', proposedReason: 'inferred_from_instruction', scope: { kind: 'task', label: 'one task only', conditions: [] } })],
    recentChanges: [], settings, ...extra,
  }
}

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown }
let handler: Handler
const calls: { url: string; body: unknown }[] = []

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body })
    const result = handler(url, init)
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
})

function ready(extra: Handler = () => ({ status: 404, body: { ok: false, error: { code: 'x', message: 'unexpected', retryable: false } } })): Handler {
  return (url, init) => {
    if (url.includes('view=status')) return { body: { ok: true, enabled: true, settings } }
    if (url.includes('view=overview')) return { body: { ok: true, overview: overview() } }
    if (url.includes('view=items')) return { body: { ok: true, page: { items: [item()], nextCursor: null } } }
    return extra(url, init)
  }
}

it('explains an unavailable memory without claiming nothing is remembered, and retries', async () => {
  let failing = true
  handler = (url) => failing
    ? { status: 503, body: { ok: false, error: { code: 'unavailable', message: 'Memory is unavailable right now.', retryable: true } } }
    : ready()(url)
  const view = render(<MemoryInspector />)
  const alert = await view.findByRole('alert')
  expect(alert.textContent).toContain('Memory is unavailable right now.')
  expect(view.getByText('This does not mean anything was forgotten.')).toBeTruthy()
  failing = false
  fireEvent.click(view.getByRole('button', { name: /Try again/u }))
  expect(await view.findByRole('heading', { name: 'At a glance' })).toBeTruthy()
})

it('offers to turn memory on when it is off, and only then loads the inspector', async () => {
  let enabled = false
  handler = (url, init) => {
    if (url.includes('view=status')) return { body: enabled ? { ok: true, enabled: true, settings } : { ok: true, enabled: false } }
    if (init?.method === 'POST') { enabled = true; return { body: { ok: true, settings } } }
    return ready()(url, init)
  }
  const view = render(<MemoryInspector />)
  fireEvent.click(await view.findByRole('button', { name: /Turn on memory/u }))
  expect(await view.findByRole('heading', { name: 'At a glance' })).toBeTruthy()
  expect(calls.find((call) => call.body)?.body).toEqual({ op: 'enable' })
})

it('shows basis, scope and proposed status, and labels controls with their real effect', async () => {
  handler = ready()
  const view = render(<MemoryInspector />)
  await view.findByRole('heading', { name: 'At a glance' })
  expect(view.getAllByText('You said this').length).toBeGreaterThan(0)
  expect(view.getByText('Proposed — not used yet')).toBeTruthy()
  expect(view.getByText(/Asked once for a task/u)).toBeTruthy()
  const learning = view.getByRole('switch', { name: 'Learn from conversations' })
  expect((learning as HTMLInputElement).checked).toBe(true)
  expect(view.getByText(/Nothing already remembered is deleted, and "remember this" still works/u)).toBeTruthy()
  expect(view.getByRole('combobox', { name: /Keep conversation turns/u })).toBeTruthy()
  expect(view.getByRole('tablist', { name: 'Filter memories' })).toBeTruthy()
})

it('a stale edit shows the current wording and saves nothing', async () => {
  handler = ready((url, init) => {
    if (init?.method === 'POST') return { status: 409, body: { ok: false, error: { code: 'conflict', message: 'changed', retryable: true, details: { currentRevision: 2 } } } }
    if (url.includes('view=item')) return { body: { ok: true, detail: { item: item({ revision: 2, text: 'I prefer green tea' }), history: [], sources: [], decisions: [] } } }
    return { status: 404, body: { ok: false, error: { code: 'x', message: 'x', retryable: false } } }
  })
  const view = render(<MemoryInspector />)
  await view.findByRole('heading', { name: 'At a glance' })
  const card = view.getAllByRole('button', { name: 'Edit: I prefer tea' })[0]!.closest('li')!
  fireEvent.click(within(card).getByRole('button', { name: 'Edit: I prefer tea' }))
  fireEvent.change(within(card).getByLabelText('New wording'), { target: { value: 'I prefer coffee' } })
  fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
  const alert = await within(card).findByRole('alert')
  expect(alert.textContent).toContain('nothing was saved')
  expect(within(card).getByText('I prefer green tea')).toBeTruthy()
  const posted = calls.find((call) => call.body)?.body as Record<string, unknown>
  expect(posted).toMatchObject({ op: 'edit', expectedRevision: 1, text: 'I prefer coffee', change: 'mistake' })
  expect(String(posted.requestId)).toMatch(/^[A-Za-z0-9_-]{8,64}$/u)
})

it('forget asks first, then reports the logical block and cleanup separately', async () => {
  handler = ready((url, init) => {
    if (init?.method === 'POST') return { body: { ok: true, forget: { deletionId: 'deletion/1', physical: { status: 'pending' } } } }
    if (url.includes('view=deletion')) return { body: { ok: true, status: { physical: { status: 'complete' } } } }
    return { status: 404, body: { ok: false, error: { code: 'x', message: 'x', retryable: false } } }
  })
  const view = render(<MemoryInspector />)
  await view.findByRole('heading', { name: 'At a glance' })
  const card = view.getAllByRole('button', { name: 'Forget: I prefer tea' })[0]!.closest('li')!
  fireEvent.click(within(card).getByRole('button', { name: 'Forget: I prefer tea' }))
  expect(calls.some((call) => call.body)).toBe(false)
  fireEvent.click(within(card).getByRole('button', { name: 'Forget' }))
  await waitFor(() => expect(view.getAllByText('Forgotten').length).toBeGreaterThan(0))
  expect(view.getAllByText(/Cleanup of stored copies is in progress/u).length).toBeGreaterThan(0)
  expect(view.getAllByText(/Copies you downloaded earlier are not affected/u).length).toBeGreaterThan(0)
})
