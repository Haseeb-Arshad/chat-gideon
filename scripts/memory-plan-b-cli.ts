import {Pool} from 'pg'
import {readFileSync} from 'node:fs'
import {PostgresMemoryStore} from '../backend/memory/src/postgres.ts'
import {createServerMemorySession} from '../src/server/memory-session.ts'
import {runOfflineRefinement,verifyOverlay,type HeldOutOverlayCase} from '../backend/memory/src/refiner.ts'
import {createRefinementModel} from '../backend/memory/src/refinement-provider.ts'
import {indexPendingMemories} from '../backend/memory/src/index-pending.ts'
import {embeddingProviderFromEnv} from '../backend/memory/src/providers.ts'
import {runMemoryMaintenance} from '../backend/memory/src/background.ts'
import {RULE_EXTRACTOR} from '../src/lib/memory/rule-extractor.ts'

const args=process.argv.slice(2)
const command=args[0]
if(!command||command==='help'){
  console.log('memory:plan-b status|maintain|index|refine|overlays|gaps|verify|retire --owner=user/id [--id=overlay/id] [--cases=file.json] [--cap=0.03]. Remote model commands require MEMORY_PLANB_LIVE=1. This trusted operator CLI never changes ownership or grants.')
}else{
  const option=(name:string)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)
  const owner=option('owner')
  if(!owner || !/^(user|node)\/[A-Za-z0-9._:-]{1,120}$/u.test(owner))throw new Error('Choose an existing authenticated owner')
  const url=process.env.GIDEON_MEMORY_DATABASE_URL||process.env.GIDEON_DATABASE_URL
  if(!url)throw new Error('Set the direct memory/database URL in your environment')
  const pool=new Pool({connectionString:url,max:2,connectionTimeoutMillis:5000})
  const store=new PostgresMemoryStore(pool)
  try{
    const epoch=await pool.query<{policy_epoch:string}>('SELECT policy_epoch FROM gideon_memory.policy_epochs WHERE scope_id=$1',[owner])
    if(!epoch.rows[0])throw new Error('This owner has no canonical memory scope')
    const session=createServerMemorySession({owner,store,channel:'test',authority:'worker_internal_owner',policyEpoch:Number(epoch.rows[0].policy_epoch)})
    const inspect=async(sql:string,params:unknown[]=[])=>store.forSession(session).runTransaction(async tx=>{await tx.assertAuthorizedContext(session,'inspect');return tx.query(sql,[owner,...params])})
    if(command==='status')console.log(JSON.stringify((await inspect(`SELECT (SELECT count(*) FROM gideon_memory.assertions WHERE scope_id=$1 AND current_status='accepted') AS accepted,(SELECT count(*) FROM gideon_memory.turn_traces WHERE scope_id=$1) AS traces,(SELECT count(*) FROM gideon_memory.skill_overlays WHERE scope_id=$1 AND state='verified') AS verified_rules,(SELECT count(*) FROM gideon_memory.purge_tasks WHERE scope_id=$1 AND status<>'completed') AS pending_purge`)).rows[0],null,2))
    else if(command==='gaps')console.log(JSON.stringify((await inspect('SELECT question_hash,question,times_asked FROM gideon_memory.knowledge_gaps WHERE scope_id=$1 ORDER BY last_asked_at DESC LIMIT 50')).rows,null,2))
    else if(command==='overlays')console.log(JSON.stringify((await inspect('SELECT overlay_id,state,topic,instructions,verification FROM gideon_memory.skill_overlays WHERE scope_id=$1 ORDER BY created_at DESC LIMIT 50')).rows,null,2))
    else if(command==='maintain')console.log(JSON.stringify(await runMemoryMaintenance(store,{workerId:'operator/plan-b',scopeId:session.scope.id,extractor:RULE_EXTRACTOR,learning:false,learningEnabledFor:()=>false}),null,2))
    else if(command==='retire')console.log(JSON.stringify((await store.forSession(session).runTransaction(async tx=>{await tx.assertAuthorizedContext(session,'remember');return tx.query(`UPDATE gideon_memory.skill_overlays SET state='retired' WHERE scope_id=$1 AND overlay_id=$2 RETURNING overlay_id`,[owner,option('id')])})).rows))
    else if(['refine','verify','index'].includes(command)){
      if(process.env.MEMORY_PLANB_LIVE!=='1')throw new Error('Set MEMORY_PLANB_LIVE=1 for paid remote calls')
      if(command==='index'){const provider=embeddingProviderFromEnv(process.env);if(!provider)throw new Error('Enable the embedding provider');console.log(JSON.stringify({indexed:await indexPendingMemories(session,provider)}))}
      else{
        const model=createRefinementModel(process.env,Number(option('cap')||0.03))
        const result=command==='refine'?await runOfflineRefinement(session,model):await verifyOverlay(session,option('id')||'',JSON.parse(readFileSync(option('cases')||'','utf8')) as HeldOutOverlayCase[],model)
        console.log(JSON.stringify({result,costUsd:model.spent()},null,2))
      }
    }else throw new Error('Unknown Plan B command')
  }finally{await store.close()}
}
