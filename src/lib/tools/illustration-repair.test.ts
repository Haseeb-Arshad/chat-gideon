import { afterEach, expect, it, vi } from 'vitest'
import { handleIllustrationRepair } from './illustration-repair'
import { handleApi } from '../../../backend/worker/src/api'
import { setRuntimeEnv } from '../runtime-env'
const source = { title: 'Model', summary: 'Illustrative model', html: '<svg></svg><script>broken()</script>', error: 'broken is not defined' }
const request = (body: unknown) => new Request('https://gideon.test/api/illustration-repair', { method: 'POST', headers: { Origin: 'https://gideon.test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
afterEach(() => { vi.unstubAllGlobals(); setRuntimeEnv(null) })
it('repairs through the same provider without executing the previous code and records the outcome', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...source, html: '<svg></svg><script>const repaired=true;</script>' }) } }] }))
  vi.stubGlobal('fetch', fetcher)
  const record = vi.fn()
  const response = await handleIllustrationRepair(request(source), name => name === 'OPENROUTER_API_KEY' ? 'test' : undefined, { record } as never)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ block: { type: 'illustration', html: expect.stringContaining('repaired') } })
  const sent = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
  expect(sent.messages[1].content).toContain('broken is not defined')
  expect(record).toHaveBeenCalledWith('illustration_repair_result', expect.objectContaining({ ok: true }))
})
it('rejects malformed input without a provider call', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  expect((await handleIllustrationRepair(request({ ...source, html: '<iframe></iframe>' }), () => undefined)).status).toBe(400)
  expect(fetcher).not.toHaveBeenCalled()
})
it('keeps the Worker method and required audit gates ahead of generation', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  const env = { GIDEON_AUDIT_REQUIRED: '1' } as never
  expect((await handleApi(new Request('https://gideon.test/api/illustration-repair'), env))?.status).toBe(405)
  expect((await handleApi(request(source), env))?.status).toBe(503)
  expect(fetcher).not.toHaveBeenCalled()
})
