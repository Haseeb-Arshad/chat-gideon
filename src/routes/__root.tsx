import { PostHogProvider } from '@posthog/react'
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'GIDEON — Voice Companion',
      },
      {
        name: 'description',
        content:
          'A full-duplex voice presence: it listens while it speaks, starts working before you finish your sentence, and shows you every millisecond it spent.',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'icon',
        href: '/favicon.ico',
        sizes: '16x16 32x32 48x48',
      },
      {
        rel: 'apple-touch-icon',
        type: 'image/png',
        sizes: '192x192',
        href: '/gideon-192.png',
      },
      {
        rel: 'manifest',
        href: '/manifest.json',
      },
    ],
  }),
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
})

function NotFound() {
  return (
    <main className="not-found">
      <p>That place is outside GIDEON's current world.</p>
      <a href="/">Return to GIDEON</a>
    </main>
  )
}

function PostHogRoot({ children }: { children: React.ReactNode }) {
  const token = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN as string | undefined
  const host = import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined

  if (!token?.trim() || !host?.trim() || token.startsWith('replace_with_')) {
    return children
  }

  return (
    <PostHogProvider
      apiKey={token}
      options={{
        api_host: host,
        defaults: '2025-05-24',
        capture_exceptions: true,
        debug: import.meta.env.DEV,
        tracing_headers: typeof window !== 'undefined' ? [window.location.hostname] : [],
      }}
    >
      {children}
    </PostHogProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: 'dark' }}>
      <head>
        <HeadContent />
      </head>
      <body className="font-sans antialiased [overflow-wrap:anywhere]">
        <PostHogRoot>{children}</PostHogRoot>
        <Scripts />
      </body>
    </html>
  )
}
