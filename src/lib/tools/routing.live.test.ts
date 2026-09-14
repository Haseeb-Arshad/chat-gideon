import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { streamTurn } from '../agent-core'
import { confusionTable, gates, judge, score, type RoutingOutcome } from './routing'
import { ROUTING_CORPUS, ROUTING_SCREEN, type RoutingCase } from './routing-corpus'
import { EphemeralMemoryStore } from './memory'
import type { ToolName } from './skills'

/**
 * Routing, measured: every sentence in the corpus through the real speaking
 * model, run on purpose with `npm run benchmark:routing`.
 *
 * Only the speaking model is real. Everything a turn might reach for beyond it
 * (the research desk, the picture search, the stage judge) is answered with
 * nothing, so this measures which tools the model calls and nothing else. The
 * tools are read straight off the model's own stream, and the turn is stopped
 * as soon as the round that chose them has finished, so no reply is paid for.
 * Two requests in one sentence may be made over two rounds, and those cases
 * are given both.
 *
 * Skipped in the ordinary suite: it needs OPENROUTER_API_KEY and spends credit,
 * about a quarter of a dollar for the whole corpus at gpt-4.1-mini's prices.
 * Set ROUTING_ONLY to a group (plain, boundary, speech, screen, double) or to
 * part of a sentence to run fewer. The model is temperature 0.9 in production
 * and here, so a run is a sample: read one miss as a question, a pattern as an
 * answer.
 */

const live = import.meta.env.MODE === 'live'
const CONCURRENCY = 3

function loadEnv() {
  if (!existsSync('.env')) return
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at < 1 || line.startsWith('#')) continue
    const name = line.slice(0, at).trim()
    process.env[name] ??= line.slice(at + 1).trim()
  }
}

function report(row: Record<string, unknown>) {
  process.stdout.write(`LIVE ${JSON.stringify(row)}\n`)
}

/** One model round, read as it streams past: the tools it called and with what, what it said, and which model said it. */
interface Round {
  tools: Map<number, string>
  args: Map<number, string>
  text: string
  model: string
}

/** Passes a streamed completion through untouched, and reads the round out of it on the way. */
function watch(round: Round, onEnd: () => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  let pending = ''
  const read = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    try {
      const chunk = JSON.parse(data) as {
        model?: string
        choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> } }>
      }
      if (chunk.model) round.model = chunk.model
      const delta = chunk.choices?.[0]?.delta
      if (delta?.content) round.text += delta.content
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? Math.max(0, round.tools.size - 1)
        if (call.function?.name) round.tools.set(index, call.function.name)
        if (call.function?.arguments) round.args.set(index, (round.args.get(index) ?? '') + call.function.arguments)
      }
    } catch {
      // A keep-alive comment or a partial line; the next chunk completes it.
    }
  }
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      lines.forEach(read)
    },
    flush() {
      read(pending)
      onEnd()
    },
  })
}

interface Turn {
  rounds: Round[]
  /** Called when a round's stream has ended, however it ended. */
  roundEnded: () => void
}

type Routed = RoutingOutcome & { said: string; models: string[] }

/**
 * What a round's calls did. A remember that replaces an old fact has forgotten
 * it too, so it does what a case asking for forget wants; where no case asked,
 * it is still a remember, because the tool only lets a fact about the same
 * thing give way to it.
 */
function effects(round: Round, routingCase: RoutingCase): ToolName[] {
  return [...round.tools].flatMap(([index, name]) => {
    if (name !== 'remember') return [name as ToolName]
    try {
      const args = JSON.parse(round.args.get(index) ?? '{}') as { replaces?: unknown }
      const replaced = typeof args.replaces === 'string' && args.replaces.trim() && routingCase.expect.includes('forget')
      return replaced ? (['remember', 'forget'] as ToolName[]) : (['remember'] as ToolName[])
    } catch {
      return ['remember' as ToolName]
    }
  })
}

