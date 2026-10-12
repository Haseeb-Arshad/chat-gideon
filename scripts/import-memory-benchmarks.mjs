import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const directory=resolve(process.argv[2]||'output/memory-plan-b-datasets');
const hash=s=>createHash('sha256').update(s).digest('hex');
const read=name=>readFileSync(resolve(directory,name),'utf8');
const parseDate=s=>{const d=new Date(String(s).replace(/\([^)]*\)/g,''));if(!Number.isFinite(d.getTime()))throw new Error('Invalid benchmark timestamp');return d.toISOString()};
const longRaw=read('longmemeval-oracle.json'),loRaw=read('locomo-plus.json'),personaRaw=read('personamem-questions.csv'),contextRaw=read('personamem-contexts.jsonl');
function csv(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++}else quoted=!quoted}else if(c===','&&!quoted){row.push(cell);cell=''}else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell=''}else cell+=c}if(cell||row.length){row.push(cell);rows.push(row)}const header=rows.shift();return rows.filter(r=>r.length===header.length).map(r=>Object.fromEntries(header.map((k,i)=>[k,r[i]])))}
function options(value){try{return JSON.parse(value)}catch{return [...value.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/gs)].map(m=>(m[1]??m[2]).replace(/\\n/g,'\n').replace(/\\'/g,"'").replace(/\\"/g,'"'))}}
const contexts=Object.assign({},...contextRaw.trim().split(/\r?\n/).map(l=>JSON.parse(l)));
const long=JSON.parse(longRaw).slice(0,100).map(r=>{
  const cutoff=parseDate(r.question_date);
  const history=r.haystack_sessions.flatMap((turns,i)=>{const at=parseDate(r.haystack_dates[i]);if(at>cutoff)return [];return turns.map(t=>({role:t.role,content:t.content,at,sessionId:r.haystack_session_ids[i]}))});
  return {dataset:'LongMemEval',track:'oracle diagnostic; original roles preserved',id:r.question_id,group:r.question_id,cutoff,history,question:r.question,answer:String(r.answer),evidenceSessions:r.answer_session_ids,task:'open-ended'};
});
const locomo=JSON.parse(loRaw).slice(0,100).map((r,i)=>({dataset:'LoCoMo-Plus',track:'cognitive cue-only diagnostic; use the official stitched track for published scores',id:`locomo-${i}`,group:`locomo-${i}`,history:r.cue_dialogue.split('\n').filter(Boolean).map((content,j)=>({role:j%2===0?'user':'assistant',content,at:null})),question:r.trigger_query,answer:null,evidenceContext:r.cue_dialogue,task:'cognitive',timeGap:r.time_gap}));
const persona=csv(personaRaw).slice(0,100).map(r=>{
  const shared=contexts[r.shared_context_id];
  if(!Array.isArray(shared))throw new Error('Missing PersonaMem shared context');
  const history=shared.slice(0,Number(r.end_index_in_shared_context)).map(t=>({role:t.role,content:t.content,at:null}));
  return {dataset:'PersonaMem',track:'original multiple-choice protocol',id:r.question_id,group:`persona-${r.persona_id}`,history,question:r.user_question_or_message,answer:r.correct_answer,options:options(r.all_options),task:'multiple-choice'};
});
const cases=[...long,...locomo,...persona];
const manifest={version:1,label:'Public source imports; no model score is claimed by import',questions:cases.length,counts:{LongMemEval:long.length,'LoCoMo-Plus':locomo.length,PersonaMem:persona.length},sourceHashes:{longmemeval:hash(longRaw),locomo:hash(loRaw),persona:hash(personaRaw),personaContexts:hash(contextRaw)},sources:['https://github.com/xiaowu0162/LongMemEval','https://github.com/xjtuleeyf/Locomo-Plus','https://github.com/bowen-upenn/PersonaMem'],caseHash:hash(JSON.stringify(cases))};
mkdirSync(directory,{recursive:true});
writeFileSync(resolve(directory,'public-cases.json'),JSON.stringify({manifest,cases},null,2));
writeFileSync(resolve(directory,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest,null,2));
