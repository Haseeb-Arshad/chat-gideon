import { getMigrations } from 'better-auth/db/migration'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Memory } from '../../../src/lib/tools/memory'
import { applyWorkerMigrations, workerMigrationStatus } from '../../../scripts/worker-db'
import { cutoverScope, closeWriterLocks } from '../../memory/src/cutover'
import { PostgresMemoryStore } from '../../memory/src/postgres'
import { createServerMemorySession } from '../../../src/server/memory-session'
import { accountOptions, ownerOf } from './accounts'
import { handleApi } from './api'
import { createWorkerInteractionAudit } from './audit'
import { hyperdriveClients, HyperdriveMemoryStore, type SqlClient } from './memory'
import { createConnectionMemory, resolveWorkerMemoryForTurn } from './worker-memory'
import type { Env } from './types'

/**
 * The Worker's database on real PostgreSQL, reached the way Hyperdrive hands
 * it over: a connection string, one short-lived client per operation.
 * Run with `node scripts/memory-postgres-harness.mjs backend/worker/src/database.live.test.ts`.
 */

const enabled = process.env.GIDEON_MEMORY_POSTGRES_TEST === '1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)
const ORIGIN = 'http://localhost'
const connectionString = process.env.MEMORY_TEST_DATABASE_URL ?? ''

const cello: Memory = { id: 'memory-1', kind: 'fact', text: 'The user plays the cello.', createdAt: '2026-09-10T00:00:00.000Z', usedAt: '2026-09-10T00:00:00.000Z', uses: 1 }

