/**
 * Host-provided configuration for the shared agent core.
 *
 * The local Node server reads process.env. Cloudflare Workers expose the same
 * values as bindings instead, so the Worker entrypoint installs its bindings
 * here before it calls the framework-free core.
 */

let active: Record<string, unknown> | null = null

export function setRuntimeEnv(env: unknown) {
  active = env && typeof env === 'object' ? (env as Record<string, unknown>) : null
}

export function runtimeEnv(name: string): string | undefined {
  const value = active?.[name]
  return typeof value === 'string' ? value.trim() || undefined : undefined
}
