import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runMemoryMaintenance } from '../backend/memory/src/background'
import { applyMigrations } from '../backend/memory/src/migrations'
import { PostgresMemoryStore } from '../backend/memory/src/postgres'
import { retrieveMemory, type RetrieveMemoryOptions } from '../backend/memory/src/retrieval'
import { contextPackMessage, legacyMemoryMessage } from '../src/lib/agent-core'
import { createConversationState, replayConversationState, type ConversationState } from '../src/lib/conversation-state'
import { createProfileSessionSummaryBaseline } from '../src/lib/memory-baseline'
import { RULE_EXTRACTOR } from '../src/lib/memory/rule-extractor'
import { EphemeralMemoryStore } from '../src/lib/tools/memory'
import { contextMemories, runServerTool } from '../src/lib/tools/registry'
import { createServerMemorySession } from '../src/server/memory-session'
import { createRecallInput, createRuntime } from '../src/server/node-memory-integration'
import {
  CONTROLLED_READER_SYSTEM,
  JUDGE_PROMPT_VERSION,
  READER_PROMPT_VERSION,
  contextCoverage,
  deterministicPass,
  judgeMessages,
  judgePass,
  mean,
  pairedBootstrap,
  parseJudge,
  readerMessages,
  scoreText,
  timeline,
  type JudgeVerdict,
  type Query,
  type Trajectory,
  type Turn,
} from './lib/memory-eval'

/**
 * Stage 13 held-out conversational evaluation (see
 * docs/memory/reports/stage-13-preregistration.md).
 *
 * Run through the disposable PostgreSQL harness:
 *   node scripts/memory-postgres-harness.mjs scripts/memory-conversation-eval.live.test.ts
 * MEMORY_CONVERSATION_EVAL_SPLIT=dev|heldout (default dev). Without
 * MEMORY_CONVERSATION_EVAL_LIVE=1 only construction and context-layer metrics
 * run, plus answers already in the response cache. Live calls go only to the
 * authorized model, are cached on disk, and stop at SPEND_CAP_USD.
 */

const root = resolve(import.meta.dirname, '..')
const enabled = process.env.GIDEON_MEMORY_POSTGRES_TEST === '1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)
const split = process.env.MEMORY_CONVERSATION_EVAL_SPLIT === 'heldout' ? 'heldout' : 'dev'
const live = process.env.MEMORY_CONVERSATION_EVAL_LIVE === '1'
const AUTHORIZED_MODEL = 'openai/gpt-6-luna'
const SPEND_CAP_USD = 0.2
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const CACHE_PATH = resolve(root, 'output/memory-conversation-eval/cache.json')
const FIXTURE = `scripts/fixtures/memory-conversation-${split}.json`
const READER_SEEDS = [1, 2]
const JUDGE_SEEDS = [7, 8]
const ANSWER_ARMS = ['none', 'legacy', 'profile_summary', 'full', 'oracle'] as const
const CONTEXT_ARMS = [...ANSWER_ARMS, 'full_no_source_evidence', 'full_no_applicability', 'full_no_relationships'] as const
type AnswerArm = typeof ANSWER_ARMS[number]
type ContextArm = typeof CONTEXT_ARMS[number]
const ABLATIONS: Partial<Record<ContextArm, RetrieveMemoryOptions['ablate']>> = {
  full: undefined,
  full_no_source_evidence: { sourceEvidence: true },
  full_no_applicability: { applicability: true },
  full_no_relationships: { relationships: true },
}
const NEUTRAL_HEADER = 'Things you know about this user from earlier conversations:'

// ---------------------------------------------------------------------------
// Response cache and spend control
// ---------------------------------------------------------------------------

interface CacheEntry { status: number; body: string; latencyMs: number; costUsd: number }
const cache: Record<string, CacheEntry> = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf8')) : {}
const spend = { usd: 0, calls: 0, cacheHits: 0, errors: 0 }

function saveCache(): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true })
  writeFileSync(CACHE_PATH, JSON.stringify(cache))
}

function openRouterKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim()
  if (fromEnv) return fromEnv
  if (!existsSync(resolve(root, '.env'))) return ''
  const line = readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/u).find((entry) => entry.startsWith('OPENROUTER_API_KEY='))
  return line ? line.slice('OPENROUTER_API_KEY='.length).replace(/^["']|["']$/gu, '').trim() : ''
}

interface Completion { content: string | null; error: string | null; latencyMs: number; costUsd: number; cached: boolean }

type CompletionOptions = { seed: number; json?: boolean; maxTokens: number }
const inflight = new Map<string, Promise<Completion>>()

/**
 * One chat completion from the authorized model: replayed from cache when
 * identical (including a request still in flight, so identical answers get
 * the identical verdict), refused above the cap.
 */
function complete(messages: { role: string; content: string }[], options: CompletionOptions): Promise<Completion> {
  const body = JSON.stringify({
    model: AUTHORIZED_MODEL,
    temperature: 0,
    seed: options.seed,
    max_tokens: options.maxTokens,
    reasoning: { effort: 'minimal' },
    ...(options.json ? { response_format: { type: 'json_object' } } : {}),
    usage: { include: true },
    messages,
  })
  const key = createHash('sha256').update(`${ENDPOINT}\n${body}`).digest('hex')
  const running = inflight.get(key)
  if (running) {
    spend.cacheHits += 1
    return running
  }
  const call = completeOnce(key, body)
  inflight.set(key, call)
  return call
}

async function completeOnce(key: string, body: string): Promise<Completion> {
  let entry = cache[key]
  if (entry) spend.cacheHits += 1
  else {
    if (!live) return { content: null, error: 'not_cached', latencyMs: 0, costUsd: 0, cached: false }
    if (spend.usd >= SPEND_CAP_USD) return { content: null, error: 'spend_cap', latencyMs: 0, costUsd: 0, cached: false }
    const started = performance.now()
    let status = 0
    let text = ''
    try {
      const response = await globalThis.fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${openRouterKey()}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(60_000),
      })
      status = response.status
      text = await response.text()
    } catch (error) {
      spend.errors += 1
      return { content: null, error: error instanceof Error ? error.name : 'fetch_failed', latencyMs: Math.round(performance.now() - started), costUsd: 0, cached: false }
    }
    let costUsd = 0
    try { costUsd = Number((JSON.parse(text) as { usage?: { cost?: number } }).usage?.cost ?? 0) || 0 } catch { costUsd = 0 }
    spend.usd += costUsd
    spend.calls += 1
    entry = { status, body: text, latencyMs: Math.round(performance.now() - started), costUsd }
    // Only successful responses are cached, so transient errors are retried next run.
    if (status >= 200 && status < 300) cache[key] = entry
    if (spend.calls % 20 === 0) saveCache()
  }
  if (entry.status < 200 || entry.status >= 300) {
    spend.errors += 1
    return { content: null, error: `http_${entry.status}`, latencyMs: entry.latencyMs, costUsd: entry.costUsd, cached: Boolean(cache[key]) }
  }
  const parsed = JSON.parse(entry.body) as { choices?: { message?: { content?: unknown } }[] }
  const content = parsed.choices?.[0]?.message?.content
  return { content: typeof content === 'string' ? content : null, error: typeof content === 'string' ? null : 'empty', latencyMs: entry.latencyMs, costUsd: entry.costUsd, cached: true }
}

// ---------------------------------------------------------------------------
// Replaying one trajectory into every system
// ---------------------------------------------------------------------------

const flags = Object.freeze({ capture: true, commandWrites: true, recall: true })
// Deterministic, so identifiers inside packs (and therefore cached answers) replay exactly; the schema is fresh per run.
const run = `eval-${split}`
const at = (iso: string, offsetSeconds = 0) => new Date(Date.parse(iso) + offsetSeconds * 1000)
const slug = (text: string) => text.toLocaleLowerCase('en').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
const legacyKind = (kind: string) => (kind === 'preference' ? 'preference' : kind === 'decision' ? 'plan' : 'fact')

