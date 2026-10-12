import {spawn} from 'node:child_process';
import {createWriteStream,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const directory=resolve(root,'output/memory-no-credit');
mkdirSync(directory,{recursive:true});
const attempts=resolve(directory,'blocked-network.jsonl');
writeFileSync(attempts,'');
const guard=resolve(directory,'network-guard.cjs');
writeFileSync(guard,`
const net=require('node:net');
const fs=require('node:fs');
const {syncBuiltinESMExports}=require('node:module');
const local=h=>['localhost','127.0.0.1','::1','[::1]'].includes(String(h).toLowerCase());
function refuse(kind){
  fs.appendFileSync(process.env.MEMORY_OFFLINE_NETWORK_LOG,JSON.stringify({kind,pid:process.pid})+'\\n');
  throw new Error('No-credit test run blocked an external network request');
}
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  let first=args[0];if(Array.isArray(first))first=first[0];
  if(typeof first==='object' && first!==null){
    if(!first.path && !local(first.host??first.hostname??'localhost'))refuse('socket');
  }else if(typeof first==='number' || /^\\d+$/.test(String(first))){
    if(typeof args[1]==='string' && !local(args[1]))refuse('socket');
  } // Named pipes are local and used by Node's test workers.
  return connect.apply(this,args);
};
const originalFetch=globalThis.fetch;
globalThis.fetch=async function(input,...rest){
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(!local(url.hostname))refuse('fetch');
  return originalFetch.call(this,input,...rest);
};
syncBuiltinESMExports();
`);
const env={...process.env};
for(const name of Object.keys(env)){
  if(/(?:KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|CONNECTIONSTRING)$/i.test(name))delete env[name];
  if(name.endsWith('_LIVE')||name.endsWith('_REMOTE_ALLOWED'))env[name]='0';
}
Object.assign(env,{NODE_OPTIONS:`--require="${guard.replaceAll('\\','/')}"`,MEMORY_OFFLINE_NETWORK_LOG:attempts,
  MEMORY_CONVERSATION_EVAL_LIVE:'0',MEMORY_PLANB_PROVIDER_SMOKE:'0',MEMORY_PLANB_LIVE:'0',MEMORY_PUBLIC_EVAL_LIVE:'0',
  GIDEON_MEMORY_BACKGROUND_ENABLED:'0',GIDEON_MEMORY_EMBEDDINGS_REMOTE_ALLOWED:'0',GIDEON_MEMORY_EXTRACTOR_REMOTE_ALLOWED:'0',
  GIDEON_MEMORY_REFINER_REMOTE_ALLOWED:'0',WRANGLER_SEND_METRICS:'false',DO_NOT_TRACK:'1'});
const vitest='node_modules/vitest/vitest.mjs';
const probeLog=resolve(directory,'guard-selftest.jsonl');
writeFileSync(probeLog,'');
const tasks=[
  {name:'network-guard-selftest',args:['--input-type=module','-e',`import net from 'node:net';let probes=0;try{await fetch('https://no-credit-guard.invalid')}catch(e){if(!e.message.includes('No-credit test run blocked'))throw e;probes++}try{net.connect({host:'no-credit-guard.invalid',port:443})}catch(e){if(!e.message.includes('No-credit test run blocked'))throw e;probes++}if(probes!==2)throw Error('Network guard self-test failed');console.log('Fetch and direct socket probes were blocked before connecting.');`],env:{MEMORY_OFFLINE_NETWORK_LOG:probeLog}},
  {name:'unit-runtime-ui',args:[vitest,'run','src/lib/memory','backend/memory/src/plan-b.test.ts','backend/memory/src/model-extractor.test.ts','backend/memory/src/classifiers.test.ts','backend/memory/src/store-brand.test.ts','src/server/node-memory-integration.test.ts','src/server/memory-session.test.ts','backend/worker/src/memory.test.ts','src/components/MemoryInspector.test.tsx','src/lib/agent-core.test.ts','src/lib/openrouter-memory-integration.test.ts','src/lib/tools/memory-tools.test.ts','src/lib/tools/memory.test.ts','scripts/memory-eval-lib.test.ts','--maxWorkers=2']},
  {name:'disposable-database',args:['scripts/memory-postgres-harness.mjs','backend/memory/src/postgres.live.test.ts','backend/memory/src/seed-conformance.live.test.ts','backend/memory/src/plan-b.live.test.ts','backend/memory/src/plan-b-privacy.live.test.ts','backend/memory/src/cutover.live.test.ts','backend/memory/src/operational.live.test.ts']},
  {name:'offline-320-replay',args:['scripts/memory-postgres-harness.mjs','scripts/memory-conversation-eval.live.test.ts'],env:{MEMORY_PLAN_B_EVAL:'1',MEMORY_CONVERSATION_EVAL_SPLIT:'heldout',MEMORY_PLAN_B_OUTPUT_DIR:'output/memory-no-credit/replay'}},
  {name:'cloudflare-build',args:['node_modules/vite/bin/vite.js','build','--mode','cloudflare']},
  {name:'typescript',args:['node_modules/typescript/bin/tsc','--noEmit']},
  {name:'bundle-boundaries',args:['scripts/check-worker-bundle.mjs']},
];
const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7).split(',');
if(only?.some(name=>!tasks.some(task=>task.name===name)))throw new Error('Unknown check name');
const resultPath=resolve(directory,'results.json');
const results=only && existsSync(resultPath)?JSON.parse(readFileSync(resultPath,'utf8')).results:[];
for(const task of tasks.filter(task=>!only||task.name==='network-guard-selftest'||only.includes(task.name))){
  console.log(`Starting ${task.name}; external network blocked`);
  const started=Date.now();
  const logPath=resolve(directory,`${task.name}.log`);
  const log=createWriteStream(logPath);
  const code=await new Promise((done,reject)=>{
    const child=spawn(process.execPath,task.args,{cwd:root,env:{...env,...task.env},windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
    child.once('error',reject);child.once('close',done);
  });
  await new Promise(done=>log.end(done));
  const previous=results.findIndex(result=>result.name===task.name);
  const count=readFileSync(logPath,'utf8').match(/Tests\s+(\d+) passed/);
  const result={name:task.name,exitCode:code,durationMs:Date.now()-started,testedAt:new Date().toISOString(),passedTests:count?Number(count[1]):null,log:logPath};
  if(previous<0)results.push(result);else results[previous]=result;
  console.log(`Completed ${task.name}: exit ${code}`);
  writeFileSync(resolve(directory,'results.json'),JSON.stringify({label:'No-credit local checks; provider behavior tested with mocks, no new live model quality score',results},null,2));
}
const blocked=readFileSync(attempts,'utf8').trim().split('\n').filter(Boolean).length;
const replayPath=resolve(directory,'replay/heldout.json');
const replay=existsSync(replayPath)?JSON.parse(readFileSync(replayPath,'utf8')):null;
const report={label:'No-credit local verification',externalNetworkBlocked:true,blockedExternalAttempts:blocked,
  newProviderCalls:replay?.spend?.liveCalls??0,providerSpendUsd:replay?.spend?.usd??0,
  replay:replay?{complete:replay.complete,questions:replay.counts.queries,answersAvailable:replay.answersAvailable,explicitFailures:replay.construction.explicitFailures.length}:null,
  results,limitations:['Fresh model and multilingual embedding quality require a provider or previously cached vectors/responses','Production Supabase, queue service and latency are not verified by these disposable local tests']};
writeFileSync(resolve(directory,'results.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
process.exitCode=results.some(r=>r.exitCode!==0)||blocked>0||report.newProviderCalls>0||report.providerSpendUsd>0?1:0;
