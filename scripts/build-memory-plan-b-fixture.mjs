import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// A frozen internal challenge set, explicitly separate from public benchmarks.
// Unique owners, values, histories and queries; no repetition of the dev corpus.
const trajectories=[];
const colors=['amber','indigo','olive','maroon','teal','coral','silver','violet'];
for(let i=0;i<40;i++){
  const town=`Harbor ${i}`,old=`Studio ${i}`,current=`Workshop ${i}`,color=colors[i%colors.length];
  const sessions=[
    {at:'2026-08-01T08:00:00Z',turns:[{remember:{text:`I live in ${town}.`,kind:'fact'}},{remember:{text:`I work at ${old}.`,kind:'fact'}},{remember:{text:`I prefer ${color} notebooks for project ${i}.`,kind:'preference'}},{remember:{text:`For project ${i}, every document must stay offline.`,kind:'constraint',conditions:[{key:'topic',operator:'equals',value:`project ${i}`}]}},{say:`My friend works at Company ${i}; that is not my employer.`}]},
    {at:'2026-09-01T08:00:00Z',turns:[{correct:{target:`I work at ${old}.`,text:`I work at ${current}.`,change:'changed',since:'2026-09-01'}},{remember:{text:`My old route code is route-${i}.`,kind:'fact'}}]},
    {at:'2026-09-03T08:00:00Z',turns:[{forget:`My old route code is route-${i}.`}]},
  ];
  const q=(id,text,evidence,required,forbidden=[],category='recall',at='2026-09-04T10:00:00Z',topic)=>({id:`b-${i}-${id}`,at,text,evidence,category,...(topic?{topic}:{}),rubric:{mustInclude:required.map(v=>[v]),mustNotInclude:forbidden}});
  const queries=[
    q('residence','Which place do I call home?', [`I live in ${town}.`],[town],[],'paraphrase'),
    q('urdu','میں کہاں رہتا ہوں؟',[`I live in ${town}.`],[town],[],'multilingual'),
    q('roman','Main kis jagah rehta hoon?',[`I live in ${town}.`],[town],[],'multilingual'),
    q('current','Where do I work now?',[`I work at ${current}.`],[current],[old,`Company ${i}`],'temporal'),
    q('past','Where was I working then?',[`I work at ${old}.`],[old],[current],'temporal','2026-08-15T10:00:00Z'),
    q('preference',`What notebook would suit project ${i}?`,[`I prefer ${color} notebooks for project ${i}.`],[color],[],'preference_application'),
    q('constraint','Could we use a hosted document service?', [`For project ${i}, every document must stay offline.`],['offline'],[], 'constraint_adherence','2026-09-04T10:00:00Z',`project ${i}`),
    {...q('forgotten','What is my old route code?',[],[],[`route-${i}`],'deletion'),rubric:{mustInclude:[],mustNotInclude:[`route-${i}`],expectAbstain:true}},
  ];
  trajectories.push({id:`plan-b-owner-${i}`,language:'English / Urdu / Roman Urdu',sessions,queries});
}
const output={label:'Internal synthetic held-out challenge set; not a public benchmark result',version:1,trajectories};
const json=JSON.stringify(output,null,2)+'\n';
mkdirSync('scripts/fixtures',{recursive:true});
writeFileSync('scripts/fixtures/memory-plan-b-heldout.json',json);
console.log(JSON.stringify({trajectories:40,queries:320,sha256:createHash('sha256').update(json).digest('hex')}));
