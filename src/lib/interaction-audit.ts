/**
 * Server-selected record of one conversation. The Worker owns persistence.
 *
 * Nothing here returns a promise on purpose. Recording is a note left for a
 * background writer, stamped with the clock at the moment it is made, so a
 * reply, a transcript or a spoken chunk never waits on the database. A write
 * that fails loses the record, never the answer.
 */
export interface InteractionAudit {
  readonly turnId: string
  record(type: string, payload: Record<string, unknown>): void
  /** Milliseconds from the start of the turn to a named stage; the first mark of a name wins. */
  mark(stage: string, ms?: number): void
  /** Queues audio for storage and returns the id it will be stored under. */
  saveAudio(input: AuditAudio): string
  finish(status: 'completed' | 'failed' | 'cancelled'): void
}

export interface AuditAudio {
  source: 'user' | 'assistant'
  mime: string
  audio: ArrayBuffer | Uint8Array
  text?: string
  metadata?: Record<string, unknown>
}

/** One stretch of speech on the conversation's timeline. */
export interface AuditSpeech extends AuditAudio {
  /** The browser's turn this belongs to, when it is known yet. */
  clientTurnId?: string
  /** Wall-clock bounds of the speech, in epoch milliseconds, when they are known. */
  startedAt?: number
  endedAt?: number
  /** The id the segment is stored under, when the caller has already issued one. */
  segmentId?: string
  seq?: number
  startChar?: number
  endChar?: number
}

export interface InteractionAuditFactory {
  startTurn(input: {
    clientTurnId: string
    messages: readonly { role: string; content: string }[]
    speculative?: boolean
  }): InteractionAudit | null
  /** Stores a recording with its place on the timeline; returns the segment id. */
  recordSpeech(input: AuditSpeech): string
  /** An event about a turn that may already have finished, such as a card being shown. */
  recordEvent(input: { clientTurnId: string; type: string; payload: Record<string, unknown>; at?: number }): void
  /** What the browser later learns about a turn or one of its spoken segments. */
  amendTurn(clientTurnId: string, patch: Record<string, unknown>): void
  amendSpeech(segmentId: string, patch: { startedAt?: number; endedAt?: number; interrupted?: boolean }): void
  /** Resolves once everything queued so far has been written or given up on. */
  settled(): Promise<void>
}
