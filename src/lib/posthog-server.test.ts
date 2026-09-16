import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  capture: vi.fn(),
  flush: vi.fn<() => Promise<void>>(),
  create: vi.fn(),
}))
vi.mock('posthog-node', () => ({
  PostHog: class {
    constructor(...args: unknown[]) { sdk.create(...args) }
    capture = sdk.capture
    flush = sdk.flush
  },
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  sdk.flush.mockResolvedValue()
  vi.stubEnv('VITE_PUBLIC_POSTHOG_PROJECT_TOKEN', '')
  vi.stubEnv('VITE_PUBLIC_POSTHOG_HOST', '')
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function configure() {
  vi.stubEnv('VITE_PUBLIC_POSTHOG_PROJECT_TOKEN', 'test-project-token')
  vi.stubEnv('VITE_PUBLIC_POSTHOG_HOST', 'https://analytics.example')
}

describe('optional server analytics', () => {
  it('does not initialize or throw without configuration in development', async () => {
    const { captureServerEvent } = await import('./posthog-server')
    expect(() => captureServerEvent(new Request('https://app.example'), 'chat_requested')).not.toThrow()
    expect(sdk.create).not.toHaveBeenCalled()
  })

  it('does not initialize from copied placeholder credentials', async () => {
    configure()
    vi.stubEnv('VITE_PUBLIC_POSTHOG_PROJECT_TOKEN', 'replace_with_your_posthog_project_token')
    const { getPostHogClient } = await import('./posthog-server')
    expect(getPostHogClient()).toBeNull()
  })

  it('returns immediately while delivery remains pending and extends supported requests', async () => {
    configure()
    const delivery = new Promise<void>(() => {})
    sdk.flush.mockReturnValue(delivery)
    const request = Object.assign(new Request('https://app.example'), { waitUntil: vi.fn() })
    const { captureServerEvent } = await import('./posthog-server')
    expect(captureServerEvent(request, 'chat_requested', { message_count: 1 })).toBeUndefined()
    expect(request.waitUntil).toHaveBeenCalledWith(expect.any(Promise))
    expect(sdk.create).toHaveBeenCalledWith('test-project-token', expect.objectContaining({
      requestTimeout: 1_000, fetchRetryCount: 0,
    }))
  })

  it('absorbs capture and delivery failures', async () => {
    configure()
    const { captureServerEvent } = await import('./posthog-server')
    sdk.capture.mockImplementationOnce(() => { throw new Error('capture failed') })
    expect(() => captureServerEvent(new Request('https://app.example'), 'chat_requested')).not.toThrow()
    sdk.flush.mockRejectedValueOnce(new Error('delivery failed'))
    const request = Object.assign(new Request('https://app.example'), { waitUntil: vi.fn() })
    captureServerEvent(request, 'chat_requested')
    await expect(request.waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined()
  })
})
