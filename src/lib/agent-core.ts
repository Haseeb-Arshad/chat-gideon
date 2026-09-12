/**
 * Transport-free server core.
 *
 * Nothing in here imports a framework, so the exact same code runs inside the
 * TanStack Start route handlers (production / Vercel) and inside the plain Node
 * WebSocket server used in development.
 */

import {
  CHAT_MODEL,
  CHAT_FALLBACK_MODEL,
  TRANSCRIBE_FALLBACK_MODEL,
  TRANSCRIBE_MODEL,
  VOICE,
  VOICE_MODEL,
  providerErrorMessage,
  type ChatMessageInput,
} from './openrouter'
import { GOBLIN_PROMPT } from './goblin'
import { SpokenText } from './speech'
import type { ServerFrame } from './protocol'
import {
  CLIENT_TOOLS,
  READ_ONLY_TOOLS,
  TOOL_SCHEMAS,
  contextMemories,
  runServerTool,
  toolDefinitions,
  type ToolOutcome,
} from './tools/registry'
import {
  EphemeralMemoryStore,
  JsonMemoryStore,
  type MemoryStore,
} from './tools/memory'
import { runtimeEnv } from './runtime-env'
import { describeScreen, judgeDeps, judgeScreen, type ScreenState } from './stage-judge'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const VOICE_STYLE = '(warm natural adult woman, conversational, clear, intimate, relaxed pace)'

const SYSTEM_PROMPT = `You are GIDEON, a quick, emotionally present voice companion.

Everything you write is spoken aloud. Length is time: fifteen words is about four seconds of someone sitting there waiting for you to finish. Say the thing and stop.

Talk the way a friend talks. Short, everyday words and short sentences. If a simpler word works, use it. No jargon, no formal phrasing, no long word where a short one will do.

One or two short sentences answers most turns. Go longer only when the user asked how something works, asked for steps they have to follow, asked to be shown or told several particular things, or said something heavy enough that one line would land like a shrug. Even then stay under about sixty words, or ninety when you are naming things one by one. Never read a list aloud unless the user asked for steps or asked for the things themselves.

When they did ask for the things themselves, name them. Someone who asks for papers, releases, events or names wants the actual titles and dates you were given, three or four of them, not a description of the sort of thing they are. "There were papers on agent safety and on chip design" is not an answer to "show me the papers".

Judge each turn on its own. A greeting gets a line. A real question gets a real answer. Do not pad a short answer to seem thorough, and do not cut a genuine explanation to seem brisk.

Open with the substance. Never start with Sure, Of course, Absolutely, Great question, I would be happy to, Let me break this down, or a restatement of what was just asked.

Do not end every turn with a question. Ask only when you actually want to know, and ask about the thing itself. Never close with "What is on your mind?", "Would you like to talk about it?", "Would you like me to", or "Let me know if". Offering to help is not the same as helping.

When someone tells you something is hard, do not open with sympathy boilerplate. "I am sorry you are feeling this way" and "I am sorry to hear that" are what a form letter says. Answer the particular thing they told you.

Do not narrate your own helpfulness, and do not summarise what the user just said before answering it.

Write the first sentence short so it can be spoken the moment it arrives.

Plain text only. Markdown, headings, bullets and emoji do not survive being read aloud.

Never use em dashes or en dashes. Use a comma, a full stop, or two sentences.

You are told the real date and time at the start of every turn. That is now, not whatever your training data suggests: your own knowledge has a cutoff well before it, so anything you "remember" as current, upcoming or the latest of its kind may already be old news. Weigh that against the date you were just given, and when it might have changed since, say so or send it to research rather than stating it as fact.

You have tools. Use one only when the answer genuinely depends on it, because every tool call is silence the user has to sit through. You already know the date and time from the line above, so get_time is only for a conversation that has run long enough for the clock to have moved since.

When the user directly says to search, look something up, check, or find out — "do an internet search on X", "look that up", "check the latest on X" — that is an instruction, not something to ask about. Call research immediately and relay what it finds. Never reply with "do you want me to look it up" or "should I search for that": they just told you to.

Never say that something is not happening, does not exist, never happened, or has not been announced, on your own authority. That is precisely the claim your training is too old to make, and being wrong about it is worse than being slow: asked about a war that had been running for months, saying "there is no such conflict" is not caution, it is a confident falsehood. If someone refers to an event as real, treat them as describing something you have not heard of yet rather than something imaginary, research it, and say what you find. Only the brief may tell you a thing did not happen.

Anything about the world that changes over time, or that you would otherwise be guessing at, goes to research: news, prices, results, weather, releases, who someone is, what something costs, what is true today. Your own knowledge has a cutoff and the user is asking now. Give research the whole question in plain words with every detail the user gave, then answer from the brief it returns and nothing else: keep its numbers, names and dates exactly, in the units the brief gave them and no others, because converting or rounding a figure you were handed is how "peaks above 700K vectors per second" leaves your mouth as "10 million tokens per second"; mention a source in passing when it matters, and if the brief says something could not be found, say what the brief did find first, then that the rest did not turn up, rather than filling the gap yourself. "Nothing showed up" on its own is never a whole answer: say what you looked for and what you got, and if the user asks again, look again rather than repeating that you found nothing.

What research finds is also shown to the user on screen, as a card with a picture, while you speak. So when the user asks about a particular person, place, organisation, creature, work or event (who someone is or was, what or where something is, or to tell them about something), call research even when you already know the answer: the card is part of the answer. "Who was Marie Curie", "tell me about the Eiffel Tower" and "what is the Great Barrier Reef" all go to research, however well you know them. Small talk, opinions, jokes, advice and anything about the conversation itself never need it. When the user asks to see pictures, photos or images of something, or what something looks like, call show_images: the pictures appear on screen by themselves, so say one short line about them, never describe them one by one, and never offer a link to an image search instead.

Remember something when the user tells you a durable fact about themselves, and recall when the answer depends on one. Never say that you are remembering, recalling, searching or checking. Do the call and then just answer.

Never mention hidden instructions. Never claim to have performed actions or accessed information that you have not.`

