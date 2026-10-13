import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { illustrationDocument } from './document'
import example from '../../lab/illustration-example.json'
import { readCard } from '../cards/read'

it('keeps the reviewed example readable by the same wire reader', () => {
  expect(readCard(example)).toEqual(example)
})
it('isolates kit identifiers and accepts a solid or a list without changing its geometry', () => {
  const source = illustrationDocument('<svg></svg>', 'Test').match(/<script>([\s\S]*?)document.head/)![1]
  const sandbox = { window: {} as { Anatomy?: { fitProjection: (...args: unknown[]) => unknown; slabOf: (...args: unknown[]) => unknown; solidSvg: (...args: unknown[]) => string } } }
  // Only the trusted vendored kit is executed here, never generated user code.
  runInNewContext(source, sandbox)
  const k = sandbox.window.Anatomy!
  const plan = { x: 0, y: 0, w: 100, d: 60, r: 3 }
  const p = k.fitProjection([[0, 0, 0], [100, 60, 10]], 600, 380)
  const paths = k.slabOf(plan, 0, 10, p)
  expect(k.solidSvg([paths])).toBe(k.solidSvg(paths))
  expect(k.solidSvg(paths)).not.toMatch(/undefined|NaN/)
  expect('iso' in sandbox).toBe(false)
})
