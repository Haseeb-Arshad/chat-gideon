import { parseAssertionVersion, type MemorySession, type ExactVersionRef } from '../../../src/lib/memory/contracts.ts'
import { containsSecretLikeMaterial } from '../../../src/lib/memory/screening.ts'
import { createRecallInput } from '../../../src/server/memory-turn-runtime.ts'
import { createRetrievalRequest } from '../../../src/lib/memory/retrieval.ts'
import { embeddableAssertionText, indexAuthorizedEmbeddings, MAX_EMBEDDING_DOCUMENT_CHARS, type RetrievalEmbeddingProvider } from './retrieval.ts'
import type { PostgresMemoryStore } from './postgres.ts'
import { readMemoryMode } from './controls.ts'

export async function indexPendingMemories(session:MemorySession<PostgresMemoryStore>,provider:RetrievalEmbeddingProvider):Promise<number>{
  if((await readMemoryMode(session))?.temporary)return 0
  const rows=await session.store.forSession(session).runTransaction(async tx=>{
    await tx.assertAuthorizedContext(session,'recall')
    return tx.query<{assertion_id:string;current_revision:string;version:unknown}>(`SELECT a.assertion_id,a.current_revision,v.version FROM gideon_memory.assertions a
      JOIN gideon_memory.assertion_versions v ON v.scope_id=a.scope_id AND v.assertion_id=a.assertion_id AND v.revision=a.current_revision
      WHERE a.scope_id=$1 AND a.current_status='accepted' AND NOT EXISTS (SELECT 1 FROM gideon_memory.retrieval_embeddings e WHERE e.scope_id=a.scope_id AND e.assertion_id=a.assertion_id AND e.assertion_revision=a.current_revision AND e.model_id=$2 AND e.model_version=$3)
      AND NOT EXISTS(SELECT 1 FROM gideon_memory.embedding_exclusions e WHERE e.scope_id=a.scope_id AND e.assertion_id=a.assertion_id AND e.assertion_revision=a.current_revision AND e.model_id=$2 AND e.model_version=$3)
      ORDER BY a.updated_at,a.assertion_id LIMIT 16`,[session.scope.id,provider.modelId,provider.modelVersion])
  })
  if(!rows.rows.length)return 0
  const refs:ExactVersionRef[]=[]
  for (const row of rows.rows) {
    const parsed = parseAssertionVersion(row.version)
    if (!parsed.ok) continue
    const text = embeddableAssertionText(parsed.value).text
    const reason = containsSecretLikeMaterial(text) ? 'secret' : text.length > MAX_EMBEDDING_DOCUMENT_CHARS ? 'oversized' : null
    if (reason) {
      await session.store.forSession(session).runTransaction(async tx => {
        await tx.assertAuthorizedContext(session, 'recall')
        await tx.query(`INSERT INTO gideon_memory.embedding_exclusions(scope_id,assertion_id,assertion_revision,model_id,model_version,reason)
          SELECT scope_id,assertion_id,current_revision,$4,$5,$6 FROM gideon_memory.assertions WHERE scope_id=$1 AND assertion_id=$2 AND current_revision=$3 AND current_status='accepted'
          ON CONFLICT DO NOTHING`, [session.scope.id,row.assertion_id,Number(row.current_revision),provider.modelId,provider.modelVersion,reason])
      })
    } else refs.push({assertionId:row.assertion_id as ExactVersionRef['assertionId'],revision:Number(row.current_revision)})
  }
  if (!refs.length) return 0
  const input=createRecallInput('background indexing','UTC',null,'','deep')
  input.deadlineAt=new Date(Date.now()+15000).toISOString()
  const parsed=createRetrievalRequest(session,input)
  if(!parsed.ok)throw new Error('Invalid indexing request')
  const result=await indexAuthorizedEmbeddings(session,refs,provider,{request:parsed.request,authorizeRemoteEmbedding:()=>true,signal:AbortSignal.timeout(15000)})
  if(result.status!=='indexed')throw new Error(`Memory indexing ${result.status}`)
  return result.indexed
}
