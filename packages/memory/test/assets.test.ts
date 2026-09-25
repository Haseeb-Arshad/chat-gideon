import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openAssets, SqliteAssetStore, sniff, TEXT_DOCUMENT_INTERPRETER, wavDuration } from '../src/assets.ts'
import { MemoryError } from '../src/contract.ts'
import { fixtureInterpreter, makePng, makeWav, text } from './media-fixtures.ts'

const directory = mkdtempSync(join(tmpdir(), 'gideon-assets-'))
const objectDir = join(directory, 'objects')
const store = new SqliteAssetStore({ path: join(directory, 'assets.db'), objectDir, limits: { image: 200_000, document: 50_000, audio: 400_000, scopeBytes: 600_000 } })
let scopes = 0
const fresh = () => openAssets({ store, scopeId: `assets-${(scopes += 1)}`, principalId: `assets-${scopes}` })
const all = { raw: true, derived: true }
const vision = fixtureInterpreter('fixture-vision', ['image/png'])
const asr = fixtureInterpreter('fixture-asr', ['audio/wav'])

afterAll(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

async function code(work: () => unknown): Promise<string> {
  try {
    await work()
    return 'ok'
  } catch (error) {
    if (error instanceof MemoryError) return error.code
    throw error
  }
}

describe('consent per modality', () => {
  it('keeps nothing without consent, and text consent never implies media consent', async () => {
    const assets = fresh()
    expect(assets.consent('image')).toEqual({ raw: false, derived: false, embeddings: false, retentionDays: null })
    expect(await code(() => assets.ingest({ bytes: makePng(2, 2, [0, 0, 255]), contentType: 'image/png' }))).toBe('unauthorized')
    expect(await code(() => assets.setConsent('image', { raw: true, derived: true, embeddings: true }))).toBe('unsupported')
    assets.setConsent('document', all)
    expect(assets.consent('image').raw).toBe(false)
  })

  it('raw-only keeps the bytes and derives nothing; derived-only reads now and keeps no bytes', async () => {
    const assets = fresh()
    assets.setConsent('document', { raw: true, derived: false })
    const rawOnly = await assets.ingest({ bytes: text('The lease starts in March.'), contentType: 'text/plain' })
    expect(rawOnly).toMatchObject({ rawRetained: true, derivation: 'not_consented' })
    expect(assets.recall('lease starts')).toEqual([])
    assets.setConsent('document', { raw: false, derived: true })
    const derivedOnly = await assets.ingest({ bytes: text('Warranty: two years on parts and labour.'), contentType: 'text/plain' }, { interpreter: TEXT_DOCUMENT_INTERPRETER })
    expect(derivedOnly).toMatchObject({ rawRetained: false, derivation: 'completed' })
    const [hit] = assets.recall('warranty parts labour')
    expect(hit).toMatchObject({ kind: 'text', historicalObservation: true, sourceAvailable: false, producer: 'text-document-reader' })
    expect(hit!.note).toMatch(/cannot be re-checked/u)
    expect(await code(() => assets.fetchSource(derivedOnly.assetId, 1))).toBe('unavailable')
    // Withdrawing raw consent removed the earlier raw-only bytes too.
    expect(await code(() => assets.fetchSource(rawOnly.assetId, 1))).toBe('unavailable')
  })
})

describe('upload boundaries', () => {
  it('refuses URLs, type mismatches, unsupported types, oversize files and a full budget', async () => {
    const assets = fresh()
    assets.setConsent('image', all)
    assets.setConsent('document', all)
    expect(await code(() => assets.ingest({ url: 'http://example.com/a.png', bytes: makePng(1, 1, [0, 0, 0]), contentType: 'image/png' } as never))).toBe('validation')
    expect(await code(() => assets.ingest({ bytes: makePng(1, 1, [0, 0, 0]), contentType: 'image/jpeg' }))).toBe('validation')
    expect(await code(() => assets.ingest({ bytes: text('GIF89a'), contentType: 'image/gif' }))).toBe('unsupported')
    expect(await code(() => assets.ingest({ bytes: text('x'.repeat(60_000)), contentType: 'text/plain' }))).toBe('quota')
    expect(sniff(text('%PDF-1.7 minimal'), 'application/pdf')).toBe(true)
    expect(sniff(Uint8Array.from([0, 1, 2]), 'text/plain')).toBe(false)
  })
})

describe('derived evidence and time', () => {
  it('C35: an image description is a dated observation of that revision, not the room today', async () => {
    const assets = fresh()
    assets.setConsent('image', all)
    const photo = makePng(4, 4, [120, 90, 60])
    vision.register(photo, [{ kind: 'description', text: 'A living room with a green sofa under the window', region: { x: 0.1, y: 0.5, w: 0.6, h: 0.4 }, confidence: 0.72 }])
    const first = await assets.ingest({ assetId: 'living-room', bytes: photo, contentType: 'image/png', sourceTime: '2025-03-02T10:00:00Z' })
    expect(first.derivation).toBe('queued')
    expect(await assets.processPending(vision.interpreter)).toMatchObject({ committed: 1 })
    const [hit] = assets.recall('what colour is my sofa')
    expect(hit).toMatchObject({ assetId: 'living-room', revision: 1, historicalObservation: true, observedAt: '2025-03-02T10:00:00.000Z', producer: 'fixture-vision', supersededByRevision: null, region: { x: 0.1, y: 0.5, w: 0.6, h: 0.4 } })
    expect(hit!.note).toMatch(/model.s description of an image captured 2025-03-02 .* not how things are now/u)
    // A new photo is a new revision; the old description now says it has been superseded.
    await assets.ingest({ assetId: 'living-room', bytes: makePng(4, 4, [20, 20, 200]), contentType: 'image/png', sourceTime: '2026-09-20T10:00:00Z' })
    expect(assets.recall('green sofa')[0]).toMatchObject({ revision: 1, supersededByRevision: 2 })
    expect(assets.fetchSource('living-room', 1).bytes).toEqual(photo)
  })

  it('C01/C17: "the picture you showed me" resolves to the revision on screen; a display never issued is refused', async () => {
    const assets = fresh()
    assets.setConsent('image', { raw: true, derived: false })
    await assets.ingest({ assetId: 'plan', bytes: makePng(2, 2, [1, 2, 3]), contentType: 'image/png' })
    assets.recordDisplay({ conversationId: 'conv-1', displayRevision: 4, assetId: 'plan', revision: 1 })
    await assets.ingest({ assetId: 'plan', bytes: makePng(2, 2, [9, 9, 9]), contentType: 'image/png' })
    expect(assets.resolveDisplay('conv-1', 4)).toEqual({ status: 'resolved', assetId: 'plan', revision: 1, newerRevision: 2 })
    expect(await code(() => assets.resolveDisplay('conv-1', 5))).toBe('not_found')
    expect(await code(() => assets.recordDisplay({ conversationId: 'conv-1', displayRevision: 6, assetId: 'plan', revision: 9 }))).toBe('not_found')
  })

  it('C16: an interrupted recording is transcribed only for what arrived', async () => {
    const assets = fresh()
    assets.setConsent('audio', all)
    const cut = makeWav(6_000, 440, 2_500)
    expect(wavDuration(cut)).toEqual({ declaredMs: 6_000, receivedMs: 2_500, truncated: true })
    asr.register(cut, [
      { kind: 'transcript', text: 'Book the dentist for Tuesday', timeSpan: { startMs: 0, endMs: 2_000 }, confidence: 0.9 },
      { kind: 'transcript', text: 'and cancel the gym membership', timeSpan: { startMs: 2_000, endMs: 4_000 }, confidence: 0.9 },
      { kind: 'transcript', text: 'also call my sister tonight', timeSpan: { startMs: 4_000, endMs: 6_000 }, confidence: 0.9 },
    ])
    await assets.ingest({ bytes: cut, contentType: 'audio/wav' })
    await assets.processPending(asr.interpreter)
    expect(assets.recall('dentist Tuesday')[0]!.timeSpan).toEqual({ startMs: 0, endMs: 2_000 })
    expect(assets.recall('gym membership')[0]!.timeSpan).toEqual({ startMs: 2_000, endMs: 2_500 })
    expect(assets.recall('call my sister tonight')).toEqual([])
  })

  it('an interpreter claims only the uploads it can read; the others wait for theirs', async () => {
    const assets = fresh()
    assets.setConsent('image', all)
    assets.setConsent('document', all)
    const photo = makePng(3, 2, [1, 200, 1])
    vision.register(photo, [{ kind: 'description', text: 'A blue kayak on a trailer', confidence: 0.8 }])
    await assets.ingest({ bytes: photo, contentType: 'image/png' })
    await assets.ingest({ bytes: text('The kayak club meets on Sundays.'), contentType: 'text/plain' })
    expect(await assets.processPending(TEXT_DOCUMENT_INTERPRETER)).toMatchObject({ committed: 1, skipped: 0 })
    expect(await assets.processPending(vision.interpreter)).toMatchObject({ committed: 1 })
    expect(assets.recall('blue kayak trailer').map((item) => item.kind)).toContain('description')
  })

  it('a provider outage leaves the upload uninterpreted and says so, then gives up after three tries', async () => {
    const assets = fresh()
    assets.setConsent('image', all)
    const photo = makePng(3, 3, [5, 5, 5])
    vision.register(photo, [{ kind: 'description', text: 'A red bicycle by a door', confidence: 0.8 }])
    await assets.ingest({ bytes: photo, contentType: 'image/png' })
    vision.control.fail = true
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) expect(await assets.processPending(vision.interpreter)).toMatchObject({ failed: 1 })
      expect(await assets.processPending(vision.interpreter)).toMatchObject({ failed: 0, committed: 0 })
    } finally {
      vision.control.fail = false
    }
    expect(assets.recall('red bicycle')).toEqual([])
  })
})