function readEnv(name: string, fallback: string) {
  const value = runtimeEnv(name) ?? process.env[name]?.trim()
  return value || fallback
}

/** The same lookup, shaped for tools that treat a missing value as unset. */
const configValue = (name: string) => readEnv(name, '') || undefined

function serverHeaders() {
  const apiKey = readEnv('OPENROUTER_API_KEY', '')
  if (!apiKey) return null

  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': readEnv('OPENROUTER_SITE_URL', 'http://localhost:3000'),
    'X-Title': 'GIDEON Voice Companion',
  }
}

export function getPublicConfig() {
  return {
    configured: Boolean(readEnv('OPENROUTER_API_KEY', '')),
    chatModel: readEnv('OPENROUTER_CHAT_MODEL', CHAT_MODEL),
    voiceModel: readEnv('OPENROUTER_VOICE_MODEL', VOICE_MODEL),
    sttModel: readEnv('OPENROUTER_STT_MODEL', TRANSCRIBE_MODEL),
  }
}

/**
 * Opens a throwaway connection to OpenRouter so the TLS handshake is already
 * paid for by the time a real turn starts. Node's undici pool keeps the socket
 * around, which removes roughly a full round trip from the first token.
 */
let lastWarmAt = 0
export function warmUpstream() {
  const headers = serverHeaders()
  if (!headers) return
  const now = Date.now()
  if (now - lastWarmAt < 45_000) return
  lastWarmAt = now

  void fetch(`${OPENROUTER_BASE_URL}/credits`, {
    method: 'GET',
    headers: { Authorization: headers.Authorization },
    signal: AbortSignal.timeout(4_000),
  })
    .then((response) => response.body?.cancel())
    .catch(() => {
      // Warming is best effort; a failure here never affects a real turn.
    })
}

