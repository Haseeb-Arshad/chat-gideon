/**
 * The things GIDEON can actually do.
 *
 * Two kinds live here behind one interface. Server tools run where the keys are
 * — memory, the clock, a web search. Client tools run in the browser, because
 * some things are only possible there: a timer that survives being spoken
 * about, a link put in front of you, the state of the device you are holding.
 * The agent loop does not care which it called; it sends a request and waits
 * for a result, and the transport decides where that result comes from.
 *
 * Tool descriptions are written for a model that is about to *speak* the
 * answer, which is why several of them say so explicitly. A tool that returns a
 * table produces a reply nobody wants read aloud.
 */

import {
  type Memory,
  type MemoryStore,
  rank,
  remember,
  touch,
  type MemoryKind,
} from './memory'
import { defaultDeps, research, type EnvReader, type ResearchSource } from './research'
import { buildCard, cardDeps } from './card-builder'
import type { Card } from '../cards'

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Fulfilled by the browser rather than the server. */
  client?: boolean
  /**
   * Leaves no trace: nothing stored, started, or shown. Only these may run in
   * a speculative turn, because only for these is a wrong guess unobservable.
   */
  readOnly?: boolean
}

export interface ToolOutcome {
  ok: boolean
  /**
   * What goes back to the model. Kept short and prose-shaped, because whatever
   * is in here is about to be turned into speech.
   */
  content: string
  /** One line for the action ledger, or nothing to keep it out of the ledger. */
  summary?: string
  /** Pages the user may want to open themselves: where an answer came from. */
  links?: ResearchSource[]
  /**
   * A card for the screen, still being drawn. Left as a promise on purpose:
   * the agent loop hands `content` to the speaking model straight away and
   * sends the card whenever it is ready, so the voice never waits for it.
   */
  card?: Promise<Card | null>
  /** Take every card off the screen. */
  clearStage?: boolean
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'get_time',
    description:
      "The current date and time in the user's timezone. Use this before answering anything about today, now, or how long until something.",
    parameters: { type: 'object', properties: {}, required: [] },
    readOnly: true,
  },
  {
    name: 'remember',
    description:
      'Store one durable fact about the user so it survives into later sessions: a preference, a name, an ongoing plan. Store only things worth knowing next week. Never store passing chat or anything the user has asked you not to keep.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'One self-contained sentence, written in the third person about the user.',
        },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'plan', 'person'],
          description: 'What sort of thing this is.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'recall',
    description:
      'Search what you already know about the user. Use it when the answer depends on something they told you before.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are trying to remember about.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'forget',
    description:
      'Delete stored memories matching a description. Use this whenever the user asks you to forget something.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Which memories to remove.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'research',
    description:
      'Hand a question about the world to the research desk, which searches the live web, reads sources, and returns a short brief with the answer, the facts with their dates, and the sources. Use it for anything current or anything you would otherwise be guessing at: news, prices, scores, weather, releases, people, places, products, what something is or how it works today. Pass the whole question in plain words with every detail the user gave. Relay the brief faithfully: keep its numbers and dates exactly, never add facts it does not contain, and if it says something could not be found, say so.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The full question, self-contained, including names, places, and dates the user mentioned.',
        },
      },
      required: ['question'],
    },
    readOnly: true,
  },
  {
    name: 'clear_screen',
    description:
      'Take the research cards off the screen and let your face return to the middle. Call it when the user says they are done with the topic, asks you to close, clear or hide what is on screen, or clearly moves on to something unrelated. It does nothing when no cards are showing, so there is no harm in calling it then.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_timer',
    description:
      'Set a timer that alerts the user when it finishes. Use it for anything like remind me in ten minutes.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How long from now, in seconds.' },
        label: { type: 'string', description: 'A few words about what it is for.' },
      },
      required: ['seconds'],
    },
    client: true,
  },
  {
    name: 'offer_link',
    description:
      'Put a link in front of the user as something they can choose to open. It is never opened for them, so say aloud what it is and let them decide.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'An absolute http or https URL.' },
        title: { type: 'string', description: 'What the link is, in a few words.' },
      },
      required: ['url', 'title'],
    },
    client: true,
  },
]

export const CLIENT_TOOLS = new Set(
  TOOL_SCHEMAS.filter((schema) => schema.client).map((schema) => schema.name),
)

export const READ_ONLY_TOOLS = new Set(
  TOOL_SCHEMAS.filter((schema) => schema.readOnly).map((schema) => schema.name),
)

/** Shape for the OpenRouter/OpenAI `tools` parameter. */
export function toolDefinitions() {
  return TOOL_SCHEMAS.map((schema) => ({
    type: 'function' as const,
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    },
  }))
}

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

// -- Server tools ----------------------------------------------------------

