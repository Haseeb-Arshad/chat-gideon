import type { MemoryStore } from '../lib/tools/memory'
import {
  type ClientChannel,
  type ClientContext,
  type Grant,
  type MemorySession,
  type Principal,
  type Scope,
  type SessionAuthority,
  type SubjectId,
  type ClaimSubject,
  type PrincipalId,
  type ScopeId,
} from '../lib/memory'

/**
 * Server-only session binder.
 *
 * Callers provide only an owner already established by a server authentication
 * adapter and a store selected by that same adapter. Scope, subject, principal,
 * and grants are derived here; none can arrive from a browser body or model
 * argument. Worker code may use this small module because it has no Node
 * imports. The Node-specific cookie resolver lives in node-memory-session.ts.
 */
export interface ServerMemorySessionInput {
  owner: string
  store: MemoryStore
  channel: ClientChannel
  authority: SessionAuthority
  clientId?: string
  connectionRevision?: string | null
  policyEpoch?: number
}

const DURABLE_ACTIONS = ['capture', 'read', 'remember', 'correct', 'forget', 'recall', 'inspect', 'export'] as const

function ownerId(owner: string, label: string): string {
  if (!/^(?:user|node|ephemeral)\/[A-Za-z0-9._:-]{1,120}$/.test(owner)) throw new Error(`Invalid ${label}`)
  return owner
}

function clientId(owner: string, supplied: string | undefined, channel: ClientChannel): string {
  const value = supplied?.trim() || `${channel}/${owner}`
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) throw new Error('Invalid client id')
  return value
}

function grantsFor(scopeId: ScopeId): readonly Grant[] {
  return [{
    id: `grant/${scopeId}` as Grant['id'],
    scopeId,
    actions: DURABLE_ACTIONS,
    issuedBy: 'server_policy',
    expiresAt: null,
  }]
}

/**
 * Bind an already authenticated owner to the memory tools.
 *
 * This is intentionally the only constructor used by HTTP, Worker, and
 * realtime adapters. It does not accept a scope or grant list as input.
 */
export function createServerMemorySession(input: ServerMemorySessionInput): MemorySession<MemoryStore> {
  const owner = ownerId(input.owner, 'memory owner')
  const ephemeral = input.authority === 'ephemeral_request'
  const trust = ephemeral ? 'ephemeral' : 'authenticated'
  const principalId = owner as PrincipalId
  const subjectId = owner as SubjectId
  const scopeId = owner as ScopeId
  const principal: Principal = { id: principalId, kind: 'anonymous', trust }
  const client: ClientContext = {
    id: clientId(owner, input.clientId, input.channel) as ClientContext['id'],
    channel: input.channel,
    connectionRevision: input.connectionRevision ?? null,
  }
  const subject: ClaimSubject = { kind: 'known', subjectId }
  const scope: Scope = { id: scopeId, kind: 'account', parentId: null }
  const policyEpoch = input.policyEpoch ?? 1
  if (!Number.isSafeInteger(policyEpoch) || policyEpoch < 0) throw new Error('Invalid memory policy epoch')

  return Object.freeze({
    schemaVersion: 1 as const,
    trust,
    authority: input.authority,
    principal,
    client,
    subject,
    scope,
    grants: grantsFor(scopeId),
    policyEpoch,
    store: input.store,
  })
}