async function route(routingCase: RoutingCase, turns: WeakMap<AbortSignal, Turn>): Promise<Routed> {
  const controller = new AbortController()
  let endRound: () => void = () => undefined
  const nextRoundEnd = () => new Promise<void>((resolve) => (endRound = resolve))
  const turn: Turn = { rounds: [], roundEnded: () => endRound() }
  turns.set(controller.signal, turn)

  // Armed before the turn starts, so the first round cannot end unheard.
  let roundEnd = nextRoundEnd()
  const running = (async () => {
    for await (const _frame of streamTurn('routing', [{ role: 'user', content: routingCase.say }], controller.signal, {
      timezone: 'Europe/London',
      // Each sentence starts from a person GIDEON knows nothing about: a memory one case keeps
      // must not answer another's question.
      memoryStore: new EphemeralMemoryStore(),
      ...(routingCase.screen ? { screen: ROUTING_SCREEN } : {}),
    })) {
      // Only the model's stream is read; the frames themselves are not needed.
    }
  })().catch(() => undefined)

  // A second request in the same sentence can come in a second round.
  const roundsAllowed = routingCase.group === 'double' ? 2 : 1
  for (let round = 0; round < roundsAllowed; round += 1) {
    const turnOver = await Promise.race([roundEnd.then(() => false), running.then(() => true)])
    const last = turn.rounds.at(-1)
    if (turnOver || !last || last.tools.size === 0) break
    roundEnd = nextRoundEnd()
  }
  controller.abort()
  await running

  return {
    routingCase,
    called: [...new Set(turn.rounds.flatMap((round) => effects(round, routingCase)))],
    said: turn.rounds
      .map((round) => round.text)
      .join(' ')
      .trim(),
    models: [...new Set(turn.rounds.map((round) => round.model).filter(Boolean))],
  }
}

describe.skipIf(!live)('routing', () => {
  it('sends every sentence in the corpus to the right tool, or to none', { timeout: 1_200_000 }, async () => {
    loadEnv()
    process.env.GIDEON_MEMORY_PATH = 'none'
    // Research is only offered when it could run; offer it, and answer it with nothing.
    process.env.EXA_API_KEY ||= 'routing-probe'
    expect(process.env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY').toBeTruthy()

    const only = process.env.ROUTING_ONLY?.toLowerCase()
    const cases = ROUTING_CORPUS.filter((each) => !only || each.group === only || each.say.toLowerCase().includes(only))

    const turns = new WeakMap<AbortSignal, Turn>()
    const real = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { stream?: boolean }) : {}
      const turn = init?.signal ? turns.get(init.signal) : undefined
      if (url.includes('openrouter.ai') && body.stream === true && turn) {
        const round: Round = { tools: new Map(), args: new Map(), text: '', model: '' }
        turn.rounds.push(round)
        const response = await real(input, init)
        if (!response.ok || !response.body) {
          turn.roundEnded()
          return response
        }
        return new Response(response.body.pipeThrough(watch(round, turn.roundEnded)), { status: response.status, headers: response.headers })
      }
      // Everything else a turn reaches for, answered with nothing: an empty brief, no pictures.
      return Response.json({ choices: [{ message: { content: 'Nothing was found for this routing check.' } }], results: [] })
    }) as typeof fetch

    const outcomes: Routed[] = []
    const startedAt = Date.now()
    try {
      let next = 0
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          while (next < cases.length) {
            const routingCase = cases[next++]
            outcomes.push(await route(routingCase, turns))
          }
        }),
      )
    } finally {
      globalThis.fetch = real
    }

    for (const outcome of outcomes) {
      const verdict = judge(outcome.routingCase, outcome.called)
      if (verdict.correct) continue
      report({
        say: outcome.routingCase.say,
        group: outcome.routingCase.group,
        expected: outcome.routingCase.expect,
        called: outcome.called,
        ...(verdict.missing.length ? { missing: verdict.missing } : {}),
        ...(verdict.extra.length ? { extra: verdict.extra } : {}),
        said: outcome.said.slice(0, 140),
      })
    }
    const models = [...new Set(outcomes.flatMap((outcome) => outcome.models))]
    const result = score(outcomes)
    const checks = gates(result)
    process.stdout.write(
      [
        '',
        `Routing, ${new Date().toISOString().slice(0, 10)}: ${result.correct} of ${result.cases} right (${(result.accuracy * 100).toFixed(1)}%) in ${((Date.now() - startedAt) / 1000).toFixed(0)} s, answered by ${models.join(', ')}`,
        '',
        confusionTable(result),
        '',
        ...checks.map((gate) => `${gate.passed ? 'pass' : 'FAIL'}  ${gate.name}: ${gate.detail}`),
        '',
      ].join('\n'),
    )
    // Soft, so every gate is reported rather than only the first to fail.
    for (const gate of checks) expect.soft(gate.passed, `${gate.name}: ${gate.detail}`).toBe(true)
  })
})
