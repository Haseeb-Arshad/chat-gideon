/**
 * Browser side of the realtime link.
 *
 * Prefers a persistent WebSocket: the socket is already open when you finish
 * speaking, so a turn costs one frame instead of a fresh connection, and the
 * server can hold a warm upstream connection between turns.
 *
 * Serverless hosts cannot accept socket upgrades. Rather than fail there, the
 * link detects it once and permanently falls back to a streaming HTTP POST that
 * carries the identical protocol frames — so everything above this module has a
 * single code path regardless of transport.
 */

import {
  REALTIME_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type ClientFrame,
  type ServerFrame,
} from './protocol'
import { backendHeaders, backendUrl, backendWebSocketUrl, awaitAccount, ensureAccount, onAccountReady } from './backend'
import { readPatch, type CardPatch } from './cards/patch'
import { readCard } from './cards/read'
import type { CardV2 } from './cards/schema'
import type { ScreenState, StageMove } from './stage-judge'

export type LinkTransport = 'idle' | 'connecting' | 'socket' | 'http'

export interface LinkConfig {
  configured: boolean
  chatModel: string
  voiceModel: string
  sttModel: string
  /** Tools this server can run, which depends on its keys and its transport. */
  tools: string[]
}

export interface ActionEvent {
  call: string
  name: string
  summary: string
  ok: boolean
  /** Still in progress; the frame that follows with the same `call` is the result. */
  pending: boolean
  /** What is being worked on, such as the question being researched. */
  detail: string
  links: Array<{ title: string; url: string; publishedDate?: string }>
}

export interface TurnHandlers {
  onStart?: () => void
  onDelta: (text: string) => void
  onDone: (text: string) => void
  onError: (message: string, retryable: boolean) => void
  /** GIDEON did something worth showing in the ledger. */
  onAction?: (action: ActionEvent) => void
}

export interface TurnHandle {
  id: string
  cancel: () => void
}

export interface ChatTurnMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Remembered per tab so a host without upgrades is only probed once. */
const FALLBACK_KEY = 'gideon-transport-fallback'
const OPEN_TIMEOUT_MS = 1_600
const PING_INTERVAL_MS = 20_000

/** Best-effort IANA zone, so the server can answer "what day is it". */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function rememberFallback() {
  try {
    sessionStorage.setItem(FALLBACK_KEY, '1')
  } catch {
    // A blocked storage accessor only costs us one probe per load.
  }
}

function fallbackRemembered() {
  try {
    return sessionStorage.getItem(FALLBACK_KEY) === '1'
  } catch {
    return false
  }
}

interface PendingAudio {
  resolve: (blob: Blob) => void
  reject: (error: Error) => void
  mime: string
  /** Detaches the caller's abort listener once this pending no longer needs it. */
  cleanup: () => void
}

export class RealtimeLink {
  transport: LinkTransport = 'idle'

  private socket: WebSocket | null = null
  /** A refresh waits for the current turn to drain before rebinding. */
  private refreshPending = false
  /** Gate while the account is resolved, or the wait for it gives up. */
  private accountRelease: (() => void) | null = null
  /** Detaches the late-identity listener when the link is thrown away. */
  private unsubscribeAccount: (() => void) | null = null
  private readonly socketTurns = new Set<string>()
  private readonly httpControllers = new Map<string, AbortController>()
  private openTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 600
  private disposed = false
  private readonly lifetime = new AbortController()

  private readonly turns = new Map<string, TurnHandlers>()
  /**
   * Turns that are guesses. A tool request arriving for one of these is refused
   * rather than run: the server already declines to execute tools for a
   * speculative turn, and this is the second half of that guarantee, held on
   * the side that actually owns the timers and the screen.
   */
  private readonly speculativeTurns = new Set<string>()
  private readonly audio = new Map<string, PendingAudio>()
  private pendingAudioKey: string | null = null

