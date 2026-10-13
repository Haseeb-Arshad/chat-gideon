import microsoftVoices from './microsoft-voices.json'
import { RequestValidationError } from './openrouter'

export interface VoiceChoice { model: string; voice: string }
export interface VoiceOption { id: string; name: string; locale: string }

// Microsoft IDs verified against OpenRouter's model catalog on 2026-10-08.
// Fish IDs come from the public Fish library; Sarah is the previous app voice.
export const VOICE_PROVIDERS = [
  { id: 'microsoft/mai-voice-2.1-flash', name: 'Microsoft Flash', price: '$15 / million characters',
    voices: microsoftVoices.map((id): VoiceOption => ({
      id, name: id.split(':')[0].split('-').slice(2).join('-'), locale: id.slice(0, 5),
    })) },
  ...['fish-audio/s2.1-pro', 'fish-audio/s2.1-pro-free:free'].map((id) => ({
    id, name: id.endsWith(':free') ? 'Fish S2.1 Pro Free' : 'Fish S2.1 Pro',
    price: id.endsWith(':free') ? 'Free · response times may vary' : '$15 / million UTF-8 bytes',
    voices: [
      { id: '933563129e564b19a115bedd57b7406a', name: 'Sarah · previous voice', locale: 'en' },
      { id: 'f48d143a59a946ab87c0130fd081f349', name: 'Polo', locale: 'en' },
      { id: '98655a12fa944e26b274c535e5e03842', name: 'E-girl', locale: 'en' },
      { id: 'e9b134e4c0b547a3894793be502314f1', name: 'Jasphina', locale: 'en' },
    ],
  })),
]

export const DEFAULT_VOICE_CHOICE: VoiceChoice = {
  model: 'microsoft/mai-voice-2.1-flash', voice: 'en-US-Harper:MAI-Voice-2.1-Flash',
}

export function parseVoiceChoice(value: unknown): VoiceChoice | undefined {
  if (value === undefined) return undefined
  if (value && typeof value === 'object') {
    const { model, voice } = value as Partial<VoiceChoice>
    const provider = VOICE_PROVIDERS.find(p => p.id === model)
    if (typeof voice === 'string' && provider?.voices.some(v => v.id === voice)) return { model: provider.id, voice }
  }
  throw new RequestValidationError('invalid_voice_choice', 'Choose a voice from the voice menu.')
}

const STORAGE_KEY = 'gideon-voice-choice'
export function readVoiceChoice(): VoiceChoice {
  try { return parseVoiceChoice(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')) ?? DEFAULT_VOICE_CHOICE }
  catch { return DEFAULT_VOICE_CHOICE }
}

export function saveVoiceChoice(choice: VoiceChoice): boolean {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parseVoiceChoice(choice))); return true }
  catch { return false }
}