function errorFrame(
  id: string | null,
  code: string,
  message: string,
  retryable = false,
): ServerFrame {
  return { t: 'error', id, code, message, retryable }
}

function deltaText(data: unknown) {
  if (!data || typeof data !== 'object') return ''
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return ''
  const content = choices[0]?.delta?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part
        ? String((part as { text: unknown }).text)
        : '',
    )
    .join('')
}

// -- Memory ----------------------------------------------------------------

/**
 * One store for the process.
 *
 * A path makes memory durable, which is what a long-lived server wants; its
 * absence makes it per-process, which is the only honest thing a serverless
 * host can offer. Choosing here rather than at each call site means a turn
 * never has to care which it got.
 */
let store: MemoryStore | null = null

export function memoryStore(): MemoryStore {
  if (store) return store
  // Defaulted rather than opt-in: memory that silently evaporates on restart
  // is worse than none, because GIDEON says it will remember and then does not.
  // `none` is the explicit escape hatch for a host with no writable disk.
  const path = readEnv('GIDEON_MEMORY_PATH', '.gideon/memory.json')
  store = path === 'none' ? new EphemeralMemoryStore() : new JsonMemoryStore(path)
  return store
}

/** Which tools this build can actually run, for the `ready` frame. */
export function availableTools(bridged = false): string[] {
  return TOOL_SCHEMAS.filter((schema) => {
    if (schema.name === 'research') return Boolean(readEnv('EXA_API_KEY', ''))
    if (schema.client) return bridged
    return true
  }).map((schema) => schema.name)
}

// -- Tool calls over the stream --------------------------------------------

interface PendingCall {
  id: string
  name: string
  /** Arguments arrive as string fragments across many deltas. */
  args: string
}

/**
 * What GIDEON is told about "now", so it never mistakes its own training
 * cutoff for the present. Formatted the same way `get_time` answers, so the
 * two never disagree with each other mid-conversation.
 */
