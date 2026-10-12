import { Pool } from 'pg'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { createServerMemorySession } from '../../../src/server/memory-session.ts'
import { createRuntime,createRecallInput } from '../../../src/server/memory-turn-runtime.ts'
import { PostgresMemoryStore } from './postgres.ts'
import { applyMigrations } from './migrations.ts'
import { executeExplicitCommand } from './commands.ts'
import { executeForgetCommand,getDeletionStatus } from './deletion.ts'
import { runMemoryMaintenance } from './background.ts'
import { RULE_EXTRACTOR } from '../../../src/lib/memory/rule-extractor.ts'
import { retrieveMemory } from './retrieval.ts'
import { recordMemoryTurn } from './turn-traces.ts'
import { MEMORY_TOKENIZER } from './providers.ts'
import { updateMemorySettings } from './controls.ts'
import { rebuildWarmSnapshot } from './projections.ts'
import { readWarmSnapshot } from './projections.ts'
import { runOfflineRefinement,verifyOverlay,type RefinementModel } from './refiner.ts'
import { attachVerifiedOverlays } from './turn-traces.ts'
import { dispatchMemoryMaintenance,maintainMemoryScope,type MemoryMaintenanceMessage } from '../../worker/src/memory-maintenance.ts'
import type { Env } from '../../worker/src/types.ts'
import type { JudgedTrace } from '../../../src/lib/memory/refinement.ts'
import { indexPendingMemories } from './index-pending.ts'
import type { RetrievalEmbeddingProvider } from './retrieval.ts'
import type { MemoryExtractor } from '../../../src/lib/memory/learning.ts'
const enabled=process.env.GIDEON_MEMORY_POSTGRES_TEST==='1' && Boolean(process.env.MEMORY_TEST_DATABASE_URL)

