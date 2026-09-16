/**
 * A small time-limited cache for the desk's data sources.
 *
 * The figures behind a chart change once a year and a person's record almost
 * never, while the same question is asked twice in a row whenever a guessed
 * turn is followed by the real one. So an answer is kept for a while, and a
 * lookup that is still running is shared rather than repeated. A failure is
 * not kept: the next ask should try again.
 */
export class TimedCache<T> {
  private readonly entries = new Map<string, { at: number; value: Promise<T> }>()

  constructor(
    private readonly ttlMs: number,
    private readonly limit = 64,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<T>, keep: (value: T) => boolean = () => true): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value
    if (hit) this.entries.delete(key)

    const value = load()
    this.entries.set(key, { at: this.now(), value })
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value as string)
    value.then(
      (result) => {
        if (!keep(result) && this.entries.get(key)?.value === value) this.entries.delete(key)
      },
      () => {
        if (this.entries.get(key)?.value === value) this.entries.delete(key)
      },
    )
    return value
  }

  /** Shared work owns its deadline; each caller only cancels its own wait. */
  getShared(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    timeoutMs: number,
    keep: (value: T) => boolean = () => true,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason)
    const value = this.get(key, () => load(AbortSignal.timeout(timeoutMs)), keep)
    return new Promise<T>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      value.then(
        (result) => { signal.removeEventListener('abort', abort); resolve(result) },
        (error) => { signal.removeEventListener('abort', abort); reject(error) },
      )
      if (signal.aborted) abort()
    })
  }

  clear() {
    this.entries.clear()
  }
}
