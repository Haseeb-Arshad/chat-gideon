import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { judgeDeps, judgeScreen, type ScreenState } from './stage-judge'

/**
 * Live checks of the screen judge, run on purpose with `npm run benchmark:judge`.
 *
 * Skipped in the ordinary suite: they spend real tokens. They answer the one
 * question no mock can: does the model tell a follow-up from a change of
 * subject, and notice when the talk comes back to something put away?
 */

const live = import.meta.env.MODE === 'live'

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

const EINSTEIN = { id: 'turn-1:call_0', title: 'Albert Einstein', query: 'Who was Albert Einstein?', kind: 'entity' }
const CAKE = { id: 'turn-2:call_0', title: 'Chocolate layer cake', query: 'Chocolate layer cake', kind: 'gallery' }

type Line = ['user' | 'assistant', string]

const ABOUT_EINSTEIN: Line[] = [
  ['user', 'who was Albert Einstein?'],
  ['assistant', 'A German-born physicist, best known for the theory of relativity.'],
]
const ABOUT_CAKE: Line[] = [
  ['user', 'show me some pictures of chocolate cake'],
  ['assistant', 'Here are some, looking rich and ready to eat.'],
]
const A_JOKE: Line[] = [
  ['user', 'ok, tell me a joke about cats'],
  ['assistant', 'Why did the cat sit on the computer? To keep an eye on the mouse.'],
]

const CASES: Array<{ name: string; screen: ScreenState; talk: Line[]; expected: 'keep' | 'tuck' | 'show' }> = [
  {
    name: 'a follow-up about the open card',
    screen: { open: true, front: EINSTEIN.id, cards: [EINSTEIN] },
    talk: [...ABOUT_EINSTEIN, ['user', 'how old was he when he died?']],
    expected: 'keep',
  },
  {
    name: 'a reaction to the open pictures',
    screen: { open: true, front: CAKE.id, cards: [CAKE] },
    talk: [...ABOUT_CAKE, ['user', 'wow, these look so good']],
    expected: 'keep',
  },
  {
    name: 'a change of subject',
    screen: { open: true, front: EINSTEIN.id, cards: [EINSTEIN] },
    talk: [...ABOUT_EINSTEIN, ['user', 'ok, tell me a joke about cats']],
    expected: 'tuck',
  },
  {
    name: 'asking for put-away pictures again',
    screen: { open: false, front: null, cards: [CAKE] },
    talk: [
      ...ABOUT_CAKE,
      ...A_JOKE,
      ['user', 'go back to the chocolate cake pictures, which one looks the best?'],
    ],
    expected: 'show',
  },
  {
    name: 'coming back to a put-away topic',
    screen: { open: false, front: null, cards: [EINSTEIN, CAKE] },
    talk: [...ABOUT_EINSTEIN, ...ABOUT_CAKE, ...A_JOKE, ['user', 'back to Einstein, where was he born?']],
    expected: 'show',
  },
  {
    name: 'small talk with everything put away',
    screen: { open: false, front: null, cards: [EINSTEIN] },
    talk: [...ABOUT_EINSTEIN, ...A_JOKE, ['user', 'how are you today?']],
    expected: 'keep',
  },
]

describe.skipIf(!live)('live screen judge', () => {
  it('keeps, steps aside and brings back when a person would', { timeout: 120_000 }, async () => {
    loadEnv()
    const deps = judgeDeps((name) => process.env[name]?.trim() || undefined)
    expect(deps.openrouterHeaders, 'OPENROUTER_API_KEY is needed').not.toBeNull()

    const wrong: string[] = []
    for (const { name, screen, talk, expected } of CASES) {
      const startedAt = Date.now()
      let said = ''
      const move = await judgeScreen(
        talk.map(([role, content]) => ({ role, content })),
        screen,
        { ...deps, trace: (content) => (said = content) },
        new AbortController().signal,
      )
      const got = move?.op ?? 'keep'
      report({ name, expected, got, said, ms: Date.now() - startedAt })
      if (got !== expected) wrong.push(`${name}: expected ${expected}, got ${got}`)
    }
    expect(wrong).toEqual([])
  })
})