/** What the user literally said on an explicit turn; this is what capture stores. */
function spoken(turn: Turn): string {
  if ('say' in turn) return turn.say
  if ('remember' in turn) return `Please remember this: ${turn.remember.text}`
  if ('correct' in turn) return `Update that: ${turn.correct.text}`
  return `Forget this: ${turn.forget}`
}

function topicState(conversationId: string, text: string, topic: string | null, now: string): ConversationState {
  return replayConversationState(createConversationState({ conversationId, sessionId: `session/${conversationId}`, now }), [{
    type: 'turn_committed',
    turn: { turnId: `turn/${conversationId}`, revision: 1, sequence: 1, role: 'user', text, source: 'final_transcript', committedAt: now, delivery: 'committed', heardText: null },
    topic: topic ? { topicId: `topic/${slug(topic)}`, label: topic } : null,
  }])
}

interface Systems {
  trajectory: Trajectory
  full: ReturnType<typeof createServerMemorySession> & { store: PostgresMemoryStore }
  runtime: ReturnType<typeof createRuntime>
  legacy: EphemeralMemoryStore
  profile: string[]
  digests: { id: string; summary: string }[]
  ingestion: { turn: string; system: 'full' | 'legacy'; ok: boolean; detail: string }[]
  maintenanceMs: number
  ingestMs: { full: number; legacy: number }
}

/** Remembered items in a pack; its fixed header and coverage lines are not personal content. */
function packItems(pack: { sections: { applicableConstraints: readonly unknown[]; relevantFacts: readonly unknown[]; conflicts: readonly unknown[]; evidenceOnly: readonly unknown[] } }): number {
  return pack.sections.applicableConstraints.length + pack.sections.relevantFacts.length + pack.sections.conflicts.length + pack.sections.evidenceOnly.length
}

interface ContextRow {
  trajectory: string; query: string; category: string; language: string; arm: ContextArm
  content: string; framed: string; selectionMs: number; estimatedTokens: number
  evidenceHit: boolean | null; leak: boolean; injectedWhenNone: boolean | null; items: number; failure: string | null
}

