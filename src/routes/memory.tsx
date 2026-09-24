import { createFileRoute } from '@tanstack/react-router'
import { MemoryInspector } from '../components/MemoryInspector'

/** What GIDEON remembers, and the controls to change or remove it. */
export const Route = createFileRoute('/memory')({
  component: MemoryInspector,
  head: () => ({
    meta: [
      { title: 'Memory — GIDEON' },
      { name: 'robots', content: 'noindex' },
    ],
  }),
})
