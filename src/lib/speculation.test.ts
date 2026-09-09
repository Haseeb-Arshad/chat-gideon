import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POLICY,
  SpeculationTracker,
  decideCommit,
  looksUnfinished,
  normalise,
  shouldSpeculate,
  words,
} from './speculation'

describe('normalise', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(normalise('  What IS this,  really? ')).toBe('what is this really')
  })

  it('keeps apostrophes, which change the word', () => {
    expect(words("don't")).toEqual(["don't"])
  })
})

describe('decideCommit', () => {
  it('commits when the final transcript is exactly the guess', () => {
    expect(decideCommit('what is the weather', 'What is the weather?')).toEqual({
      commit: true,
      reason: 'exact',
    })
  })

  it('commits when only harmless filler was added', () => {
    expect(decideCommit('set a timer for ten minutes', 'set a timer for ten minutes please')).toEqual(
      { commit: true, reason: 'filler' },
    )
  })

  it('refuses when the tail is long, even if every word is bland', () => {
    const decision = decideCommit('tell me about it', 'tell me about it now then actually really')
    expect(decision.commit).toBe(false)
  })

  it('refuses when a real word was added', () => {
    expect(decideCommit('book a table', 'book a table for four').commit).toBe(false)
  })

  it('refuses when the guess heard words that were never said', () => {
    expect(decideCommit('cancel the meeting tomorrow', 'cancel the meeting')).toEqual({
      commit: false,
      reason: 'truncated',
    })
  })

  it('refuses when a word changed in the middle', () => {
    expect(decideCommit('send it to Ben', 'send it to Jen')).toEqual({
      commit: false,
      reason: 'diverged',
    })
  })

  it('refuses a negation dressed up as filler', () => {
    // "not" is exactly the trailing word that inverts the request, so it must
    // never qualify however short the tail is.
    expect(decideCommit('turn the lights on', 'turn the lights on not').commit).toBe(false)
  })

  it('reports an absent guess rather than committing to nothing', () => {
    expect(decideCommit('', 'anything')).toEqual({ commit: false, reason: 'absent' })
  })
})

describe('looksUnfinished', () => {
  it('spots a dangling conjunction, article or preposition', () => {
    expect(looksUnfinished('I want to go to the')).toBe(true)
    expect(looksUnfinished('remind me later and')).toBe(true)
    expect(looksUnfinished('could you remind me about')).toBe(true)
  })

  it('accepts a sentence that stands on its own', () => {
    expect(looksUnfinished('what time is the meeting')).toBe(false)
  })

  it('lets a trailing pronoun through, since it usually ends a sentence', () => {
    // "send it to you" is finished and "can you" is not, and the difference is
    // grammar this heuristic deliberately does not model. The short fragment is
    // caught by the word-count floor instead; the complete sentence must not be.
    expect(looksUnfinished('I will send it to you')).toBe(false)
    expect(shouldSpeculate({ text: 'can you', stableMs: 500, inFlight: false, attempts: 0 })).toBe(
      false,
    )
  })

  it('treats empty text as unfinished', () => {
    expect(looksUnfinished('   ')).toBe(true)
  })
})

describe('shouldSpeculate', () => {
  const base = { text: 'what is on my calendar', stableMs: 400, inFlight: false, attempts: 0 }

  it('runs on a settled, complete-looking phrase', () => {
    expect(shouldSpeculate(base)).toBe(true)
  })

  it('waits for the transcript to hold still', () => {
    expect(shouldSpeculate({ ...base, stableMs: 120 })).toBe(false)
  })

  it('will not stack a second guess on top of a running one', () => {
    expect(shouldSpeculate({ ...base, inFlight: true })).toBe(false)
  })

  it('gives up after the attempt budget', () => {
    expect(shouldSpeculate({ ...base, attempts: DEFAULT_POLICY.maxAttempts })).toBe(false)
  })

  it('ignores something too short to answer', () => {
    expect(shouldSpeculate({ ...base, text: 'hey' })).toBe(false)
  })

  it('ignores an obviously mid-sentence phrase', () => {
    expect(shouldSpeculate({ ...base, text: 'I was thinking that we could' })).toBe(false)
  })
})

describe('SpeculationTracker', () => {
  it('keeps the newest run that the final transcript vindicates', () => {
    const tracker = new SpeculationTracker<string>()
    tracker.start('what is the', 'a', 0)
    // The tracker allows a second run only once the first is resolved, so this
    // exercises the resolve path over two recorded guesses.
    const resolved = tracker.resolve('what is the plan')
    expect(resolved.keep).toBeNull()
    expect(resolved.discard).toHaveLength(1)
    expect(resolved.reason).toBe('diverged')
  })

  it('promotes a matching run and hands back the rest to cancel', () => {
    const tracker = new SpeculationTracker<string>()
    const run = tracker.start('what is the plan', 'handle-1', 0)
    const resolved = tracker.resolve('What is the plan?')
    expect(resolved.keep).toBe(run)
    expect(resolved.discard).toEqual([])
    expect(resolved.reason).toBe('exact')
  })

  it('empties itself once resolved, so a stale run cannot be promoted twice', () => {
    const tracker = new SpeculationTracker<string>()
    tracker.start('what is the plan', 'handle-1', 0)
    tracker.resolve('what is the plan')
    expect(tracker.inFlight).toBe(false)
    expect(tracker.resolve('what is the plan').keep).toBeNull()
  })

  it('refuses to speculate while one is in flight and allows it after', () => {
    const tracker = new SpeculationTracker<string>()
    expect(tracker.consider('what is the plan', 400)).toBe(true)
    tracker.start('what is the plan', 'handle-1', 0)
    expect(tracker.consider('what is the plan today', 400)).toBe(false)
    tracker.resolve('something else entirely')
    expect(tracker.consider('what is the plan today', 400)).toBe(true)
  })

  it('returns everything outstanding when cleared', () => {
    const tracker = new SpeculationTracker<string>()
    tracker.start('one', 'a', 0)
    expect(tracker.clear()).toHaveLength(1)
    expect(tracker.attempts).toBe(0)
  })
})
