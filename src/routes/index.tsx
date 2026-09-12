import { createFileRoute } from '@tanstack/react-router'
import { AgentPage } from '../components/AgentPage'
import { GlassFilters } from '../components/LiquidGlass'

/**
 * The glass filters wrap the page rather than living inside it: a component
 * cannot read a context it renders itself, and the page is made of the same
 * glass as everything on it.
 */
function Home() {
  return (
    <GlassFilters>
      <AgentPage />
    </GlassFilters>
  )
}

/** The owned domain opens straight into the conversation, not a redirect. */
export const Route = createFileRoute('/')({
  component: Home,
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