describe.skipIf(!enabled)(`Stage 13 conversational evaluation (${split})`, () => {
  const database = new Pool({ connectionString: process.env.MEMORY_TEST_DATABASE_URL, max: 6, connectionTimeoutMillis: 3_000 })
  const store = new PostgresMemoryStore(database)
  const trajectories = (JSON.parse(readFileSync(resolve(root, FIXTURE), 'utf8')) as { trajectories: Trajectory[] }).trajectories
  const contextRows: ContextRow[] = []

  beforeAll(async () => {
    if (process.env.MEMORY_TEST_DATABASE_OWNED !== '1') throw new Error('The conversational evaluation requires an owned disposable database.')
    await database.query('DROP SCHEMA IF EXISTS gideon_memory CASCADE')
    await applyMigrations(database)
  })

  afterAll(async () => {
    vi.useRealTimers()
    saveCache()
    await store.close()
  })

  async function maintain(systems: Systems, now: string): Promise<void> {
    const started = performance.now()
    for (let pass = 0; pass < 5; pass += 1) {
      const report = await runMemoryMaintenance(store, {
        workerId: `${run}/maintenance`, extractor: RULE_EXTRACTOR, learning: true, learningEnabledFor: () => true,
        scopeId: systems.full.scope.id, now, settleMs: 0,
      })
      if (report.queue.pendingInterpret === 0 && report.queue.pendingProjection === 0) break
    }
    systems.maintenanceMs += performance.now() - started
  }

  async function ingest(systems: Systems, session: Trajectory['sessions'][number], index: number): Promise<void> {
    const conversationId = `conversation/${run}/${systems.trajectory.id}/${index}`
    const said: string[] = []
    for (const [position, turn] of session.turns.entries()) {
      const now = at(session.at, position * 30)
      vi.setSystemTime(now)
      const text = spoken(turn)
      const turnId = `turn/${run}/${systems.trajectory.id}/${index}/${position}`
      const conditionTopic = 'remember' in turn ? turn.remember.conditions?.find((condition) => condition.key === 'topic')?.value ?? null : null
      const state = topicState(conversationId, text, conditionTopic, now.toISOString())
      const base = { principalId: systems.full.principal.id, scopeId: systems.full.scope.id, policyEpoch: systems.full.policyEpoch, latestUserText: text, transcriptHash: createHash('sha256').update(text).digest('hex') }
      const signal = AbortSignal.timeout(15_000)

      let started = performance.now()
      const captured = await systems.runtime.captureUserTurn!({ ...base, turnId, conversationId }, signal)
      if (captured.status !== 'captured') systems.ingestion.push({ turn: turnId, system: 'full', ok: false, detail: `capture ${captured.status}: ${'reason' in captured ? captured.reason : ''}` })
      if (!('say' in turn)) {
        const context = { ...base, turnId, callId: `call/${position}`, responseId: `response/${turnId}`, timezone: 'UTC', conversationState: state, speculative: false, signal }
        const [name, args]: ['remember' | 'correct' | 'forget', Record<string, unknown>] = 'remember' in turn
          ? ['remember', { text: turn.remember.text, kind: turn.remember.kind, ...(conditionTopic ? { appliesTo: 'this_topic' } : {}) }]
          : 'correct' in turn
            ? ['correct', { query: turn.correct.target, text: turn.correct.text, change: turn.correct.change, ...(turn.correct.since ? { since: turn.correct.since.slice(0, 10) } : {}) }]
            : ['forget', { query: turn.forget }]
        const outcome = await systems.runtime.execute(name, args, context)
        systems.ingestion.push({ turn: turnId, system: 'full', ok: outcome.ok && !outcome.pending, detail: `${name}: ${outcome.summary ?? outcome.content}`.slice(0, 160) })
      }
      systems.ingestMs.full += performance.now() - started

      started = performance.now()
      const legacyContext = { store: systems.legacy, timezone: 'UTC', signal, env: () => undefined }
      if ('remember' in turn) {
        const outcome = await runServerTool('remember', { text: turn.remember.text, kind: legacyKind(turn.remember.kind) }, legacyContext)
        systems.ingestion.push({ turn: turnId, system: 'legacy', ok: outcome.ok, detail: `remember: ${outcome.content}`.slice(0, 160) })
        systems.profile.push(turn.remember.text)
      } else if ('correct' in turn) {
        // The legacy contract for a changed fact: remember the new one, naming what it replaces.
        const outcome = await runServerTool('remember', { text: turn.correct.text, kind: 'fact', replaces: turn.correct.target }, legacyContext)
        systems.ingestion.push({ turn: turnId, system: 'legacy', ok: outcome.ok, detail: `correct: ${outcome.content}`.slice(0, 160) })
        systems.profile.splice(0, systems.profile.length, ...systems.profile.map((item) => (item === turn.correct.target ? turn.correct.text : item)))
      } else if ('forget' in turn) {
        const outcome = await runServerTool('forget', { query: turn.forget }, legacyContext)
        systems.ingestion.push({ turn: turnId, system: 'legacy', ok: outcome.ok && /Forgotten/u.test(outcome.content), detail: `forget: ${outcome.content}`.slice(0, 160) })
        systems.profile.splice(0, systems.profile.length, ...systems.profile.filter((item) => item !== turn.forget))
      } else {
        said.push(turn.say)
      }
      systems.ingestMs.legacy += performance.now() - started
    }
    if (said.length) systems.digests.push({ id: `session-${index}`, summary: said.join(' ') })
    const end = at(session.at, session.turns.length * 30 + 60)
    vi.setSystemTime(end)
    await maintain(systems, end.toISOString())
  }

  async function contexts(systems: Systems, query: Query): Promise<Record<ContextArm, { content: string; framed: string; selectionMs: number; items: number; failure: string | null }>> {
    const now = at(query.at)
    vi.setSystemTime(now)
    await maintain(systems, now.toISOString())
    const out = {} as Record<ContextArm, { content: string; framed: string; selectionMs: number; items: number; failure: string | null }>
    out.none = { content: '', framed: '', selectionMs: 0, items: 0, failure: null }

    let started = performance.now()
    const legacy = await contextMemories(systems.legacy, query.text, 4, true)
    out.legacy = { content: legacy.map((memory) => memory.text).join('\n'), framed: legacy.length ? legacyMemoryMessage(legacy.map((memory) => memory.text)) : '', selectionMs: performance.now() - started, items: legacy.length, failure: null }

    started = performance.now()
    const profileSummary = createProfileSessionSummaryBaseline({ profile: systems.profile.join('. '), sessions: systems.digests }).select(query.text)
    const records = profileSummary.records.filter((record) => record.text.trim())
    out.profile_summary = { content: records.map((record) => record.text).join('\n'), framed: records.length ? `${NEUTRAL_HEADER}\n${records.map((record) => `- ${record.text}`).join('\n')}` : '', selectionMs: performance.now() - started, items: records.length, failure: null }

    const state = topicState(`conversation/${run}/${systems.trajectory.id}/query-${query.id}`, query.text, query.topic ?? null, now.toISOString())
    for (const arm of ['full', 'full_no_source_evidence', 'full_no_applicability', 'full_no_relationships'] as const) {
      started = performance.now()
      const input = createRecallInput(query.text, 'UTC', state, query.text)
      const result = await retrieveMemory(systems.full, { ...input, deadlineAt: new Date(now.getTime() + 15_000).toISOString() }, { now: now.toISOString(), ablate: ABLATIONS[arm] })
      const selectionMs = performance.now() - started
      if (!result.ok || !result.pack || result.pack.status === 'unavailable') {
        out[arm] = { content: '', framed: '', selectionMs, items: 0, failure: result.ok ? `pack_${result.pack?.status ?? 'missing'}` : result.failure.code }
      } else {
        out[arm] = { content: result.pack.text, framed: result.pack.text.trim() ? contextPackMessage(result.pack.text) : '', selectionMs, items: packItems(result.pack), failure: null }
      }
    }

    out.oracle = { content: query.evidence.join('\n'), framed: query.evidence.length ? `${NEUTRAL_HEADER}\n${query.evidence.map((line) => `- ${line}`).join('\n')}` : '', selectionMs: 0, items: query.evidence.length, failure: null }
    return out
  }

  interface AnswerRow {
    trajectory: string; query: string; category: string; language: string; arm: AnswerArm; seed: number
    answer: string | null; error: string | null; deterministic: boolean; judge: JudgeVerdict | null; judgePass: boolean | null; judgeRepeatPass: boolean | null; readerMs: number
  }
  const answers: AnswerRow[] = []
  const systemsLog: Pick<Systems, 'ingestion' | 'maintenanceMs' | 'ingestMs'>[] = []

  it(`replays every ${split} trajectory, builds every arm's context, and answers with the controlled reader`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    for (const trajectory of trajectories) {
      vi.setSystemTime(at(trajectory.sessions[0]?.at ?? trajectory.queries[0]!.at, -60))
      const memorySession = createServerMemorySession({ owner: `user/${run}-${trajectory.id}`, store: new EphemeralMemoryStore(), channel: 'test', authority: 'worker_auth_session' })
      await store.provisionTrustedContext(memorySession)
      const full = { ...memorySession, store } as Systems['full']
      const systems: Systems = { trajectory, full, runtime: createRuntime(full, flags), legacy: new EphemeralMemoryStore(), profile: [], digests: [], ingestion: [], maintenanceMs: 0, ingestMs: { full: 0, legacy: 0 } }

      for (const item of timeline(trajectory)) {
        if (item.type === 'session') { await ingest(systems, item.session, item.index); continue }
        const query = item.query
        const built = await contexts(systems, query)
        const personal = query.evidence.length > 0
        for (const arm of CONTEXT_ARMS) {
          const context = built[arm]
          const coverage = contextCoverage(context.content, query.rubric)
          contextRows.push({
            trajectory: trajectory.id, query: query.id, category: query.category, language: trajectory.language, arm,
            content: context.content, framed: context.framed, selectionMs: context.selectionMs, estimatedTokens: Math.ceil(context.framed.length / 4),
            evidenceHit: personal && query.rubric.mustInclude.length ? coverage.evidenceHit : null,
            leak: coverage.leak, injectedWhenNone: personal ? null : context.items > 0, items: context.items, failure: context.failure,
          })
        }
        const system = `${CONTROLLED_READER_SYSTEM}\nToday's date is ${query.at.slice(0, 10)}.`
        await Promise.all(ANSWER_ARMS.flatMap((arm) => READER_SEEDS.map(async (seed) => {
          const reply = await complete(readerMessages(system, built[arm].framed, query.text), { seed, maxTokens: 300 })
          const answer = reply.content?.trim() ?? null
          const deterministic = answer ? deterministicPass(scoreText(answer, query.rubric), query.rubric) : false
          let judge: JudgeVerdict | null = null
          let judgeRepeat: JudgeVerdict | null = null
          if (answer && seed === READER_SEEDS[0]) {
            // The same verdict asked twice with different seeds measures the judge's own variability.
            const [verdict, repeat] = await Promise.all(JUDGE_SEEDS.map((judgeSeed) => complete(judgeMessages(query.text, query.rubric, query.evidence, answer), { seed: judgeSeed, json: true, maxTokens: 300 })))
            judge = verdict!.content ? parseJudge(verdict!.content) : null
            judgeRepeat = repeat!.content ? parseJudge(repeat!.content) : null
          }
          answers.push({
            trajectory: trajectory.id, query: query.id, category: query.category, language: trajectory.language, arm, seed,
            answer, error: reply.error, deterministic, judge, judgePass: judge ? judgePass(judge, query.rubric) : null,
            judgeRepeatPass: judgeRepeat ? judgePass(judgeRepeat, query.rubric) : null, readerMs: reply.latencyMs,
          })
        })))
      }
      systemsLog.push({ ingestion: systems.ingestion, maintenanceMs: systems.maintenanceMs, ingestMs: systems.ingestMs })
    }
    vi.useRealTimers()
    writeReport()
    // The run itself must complete; quality is reported, not asserted.
    expect(contextRows.length).toBe(trajectories.reduce((sum, trajectory) => sum + trajectory.queries.length, 0) * CONTEXT_ARMS.length)
  }, 1_800_000)

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------

  function percentile(values: number[], p: number): number | null {
    if (!values.length) return null
    const sorted = [...values].sort((left, right) => left - right)
    return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! * 10) / 10
  }

  const rate = (values: readonly (boolean | null)[]) => {
    const counted = values.filter((value): value is boolean => value !== null)
    return { rate: counted.length ? Math.round((counted.filter(Boolean).length / counted.length) * 1000) / 1000 : null, n: counted.length }
  }

  function paired(metric: (row: AnswerRow) => number | null, a: AnswerArm, b: AnswerArm) {
    const clusters = trajectories.map((trajectory) => {
      const pick = (arm: AnswerArm) => trajectory.queries.map((query) => {
        const row = answers.find((item) => item.trajectory === trajectory.id && item.query === query.id && item.arm === arm && item.seed === READER_SEEDS[0])
        return row ? metric(row) : null
      })
      const left = pick(a)
      const right = pick(b)
      // Pairs where either side has no value (e.g. no judge verdict) are dropped together, and counted.
      const keep = left.map((value, index) => value !== null && right[index] !== null)
      return { a: left.filter((_, index) => keep[index]) as number[], b: right.filter((_, index) => keep[index]) as number[] }
    }).filter((cluster) => cluster.a.length > 0)
    if (!clusters.length) return null
    const result = pairedBootstrap(clusters, { resamples: 10_000, seed: 13 })
    const round = (value: number) => Math.round(value * 1000) / 1000
    return { comparison: `${b} − ${a}`, difference: round(result.difference), ci95: [round(result.low), round(result.high)], trajectories: result.clusters, queries: result.queries }
  }

  function writeReport(): void {
    const first = answers.filter((row) => row.seed === READER_SEEDS[0])
    const second = answers.filter((row) => row.seed === READER_SEEDS[1])
    const answered = first.some((row) => row.answer !== null)
    const byArm = Object.fromEntries(ANSWER_ARMS.map((arm) => {
      const rows = first.filter((row) => row.arm === arm)
      const categories = [...new Set(rows.map((row) => row.category))].sort()
      const languages = [...new Set(rows.map((row) => row.language))].sort()
      const secondRows = second.filter((row) => row.arm === arm)
      return [arm, {
        diagnosticOnly: arm === 'oracle',
        queries: rows.length,
        errors: rows.filter((row) => row.error).length,
        deterministicPass: rate(rows.map((row) => (row.answer === null ? false : row.deterministic))),
        judgePass: rate(rows.map((row) => row.judgePass)),
        falsePersonalClaim: rate(rows.map((row) => row.judge?.false_personal_claim ?? null)),
        unnecessaryPersonalization: rate(rows.map((row) => row.judge?.unnecessary_personalization ?? null)),
        judgeDeterministicAgreement: rate(rows.map((row) => (row.judgePass === null ? null : row.judgePass === row.deterministic))),
        judgeRepeatAgreement: rate(rows.map((row) => (row.judgePass === null || row.judgeRepeatPass === null ? null : row.judgePass === row.judgeRepeatPass))),
        repeatRun: { deterministicPassSeed2: rate(secondRows.map((row) => (row.answer === null ? false : row.deterministic))), changedVerdicts: rows.filter((row) => secondRows.find((other) => other.query === row.query && other.trajectory === row.trajectory)?.deterministic !== row.deterministic).length },
        byCategory: Object.fromEntries(categories.map((category) => [category, rate(rows.filter((row) => row.category === category).map((row) => row.deterministic))])),
        byLanguage: Object.fromEntries(languages.map((language) => [language, rate(rows.filter((row) => row.language === language).map((row) => row.deterministic))])),
        readerLatencyMs: { p50: percentile(rows.map((row) => row.readerMs), 50), p95: percentile(rows.map((row) => row.readerMs), 95) },
      }]
    }))
    const contextByArm = Object.fromEntries(CONTEXT_ARMS.map((arm) => {
      const rows = contextRows.filter((row) => row.arm === arm)
      return [arm, {
        diagnosticOnly: arm === 'oracle',
        evidenceCoverage: rate(rows.map((row) => row.evidenceHit)),
        forbiddenLeak: rate(rows.map((row) => row.leak)),
        personalContentWhenNoneNeeded: rate(rows.map((row) => row.injectedWhenNone)),
        meanItems: Math.round(mean(rows.map((row) => row.items)) * 100) / 100,
        failures: rows.filter((row) => row.failure).map((row) => `${row.trajectory}/${row.query}: ${row.failure}`),
        selectionMs: { p50: percentile(rows.map((row) => row.selectionMs), 50), p95: percentile(rows.map((row) => row.selectionMs), 95), p99: percentile(rows.map((row) => row.selectionMs), 99) },
        estimatedTokens: { mean: Math.round(mean(rows.map((row) => row.estimatedTokens)) || 0), max: Math.max(0, ...rows.map((row) => row.estimatedTokens)) },
      }]
    }))
    const comparisons = answered ? {
      deterministicPass: (['none', 'legacy', 'profile_summary'] as const).map((arm) => paired((row) => (row.deterministic ? 1 : 0), arm, 'full')),
      judgePass: (['none', 'legacy', 'profile_summary'] as const).map((arm) => paired((row) => (row.judgePass === null ? null : row.judgePass ? 1 : 0), arm, 'full')),
      falsePersonalClaim: (['legacy', 'profile_summary'] as const).map((arm) => paired((row) => (row.judge ? (row.judge.false_personal_claim ? 1 : 0) : null), arm, 'full')),
      unnecessaryPersonalization: (['legacy', 'profile_summary'] as const).map((arm) => paired((row) => (row.judge ? (row.judge.unnecessary_personalization ? 1 : 0) : null), arm, 'full')),
    } : null
    const context = (arm: ContextArm) => (row: ContextRow) => row.arm === arm
    const ingestion = systemsLog.flatMap((item) => item.ingestion)
    let commit = 'unknown'
    try { commit = execSync('git rev-parse HEAD', { cwd: root }).toString().trim() } catch { commit = 'unknown' }
    const fileHash = (path: string) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')
    const report = {
      stage: 13,
      split,
      label: split === 'heldout' ? 'held-out pilot (diagnostic; not a competitive claim)' : 'development split (harness debugging only)',
      liveCallsAllowed: live,
      answersAvailable: answered,
      manifest: {
        commit,
        fixture: { path: FIXTURE, sha256: fileHash(FIXTURE) },
        scoringLibrarySha256: fileHash('scripts/lib/memory-eval.ts'),
        preregistration: 'docs/memory/reports/stage-13-preregistration.md',
        reader: { model: AUTHORIZED_MODEL, promptVersion: READER_PROMPT_VERSION, temperature: 0, seeds: READER_SEEDS, reasoningEffort: 'minimal', maxTokens: 300 },
        judge: { model: AUTHORIZED_MODEL, promptVersion: JUDGE_PROMPT_VERSION, temperature: 0, seeds: JUDGE_SEEDS, verdictFromSeed: JUDGE_SEEDS[0], blindedToArm: true },
        extractor: `${RULE_EXTRACTOR.id}@${RULE_EXTRACTOR.version} (production default)`,
        retrieval: 'lexical (PostgreSQL simple tsvector + prefix stem); standard budget via createRecallInput',
        bootstrap: { resamples: 10_000, seed: 13, unit: 'trajectory' },
        node: process.version,
      },
      counts: { trajectories: trajectories.length, queries: trajectories.reduce((sum, trajectory) => sum + trajectory.queries.length, 0) },
      answers: byArm,
      comparisons,
      context: contextByArm,
      construction: {
        explicitFailures: ingestion.filter((item) => !item.ok),
        fullIngestMs: percentile(systemsLog.map((item) => item.ingestMs.full), 50),
        fullMaintenanceMsTotal: Math.round(systemsLog.reduce((sum, item) => sum + item.maintenanceMs, 0)),
        legacyIngestMs: percentile(systemsLog.map((item) => item.ingestMs.legacy), 50),
      },
      spend: { usd: Math.round(spend.usd * 10_000) / 10_000, liveCalls: spend.calls, cacheHits: spend.cacheHits, errors: spend.errors, capUsd: SPEND_CAP_USD },
      blocked: {
        jev: 'no TypeSafe API key available',
        hybridRetrieval: 'not implemented in the runtime',
        externalProviders: 'no provider account authorized',
        publicBenchmarks: 'LongMemEval / PersonaMem / LoCoMo-Plus need a dataset download that has not been authorized',
        humanReview: 'needs a reviewer',
      },
    }
    const details = {
      split,
      context: contextRows.filter((row) => row.arm !== 'none').map(({ framed: _framed, ...row }) => row),
      answers: answers.map((row) => ({ ...row, readerMs: undefined })),
      fullContextByQuery: Object.fromEntries(contextRows.filter(context('full')).map((row) => [`${row.trajectory}/${row.query}`, row.content])),
    }
    const out = resolve(root, `docs/memory/reports/stage-13-${split}.json`)
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
    writeFileSync(resolve(root, `docs/memory/reports/stage-13-${split}-details.json`), `${JSON.stringify(details, null, 2)}\n`)
    console.log(JSON.stringify({ split, answers: Object.fromEntries(Object.entries(byArm).map(([arm, value]) => [arm, value.deterministicPass])), comparisons: comparisons?.deterministicPass, spend: report.spend }, null, 2))
  }
})
