import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { adviceFromManifest, openProcedures, SqliteProcedureStore, type Advice, type ProcedureManifest } from '../src/procedures.ts'
import { terms } from '../src/text.ts'

/**
 * Stage 17 held-out comparison in a deterministic, synthetic deploy
 * simulator. It measures the mechanism (does advice help, does it avoid
 * harmful shortcuts, is stale or unverified advice kept out), not the quality
 * of any model: the "agent" follows advice literally.
 *
 * Writes docs/memory/reports/stage-17-procedures-eval.json.
 */

interface World { site: string; platform: string; branch: string; tests: 'passing' | 'failing'; canDeploy: boolean }
interface Result { outcome: 'deployed' | 'stopped' | 'wrong_platform'; ranTests: boolean }

const PRODUCTION = 'cloudflare-pages'

/** The independent verifier: what should have happened in this world. */
function correct(world: World): 'deploy' | 'stop' {
  return world.tests === 'passing' && world.branch === 'main' && world.canDeploy ? 'deploy' : 'stop'
}

/** Runs step ids against the world, the way a literal agent would. */
function run(world: World, steps: readonly string[], platform: string): Result {
  let ranTests = false
  for (const step of steps) {
    if (step === 'test') {
      ranTests = true
      if (world.tests === 'failing') return { outcome: 'stopped', ranTests }
    }
    if (step === 'deploy') {
      if (!world.canDeploy) return { outcome: 'stopped', ranTests }
      return { outcome: platform === world.platform ? 'deployed' : 'wrong_platform', ranTests }
    }
  }
  return { outcome: 'stopped', ranTests }
}

function score(world: World, result: Result) {
  const wanted = correct(world)
  const success = wanted === 'deploy' ? result.outcome === 'deployed' : result.outcome === 'stopped'
  // Harm: anything shipped that should not have been, or shipped to the wrong place.
  const harmful = result.outcome === 'wrong_platform' || (result.outcome === 'deployed' && wanted === 'stop')
  return { success, harmful }
}

/** Past episodes, as raw retrieval would return them: summaries and the actions taken. */
const EPISODES = [
  { id: 'ep-netlify', task: 'deploy the marketing site to production', platform: 'netlify', actions: ['build', 'deploy'], observed: true },
  { id: 'ep-preview', task: 'deploy a preview of the site from a feature branch', platform: PRODUCTION, actions: ['build', 'deploy'], observed: true },
  { id: 'ep-cf', task: 'publish the docs site to production on cloudflare', platform: PRODUCTION, actions: ['test', 'build', 'deploy'], observed: true },
]

function base(overrides: Partial<ProcedureManifest>): ProcedureManifest {
  return {
    manifestVersion: 1, kind: 'task', name: 'publish-static-site',
    trigger: { intent: 'deploy or publish a static site to production', keywords: ['deploy', 'publish', 'site', 'production'] },
    inputs: [{ name: 'site', description: 'Which site', required: true }],
    preconditions: [
      { id: 'tests-pass', fact: 'tests', op: 'eq', value: 'passing', description: 'The test suite passes' },
      { id: 'on-main', fact: 'branch', op: 'eq', value: 'main', description: 'Releasing from main' },
    ],
    steps: [{ id: 'test', instruction: 'Run the tests; stop on any failure.' }, { id: 'build', instruction: 'Build for production.' }, { id: 'deploy', instruction: 'Deploy the build to the production project.', capability: 'deploy' }],
    stopConditions: ['A test fails', 'Not on main'],
    verification: { method: 'observed_outcome', description: 'Production serves the new build.' },
    environment: { platform: PRODUCTION }, toolVersions: {}, requiredCapabilities: ['deploy'],
    ...overrides,
  }
}

const store = new SqliteProcedureStore({ path: ':memory:' })
afterAll(() => store.close())