describe.skipIf(!enabled)('Worker database on PostgreSQL', () => {
  const admin = new pg.Client({ connectionString })

  beforeAll(async () => { await admin.connect() })
  afterAll(async () => { await admin.end() })

  it('applies the migrations once, and refuses a recorded file that changed', async () => {
    const first = await applyWorkerMigrations(admin)
    expect(first.pending).toEqual([])
    expect(first.applied.slice(0, 4)).toEqual(['001_gideon_memories.sql', '002_accounts.sql', '003_interaction_audit.sql', '004_conversation_telemetry.sql'])
    expect(first.applied.filter((name) => name.startsWith('memory_'))).toHaveLength(12)
    expect(await applyWorkerMigrations(admin)).toEqual(first)
    const recorded = (await admin.query(`SELECT checksum FROM public.gideon_worker_migrations WHERE name = '002_accounts.sql'`)).rows[0].checksum
    await admin.query(`UPDATE public.gideon_worker_migrations SET checksum = 'edited' WHERE name = '002_accounts.sql'`)
    await expect(applyWorkerMigrations(admin)).rejects.toThrow(/changed after it was applied/u)
    await admin.query(`UPDATE public.gideon_worker_migrations SET checksum = $1 WHERE name = '002_accounts.sql'`, [recorded])
    expect(await workerMigrationStatus(admin)).toEqual(first)
  })

  it('matches exactly what Better Auth expects, so no column it reads is missing', async () => {
    const pool = new pg.Pool({ connectionString, max: 4 })
    try {
      const plan = await getMigrations(accountOptions(pool, 'x'.repeat(40), ORIGIN))
      expect(plan.toBeCreated).toEqual([])
      expect(plan.toBeAdded).toEqual([])
    } finally {
      await pool.end()
    }
  })

  it('issues an anonymous account through Hyperdrive and recognises it on the next request', async () => {
    const env = { HYPERDRIVE: { connectionString }, BETTER_AUTH_SECRET: 'a-test-secret-that-is-long-enough-to-use' } as unknown as Env
    const response = await handleApi(new Request(`${ORIGIN}/api/account`, { method: 'POST', headers: { Origin: ORIGIN } }), env)
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ anonymous: true })
    const cookie = (response?.headers.getSetCookie() ?? []).map((value) => value.split(';')[0]).join('; ')

    const users = await admin.query(`SELECT id, "isAnonymous" FROM public."user"`)
    expect(users.rows).toHaveLength(1)
    expect(users.rows[0].isAnonymous).toBe(true)
    expect(await ownerOf(new Request(`${ORIGIN}/api/chat`, { method: 'POST', headers: { Cookie: cookie } }), env)).toBe(`user/${users.rows[0].id}`)

    // Every request's connection was closed: nothing is left idle on the server.
    const open = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle'`)
    expect(open.rows[0].n).toBe(0)
  })

  it('keeps account memory in the owner\'s row, and nobody else\'s', async () => {
    const connect = hyperdriveClients(connectionString)
    await new HyperdriveMemoryStore(connect, 'user/a').mutate((memories) => ({ memories: [...memories, cello], result: null }))

    expect(await new HyperdriveMemoryStore(connect, 'user/a').all()).toEqual([cello])
    expect(await new HyperdriveMemoryStore(connect, 'user/b').all()).toEqual([])
    const row = await admin.query(`SELECT jsonb_typeof(memories) AS type FROM public.gideon_memories WHERE session_id = 'user/a'`)
    expect(row.rows[0].type).toBe('array')

    await new HyperdriveMemoryStore(connect, 'user/a').mutate(() => ({ memories: [], result: null }))
    expect(await new HyperdriveMemoryStore(connect, 'user/a').all()).toEqual([])
  })

  it('holds non-empty legacy memory until a controlled cutover, then serves it from the canonical authority', async () => {
    const owner = `user/worker-cutover-${crypto.randomUUID()}`
    const legacy = new HyperdriveMemoryStore(hyperdriveClients(connectionString), owner)
    await legacy.mutate((memories) => ({ memories: [...memories, cello], result: null }))
    const env = {
      HYPERDRIVE: { connectionString },
      ENVIRONMENT: 'production',
      GIDEON_MEMORY_STAGE15_CUTOVER: '1',
      GIDEON_MEMORY_CUTOVER_ENABLED: '1',
      GIDEON_MEMORY_ROLLOUT_PERCENT: '100',
      GIDEON_MEMORY_CAPTURE_ENABLED: '1',
      GIDEON_MEMORY_COMMAND_WRITES_ENABLED: '1',
      GIDEON_MEMORY_RECALL_ENABLED: '1',
    } as unknown as Env

    const before = await resolveWorkerMemoryForTurn({ env, owner, channel: 'worker_http', legacyStore: legacy })
    expect(before.memoryRuntime).toBeUndefined()
    expect(await before.memoryStore.all()).toEqual([cello])
    await before.close()

    const pool = new pg.Pool({ connectionString, max: 1 })
    const store = new PostgresMemoryStore(pool)
    try {
      const session = createServerMemorySession({ owner, store, channel: 'http', authority: 'worker_auth_session' })
      await store.provisionTrustedContext(session)
      const report = await cutoverScope(session, {
        async read() {
          const client = new pg.Client({ connectionString })
          client.on('error', () => undefined)
          await client.connect()
          try {
            const result = await client.query('SELECT memories FROM public.gideon_memories WHERE session_id = $1', [owner])
            return (result.rows[0] as { memories?: unknown } | undefined)?.memories ?? null
          } finally {
            await client.end().catch(() => undefined)
          }
        },
        async write(memories) {
          const client = new pg.Client({ connectionString })
          client.on('error', () => undefined)
          await client.connect()
          try {
            await client.query('UPDATE public.gideon_memories SET memories = $2::jsonb WHERE session_id = $1', [owner, JSON.stringify(memories)])
          } finally {
            await client.end().catch(() => undefined)
          }
        },
      })
      expect(report.outcome).toBe('activated')
      expect(report.verification?.matching).toBe(1)
    } finally {
      await closeWriterLocks(store)
      await pool.end()
    }

    const after = await resolveWorkerMemoryForTurn({ env, owner, channel: 'worker_http', legacyStore: legacy })
    try {
      expect(after.memoryRuntime?.flags).toEqual({ capture: true, commandWrites: true, recall: true })
      expect(after.controlSession).toBeDefined()
      expect((await after.memoryStore.all()).map((memory) => memory.text)).toEqual([cello.text])
    } finally {
      await after.close()
    }
  }, 20_000)

  it('keeps one connection\'s memory and its database connections for the turns that follow', async () => {
    const owner = 'user/worker-connection-live'
    const env = {
      HYPERDRIVE: { connectionString }, ENVIRONMENT: 'production',
      GIDEON_MEMORY_STAGE15_CUTOVER: '1', GIDEON_MEMORY_CUTOVER_ENABLED: '1', GIDEON_MEMORY_ROLLOUT_PERCENT: '100',
      GIDEON_MEMORY_CAPTURE_ENABLED: '1', GIDEON_MEMORY_COMMAND_WRITES_ENABLED: '1', GIDEON_MEMORY_RECALL_ENABLED: '1',
    } as unknown as Env
    const memory = createConnectionMemory({ env, owner, channel: 'worker_websocket', legacyStore: new HyperdriveMemoryStore(hyperdriveClients(connectionString), owner) })

    const first = await memory.resolve()
    const pool = first.controlSession!.store.pool
    expect(first.memoryRuntime?.flags).toEqual({ capture: true, commandWrites: true, recall: true })
    // A turn that overlaps another meets the same runtime, not a second pool.
    const overlapping = await memory.resolve()
    expect(overlapping.controlSession!.store.pool).toBe(pool)
    await first.close()
    await overlapping.close()

    // Handed back by both turns, and still open for the next one.
    const next = await memory.resolve()
    expect(next.controlSession!.store.pool).toBe(pool)
    expect((pool as unknown as { ended: boolean }).ended).toBe(false)
    expect(await next.memoryStore.all()).toEqual([])
    await next.close()
    await next.close()

    // Warming opens the connections a lookup will read on, before it asks.
    memory.warm()
    await expect.poll(() => pool.totalCount, { timeout: 5_000 }).toBeGreaterThanOrEqual(4)

    // Closing the socket closes them, but not underneath a turn still running.
    const running = await memory.resolve()
    await memory.close()
    expect(await running.memoryStore.all()).toEqual([])
    expect((pool as unknown as { ended: boolean }).ended).toBe(false)
    await running.close()
    await expect.poll(() => (pool as unknown as { ended: boolean }).ended, { timeout: 5_000 }).toBe(true)
  }, 20_000)

  it('stores chat evidence and real audio bytes in the private audit tables', async () => {
    const auditFactory = createWorkerInteractionAudit({
      env: {
        HYPERDRIVE: { connectionString } as Hyperdrive,
        GIDEON_AUDIT_ENABLED: '1',
        GIDEON_AUDIT_REQUIRED: '1',
      } as Env,
      owner: 'user/worker-audit-live',
      sessionKey: `audit-${crypto.randomUUID()}`,
      channel: 'http',
    })!
    const audit = auditFactory.startTurn({
      clientTurnId: 'live-turn-1',
      messages: [{ role: 'user', content: 'Search for a published source.' }],
    })!
    audit.record('provider_response', { model: 'fixture/model', usage: { prompt_tokens: 25, completion_tokens: 9, cost: 0.0004 } })
    audit.record('tool_call', { callId: 'call-1', name: 'research', arguments: { question: 'Search for a published source.' } })
    audit.record('research_search_request', { query: 'published source' })
    audit.record('tool_result', { callId: 'call-1', name: 'research', ok: true, content: 'A source was found.', links: [{ title: 'Source', url: 'https://example.com/source' }] })
    audit.record('assistant_message', { responseId: 'live-response-1', text: 'The source supports the claim.' })
    audit.mark('first_token', 480)
    const voice = Uint8Array.from([82, 73, 70, 70, 4, 3, 2, 1])
    const segmentId = audit.saveAudio({ source: 'assistant', mime: 'audio/mpeg', audio: voice, text: 'The source supports the claim.' })
    audit.finish('completed')
    // Nothing above waited on the database; this is the first thing that does.
    await auditFactory.settled()

    const events = await admin.query(
      'SELECT event_type, payload, occurred_at FROM public.gideon_interaction_events WHERE turn_id = $1 ORDER BY sequence',
      [audit.turnId],
    )
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'turn_started', 'submitted_messages', 'provider_response', 'tool_call', 'research_search_request', 'tool_result', 'assistant_message', 'turn_finished',
    ])
    expect(events.rows.every((row) => row.occurred_at instanceof Date)).toBe(true)

    const turn = (await admin.query('SELECT * FROM public.gideon_turns WHERE id = $1', [audit.turnId])).rows[0]
    expect(turn).toMatchObject({
      client_turn_id: 'live-turn-1', status: 'completed', committed: true, speculative: false,
      user_text: 'Search for a published source.', assistant_text: 'The source supports the claim.',
      model: 'fixture/model', model_rounds: 1, prompt_tokens: 25, completion_tokens: 9, total_tokens: 34,
      tool_calls: 1, searches: 1, first_token_ms: 480,
    })
    expect(Number(turn.cost_usd)).toBeCloseTo(0.0004)
    expect(turn.tools).toEqual([expect.objectContaining({ name: 'research', ok: true })])

    const spoken = await admin.query(
      `SELECT s.speaker, s.text, s.turn_id, a.audio, a.sha256, a.byte_length
       FROM public.gideon_speech_segments s JOIN public.gideon_voice_assets a ON a.id = s.asset_id WHERE s.id = $1`,
      [segmentId],
    )
    expect(spoken.rows[0]).toMatchObject({ speaker: 'assistant', text: 'The source supports the claim.', turn_id: audit.turnId, byte_length: voice.byteLength })
    expect(spoken.rows[0].audio).toEqual(Buffer.from(voice))
    expect(spoken.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('ties what was said to the turn that answered it, and fills in when the reply was heard', async () => {
    const auditFactory = createWorkerInteractionAudit({
      env: { HYPERDRIVE: { connectionString } as Hyperdrive, GIDEON_AUDIT_ENABLED: '1' } as Env,
      owner: 'user/worker-timeline-live',
      sessionKey: `timeline-${crypto.randomUUID()}`,
      channel: 'websocket',
    })!
    // One second of 16 kHz mono PCM, so the recording's own length places it in time.
    const recording = new Uint8Array(44 + 32_000)
    const header = new DataView(recording.buffer)
    recording.set([82, 73, 70, 70], 0); header.setUint32(4, 36 + 32_000, true); recording.set([87, 65, 86, 69, 102, 109, 116, 32], 8)
    header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true)
    header.setUint32(24, 16_000, true); header.setUint32(28, 32_000, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true)
    recording.set([100, 97, 116, 97], 36); header.setUint32(40, 32_000, true)

    const said = Date.parse('2026-10-13T09:00:01.000Z')
    const heard = auditFactory.recordSpeech({ source: 'user', mime: 'audio/wav', audio: recording, text: 'What is the weather?', endedAt: said })
    const turn = auditFactory.startTurn({ clientTurnId: 'timeline-turn', messages: [{ role: 'user', content: 'What is the weather?' }] })!
    turn.finish('completed')
    const reply = auditFactory.recordSpeech({ source: 'assistant', clientTurnId: 'timeline-turn', mime: 'audio/mpeg', audio: Uint8Array.from([73, 68, 51]), text: 'Sunny.', seq: 0, startChar: 0, endChar: 6 })
    auditFactory.amendSpeech(reply, { startedAt: said + 1_500 })
    auditFactory.amendSpeech(reply, { endedAt: said + 2_300 })
    auditFactory.recordEvent({ clientTurnId: 'timeline-turn', type: 'card_displayed', payload: { artifactId: 'artifact-1', displayRevision: 1 }, at: said + 1_800 })
    auditFactory.amendTurn('timeline-turn', { source: 'voice', cardsDisplayed: 1, marks: { first_sample: said + 1_500 } })
    await auditFactory.settled()

    const timeline = await admin.query(
      'SELECT speaker, text, at, ended_at, duration_ms, turn_id, segment_id FROM public.gideon_conversation_timeline WHERE owner_id = $1 ORDER BY at',
      ['user/worker-timeline-live'],
    )
    expect(timeline.rows.map((row) => [row.speaker, row.text, row.at.toISOString(), row.ended_at.toISOString(), row.duration_ms, row.turn_id])).toEqual([
      ['user', 'What is the weather?', '2026-10-13T09:00:00.000Z', '2026-10-13T09:00:01.000Z', 1000, turn.turnId],
      ['assistant', 'Sunny.', '2026-10-13T09:00:02.500Z', '2026-10-13T09:00:03.300Z', 800, turn.turnId],
    ])
    expect(timeline.rows.map((row) => row.segment_id)).toEqual([heard, reply])

    const row = (await admin.query('SELECT source, cards_displayed, spoken_segments, client, first_audio_ms FROM public.gideon_turns WHERE id = $1', [turn.turnId])).rows[0]
    expect(row).toMatchObject({ source: 'voice', cards_displayed: 1, spoken_segments: 1, client: { marks: { first_sample: said + 1_500 } } })
    expect(row.first_audio_ms).toEqual(expect.any(Number))
    const shown = await admin.query(`SELECT occurred_at FROM public.gideon_interaction_events WHERE turn_id = $1 AND event_type = 'card_displayed'`, [turn.turnId])
    expect(shown.rows[0].occurred_at.toISOString()).toBe('2026-10-13T09:00:02.800Z')
  })

  it('runs a Worker chat with web research, memory capture, transcription and speech, then reads every artifact back', async () => {
    const sessionKey = `worker-e2e-${crypto.randomUUID()}`
    const rpc = {
      memorySnapshot: async () => ({ memories: [], version: 'empty' }),
      memoryCommit: async () => true,
    }
    const namespace = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => rpc,
    }
    const env = {
      HYPERDRIVE: { connectionString },
      BETTER_AUTH_SECRET: 'a-test-secret-that-is-long-enough-to-use',
      OPENROUTER_API_KEY: 'e2e-test-key',
      OPENROUTER_CHAT_MODEL: 'test/main-chat',
      OPENROUTER_CHAT_FALLBACK_MODEL: 'test/main-fallback',
      OPENROUTER_RESEARCH_MODEL: 'test/research',
      OPENROUTER_RESEARCH_FALLBACK_MODEL: 'test/research-fallback',
      EXA_API_KEY: 'e2e-test-exa-key',
      GIDEON_AUDIT_ENABLED: '1',
      GIDEON_AUDIT_REQUIRED: '1',
      ENVIRONMENT: 'production',
      GIDEON_MEMORY_STAGE15_CUTOVER: '1',
      GIDEON_MEMORY_CUTOVER_ENABLED: '1',
      GIDEON_MEMORY_ROLLOUT_PERCENT: '100',
      GIDEON_MEMORY_CAPTURE_ENABLED: '1',
      GIDEON_MEMORY_COMMAND_WRITES_ENABLED: '1',
      GIDEON_MEMORY_RECALL_ENABLED: '1',
      GIDEON_MEMORY_CONTROLS_ENABLED: '1',
      GIDEON_SESSION: namespace,
    } as unknown as Env

    const account = await handleApi(new Request(`${ORIGIN}/api/account`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
    }), env)
    expect(account?.status).toBe(200)
    const cookie = (account?.headers.getSetCookie() ?? []).map((value) => value.split(';')[0]).join('; ')
    const owner = await ownerOf(new Request(`${ORIGIN}/api/chat`, { headers: { Cookie: cookie } }), env)
    expect(owner.startsWith('user/')).toBe(true)
    const memoryContext = await resolveWorkerMemoryForTurn({
      env,
      owner,
      channel: 'worker_http',
      legacyStore: new HyperdriveMemoryStore(hyperdriveClients(connectionString), owner),
    })
    expect(memoryContext.memoryRuntime?.flags).toEqual({ capture: true, commandWrites: true, recall: true })
    await memoryContext.close()

    const background: Promise<unknown>[] = []
    const ctx = { waitUntil: (work: Promise<unknown>) => { background.push(work) } }
    const written = async () => { while (background.length) await background.shift() }
    const encoder = new TextEncoder()
    const completionCalls: Record<string, number> = {}
    let exaAnswerCalls = 0
    const priorFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/audio/transcriptions')) return Response.json({ text: 'Please check the published report against a source.' })
      if (url.endsWith('/audio/speech')) return new Response(Uint8Array.from([73, 68, 51, 4, 5, 6]), { headers: { 'Content-Type': 'audio/mpeg' } })
      if (url === 'https://api.exa.ai/answer') {
        exaAnswerCalls += 1
        return Response.json({
          answer: 'The report is supported by the published source.',
          citations: [{ title: 'Published report', url: 'https://example.test/report', publishedDate: '2026-09-20' }],
        })
      }
      if (url === 'https://api.exa.ai/search') return Response.json({ results: [
        { title: 'Published report', url: 'https://example.test/report', publishedDate: '2026-09-20', highlights: ['The published report confirms the audited result.'] },
      ] })
      if (url.endsWith('/chat/completions')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
        const model = payload.model ?? 'unknown'
        completionCalls[model] = (completionCalls[model] ?? 0) + 1
        if (model === 'test/research') {
          const firstResearchRound = completionCalls[model] === 1
          return Response.json({
            id: `research-${completionCalls[model]}`,
            model,
            choices: [{ message: firstResearchRound
              ? { content: null, tool_calls: [{ id: 'search-call-1', type: 'function', function: { name: 'search', arguments: JSON.stringify({ query: 'published report audited result' }) } }] }
              : { content: 'The published report supports the audited result. Sources: Published report https://example.test/report' } }],
            usage: firstResearchRound
              ? { prompt_tokens: 19, completion_tokens: 6, total_tokens: 25 }
              : { prompt_tokens: 33, completion_tokens: 11, total_tokens: 44 },
          })
        }
        if (model !== 'test/main-chat') return new Response('provider fixture unavailable', { status: 503 })
        const first = completionCalls[model] === 1
        const data = first
          ? [
              { id: 'chatgen-1', model, choices: [{ delta: { tool_calls: [{ index: 0, id: 'research-call-1', type: 'function', function: { name: 'research', arguments: JSON.stringify({ question: 'Find the published report.' }) } }] }, finish_reason: null }] },
              { id: 'chatgen-1', model, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 31, completion_tokens: 8, total_tokens: 39, cost: 0.0002 } },
            ]
          : [
              { id: 'chatgen-2', model, choices: [{ delta: { content: 'The source supports the report.' }, finish_reason: null }] },
              { id: 'chatgen-2', model, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 57, completion_tokens: 7, total_tokens: 64, cost: 0.0003 } },
            ]
        const body = `${data.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
        return new Response(encoder.encode(body), { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response(`Unexpected fixture request: ${url}`, { status: 500 })
    }) as typeof fetch

    try {
      const uploadedAudio = Uint8Array.from([82, 73, 70, 70, 8, 0, 0, 0])
      const transcribed = await handleApi(new Request(`${ORIGIN}/api/transcribe`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN, 'X-Gideon-Session': sessionKey, 'Content-Type': 'audio/wav' },
        body: uploadedAudio,
      }), env, ctx)
      expect(transcribed?.status).toBe(200)
      expect(await transcribed?.json()).toMatchObject({ text: 'Please check the published report against a source.' })
      await written()

      const chat = await handleApi(new Request(`${ORIGIN}/api/chat`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN, 'X-Gideon-Session': sessionKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'e2e-worker-turn', messages: [{ role: 'user', content: 'Please check the published report against a source.' }] }),
      }), env, ctx)
      expect(chat?.status).toBe(200)
      const stream = await chat!.text()
      expect(stream).toContain('The source supports the report.')
      expect(exaAnswerCalls).toBe(1)
      await written()

      const memoryStatus = await handleApi(new Request(`${ORIGIN}/api/memory?view=status`, {
        headers: { Cookie: cookie, Origin: ORIGIN, 'X-Gideon-Session': sessionKey },
      }), env)
      expect(memoryStatus?.status).toBe(200)
      expect(await memoryStatus?.json()).toMatchObject({ ok: true, enabled: true })

      const speechBytes = Uint8Array.from([73, 68, 51, 4, 5, 6])
      const speech = await handleApi(new Request(`${ORIGIN}/api/voice`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN, 'X-Gideon-Session': sessionKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: 'e2e-worker-turn', responseId: 'chatgen-2', text: 'The source supports the report.', seq: 0 }),
      }), env, ctx)
      expect(speech?.status).toBe(200)
      expect(new Uint8Array(await speech!.arrayBuffer())).toEqual(speechBytes)
      await written()
    } finally {
      globalThis.fetch = priorFetch
    }

    const conversations = await admin.query('SELECT id FROM public.gideon_conversations WHERE owner_id = $1', [owner])
    expect(conversations.rows).toHaveLength(1)
    const conversationId = conversations.rows[0].id
    const events = await admin.query(
      'SELECT event_type, payload FROM public.gideon_interaction_events WHERE conversation_id = $1 ORDER BY created_at, id',
      [conversationId],
    )
    const byType = (type: string) => events.rows.filter((row) => row.event_type === type).map((row) => row.payload as Record<string, unknown>)
    expect(byType('submitted_messages').some((payload) => JSON.stringify(payload).includes('Please check the published report'))).toBe(true)
    expect(byType('tool_call').some((payload) => payload.name === 'research' && JSON.stringify(payload).includes('Find the published report'))).toBe(true)
    expect(byType('tool_result').some((payload) => payload.name === 'research' && JSON.stringify(payload).includes('https://example.test/report'))).toBe(true)
    expect(byType('provider_response').some((payload) => JSON.stringify(payload).includes('"prompt_tokens":57') && JSON.stringify(payload).includes('"completion_tokens":7'))).toBe(true)
    expect(byType('research_provider_response').some((payload) => JSON.stringify(payload).includes('"prompt_tokens":33') && JSON.stringify(payload).includes('"completion_tokens":11'))).toBe(true)
    expect(byType('research_search_request').some((payload) => payload.query === 'published report audited result')).toBe(true)
    expect(byType('research_search_result').some((payload) => JSON.stringify(payload).includes('https://example.test/report'))).toBe(true)
    expect(byType('assistant_message')).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('The source supports the report.') }),
    ]))
    expect(byType('memory_context')).toEqual(expect.arrayContaining([
      expect.objectContaining({ captureEnabled: true, commandWritesEnabled: true, recallEnabled: true }),
    ]))
    expect(byType('memory_capture_result')).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'captured' }),
    ]))
    // The reply is kept once, whole; its tokens are counted rather than stored a row each.
    expect(byType('released_frame').find((payload) => payload.type === 'done')).toMatchObject({ deltas: expect.any(Number) })
    expect(byType('released_frame').some((payload) => payload.type === 'delta')).toBe(false)
    expect(byType('memory_recall')).toEqual([expect.objectContaining({ status: 'ready', ms: expect.any(Number) })])

    const turns = await admin.query('SELECT * FROM public.gideon_turns WHERE conversation_id = $1', [conversationId])
    expect(turns.rows).toHaveLength(1)
    expect(turns.rows[0]).toMatchObject({
      client_turn_id: 'e2e-worker-turn', channel: 'http', status: 'completed', committed: true,
      user_text: 'Please check the published report against a source.',
      assistant_text: expect.stringContaining('The source supports the report.'),
      model: 'test/main-chat', model_rounds: 2,
      // Both rounds of the speaking model and both of the research model.
      prompt_tokens: 31 + 57 + 19 + 33, completion_tokens: 8 + 7 + 6 + 11,
      tool_calls: 1,
      // One direct answer and one search.
      searches: 2,
    })
    expect(Number(turns.rows[0].cost_usd)).toBeCloseTo(0.0005)
    expect(turns.rows[0].timings).toMatchObject({ setup: expect.any(Number), memory: expect.any(Number), first_token: expect.any(Number), done: expect.any(Number) })
    expect(turns.rows[0].tools).toEqual([expect.objectContaining({ name: 'research', ok: true, ms: expect.any(Number) })])
    expect(turns.rows[0].memory).toMatchObject({ recall: { status: 'ready' }, capture_result: { status: 'captured' } })

    const timeline = await admin.query(
      'SELECT speaker, text, ended_at, asset_id FROM public.gideon_conversation_timeline WHERE conversation_id = $1 ORDER BY at',
      [conversationId],
    )
    expect(timeline.rows.map((row) => [row.speaker, row.text])).toEqual([
      ['user', 'Please check the published report against a source.'],
      ['assistant', 'The source supports the report.'],
    ])
    expect(timeline.rows.every((row) => row.asset_id)).toBe(true)
    expect(timeline.rows[0].ended_at).toBeInstanceOf(Date)

    const voice = await admin.query(
      'SELECT source, transcript, transcription_model, audio FROM public.gideon_voice_assets WHERE conversation_id = $1 ORDER BY created_at',
      [conversationId],
    )
    expect(voice.rows.map((row) => row.source)).toEqual(['user', 'assistant'])
    expect(voice.rows[0].transcript).toBe('Please check the published report against a source.')
    expect(voice.rows[0].transcription_model).toBeTruthy()
    expect(voice.rows[0].audio).toEqual(Buffer.from([82, 73, 70, 70, 8, 0, 0, 0]))
    expect(voice.rows[1].audio).toEqual(Buffer.from([73, 68, 51, 4, 5, 6]))

    const memoryEvent = await admin.query(
      'SELECT event_id FROM gideon_memory.events WHERE scope_id = $1',
      [owner],
    )
    expect(memoryEvent.rows.length).toBeGreaterThan(0)
  })

  it('reports a failed read instead of treating it as empty memory', async () => {
    const broken: () => Promise<SqlClient> = async () => ({ query: async () => { throw new Error('offline') }, end: async () => undefined })
    await expect(new HyperdriveMemoryStore(broken, 'user/a').all()).rejects.toThrow('offline')
  })
})
