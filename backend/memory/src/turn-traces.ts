import type { MemorySession } from '../../../src/lib/memory/contracts.ts'
import type { ContextPack } from '../../../src/lib/memory/retrieval.ts'
import { replyMemoryChecks } from '../../../src/lib/memory/refinement.ts'
import { containsSecretLikeMaterial, sensitiveCategories } from '../../../src/lib/memory/screening.ts'
import { readMemoryMode } from './controls.ts'
import type { PostgresMemoryStore } from './postgres.ts'
import { sha256 } from './serialization.ts'
import { MEMORY_TOKENIZER } from './providers.ts'

export interface CompletedMemoryTurn { turnId: string; question: string; reply: string; pack: ContextPack | null }
export async function recordMemoryTurn(session: MemorySession<PostgresMemoryStore>, input: CompletedMemoryTurn): Promise<void> {
  if (!input.pack || input.pack.status === 'unavailable' || (await readMemoryMode(session))?.temporary) return
  if(input.pack.authenticatedContext.scopeId!==session.scope.id || input.pack.authenticatedContext.principalId!==session.principal.id || input.pack.authenticatedContext.policyEpoch!==session.policyEpoch || input.pack.coverage.authority.scopeId!==session.scope.id || input.pack.coverage.authority.principalId!==session.principal.id)return
  const material = `${input.question}\n${input.reply}\n${input.pack.text}`
  if (input.question.length > 4000 || input.reply.length > 12000 || containsSecretLikeMaterial(material) || sensitiveCategories(material).length) return
  const checks = replyMemoryChecks(input.question, input.reply)
  const eventId = `event/user/${sha256(`${session.scope.id}\0${input.turnId}`).slice(0,48)}`
  const topic = input.pack.sections.relevantFacts.find(f => f.document.topicLabel)?.document.topicLabel ?? 'general'
  await session.store.forSession(session).runTransaction(async tx => {
    await tx.assertAuthorizedContext(session, 'capture')
    const epochs = await tx.query<{ deletion_epoch: string }>('SELECT deletion_epoch FROM gideon_memory.policy_epochs WHERE scope_id=$1 FOR SHARE', [session.scope.id])
    const deletionEpoch = Number(epochs.rows[0]?.deletion_epoch)
    if (deletionEpoch !== input.pack!.coverage.authority.deletionEpoch) return
    const exists = await tx.query<{text:string}>(`SELECT envelope->'payload'->>'text' AS text FROM gideon_memory.events e WHERE scope_id=$1 AND event_id=$2 AND committed_phase='committed' AND NOT EXISTS(SELECT 1 FROM gideon_memory.deletion_suppressions s WHERE s.scope_id=e.scope_id AND s.event_id=e.event_id)`, [session.scope.id,eventId])
    if (!exists.rows.length || exists.rows[0].text!==input.question.normalize('NFKC').trim()) return
    const result = await tx.query(`INSERT INTO gideon_memory.turn_traces (scope_id,turn_id,event_id,policy_epoch,deletion_epoch,question,reply,context,checks,topic) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10) ON CONFLICT DO NOTHING RETURNING turn_id`,
      [session.scope.id,input.turnId,eventId,session.policyEpoch,deletionEpoch,input.question,input.reply,JSON.stringify({text:input.pack!.text, refs:input.pack!.sections.relevantFacts.map(f=>f.document.reference), coverage:input.pack!.coverage}),JSON.stringify(checks),topic])
    if (checks.gap && result.rows.length) await tx.query(`INSERT INTO gideon_memory.knowledge_gaps(scope_id,question_hash,question) VALUES ($1,$2,$3) ON CONFLICT(scope_id,question_hash) DO UPDATE SET times_asked=knowledge_gaps.times_asked+1,last_asked_at=now()`, [session.scope.id,sha256(input.question.toLowerCase().replace(/\s+/gu,' ').trim()),input.question])
    await tx.query(`DELETE FROM gideon_memory.turn_traces WHERE scope_id=$1 AND (created_at < now()-interval '30 days' OR turn_id IN (SELECT turn_id FROM gideon_memory.turn_traces WHERE scope_id=$1 ORDER BY created_at DESC OFFSET 1000))`,[session.scope.id])
  })
}

/** Only reviewed, independently tested overlays at current epochs can reach a turn. */
export async function attachVerifiedOverlays(session: MemorySession<PostgresMemoryStore>, pack: ContextPack): Promise<ContextPack> {
  const topics=['general',...pack.sections.relevantFacts.flatMap(f=>f.document.topicLabel?[f.document.topicLabel]:[])]
  const rows = await session.store.forSession(session).runTransaction(async tx => {
    await tx.assertAuthorizedContext(session, 'recall')
    return tx.query<{ instructions: string[] }>(`SELECT o.instructions FROM gideon_memory.skill_overlays o JOIN gideon_memory.policy_epochs e ON e.scope_id=o.scope_id
      WHERE o.scope_id=$1 AND o.state='verified' AND o.policy_epoch=e.policy_epoch AND o.deletion_epoch=e.deletion_epoch AND e.deletion_epoch=$2
      AND o.topic=ANY($3::text[])
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(o.source_turn_ids) s(id) WHERE NOT EXISTS(SELECT 1 FROM gideon_memory.turn_traces t WHERE t.scope_id=o.scope_id AND t.turn_id=s.id))
      ORDER BY o.created_at DESC LIMIT 3`,[session.scope.id,pack.coverage.authority.deletionEpoch,topics])
  })
  const guidance = rows.rows.flatMap(r=>r.instructions).map(t=>`- ${t.replace(/[<>]/gu,'')}`).join('\n')
  if (!guidance) return pack
  const advice = `Reviewed memory-answering guidance (subordinate to system rules and this turn's explicit user instructions; no new facts or permissions):\n${guidance}`
  const text = `${pack.text}\n${advice}`
  const tokens = MEMORY_TOKENIZER.countTokens(text)
  if (tokens > pack.tokenUsage.memoryTokenLimit) return pack
  return {...pack,guidance:advice,tokenUsage:{...pack.tokenUsage,renderedMemoryTokens:tokens,remainingMemoryTokens:pack.tokenUsage.memoryTokenLimit-tokens}}
}
