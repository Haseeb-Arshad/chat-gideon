/** Server-selected audit sink for one model turn. The Worker owns persistence. */
export interface InteractionAudit {
  readonly conversationId: string
  readonly turnId: string
  record(type: string, payload: Record<string, unknown>): void
  flush(): Promise<void>
  saveAudio(input: {
    source: 'user' | 'assistant'
    mime: string
    audio: ArrayBuffer | Uint8Array
    text?: string
    metadata?: Record<string, unknown>
  }): Promise<string>
  finish(status: 'completed' | 'failed' | 'cancelled'): Promise<void>
}

export interface InteractionAuditFactory {
  startTurn(input: {
    clientTurnId: string
    messages: readonly { role: string; content: string }[]
  }): Promise<InteractionAudit | null>
  recordVoice(input: {
    clientTurnId: string
    audio: ArrayBuffer | Uint8Array
    mime: string
    source?: 'user' | 'assistant'
    text?: string
    metadata?: Record<string, unknown>
  }): Promise<string>
  updateVoiceTranscript(assetId: string, text: string, model: string): Promise<void>
  recordEvent(input: { clientTurnId: string; type: string; payload: Record<string, unknown> }): Promise<void>
}