describe.skipIf(!enabled)('Plan B on disposable PostgreSQL',()=>{
  const pool=new Pool({connectionString:process.env.MEMORY_TEST_DATABASE_URL,max:3})
  const store=new PostgresMemoryStore(pool)
  const session=createServerMemorySession({owner:'user/plan-b-live',store,channel:'test',authority:'worker_auth_session'})
  beforeAll(async()=>{if(process.env.MEMORY_TEST_DATABASE_OWNED!=='1')throw new Error('Use an owned disposable database');await pool.query('DROP SCHEMA IF EXISTS gideon_memory CASCADE');await applyMigrations(pool);await store.provisionTrustedContext(session)})
  afterAll(()=>store.close())
  it('consolidates accepted facts and clears traces, gaps, overlays on forget before physical purge',async()=>{
    const runtime=createRuntime(session,{capture:true,recall:true,commandWrites:true})
    expect(await runtime.captureUserTurn!({turnId:'trace-one',conversationId:'conversation/test',principalId:session.principal.id,scopeId:session.scope.id,policyEpoch:1,latestUserText:'What is my favorite drink?',transcriptHash:'a'.repeat(64)},new AbortController().signal)).toMatchObject({status:'captured'})
    const saved=await executeExplicitCommand(session,{schemaVersion:1,commandId:'command/remember-plan-b',kind:'remember',text:'I prefer quiet rooms',assertionKind:'fact',conditions:[]})
    expect(saved.ok).toBe(true);if(!saved.ok)throw new Error('remember failed')
    const projection=await rebuildWarmSnapshot(session)
    expect(projection.status).toBe('published')
    if(projection.status==='published')expect(projection.snapshot.stableProfile.some(p=>p.kind==='fact')).toBe(true)
    const recalled=await retrieveMemory(session,createRecallInput('quiet rooms','UTC',null,'','deep'),{compact:true,tokenizer:MEMORY_TOKENIZER})
    if(!recalled.ok)throw new Error(recalled.failure.message)
    await recordMemoryTurn(session,{turnId:'trace-one',question:'What is my favorite drink?',reply:'I do not remember your preferred drink.',pack:recalled.pack})
    expect((await pool.query('SELECT * FROM gideon_memory.turn_traces')).rowCount).toBe(1)
    expect((await pool.query('SELECT * FROM gideon_memory.knowledge_gaps')).rowCount).toBe(1)
    await pool.query(`INSERT INTO gideon_memory.skill_overlays(overlay_id,scope_id,topic,instructions,source_turn_ids,policy_epoch,deletion_epoch,state,evidence) VALUES('overlay/test',$1,'general','["Use supported context"]','["trace-one"]',1,0,'candidate','[]')`,[session.scope.id])
    const forgotten=await executeForgetCommand(session,{schemaVersion:1,commandId:'command/forget-plan-b',kind:'forget',targetAssertionId:saved.assertion.id,targetRevision:saved.assertion.revision,query:null})
    expect(forgotten.ok).toBe(true)
    for(const table of ['turn_traces','knowledge_gaps','skill_overlays'])expect((await pool.query(`SELECT count(*) AS n FROM gideon_memory.${table}`)).rows[0].n).toBe('0')
    for(let i=0;i<4;i++)await runMemoryMaintenance(store,{workerId:'worker/test',extractor:RULE_EXTRACTOR,learning:false,learningEnabledFor:()=>false,limits:{purgeTasks:100}})
    if(forgotten.ok)expect(await getDeletionStatus(session,forgotten.receipt.deletionId)).toMatchObject({ok:true,receipt:{physical:{status:'complete'}}})
  })
  it('temporary conversations cannot produce traces or learning',async()=>{
    expect(await updateMemorySettings(session,{expectedRevision:0,temporary:{on:true}})).toMatchObject({ok:true})
    const runtime=createRuntime(session,{capture:true,recall:true,commandWrites:true})
    expect(await runtime.captureUserTurn!({turnId:'temporary',conversationId:'conversation/temp',principalId:session.principal.id,scopeId:session.scope.id,policyEpoch:1,latestUserText:'I work at a secret company',transcriptHash:'b'.repeat(64)},new AbortController().signal)).toMatchObject({status:'unavailable',reason:'temporary_mode'})
    expect((await pool.query(`SELECT event_id FROM gideon_memory.events WHERE envelope->'payload'->>'text'='I work at a secret company'`)).rowCount).toBe(0)
  })
  it('runs the refinement lifecycle and clears promoted advice when a source is forgotten',async()=>{
    const owner=createServerMemorySession({owner:'user/plan-b-refinement',store,channel:'test',authority:'worker_auth_session'})
    await store.provisionTrustedContext(owner)
    const saved=await executeExplicitCommand(owner,{schemaVersion:1,commandId:'command/refinement-fact',kind:'remember',text:'I prefer quiet rooms.',assertionKind:'fact',conditions:[]})
    if(!saved.ok)throw new Error('setup failed')
    const runtime=createRuntime(owner,{capture:true,recall:true,commandWrites:true})
    const recalled=await retrieveMemory(owner,createRecallInput('quiet rooms','UTC',null,'','deep'),{compact:true,tokenizer:MEMORY_TOKENIZER})
    if(!recalled.ok)throw new Error('recall failed')
    for(const id of ['refine-a','refine-b']){
      const question=`Which room should I use for ${id}?`
      await runtime.captureUserTurn!({turnId:id,conversationId:'conversation/refinement',principalId:owner.principal.id,scopeId:owner.scope.id,policyEpoch:1,latestUserText:question,transcriptHash:'c'.repeat(64)},new AbortController().signal)
      await recordMemoryTurn(owner,{turnId:id,question,reply:'I cannot recall your preference.',pack:recalled.pack})
    }
    const model:RefinementModel={json:async(instructions,data)=>{
      if(instructions.startsWith('Label'))return {label:'failure',summary:'The answer ignored the supplied preference when answering the question',evidence:'I prefer quiet rooms.'}
      if(instructions.startsWith('Check'))return {supported:true}
      const group=data as JudgedTrace[]
      return {topic:'general',instructions:['When a preference is supplied, use that preference while keeping its stated conditions.'],sourceTurnIds:group.map(t=>t.turnId),evidence:group.map(t=>({turnId:t.turnId,quote:'I prefer quiet rooms.'}))}
    }}
    expect(await runOfflineRefinement(owner,model)).toMatchObject({examined:2,clusters:1,candidates:1})
    const candidate=(await pool.query<{overlay_id:string}>('SELECT overlay_id FROM gideon_memory.skill_overlays WHERE scope_id=$1',[owner.scope.id])).rows[0]
    expect((await attachVerifiedOverlays(owner,recalled.pack)).guidance).toBeUndefined()
    let calls=0
    const cases=Array.from({length:5},(_,i)=>({id:`heldout-${i}`,question:`variant-${i}: Which room fits?`,context:i===4?'No preference is given for this activity.':'The supplied preference is a quiet room.',expected:[i===4?'not on record':'quiet room'],forbidden:['invented detail'],negative:i===4}))
    const result=await verifyOverlay(owner,candidate.overlay_id,cases,{answer:async(question,_context,overlay)=>{calls++;return question.includes('variant-4')?'not on record':!overlay.length&&question.includes('variant-0')?'busy room':'quiet room'}})
    expect(result.promoted).toBe(true);expect(calls).toBe(10)
    expect((await attachVerifiedOverlays(owner,recalled.pack)).guidance).toContain('keeping its stated conditions')
    await executeForgetCommand(owner,{schemaVersion:1,commandId:'command/refinement-forget',kind:'forget',targetAssertionId:saved.assertion.id,targetRevision:saved.assertion.revision,query:null})
    expect((await pool.query('SELECT overlay_id FROM gideon_memory.skill_overlays WHERE scope_id=$1',[owner.scope.id])).rowCount).toBe(0)
  })
  it('renews a cached profile only while its inputs and authority remain unchanged',async()=>{
    const owner=createServerMemorySession({owner:'user/plan-b-lease',store,channel:'test',authority:'worker_auth_session'})
    await store.provisionTrustedContext(owner)
    await executeExplicitCommand(owner,{schemaVersion:1,commandId:'command/lease-fact',kind:'remember',text:'I work remotely.',assertionKind:'fact',conditions:[]})
    await rebuildWarmSnapshot(owner)
    await pool.query(`UPDATE gideon_memory.managed_cache_entries SET expires_at=now()-interval '1 second' WHERE scope_id=$1`,[owner.scope.id])
    expect(await readWarmSnapshot(owner)).toMatchObject({status:'expired'})
    expect(await readWarmSnapshot(owner,{renew:true})).toMatchObject({status:'available'})
    await executeExplicitCommand(owner,{schemaVersion:1,commandId:'command/lease-new',kind:'remember',text:'I prefer short replies.',assertionKind:'preference',conditions:[]})
    await pool.query(`UPDATE gideon_memory.managed_cache_entries SET expires_at=now()-interval '1 second' WHERE scope_id=$1`,[owner.scope.id])
    expect(await readWarmSnapshot(owner,{renew:true})).toMatchObject({status:'invalidated',reason:'snapshot_inputs_changed'})
  })
  it('dispatches scoped work through the queue and executes its maintenance consumer',async()=>{
    const owner=createServerMemorySession({owner:'user/plan-b-queue',store,channel:'test',authority:'worker_auth_session'})
    await store.provisionTrustedContext(owner)
    await pool.query(`INSERT INTO gideon_memory.authority_cutovers(scope_id,state) VALUES($1,'active')`,[owner.scope.id])
    await executeExplicitCommand(owner,{schemaVersion:1,commandId:'command/queue-fact',kind:'remember',text:'I prefer tea.',assertionKind:'preference',conditions:[]})
    const messages:MemoryMaintenanceMessage[]=[]
    const env={GIDEON_SESSION:{} as Env['GIDEON_SESSION'],HYPERDRIVE:{connectionString:process.env.MEMORY_TEST_DATABASE_URL!} as Hyperdrive,GIDEON_MEMORY_BACKGROUND_ENABLED:'1',MEMORY_MAINTENANCE:{sendBatch:async(batch:Iterable<MessageSendRequest<MemoryMaintenanceMessage>>)=>{messages.push(...[...batch].map(m=>m.body));return {}}} as Env['MEMORY_MAINTENANCE']}
    await dispatchMemoryMaintenance(env)
    expect(messages).toEqual([{scopeId:owner.scope.id,version:1}])
    await maintainMemoryScope(env,messages[0])
    expect((await pool.query('SELECT completed_at FROM gideon_memory.maintenance_dispatch WHERE scope_id=$1',[owner.scope.id])).rows[0].completed_at).toBeTruthy()
  })
  it('does not let excluded text starve backfill and retries failed provider work', async () => {
    const owner=createServerMemorySession({owner:'user/plan-b-index-retry',store,channel:'test',authority:'worker_auth_session'})
    await store.provisionTrustedContext(owner)
    for (let i=0;i<17;i++) {
      const saved=await executeExplicitCommand(owner,{schemaVersion:1,commandId:`command/index-exclude-${i}`,kind:'remember',text:`I prefer reading in room ${i}.`,assertionKind:'fact',conditions:[]})
      if(!saved.ok)throw new Error('setup failed')
      // Corrupt synthetic storage fixture only; the normal command path screens secrets.
      await pool.query(`UPDATE gideon_memory.assertion_versions SET version=jsonb_set(version,'{payload,proposition,text}',to_jsonb($3::text)) WHERE assertion_id=$1 AND revision=$2`,[saved.assertion.id,saved.assertion.revision,'My password is synthetic-placeholder'])
    }
    await executeExplicitCommand(owner,{schemaVersion:1,commandId:'command/index-valid',kind:'remember',text:'I enjoy quiet gardens.',assertionKind:'fact',conditions:[]})
    let fail=true
    const embedded:string[]=[]
    const provider:RetrievalEmbeddingProvider={modelId:'local/test',modelVersion:'v1',dimensions:2,placement:'local',embed:async texts=>{
      if(fail)throw new Error('Transient synthetic failure')
      embedded.push(...texts);return texts.map(()=>[1,0])
    }}
    expect(await indexPendingMemories(owner,provider)).toBe(0)
    await expect(indexPendingMemories(owner,provider)).rejects.toThrow('unavailable')
    fail=false
    expect(await indexPendingMemories(owner,provider)).toBeGreaterThan(0)
    expect(embedded.every(text=>!text.includes('synthetic-placeholder'))).toBe(true)
    expect((await pool.query('SELECT count(*) AS n FROM gideon_memory.embedding_exclusions WHERE scope_id=$1',[owner.scope.id])).rows[0].n).toBe('17')
  })
  it('does not persist a wrong model corroboration edge against a different preference',async()=>{
    const owner=createServerMemorySession({owner:'user/plan-b-wrong-target',store,channel:'test',authority:'worker_auth_session'})
    await store.provisionTrustedContext(owner)
    const tea=await executeExplicitCommand(owner,{schemaVersion:1,commandId:'command/wrong-target-tea',kind:'remember',text:'I like tea.',assertionKind:'preference',conditions:[]})
    if(!tea.ok)throw new Error('setup failed')
    const runtime=createRuntime(owner,{capture:true,recall:true,commandWrites:true})
    await runtime.captureUserTurn!({turnId:'wrong-target-coffee',conversationId:'conversation/wrong-target',principalId:owner.principal.id,scopeId:owner.scope.id,policyEpoch:1,latestUserText:'I like coffee',transcriptHash:'d'.repeat(64)},new AbortController().signal)
    const extractor:MemoryExtractor={id:'test/wrong-target',version:'1',promptVersion:'1',schemaVersion:1,model:null,placement:'local',extract:async()=>({output:{candidates:[{kind:'preference',text:'User said: I like coffee',speechAct:'self_statement',polarity:'positive',scope:'general',conditions:[],relation:'ordinary',validTime:{from:null,until:null,precision:'unknown',sourceTimeZone:null},evidence:{start:0,end:13,quote:'I like coffee'},operation:'corroborate',targetAssertionId:tea.assertion.id}]},usage:{inputUnits:0,outputUnits:0,costMicros:0}})}
    const report=await runMemoryMaintenance(store,{workerId:'test/wrong-target',scopeId:owner.scope.id,extractor,learning:true,learningEnabledFor:()=>true,includeKnownMemories:true,settleMs:0})
    expect(report.learning.learned).toBe(1)
    expect(report.learning.corroborated).toBe(0)
    const support=await pool.query<{text:string}>(`SELECT e.envelope #>> '{payload,text}' AS text FROM gideon_memory.evidence_edges edge JOIN gideon_memory.events e ON e.event_id=edge.event_id AND e.scope_id=edge.scope_id WHERE edge.scope_id=$1 AND edge.assertion_id=$2 AND edge.relation='supports'`,[owner.scope.id,tea.assertion.id])
    expect(support.rows.every(row=>row.text!=='I like coffee')).toBe(true)
    const memories=await pool.query<{n:string}>(`SELECT count(*) AS n FROM gideon_memory.assertions WHERE scope_id=$1 AND current_status='accepted'`,[owner.scope.id])
    expect(memories.rows[0].n).toBe('2')
  })
})
