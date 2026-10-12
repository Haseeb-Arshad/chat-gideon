import { Pool } from 'pg'
import { PostgresMemoryStore } from '../../memory/src/postgres.ts'
import { runMemoryMaintenance } from '../../memory/src/background.ts'
import { createModelExtractor } from '../../memory/src/model-extractor.ts'
import { embeddingProviderFromEnv } from '../../memory/src/providers.ts'
import { indexPendingMemories } from '../../memory/src/index-pending.ts'
import { createServerMemorySession } from '../../../src/server/memory-session.ts'
import { memoryLearningEnabled } from '../../../src/lib/memory/rollout.ts'
import { RULE_EXTRACTOR } from '../../../src/lib/memory/rule-extractor.ts'
import { runOfflineRefinement } from '../../memory/src/refiner.ts'
import { createRefinementModel } from '../../memory/src/refinement-provider.ts'
import type { ScopeId } from '../../../src/lib/memory/contracts.ts'
import type { Env } from './types.ts'

export interface MemoryMaintenanceMessage { scopeId: string; version: 1 }
function storeFor(env: Env) {
  if (!env.HYPERDRIVE) throw new Error('Memory maintenance needs Hyperdrive')
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1, connectionTimeoutMillis: 3000, application_name: 'gideon-memory-maintenance' })
  pool.on('error', () => undefined)
  return { store: new PostgresMemoryStore(pool), close: () => pool.end() }
}
function extractor(env: Env) {
  return env.GIDEON_MEMORY_EXTRACTOR === 'model' && env.GIDEON_MEMORY_EXTRACTOR_REMOTE_ALLOWED === '1' && env.OPENROUTER_API_KEY
    ? createModelExtractor({ apiKey: env.OPENROUTER_API_KEY, model: env.GIDEON_MEMORY_EXTRACTOR_MODEL, siteUrl: env.OPENROUTER_SITE_URL }) : RULE_EXTRACTOR
}

/** Global purge/retention first, then fair per-owner dispatch. Messages contain no memory text. */
export async function dispatchMemoryMaintenance(env: Env): Promise<void> {
  if (env.GIDEON_MEMORY_BACKGROUND_ENABLED !== '1') return
  const { store, close } = storeFor(env)
  try {
    const report = await runMemoryMaintenance(store, { workerId: 'worker/cron', extractor: RULE_EXTRACTOR, learning: false, learningEnabledFor: () => false, limits: { learningJobs: 0, projectionJobs: 0, purgeTasks: 100 } })
    const embedding=embeddingProviderFromEnv(env)
    const rows = await store.runTransaction(async tx => {
      const ready = await tx.query<{ scope_id: string }>(`SELECT s.scope_id FROM gideon_memory.scopes s
        JOIN gideon_memory.authority_cutovers a ON a.scope_id=s.scope_id AND a.state='active'
        LEFT JOIN gideon_memory.maintenance_dispatch d ON d.scope_id=s.scope_id
        WHERE s.scope_id LIKE 'user/%' AND COALESCE(d.lease_until, 'epoch') < now()
        AND (EXISTS (SELECT 1 FROM gideon_memory.jobs j WHERE j.scope_id=s.scope_id AND ((j.state IN ('pending','retry') AND j.available_at<=now()) OR (j.state='running' AND j.lease_until<now())))
          OR ($1<>'' AND EXISTS (SELECT 1 FROM gideon_memory.assertions m WHERE m.scope_id=s.scope_id AND m.current_status='accepted' AND NOT EXISTS(SELECT 1 FROM gideon_memory.retrieval_embeddings v WHERE v.scope_id=m.scope_id AND v.assertion_id=m.assertion_id AND v.assertion_revision=m.current_revision AND v.model_id=$1 AND v.model_version=$2) AND NOT EXISTS(SELECT 1 FROM gideon_memory.embedding_exclusions v WHERE v.scope_id=m.scope_id AND v.assertion_id=m.assertion_id AND v.assertion_revision=m.current_revision AND v.model_id=$1 AND v.model_version=$2)))
          OR ($3 AND (d.refined_at IS NULL OR d.refined_at<now()-interval '1 day') AND (SELECT count(*) FROM gideon_memory.turn_traces t WHERE t.scope_id=s.scope_id)>=8))
        ORDER BY COALESCE(d.dispatched_at, 'epoch'), s.scope_id LIMIT 20 FOR UPDATE OF s SKIP LOCKED`,[embedding?.modelId ?? '',embedding?.modelVersion ?? '',env.GIDEON_MEMORY_REFINER_REMOTE_ALLOWED==='1'])
      for (const row of ready.rows) await tx.query(`INSERT INTO gideon_memory.maintenance_dispatch (scope_id, dispatched_at, lease_until) VALUES ($1, now(), now()+interval '90 seconds') ON CONFLICT(scope_id) DO UPDATE SET dispatched_at=now(), lease_until=now()+interval '90 seconds'`, [row.scope_id])
      return ready.rows
    })
    if (env.MEMORY_MAINTENANCE) {
      if (rows.length) await env.MEMORY_MAINTENANCE.sendBatch(rows.map(row => ({ body: { scopeId: row.scope_id, version: 1 as const } })))
    } else {
      // Local and single-host fallback; deployed config binds the queue.
      for (const row of rows.slice(0, 2)) await maintainMemoryScope(env, { scopeId: row.scope_id, version: 1 })
    }
    console.log(JSON.stringify({ event: 'memory_maintenance_dispatch', owners: rows.length, purge: report.purge, oldestPendingSeconds: report.queue.oldestPendingSeconds }))
  } finally { await close() }
}