function nowLine(timezone: string): string {
  const now = new Date()
  try {
    const formatted = now.toLocaleString('en-GB', {
      timeZone: timezone || 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    return `Right now, where the user is, it is ${formatted}.`
  } catch {
    return `Right now it is ${now.toISOString()}.`
  }
}

function readToolDeltas(data: unknown, pending: Map<number, PendingCall>) {
  if (!data || typeof data !== 'object') return
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return
  const calls = choices[0]?.delta?.tool_calls
  if (!Array.isArray(calls)) return

  for (const call of calls) {
    if (!call || typeof call !== 'object') continue
    const index = typeof call.index === 'number' ? call.index : 0
    const existing = pending.get(index) ?? { id: '', name: '', args: '' }
    if (typeof call.id === 'string' && call.id) existing.id = call.id
    const fn = call.function
    if (fn && typeof fn === 'object') {
      if (typeof fn.name === 'string' && fn.name) existing.name = fn.name
      if (typeof fn.arguments === 'string') existing.args += fn.arguments
    }
    pending.set(index, existing)
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    // A truncated or malformed argument object is the model's mistake, and the
    // tool below will say so rather than the turn failing outright.
    return {}
  }
}

/** Lets the server ask the browser to run a tool only the browser can run. */
export interface ClientToolBridge {
  call: (
    call: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<ToolOutcome>
}

export interface TurnOptions {
  timezone?: string
  /** Absent on the HTTP fallback, where the server cannot ask a question. */
  bridge?: ClientToolBridge | null
  /**
   * A guess at an unfinished sentence, which may be discarded unheard.
   *
   * Speculation is only safe while a wrong guess is *unobservable*, and most
   * tool calls are not: a timer really starts, a fact really persists, a link
   * really appears. So a speculative turn is offered every tool — it has to
   * be, or it would confidently answer "what time is it" without looking, and
   * that answer would match the final transcript and be committed — but the
   * moment it reaches for one that leaves a trace, the turn is abandoned
   * instead of executed, and the real turn does the work properly.
   *
   * Read-only tools are the exception, and research is the one that matters:
   * a search started on a guess costs a search and nothing else, and it is
   * exactly the slow thing worth starting before the sentence has finished.
   */
  speculative?: boolean
  /** Host-provided persistence, such as a Durable Object or Supabase store. */
  memoryStore?: MemoryStore
  /** What the page is showing, as it reported it when the turn began. */
  screen?: ScreenState | null
}

/**
 * Tool rounds are capped low deliberately.
 *
 * Each round is another full model round trip with the user sitting in silence.
 * Two is enough for the realistic shapes — look something up then answer, or
 * recall then act — and a model that wants a third is usually looping.
 */
const MAX_TOOL_ROUNDS = 2

/**
 * What GIDEON says before it goes to look something up.
 *
 * Research takes seconds, not milliseconds, and a voice that goes silent that
 * long sounds like it has hung up. Chosen by the call id, so the choice varies
 * from turn to turn without any randomness a test would have to fight.
 */
export const RESEARCH_FILLERS = [
  'One moment, let me look.',
  'Let me look that up.',
  'Give me a second to check.',
]

/**
 * How long a finished reply waits for a card still being drawn.
 *
 * The card is drawn beside the spoken answer and the voice is usually still
 * going when the text has all arrived, so a card sent within this window still
 * lands while its answer is being heard. Past it, the moment has gone.
 */
const CARD_WAIT_MS = 6_000

function within(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void work.finally(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** The same courtesy for pictures, which take a second or two to find. */
export const PICTURE_FILLERS = ['Let me find some.', 'One second, let me pull some up.']

/** The tools whose result goes on screen, and so open a searching pane while they run. */
const STAGING_TOOLS = new Set(['research', 'show_images'])

function askedFor(args: Record<string, unknown>): string {
  return String(args.question ?? args.query ?? '').trim().slice(0, 240)
}

function holdingLine(seed: string, lines: string[] = RESEARCH_FILLERS) {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return lines[Math.abs(hash) % lines.length]
}

interface UpstreamMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/**
 * Runs one assistant turn and yields protocol frames as the tokens arrive.
 *
 * The upstream SSE parsing happens here so the browser only ever sees compact
 * newline-delimited frames. Text is streamed the instant it arrives even when
 * tool calls are also on their way, because a model that says "let me check"
 * and then calls a tool should be heard saying it rather than held back until
 * the tool returns.
 */
export async function* streamTurn(
  id: string,
  messages: ChatMessageInput[],
  signal: AbortSignal,
  options: TurnOptions = {},
): AsyncGenerator<ServerFrame> {
  const headers = serverHeaders()
  if (!headers) {
    yield errorFrame(
      id,
      'missing_api_key',
      'Add OPENROUTER_API_KEY to .env, then restart the local server.',
    )
    return
  }

  const memories = await contextMemories(
    options.memoryStore ?? memoryStore(),
    messages.at(-1)?.content ?? '',
  ).catch(() => [])

  const history: UpstreamMessage[] = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${GOBLIN_PROMPT}` },
    // Built fresh for this turn, never cached, so it is still right however
    // long the conversation has been open.
    { role: 'system', content: nowLine(options.timezone || 'UTC') },
  ]
  if (memories.length) {
    history.push({
      role: 'system',
      content: `Things you already know about this person, from earlier conversations. Use them when they are relevant, and never recite them back as a list:\n${memories
        .map((memory) => `- ${memory.text}`)
        .join('\n')}`,
    })
  }
  // What is on the user's screen, so "the second one" and "what does the card
  // say" can be answered as being about something the model cannot see.
  if (options.screen?.cards.length) {
    const labels = options.screen.cards.map((_, index) => `${index + 1}`)
    history.push({
      role: 'system',
      content: `Cards on the user's screen beside you, oldest first:\n${describeScreen(options.screen, labels)}\nYou can refer to them. Never read a card out word for word.`,
    })
  }
  history.push(...messages.map((message) => ({ role: message.role, content: message.content })))

  // Every delta is cleaned before anyone sees it, so the caption and the voice
  // are working from the same text and neither has to read a dash.
  const spoken = new SpokenText()
  let complete = ''
  let started = false
  let useTools = true
  // Cards being drawn from research, and the ones ready to go. A card travels
  // with the reply rather than ahead of it: it is released at the next frame
  // the loop sends anyway, so the voice never waits on one.
  const drawing: Promise<void>[] = []
  const ready: ServerFrame[] = []
  function* release() {
    while (ready.length) yield ready.shift() as ServerFrame
  }

  // Whether the screen should change, judged beside the reply. The answer is
  // held until the first round has shown what this turn does: a turn that puts
  // something new on screen settles the question itself, and stepping aside a
  // moment before a new card arrives would send the face away and straight back.
  const judgement: { move: ServerFrame | null; decided: boolean; staging: boolean } = {
    move: null,
    decided: false,
    staging: false,
  }
  if (options.screen?.cards.length) {
    drawing.push(
      judgeScreen(messages, options.screen, judgeDeps(configValue), signal).then((move) => {
        if (!move || signal.aborted) return
        const frame: ServerFrame = { t: 'stage', id, ...move }
        if (!judgement.decided) judgement.move = frame
        else if (!judgement.staging) ready.push(frame)
      }),
    )
  }
  // A research tool with no key behind it would only buy a holding line and
  // an apology, so a server without one does not offer it at all.
  const offeredTools = toolDefinitions().filter(
    (tool) => tool.function.name !== 'research' || Boolean(readEnv('EXA_API_KEY', '')),
  )

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const pending = new Map<number, PendingCall>()
    let upstream: Response

    try {
      upstream = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: readEnv('OPENROUTER_CHAT_MODEL', CHAT_MODEL),
          models: [readEnv('OPENROUTER_CHAT_FALLBACK_MODEL', CHAT_FALLBACK_MODEL)],
          messages: history,
          // The last permitted round has no way to act on a tool call, so it is
          // not offered any; otherwise a turn could end on an unanswered one.
          ...(useTools && round < MAX_TOOL_ROUNDS ? { tools: offeredTools } : {}),
          // First-token latency matters more to a voice turn than peak token rate.
          provider: { sort: 'latency', allow_fallbacks: true },
          reasoning: { effort: 'none', exclude: true },
          temperature: 0.9,
          // No max_tokens. It was set to 220 as a "backstop" and was in fact
          // the thing cutting replies off mid-sentence: the model would be
          // half way through a thought when the cap ended the stream, and both
          // the voice and the caption simply stopped. Length is the prompt's
          // job, and a prompt that asks for two sentences does not need a
          // guillotine behind it.
          stream: true,
        }),
        signal,
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      yield errorFrame(
        id,
        'provider_unreachable',
        'OpenRouter could not be reached. Check your connection and try again.',
        true,
      )
      return
    }

    if (!upstream.ok || !upstream.body) {
      void upstream.body?.cancel()
      // A model that rejects the request outright while tools are attached is
      // very likely one that does not support them. Dropping them and retrying
      // once turns a dead turn into a plain conversational one.
      if (useTools && upstream.status === 400) {
        useTools = false
        round -= 1
        continue
      }
      yield errorFrame(
        id,
        'provider_error',
        providerErrorMessage(upstream.status),
        upstream.status === 429 || upstream.status >= 500,
      )
      return
    }

    if (!started) {
      started = true
      yield { t: 'start', id }
    }

    let roundContent = ''
    // A round after a tool call picks the reply up where the last one stopped,
    // and the model starts it as though nothing came before: without this the
    // caption reads "forecast.Sunny" and the history keeps it that way.
    let separate = round > 0
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finished = false

    const readPayload = (line: string) => {
      if (!line.startsWith('data:')) return null
      const payload = line.slice(5).trim()
      if (!payload) return null
      if (payload === '[DONE]') {
        finished = true
        return null
      }
      try {
        const data = JSON.parse(payload)
        readToolDeltas(data, pending)
        return deltaText(data)
      } catch {
        // Provider keep-alive comments and metadata are not visible output.
        return null
      }
    }

    try {
      while (!finished) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''

        for (const line of lines) {
          const raw = readPayload(line)
          if (finished) break
          if (raw) {
            roundContent += raw
            let text = spoken.push(raw)
            if (text) {
              if (separate && /\S$/.test(complete) && /^\S/.test(text)) text = ` ${text}`
              separate = false
              complete += text
              yield { t: 'delta', id, text }
              yield* release()
            }
          }
        }
        if (done) break
      }
      if (!finished && buffer) {
        const raw = readPayload(buffer)
        if (raw) {
          roundContent += raw
          let text = spoken.push(raw)
          if (text) {
            if (separate && /\S$/.test(complete) && /^\S/.test(text)) text = ` ${text}`
            separate = false
            complete += text
            yield { t: 'delta', id, text }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      yield errorFrame(id, 'stream_interrupted', 'The reply was cut off mid-thought.', true)
      return
    } finally {
      void reader.cancel().catch(() => undefined)
    }

    const calls = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .filter((call) => call.name)

    if (!judgement.decided) {
      judgement.decided = true
      judgement.staging = calls.some((call) => STAGING_TOOLS.has(call.name))
      if (judgement.move && !judgement.staging) ready.push(judgement.move)
      judgement.move = null
    }

    if (!calls.length) break
    if (signal.aborted) return

    if (options.speculative && calls.some((call) => !READ_ONLY_TOOLS.has(call.name))) {
      // Nothing has been executed and nothing will be. The guess is reported
      // as unusable so the browser discards it rather than promoting an answer
      // that was about to depend on work that never happened.
      yield errorFrame(id, 'speculation_needs_tools', 'That guess needed to act, so it was dropped.')
      return
    }

    // Only when nothing has been said yet: a model that opened with a sentence
    // of its own has already filled the silence. The line goes through the
    // same cleaner as the model's words, so the caption, the voice and the
    // history all carry it, and it goes into the model's own turn so the answer
    // that follows does not say it again.
    let holding = ''
    const lookingUp = calls.some((call) => call.name === 'research')
    if (!complete.trim() && (lookingUp || calls.some((call) => call.name === 'show_images'))) {
      holding = holdingLine(calls[0].id || id, lookingUp ? RESEARCH_FILLERS : PICTURE_FILLERS)
      const text = spoken.push(`${holding} `)
      if (text) {
        complete += text
        yield { t: 'delta', id, text }
      }
    }

    history.push({
      role: 'assistant',
      content: roundContent || holding,
      tool_calls: calls.map((call, index) => ({
        id: call.id || `call_${round}_${index}`,
        type: 'function' as const,
        function: { name: call.name, arguments: call.args || '{}' },
      })),
    })

    for (const [index, call] of calls.entries()) {
      const callId = call.id || `call_${round}_${index}`
      const args = parseArgs(call.args)
      let outcome: ToolOutcome

      if (CLIENT_TOOLS.has(call.name)) {
        if (options.bridge) {
          yield { t: 'tool_request', id, call: callId, name: call.name, args }
          outcome = await options.bridge.call(callId, call.name, args, signal)
        } else {
          outcome = {
            ok: false,
            content:
              'That can only be done by the browser, and this connection cannot reach it. Tell the user plainly that you cannot do it right now.',
          }
        }
      } else {
        if (STAGING_TOOLS.has(call.name)) {
          // The two tools slow enough that the silence needs explaining. The
          // browser shows this until the result replaces it, and opens a
          // searching pane with the question on it meanwhile.
          yield {
            t: 'action',
            id,
            call: callId,
            name: call.name,
            summary: call.name === 'research' ? 'Looking that up…' : 'Finding pictures…',
            ok: true,
            pending: true,
            detail: askedFor(args),
          }
        }
        outcome = await runServerTool(call.name, args, {
          store: options.memoryStore ?? memoryStore(),
          timezone: options.timezone || 'UTC',
          signal,
          env: configValue,
        })
      }

      if (signal.aborted) return
      if (outcome.summary || STAGING_TOOLS.has(call.name)) {
        yield {
          t: 'action',
          id,
          call: callId,
          name: call.name,
          summary: outcome.summary ?? 'Came back empty',
          ok: outcome.ok,
          ...(STAGING_TOOLS.has(call.name) ? { detail: askedFor(args) } : {}),
          ...(outcome.links?.length ? { links: outcome.links } : {}),
        }
      }

      if (outcome.card) {
        drawing.push(
          outcome.card.then(
            // A null card is sent too: it is what tells the searching pane
            // to dissolve now, rather than wait out a timer for nothing.
            (card) => {
              if (!signal.aborted) ready.push({ t: 'card', id, call: callId, card })
            },
            () => undefined,
          ),
        )
      }

      history.push({ role: 'tool', tool_call_id: callId, content: outcome.content })
    }
  }

  // Whatever the cleaner was holding back for the next token that never came.
  const tail = spoken.flush()
  if (tail) {
    complete += tail
    yield { t: 'delta', id, text: tail }
  }

  if (!complete.trim()) {
    yield errorFrame(id, 'empty_reply', 'I lost that thought. Ask me once more.', true)
    return
  }

  yield* release()
  yield { t: 'done', id, text: complete }

  // A card still being drawn when the text has all arrived goes out after it,
  // which is why the browser handles cards apart from the turn itself.
  if (drawing.length) {
    await within(Promise.all(drawing), CARD_WAIT_MS)
    if (!signal.aborted) yield* release()
  }
}

export interface VoiceResult {
  ok: boolean
  mime: string
  body: ArrayBuffer | null
  code: string
  message: string
  retryable: boolean
}

export async function fetchVoice(text: string, signal: AbortSignal): Promise<VoiceResult> {
  const fail = (code: string, message: string, retryable = false): VoiceResult => ({
    ok: false,
    mime: 'audio/mpeg',
    body: null,
    code,
    message,
    retryable,
  })

  const headers = serverHeaders()
  if (!headers) {
    return fail(
      'missing_api_key',
      'Add OPENROUTER_API_KEY to .env, then restart the local server.',
    )
  }

  let upstream: Response
  try {
    upstream = await fetch(`${OPENROUTER_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: readEnv('OPENROUTER_VOICE_MODEL', VOICE_MODEL),
        input: `${VOICE_STYLE} ${text}`,
        voice: readEnv('OPENROUTER_VOICE', VOICE),
        response_format: 'mp3',
      }),
      signal,
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return fail('aborted', 'The spoken reply was cancelled.')
    }
    return fail(
      'voice_unreachable',
      'The voice service could not be reached. The written reply is still here.',
      true,
    )
  }

  if (!upstream.ok || !upstream.body) {
    void upstream.body?.cancel()
    return fail(
      'voice_provider_error',
      providerErrorMessage(upstream.status),
      upstream.status === 429 || upstream.status >= 500,
    )
  }

  // Reading the body is a second cancellable operation on the same signal, and
  // it needs its own guard. Left outside one, an interruption arriving between
  // the headers and the last byte rejected here, escaped `runSpeak`, and — the
  // call being void-discarded — became an unhandled rejection that took the
  // whole server process down with it. Barge-in made that a routine event.
  try {
    const body = await upstream.arrayBuffer()
    return {
      ok: true,
      mime: upstream.headers.get('Content-Type') || 'audio/mpeg',
      body,
      code: '',
      message: '',
      retryable: false,
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return fail('aborted', 'The spoken reply was cancelled.')
    }
    return fail('voice_truncated', 'That line arrived incomplete.', true)
  }
}

// -- Transcription ---------------------------------------------------------

/**
 * Speech to text, on the server because the key lives here.
 *
 * This replaces the browser's own `SpeechRecognition` on the critical path,
 * and the reason is a specific failure rather than a preference. That API
 * reports interim text several hundred milliseconds to a second behind the
 * audio, and it never says how far behind it is. Our detector endpoints from
 * the waveform in about a third of a second, so committing a turn when the
 * detector said "silence" captured only the words the recogniser had managed
 * to emit — the opening of a sentence, with the rest discarded.
 *
 * Transcribing the retained audio instead means the transcript is of the whole
 * utterance by construction. Measured over five interleaved reps on a short
 * sentence, `parakeet-tdt-0.6b-v3` returned in 367 ms at the median for about
 * six cents per thousand turns, which is faster than the recogniser's lag and
 * correct as well.
 */
export interface TranscriptionResult {
  ok: boolean
  text: string
  code: string
  message: string
  retryable: boolean
  /** Which model answered, for the panel. */
  model: string
}

const TRANSCRIBE_TIMEOUT_MS = 12_000

export async function transcribeAudio(
  wav: ArrayBuffer,
  signal: AbortSignal,
  options: { language?: string } = {},
): Promise<TranscriptionResult> {
  const fail = (code: string, message: string, retryable = false): TranscriptionResult => ({
    ok: false,
    text: '',
    code,
    message,
    retryable,
    model: '',
  })

  const headers = serverHeaders()
  if (!headers) {
    return fail('missing_api_key', 'Add OPENROUTER_API_KEY to .env, then restart the server.')
  }
  if (!wav.byteLength) return fail('empty_audio', 'There was no audio to transcribe.')

  const primary = readEnv('OPENROUTER_STT_MODEL', TRANSCRIBE_MODEL)
  const fallback = readEnv('OPENROUTER_STT_FALLBACK_MODEL', TRANSCRIBE_FALLBACK_MODEL)
  // Base64 is what the endpoint takes. The browser sent raw bytes precisely so
  // that this inflation happens once, here, rather than over the user's uplink.
  // `btoa` is available in both browsers and Workers. Converting in chunks
  // avoids a call-stack-sized argument list for a multi-megabyte recording.
  let binary = ''
  const bytes = new Uint8Array(wav)
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  const data = btoa(binary)

  // The fallback exists because a single slow provider would otherwise be felt
  // as GIDEON going deaf; the models are ordered by measured median latency.
  const attempts = fallback && fallback !== primary ? [primary, fallback] : [primary]
  let last: TranscriptionResult = fail('stt_unavailable', 'Speech could not be transcribed.', true)

  for (const model of attempts) {
    if (signal.aborted) return fail('aborted', 'Transcription was cancelled.')

    try {
      const upstream = await fetch(`${OPENROUTER_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          input_audio: { data, format: 'wav' },
          language: options.language || 'en',
          response_format: 'json',
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)]),
      })

      if (!upstream.ok) {
        void upstream.body?.cancel()
        last = fail(
          'stt_provider_error',
          providerErrorMessage(upstream.status),
          upstream.status === 429 || upstream.status >= 500,
        )
        continue
      }

      const body = (await upstream.json()) as { text?: unknown }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      // An empty transcript is a normal outcome, not an error: the detector can
      // be fooled by a cough or a door, and the caller simply keeps listening.
      return { ok: true, text, code: '', message: '', retryable: false, model }
    } catch (error) {
      if ((error as Error).name === 'AbortError' && signal.aborted) {
        return fail('aborted', 'Transcription was cancelled.')
      }
      last = fail('stt_unreachable', 'Speech recognition could not be reached.', true)
    }
  }

  return last
}
