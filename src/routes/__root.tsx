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
        type: 'image/png',
        sizes: '1254x1254',
        href: '/gideon-sphere.png',
      },
      {
        rel: 'apple-touch-icon',
        type: 'image/png',
        sizes: '1254x1254',
        href: '/gideon-sphere.png',
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

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: 'dark' }}>
      <head>
        <HeadContent />
      </head>
      <body className="font-sans antialiased [overflow-wrap:anywhere]">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
