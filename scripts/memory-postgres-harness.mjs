import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const isLocalHost = (hostname) => ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase())

function requiredExecutable(directory, name) {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const candidate = join(directory, `${name}${suffix}`)
  return existsSync(candidate) ? candidate : null
}

function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${executable} exited with ${result.status}`)
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not allocate a local PostgreSQL test port.'))
        return
      }
      const port = address.port
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

function testCommand(env) {
  const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
  if (!existsSync(vitest)) throw new Error('Vitest is not installed; run npm install first.')
  const result = spawnSync(process.execPath, [vitest, 'run', 'backend/memory/src/postgres.live.test.ts', '--mode', 'memory-postgres'], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

async function main() {
  const external = process.env.MEMORY_TEST_DATABASE_URL
  if (external) {
    if (process.env.GIDEON_MEMORY_POSTGRES_TEST !== '1') throw new Error('External test URLs require GIDEON_MEMORY_POSTGRES_TEST=1.')
    if (process.env.MEMORY_TEST_DATABASE_OWNED !== '1') throw new Error('External test URLs require MEMORY_TEST_DATABASE_OWNED=1.')
    const url = new URL(external)
    if (!isLocalHost(url.hostname)) throw new Error('The PostgreSQL test harness refuses a non-local database URL.')
    process.exitCode = testCommand({ ...process.env, GIDEON_MEMORY_POSTGRES_TEST: '1' })
    return
  }

  const configuredBin = process.env.MEMORY_TEST_POSTGRES_BIN
  const candidates = [
    configuredBin,
    ...(process.platform === 'win32' ? [
      'C:\\Program Files\\PostgreSQL\\17\\bin',
      'C:\\Program Files\\PostgreSQL\\16\\bin',
    ] : ['/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin', '/usr/bin']),
  ].filter(Boolean)
  const bin = candidates.find((candidate) => requiredExecutable(candidate, 'initdb') && requiredExecutable(candidate, 'pg_ctl'))
  if (!bin) throw new Error('No local PostgreSQL initdb/pg_ctl pair was found. Set MEMORY_TEST_POSTGRES_BIN or install PostgreSQL locally.')

  const dataDirectory = mkdtempSync(join(tmpdir(), 'gideon-memory-postgres-'))
  const port = await freePort()
  const initdb = requiredExecutable(bin, 'initdb')
  const pgctl = requiredExecutable(bin, 'pg_ctl')
  const logPath = join(dataDirectory, 'postgres.log')
  let started = false
  try {
    run(initdb, ['-D', dataDirectory, '-U', 'gideon_test', '-A', 'trust', '--no-locale', '--encoding', 'UTF8'])
    run(pgctl, ['-D', dataDirectory, '-o', `-h 127.0.0.1 -p ${port}`, '-l', logPath, '-w', 'start'])
    started = true
    const env = {
      ...process.env,
      GIDEON_MEMORY_POSTGRES_TEST: '1',
      MEMORY_TEST_DATABASE_URL: `postgresql://gideon_test@127.0.0.1:${port}/postgres`,
      MEMORY_TEST_DATABASE_OWNED: '1',
    }
    process.exitCode = testCommand(env)
  } finally {
    if (started) spawnSync(pgctl, ['-D', dataDirectory, '-m', 'fast', '-w', 'stop'], { cwd: root, stdio: 'inherit', windowsHide: true })
    rmSync(dataDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