function describeTime(timezone: string): ToolOutcome {
  const now = new Date()
  let formatted: string
  try {
    formatted = now.toLocaleString('en-GB', {
      timeZone: timezone || 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    // An unparseable timezone from the client must not fail the turn.
    formatted = now.toISOString()
  }
  return { ok: true, content: formatted }
}

/**
 * Memory tools, each as one serialised read-modify-write.
 *
 * Going through `store.mutate` rather than `all()` then `save()` is what stops
 * two turns finishing together from overwriting each other's list wholesale.
 */
async function runMemoryTool(
  name: string,
  args: Record<string, unknown>,
  store: MemoryStore,
): Promise<ToolOutcome> {
  if (name === 'remember') {
    const value = text(args, 'text')
    if (!value) return { ok: false, content: 'Nothing was given to remember.' }
    const kind = (text(args, 'kind') || 'fact') as MemoryKind

    return store.mutate<ToolOutcome>((memories) => {
      const { memories: next, result } = remember(memories, kind, value)
      return {
        memories: next,
        result: {
          ok: true,
          content: result.status === 'merged' ? 'Updated what I already knew.' : 'Stored.',
          summary: `Remembered: ${result.memory.text}`,
        } satisfies ToolOutcome,
      }
    })
  }

  if (name === 'recall') {
    const query = text(args, 'query')
    return store.mutate<ToolOutcome>((memories) => {
      const hits = rank(memories, query).slice(0, 5)
      if (!hits.length) {
        return {
          memories,
          result: { ok: true, content: 'Nothing stored about that.' } satisfies ToolOutcome,
        }
      }
      return {
        memories: touch(
          memories,
          hits.map((hit) => hit.memory),
        ),
        result: {
          ok: true,
          content: hits.map((hit) => `- ${hit.memory.text}`).join('\n'),
        } satisfies ToolOutcome,
      }
    })
  }

  if (name === 'forget') {
    const query = text(args, 'query')
    return store.mutate<ToolOutcome>((memories) => {
      const hits = rank(memories, query).slice(0, 5)
      if (!hits.length) {
        return {
          memories,
          result: {
            ok: true,
            content: 'There was nothing stored about that.',
          } satisfies ToolOutcome,
        }
      }
      const doomed = new Set(hits.map((hit) => hit.memory.id))
      return {
        memories: memories.filter((memory) => !doomed.has(memory.id)),
        result: {
          ok: true,
          content: `Forgotten: ${hits.map((hit) => hit.memory.text).join('; ')}`,
          summary: `Forgot ${hits.length} memor${hits.length === 1 ? 'y' : 'ies'}`,
        } satisfies ToolOutcome,
      }
    })
  }

  return { ok: false, content: `Unknown memory tool ${name}.` }
}

/**
 * Delegates a live question to the researcher and shapes its brief for a
 * model that is about to speak.
 *
 * Soft-failing on purpose. Research is the one tool with two external
 * dependencies, and a GIDEON that cannot look something up should say so in a
 * sentence rather than break every turn that touches the outside world.
 */
async function runResearch(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolOutcome> {
  const question = text(args, 'question') || text(args, 'query')
  if (!question) return { ok: false, content: 'No question was given to research.' }

  const deps = defaultDeps(context.env)
  const result = await research(question, { signal: context.signal, timezone: context.timezone }, deps)
  if (!result.ok) {
    return {
      ok: false,
      content: result.brief,
      summary: deps.exaKey ? 'Could not look that up' : 'Research is not set up here',
    }
  }

  const where =
    result.via === 'cache'
      ? 'already had'
      : result.via === 'answer'
        ? 'looked up'
        : `checked ${result.searches} search${result.searches === 1 ? '' : 'es'} for`
  return {
    ok: true,
    content: result.brief,
    summary: `Researched · ${where} "${question.length > 72 ? `${question.slice(0, 70)}…` : question}"`,
    links: result.sources,
    card: buildCard(question, result, cardDeps(context.env), context.signal),
  }
}

export interface ToolContext {
  store: MemoryStore
  /** From the browser, so "today" means the user's today. */
  timezone: string
  signal: AbortSignal
  /** Configuration from the host, which may be a Worker rather than a process. */
  env: EnvReader
}

/** Runs one server-side tool. Client tools never reach this. */
export async function runServerTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolOutcome> {
  switch (name) {
    case 'get_time':
      return describeTime(context.timezone)
    case 'remember':
    case 'recall':
    case 'forget':
      return runMemoryTool(name, args, context.store)
    case 'research':
      return runResearch(args, context)
    case 'clear_screen':
      return {
        ok: true,
        content: 'The screen is clear. Acknowledge it in a few words at most, or simply carry on.',
        clearStage: true,
      }
    default:
      return { ok: false, content: `There is no tool called ${name}.` }
  }
}

/**
 * The memories worth putting in front of the model before it answers.
 *
 * Retrieval runs against the latest user message only. Ranking against the
 * whole history sounds more thorough and is worse: every term in twenty
 * messages dilutes the few that describe what is being asked right now.
 */
export async function contextMemories(
  store: MemoryStore,
  latestUserText: string,
  limit = 4,
): Promise<Memory[]> {
  if (!latestUserText.trim()) return []
  // This runs on every turn, which is exactly why it has to go through the
  // serialised path: it was the most frequent writer, and therefore the one
  // most likely to clobber a fact stored a moment earlier.
  return store.mutate<Memory[]>((memories) => {
    const hits = rank(memories, latestUserText).slice(0, limit)
    if (!hits.length) return { memories, result: [] as Memory[] }
    const used = hits.map((hit) => hit.memory)
    return { memories: touch(memories, used), result: used }
  })
}
