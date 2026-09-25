import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openProcedures, SqliteProcedureStore, type Advice, type ProcedureManifest } from '../src/procedures.ts'
import { createMemoryServer } from '../src/server.ts'
import { SqliteMemoryBackend } from '../src/sqlite.ts'

const backend = new SqliteMemoryBackend({ path: ':memory:' })
const store = new SqliteProcedureStore({ path: ':memory:' })
const OPERATOR = 'operator-token-0123456789ab'
const VIEWER = 'viewer-token-0123456789abcd'
const service = createMemoryServer({
  backend,
  procedures: store,
  tokens: new Map([
    [OPERATOR, { scopeId: 'team', principalId: 'team', capabilities: ['deploy'] }],
    [VIEWER, { scopeId: 'team', principalId: 'team', capabilities: [] }],
  ]),
})
let url = ''

const manifest: ProcedureManifest = {
  manifestVersion: 1, kind: 'task', name: 'publish-static-site',
  trigger: { intent: 'deploy the site', keywords: ['deploy', 'site'] },
  inputs: [], preconditions: [], stopConditions: ['A test fails'],
  steps: [{ id: 'test', instruction: 'Run the tests.' }, { id: 'deploy', instruction: 'Deploy the build.', capability: 'deploy' }],
  verification: { method: 'observed_outcome', description: 'Production serves the build.' },
  environment: { platform: 'cloudflare-pages' }, toolVersions: {}, requiredCapabilities: ['deploy'],
}

beforeAll(async () => {
  url = (await service.listen()).url
  const procedures = openProcedures({ store, scopeId: 'team', principalId: 'team' })
  procedures.recordEpisode({ episodeId: 'ep', taskId: 'alpha', summary: 'Deployed alpha', outcome: 'succeeded', observedBy: 'tool_result', evidenceRef: 'log' })
  const version = procedures.propose({ manifest, sourceEpisodes: ['ep'], createdBy: 'learner' })
  procedures.review({ ...version, reviewer: 'reviewer', decision: 'approve', note: 'ok' })
  procedures.recordVerification({ ...version, verifier: 'checker', variantId: 'beta', kind: 'held_out_variant', outcome: 'passed', observedBy: 'external_check' })
  procedures.recordVerification({ ...version, verifier: 'checker', variantId: 'gamma', kind: 'negative_precondition', outcome: 'passed', observedBy: 'external_check' })
  procedures.promote(version)
})

afterAll(async () => {
  await service.close()
  await backend.close()
  store.close()
})

const post = (token: string, operation: string, body: unknown) => fetch(`${url}/v1/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('procedures over the local server', () => {
  it('C29: capabilities come from the host token; stored instructions and request bodies cannot add any', async () => {
    const request = { task: 'deploy the site', environment: { platform: 'cloudflare-pages' } }
    const operator = (await (await post(OPERATOR, 'procedures-advise', request)).json()) as { result: Advice[] }
    expect(operator.result[0]).toMatchObject({ usable: true, missingCapabilities: [] })
    const viewer = (await (await post(VIEWER, 'procedures-advise', request)).json()) as { result: Advice[] }
    expect(viewer.result[0]).toMatchObject({ usable: false, missingCapabilities: ['deploy'] })
    expect((await post(VIEWER, 'procedures-advise', { ...request, capabilities: ['deploy'] })).status).toBe(400)
  })

  it('shows versions and evidence to the inspector', async () => {
    const inspected = (await (await post(VIEWER, 'procedures-inspect', { name: 'publish-static-site' })).json()) as { result: { versions: { status: string; sources: unknown[] }[] } }
    expect(inspected.result.versions).toMatchObject([{ status: 'verified', sources: [{ episodeId: 'ep', observedBy: 'tool_result' }] }])
  })
})
