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
  matchesMemory,
  tokenise,
  touch,
  type MemoryKind,
  type RememberRejection,
} from './memory'
import { evaluateGrant, type MemoryAction, type MemorySession } from '../memory'
import { defaultDeps, research, type EnvReader, type ResearchSource } from './research'
import { buildCard, cardDeps, wikipediaImage, type CardDeps } from './card-builder'
import { MIN_PICTURES, findPictures, galleryCard, imageDeps } from './images'
import { cardFromMaterials, describeCard, mergeCards, portraitSubject } from '../cards/from-materials'
import { SKILLS, describeSkill } from './skills'
import { openMeteo, runWeather } from './weather'
import { runMap, withCardMap } from './maps'
import type { CoarseLocation } from '../location'
import { fromLegacy } from '../cards/legacy'
import type { Material } from '../cards/materials'
import type { CardPatch } from '../cards/patch'
import type { CardV2 } from '../cards/schema'

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
  card?: Promise<CardV2 | null>
  /**
   * What grows the card once it is on screen, in order. Only read after the
   * card itself has arrived, and only if it was a card rather than none.
   */
  cardPatches?: AsyncIterable<CardPatch>
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'get_time',
    description: describeSkill(SKILLS.get_time),
    parameters: { type: 'object', properties: {}, required: [] },
    readOnly: true,
  },
  {
    name: 'remember',
    description: describeSkill(SKILLS.remember),
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
        replaces: {
          type: 'string',
          description:
            'Only when the user says a fact about them has changed: a few words naming the old one, such as "where the user lives". What matches it is removed as the new fact is kept.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'recall',
    description: describeSkill(SKILLS.recall),
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
    description: describeSkill(SKILLS.forget),
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
    description: describeSkill(SKILLS.research),
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The full question, self-contained, including names, places, and dates the user mentioned.',
        },
        depth: {
          type: 'string',
          enum: ['deep'],
          description:
            'Only when the user explicitly asked to go deep: "tell me everything", "explain it fully", "the full paper", "in detail", or to go past what a card on screen already shows. Leave it out otherwise.',
        },
      },
      required: ['question'],
    },
    readOnly: true,
  },
  {
    name: 'show_images',
    description: describeSkill(SKILLS.show_images),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'What to picture, in a few words, as specific as the user was, such as "chocolate layer cake" or "Eiffel Tower at night".',
        },
      },
      required: ['query'],
    },
    readOnly: true,
  },
  {
    name: 'weather',
    description: describeSkill(SKILLS.weather),
    parameters: {
      type: 'object',
      properties: {
        place: {
          type: 'string',
          description:
            'The place as the user said it, with its region or country when they gave one, such as "Portland, Oregon". Leave it out for where the user is.',
        },
        day: {
          type: 'string',
          description: "Only when the user asked about a particular day: 'today', 'tomorrow', a weekday, or a date as YYYY-MM-DD.",
        },
        units: {
          type: 'string',
          enum: ['celsius', 'fahrenheit'],
          description: 'Only when the user asked for one, or is known to prefer it.',
        },
      },
      required: [],
    },
    readOnly: true,
  },
  {
    name: 'show_map',
    description: describeSkill(SKILLS.show_map),
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['place', 'route', 'nearby'],
          description: "'place' for where somewhere is; 'route' for the way from one place to another, how long it takes or how far it is; 'nearby' for real places of a kind around a point, found and put on the map, never named from memory.",
        },
        place: {
          type: 'string',
          description: "For 'place': the place's name as the user said it, and after a comma one region or country only when the user gave one, such as \"Springfield, Illinois\". Never add where the user is, or regions you are guessing at. Leave it out for where the user is.",
        },
        from: {
          type: 'string',
          description: "For 'route': where it starts, as the user said it. Leave it out when they did not say, to start from where they are.",
        },
        to: { type: 'string', description: "For 'route': where it ends, as the user said it, with one region or country after a comma only when the user gave one." },
        travel: {
          type: 'string',
          enum: ['driving', 'walking', 'cycling'],
          description: "For 'route': only when the user said how they are going; by car otherwise.",
        },
        category: {
          type: 'string',
          description: "For 'nearby': the common kind of place the user wants, in a word or two, such as \"restaurants\", \"coffee shops\", \"pharmacies\" or \"petrol stations\".",
        },
        near: {
          type: 'string',
          description: "For 'nearby': the place to search around, as the user said it. Leave it out to search near them.",
        },
      },
      required: ['mode'],
    },
    readOnly: true,
  },
  {
    name: 'set_timer',
    description: describeSkill(SKILLS.set_timer),
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
    description: describeSkill(SKILLS.offer_link),
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

/** Replacement requires a unique selector or a unique subject shared with the new fact. */
function outdatedBy(memories: Memory[], replaces: string, fact: string): Set<string> {
  const exact = memories.filter((memory) => matchesMemory(memory.text, replaces))
  if (exact.length) return new Set(exact.length === 1 ? [exact[0].id] : [])
  const about = new Set(tokenise(fact).filter((term) => term !== 'user'))
  const shared = tokenise(replaces).filter((term) => term !== 'user' && about.has(term))
  if (!shared.length) return new Set()
  const hits = memories.filter((memory) => {
    const terms = new Set(tokenise(memory.text))
    return shared.every((term) => terms.has(term))
  })
  return new Set(hits.length === 1 ? [hits[0].id] : [])
}

/**
 * Memory tools, each as one serialised read-modify-write.
 *
 * Going through `store.mutate` rather than `all()` then `save()` is what stops
 * two turns finishing together from overwriting each other's list wholesale.
 */
function rememberRejection(reason: RememberRejection): ToolOutcome {
  if (reason === 'capacity') {
    return {
      ok: false,
      content: 'I could not store that because memory capacity is full, so the new fact was not retained.',
      summary: 'Memory was not stored: capacity reached',
    }
  }
  if (reason === 'too_long') {
    return {
      ok: false,
      content: 'I could not store that because a memory is limited to 240 characters, and nothing was truncated.',
      summary: 'Memory was not stored: text too long',
    }
  }
  return { ok: false, content: 'Nothing was given to remember.' }
}

function memoryStorageFailure(name: string): ToolOutcome {
  if (name === 'remember') {
    return {
      ok: false,
      content: 'I could not store that because durable memory rejected the write. Nothing was confirmed as stored.',
      summary: 'Memory was not stored',
    }
  }
  if (name === 'forget') {
    return {
      ok: false,
      content: 'I could not forget that because durable memory rejected the change. Nothing was confirmed as forgotten.',
      summary: 'Memory was not forgotten',
    }
  }
  return {
    ok: false,
    content: 'I could not read stored memory because durable memory is unavailable.',
    summary: 'Memory could not be read',
  }
}

async function runMemoryToolUnsafe(
  name: string,
  args: Record<string, unknown>,
  store: MemoryStore,
): Promise<ToolOutcome> {
  if (name === 'remember') {
    const value = text(args, 'text')
    if (!value) return { ok: false, content: 'Nothing was given to remember.' }
    const kind = (text(args, 'kind') || 'fact') as MemoryKind
    // A fact that has changed is one act to the person saying it ("I live in
    // Leeds now"), and the old one must not stay behind to be recalled later.
    const replaces = text(args, 'replaces')

    return store.mutate<ToolOutcome>((memories) => {
      const outdated = replaces ? outdatedBy(memories, replaces, value) : new Set<string>()
      const { memories: next, result } = remember(
        memories.filter((memory) => !outdated.has(memory.id)),
        kind,
        value,
      )
      if (result.status === 'rejected') {
        return { memories, result: rememberRejection(result.reason) }
      }
      const replaced = outdated.size ? `Replaced ${outdated.size} older memor${outdated.size === 1 ? 'y' : 'ies'}. ` : ''
      return {
        memories: next,
        result: {
          ok: true,
          content: `${replaced}${result.status === 'merged' ? 'Updated what I already knew.' : 'Stored.'}`,
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
    if (!query) return { ok: false, content: 'Nothing was given to forget.' }
    return store.mutate<ToolOutcome>((memories) => {
      // Forgetting is destructive, so it takes exact-word certainty: every
      // meaningful word of the query must appear in the memory. Ranking is for
      // recall, where a wrong hit costs a sentence; here it would delete a
      // fact because it shared "the user" with the question. Overlapping
      // phrasings ("allergic to peanuts" vs "allergic to shellfish") stay
      // distinct, so one ask removes one thing.
      const hits = memories.filter((memory) => matchesMemory(memory.text, query))
      if (!hits.length) {
        return {
          memories,
          result: {
            ok: true,
            content: 'There was nothing stored about that.',
          } satisfies ToolOutcome,
        }
      }
      const doomed = new Set(hits.map((hit) => hit.id))
      return {
        memories: memories.filter((memory) => !doomed.has(memory.id)),
        result: {
          ok: true,
          content: `Forgotten: ${hits.map((hit) => hit.text).join('; ')}`,
          summary: `Forgot ${hits.length} memor${hits.length === 1 ? 'y' : 'ies'}`,
        } satisfies ToolOutcome,
      }
    })
  }

  return { ok: false, content: `Unknown memory tool ${name}.` }
}

/** Storage failures are failed receipts, not stream-level exceptions. */
async function runMemoryTool(
  name: string,
  args: Record<string, unknown>,
  store: MemoryStore,
): Promise<ToolOutcome> {
  try {
    return await runMemoryToolUnsafe(name, args, store)
  } catch {
    return memoryStorageFailure(name)
  }
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
  const deep = args.depth === 'deep'

  const deps = defaultDeps(context.env)
  const result = await research(question, { signal: context.signal, timezone: context.timezone, ...(deep ? { depth: 'deep' as const } : {}) }, deps)
  if (!result.ok) {
    return {
      ok: false,
      content: result.brief,
      summary: deps.exaKey ? 'Could not look that up' : 'Research is not set up here',
    }
  }

  // The question itself travels as the action's detail, so this only says how.
  const how =
    result.via === 'cache'
      ? 'From a recent search'
      : result.via === 'answer'
        ? 'One quick search'
        : `${result.searches} search${result.searches === 1 ? '' : 'es'}`

  const cards = cardDeps(context.env)
  // A card about a place gets the place on a map, when maps are set up.
  const mapped = (card: CardV2): Promise<CardV2> => {
    const publicToken = context.env('MAPBOX_PUBLIC_TOKEN')?.trim() ?? ''
    if (!publicToken) return Promise.resolve(card)
    const fetcher = (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)
    return withCardMap(
      card,
      question,
      result.materials,
      { fetch: fetcher, publicToken, serverToken: context.env('MAPBOX_SERVER_TOKEN')?.trim() || publicToken, now: Date.now },
      openMeteo({ fetch: fetcher, now: Date.now }),
      { signal: context.signal, timezone: context.timezone, location: context.location ?? null },
    ).catch(() => card)
  }
  const drawn = cardFromMaterials(question, result.materials, Date.now())
  if (!drawn) {
    const written = buildCard(question, result, cards, context.signal, deep).then((card) => (card ? mapped(fromLegacy(card, deep ? 'wide' : undefined)) : null))
    // A deep brief is long so the card can be full, not so the voice can read it all.
    const content = deep
      ? `${result.brief}

All of this is going onto a card on the user's screen. Say only the heart of it, in under sixty words, and leave the detail to the card.`
      : result.brief
    return { ok: true, content, summary: how, links: result.sources, card: written }
  }
  const content = `${result.brief}\n\nOn the user's screen now: ${describeCard(drawn)}. Refer to it rather than reading it out.`

  // A card drawn complete, such as a front page, has nothing a model's card could add.
  if (!drawn.partial) {
    return { ok: true, content, summary: how, links: result.sources, card: mapped(drawn) }
  }
  const written = buildCard(question, result, cards, context.signal, deep).then((card) => (card ? fromLegacy(card) : null))

  // Drawn from the desk's data, the card is ready as soon as the brief is; the
  // model's card, a few seconds behind, adds its sentence to it as a patch.
  const card = withPortrait(drawn, result.materials, cards).then(mapped)
  return {
    ok: true,
    content,
    summary: how,
    links: result.sources,
    card,
    cardPatches: (async function* () {
      const [shown, other] = await Promise.all([card, written])
      yield mergeCards(shown, other)
    })(),
  }
}

/** How long a card drawn from data waits for its subject's portrait before going without. */
const PORTRAIT_WAIT_MS = 3_000

/**
 * The card with its subject's portrait, when it is about one subject with a
 * Wikipedia article. The title comes from the subject's own record, so the
 * picture is of the right person rather than of whoever a guessed title finds.
 */
async function withPortrait(card: CardV2, materials: Material[], deps: CardDeps): Promise<CardV2> {
  const subject = portraitSubject(card, materials)
  if (!subject) return card
  const image = await wikipediaImage(subject, deps, AbortSignal.timeout(PORTRAIT_WAIT_MS)).catch(() => null)
  return image ? { ...card, blocks: [{ id: 'media', slot: 'media', type: 'media', image }, ...card.blocks] } : card
}

/**
 * Finds pictures and puts them on screen as a gallery.
 *
 * The speaking model is told what is showing and from where, and asked for one
 * line about it: nine photographs described aloud one by one would be a minute
 * of someone reading a screen the user can already see.
 */
async function runShowImages(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolOutcome> {
  const query = text(args, 'query') || text(args, 'question')
  if (!query) return { ok: false, content: 'No query was given for the pictures.' }

  const pictures = await findPictures(query, imageDeps(context.env), context.signal)
  if (pictures.length < MIN_PICTURES) {
    return {
      ok: false,
      content: `No good pictures of ${query} could be found right now. Say so in one short sentence, and do not offer a link instead.`,
      summary: 'Could not find pictures',
    }
  }

  const hosts = [...new Set(pictures.map((picture) => picture.host))]
  const pages = [...new Map(pictures.map((picture) => [picture.pageUrl, picture])).values()]
  return {
    ok: true,
    content: `${pictures.length} pictures of ${query} are on the user's screen now, from ${hosts.slice(0, 3).join(', ')}. Say one short, natural line about them. Do not describe them one by one, and do not read out where they came from.`,
    summary: `${pictures.length} pictures`,
    links: pages.slice(0, 6).map((picture) => ({ title: picture.alt, url: picture.pageUrl })),
    card: Promise.resolve(galleryCard(query, pictures)),
  }
}

export interface ToolContext {
  store: MemoryStore
  /** Server-bound identity and grants. Model arguments cannot construct this. */
  session?: MemorySession<MemoryStore>
  /** From the browser, so "today" means the user's today. */
  timezone: string
  signal: AbortSignal
  /** Configuration from the host, which may be a Worker rather than a process. */
  env: EnvReader
  /** Roughly where the user is, when the host knows. */
  location?: CoarseLocation | null
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
      if (context.session) {
        const action = name as MemoryAction
        const decision = evaluateGrant(context.session, action)
        if (!decision.allowed) return { ok: false, content: decision.failure.message, summary: 'Memory operation was not authorized' }
        return runMemoryTool(name, args, context.session.store)
      }
      // Compatibility for existing unit/baseline adapters. Production hosts
      // bind a session before model-visible memory tools are reached.
      return runMemoryTool(name, args, context.store)
    case 'research':
      return runResearch(args, context)
    case 'show_images':
      return runShowImages(args, context)
    case 'weather':
      return runWeather(
        args,
        { signal: context.signal, timezone: context.timezone, location: context.location ?? null, publicToken: context.env('MAPBOX_PUBLIC_TOKEN')?.trim() || undefined },
        // Read at the call, so a test that replaces fetch is the fetch the provider uses.
        openMeteo({ fetch: (input, init) => globalThis.fetch(input, init), now: Date.now }),
        Date.now(),
      )
    case 'show_map': {
      const publicToken = context.env('MAPBOX_PUBLIC_TOKEN')?.trim() ?? ''
      return runMap(
        args,
        { signal: context.signal, timezone: context.timezone, location: context.location ?? null },
        {
          fetch: (input, init) => globalThis.fetch(input, init),
          publicToken,
          // The secret token stays on the server: only the public one is ever put on a card.
          serverToken: context.env('MAPBOX_SERVER_TOKEN')?.trim() || publicToken,
          now: Date.now,
        },
        openMeteo({ fetch: (input, init) => globalThis.fetch(input, init), now: Date.now }),
      )
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
  readOnly = false,
): Promise<Memory[]> {
  if (!latestUserText.trim()) return []
  if (readOnly) return rank(await store.all(), latestUserText).slice(0, limit).map((hit) => hit.memory)
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
