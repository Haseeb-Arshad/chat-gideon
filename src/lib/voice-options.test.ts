import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE_CHOICE, VOICE_PROVIDERS, parseVoiceChoice } from './voice-options'

describe('voice selection boundary', () => {
  it('keeps omitted selections compatible with the server default', () => {
    expect(parseVoiceChoice(undefined)).toBeUndefined()
    expect(parseVoiceChoice(DEFAULT_VOICE_CHOICE)).toEqual(DEFAULT_VOICE_CHOICE)
  })
  it.each([null, {}, { model: 'openai/expensive-model', voice: 'anything' },
    { model: 'microsoft/mai-voice-2.1-flash', voice: '933563129e564b19a115bedd57b7406a' },
    { model: 'fish-audio/s2.1-pro', voice: DEFAULT_VOICE_CHOICE.voice }])('rejects unsupported or mismatched selections: %j', selection => {
    expect(() => parseVoiceChoice(selection)).toThrow('Choose a voice from the voice menu.')
  })
  it('permits each listed voice only with its catalog model', () => {
    for (const provider of VOICE_PROVIDERS) for (const voice of provider.voices) {
      expect(parseVoiceChoice({ model: provider.id, voice: voice.id })).toEqual({ model: provider.id, voice: voice.id })
    }
  })
})