describe('deletion and isolation', () => {
  it('C22: deleting during a parse removes the bytes and the parse cannot recreate derivatives', async () => {
    const assets = fresh()
    assets.setConsent('image', all)
    const photo = makePng(5, 5, [200, 10, 10])
    vision.register(photo, [{ kind: 'description', text: 'A whiteboard with the launch date written on it', confidence: 0.7 }])
    const saved = await assets.ingest({ bytes: photo, contentType: 'image/png' })
    let release: () => void = () => undefined
    vision.control.gate = new Promise((resolve) => { release = resolve })
    const parsing = assets.processPending(vision.interpreter)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const before = readdirSync(objectDir).length
    expect(assets.deleteAsset(saved.assetId)).toMatchObject({ revisions: 1, rawFiles: 1 })
    expect(readdirSync(objectDir).length).toBe(before - 1)
    release()
    vision.control.gate = null
    expect(await parsing).toMatchObject({ stale: 1, committed: 0 })
    expect(assets.recall('whiteboard launch date')).toEqual([])
    expect(await code(() => assets.fetchSource(saved.assetId, 1))).toBe('not_found')
    expect(assets.exportAll({ includeRaw: true }).assets).toEqual([])
    expect(await code(() => assets.ingest({ assetId: saved.assetId, bytes: photo, contentType: 'image/png' }))).toBe('suppressed')
  })

  it('withdrawing derived consent removes descriptions; retention removes old bytes', async () => {
    const assets = fresh()
    assets.setConsent('document', { raw: true, derived: true, retentionDays: 30 })
    await assets.ingest({ bytes: text('Invoice 42 is due on the first of the month.'), contentType: 'text/plain' })
    await assets.processPending(TEXT_DOCUMENT_INTERPRETER)
    expect(assets.recall('invoice due')).toHaveLength(1)
    expect(assets.applyRetention(new Date(Date.now() + 31 * 86_400_000))).toBe(1)
    expect(assets.recall('invoice due')[0]!.sourceAvailable).toBe(false)
    expect(assets.setConsent('document', { raw: false, derived: false })).toMatchObject({ purgedDerived: 1 })
    expect(assets.recall('invoice due')).toEqual([])
  })

  it('C24: another principal or scope gets no asset, description or source', async () => {
    const owner = fresh()
    owner.setConsent('document', all)
    const saved = await owner.ingest({ bytes: text('My passport expires in 2031.'), contentType: 'text/plain' })
    await owner.processPending(TEXT_DOCUMENT_INTERPRETER)
    const intruder = openAssets({ store, scopeId: owner.scopeId, principalId: 'someone-else' })
    expect(await code(() => intruder.recall('passport expires'))).toBe('unauthorized')
    const other = fresh()
    expect(other.recall('passport expires')).toEqual([])
    expect(await code(() => other.fetchSource(saved.assetId, 1))).toBe('not_found')
    expect(other.exportAll().assets).toEqual([])
  })

  it('exports derived text only under derived consent, and raw bytes only when asked and kept', async () => {
    const assets = fresh()
    assets.setConsent('document', all)
    await assets.ingest({ bytes: text('Wifi name is Orchard.'), contentType: 'text/plain' })
    await assets.processPending(TEXT_DOCUMENT_INTERPRETER)
    const plain = assets.exportAll()
    expect(plain.assets[0]).toMatchObject({ raw: null, derived: [{ kind: 'text', text: 'Wifi name is Orchard.' }] })
    expect(Buffer.from(assets.exportAll({ includeRaw: true }).assets[0]!.raw!, 'base64').toString('utf8')).toBe('Wifi name is Orchard.')
  })
})
