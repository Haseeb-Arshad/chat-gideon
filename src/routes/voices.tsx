import { createFileRoute } from '@tanstack/react-router'
import { VoiceSettings } from '../components/VoiceSettings'
import { GlassFilters } from '../components/LiquidGlass'

export const Route = createFileRoute('/voices')({
  component: () => <GlassFilters><VoiceSettings /></GlassFilters>,
  head: () => ({ meta: [{ title: 'Voices — GIDEON' }, { name: 'robots', content: 'noindex' }] }),
})
