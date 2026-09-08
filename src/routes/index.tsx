import { createFileRoute } from '@tanstack/react-router'
import { AgentPage } from '../components/AgentPage'

/** The owned domain opens straight into the conversation, not a redirect. */
export const Route = createFileRoute('/')({
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
