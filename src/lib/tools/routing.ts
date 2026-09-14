/**
 * How well the speaking model routes, worked out from what it called.
 *
 * A case is right when every tool it expects was called, and nothing else was
 * but the tools it accepts. Each tool is then scored on its own: its precision
 * is how often a call to it was wanted, its recall how often it was called when
 * it was wanted. A call to a tool that leaves something behind (a memory, a
 * timer, a link) that no one asked for is counted apart, because one of those
 * is worse than any number of slow lookups.
 */

import type { RoutingCase } from './routing-corpus'
import { SIDE_EFFECT_TOOLS, type ToolName } from './skills'

export interface RoutingOutcome {
  routingCase: RoutingCase
  /** Every tool the turn called, in the order it called them. */
  called: ToolName[]
}

export interface Verdict {
  correct: boolean
  /** Expected, and not called. */
  missing: ToolName[]
  /** Called, and neither expected nor accepted. */
  extra: ToolName[]
}

export function judge(routingCase: RoutingCase, called: ToolName[]): Verdict {
  const calledSet = new Set(called)
  const missing = routingCase.expect.filter((tool) => !calledSet.has(tool))
  const extra = [...calledSet].filter((tool) => !routingCase.expect.includes(tool) && !routingCase.accept?.includes(tool))
  return { correct: missing.length === 0 && extra.length === 0, missing, extra }
}

export interface ToolScore {
  /** Called when expected. */
  hits: number
  /** Called when neither expected nor accepted. */
  falseCalls: number
  /** Expected and not called. */
  misses: number
  /** Null when it was never called. */
  precision: number | null
  /** Null when it was never expected. */
  recall: number | null
}

export interface RoutingScore {
  cases: number
  correct: number
  accuracy: number
  tools: Partial<Record<ToolName, ToolScore>>
  /** Tools that leave something behind, called when no one asked. */
  unaskedSideEffects: Array<{ say: string; tool: ToolName }>
  /** The first tool expected, or "none", against what was called instead. */
  confusion: Record<string, Record<string, number>>
}

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole)

export function score(outcomes: RoutingOutcome[]): RoutingScore {
  const tools: Partial<Record<ToolName, ToolScore>> = {}
  const tally = (tool: ToolName) => (tools[tool] ??= { hits: 0, falseCalls: 0, misses: 0, precision: null, recall: null })
  const unaskedSideEffects: RoutingScore['unaskedSideEffects'] = []
  const confusion: RoutingScore['confusion'] = {}
  let correct = 0

  for (const { routingCase, called } of outcomes) {
    const verdict = judge(routingCase, called)
    if (verdict.correct) correct += 1
    for (const tool of routingCase.expect) {
      if (called.includes(tool)) tally(tool).hits += 1
      else tally(tool).misses += 1
    }
    for (const tool of verdict.extra) {
      tally(tool).falseCalls += 1
      if (SIDE_EFFECT_TOOLS.has(tool)) unaskedSideEffects.push({ say: routingCase.say, tool })
    }
    const expected = routingCase.expect[0] ?? 'none'
    // A right answer is on the diagonal whatever order its tools came in; a wrong one is
    // filed under the first tool that should not have been called, or under none.
    const got = verdict.correct ? expected : (verdict.extra[0] ?? 'none')
    confusion[expected] ??= {}
    confusion[expected][got] = (confusion[expected][got] ?? 0) + 1
  }

  for (const each of Object.values(tools)) {
    each.precision = ratio(each.hits, each.hits + each.falseCalls)
    each.recall = ratio(each.hits, each.hits + each.misses)
  }
  return { cases: outcomes.length, correct, accuracy: outcomes.length ? correct / outcomes.length : 0, tools, unaskedSideEffects, confusion }
}

/** What a change to the prompt, a description or the tool list has to meet before it ships. */
export const ROUTING_GATES = { accuracy: 0.95, precision: 0.92, recall: 0.9 } as const

export interface Gate {
  name: string
  passed: boolean
  detail: string
}

const percent = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`)

export function gates(result: RoutingScore): Gate[] {
  const list: Gate[] = [
    {
      name: 'accuracy',
      passed: result.accuracy >= ROUTING_GATES.accuracy,
      detail: `${result.correct} of ${result.cases} right, ${percent(result.accuracy)} against ${percent(ROUTING_GATES.accuracy)}`,
    },
  ]
  for (const [tool, each] of Object.entries(result.tools) as Array<[ToolName, ToolScore]>) {
    if (each.precision !== null) {
      list.push({
        name: `${tool} precision`,
        passed: each.precision >= ROUTING_GATES.precision,
        detail: `${each.hits} wanted of ${each.hits + each.falseCalls} calls, ${percent(each.precision)}`,
      })
    }
    if (each.recall !== null) {
      list.push({
        name: `${tool} recall`,
        passed: each.recall >= ROUTING_GATES.recall,
        detail: `called ${each.hits} of ${each.hits + each.misses} times it was wanted, ${percent(each.recall)}`,
      })
    }
  }
  list.push({
    name: 'no unasked side effects',
    passed: result.unaskedSideEffects.length === 0,
    detail: result.unaskedSideEffects.length ? result.unaskedSideEffects.map(({ say, tool }) => `${tool} for "${say}"`).join('; ') : 'none',
  })
  return list
}

/** The confusion matrix as a table to print: expected down the side, called across the top. */
export function confusionTable(result: RoutingScore): string {
  const names = [...new Set([...Object.keys(result.confusion), ...Object.values(result.confusion).flatMap((row) => Object.keys(row))])].sort((a, b) =>
    a === 'none' ? 1 : b === 'none' ? -1 : a.localeCompare(b),
  )
  const width = Math.max(8, ...names.map((name) => name.length))
  const cell = (text: string) => text.padStart(width)
  const lines = [`${'expected \\ called'.padEnd(width + 10)}${names.map(cell).join(' ')}`]
  for (const expected of names) {
    const row = result.confusion[expected]
    if (!row) continue
    lines.push(`${expected.padEnd(width + 10)}${names.map((got) => cell(row[got] ? String(row[got]) : '.')).join(' ')}`)
  }
  return lines.join('\n')
}
