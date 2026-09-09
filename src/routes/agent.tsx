import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * An earlier plan split a landing page from the conversation and put the
 * conversation here. The landing was never built and the root opens straight
 * into GIDEON, so this path exists only to keep old links working.
 */
export const Route = createFileRoute('/agent')({
  beforeLoad: () => {
    throw redirect({ to: '/' })
  },
})
