import { PostHog } from 'posthog-node'

let posthogClient: PostHog | null = null

export function getPostHogClient() {
  const token =
    process.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN ||
    (import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN as string | undefined)
  const host =
    process.env.VITE_PUBLIC_POSTHOG_HOST ||
    (import.meta.env.VITE_PUBLIC_POSTHOG_HOST as string | undefined)

  if (!token || !host) {
    if (import.meta.env.DEV) {
      const variable = !token
        ? 'VITE_PUBLIC_POSTHOG_PROJECT_TOKEN'
        : 'VITE_PUBLIC_POSTHOG_HOST'
      throw new Error(
        `${variable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variable} is configured`,
      )
    }
    return null
  }

  posthogClient ??= new PostHog(token, {
    host,
    flushAt: 1,
    flushInterval: 0,
    enableExceptionAutocapture: true,
  })
  return posthogClient
}

export async function captureServerEvent(
  request: Request,
  event: string,
  properties: Record<string, unknown> = {},
) {
  const client = getPostHogClient()
  if (!client) return

  const sessionId = request.headers.get('X-PostHog-Session-Id') || undefined
  const distinctId =
    request.headers.get('X-PostHog-Distinct-Id') ||
    request.headers.get('X-Gideon-Session') ||
    'anonymous'

  try {
    client.capture({
      distinctId,
      event,
      properties: {
        ...properties,
        $session_id: sessionId,
        source: 'api',
      },
    })
    await client.flush()
  } catch {
    // Analytics delivery must not prevent the underlying request from completing.
  }
}
