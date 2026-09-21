import type { PoolConfig } from 'pg'

export const MEMORY_SCHEMA = 'gideon_memory'
export const DEFAULT_MEMORY_POOL_MAX = 8
export const DEFAULT_MEMORY_CONNECTION_TIMEOUT_MS = 3_000
export const DEFAULT_MEMORY_IDLE_TIMEOUT_MS = 30_000
export const DEFAULT_MEMORY_STATEMENT_TIMEOUT_MS = 10_000

export interface MemoryPostgresConfig extends PoolConfig {
  connectionString: string
}

export class MemoryConfigurationError extends Error {
  readonly name = 'MemoryConfigurationError'
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new MemoryConfigurationError('Invalid PostgreSQL pool configuration.')
  }
  return parsed
}

export function validatePostgresUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new MemoryConfigurationError('A PostgreSQL connection URL is required.')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new MemoryConfigurationError('The PostgreSQL connection URL is invalid.')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new MemoryConfigurationError('The memory database must use PostgreSQL.')
  }
  if (!parsed.hostname) throw new MemoryConfigurationError('The PostgreSQL connection URL has no host.')
  return trimmed
}

export function memoryPostgresConfig(env: NodeJS.ProcessEnv = process.env): MemoryPostgresConfig {
  const connectionString = validatePostgresUrl(env.GIDEON_MEMORY_DATABASE_URL ?? env.MEMORY_TEST_DATABASE_URL ?? '')
  return {
    connectionString,
    max: positiveInteger(env.GIDEON_MEMORY_POOL_MAX, DEFAULT_MEMORY_POOL_MAX, 32),
    connectionTimeoutMillis: positiveInteger(env.GIDEON_MEMORY_CONNECTION_TIMEOUT_MS, DEFAULT_MEMORY_CONNECTION_TIMEOUT_MS, 60_000),
    idleTimeoutMillis: positiveInteger(env.GIDEON_MEMORY_IDLE_TIMEOUT_MS, DEFAULT_MEMORY_IDLE_TIMEOUT_MS, 300_000),
    statement_timeout: positiveInteger(env.GIDEON_MEMORY_STATEMENT_TIMEOUT_MS, DEFAULT_MEMORY_STATEMENT_TIMEOUT_MS, 120_000),
    application_name: 'chat-gideon-memory',
  }
}

export function assertExplicitMigrationPermission(env: NodeJS.ProcessEnv = process.env): void {
  if (env.GIDEON_MEMORY_MIGRATE !== '1') {
    throw new MemoryConfigurationError('Migrations require GIDEON_MEMORY_MIGRATE=1.')
  }
  const connectionString = validatePostgresUrl(env.GIDEON_MEMORY_DATABASE_URL ?? '')
  const host = new URL(connectionString).hostname.toLowerCase()
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (!local && env.GIDEON_MEMORY_ALLOW_REMOTE !== '1') {
    throw new MemoryConfigurationError('Remote memory migrations require GIDEON_MEMORY_ALLOW_REMOTE=1.')
  }
}

export function assertDisposableTestPermission(env: NodeJS.ProcessEnv = process.env): void {
  if (env.GIDEON_MEMORY_POSTGRES_TEST !== '1') {
    throw new MemoryConfigurationError('PostgreSQL integration tests require GIDEON_MEMORY_POSTGRES_TEST=1.')
  }
  const connectionString = validatePostgresUrl(env.MEMORY_TEST_DATABASE_URL ?? '')
  const host = new URL(connectionString).hostname.toLowerCase()
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (!local) throw new MemoryConfigurationError('The disposable memory test database must be local.')
}