  private onTransportChange: ((transport: LinkTransport) => void) | null = null
  private onConfig: ((config: LinkConfig) => void) | null = null
  /**
   * Fulfils tools the server asks the browser to run. Absent on the HTTP
   * fallback, where the server has no way to ask in the first place.
   */
  private runClientTool:
    | ((name: string, args: unknown) => Promise<{ ok: boolean; content: string }>)
    | null = null
  /**
   * Cards and stage changes go to the page directly, not through the turn's
   * handlers: a card is drawn beside the reply and often arrives after `done`,
   * by which point the turn has already been let go.
   */
  private onCard: ((turnId: string, call: string, card: CardV2 | null) => void) | null = null
  private onCardPatch: ((turnId: string, call: string, patch: CardPatch) => void) | null = null
  private onStage: ((turnId: string, move: StageMove) => void) | null = null

  constructor(options: {
    onTransportChange?: (transport: LinkTransport) => void
    onConfig?: (config: LinkConfig) => void
    runClientTool?: (name: string, args: unknown) => Promise<{ ok: boolean; content: string }>
    onCard?: (turnId: string, call: string, card: CardV2 | null) => void
    onCardPatch?: (turnId: string, call: string, patch: CardPatch) => void
    onStage?: (turnId: string, move: StageMove) => void
  } = {}) {
    this.onTransportChange = options.onTransportChange ?? null
    this.onConfig = options.onConfig ?? null
    this.runClientTool = options.runClientTool ?? null
    this.onCard = options.onCard ?? null
    this.onCardPatch = options.onCardPatch ?? null
    this.onStage = options.onStage ?? null
  }

  connect() {
    if (this.disposed) return
    if (typeof window === 'undefined') return
    if (fallbackRemembered() || typeof WebSocket === 'undefined') {
      this.setTransport('http')
      void ensureAccount()
      return
    }
    if (this.socket || this.accountRelease) return

    this.setTransport('connecting')

    // The socket's memory is chosen as it opens, so the account comes first —
    // but only for a bounded moment. A server that is slow to answer still
    // gets its socket, under the browser's id, and if the account lands
    // afterwards the idle socket is replaced rather than the turn held up.
    const release = () => {
      if (this.accountRelease !== release) return
      this.accountRelease = null
      if (this.disposed) return
      this.open()
    }
    this.accountRelease = release
    void ensureAccount(2_000, this.lifetime.signal).then((state) => {
      if (this.disposed) return
      if (state === 'pending' || state === 'error') {
        this.unsubscribeAccount?.()
        this.unsubscribeAccount = onAccountReady(() => {
          this.refreshPending = true
          this.drainRefresh()
        })
      }
      release()
    }).catch(() => { this.accountRelease = null })
  }

  /**
   * Replaces the socket so its memory follows the account cookie.
   *
   * Only an idle socket is replaced — never mid-turn. With a turn on the
   * socket, or the link already fallen back to HTTP, the replacement waits
   * for the next natural reconnect instead of interrupting an answer.
   */
  private refreshSocket() {
    this.unsubscribeAccount?.()
    this.unsubscribeAccount = null
    if (this.disposed || !this.refreshPending || this.socketTurns.size || this.audio.size) return
    this.refreshPending = false
    const old = this.socket
    if (!old) return
    this.socket = null
    this.clearSocketTimers()
    try { old.close() } catch { /* Already gone. */ }
    this.setTransport('connecting')
    this.open()
  }

  /** A turn finished; a refresh held back for it can now have the socket. */
  private drainRefresh() {
    if (!this.refreshPending || this.disposed) return
    if (this.socketTurns.size === 0 && this.audio.size === 0) this.refreshSocket()
  }

