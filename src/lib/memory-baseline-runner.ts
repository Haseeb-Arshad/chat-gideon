import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { arch, hostname, platform, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import {
  MAX_MEMORIES,
  EphemeralMemoryStore,
  JsonMemoryStore,
  type Memory,
  type MemoryStore,
} from './tools/memory'
import { runServerTool, type ToolContext } from './tools/registry'
import {
  createCurrentMemoryBaseline,
  createProfileSessionSummaryBaseline,
  measureBaseline,
  type BaselineMeasurement,
} from './memory-baseline'

interface SeedCase {
  id: string
  category: string
  release_blocking: boolean
}

interface SeedSchema {
  schema_version: string
  status: string
  cases: SeedCase[]
}

interface FixtureResult {
  caseId: string
  backend: string
  capability: string
  outcome: 'PASS' | 'FAIL' | 'NOT_IMPLEMENTED'
  latencyBoundary: string
  latencyMs?: number
  evidence: string
  releaseBlocking: boolean
}

export interface Stage01BaselineReport {
  reportVersion: string
  generatedAt: string
  scope: string
  runtime: { node: string; platform: string; release: string; arch: string; host: string }
  sourceSchema: string
  fixtureSummary: {
    totalCases: number
    pass: number
    fail: number
    notImplemented: number
    releaseBlockingNotImplemented: number
  }
  fixtureResults: FixtureResult[]
  corpusMeasurements: Array<{ corpus: string; sampleCount: number; measurements: BaselineMeasurement[] }>
  profileSessionSummaryMeasurements: BaselineMeasurement[]
  persistenceMeasurement: { backend: string; ok: boolean; persistenceMs: number; corpusCount: number; evidence: string }
  capacityMembership: { ok: boolean; corpusCount: number; newFactPresent: boolean }
  boundaries: Record<string, string | boolean>
}

function parseSchema(value: unknown): SeedSchema {
  if (!value || typeof value !== 'object') throw new Error('Acceptance schema is not an object')
  const schema = value as Partial<SeedSchema>
  if (schema.schema_version !== '0.1' || schema.status !== 'seed_specifications_not_executable_tests') {
    throw new Error('Acceptance schema version/status is not supported')
  }
  if (!Array.isArray(schema.cases) || schema.cases.some((item) => !item || typeof item.id !== 'string' || typeof item.category !== 'string' || typeof item.release_blocking !== 'boolean')) {
    throw new Error('Acceptance schema cases are not valid')
  }
  return schema as SeedSchema
}

function context(store: MemoryStore): ToolContext {
  return { store, timezone: 'UTC', signal: new AbortController().signal, env: () => undefined }
}

function legacyCorpus(size: number): Memory[] {
  const stamp = '2026-09-21T00:00:00.000Z'
  return Array.from({ length: size }, (_, index) => ({
    id: `baseline-${size}-${index}`,
    kind: 'fact' as const,
    text: size === 400 ? `Existing durable detail ${index}` : `Synthetic baseline detail ${index}`,
    createdAt: stamp,
    usedAt: stamp,
    uses: size === 400 ? 1 : 0,
  }))
}

async function capacityFixture(): Promise<{ result: FixtureResult; persistence: { ok: boolean; corpusCount: number; newFactPresent: boolean } }> {
  const store = new EphemeralMemoryStore()
  await store.save(legacyCorpus(MAX_MEMORIES))
  const startedAt = performance.now()
  const outcome = await runServerTool('remember', { text: 'The user prefers quiet venues' }, context(store))
  const latencyMs = performance.now() - startedAt
  const corpus = await store.all()
  const newFactPresent = corpus.some((memory) => memory.text === 'The user prefers quiet venues')
  const pass = !outcome.ok && !newFactPresent && corpus.length === MAX_MEMORIES
  return {
    result: {
      caseId: 'C26',
      backend: 'legacy-memory',
      capability: 'truthful-capacity-receipt',
      outcome: pass ? 'PASS' : 'FAIL',
      latencyBoundary: 'local in-process legacy tool and ephemeral store; not voice or deployment',
      latencyMs: Number(latencyMs.toFixed(3)),
      evidence: pass
        ? 'The full 400-record corpus remained intact, the new record was absent, and the tool returned ok=false.'
        : 'Capacity fixture did not produce the required failed receipt and membership result.',
      releaseBlocking: true,
    },
    persistence: { ok: outcome.ok, corpusCount: corpus.length, newFactPresent },
  }
}

function fixtureResultFor(caseItem: SeedCase): FixtureResult {
  if (caseItem.id === 'C33') {
    return {
      caseId: caseItem.id,
      backend: 'legacy-memory',
      capability: 'durable-quota-receipt',
      outcome: 'NOT_IMPLEMENTED',
      latencyBoundary: 'not-run',
      evidence: 'The legacy MemoryStore has no per-user durable quota contract; this case is not counted as a pass.',
      releaseBlocking: caseItem.release_blocking,
    }
  }
  return {
    caseId: caseItem.id,
    backend: 'legacy-memory',
    capability: `stage-01:${caseItem.category}`,
    outcome: 'NOT_IMPLEMENTED',
    latencyBoundary: 'not-run',
    evidence: 'Outside Stage 01 scope; retained in the denominator rather than silently passing or being removed.',
    releaseBlocking: caseItem.release_blocking,
  }
}

async function persistenceFixture(): Promise<{ backend: string; ok: boolean; persistenceMs: number; corpusCount: number; evidence: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'gideon-memory-baseline-'))
  try {
    const store = new JsonMemoryStore(join(directory, 'memory.json'))
    const startedAt = performance.now()
    const outcome = await runServerTool('remember', { text: 'The user prefers concise baseline replies' }, context(store))
    const persistenceMs = performance.now() - startedAt
    return {
      backend: 'json-memory-local-fixture',
      ok: outcome.ok,
      persistenceMs: Number(persistenceMs.toFixed(3)),
      corpusCount: (await store.all()).length,
      evidence: 'Local Node JSON store only; no database, Worker, deployment, provider, or customer data involved.',
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function runStage01Baseline(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
): Promise<Stage01BaselineReport> {
  const schemaPath = join(root, 'docs/memory/acceptance-scenarios.json')
  const reportPath = join(root, 'docs/memory/reports/stage-01-baseline.json')
  const schema = parseSchema(JSON.parse(await readFile(schemaPath, 'utf8')))
  const capacity = await capacityFixture()
  const persistence = await persistenceFixture()
  const queries = [
    { label: 'empty/no-match', query: 'quiet venue' },
    { label: 'small/detail', query: 'baseline detail' },
    { label: 'cap-sized/detail', query: 'durable detail' },
  ]
  const corpusMeasurements = [
    { corpus: 'empty', sampleCount: 0, measurements: measureBaseline(createCurrentMemoryBaseline(legacyCorpus(0)), [queries[0]!]) },
    { corpus: 'small', sampleCount: 3, measurements: measureBaseline(createCurrentMemoryBaseline(legacyCorpus(3)), [queries[1]!]) },
    { corpus: 'cap-sized', sampleCount: MAX_MEMORIES, measurements: measureBaseline(createCurrentMemoryBaseline(legacyCorpus(MAX_MEMORIES)), [queries[2]!]) },
  ]
  const summaryMeasurements = measureBaseline(
    createProfileSessionSummaryBaseline({
      profile: 'The user prefers concise replies for ordinary work.',
      sessions: [
        { id: 'session-1', summary: 'The user compared quiet venues for a client meeting.' },
        { id: 'session-2', summary: 'The user selected a morning meeting time.' },
      ],
    }),
    [
      { label: 'profile', query: 'concise work replies' },
      { label: 'session-summary', query: 'quiet client meeting' },
    ],
  )
  const fixtureResults = schema.cases.map(fixtureResultFor)
  const c26Index = fixtureResults.findIndex((result) => result.caseId === 'C26')
  if (c26Index < 0) throw new Error('Acceptance schema is missing C26')
  fixtureResults[c26Index] = capacity.result
  if (!schema.cases.some((caseItem) => caseItem.id === 'C33')) throw new Error('Acceptance schema is missing C33')

  const report: Stage01BaselineReport = {
    reportVersion: 'stage-01-baseline-v1',
    generatedAt: new Date().toISOString(),
    scope: 'local offline baseline; not staging, production, live provider, or voice proof',
    runtime: { node: process.version, platform: platform(), release: release(), arch: arch(), host: hostname() },
    sourceSchema: 'docs/memory/acceptance-scenarios.json',
    fixtureSummary: {
      totalCases: fixtureResults.length,
      pass: fixtureResults.filter((result) => result.outcome === 'PASS').length,
      fail: fixtureResults.filter((result) => result.outcome === 'FAIL').length,
      notImplemented: fixtureResults.filter((result) => result.outcome === 'NOT_IMPLEMENTED').length,
      releaseBlockingNotImplemented: fixtureResults.filter((result) => result.releaseBlocking && result.outcome === 'NOT_IMPLEMENTED').length,
    },
    fixtureResults,
    corpusMeasurements,
    profileSessionSummaryMeasurements: summaryMeasurements,
    persistenceMeasurement: persistence,
    capacityMembership: capacity.persistence,
    boundaries: {
      rawUserTextLogged: false,
      selectionLatency: 'performance.now around synchronous lexical selection; no network/provider time',
      contextLength: 'UTF-16 character count plus an approximate four-characters-per-token estimate',
      persistenceLatency: 'performance.now around the local tool and local store write',
      summaryBaseline: 'controlled supplied-summary fixtures, not a configured summarizer',
    },
  }

  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}
