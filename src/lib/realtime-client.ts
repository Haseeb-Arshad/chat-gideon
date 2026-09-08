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
  REALTIME_PATH,
  REALTIME_PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type ClientFrame,
  type ServerFrame,
} from './protocol'

export type LinkTransport = 'idle' | 'connecting' | 'socket' | 'http'

export interface LinkConfig {
  configured: boolean
  chatModel: string
  voiceModel: string
}

export interface TurnHandlers {
  onStart?: () => void
  onDelta: (text: string) => void
  onDone: (text: string) => void
  onError: (message: string, retryable: boolean) => void
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

function socketUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}${REALTIME_PATH}`
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
}

export class RealtimeLink {
  transport: LinkTransport = 'idle'

  private socket: WebSocket | null = null
  private openTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 600
  private disposed = false

  private readonly turns = new Map<string, TurnHandlers>()
  private readonly audio = new Map<string, PendingAudio>()
  private pendingAudioKey: string | null = null

  private onTransportChange: ((transport: LinkTransport) => void) | null = null
  private onConfig: ((config: LinkConfig) => void) | null = null

  constructor(options: {
    onTransportChange?: (transport: LinkTransport) => void
    onConfig?: (config: LinkConfig) => void
  } = {}) {
    this.onTransportChange = options.onTransportChange ?? null
    this.onConfig = options.onConfig ?? null
  }

  connect() {
    if (this.disposed) return
    if (typeof window === 'undefined') return
    if (fallbackRemembered() || typeof WebSocket === 'undefined') {
      this.setTransport('http')
      return
    }
    if (this.socket) return

    this.setTransport('connecting')

    let socket: WebSocket
    try {
      socket = new WebSocket(socketUrl())
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
      if (this.openTimer) clearTimeout(this.openTimer)
      this.openTimer = null
      this.reconnectDelay = 600
      this.send({ t: 'hello', version: REALTIME_PROTOCOL_VERSION })
      this.setTransport('socket')
      this.pingTimer = setInterval(() => this.send({ t: 'ping', at: Date.now() }), PING_INTERVAL_MS)
    }

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const frame = decodeFrame<ServerFrame>(event.data)
        if (frame) this.dispatch(frame)
        return
      }
      this.resolveAudio(event.data as ArrayBuffer)
    }

    socket.onerror = () => {
      if (this.transport === 'connecting') this.degrade()
    }

    socket.onclose = () => {
      this.clearSocketTimers()
      this.socket = null
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
    this.clearSocketTimers()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.turns.clear()
    for (const pending of this.audio.values()) pending.reject(new Error('The link closed.'))
    this.audio.clear()
    try {
      this.socket?.close()
    } catch {
      // Nothing left to do on a socket that is already gone.
    }
    this.socket = null
  }

  /** Starts one assistant turn. Frames are delivered to `handlers` as they land. */
  startTurn(id: string, messages: ChatTurnMessage[], handlers: TurnHandlers): TurnHandle {
    this.turns.set(id, handlers)

    if (this.transport === 'socket' && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ t: 'turn', id, messages })
      return {
        id,
        cancel: () => {
          this.turns.delete(id)
          this.send({ t: 'cancel', id })
        },
      }
    }

    const controller = new AbortController()
    void this.runHttpTurn(id, messages, controller.signal)
    return {
      id,
      cancel: () => {
        this.turns.delete(id)
        controller.abort()
      },
    }
  }

  /** Requests spoken audio for one chunk of the reply. */
  async speak(turnId: string, seq: number, text: string, signal: AbortSignal): Promise<Blob> {
    if (this.transport === 'socket' && this.socket?.readyState === WebSocket.OPEN) {
      const key = `${turnId}#${seq}`
      return new Promise<Blob>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        this.audio.set(key, { resolve, reject, mime: 'audio/mpeg' })
        signal.addEventListener(
          'abort',
          () => {
            if (!this.audio.has(key)) return
            this.audio.delete(key)
            this.send({ t: 'cancel', id: key })
            reject(new DOMException('Aborted', 'AbortError'))
          },
          { once: true },
        )
        this.send({ t: 'speak', id: key, seq, text })
      })
    }

    const response = await fetch('/api/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    })
    if (!response.ok) throw new Error(await readErrorMessage(response))
    return response.blob()
  }

  private setTransport(next: LinkTransport) {
    if (this.transport === next) return
    this.transport = next
    this.onTransportChange?.(next)
  }

  private degrade() {
    this.clearSocketTimers()
    this.socket = null
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
        })
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
        handlers?.onDone(frame.text)
        return
      }
      case 'error': {
        if (frame.id && this.audio.has(frame.id)) {
          const pending = this.audio.get(frame.id)!
          this.audio.delete(frame.id)
          pending.reject(new Error(frame.message))
          return
        }
        if (frame.id) {
          const handlers = this.turns.get(frame.id)
          this.turns.delete(frame.id)
          handlers?.onError(frame.message, frame.retryable)
        }
        return
      }
      case 'pong':
      default:
        return
    }
  }

  private resolveAudio(buffer: ArrayBuffer) {
    const key = this.pendingAudioKey
    this.pendingAudioKey = null
    if (!key) return
    const pending = this.audio.get(key)
    if (!pending) return
    this.audio.delete(key)
    pending.resolve(new Blob([buffer], { type: pending.mime }))
  }

  private async runHttpTurn(id: string, messages: ChatTurnMessage[], signal: AbortSignal) {
    const handlers = this.turns.get(id)
    if (!handlers) return

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, messages }),
        signal,
      })

      if (!response.ok) throw new Error(await readErrorMessage(response))
      if (!response.body) throw new Error('The reply stream was empty.')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
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
