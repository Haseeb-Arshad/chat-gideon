import { PostHog } from 'posthog-node'

let posthogClient: PostHog | null = null
let warned = false

export function getPostHogClient() {
  try {
    const token = (
      process.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN ||
      (import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN as string | undefined)
    )?.trim()
    const host = (
      process.env.VITE_PUBLIC_POSTHOG_HOST ||
      (import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined)
    )?.trim()

    if (!token || !host || token.startsWith('replace_with_')) {
      if (import.meta.env.DEV && !warned) {
        warned = true
        console.warn('PostHog is not configured; analytics is disabled.')
      }
      return null
    }

    posthogClient ??= new PostHog(token, {
      host,
      flushAt: 1,
      flushInterval: 0,
      requestTimeout: 1_000,
      fetchRetryCount: 0,
      enableExceptionAutocapture: true,
    })
    return posthogClient
  } catch {
    return null
  }
}

type BackgroundRequest = Request & { waitUntil?: (work: Promise<unknown>) => unknown }
type RequestContext = { get?: () => { waitUntil?: (work: Promise<unknown>) => unknown } }

function keepAlive(request: Request, work: Promise<unknown>) {
  const background = (request as BackgroundRequest).waitUntil
  if (background) {
    background.call(request, work)
    return
  }
  // Vercel exposes the active invocation here; long-lived Node needs no extension.
  const context = (globalThis as unknown as Record<symbol, RequestContext>)[
    Symbol.for('@vercel/request-context')
  ]?.get?.()
  context?.waitUntil?.(work)
}

export function captureServerEvent(
  request: Request,
  event: string,
  properties: Record<string, unknown> = {},
): void {
  try {
    const client = getPostHogClient()
    if (!client) return

    client.capture({
      distinctId:
        request.headers.get('X-PostHog-Distinct-Id') ||
        request.headers.get('X-Gideon-Session') ||
        'anonymous',
      event,
      properties: {
        ...properties,
        $session_id: request.headers.get('X-PostHog-Session-Id') || undefined,
        source: 'api',
      },
    })
    const delivery = client.flush().catch(() => undefined)
    keepAlive(request, delivery)
  } catch {
    // Optional telemetry cannot change the outcome of a conversation request.
  }
}