export async function maintainMemoryScope(env: Env, message: MemoryMaintenanceMessage): Promise<void> {
  if (message.version !== 1 || !/^user\/[A-Za-z0-9._:-]{1,120}$/u.test(message.scopeId)) throw new Error('Invalid memory maintenance message')
  if (env.GIDEON_MEMORY_BACKGROUND_ENABLED !== '1') throw new Error('Memory maintenance is disabled')
  const { store, close } = storeFor(env)
  try {
    const row = await store.runTransaction(tx => tx.query<{ policy_epoch: string }>(`SELECT e.policy_epoch FROM gideon_memory.policy_epochs e JOIN gideon_memory.authority_cutovers a ON a.scope_id=e.scope_id WHERE e.scope_id=$1 AND a.state='active'`, [message.scopeId]))
    if (!row.rows[0]) return
    const session = createServerMemorySession({ owner: message.scopeId, store, channel: 'worker_http', authority: 'worker_internal_owner', policyEpoch: Number(row.rows[0].policy_epoch) })
    const report = await runMemoryMaintenance(store, {
      workerId: `worker/${crypto.randomUUID()}`, scopeId: message.scopeId as ScopeId,
      extractor: extractor(env), includeKnownMemories: true,
      learning: env.GIDEON_MEMORY_LEARNING_ENABLED === '1',
      learningEnabledFor: owner => memoryLearningEnabled({ NODE_ENV: 'production', GIDEON_MEMORY_STAGE15_CUTOVER: env.GIDEON_MEMORY_STAGE15_CUTOVER, GIDEON_MEMORY_ROLLOUT_PERCENT: env.GIDEON_MEMORY_ROLLOUT_PERCENT, GIDEON_MEMORY_LEARNING_ENABLED: env.GIDEON_MEMORY_LEARNING_ENABLED }, owner),
      limits: { learningJobs: 2, learningJobsPerScope: 2, projectionJobs: 8, promotions: 8, purgeTasks: 50 },
    })
    const provider = embeddingProviderFromEnv(env)
    if (provider) await indexPendingMemories(session, provider)
    if (env.GIDEON_MEMORY_REFINER_REMOTE_ALLOWED === '1' && env.OPENROUTER_API_KEY) {
      // Reserve from the same per-owner daily budget before remote work. A
      // failure still spends the reservation, so retries cannot burn credit.
      const reserved=await store.forSession(session).runTransaction(async tx=>{
        await tx.assertAuthorizedContext(session,'inspect')
        const claimed=await tx.query(`UPDATE gideon_memory.maintenance_dispatch d SET refined_at=now() WHERE d.scope_id=$1 AND (d.refined_at IS NULL OR d.refined_at<now()-interval '1 day') AND (SELECT count(*) FROM gideon_memory.turn_traces t WHERE t.scope_id=d.scope_id)>=8 RETURNING scope_id`,[message.scopeId])
        if(!claimed.rows.length)return false
        await tx.query(`INSERT INTO gideon_memory.learning_budgets(scope_id,window_start) VALUES($1,current_date) ON CONFLICT DO NOTHING`,[message.scopeId])
        const budget=await tx.query(`UPDATE gideon_memory.learning_budgets SET cost_micros=cost_micros+10000 WHERE scope_id=$1 AND window_start=current_date AND cost_micros<=40000 RETURNING scope_id`,[message.scopeId])
        return budget.rows.length>0
      })
      if(reserved)await runOfflineRefinement(session,createRefinementModel(env,0.01),8).catch(()=>console.warn(JSON.stringify({event:'memory_refinement_deferred'})))
    }
    await store.runTransaction(tx => tx.query(`UPDATE gideon_memory.maintenance_dispatch SET completed_at=now(),lease_until='epoch',last_failure=NULL WHERE scope_id=$1`, [message.scopeId]))
    console.log(JSON.stringify({ event: 'memory_maintenance', purge: report.purge, learning: report.learning, projections: report.projections.scopesRebuilt }))
  } finally { await close() }
}
