import {pairedBootstrap} from './memory-eval.ts'
export interface PublicMemoryCase {dataset:string;track:string;id:string;group:string;history:{role:string;content:string;at:string|null}[];question:string;answer:string|null;evidenceContext?:string;options?:string[];task:string;cutoff?:string}
export interface PublicMemorySystem {answer(sample:Omit<PublicMemoryCase,'answer'|'evidenceContext'>):Promise<string>}
export interface PublicMemoryJudge {score(data:{question:string;answer:string|null;context:string;reply:string;task:string}):Promise<number>}

/** The answer/evidence labels are kept out of the systems; only the blinded judge sees them. */
export async function evaluatePublicMemory(cases:readonly PublicMemoryCase[],baseline:PublicMemorySystem,full:PublicMemorySystem,judge:PublicMemoryJudge){
  if(new Set(cases.map(c=>`${c.dataset}/${c.id}`)).size!==cases.length)throw new Error('Duplicate benchmark ids')
  const rows:{dataset:string;track:string;group:string;id:string;baseline:number;full:number}[]=[]
  for(const sample of cases){
    const {answer,evidenceContext,...visible}=sample
    if(sample.cutoff && visible.history.some(h=>h.at && h.at>sample.cutoff!))throw new Error('Future history leaked into a query')
    const a=await baseline.answer(visible),b=await full.answer(visible)
    const common={question:sample.question,answer,context:evidenceContext??sample.history.map(h=>`${h.role}: ${h.content}`).join('\n'),task:sample.task}
    // Stable reversal makes answer-position labels uninformative to the judge.
    const flip=rows.length%2===1
    const first=await judge.score({...common,reply:flip?b:a}),second=await judge.score({...common,reply:flip?a:b})
    if(![first,second].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw new Error('Invalid benchmark judge score')
    rows.push({dataset:sample.dataset,track:sample.track,group:sample.group,id:sample.id,baseline:flip?second:first,full:flip?first:second})
  }
  const groups=new Map<string,typeof rows>()
  for(const row of rows){const key=`${row.dataset}/${row.group}`;groups.set(key,[...(groups.get(key)??[]),row])}
  return {questions:rows.length,rows,paired:pairedBootstrap([...groups.values()].map(g=>({a:g.map(r=>r.baseline),b:g.map(r=>r.full)})))}
}
