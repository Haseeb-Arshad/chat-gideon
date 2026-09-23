import { describe, expect, it } from 'vitest'
import { DeliveryObservationLedger } from './delivery-observations'

function delivered() {
  const ledger = new DeliveryObservationLedger()
  expect(ledger.beginResponse('turn-1', 'response-1')).toBe(true)
  expect(ledger.appendTextSegment({
    turnId: 'turn-1', responseId: 'response-1', segmentId: 'text-1',
    startChar: 0, endChar: 12, text: 'Hello there.',
  })).toBe(true)
  expect(ledger.completeResponse('turn-1', 'response-1', 'Hello there.')).toBe(true)
  expect(ledger.issueAudioSegment({
    turnId: 'turn-1', responseId: 'response-1', segmentId: 'audio-1',
    startChar: 0, endChar: 12, text: 'Hello there.',
  })).toBe(true)
  return ledger
}

describe('delivery observation provenance', () => {
  it('accepts only bounded reports for server-issued audio and rejects replay or cross-turn claims', () => {
    const ledger = delivered()
    const report = {
      id: 'report-1', turnId: 'turn-1', responseId: 'response-1',
      kind: 'playback_reported' as const, segmentId: 'audio-1', startChar: 0, endChar: 5,
    }
    expect(ledger.accept(report)).toBe(true)
    expect(ledger.accept({ ...report, id: 'report-2', startChar: 4, endChar: 8 })).toBe(false)
    expect(ledger.accept({ ...report, id: 'report-3', turnId: 'turn-2' })).toBe(false)
    expect(ledger.accept({ ...report, id: 'report-4', endChar: 99 })).toBe(false)
  })

  it('does not equate generated text with playback and requires interruption reports to be bounded points', () => {
    const ledger = delivered()
    expect(ledger.accept({
      id: 'interrupt-1', turnId: 'turn-1', responseId: 'response-1',
      kind: 'playback_interrupted', startChar: 5, endChar: 5,
    })).toBe(true)
    expect(ledger.accept({
      id: 'interrupt-2', turnId: 'turn-1', responseId: 'response-1',
      kind: 'playback_interrupted', startChar: 5, endChar: 6,
    })).toBe(false)
    expect(ledger.accept({
      id: 'not-generated', turnId: 'turn-1', responseId: 'unknown',
      kind: 'playback_interrupted', startChar: 0, endChar: 0,
    })).toBe(false)
  })

  it('requires a matching server-issued card revision and limits revision advances to one step', () => {
    const ledger = new DeliveryObservationLedger()
    expect(ledger.issueArtifact('turn-1', 'card-1', 1)).toBe(true)
    expect(ledger.issueArtifact('turn-1', 'card-1', 3)).toBe(false)
    expect(ledger.issueArtifact('turn-1', 'card-1', 2)).toBe(true)
    expect(ledger.accept({ id: 'display-1', turnId: 'turn-1', kind: 'displayed', artifactId: 'card-1', displayRevision: 2 })).toBe(true)
    expect(ledger.accept({ id: 'display-2', turnId: 'turn-2', kind: 'displayed', artifactId: 'card-1', displayRevision: 2 })).toBe(false)
  })

  it('rejects generated output that is not the exact source for an audio span', () => {
    const ledger = delivered()
    expect(ledger.issueAudioSegment({
      turnId: 'turn-1', responseId: 'response-1', segmentId: 'forged-audio',
      startChar: 0, endChar: 5, text: 'Good.',
    })).toBe(false)
  })
})
