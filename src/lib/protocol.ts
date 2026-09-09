/**
 * Wire protocol shared by the WebSocket link and the streaming HTTP fallback.
 *
 * Both transports carry the exact same frames so the client only has one code
 * path. Over WebSocket the frames arrive as individual text messages; over HTTP
 * they arrive as newline-delimited JSON in the response body.
 */

export const REALTIME_PATH = '/api/realtime'
export const REALTIME_PROTOCOL_VERSION = 1

export type ClientFrame =
  | { t: 'hello'; version: number }
  | {
      t: 'turn'
      id: string
      messages: Array<{ role: 'user' | 'assistant'; content: string }>
    }
  | { t: 'speak'; id: string; seq: number; text: string }
  | { t: 'cancel'; id: string }
  | { t: 'ping'; at: number }

export type ServerFrame =
  /** Sent once when the socket is live. `warm` reports upstream pre-connect. */
  | { t: 'ready'; version: number; configured: boolean; chatModel: string; voiceModel: string }
  /** The upstream request has been accepted; first token is imminent. */
  | { t: 'start'; id: string }
  /** An incremental piece of assistant text. */
  | { t: 'delta'; id: string; text: string }
  /** The turn finished cleanly. `text` is the full assistant message. */
  | { t: 'done'; id: string; text: string }
  /** Header frame for audio; over WebSocket the binary frame follows immediately. */
  | { t: 'audio'; id: string; seq: number; mime: string; bytes: number }
  | { t: 'error'; id: string | null; code: string; message: string; retryable: boolean }
  | { t: 'pong'; at: number }

export function encodeFrame(frame: ServerFrame | ClientFrame) {
  return JSON.stringify(frame)
}

export function decodeFrame<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
