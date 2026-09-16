import type { Memory, MemoryStore } from '../lib/tools/memory'

/** Shared by HTTP CAS clients and direct socket mutations. Epoch rejects stale RPCs after restart. */
export class VersionedMemoryAuthority implements MemoryStore {
  private queue: Promise<unknown> = Promise.resolve()
  private version = crypto.randomUUID()
  constructor(private readonly storage: MemoryStore) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.catch(() => undefined)
    return run
  }
  all() { return this.serial(async () => structuredClone(await this.storage.all())) }
  save(_memories: Memory[]): Promise<void> { return Promise.reject(new Error('Use a versioned mutation')) }
  mutate<T>(change: (memories: Memory[]) => { memories: Memory[]; result: T }): Promise<T> {
    return this.serial(async () => {
      const { memories, result } = change(structuredClone(await this.storage.all()))
      try { await this.storage.save(memories) }
      finally { this.version = crypto.randomUUID() }
      return result
    })
  }
  snapshot() {
    return this.serial(async () => ({ memories: structuredClone(await this.storage.all()), version: this.version }))
  }
  commit(expected: string, memories: Memory[]) {
    return this.serial(async () => {
      if (expected !== this.version) return false
      try { await this.storage.save(structuredClone(memories)) }
      finally { this.version = crypto.randomUUID() }
      return true
    })
  }
}
