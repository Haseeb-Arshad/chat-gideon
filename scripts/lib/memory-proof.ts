export interface PlanBProof {
  heldoutQuestions:number
  completeAnswers:number
  pairedGain:number
  pairedLowerBound:number
  multilingualRecallGain:number
  falseMemoryRate:number|null
  rulesFalseMemoryRate:number|null
  compactCapacityRatio:number
  seedCasesPassed:number
  purgeP95Seconds:number|null
  staleCleanupOverDay:number|null
  overlayRegressions:number|null
  productionP95Ms:number|null
  publicBenchmarks:{name:string;scoredQuestions:number;complete:boolean;protocol:string}[]
}
export function planBProofGates(p:PlanBProof){
  const gates={
    heldout:p.heldoutQuestions>=300 && p.completeAnswers===p.heldoutQuestions,
    baseline:p.pairedGain>=0.05 && p.pairedLowerBound>0,
    multilingual:p.multilingualRecallGain>=0.15,
    learning:p.falseMemoryRate!==null && p.rulesFalseMemoryRate!==null && Number.isFinite(p.falseMemoryRate) && Number.isFinite(p.rulesFalseMemoryRate) && p.falseMemoryRate>=0 && p.falseMemoryRate<=p.rulesFalseMemoryRate,
    compact:p.compactCapacityRatio>=2,
    safety:p.seedCasesPassed>=36,
    operations:p.purgeP95Seconds!==null && Number.isFinite(p.purgeP95Seconds) && p.purgeP95Seconds>=0 && p.purgeP95Seconds<600 && p.staleCleanupOverDay===0,
    refinement:p.overlayRegressions===0,
    latency:p.productionP95Ms!==null && Number.isFinite(p.productionP95Ms) && p.productionP95Ms>0,
    publicBenchmarks:['LongMemEval','LoCoMo-Plus','PersonaMem'].every(n=>p.publicBenchmarks.some(b=>b.name===n&&b.scoredQuestions>0&&b.complete&&b.protocol.length>0)),
  }
  return {gates,claimable95:Object.values(gates).every(Boolean)}
}