it('held-out comparison: raw episodes vs previous version vs current version vs an unpromoted shortcut', () => {
  const procedures = openProcedures({ store, scopeId: 'eval', principalId: 'eval' })
  for (const episode of EPISODES) procedures.recordEpisode({ episodeId: episode.id, taskId: episode.id, summary: episode.task, outcome: 'succeeded', observedBy: episode.observed ? 'tool_result' : 'assistant_claim', evidenceRef: `log-${episode.id}` })
  const promoteWith = (manifest: ProcedureManifest, source: string) => {
    const version = procedures.propose({ manifest, sourceEpisodes: [source], createdBy: 'learner' })
    procedures.review({ ...version, reviewer: 'reviewer', decision: 'approve', note: 'matches observed run' })
    procedures.recordVerification({ ...version, verifier: 'checker', variantId: `train-pos-${version.version}`, kind: 'held_out_variant', outcome: 'passed', observedBy: 'external_check' })
    procedures.recordVerification({ ...version, verifier: 'checker', variantId: `train-neg-${version.version}`, kind: 'negative_precondition', outcome: 'passed', observedBy: 'external_check' })
    procedures.promote(version)
    return version.version
  }
  // v1 was verified before the move to Cloudflare; v2 after it. v3 skips the tests and never got past shadow.
  const v1 = promoteWith(base({ environment: { platform: 'netlify' } }), 'ep-netlify')
  const v2 = promoteWith(base({}), 'ep-cf')
  const v3 = procedures.propose({ manifest: base({ steps: [{ id: 'build', instruction: 'Build for production.' }, { id: 'deploy', instruction: 'Deploy the build to the production project.', capability: 'deploy' }], preconditions: [] }), sourceEpisodes: ['ep-cf'], createdBy: 'learner' }).version

  // Held-out variants: sites never seen in training; half must deploy, half must stop.
  const variants: World[] = [
    ...['shop', 'blog', 'careers', 'status', 'pricing', 'help'].map((site) => ({ site, platform: PRODUCTION, branch: 'main', tests: 'passing' as const, canDeploy: true })),
    { site: 'shop', platform: PRODUCTION, branch: 'main', tests: 'failing', canDeploy: true },
    { site: 'blog', platform: PRODUCTION, branch: 'feature-nav', tests: 'passing', canDeploy: true },
    { site: 'careers', platform: PRODUCTION, branch: 'main', tests: 'failing', canDeploy: true },
    { site: 'status', platform: PRODUCTION, branch: 'hotfix-banner', tests: 'failing', canDeploy: true },
    { site: 'pricing', platform: PRODUCTION, branch: 'main', tests: 'passing', canDeploy: false },
    { site: 'help', platform: PRODUCTION, branch: 'feature-search', tests: 'passing', canDeploy: true },
  ]

  const allVersions = new Map(procedures.inspect('publish-static-site').versions.map((item) => [item.version, item.manifest]))
  const adviceFor = (world: World, version: number | 'current' | 'shadow'): Advice | null => {
    const request = { task: `please deploy the ${world.site} site to production`, environment: { platform: world.platform }, facts: { tests: world.tests, branch: world.branch }, capabilities: world.canDeploy ? ['deploy'] : [] }
    if (version === 'current') return procedures.advise(request)[0] ?? null
    if (version === 'shadow') return procedures.adviseShadow(request).find((item) => item.version === v3) ?? null
    // The previous version, as if it were still the one recalled: same recall-time checks.
    return adviceFromManifest('publish-static-site', version, allVersions.get(version)!, request)
  }

  /** A literal agent: follows usable advice; otherwise stops and says why. */
  const follow = (world: World, advice: Advice | null, platform = PRODUCTION): Result => (advice && advice.usable ? run(world, advice.steps.map((step) => step.id), platform) : { outcome: 'stopped', ranTests: false })
  /** Raw retrieval: the most similar past episode's actions, replayed on that episode's platform. */
  const rawEpisode = (world: World): Result => {
    const wanted = new Set(terms(`please deploy the ${world.site} site to production`))
    const best = [...EPISODES].sort((left, right) => terms(right.task).filter((term) => wanted.has(term)).length - terms(left.task).filter((term) => wanted.has(term)).length)[0]!
    return run(world, world.canDeploy ? best.actions : best.actions.filter((action) => action !== 'deploy'), best.platform)
  }

  const arms: Record<string, (world: World) => Result> = {
    raw_episode_replay: rawEpisode,
    previous_version_v1: (world) => follow(world, adviceFor(world, v1), 'netlify'),
    current_version_v2: (world) => follow(world, adviceFor(world, 'current')),
    shadow_candidate_v3: (world) => follow(world, (() => {
      const advice = adviceFor(world, 'shadow')
      // Shadow advice is never followed in production; here it is followed only to measure it.
      return advice ? { ...advice, usable: advice.compatibility === 'compatible' && advice.missingCapabilities.length === 0 } : null
    })()),
  }
  const results = Object.fromEntries(Object.entries(arms).map(([arm, policy]) => {
    const scored = variants.map((world) => score(world, policy(world)))
    return [arm, {
      variants: scored.length,
      verifiedSuccess: scored.filter((item) => item.success).length / scored.length,
      harmfulShortcuts: scored.filter((item) => item.harmful).length / scored.length,
      positives: scored.slice(0, 6).filter((item) => item.success).length,
      negativesStoppedCorrectly: scored.slice(6).filter((item) => item.success).length,
    }]
  })) as Record<string, { variants: number; verifiedSuccess: number; harmfulShortcuts: number; positives: number; negativesStoppedCorrectly: number }>

  const current = results.current_version_v2!
  procedures.recordAdoption({
    name: 'publish-static-site', version: v2,
    decision: current.harmfulShortcuts === 0 && current.verifiedSuccess > results.raw_episode_replay!.verifiedSuccess ? 'adopt' : 'defer',
    reason: 'Advisory only: better held-out success than raw episode replay with no harmful shortcut in the synthetic simulator. Automatic execution stays off.',
    metrics: { verifiedSuccess: current.verifiedSuccess, harmfulShortcuts: current.harmfulShortcuts },
  })

  const report = {
    stage: 17,
    label: 'deterministic synthetic deploy simulator; measures the mechanism, not any model or real deployment',
    caveat: 'The past episodes were chosen to include a stale provider and a preview deploy, so raw replay fails by construction; these rates show the safeguards working on those cases, not a general estimate of benefit.',
    heldOutVariants: variants.length,
    arms: results,
    adoption: procedures.inspect('publish-static-site').adoptions,
    versions: procedures.inspect('publish-static-site').versions.map((item) => ({ version: item.version, status: item.status })),
  }
  writeFileSync(resolve(import.meta.dirname, '../../../docs/memory/reports/stage-17-procedures-eval.json'), `${JSON.stringify(report, null, 2)}\n`)

  expect(current).toMatchObject({ verifiedSuccess: 1, harmfulShortcuts: 0 })
  expect(results.raw_episode_replay!.harmfulShortcuts).toBeGreaterThan(0)
  expect(results.previous_version_v1!.harmfulShortcuts).toBe(0)
  expect(results.shadow_candidate_v3!.harmfulShortcuts).toBeGreaterThan(0)
  expect(report.versions).toEqual([{ version: 1, status: 'superseded' }, { version: 2, status: 'verified' }, { version: 3, status: 'candidate' }])
})
