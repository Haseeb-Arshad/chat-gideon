import { containsSecretLikeMaterial, sensitiveCategories } from './screening.ts'

export interface RefinementTrace { turnId: string; topic: string; question: string; reply: string; context: string }
export interface JudgedTrace extends RefinementTrace { label: 'success' | 'failure' | 'gap'; summary: string; evidence: string }
export interface SkillProposal { topic: string; instructions: string[]; sourceTurnIds: string[]; evidence: { turnId: string; quote: string }[] }
export interface OverlayVerification { cases: { id: string; baselinePass: boolean; overlayPass: boolean; negative: boolean }[]; independent: boolean }

export function replyMemoryChecks(question: string, reply: string) {
  const normalized = reply.replace(/[’‘]/gu, "'")
  const gap = /(?:\b(?:don't|do not|can't|cannot) (?:remember|recall|find|know)|not (?:on record|in (?:my|the) memory)|haven't (?:shared|told)|not enough (?:context|information)|memory (?:is |was )?unavailable)/iu.test(normalized)
  const uncertainty = /\b(?:possibly|might|uncertain|conflicting|not sure)\b/iu.test(normalized)
  const dependsOnMemory = /\b(?:my|remember|earlier|last time|previous|what did i|where do i)\b/iu.test(question)
  const confirmation = uncertainty && dependsOnMemory
  return { gap, confirmation, nonempty: Boolean(reply.trim()), containsSecret: containsSecretLikeMaterial(reply) }
}

/** Complete-link lexical clusters; opposite outcomes never share a cluster. */
export function clusterTraces(traces: readonly JudgedTrace[], vectors?: readonly (readonly number[])[]): JudgedTrace[][] {
  const tokens = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
  const similar = (a: JudgedTrace, b: JudgedTrace) => {
    const av=vectors?.[traces.indexOf(a)], bv=vectors?.[traces.indexOf(b)]
    if(av && bv && av.length===bv.length) { let dot=0, aa=0, bb=0; av.forEach((v,i)=>{dot+=v*bv[i];aa+=v*v;bb+=bv[i]*bv[i]}); return dot/Math.sqrt(aa*bb)>=0.72 }
    const x = tokens(a.summary), y = tokens(b.summary); let n=0; for (const t of x) if (y.has(t)) n++; return n / Math.max(1, x.size+y.size-n) >= 0.3
  }
  const clusters: JudgedTrace[][] = []
  for (const trace of traces) {
    if (trace.label === 'gap') continue // missing facts belong in the inbox
    const group = clusters.find(c => c.every(t => t.topic === trace.topic && t.label === trace.label && similar(t, trace)))
    if (group) group.push(trace); else clusters.push([trace])
  }
  return clusters.filter(group => group.length >= 2)
}

/** Evidence supports an instruction, never a new personal fact or authority. */
export function validateSkillProposal(proposal: SkillProposal, cluster: readonly JudgedTrace[]): boolean {
  if (cluster.length < 2 || !proposal.instructions.length || proposal.instructions.length > 4 || proposal.topic !== cluster[0].topic) return false
  const texts = proposal.instructions.join('\n')
  const allowedCapitals=new Set(['When','If','For','Use','Keep','Preserve','Check','State','Ask','Answer','Avoid','Treat','Explain','Quote','Do','Never','Only','Prefer','The','This','That','Otherwise','English','Urdu','Roman'])
  if((texts.match(/\b[A-Z][a-z]{2,}\b/gu)??[]).some(word=>!allowedCapitals.has(word)))return false
  if(/\b(?:he|she|the user) (?:lives|works|earns|owns|likes|prefers|studies)\b|\b(?:always|must) (?:say|reply with|answer with)\b/iu.test(texts))return false
  if (texts.length > 1600 || containsSecretLikeMaterial(texts) || sensitiveCategories(texts).length) return false
  if (/(?:ignore|override|bypass|disable).{0,45}(?:rule|system|safety|approval|consent|privacy)|\b(?:identity|grant|authorize|credentials|retention|deletion|extractor|shell|execute|sudo|powershell|curl|api key)\b|https?:\/\/|\b\d+(?:\.\d+)?\b|@/iu.test(texts)) return false
  if (!proposal.instructions.every(s => typeof s === 'string' && s.trim().length >= 12 && s.length <= 500)) return false
  if (new Set(proposal.sourceTurnIds).size < 2 || proposal.sourceTurnIds.some(id => !cluster.some(t => t.turnId === id))) return false
  const supported = new Set<string>()
  for (const edge of proposal.evidence) {
    const t = cluster.find(t => t.turnId === edge.turnId)
    if (!t || !edge.quote || edge.quote.length < 8 || !`${t.question}\n${t.context}\n${t.reply}`.includes(edge.quote)) return false
    supported.add(t.turnId)
  }
  return supported.size >= 2 && proposal.sourceTurnIds.every(id => supported.has(id))
}

export function verificationPasses(result: OverlayVerification): boolean {
  const rows = result.cases
  return result.independent && rows.length >= 5 && new Set(rows.map(r => r.id)).size === rows.length
    && rows.some(r => r.negative) && rows.every(r => !r.baselinePass || r.overlayPass)
    && rows.some(r => !r.baselinePass && r.overlayPass) && rows.filter(r => r.negative).every(r => r.overlayPass)
}
