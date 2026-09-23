import { describe, expect, it } from 'vitest'
import { anyMemoryFeatureEnabled, memoryFeatureFlags, memoryRolloutBucket } from './rollout'

describe('server-owned memory rollout', () => {
  it('keeps every new capability off when rollout configuration is absent or invalid', () => {
    expect(memoryFeatureFlags({}, 'user/1', true)).toEqual({ capture: false, commandWrites: false, recall: false })
    expect(memoryFeatureFlags({ GIDEON_MEMORY_ROLLOUT_PERCENT: '101', GIDEON_MEMORY_RECALL_ENABLED: '1' }, 'user/1', true))
      .toEqual({ capture: false, commandWrites: false, recall: false })
  })

  it('keeps the three capabilities independent inside the server-selected cohort', () => {
    const owner = 'user/rollout-test'
    const flags = memoryFeatureFlags({
      GIDEON_MEMORY_ROLLOUT_PERCENT: '100',
      GIDEON_MEMORY_CAPTURE_ENABLED: '1',
      GIDEON_MEMORY_RECALL_ENABLED: '1',
    }, owner, true)
    expect(flags).toEqual({ capture: true, commandWrites: false, recall: true })
    expect(anyMemoryFeatureEnabled(flags)).toBe(true)
    expect(memoryRolloutBucket(owner)).toBe(memoryRolloutBucket(owner))
  })

  it('never enrolls an unauthenticated or missing owner, even at 100 percent', () => {
    const env = { GIDEON_MEMORY_ROLLOUT_PERCENT: '100', GIDEON_MEMORY_COMMAND_WRITES_ENABLED: '1' }
    expect(memoryFeatureFlags(env, 'ephemeral/request', false)).toEqual({ capture: false, commandWrites: false, recall: false })
    expect(memoryFeatureFlags(env, null, true)).toEqual({ capture: false, commandWrites: false, recall: false })
  })

  it('keeps production off until the separately governed Stage 15 cutover', () => {
    const env = {
      NODE_ENV: 'production',
      GIDEON_MEMORY_STAGE15_CUTOVER: '0',
      GIDEON_MEMORY_ROLLOUT_PERCENT: '100',
      GIDEON_MEMORY_COMMAND_WRITES_ENABLED: '1',
    }
    expect(memoryFeatureFlags(env, 'user/1', true)).toEqual({ capture: false, commandWrites: false, recall: false })
    expect(memoryFeatureFlags({ ...env, GIDEON_MEMORY_STAGE15_CUTOVER: '1' }, 'user/1', true).commandWrites).toBe(true)
  })
})
