import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/** The second host, run as a real separate process and restarted, as a fresh user would. */

const directory = mkdtempSync(join(tmpdir(), 'gideon-visitor-notes-'))
const root = resolve(import.meta.dirname, '../../..')
const secret = 'test-secret-that-is-long-enough-000000'
const running: ChildProcess[] = []

afterAll(() => {
  for (const child of running) child.kill()
  rmSync(directory, { recursive: true, force: true })
})

function start(): Promise<{ url: string; stop(): Promise<void> }> {
  const child = spawn(process.execPath, ['--no-warnings', resolve(root, 'node_modules/jiti/lib/jiti-cli.mjs'), resolve(import.meta.dirname, '../examples/visitor-notes/main.ts')], {
    env: { ...process.env, NOTES_DATA: join(directory, 'notes.db'), NOTES_SECRET: secret }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  running.push(child)
  return new Promise((ready, fail) => {
    let out = ''
    child.stdout!.on('data', (chunk) => {
      out += chunk
      const match = /listening (http:\/\/\S+)/u.exec(out)
      if (match) ready({ url: match[1]!, stop: () => new Promise((done) => { child.once('exit', () => done()); child.kill() }) })
    })
    child.once('exit', (code) => fail(new Error(`example exited ${code}`)))
  })
}

async function session(url: string): Promise<string> {
  const response = await fetch(`${url}/session`, { method: 'POST' })
  return (response.headers.get('set-cookie') ?? '').split(';')[0]!
}

describe('second host: visitor notes (no ChatGideon code)', () => {
  it('keeps each verified visitor separate, shares only published notes, and survives a restart', async () => {
    const first = await start()
    const alice = await session(first.url)
    const bob = await session(first.url)
    const saved = await (await fetch(`${first.url}/notes`, { method: 'POST', headers: { cookie: alice, 'x-request-id': 'n1' }, body: JSON.stringify({ text: 'My order number is 55120' }) })).json() as { result: { item: { id: string } } }
    expect(saved.result.item.id).toMatch(/^mem_/u)
    const bobAsks = await (await fetch(`${first.url}/ask?q=order%20number`, { headers: { cookie: bob } })).json() as { result: { mine: unknown[]; site: unknown[] } }
    expect(bobAsks.result.mine).toEqual([])
    const hours = await (await fetch(`${first.url}/ask?q=opening%20hours%20weekdays`, { headers: { cookie: bob } })).json() as { result: { site: { text: string }[] } }
    expect(hours.result.site.map((item) => item.text)).toContain('The shop is open from 9 to 5 on weekdays')
    // No session, a forged one, or a visitor trying to forget someone else's note: all refused.
    expect((await fetch(`${first.url}/notes`)).status).toBe(401)
    expect((await fetch(`${first.url}/notes`, { headers: { cookie: `visitor=v1.${'a'.repeat(32)}.${'b'.repeat(43)}` } })).status).toBe(401)
    expect((await fetch(`${first.url}/notes/${saved.result.item.id}?revision=1`, { method: 'DELETE', headers: { cookie: bob } })).status).toBe(404)
    await first.stop()

    const second = await start()
    const afterRestart = await (await fetch(`${second.url}/notes`, { headers: { cookie: alice } })).json() as { result: { items: { text: string }[] } }
    expect(afterRestart.result.items.map((item) => item.text)).toEqual(['My order number is 55120'])
    // Publishing again at startup is idempotent: still two published notes, not four.
    const site = await (await fetch(`${second.url}/ask?q=shop%20open%20returns%20receipt`, { headers: { cookie: bob } })).json() as { result: { site: unknown[] } }
    expect(site.result.site).toHaveLength(2)
    expect((await fetch(`${second.url}/notes/${saved.result.item.id}?revision=1`, { method: 'DELETE', headers: { cookie: alice } })).status).toBe(200)
    const gone = await (await fetch(`${second.url}/notes`, { headers: { cookie: alice } })).json() as { result: { items: unknown[] } }
    expect(gone.result.items).toEqual([])
    await second.stop()
  }, 60_000)
})
