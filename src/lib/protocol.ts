/**
 * Wire protocol shared by the WebSocket link and the streaming HTTP fallback.
 *
 * Both transports carry the same frames so the client only has one code path.
 * Over WebSocket the frames arrive as individual text messages; over HTTP they
 * arrive as newline-delimited JSON in the response body.
 *
 * One capability does not survive the fallback. A tool the *browser* fulfils
 * needs the server to ask a question and wait for an answer mid-turn, and a
 * single HTTP response can only be written in one direction. So `tool_request`
 * is socket-only, and the agent loop is told up front whether it has a way
 * back to the browser rather than discovering it half way through a turn.
 */

import type { Card } from './cards'

export const REALTIME_PATH = '/api/realtime'
export const REALTIME_PROTOCOL_VERSION = 2

export interface TurnMessage {
  role: 'user' | 'assistant'
  content: string
}

export type ClientFrame =
  | {
      t: 'hello'
      version: number
      /**
       * The shared access code, when the server is configured to want one.
       *
       * It travels in a frame rather than a header because the browser
       * WebSocket API cannot set headers, and in the body rather than the URL
       * because query strings end up in access logs.
       */
      access?: string
    }
  | {
      t: 'turn'
      id: string
      messages: TurnMessage[]
      /** The browser's timezone, so "today" means the user's today. */
      timezone?: string
      /**
       * This turn is a guess at a sentence the user has not finished, and may
       * be thrown away. The server must not let it change anything.
       */
      speculative?: boolean
    }
  | { t: 'speak'; id: string; seq: number; text: string }
  | { t: 'cancel'; id: string }
  /** The browser's answer to a `tool_request`. */
  | { t: 'tool_reply'; id: string; call: string; ok: boolean; content: string }
  | { t: 'ping'; at: number }

export type ServerFrame =
  /** Sent once when the socket is live. */
  | {
      t: 'ready'
      version: number
      configured: boolean
      chatModel: string
      voiceModel: string
      sttModel: string
      /** Which tools this server can actually run, given its configuration. */
      tools: string[]
    }
  /** The upstream request has been accepted; first token is imminent. */
  | { t: 'start'; id: string }
  /** An incremental piece of assistant text. */
  | { t: 'delta'; id: string; text: string }
  /** The turn finished cleanly. `text` is the full assistant message. */
  | { t: 'done'; id: string; text: string }
  /** Header frame for audio; over WebSocket the binary frame follows immediately. */
  | { t: 'audio'; id: string; seq: number; mime: string; bytes: number }
  /**
   * GIDEON did something. One line per action, for the ledger the user can
   * read back — an agent that acts has to be auditable.
   */
  | {
      t: 'action'
      id: string
      call: string
      name: string
      summary: string
      ok: boolean
      /** Still happening; a later frame with the same `call` replaces this one. */
      pending?: boolean
      /** What is being worked on, such as the question being researched. */
      detail?: string
      /** Where the result came from, for the user to open if they want to. */
      links?: Array<{ title: string; url: string; publishedDate?: string }>
    }
  /**
   * Something GIDEON looked up, laid out for the screen, or null when there is
   * nothing worth showing. May arrive after `done`, because it is drawn beside
   * the spoken answer rather than before it.
   */
  | { t: 'card'; id: string; call: string; card: Card | null }
  /** A change to what is on screen that the model asked for. */
  | { t: 'stage'; id: string; op: 'clear' }
  /** Asks the browser to run a tool only it can run. Socket transport only. */
  | { t: 'tool_request'; id: string; call: string; name: string; args: unknown }
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
