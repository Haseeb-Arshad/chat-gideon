/**
 * Server-selected memory rollout controls. Callers must supply the owner from
 * a server-bound session; this module deliberately accepts no request body.
 */

export interface MemoryFeatureFlags {
  capture: boolean
  commandWrites: boolean
  recall: boolean
}

export type MemoryRolloutEnvironment = Readonly<Record<string, string | undefined>>

const DISABLED: MemoryFeatureFlags = Object.freeze({ capture: false, commandWrites: false, recall: false })

function rolloutPercent(value: string | undefined): number {
  if (!value || !/^\d{1,3}$/u.test(value.trim())) return 0
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : 0
}

/** Stable, dependency-free bucket; the owner is never exposed to the client. */
export function memoryRolloutBucket(owner: string): number {
  let hash = 0x811c9dc5
  for (const character of owner) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 100
}

export function memoryFeatureFlags(
  env: MemoryRolloutEnvironment,
  owner: string | null,
  authenticated: boolean,
): MemoryFeatureFlags {
  if (!authenticated || !owner) return DISABLED
  if (env.NODE_ENV === 'production' && env.GIDEON_MEMORY_STAGE15_CUTOVER !== '1') return DISABLED
  // An unset or malformed percentage is zero: deploying code cannot silently
  // opt accounts in. Each capability remains an independent server switch.
  if (memoryRolloutBucket(owner) >= rolloutPercent(env.GIDEON_MEMORY_ROLLOUT_PERCENT)) return DISABLED
  return Object.freeze({
    capture: env.GIDEON_MEMORY_CAPTURE_ENABLED === '1',
    commandWrites: env.GIDEON_MEMORY_COMMAND_WRITES_ENABLED === '1',
    recall: env.GIDEON_MEMORY_RECALL_ENABLED === '1',
  })
}

export function anyMemoryFeatureEnabled(flags: MemoryFeatureFlags): boolean {
  return flags.capture || flags.commandWrites || flags.recall
}
