import { Client } from 'pg'
import type { InteractionAudit, InteractionAuditFactory } from '../../../src/lib/interaction-audit'
import type { Env } from './types'

const MAX_AUDIT_EVENTS_PER_TURN = 500
const MAX_STORED_AUDIO_BYTES = 32 * 1024 * 1024

interface AuditFactoryOptions {
  env: Env
  owner: string
  sessionKey: string | null
  channel: 'http' | 'websocket'
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function withClient<T>(connectionString: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString })
  client.on('error', () => undefined)
  let transaction = false
  try {
    await client.connect()
    await client.query('BEGIN')
    transaction = true
    const result = await work(client)
    await client.query('COMMIT')
    transaction = false
    return result
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end().catch(() => undefined)
  }
}

class WorkerInteractionAudit implements InteractionAudit {
  readonly turnId = crypto.randomUUID()
  private sequence = 0
  private pending: { sequence: number; type: string; payload: Record<string, unknown> }[] = []
  private finished = false
  private flushing: Promise<void> | null = null

  constructor(
    readonly conversationId: string,
    private readonly owner: string,
    private readonly connectionString: string,
  ) {}

  record(type: string, payload: Record<string, unknown>) {
    if (this.finished) return
    if (this.pending.length >= MAX_AUDIT_EVENTS_PER_TURN) throw new Error('Audit event limit exceeded')
    this.pending.push({ sequence: ++this.sequence, type: type.slice(0, 80), payload: structuredClone(payload) })
  }

  async saveAudio(input: { source: 'user' | 'assistant'; mime: string; audio: ArrayBuffer | Uint8Array; text?: string; metadata?: Record<string, unknown> }): Promise<string> {
    const bytes = input.audio instanceof Uint8Array ? input.audio : new Uint8Array(input.audio)
    if (!bytes.byteLength || bytes.byteLength > MAX_STORED_AUDIO_BYTES) throw new Error('Audio asset exceeds the storage limit')
    const digest = await sha256(bytes)
    const assetId = crypto.randomUUID()
    await withClient(this.connectionString, async (client) => {
      await client.query(
        `INSERT INTO public.gideon_voice_assets
          (id, conversation_id, owner_id, turn_id, source, mime_type, byte_length, sha256, transcript, audio, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [assetId, this.conversationId, this.owner, this.turnId, input.source, input.mime.slice(0, 120), bytes.byteLength,
          digest, input.text ?? null, bytes, JSON.stringify(input.metadata ?? {})],
      )
    })
    this.record('voice_asset_saved', {
      assetId,
      source: input.source,
      mime: input.mime.slice(0, 120),
      byteLength: bytes.byteLength,
      sha256: digest,
      text: input.text ?? null,
      metadata: input.metadata ?? {},
    })
    return assetId
  }

  async updateTranscript(assetId: string, text: string, model: string) {
    await withClient(this.connectionString, async (client) => {
      const result = await client.query(
        `UPDATE public.gideon_voice_assets SET transcript = $1, transcription_model = $2
         WHERE id = $3 AND conversation_id = $4 AND owner_id = $5`,
        [text, model.slice(0, 160), assetId, this.conversationId, this.owner],
      )
      if (result.rowCount !== 1) throw new Error('Voice asset could not be updated for this owner')
    })
    this.record('transcription_completed', { assetId, text, model: model.slice(0, 160) })
  }

  async finish(status: 'completed' | 'failed' | 'cancelled') {
    if (this.finished) return
    this.record('turn_finished', { status })
    await this.flush()
    await withClient(this.connectionString, async (client) => {
      await client.query('UPDATE public.gideon_conversations SET updated_at = now() WHERE id = $1 AND owner_id = $2', [this.conversationId, this.owner])
    })
    this.finished = true
  }

  /** Commit initial request evidence before contacting a model. */
  async flush() {
    if (this.flushing) return this.flushing
    const work = (async () => {
      while (this.pending.length) {
        const batch = this.pending.slice()
        await withClient(this.connectionString, async (client) => {
          for (const item of batch) {
            await client.query(
              `INSERT INTO public.gideon_interaction_events
                (conversation_id, owner_id, turn_id, sequence, event_type, payload)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
              [this.conversationId, this.owner, this.turnId, item.sequence, item.type, JSON.stringify(item.payload)],
            )
          }
        })
        this.pending.splice(0, batch.length)
      }
    })()
    this.flushing = work
    try {
      await work
    } finally {
      this.flushing = null
    }
  }
}

/** Private Hyperdrive writer. The browser session value is hashed and is never an owner key. */
export function createWorkerInteractionAudit(options: AuditFactoryOptions): InteractionAuditFactory | null {
  if (options.env.GIDEON_AUDIT_ENABLED !== '1') {
    if (options.env.GIDEON_AUDIT_REQUIRED === '1') throw new Error('Required conversation audit is disabled')
    return null
  }
  const connectionString = options.env.HYPERDRIVE?.connectionString
  if (!connectionString) {
    if (options.env.GIDEON_AUDIT_REQUIRED === '1') throw new Error('Conversation audit storage is unavailable')
    return null
  }

  const sessionValue = (options.sessionKey || crypto.randomUUID()).slice(0, 256)
  const clientSessionHash = sha256(`${options.owner}\0${sessionValue}`)
  let conversationPromise: Promise<string> | null = null
  const conversationId = () => conversationPromise ??= clientSessionHash.then((sessionHash) => withClient(connectionString, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO public.gideon_conversations (owner_id, client_session_hash, channel)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, client_session_hash) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [options.owner, sessionHash, options.channel],
    )
    if (!result.rows[0]?.id) throw new Error('Conversation audit record was not created')
    return result.rows[0].id
  }))

  return {
    async startTurn(input) {
      const id = await conversationId()
      const audit = new WorkerInteractionAudit(id, options.owner, connectionString)
      audit.record('turn_started', {
        channel: options.channel,
        clientTurnIdHash: await sha256(input.clientTurnId.slice(0, 256)),
      })
      audit.record('submitted_messages', { messages: input.messages })
      await audit.flush()
      return audit
    },
    async recordVoice(input) {
      const id = await conversationId()
      const audit = new WorkerInteractionAudit(id, options.owner, connectionString)
      const source = input.source ?? 'user'
      audit.record(source === 'user' ? 'voice_upload_received' : 'assistant_voice_generation', {
        channel: options.channel,
        clientTurnIdHash: await sha256(input.clientTurnId.slice(0, 256)),
        text: input.text ?? null,
        metadata: input.metadata ?? {},
      })
      await audit.flush()
      const assetId = await audit.saveAudio({ source, mime: input.mime, audio: input.audio, text: input.text, metadata: input.metadata })
      await audit.finish('completed')
      return assetId
    },
    async updateVoiceTranscript(assetId, text, model) {
      const id = await conversationId()
      const audit = new WorkerInteractionAudit(id, options.owner, connectionString)
      await audit.updateTranscript(assetId, text, model)
      await audit.finish('completed')
    },
    async recordEvent(input) {
      const id = await conversationId()
      const audit = new WorkerInteractionAudit(id, options.owner, connectionString)
      audit.record(input.type, { ...input.payload, clientTurnIdHash: await sha256(input.clientTurnId.slice(0, 256)) })
      await audit.finish('completed')
    },
  }
}