  private open() {
    if (this.disposed || this.socket) return
    let socket: WebSocket
    try {
      socket = new WebSocket(backendWebSocketUrl())
    } catch {
      this.degrade()
      return
    }

    socket.binaryType = 'arraybuffer'
    this.socket = socket

    // A host that refuses upgrades often leaves the handshake hanging rather
    // than rejecting, so the probe is bounded.
    this.openTimer = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        try {
          socket.close()
        } catch {
          // Already closing.
        }
        this.degrade()
      }
    }, OPEN_TIMEOUT_MS)

    socket.onopen = () => {
      if (this.disposed || this.socket !== socket) return
      if (this.openTimer) clearTimeout(this.openTimer)
      this.openTimer = null
      this.reconnectDelay = 600
      this.send({ t: 'hello', version: REALTIME_PROTOCOL_VERSION })
      this.setTransport('socket')
      this.pingTimer = setInterval(() => this.send({ t: 'ping', at: Date.now() }), PING_INTERVAL_MS)
    }

    socket.onmessage = (event) => {
      if (this.disposed || this.socket !== socket) return
      if (typeof event.data === 'string') {
        const frame = decodeFrame<ServerFrame>(event.data)
        if (frame) this.dispatch(frame)
        return
      }
      this.resolveAudio(event.data as ArrayBuffer)
    }

    socket.onerror = () => {
      if (this.socket !== socket) return
      if (this.transport === 'connecting') this.degrade()
    }

    socket.onclose = () => {
      if (this.socket !== socket) return
      this.clearSocketTimers()
      this.socket = null
      this.abortSocketWork('The connection dropped mid-answer.')
      if (this.disposed) return
      if (this.transport === 'connecting') {
        this.degrade()
        return
      }
      if (this.transport !== 'socket') return
      // Keep the persistent link alive across dev reloads and network blips.
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8_000)
    }
  }

  dispose() {
    this.disposed = true
    this.lifetime.abort()
    this.clearSocketTimers()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.unsubscribeAccount?.()
    this.unsubscribeAccount = null
    this.accountRelease = null
    this.turns.clear()
    this.socketTurns.clear()
    this.refreshPending = false
    for (const controller of this.httpControllers.values()) controller.abort()
    this.httpControllers.clear()
    for (const pending of this.audio.values()) {
      pending.cleanup()
      pending.reject(new Error('The link closed.'))
    }
    this.audio.clear()
    try {
      this.socket?.close()
    } catch {
      // Nothing left to do on a socket that is already gone.
    }
    this.socket = null
  }

  /** Starts one assistant turn. Frames are delivered to `handlers` as they land. */
  startTurn(
    id: string,
    messages: ChatTurnMessage[],
    handlers: TurnHandlers,
    options: { speculative?: boolean; screen?: ScreenState } = {},
  ): TurnHandle {
    if (this.disposed) {
      handlers.onError('The link closed.', false)
      return { id, cancel: () => undefined }
    }
    this.turns.set(id, handlers)
    if (options.speculative) this.speculativeTurns.add(id)

    const forget = () => {
      this.turns.delete(id)
      this.speculativeTurns.delete(id)
      this.socketTurns.delete(id)
      this.httpControllers.delete(id)
    }

    if (!this.refreshPending && this.transport === 'socket' && this.socket?.readyState === WebSocket.OPEN) {
      // Remembered so a close — and only a close — can settle what rode on it.
      this.socketTurns.add(id)
      this.send({
        t: 'turn',
        id,
        messages,
        timezone: localTimezone(),
        speculative: options.speculative,
        screen: options.screen,
      })
      return {
        id,
        cancel: () => {
          forget()
          this.send({ t: 'cancel', id })
          this.drainRefresh()
        },
      }
    }

    const controller = new AbortController()
    this.httpControllers.set(id, controller)
    void this.runHttpTurn(id, messages, controller.signal, options.speculative, options.screen)
    return {
      id,
      cancel: () => {
        forget()
        controller.abort()
      },
    }
  }

  /** Requests spoken audio for one chunk of the reply. */
  async speak(turnId: string, seq: number, text: string, signal: AbortSignal): Promise<Blob> {
    if (this.disposed) throw new DOMException('Aborted', 'AbortError')
    if (!this.refreshPending && this.transport === 'socket' && this.socket?.readyState === WebSocket.OPEN) {
      const key = `${turnId}#${seq}`
      return new Promise<Blob>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        const onAbort = () => {
          if (!this.audio.has(key)) return
          this.audio.delete(key)
          this.send({ t: 'cancel', id: key })
          reject(new DOMException('Aborted', 'AbortError'))
          this.drainRefresh()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        // Settling forgets the listener, either way: a chunk that failed or
        // finished must not leave a wire into a signal that outlives it.
        const settled = (finish: () => void) => {
          signal.removeEventListener('abort', onAbort)
          finish()
        }
        this.audio.set(key, {
          resolve: (blob) => settled(() => resolve(blob)),
          reject: (error) => settled(() => reject(error)),
          mime: 'audio/mpeg',
          cleanup: () => signal.removeEventListener('abort', onAbort),
        })
        this.send({ t: 'speak', id: key, seq, text })
      })
    }

    signal = AbortSignal.any([signal, this.lifetime.signal])
    await this.awaitAccountForRequest(signal)
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const response = await fetch(backendUrl('/api/voice'), {
      method: 'POST',
      headers: backendHeaders('application/json'),
      body: JSON.stringify({ text }),
      signal,
    })
    if (!response.ok) throw new Error(await readErrorMessage(response))
    return response.blob()
  }

  private awaitAccountForRequest(signal?: AbortSignal): Promise<void> {
    return awaitAccount(signal)
  }

  /**
   * Fails only the work the socket was carrying.
   *
   * HTTP turns and voice run on their own connection with their own
   * controller: a dropped socket says nothing about their health, and a
   * fallback that answers fine must not be failed because the preferred
   * transport died next to it.
   */
  private abortSocketWork(message: string) {
    for (const id of this.socketTurns) {
      const handlers = this.turns.get(id)
      this.turns.delete(id)
      this.speculativeTurns.delete(id)
      handlers?.onError(message, true)
    }
    this.socketTurns.clear()

    for (const [key, pending] of this.audio) {
      this.audio.delete(key)
      pending.cleanup()
      pending.reject(new Error(message))
    }
    this.pendingAudioKey = null
  }

  private setTransport(next: LinkTransport) {
    if (this.transport === next) return
    this.transport = next
    this.onTransportChange?.(next)
  }

  private degrade() {
    this.clearSocketTimers()
    const old = this.socket
    this.socket = null
    try { old?.close() } catch { /* Already gone. */ }
    this.abortSocketWork('The connection dropped mid-answer.')
    rememberFallback()
    this.setTransport('http')
  }

  private clearSocketTimers() {
    if (this.openTimer) clearTimeout(this.openTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.openTimer = null
    this.pingTimer = null
  }

  private send(frame: ClientFrame) {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    try {
      this.socket.send(encodeFrame(frame))
    } catch {
      // A send on a dying socket is handled by the close handler.
    }
  }

  private dispatch(frame: ServerFrame) {
    switch (frame.t) {
      case 'ready':
        this.onConfig?.({
          configured: frame.configured,
          chatModel: frame.chatModel,
          voiceModel: frame.voiceModel,
          sttModel: frame.sttModel,
          tools: Array.isArray(frame.tools) ? frame.tools : [],
        })
        return
      case 'action':
        this.turns.get(frame.id)?.onAction?.({
          call: frame.call,
          name: frame.name,
          summary: frame.summary,
          ok: frame.ok,
          pending: frame.pending === true,
          detail: typeof frame.detail === 'string' ? frame.detail : '',
          links: Array.isArray(frame.links) ? frame.links : [],
        })
        return
      case 'card':
        // Read for its shape here, where it arrives: a card that cannot be drawn
        // is no card, and dissolves its searching pane like a declined one.
        this.onCard?.(frame.id, frame.call, readCard(frame.card))
        return
      case 'card_patch': {
        const patch = readPatch(frame)
        if (patch) this.onCardPatch?.(frame.id, frame.call, patch)
        return
      }
      case 'stage':
        if (frame.op === 'tuck') this.onStage?.(frame.id, { op: 'tuck' })
        else if (frame.op === 'show' && typeof frame.card === 'string') {
          this.onStage?.(frame.id, { op: 'show', card: frame.card })
        }
        return
      case 'tool_request':
        void this.fulfilTool(frame.id, frame.call, frame.name, frame.args)
        return
      case 'audio':
        this.pendingAudioKey = `${frame.id}`
        {
          const pending = this.audio.get(this.pendingAudioKey)
          if (pending) pending.mime = frame.mime
        }
        return
      case 'start':
        this.turns.get(frame.id)?.onStart?.()
        return
      case 'delta':
        this.turns.get(frame.id)?.onDelta(frame.text)
        return
      case 'done': {
        const handlers = this.turns.get(frame.id)
        this.turns.delete(frame.id)
        this.speculativeTurns.delete(frame.id)
        this.socketTurns.delete(frame.id)
        handlers?.onDone(frame.text)
        this.drainRefresh()
        return
      }
      case 'error': {
        if (frame.id && this.audio.has(frame.id)) {
          const pending = this.audio.get(frame.id)!
          this.audio.delete(frame.id)
          pending.reject(new Error(frame.message))
          this.drainRefresh()
          return
        }
        if (frame.id) {
          const handlers = this.turns.get(frame.id)
          this.turns.delete(frame.id)
          this.speculativeTurns.delete(frame.id)
          this.socketTurns.delete(frame.id)
          handlers?.onError(frame.message, frame.retryable)
          this.drainRefresh()
        }
        return
      }
      case 'pong':
      default:
        return
    }
  }

  /**
   * Runs a tool the server asked for and sends the result back.
   *
   * A reply always goes out, including on failure. The server is holding a turn
   * open waiting for one, and letting it time out would cost the user eight
   * seconds of silence to learn what a single frame could have told it.
   */
  private async fulfilTool(turnId: string, call: string, name: string, args: unknown) {
    const socket = this.socket
    const handlers = this.turns.get(turnId)
    let result = { ok: false, content: `The browser cannot run ${name}.` }
    // A cancelled turn, or a guess: either way nothing may actually happen.
    if (!this.turns.has(turnId) || this.speculativeTurns.has(turnId)) {
      result = { ok: false, content: 'That turn is no longer live.' }
    } else if (this.runClientTool) {
      try {
        result = await this.runClientTool(name, args)
      } catch (error) {
        result = {
          ok: false,
          content: error instanceof Error ? error.message : 'That could not be done here.',
        }
      }
    }
    // The turn was cancelled, replaced, or the socket swapped while the tool
    // ran: a stale result must not re-enter a turn that has moved on, and the
    // server settles only a reply naming the turn it is still holding.
    if (this.disposed || this.socket !== socket || !handlers || this.turns.get(turnId) !== handlers) return
    this.send({ t: 'tool_reply', id: turnId, call, ok: result.ok, content: result.content })
  }

  private resolveAudio(buffer: ArrayBuffer) {
    const key = this.pendingAudioKey
    this.pendingAudioKey = null
    if (!key) return
    const pending = this.audio.get(key)
    if (!pending) return
    this.audio.delete(key)
    pending.resolve(new Blob([buffer], { type: pending.mime }))
    this.drainRefresh()
  }

  private async runHttpTurn(
    id: string,
    messages: ChatTurnMessage[],
    signal: AbortSignal,
    speculative?: boolean,
    screen?: ScreenState,
  ) {
    const handlers = this.turns.get(id)
    if (!handlers) return

    try {
      await this.awaitAccountForRequest(signal)
      if (this.disposed || signal.aborted) return
      const response = await fetch(backendUrl('/api/chat'), {
        method: 'POST',
        headers: backendHeaders('application/json'),
        body: JSON.stringify({ id, messages, timezone: localTimezone(), speculative, screen }),
        signal,
      })

      if (!response.ok) throw new Error(await readErrorMessage(response))
      if (!response.body) throw new Error('The reply stream was empty.')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (signal.aborted || this.disposed) { await reader.cancel(); return }
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          const frame = decodeFrame<ServerFrame>(line)
          if (frame) this.dispatch(frame)
        }
        if (done) break
      }

      if (buffer.trim()) {
        const frame = decodeFrame<ServerFrame>(buffer)
        if (frame) this.dispatch(frame)
      }

      // A stream that ended without `done` still has to release the turn.
      const stranded = this.turns.get(id)
      if (stranded) {
        this.turns.delete(id)
        stranded.onError('The reply ended early.', true)
      }
    } catch (error) {
      const stranded = this.turns.get(id)
      this.turns.delete(id)
      if ((error as Error).name === 'AbortError') return
      stranded?.onError(
        error instanceof Error ? error.message : 'The reply was interrupted.',
        true,
      )
    } finally {
      this.speculativeTurns.delete(id)
      this.httpControllers.delete(id)
    }
  }
}

async function readErrorMessage(response: Response) {
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    return body.error?.message || 'That connection did not complete.'
  } catch {
    return 'That connection did not complete.'
  }
}
