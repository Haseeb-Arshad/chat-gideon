import { rank, type Memory } from './tools/memory'

/**
 * Offline comparison surfaces for the current legacy memory and the simplest
 * profile-plus-session-summary alternative. These adapters are read-only: a
 * baseline measurement must not change usage counters or durable state.
 */

export type BaselineBackend = 'legacy-memory' | 'profile-session-summary'
export type BaselineSource = 'legacy-memory' | 'supplied-summary-fixture'
export type BaselineRecordKind = 'memory' | 'profile' | 'session-summary'

export interface BaselineRecord {
  id: string
  kind: BaselineRecordKind
  text: string
  source: BaselineSource
}

export interface BaselineSelection {
  backend: BaselineBackend
  source: BaselineSource
  records: BaselineRecord[]
  context: string
  contextChars: number
  /** A stable estimate for offline comparisons, not a provider tokenizer count. */
  estimatedTokens: number
}

export interface MemoryBaselineAdapter {
  backend: BaselineBackend
  source: BaselineSource
  select: (query: string, limit?: number) => BaselineSelection
}

export interface SummaryFixture {
  profile: string
  sessions: Array<{ id: string; summary: string }>
}

export interface BaselineQuery {
  label: string
  query: string
}

export interface BaselineMeasurement {
  queryLabel: string
  backend: BaselineBackend
  source: BaselineSource
  selectionMs: number
  selectedCount: number
  contextChars: number
  estimatedTokens: number
}

function contextFor(records: BaselineRecord[]): Pick<BaselineSelection, 'context' | 'contextChars' | 'estimatedTokens'> {
  const context = records.map((record) => `[${record.kind}] ${record.text}`).join('\n')
  return {
    context,
    contextChars: context.length,
    estimatedTokens: context ? Math.ceil(context.length / 4) : 0,
  }
}

function memoryRecord(memory: Memory, source: BaselineSource, kind: BaselineRecordKind = 'memory'): BaselineRecord {
  return { id: memory.id, kind, text: memory.text, source }
}

function fixtureMemory(id: string, text: string): Memory {
  const stamp = '2026-09-21T00:00:00.000Z'
  return { id, kind: 'fact', text, createdAt: stamp, usedAt: stamp, uses: 0 }
}

function selection(
  backend: BaselineBackend,
  source: BaselineSource,
  records: BaselineRecord[],
): BaselineSelection {
  return { backend, source, records, ...contextFor(records) }
}

/** Reproduces current lexical selection without touching the legacy corpus. */
export function createCurrentMemoryBaseline(memories: Memory[], defaultLimit = 4): MemoryBaselineAdapter {
  const corpus = structuredClone(memories)
  return {
    backend: 'legacy-memory',
    source: 'legacy-memory',
    select(query, limit = defaultLimit) {
      const records = rank(corpus, query)
        .slice(0, Math.max(0, limit))
        .map((hit) => memoryRecord(hit.memory, 'legacy-memory'))
      return selection('legacy-memory', 'legacy-memory', records)
    },
  }
}

/**
 * A controlled, supplied-summary fixture for the profile/session-summary
 * baseline. It is deliberately not called a real summarizer or a production
 * profile implementation.
 */
export function createProfileSessionSummaryBaseline(
  fixture: SummaryFixture,
  defaultLimit = 4,
): MemoryBaselineAdapter {
  const corpus = [
    memoryRecord(fixtureMemory('profile', fixture.profile), 'supplied-summary-fixture', 'profile'),
    ...fixture.sessions.map((session) =>
      memoryRecord(fixtureMemory(session.id, session.summary), 'supplied-summary-fixture', 'session-summary'),
    ),
  ]
  const searchable = corpus.map((record) => fixtureMemory(record.id, record.text))

  return {
    backend: 'profile-session-summary',
    source: 'supplied-summary-fixture',
    select(query, limit = defaultLimit) {
      const selected = rank(searchable, query)
        .slice(0, Math.max(0, limit))
        .map((hit) => corpus.find((record) => record.id === hit.memory.id)!)
      return selection('profile-session-summary', 'supplied-summary-fixture', selected)
    },
  }
}

/** Measure local selection and context size without retaining the query text. */
export function measureBaseline(
  adapter: MemoryBaselineAdapter,
  queries: BaselineQuery[],
  clock: () => number = () => performance.now(),
): BaselineMeasurement[] {
  return queries.map(({ label, query }) => {
    const startedAt = clock()
    const result = adapter.select(query)
    const selectionMs = Math.max(0, clock() - startedAt)
    return {
      queryLabel: label,
      backend: result.backend,
      source: result.source,
      selectionMs,
      selectedCount: result.records.length,
      contextChars: result.contextChars,
      estimatedTokens: result.estimatedTokens,
    }
  })
}
