import { createServer } from 'vite'

// Process-local: never changes .env or production analytics configuration.
process.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN = 'replace_with_visualization_lab'
const server = await createServer({ mode: 'visualizations', server: { port: Number(process.env.PORT) || 3012 } })
await server.listen()
server.printUrls()
console.log('Synthetic chart fixtures: /lab/cards?visualizations=1 (analytics disabled)')
