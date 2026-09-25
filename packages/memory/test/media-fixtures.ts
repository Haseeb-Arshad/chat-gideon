import { deflateSync } from 'node:zlib'
import type { AssetInterpreter, DerivedInput } from '../src/assets.ts'
import { sha256 } from '../src/text.ts'

/**
 * Media generated here, byte by byte: redistributable, no private assets.
 * The fixture interpreters stand in for a vision model and a speech
 * recogniser. They return what a test registered for exact bytes, so tests
 * check the pipeline (consent, lineage, deletion, time), not model quality.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(Buffer.from(type, 'ascii'), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** A valid solid-colour PNG. */
export function makePng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8)
  const raw = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw.set(rgb, y * (1 + width * 3) + 1 + x * 3)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]
  return Uint8Array.from(Buffer.concat(parts))
}

/** A mono 16-bit 8 kHz tone; `keepMs` truncates the data as an interrupted recording would. */
export function makeWav(durationMs: number, frequency: number, keepMs = durationMs): Uint8Array {
  const rate = 8_000
  const samples = Math.round((durationMs / 1000) * rate)
  const kept = Math.round((keepMs / 1000) * rate)
  const out = new Uint8Array(44 + kept * 2)
  const view = new DataView(out.buffer)
  out.set(Buffer.from('RIFF', 'ascii'), 0)
  view.setUint32(4, 36 + samples * 2, true)
  out.set(Buffer.from('WAVEfmt ', 'ascii'), 8)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  out.set(Buffer.from('data', 'ascii'), 36)
  view.setUint32(40, samples * 2, true)
  for (let index = 0; index < kept; index += 1) view.setInt16(44 + index * 2, Math.round(Math.sin((2 * Math.PI * frequency * index) / rate) * 8_000), true)
  return out
}

export const text = (value: string) => Uint8Array.from(Buffer.from(value, 'utf8'))

/** A registry-backed stand-in interpreter; `gate` lets a test hold it mid-parse; `fail` simulates an outage. */
export function fixtureInterpreter(id: string, contentTypes: string[]) {
  const answers = new Map<string, DerivedInput[]>()
  const control = { gate: null as Promise<void> | null, fail: false, calls: 0 }
  const interpreter: AssetInterpreter = {
    id, version: 'fixture-1',
    handles: (contentType) => contentTypes.includes(contentType),
    async interpret(asset) {
      control.calls += 1
      if (control.gate) await control.gate
      if (control.fail) throw new Error('provider unavailable')
      return answers.get(sha256(Buffer.from(asset.bytes).toString('base64'))) ?? []
    },
  }
  return { interpreter, control, register: (bytes: Uint8Array, derived: DerivedInput[]) => answers.set(sha256(Buffer.from(bytes).toString('base64')), derived) }
}
