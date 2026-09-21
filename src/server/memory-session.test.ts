import { describe, expect, it } from 'vitest'
import { EphemeralMemoryStore } from '../lib/tools/memory'
import { parseSessionDescriptor } from '../lib/memory'
import { createServerMemorySession } from './memory-session'

describe('server-bound memory sessions', () => {
  it('derives account scope and grants from the authenticated owner', () => {
    const session = createServerMemorySession({
      owner: 'user/account-1',
      store: new EphemeralMemoryStore(),
      channel: 'worker_http',
      authority: 'worker_auth_session',
    })

    expect(session.trust).toBe('authenticated')
    expect(session.scope).toEqual({ id: 'user/account-1', kind: 'account', parentId: null })
    expect(session.subject).toEqual({ kind: 'known', subjectId: 'user/account-1' })
    expect(session.grants[0]).toMatchObject({ scopeId: 'user/account-1', issuedBy: 'server_policy' })
    expect(Object.isFrozen(session)).toBe(true)
  })

  it('keeps an unverified request isolated and explicitly ephemeral', () => {
    const session = createServerMemorySession({
      owner: 'ephemeral/connection-1',
      store: new EphemeralMemoryStore(),
      channel: 'websocket',
      authority: 'ephemeral_request',
    })

    expect(session.trust).toBe('ephemeral')
    expect(session.authority).toBe('ephemeral_request')
    expect(session.scope.id).toBe('ephemeral/connection-1')
  })

  it('serializes only the descriptor, never a storage handle', () => {
    const session = createServerMemorySession({
      owner: 'user/account-1',
      store: new EphemeralMemoryStore(),
      channel: 'http',
      authority: 'node_signed_cookie',
    })
    const { store: _store, ...descriptor } = session
    const parsed = parseSessionDescriptor(JSON.parse(JSON.stringify(descriptor)))
    expect(parsed.ok).toBe(true)
    expect(JSON.stringify(descriptor)).not.toContain('EphemeralMemoryStore')
  })

  it('rejects malformed owners instead of constructing a cross-scope session', () => {
    expect(() => createServerMemorySession({
      owner: 'user/../other',
      store: new EphemeralMemoryStore(),
      channel: 'http',
      authority: 'worker_auth_session',
    })).toThrow('Invalid memory owner')
  })
})
