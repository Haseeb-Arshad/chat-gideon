/**
 * Frames that are ready to send, and a way to wait for the next one.
 *
 * A turn's text streams in order, but what it puts on screen does not: a card
 * is drawn beside the reply, patched as its slower parts arrive, and the stage
 * judgement lands whenever its model answers. Those pieces are pushed here as
 * they become ready and sent at the next frame the loop yields anyway. Once the
 * text has all gone out, the loop waits here instead, sending each piece the
 * moment it arrives rather than holding them all until the slowest is done.
 */
export class Outbox<T> {
  private items: T[] = []
  private open = 0
  private wake: (() => void) | null = null

  push(item: T) {
    this.items.push(item)
    this.notify()
  }

  /** Counts work that may push more, until it settles, whether it succeeds or not. */
  track(work: Promise<unknown>) {
    this.open += 1
    void work
      .catch(() => undefined)
      .finally(() => {
        this.open -= 1
        this.notify()
      })
  }

  /** Some tracked work has not settled yet. */
  get busy(): boolean {
    return this.open > 0
  }

  *drain(): Generator<T> {
    while (this.items.length) yield this.items.shift() as T
  }

  /**
   * Resolves as soon as something is ready to send, when the last tracked work
   * settles, or after `ms`, whichever is first. Only one waiter is expected:
   * the loop that sends the frames.
   */
  next(ms: number): Promise<void> {
    if (this.items.length || !this.open) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        if (this.wake === done) this.wake = null
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, ms))
      this.wake = done
    })
  }

  private notify() {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}
