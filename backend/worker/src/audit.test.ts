import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  queries: [] as { sql: string; values: unknown[] }[],
  connections: 0,
  /** Resolves each `connect`, so a test can hold the database back. */
  gate: null as Promise<void> | null,
  failConnect: 0,
  refuseAudio: false,
}))

vi.mock('pg', () => ({
  Client: class {
    on() { return this }
    async connect() {
      db.connections++
      if (db.gate) await db.gate
      if (db.failConnect > 0) { db.failConnect--; throw new Error('connection refused') }
    }
    async end() { return undefined }
    async query(sql: string, values: unknown[] = []) {
      if (db.refuseAudio && sql.includes('INSERT INTO public.gideon_voice_assets')) {
        throw Object.assign(new Error('value too long'), { code: '22001' })
      }
      db.queries.push({ sql, values })
      return sql.includes('RETURNING id')
        ? { rows: [{ id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 }
        : { rows: [], rowCount: 1 }
    }
  },
}))

import { createWorkerInteractionAudit, wavDurationMs } from './audit'
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

function factory(overrides: Partial<Parameters<typeof createWorkerInteractionAudit>[0]> = {}) {
  return createWorkerInteractionAudit({ env: env(), owner: 'user/audit', sessionKey: 's', channel: 'websocket', ...overrides })!
}

const inserted = (table: string) => db.queries.filter((query) => query.sql.includes(`INSERT INTO public.${table}`))
/** Event rows as [turn, sequence, type, payload], whichever INSERT carried them. */
function events() {
  return inserted('gideon_interaction_events').flatMap((query) => {
    const rows: { turn: unknown; sequence: unknown; type: unknown; payload: Record<string, unknown>; at: unknown }[] = []
    for (let offset = 0; offset + 7 <= query.values.length; offset += 7) {
      rows.push({ turn: query.values[offset + 2], sequence: query.values[offset + 3], type: query.values[offset + 4], payload: JSON.parse(query.values[offset + 5] as string), at: query.values[offset + 6] })
    }
    return rows
  })
}
/** The last row written for a turn, by column name. */
function turnRow() {
  const query = inserted('gideon_turns').at(-1)!
  const columns = query.sql.slice(query.sql.indexOf('(') + 1, query.sql.indexOf(')')).split(',').map((name) => name.trim())
  return Object.fromEntries(columns.map((name, index) => [name, query.values[index]]))
}

/** A PCM WAV header for `seconds` of 16 kHz mono 16-bit audio, with silence behind it. */
function wav(seconds: number): Uint8Array {
  const data = 32_000 * seconds
  const bytes = new Uint8Array(44 + data)
  const view = new DataView(bytes.buffer)
  const tag = (offset: number, text: string) => { for (let index = 0; index < 4; index++) bytes[offset + index] = text.charCodeAt(index) }
  tag(0, 'RIFF'); view.setUint32(4, 36 + data, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  tag(36, 'data'); view.setUint32(40, data, true)
  return bytes
}

describe('Worker interaction audit', () => {
  beforeEach(() => { db.queries = []; db.connections = 0; db.gate = null; db.failConnect = 0; db.refuseAudio = false })

  it('returns to the caller before the database has been reached at all', async () => {
    let open!: () => void
    db.gate = new Promise((resolve) => { open = resolve })
    const audit = factory()
    const turn = audit.startTurn({ clientTurnId: 'turn-1', messages: [{ role: 'user', content: 'Hello.' }] })!
    turn.record('provider_request', { round: 0 })
    const segment = audit.recordSpeech({ source: 'user', mime: 'audio/wav', audio: wav(1), text: 'Hello.' })
    turn.finish('completed')

    // Everything above ran to completion while the only connection is still held shut.
    expect(turn.turnId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(segment).toMatch(/^[0-9a-f-]{36}$/u)
    expect(db.queries).toEqual([])

    open()
    await audit.settled()
    expect(events().map((event) => event.type)).toEqual(['turn_started', 'submitted_messages', 'provider_request', 'turn_finished'])
    expect(inserted('gideon_voice_assets')).toHaveLength(1)
  })

  it('writes a streamed turn in a few batched statements rather than one per event', async () => {
    const audit = factory()
    const turn = audit.startTurn({ clientTurnId: 'batch', messages: [] })!
    for (let index = 0; index < 250; index++) turn.record('tool_progress', { index })
    await audit.settled()
    expect(inserted('gideon_interaction_events')).toHaveLength(3)
    expect(events().map((event) => event.sequence)).toEqual(Array.from({ length: 252 }, (_, index) => index + 1))
    expect(db.queries.some((query) => query.sql === 'BEGIN')).toBe(false)
  })

  it('stamps each event with when it happened, not when its batch was written', async () => {
    const audit = factory()
    const turn = audit.startTurn({ clientTurnId: 'timed', messages: [] })!
    const before = Date.now()
    turn.record('provider_request', { round: 0 })
    await audit.settled()
    const at = Date.parse(events().find((event) => event.type === 'provider_request')!.at as string)
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('hashes the browser grouping key and never stores it', async () => {
    const audit = factory({ owner: 'user/verified-1', sessionKey: 'browser-session-secret', channel: 'http' })
    audit.startTurn({ clientTurnId: 'client-turn-1', messages: [{ role: 'user', content: 'Please check this claim.' }] })
    await audit.settled()
    const conversation = db.queries.find((query) => query.sql.includes('gideon_conversations'))!
    expect(conversation.values[0]).toBe('user/verified-1')
    expect(conversation.values[1]).toMatch(/^[0-9a-f]{64}$/u)
    expect(JSON.stringify(db.queries)).not.toContain('browser-session-secret')
  })

  it('summarises a turn: its words, tokens, cost, tools, searches and cards', async () => {
    const audit = factory()
    const turn = audit.startTurn({ clientTurnId: 'turn', messages: [{ role: 'assistant', content: 'Hi.' }, { role: 'user', content: 'Who won?' }] })!
    turn.mark('setup', 4)
    turn.mark('first_token', 620)
    turn.record('provider_response', { round: 0, model: 'vendor/chat', usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001, prompt_tokens_details: { cached_tokens: 64 } } })
    turn.record('tool_call', { round: 0, callId: 'call-1', name: 'research', arguments: { question: 'Who won?' } })
    turn.record('research_search_request', { query: 'who won' })
    turn.record('research_search_request', { query: 'final score' })
    turn.record('research_page_read_request', { url: 'https://example.com' })
    turn.record('research_provider_response', { model: 'vendor/research', usage: { prompt_tokens: 40, completion_tokens: 20, cost: 0.002 } })
    turn.record('tool_result', { round: 0, callId: 'call-1', name: 'research', ok: true, content: 'They won.' })
    turn.record('card_result', { callId: 'call-1', card: { title: 'Final' } })
    turn.record('card_result', { callId: 'call-2', card: null })
    turn.record('provider_response', { round: 1, model: 'vendor/chat', usage: { prompt_tokens: 150, completion_tokens: 12, total_tokens: 162, cost: 0.0015 } })
    turn.record('assistant_message', { responseId: 'r', text: 'They won two nil.' })
    turn.finish('completed')
    await audit.settled()

    const row = turnRow()
    expect(row).toMatchObject({
      client_turn_id: 'turn', status: 'completed', user_text: 'Who won?', assistant_text: 'They won two nil.',
      model: 'vendor/chat', model_rounds: 2,
      prompt_tokens: 290, completion_tokens: 42, cached_tokens: 64, total_tokens: 332, cost_usd: '0.00450000',
      tool_calls: 1, searches: 2, pages_read: 1, cards: 1, first_token_ms: 620,
    })
    expect(JSON.parse(row.timings as string)).toMatchObject({ setup: 4, first_token: 620 })
    expect(JSON.parse(row.tools as string)).toEqual([expect.objectContaining({ name: 'research', ok: true, call: 'call-1' })])
    expect(JSON.parse(row.usage as string)).toHaveLength(3)
    // A turn that was not a guess was used by definition.
    expect(inserted('gideon_turns').at(-1)!.values.at(-1)).toBe(true)
  })

  it('places a recording on the timeline from its own length and ties it to the turn that answers it', async () => {
    const audit = factory()
    const endedAt = Date.parse('2026-10-13T10:00:03.000Z')
    const segment = audit.recordSpeech({ source: 'user', mime: 'audio/wav', audio: wav(3), text: 'What is the weather?', endedAt, metadata: { transcriptionModel: 'stt-1' } })
    const turn = audit.startTurn({ clientTurnId: 'answer', messages: [{ role: 'user', content: 'What is the weather?' }] })!
    await audit.settled()

    const asset = inserted('gideon_voice_assets')[0]
    expect(asset.values[4]).toBe('user')
    expect(asset.values[6]).toBe(wav(3).byteLength)
    expect(asset.values[7]).toMatch(/^[0-9a-f]{64}$/u)
    expect(asset.values[8]).toBe('What is the weather?')
    expect(asset.values[11]).toBe('stt-1')
    const stored = inserted('gideon_speech_segments')[0]
    expect(stored.values[0]).toBe(segment)
    expect(stored.values[5]).toBe('user')
    expect(stored.values[10]).toBe('2026-10-13T10:00:00.000Z')
    expect(stored.values[11]).toBe('2026-10-13T10:00:03.000Z')
    expect(stored.values[12]).toBe(3000)
    expect(stored.values[13]).toBe(asset.values[0])
    const claim = db.queries.find((query) => query.sql.includes('SET turn_id = $3'))!
    expect(claim.values.slice(1)).toEqual([[segment], turn.turnId, 'answer'])
  })

  it('leaves a guess unclaimed until the browser says it was used', async () => {
    const audit = factory()
    const guess = audit.startTurn({ clientTurnId: 'guess', messages: [{ role: 'user', content: 'What is the' }], speculative: true })!
    const segment = audit.recordSpeech({ source: 'user', mime: 'audio/wav', audio: wav(1), text: 'What is the weather?' })
    await audit.settled()
    expect(db.queries.some((query) => query.sql.includes('SET turn_id = $3'))).toBe(false)
    expect(inserted('gideon_turns').at(-1)!.values.at(-1)).toBeNull()

    audit.amendTurn('guess', { committed: true, source: 'voice', speculation: 'hit' })
    await audit.settled()
    expect(db.queries.find((query) => query.sql.includes('SET turn_id = $3'))!.values.slice(1)).toEqual([[segment], guess.turnId, 'guess'])
    const patch = db.queries.find((query) => query.sql.includes('UPDATE public.gideon_turns'))!
    expect(patch.values.slice(1, 4)).toEqual(['guess', true, 'voice'])
    expect(JSON.parse(patch.values[5] as string)).toEqual({ speculation: 'hit' })
  })

  it('files what the assistant said under its turn, and fills in when it was heard', async () => {
    const audit = factory()
    const turn = audit.startTurn({ clientTurnId: 'spoken', messages: [] })!
    turn.finish('completed')
    const segment = audit.recordSpeech({ source: 'assistant', clientTurnId: 'spoken', segmentId: '22222222-2222-4222-8222-222222222222', mime: 'audio/mpeg', audio: Uint8Array.from([73, 68, 51]), text: 'Sunny.', seq: 0, startChar: 0, endChar: 6 })
    audit.amendSpeech(segment, { startedAt: Date.parse('2026-10-13T10:00:05.000Z') })
    audit.amendSpeech(segment, { endedAt: Date.parse('2026-10-13T10:00:06.200Z') })
    await audit.settled()

    const stored = inserted('gideon_speech_segments')[0]
    expect(stored.values.slice(0, 10)).toEqual([segment, '11111111-1111-4111-8111-111111111111', 'user/audit', turn.turnId, 'spoken', 'assistant', 0, 'Sunny.', 0, 6])
    // Not known until the browser has played it.
    expect(stored.values.slice(10, 13)).toEqual([null, null, null])
    const patches = db.queries.filter((query) => query.sql.includes('UPDATE public.gideon_speech_segments') && query.sql.includes('interrupted'))
    expect(patches.map((query) => query.values.slice(2))).toEqual([['2026-10-13T10:00:05.000Z', null, false], [null, '2026-10-13T10:00:06.200Z', false]])
    // Speech that arrives after the turn finished still shows on its row.
    expect(turnRow()).toMatchObject({ spoken_segments: 1 })
    expect(JSON.parse(turnRow().timings as string)).toHaveProperty('first_audio')
  })

  it('retries a batch once when the connection fails, without duplicating it', async () => {
    db.failConnect = 1
    const audit = factory()
    audit.startTurn({ clientTurnId: 'retried', messages: [] })
    await audit.settled()
    expect(db.connections).toBe(2)
    expect(events().map((event) => event.type)).toEqual(['turn_started', 'submitted_messages'])
    expect(inserted('gideon_interaction_events')[0].sql).toContain('ON CONFLICT (turn_id, sequence) DO NOTHING')
  })

  it('gives up on a batch the database cannot be reached for, and never throws at the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    db.failConnect = 2
    const audit = factory()
    const turn = audit.startTurn({ clientTurnId: 'lost', messages: [{ role: 'user', content: 'a private sentence' }] })!
    expect(() => turn.finish('completed')).not.toThrow()
    await audit.settled()
    expect(events()).toEqual([])
    // What was lost is counted, never quoted.
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).not.toContain('private')
    warn.mockRestore()
  })

  it('keeps the rest of a batch when the database refuses one recording', async () => {
    db.refuseAudio = true
    const audit = factory()
    audit.startTurn({ clientTurnId: 'kept', messages: [] })
    audit.recordSpeech({ source: 'assistant', clientTurnId: 'kept', mime: 'audio/mpeg', audio: Uint8Array.from([1, 2, 3]), text: 'Kept.' })
    await audit.settled()
    expect(events().map((event) => event.type)).toEqual(expect.arrayContaining(['turn_started', 'submitted_messages']))
    const segment = inserted('gideon_speech_segments')[0]
    // The words are still on the timeline; only the audio is missing, and it says so.
    expect(segment.values[13]).toBeNull()
    expect(JSON.parse(segment.values[14] as string)).toMatchObject({ audioStored: false })
    expect(db.queries.some((query) => query.sql.includes("'audit_records_dropped'"))).toBe(true)
  })

  it('keeps the host alive for exactly the writes it has queued', async () => {
    const kept: Promise<unknown>[] = []
    const audit = factory({ keepAlive: (work) => { kept.push(work) } })
    audit.startTurn({ clientTurnId: 'alive', messages: [] })
    expect(kept).toHaveLength(1)
    await Promise.all(kept)
    expect(events()).toHaveLength(2)
  })

  it('reads how long a recording runs from its header', () => {
    expect(wavDurationMs(wav(2))).toBe(2000)
    expect(wavDurationMs(Uint8Array.from([73, 68, 51, 4]))).toBeNull()
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
