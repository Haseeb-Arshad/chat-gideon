import { createFileRoute } from '@tanstack/react-router'
import { AgentPage } from '../components/AgentPage'

export const Route = createFileRoute('/agent')({
  component: AgentPage,
  head: () => ({
    meta: [
      { title: 'GIDEON — Voice Companion' },
      {
        name: 'description',
        content:
          'Talk through what matters with GIDEON, a voice-forward companion that keeps the thread close.',
      },
    ],
  }),
})
