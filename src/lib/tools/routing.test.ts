import { describe, expect, it } from 'vitest'
import { TOOL_SCHEMAS } from './registry'
import { confusionTable, gates, judge, score, type RoutingOutcome } from './routing'
import { ROUTING_CORPUS, type RoutingCase } from './routing-corpus'
import { SIDE_EFFECT_TOOLS, SKILLS, describeSkill, type SkillManifest, type ToolName } from './skills'

/**
 * The parts of routing that need no model: that every tool the speaking model
 * sees has a manifest saying what it is not for, that the corpus is a fair
 * test, and that the arithmetic the benchmark gates on is right.
 */

const normalised = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

describe('skill manifests', () => {
  it('cover exactly the tools the speaking model is offered', () => {
    expect(Object.keys(SKILLS).sort()).toEqual(TOOL_SCHEMAS.map((schema) => schema.name).sort())
    for (const [name, skill] of Object.entries(SKILLS)) expect(skill.tool).toBe(name)
  })

  it('never send a tool back to itself, and never call a read-only tool one that leaves something behind', () => {
    for (const skill of Object.values(SKILLS)) {
      expect(skill.neverFor.map((each) => each.use), skill.tool).not.toContain(skill.tool)
      expect(skill.counterExamples.map((each) => each.use), skill.tool).not.toContain(skill.tool)
      expect(skill.useWhen.length, skill.tool).toBeGreaterThan(0)
    }
    for (const schema of TOOL_SCHEMAS.filter((each) => each.readOnly)) expect(SIDE_EFFECT_TOOLS.has(schema.name as ToolName), schema.name).toBe(false)
    expect([...SIDE_EFFECT_TOOLS].sort()).toEqual(['correct', 'forget', 'offer_link', 'remember', 'set_timer'])
  })

  it('make every description in the same shape: the job, what for, what never for and instead, then how to speak', () => {
    const skill: SkillManifest = {
      tool: 'show_images',
      job: 'Put pictures on screen.',
      useWhen: ['pictures of something', 'what something looks like'],
      neverFor: [
        { when: 'facts about it', use: 'research' },
        { when: 'a figure of speech', use: null },
      ],
      voice: 'Say one short line.',
      examples: [],
      counterExamples: [],
      sideEffects: false,
    }
    expect(describeSkill(skill)).toBe(
      'Put pictures on screen. Use it for pictures of something; what something looks like. Never use it for facts about it (use research), or a figure of speech (answer without a tool). Say one short line.',
    )
  })
})

describe('the routing corpus', () => {
  it('never repeats a sentence the model has been shown, or itself', () => {
    const shown = new Set(
      [
        ...Object.values(SKILLS).flatMap((skill) => [...skill.examples, ...skill.counterExamples.map((each) => each.text)]),
        // The speaking model's own prompt names these.
        'Who was Marie Curie',
        'tell me about the Eiffel Tower',
        'what is the Great Barrier Reef',
      ].map(normalised),
    )
    const said = ROUTING_CORPUS.map((each) => normalised(each.say))
    expect(said.filter((each) => shown.has(each))).toEqual([])
    expect(said.filter((each, index) => said.indexOf(each) !== index)).toEqual([])
  })

  it('asks for every tool, both sides of a boundary, and nothing when nothing is needed', () => {
    const expectedTimes = (tool: ToolName) => ROUTING_CORPUS.filter((each) => each.expect.includes(tool)).length
    for (const tool of Object.keys(SKILLS) as ToolName[]) {
      // The model is told the time every turn, so the clock is only ever an accepted extra.
      if (tool !== 'get_time') expect(expectedTimes(tool), tool).toBeGreaterThanOrEqual(3)
    }
    const groups = (group: RoutingCase['group']) => ROUTING_CORPUS.filter((each) => each.group === group)
    expect(groups('boundary').every((each) => each.why)).toBe(true)
    expect(groups('speech').every((each) => each.expect.length === 0)).toBe(true)
    expect(groups('screen').every((each) => each.screen && each.expect.length === 0)).toBe(true)
    expect(groups('double').every((each) => each.expect.length === 2)).toBe(true)
    expect(ROUTING_CORPUS.length).toBeGreaterThanOrEqual(100)
  })
})

describe('scoring', () => {
  const routingCase = (say: string, expect: ToolName[], accept?: ToolName[]): RoutingCase => ({ say, expect, group: 'plain', ...(accept ? { accept } : {}) })

  it('is right when every expected tool was called and nothing else but what is accepted', () => {
    expect(judge(routingCase('a', ['research']), ['research'])).toEqual({ correct: true, missing: [], extra: [] })
    expect(judge(routingCase('b', [], ['get_time']), ['get_time'])).toEqual({ correct: true, missing: [], extra: [] })
    expect(judge(routingCase('c', ['set_timer', 'remember']), ['remember'])).toEqual({ correct: false, missing: ['set_timer'], extra: [] })
    expect(judge(routingCase('d', ['show_images']), ['research'])).toEqual({ correct: false, missing: ['show_images'], extra: ['research'] })
  })

  it('scores each tool, keeps side effects no one asked for apart, and gates on all of it', () => {
    const outcomes: RoutingOutcome[] = [
      { routingCase: routingCase('who won', ['research']), called: ['research'] },
      { routingCase: routingCase('how tall', ['research']), called: ['research'] },
      { routingCase: routingCase('show me', ['show_images']), called: ['research'] },
      { routingCase: routingCase('give me a second', []), called: ['set_timer'] },
      { routingCase: routingCase('what time', [], ['get_time']), called: ['get_time'] },
    ]
    const result = score(outcomes)
    expect(result).toMatchObject({ cases: 5, correct: 3, accuracy: 0.6 })
    expect(result.tools.research).toEqual({ hits: 2, falseCalls: 1, misses: 0, precision: 2 / 3, recall: 1 })
    expect(result.tools.show_images).toEqual({ hits: 0, falseCalls: 0, misses: 1, precision: null, recall: 0 })
    // An accepted call is no false call.
    expect(result.tools.get_time).toBeUndefined()
    expect(result.unaskedSideEffects).toEqual([{ say: 'give me a second', tool: 'set_timer' }])
    expect(result.confusion).toEqual({ research: { research: 2 }, show_images: { research: 1 }, none: { set_timer: 1, none: 1 } })

    const failed = gates(result)
      .filter((gate) => !gate.passed)
      .map((gate) => gate.name)
    expect(failed).toEqual(['accuracy', 'research precision', 'show_images recall', 'set_timer precision', 'no unasked side effects'])
    expect(confusionTable(result).split('\n')[0]).toMatch(/^expected \\ called\s+research\s+set_timer\s+show_images\s+none$/)
  })
})
