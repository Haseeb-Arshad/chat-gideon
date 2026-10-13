import { ArrowLeft, Check, Play, Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { awaitAccount, backendHeaders, backendUrl } from '../lib/backend'
import { DEFAULT_VOICE_CHOICE, VOICE_PROVIDERS, readVoiceChoice, saveVoiceChoice, type VoiceChoice } from '../lib/voice-options'

const SAMPLE = 'Hello. I am GIDEON. We can pick up wherever you like.'
function localeName(locale: string) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) || locale }
  catch { return locale }
}

export function VoiceSettings() {
  const [draft, setDraft] = useState<VoiceChoice>(DEFAULT_VOICE_CHOICE)
  const [saved, setSaved] = useState<VoiceChoice>(DEFAULT_VOICE_CHOICE)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState('')
  const audio = useRef<HTMLAudioElement>(null)
  const controller = useRef<AbortController | null>(null)
  const objectUrl = useRef('')
  useEffect(() => {
    const choice = readVoiceChoice()
    setDraft(choice); setSaved(choice)
    return () => {
      controller.current?.abort()
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    }
  }, [])
  const provider = VOICE_PROVIDERS.find(p => p.id === draft.model)!
  const selected = provider.voices.find(v => v.id === draft.voice)!
  const locales = [...new Set(provider.voices.map(v => v.locale))].sort((a, b) => a.startsWith('en') !== b.startsWith('en') ? (a.startsWith('en') ? -1 : 1) : a.localeCompare(b))
  const voices = provider.voices.filter(v => v.locale === selected.locale)
  const changed = draft.model !== saved.model || draft.voice !== saved.voice

  function choose(choice: VoiceChoice) {
    controller.current?.abort(); controller.current = null
    audio.current?.pause()
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = ''
    setPreview(''); setBusy(false); setMessage(''); setDraft(choice)
  }

  async function previewVoice() {
    controller.current?.abort()
    audio.current?.pause()
    const request = new AbortController()
    controller.current = request
    setBusy(true); setMessage('')
    try {
      await awaitAccount(request.signal)
      const response = await fetch(backendUrl('/api/voice'), {
        method: 'POST', headers: backendHeaders('application/json'),
        body: JSON.stringify({ text: SAMPLE, voiceChoice: draft }), signal: request.signal,
      })
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: { message?: string } } | null
        throw new Error(error?.error?.message || 'This voice could not be previewed. Try again.')
      }
      const blob = await response.blob()
      if (request.signal.aborted) return
      if (!blob.type.startsWith('audio/') || !blob.size) throw new Error('No playable audio was returned.')
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
      objectUrl.current = URL.createObjectURL(blob)
      setPreview(objectUrl.current)
      setMessage('Preview ready. Press play below to listen.')
    } catch (error) {
      if (!request.signal.aborted) setMessage((error as Error).message)
    } finally {
      if (controller.current === request) setBusy(false)
    }
  }

  return (
    <main className="voice-settings">
      <a className="voice-back" href="/"><ArrowLeft size={16} /> Back to GIDEON</a>
      <section className="voice-settings-card" aria-labelledby="voices-title">
        <div className="voice-settings-icon"><Volume2 size={24} /></div>
        <p className="voice-eyebrow">GIDEON · Voices</p>
        <h1 id="voices-title">Find your familiar voice.</h1>
        <p className="voice-intro">Listen first, then choose who you want to talk with.</p>
        <label htmlFor="voice-provider">Speech model</label>
        <select id="voice-provider" value={draft.model} onChange={event => {
          const next = VOICE_PROVIDERS.find(p => p.id === event.target.value)!
          choose(next.id === DEFAULT_VOICE_CHOICE.model ? DEFAULT_VOICE_CHOICE : { model: next.id, voice: next.voices[0].id })
        }}>
          {VOICE_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <p className="voice-price">{provider.price}</p>
        {locales.length > 1 ? <>
          <label htmlFor="voice-language">Language and accent</label>
          <select id="voice-language" value={selected.locale} onChange={event => choose({ model: draft.model, voice: provider.voices.find(v => v.locale === event.target.value)!.id })}>
            {locales.map(locale => <option key={locale} value={locale}>{localeName(locale)}</option>)}
          </select>
        </> : null}
        <label htmlFor="voice-name">Voice</label>
        <select id="voice-name" value={draft.voice} onChange={event => choose({ model: draft.model, voice: event.target.value })}>
          {voices.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <p className="voice-hint">{draft.model.startsWith('fish-audio/') ? 'Sarah is the voice GIDEON used before Microsoft.' : 'The selected language and accent apply to speech playback.'}</p>
        <div className="voice-settings-actions">
          <button type="button" className="voice-preview" disabled={busy} onClick={() => void previewVoice()}><Play size={16} />{busy ? 'Preparing preview…' : 'Preview voice'}</button>
          <button type="button" className="voice-save" disabled={!changed} onClick={() => {
            if (saveVoiceChoice(draft)) { setSaved(draft); setMessage('Saved for this browser. New replies will use this voice.') }
            else setMessage('Your browser could not save the voice. Allow site storage and try again.')
          }}><Check size={16} />{changed ? 'Use this voice' : 'Current voice'}</button>
        </div>
        {preview ? <audio ref={audio} src={preview} controls aria-label={`${selected.name} voice preview`} /> : null}
        <p className="voice-status" role="status">{message}</p>
        <p className="voice-footnote">Your choice stays in this browser. Previews use the selected model and its listed rate.</p>
      </section>
    </main>
  )
}
