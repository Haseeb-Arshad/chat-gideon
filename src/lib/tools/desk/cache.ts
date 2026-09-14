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

  clear() {
    this.entries.clear()
  }
}
