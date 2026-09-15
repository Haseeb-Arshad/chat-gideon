import { describe, expect, it } from 'vitest'
import { attachRealtime } from './realtime-host'

/**
 * The realtime socket on a Node server. What is pinned: attaching twice to the
 * same server, as a development server restarting itself does, listens once.
 * Two listeners would each claim every upgrade, and a socket claimed twice fails.
 */

describe('attaching the realtime socket', () => {
  it('listens once per server, however often it is attached', () => {
    const listeners: string[] = []
    const server = { on: (event: 'upgrade') => void listeners.push(event) }
    attachRealtime(server)
    attachRealtime(server, { rejectOther: true })
    expect(listeners).toEqual(['upgrade'])
    attachRealtime({ on: (event: 'upgrade') => void listeners.push(event) })
    expect(listeners).toEqual(['upgrade', 'upgrade'])
  })
})
