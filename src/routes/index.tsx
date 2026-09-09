import { createFileRoute } from '@tanstack/react-router'
import { AgentPage } from '../components/AgentPage'

/** The owned domain opens straight into the conversation, not a redirect. */
export const Route = createFileRoute('/')({
  component: AgentPage,
  head: () => ({
    meta: [
      { title: 'GIDEON — Voice Presence' },
      {
        name: 'description',
        content:
          'Talk to GIDEON and cut in whenever you like. It listens while it speaks, starts working before you finish, and shows you every millisecond it spent.',
      },
    ],
  }),
})
