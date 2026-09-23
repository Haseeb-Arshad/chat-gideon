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

/**
 * Implicit background learning for one owner. Independently switchable from
 * capture/commands/recall, behind the same cohort and production gate.
 */
export function memoryLearningEnabled(env: MemoryRolloutEnvironment, owner: string | null): boolean {
  // Signed Node owners are node/…, Worker accounts user/…; request-local owners never learn.
  if (!owner || !/^(?:user|node)\//u.test(owner)) return false
  if (env.NODE_ENV === 'production' && env.GIDEON_MEMORY_STAGE15_CUTOVER !== '1') return false
  if (memoryRolloutBucket(owner) >= rolloutPercent(env.GIDEON_MEMORY_ROLLOUT_PERCENT)) return false
  return env.GIDEON_MEMORY_LEARNING_ENABLED === '1'
}

/** The process-level maintenance runner (purge, stale views, learning queue). */
export function memoryBackgroundEnabled(env: MemoryRolloutEnvironment): boolean {
  if (env.NODE_ENV === 'production' && env.GIDEON_MEMORY_STAGE15_CUTOVER !== '1') return false
  return env.GIDEON_MEMORY_BACKGROUND_ENABLED === '1'
}

export interface MemoryClassifierPlan {
  /** `shadow` records disagreements only; `enforce` lets the classifier review writes. */
  mode: 'shadow' | 'enforce'
  provider: 'jev' | 'substitute'
  workflow: 'verify' | 'gate'
}

/**
 * Stage 11 classification is off unless a mode is chosen and the separate
 * remote spend switch is set: every call sends private turns to a provider.
 * Unknown values fall back to off, never to a guessed provider. Production
 * stays behind the Stage 15 cutover like the rest of background learning.
 */
export function memoryClassifierPlan(env: MemoryRolloutEnvironment): MemoryClassifierPlan | null {
  if (env.NODE_ENV === 'production' && env.GIDEON_MEMORY_STAGE15_CUTOVER !== '1') return null
  const mode = env.GIDEON_MEMORY_CLASSIFIER_MODE
  if (mode !== 'shadow' && mode !== 'enforce') return null
  if (env.GIDEON_MEMORY_CLASSIFIER_REMOTE_ALLOWED !== '1') return null
  const provider = (env.GIDEON_MEMORY_CLASSIFIER_PROVIDER ?? 'jev') as string
  if (provider !== 'jev' && provider !== 'substitute') return null
  const workflow = (env.GIDEON_MEMORY_CLASSIFIER_WORKFLOW ?? 'verify') as string
  if (workflow !== 'verify' && workflow !== 'gate') return null
  return Object.freeze({ mode, provider, workflow })
}
