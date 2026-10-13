import { describe, expect, it } from 'vitest'
import { brief, idleThoughts, nextIdleDelay, pickIdle, workThought, type IdleSources } from './thoughts'

const nothing: IdleSources = { memories: [], topics: [], cards: [], timers: [], now: 1_000_000 }

describe('a thought about work in hand', () => {
  it('is the tool that is running, in the words it was asked with', () => {
    expect(workThought({ phase: 'thinking', action: { name: 'research', detail: 'Who won the 2026 World Cup final and by how much?' }, guessing: false }, 'on'))
      .toEqual({ key: 'work:research:Who won the 2026 World Cup final and by how much?', kind: 'work', icon: 'search', text: 'Who won the 2026 World Cup…' })
    expect(workThought({ phase: 'thinking', action: { name: 'show_images', detail: 'Lahore Fort' }, guessing: false }, 'on'))
      .toMatchObject({ icon: 'picture', text: 'Lahore Fort' })
    expect(workThought({ phase: 'thinking', action: { name: 'recall', detail: '' }, guessing: false }, 'on'))
      .toMatchObject({ icon: 'memory', text: 'what do I know…' })
  })

  it('never writes out what is being remembered or forgotten', () => {
    for (const name of ['remember', 'correct', 'forget', 'recall']) {
      const thought = workThought({ phase: 'thinking', action: { name, detail: 'my address is 14 Canal Road' }, guessing: false }, 'on')
      expect(thought?.icon).toBe('memory')
      expect(thought?.text).not.toContain('Canal')
    }
  })

  it('is three dots while it is only thinking, or already answering a sentence still being said', () => {
    expect(workThought({ phase: 'thinking', action: null, guessing: false }, 'on')).toEqual({ key: 'work:thinking', kind: 'work', icon: 'dots', text: '' })
    expect(workThought({ phase: 'listening', action: null, guessing: true }, 'on')).toMatchObject({ key: 'work:guessing', icon: 'dots' })
    // A guess is only a thought while the person is still talking.
    expect(workThought({ phase: 'speaking', action: null, guessing: true }, 'on')).toBeNull()
  })

  it('is nothing when nothing is in hand, for a tool that shows no cloud, or when thoughts are off', () => {
    expect(workThought({ phase: 'idle', action: null, guessing: false }, 'on')).toBeNull()
    expect(workThought({ phase: 'speaking', action: { name: 'set_timer', detail: '' }, guessing: false }, 'on')).toBeNull()
    expect(workThought({ phase: 'thinking', action: { name: 'research', detail: 'x' }, guessing: false }, 'off')).toBeNull()
  })
})

describe('a thought that arrives by itself', () => {
  it('does not come when there is nothing real to think about', () => {
    expect(idleThoughts(nothing, 'on')).toEqual([])
    expect(pickIdle([], null)).toBeNull()
  })

  it('is drawn only from what GIDEON actually holds', () => {
    const thoughts = idleThoughts({
      memories: ['The dog is called Bruno', 'The user is allergic to peanuts and would like that kept in mind at restaurants'],
      topics: ['the trip to Hunza'],
      cards: ['Eiffel Tower'],
      timers: [{ label: 'tea', fireAt: nothing.now + 125_000 }, { label: '', fireAt: nothing.now - 5 }],
      now: nothing.now,
    }, 'on')
    expect(thoughts.map((thought) => [thought.icon, thought.text])).toEqual([
      ['timer', 'tea · 2 min left'],
      ['topic', 'the trip to Hunza'],
      ['card', 'Eiffel Tower'],
      ['memory', 'The dog is called Bruno'],
      ['memory', 'The user is allergic to…'],
    ])
    expect(thoughts.every((thought) => thought.kind === 'idle')).toBe(true)
    expect(new Set(thoughts.map((thought) => thought.key)).size).toBe(thoughts.length)
  })

  it('keeps what it remembers about the user off a screen others can see', () => {
    const sources = { ...nothing, memories: ['The dog is called Bruno', 'Lives at 14 Canal Road'], topics: ['the trip to Hunza'] }
    const thoughts = idleThoughts(sources, 'private')
    expect(JSON.stringify(thoughts)).not.toMatch(/Bruno|Canal/u)
    expect(thoughts.filter((thought) => thought.icon === 'memory')).toEqual([
      { key: 'idle:memory:private', kind: 'idle', icon: 'memory', text: 'something you told me' },
    ])
    // The conversation itself is already on screen, so its topics still show.
    expect(thoughts.some((thought) => thought.text === 'the trip to Hunza')).toBe(true)
    expect(idleThoughts(sources, 'off')).toEqual([])
  })

  it('does not have the same thought twice running when it has another', () => {
    const thoughts = idleThoughts({ ...nothing, topics: ['one', 'two'] }, 'on')
    for (const roll of [0, 0.3, 0.6, 0.999]) {
      expect(pickIdle(thoughts, thoughts[0].key, () => roll)?.key).toBe(thoughts[1].key)
    }
    // With only one thing to think about, it may think it again.
    expect(pickIdle(thoughts.slice(0, 1), thoughts[0].key)).toBe(thoughts[0])
  })

  it('wanders rarely: not within twenty seconds of going quiet, then well under twice a minute', () => {
    for (const roll of [0, 0.5, 0.999]) {
      expect(nextIdleDelay(true, () => roll)).toBeGreaterThanOrEqual(22_000)
      expect(nextIdleDelay(true, () => roll)).toBeLessThanOrEqual(32_000)
      expect(nextIdleDelay(false, () => roll)).toBeGreaterThanOrEqual(40_000)
      expect(nextIdleDelay(false, () => roll)).toBeLessThanOrEqual(90_000)
    }
  })
})

describe('a few words', () => {
  it('cuts at a word and says that it did', () => {
    expect(brief('Who won the 2026 World Cup final and by how much?')).toBe('Who won the 2026 World Cup…')
    expect(brief('  Lahore   Fort. ')).toBe('Lahore Fort')
    expect(brief('Supercalifragilisticexpialidocious-and-then-some')).toBe('Supercalifragilisticexpialidoc…')
    expect(brief('')).toBe('')
  })

  it('counts a timer down in the unit that fits', () => {
    const at = (ms: number) => idleThoughts({ ...nothing, timers: [{ label: '', fireAt: nothing.now + ms }] }, 'on')[0].text
    expect(at(45_000)).toBe('45s left')
    expect(at(10 * 60_000)).toBe('10 min left')
    expect(at(3 * 3_600_000)).toBe('3 h left')
  })
})
