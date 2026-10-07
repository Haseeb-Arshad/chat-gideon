import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  queries: [] as { sql: string; values: unknown[] }[],
}))

vi.mock('pg', () => ({
  Client: class {
    on() { return this }
    async connect() { return undefined }
    async end() { return undefined }
    async query(sql: string, values: unknown[] = []) {
      db.queries.push({ sql, values })
      return sql.includes('RETURNING id')
        ? { rows: [{ id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    }
  },
}))

import { createWorkerInteractionAudit } from './audit'
import type { Env } from './types'

function env(overrides: Partial<Env> = {}): Env {
  return {
    GIDEON_SESSION: {} as Env['GIDEON_SESSION'],
    GIDEON_AUDIT_ENABLED: '1',
    GIDEON_AUDIT_REQUIRED: '1',
    HYPERDRIVE: { connectionString: 'postgresql://worker:test@localhost/db' } as Hyperdrive,
    ...overrides,
  }
}

describe('Worker interaction audit', () => {
  beforeEach(() => { db.queries = [] })

  it('stores the submitted request before model work and hashes the browser grouping key', async () => {
    const auditFactory = createWorkerInteractionAudit({
      env: env(), owner: 'user/verified-1', sessionKey: 'browser-session-secret', channel: 'http',
    })
    expect(auditFactory).not.toBeNull()
    const audit = await auditFactory!.startTurn({
      clientTurnId: 'client-turn-1',
      messages: [{ role: 'user', content: 'Please check this claim.' }],
    })

    const conversation = db.queries.find((item) => item.sql.includes('gideon_conversations'))!
    expect(conversation.values[0]).toBe('user/verified-1')
    expect(conversation.values[1]).toMatch(/^[0-9a-f]{64}$/u)
    expect(conversation.values).not.toContain('browser-session-secret')
    expect(db.queries.filter((item) => item.sql.includes('gideon_interaction_events'))).toHaveLength(2)
    expect(audit?.turnId).toMatch(/^[0-9a-f-]{36}$/u)
    await audit?.finish('cancelled')
    expect(db.queries.some((item) => item.values.includes('submitted_messages'))).toBe(true)
    expect(db.queries.some((item) => item.values.includes('turn_finished'))).toBe(true)
  })

  it('persists provider usage, tool evidence and the complete answer in sequence', async () => {
    const factory = createWorkerInteractionAudit({ env: env(), owner: 'user/audit', sessionKey: 's', channel: 'http' })!
    const audit = await factory.startTurn({ clientTurnId: 'turn', messages: [{ role: 'user', content: 'Search for a source.' }] })
    audit!.record('provider_response', { round: 0, model: 'vendor/model', usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.001 } })
    await audit!.flush()
    audit!.record('tool_call', { name: 'research', arguments: { question: 'Search for a source.' } })
    audit!.record('tool_result', { name: 'research', ok: true, content: 'Found one source.', links: [{ title: 'Source', url: 'https://example.com' }] })
    await audit!.flush()
    audit!.record('assistant_message', { responseId: 'server-response', text: 'The source supports the claim.' })
    await audit!.flush()
    await audit!.finish('completed')

    const events = db.queries.filter((item) => item.sql.includes('gideon_interaction_events'))
    const types = events.map((item) => item.values[4])
    expect(types).toEqual(expect.arrayContaining(['provider_response', 'tool_call', 'tool_result', 'assistant_message', 'turn_finished']))
    expect(events.some((item) => JSON.stringify(item.values).includes('https://example.com'))).toBe(true)
    expect(events.some((item) => JSON.stringify(item.values).includes('prompt_tokens'))).toBe(true)
  })

  it('stores the actual audio bytes with their hash, transcript and provider model', async () => {
    const factory = createWorkerInteractionAudit({ env: env(), owner: 'user/voice', sessionKey: 's', channel: 'http' })!
    const audio = Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4])
    const assetId = await factory.recordVoice({ clientTurnId: 'voice-1', audio, mime: 'audio/wav', source: 'user' })
    await factory.updateVoiceTranscript(assetId, 'I said this aloud.', 'test-stt')

    const inserted = db.queries.find((item) => item.sql.includes('INSERT INTO public.gideon_voice_assets'))!
    expect(inserted.values[4]).toBe('user')
    expect(inserted.values[5]).toBe('audio/wav')
    expect(inserted.values[6]).toBe(audio.byteLength)
    expect(inserted.values[7]).toMatch(/^[0-9a-f]{64}$/u)
    expect(inserted.values[9]).toEqual(audio)
    const updated = db.queries.find((item) => item.sql.includes('SET transcript ='))!
    expect(updated.values.slice(0, 2)).toEqual(['I said this aloud.', 'test-stt'])
  })

  it('refuses a required audit configuration without Hyperdrive', () => {
    expect(() => createWorkerInteractionAudit({
      env: env({ HYPERDRIVE: undefined }), owner: 'user/no-db', sessionKey: 's', channel: 'http',
    })).toThrow('Conversation audit storage is unavailable')
  })

  it('refuses a required audit configuration when audit itself is disabled', () => {
    expect(() => createWorkerInteractionAudit({
      env: env({ GIDEON_AUDIT_ENABLED: '0' }), owner: 'user/no-audit', sessionKey: 's', channel: 'http',
    })).toThrow('Required conversation audit is disabled')
  })
})
