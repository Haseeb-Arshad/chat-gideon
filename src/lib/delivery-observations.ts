/**
 * Session-local provenance ledger for generated text, TTS segments, and cards.
 * It validates bounded client reports without treating them as durable memory
 * or as proof that a person actually heard or read anything.
 */

export interface IssuedTextResponse {
  turnId: string
  responseId: string
  text: string
}

export interface IssuedAudioSegment {
  turnId: string
  responseId: string
  segmentId: string
  startChar: number
  endChar: number
  text: string
}

export type DeliveryObservation =
  | {
      id: string
      turnId: string
      responseId: string
      kind: 'playback_reported'
      segmentId: string
      startChar: number
      endChar: number
    }
  | {
      id: string
      turnId: string
      responseId: string
      kind: 'playback_interrupted'
      startChar: number
      endChar: number
    }
  | {
      id: string
      turnId: string
      kind: 'displayed'
      artifactId: string
      displayRevision: number
    }

interface ResponseRecord extends IssuedTextResponse {
  textSegments: Map<string, { startChar: number; endChar: number; text: string }>
  audioSegments: Map<string, { startChar: number; endChar: number; text: string; reportedThrough: number }>
  completed: boolean
}

interface ArtifactRecord {
  turnId: string
  revisions: Set<number>
  latestRevision: number
}

const MAX_RESPONSES = 64
const MAX_TEXT_SEGMENTS = 512
const MAX_AUDIO_SEGMENTS_PER_RESPONSE = 128
const MAX_ARTIFACTS = 128
const MAX_OBSERVATIONS = 512
const MAX_ID_LENGTH = 160
const MAX_SEGMENT_TEXT = 2_000

function validId(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function validRange(startChar: number, endChar: number, limit: number): boolean {
  return Number.isSafeInteger(startChar)
    && Number.isSafeInteger(endChar)
    && startChar >= 0
    && endChar >= startChar
    && endChar <= limit
}

export class DeliveryObservationLedger {
  private readonly responses = new Map<string, ResponseRecord>()
  private readonly artifacts = new Map<string, ArtifactRecord>()
  private readonly observationIds = new Set<string>()
  private observationCount = 0
  private textSegmentCount = 0

  beginResponse(turnId: string, responseId: string): boolean {
    if (!validId(turnId) || !validId(responseId) || this.responses.has(responseId)) return false
    while (this.responses.size >= MAX_RESPONSES) {
      const oldestId = this.responses.keys().next().value
      if (!oldestId) return false
      this.responses.delete(oldestId)
    }
    this.responses.set(responseId, {
      turnId,
      responseId,
      text: '',
      textSegments: new Map(),
      audioSegments: new Map(),
      completed: false,
    })
    return true
  }

  appendTextSegment(segment: IssuedTextResponse & { segmentId: string; startChar: number; endChar: number }): boolean {
    const response = this.responses.get(segment.responseId)
    if (!response || response.completed || response.turnId !== segment.turnId
      || !validId(segment.segmentId) || response.textSegments.has(segment.segmentId)
      || this.textSegmentCount >= MAX_TEXT_SEGMENTS
      || typeof segment.text !== 'string' || segment.text.length > MAX_SEGMENT_TEXT
      || segment.startChar !== response.text.length
      || segment.endChar !== segment.startChar + segment.text.length
      || segment.text.length === 0) return false
    response.text += segment.text
    response.textSegments.set(segment.segmentId, {
      startChar: segment.startChar,
      endChar: segment.endChar,
      text: segment.text,
    })
    this.textSegmentCount += 1
    return true
  }

  completeResponse(turnId: string, responseId: string, finalText: string): boolean {
    const response = this.responses.get(responseId)
    if (!response || response.turnId !== turnId || response.completed || response.text !== finalText) return false
    response.completed = true
    return true
  }

  issueAudioSegment(segment: IssuedAudioSegment): boolean {
    const response = this.responses.get(segment.responseId)
    if (!response || response.turnId !== segment.turnId
      || !validId(segment.segmentId) || response.audioSegments.has(segment.segmentId)
      || response.audioSegments.size >= MAX_AUDIO_SEGMENTS_PER_RESPONSE
      || typeof segment.text !== 'string' || segment.text.length === 0 || segment.text.length > MAX_SEGMENT_TEXT
      || !validRange(segment.startChar, segment.endChar, response.text.length)
      || segment.endChar <= segment.startChar
      || response.text.slice(segment.startChar, segment.endChar) !== segment.text) return false
    response.audioSegments.set(segment.segmentId, {
      startChar: segment.startChar,
      endChar: segment.endChar,
      text: segment.text,
      reportedThrough: segment.startChar,
    })
    return true
  }

  issueArtifact(turnId: string, artifactId: string, displayRevision: number): boolean {
    if (!validId(turnId) || !validId(artifactId) || !Number.isSafeInteger(displayRevision) || displayRevision < 1) return false
    const existing = this.artifacts.get(artifactId)
    if (!existing) {
      while (this.artifacts.size >= MAX_ARTIFACTS) {
        const oldestId = this.artifacts.keys().next().value
        if (!oldestId) return false
        this.artifacts.delete(oldestId)
      }
      this.artifacts.set(artifactId, { turnId, revisions: new Set([displayRevision]), latestRevision: displayRevision })
      return true
    }
    if (existing.turnId !== turnId || displayRevision !== existing.latestRevision + 1) return false
    existing.latestRevision = displayRevision
    existing.revisions.add(displayRevision)
    return true
  }

  accept(observation: DeliveryObservation): boolean {
    if (!validId(observation.id) || this.observationIds.has(observation.id) || this.observationCount >= MAX_OBSERVATIONS) return false
    if (observation.kind === 'displayed') {
      const artifact = this.artifacts.get(observation.artifactId)
      if (!artifact || artifact.turnId !== observation.turnId || !artifact.revisions.has(observation.displayRevision)) return false
    } else {
      const response = this.responses.get(observation.responseId)
      if (!response || response.turnId !== observation.turnId) return false
      if (observation.kind === 'playback_reported') {
        const segment = response.audioSegments.get(observation.segmentId)
        if (!segment || !validRange(observation.startChar, observation.endChar, response.text.length)
          || observation.startChar < segment.startChar || observation.endChar > segment.endChar
          || observation.startChar >= observation.endChar || observation.startChar < segment.reportedThrough) return false
        segment.reportedThrough = observation.endChar
      } else if (!validRange(observation.startChar, observation.endChar, response.text.length)
        || observation.startChar !== observation.endChar) {
        return false
      }
    }
    this.observationIds.add(observation.id)
    this.observationCount += 1
    return true
  }

  response(turnId: string, responseId: string): IssuedTextResponse | null {
    const response = this.responses.get(responseId)
    return response?.turnId === turnId ? { turnId, responseId, text: response.text } : null
  }
}
