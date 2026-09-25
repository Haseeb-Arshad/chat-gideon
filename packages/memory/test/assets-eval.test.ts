import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { openAssets, SqliteAssetStore, TEXT_DOCUMENT_INTERPRETER, type AssetRecall } from '../src/assets.ts'
import { openMemory } from '../src/core.ts'
import { SqliteMemoryBackend } from '../src/sqlite.ts'
import { fixtureInterpreter, makePng, makeWav, text } from './media-fixtures.ts'

/**
 * Stage 18 matched comparison: the same held-out questions against a
 * text-only memory (what was said in conversation) and the same memory plus
 * consented assets. Retrieval-level and deterministic; image and speech
 * understanding come from labelled fixture interpreters, so this measures
 * the pipeline (reference, time, deletion, restraint), not model quality.
 *
 * Writes docs/memory/reports/stage-18-multimodal-eval.json.
 */

const directory = mkdtempSync(join(tmpdir(), 'gideon-mm-eval-'))
const memoryBackend = new SqliteMemoryBackend({ path: join(directory, 'memory.db') })
const store = new SqliteAssetStore({ path: join(directory, 'assets.db'), objectDir: join(directory, 'objects') })

afterAll(async () => {
  await memoryBackend.close()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

type Expect = { answer: string } | { abstain: true } | { historicalOrAbstain: string }
interface Task { id: string; category: string; question: string; expect: Expect }

it('text-only vs multimodal on matched held-out tasks', async () => {
  const memory = openMemory({ backend: memoryBackend, scopeId: 'eval-user', principalId: 'eval-user' })
  const assets = openAssets({ store, scopeId: 'eval-user', principalId: 'eval-user' })
  for (const modality of ['image', 'document', 'audio'] as const) assets.setConsent(modality, { raw: true, derived: true })
  const vision = fixtureInterpreter('fixture-vision', ['image/png'])
  const asr = fixtureInterpreter('fixture-asr', ['audio/wav'])

  // What the user said in conversation (the text-only arm sees only this).
  await memory.remember({ commandId: 'said-1', text: 'I uploaded my new lease and the insurance policy' })
  await memory.remember({ commandId: 'said-2', text: 'I sent a photo of my living room and one of the garden' })
  await memory.remember({ commandId: 'said-3', text: 'I recorded a voice note about errands but it got cut off' })

  // What the user uploaded (the multimodal arm also sees this).
  await assets.ingest({ assetId: 'lease', bytes: text('Lease agreement.\n\nThe monthly rent is 1450 euros, due on the fifth.\n\nThe deposit is two months of rent.\n\nPets are allowed with written consent.'), contentType: 'text/plain', sourceTime: '2026-06-01T00:00:00Z' })
  await assets.ingest({ assetId: 'insurance', bytes: text('Home insurance policy.\n\nThe excess for water damage is 250 euros.\n\nThe policy renews every March.'), contentType: 'text/markdown', sourceTime: '2026-02-10T00:00:00Z' })
  const room = makePng(6, 6, [60, 120, 60])
  vision.register(room, [{ kind: 'description', text: 'A living room with a green velvet sofa and a tall bookshelf', confidence: 0.74 }])
  await assets.ingest({ assetId: 'living-room', bytes: room, contentType: 'image/png', sourceTime: '2025-11-03T09:00:00Z' })
  const garden = makePng(6, 6, [30, 160, 30])
  vision.register(garden, [{ kind: 'description', text: 'A small garden with a lemon tree in a terracotta pot', confidence: 0.69 }])
  await assets.ingest({ assetId: 'garden', bytes: garden, contentType: 'image/png', sourceTime: '2026-04-12T09:00:00Z' })
  const note = makeWav(6_000, 330, 3_000)
  asr.register(note, [
    { kind: 'transcript', text: 'Pick up the dry cleaning before noon', timeSpan: { startMs: 0, endMs: 2_500 }, confidence: 0.88 },
    { kind: 'transcript', text: 'then renew the parking permit at the council office', timeSpan: { startMs: 3_200, endMs: 6_000 }, confidence: 0.88 },
  ])
  await assets.ingest({ assetId: 'voice-note', bytes: note, contentType: 'audio/wav', sourceTime: '2026-09-20T08:00:00Z' })
  const whiteboard = makePng(6, 6, [250, 250, 250])
  vision.register(whiteboard, [{ kind: 'description', text: 'A whiteboard listing the office wifi password hint', confidence: 0.6 }])
  await assets.ingest({ assetId: 'whiteboard', bytes: whiteboard, contentType: 'image/png', sourceTime: '2026-05-05T09:00:00Z' })
  await assets.processPending(TEXT_DOCUMENT_INTERPRETER)
  await assets.processPending(vision.interpreter)
  await assets.processPending(asr.interpreter)
  assets.deleteAsset('whiteboard')

  const tasks: Task[] = [
    { id: 'doc-rent', category: 'document_reference', question: 'How much is my monthly rent?', expect: { answer: '1450' } },
    { id: 'doc-deposit', category: 'document_reference', question: 'How big is the deposit on my lease?', expect: { answer: 'two months' } },
    { id: 'doc-excess', category: 'document_reference', question: 'What is the excess for water damage on my insurance?', expect: { answer: '250' } },
    { id: 'doc-renewal', category: 'document_reference', question: 'When does my insurance policy renew?', expect: { answer: 'March' } },
    { id: 'img-sofa', category: 'image_reference', question: 'What sofa was in my living room photo?', expect: { answer: 'green velvet' } },
    { id: 'img-tree', category: 'image_reference', question: 'What tree is in the garden photo?', expect: { answer: 'lemon' } },
    { id: 'stale-room', category: 'stale_scene', question: 'What does my living room look like right now?', expect: { historicalOrAbstain: 'sofa' } },
    { id: 'stale-garden', category: 'stale_scene', question: 'Is there a lemon tree in my garden today?', expect: { historicalOrAbstain: 'lemon' } },
    { id: 'audio-heard', category: 'interrupted_audio', question: 'What did my voice note say about dry cleaning?', expect: { answer: 'noon' } },
    { id: 'audio-cut', category: 'interrupted_audio', question: 'What did the voice note say about the parking permit?', expect: { abstain: true } },
    { id: 'neg-capital', category: 'negative_personalization', question: 'What is the capital of Portugal?', expect: { abstain: true } },
    { id: 'neg-maths', category: 'negative_personalization', question: 'What is seventeen times three?', expect: { abstain: true } },
    { id: 'deleted-board', category: 'deleted_asset', question: 'What was on the office whiteboard about the wifi password?', expect: { abstain: true } },
  ]

  const textOnly = async (task: Task) => ({ texts: (await memory.search(task.question, 4)).map((item) => item.text), recalls: [] as AssetRecall[] })
  const multimodal = async (task: Task) => {
    const recalls = assets.recall(task.question, 4)
    return { texts: [...(await memory.search(task.question, 4)).map((item) => item.text), ...recalls.map((item) => item.text)], recalls }
  }

  const grade = (task: Task, evidence: { texts: string[]; recalls: AssetRecall[] }) => {
    const joined = evidence.texts.join('\n').toLocaleLowerCase('en')
    if ('answer' in task.expect) return joined.includes(task.expect.answer.toLocaleLowerCase('en'))
    if ('historicalOrAbstain' in task.expect) {
      const term = task.expect.historicalOrAbstain
      const hits = evidence.recalls.filter((item) => item.text.toLocaleLowerCase('en').includes(term))
      // Either nothing about it, or only evidence labelled as a dated observation (never presented as now).
      return hits.every((item) => item.historicalObservation && /not how things are now/u.test(item.note)) && !evidence.texts.some((textValue) => textValue.includes(term) && !hits.some((hit) => hit.text === textValue))
    }
    // Abstain: no personal content that answers it.
    const forbidden: Record<string, RegExp> = { 'audio-cut': /parking permit/iu, 'neg-capital': /./u, 'neg-maths': /./u, 'deleted-board': /whiteboard|wifi/iu }
    const pattern = forbidden[task.id]!
    return !(task.id.startsWith('neg-') ? evidence.recalls.length > 0 || evidence.texts.length > 0 : evidence.texts.some((textValue) => pattern.test(textValue)))
  }

  const arms = { text_only: textOnly, multimodal }
  const rows: { task: string; category: string; arm: string; passed: boolean; evidence: number }[] = []
  for (const task of tasks) for (const [arm, run] of Object.entries(arms)) {
    const evidence = await run(task)
    rows.push({ task: task.id, category: task.category, arm, passed: grade(task, evidence), evidence: evidence.texts.length })
  }
  const summary = Object.fromEntries(Object.keys(arms).map((arm) => {
    const mine = rows.filter((row) => row.arm === arm)
    const categories = [...new Set(tasks.map((task) => task.category))]
    return [arm, {
      passed: mine.filter((row) => row.passed).length, tasks: mine.length,
      byCategory: Object.fromEntries(categories.map((category) => [category, `${mine.filter((row) => row.category === category && row.passed).length}/${mine.filter((row) => row.category === category).length}`])),
    }]
  }))
  const stale = assets.recall('what does my living room look like right now')[0]
  const report = {
    stage: 18,
    label: 'matched retrieval-level comparison on generated media; image and speech understanding are labelled fixtures, so this measures the pipeline, not a vision or speech model',
    tasks: tasks.length,
    summary,
    rows,
    staleSceneExample: stale ? { text: stale.text, observedAt: stale.observedAt, note: stale.note } : null,
  }
  writeFileSync(resolve(import.meta.dirname, '../../../docs/memory/reports/stage-18-multimodal-eval.json'), `${JSON.stringify(report, null, 2)}\n`)

  expect(summary.multimodal!.passed).toBe(tasks.length)
  expect(summary.text_only!.byCategory.document_reference).toBe('0/4')
  expect(summary.text_only!.byCategory.negative_personalization).toBe('2/2')
  expect(summary.multimodal!.byCategory.negative_personalization).toBe('2/2')
})
