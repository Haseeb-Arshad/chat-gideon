import { createFileRoute } from '@tanstack/react-router'
import page from '../system-card/system-card.html?raw'

/**
 * The card system: how GIDEON's cards grow from one kind into sizes, blocks
 * and recipes, drawn in the same glass, with the plan for building it.
 *
 * Served as its own document rather than inside the app. It carries its own
 * type, colour and scripts for the mockups, and the conversation's stylesheet
 * sets the body, buttons and fonts globally; mounted inside the app, the two
 * would fight over every one of them.
 */
export const Route = createFileRoute('/system-card')({
  server: {
    handlers: {
      GET: async () =>
        new Response(page, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            // It changes when the plan does, which is with a deploy.
            'Cache-Control': 'public, max-age=300',
          },
        }),
    },
  },
})
