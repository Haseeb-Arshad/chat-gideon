import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Fails the Cloudflare build when the Worker bundle contains the Node-only
 * PostgreSQL memory authority. The Worker reaches its own tables (accounts and
 * account memory) with the `pg` driver through Hyperdrive; the canonical
 * adapter and its schema still belong to the Node host.
 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const bundle = join(root, 'dist', 'server')
const forbidden = [
  ['PostgreSQL memory store', 'PostgresMemoryStore'],
  ['memory authority schema', 'gideon_memory.'],
]

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.js') ? [path] : []
  })
}

const found = []
for (const file of files(bundle)) {
  const text = readFileSync(file, 'utf8')
  for (const [label, marker] of forbidden) {
    if (text.includes(marker)) found.push(`${relative(root, file)}: ${label}`)
  }
}

if (found.length) {
  console.error('The Worker bundle contains Node-only memory code:')
  for (const line of found) console.error(`  ${line}`)
  process.exitCode = 1
} else {
  console.log('Worker bundle is free of the Node PostgreSQL memory adapter.')
}

/**
 * Secrets: no bundle may embed a secret value from the local .env, and the
 * browser bundle may not even name server-only credentials or carry a
 * connection string. Values are compared, never printed.
 */
const secrets = []
try {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/u)) {
    const match = /^([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)[A-Z0-9_]*)=(.+)$/u.exec(line.trim())
    const value = match?.[2]?.replace(/^["']|["']$/gu, '').trim()
    // VITE_ variables are shipped to the browser on purpose.
    if (match && value && value.length >= 12 && !match[1].startsWith('VITE_')) secrets.push([match[1], value])
  }
} catch {
  // No local .env: only the name and pattern checks below apply.
}
const clientOnly = [
  ['server credential name', /\b(?:OPENROUTER_API_KEY|TYPESAFE_API_KEY|EXA_API_KEY|GIDEON_IDENTITY_SECRET|GIDEON_MEMORY_DATABASE_URL)\b/u],
  ['PostgreSQL connection string', /postgres(?:ql)?:\/\/[^\s"'`]+@/u],
  ['OpenRouter key', /sk-or-v1-[0-9a-f]{16,}/u],
]
const leaks = []
for (const [directory, browser] of [[join(root, 'dist', 'server'), false], [join(root, 'dist', 'client'), true]]) {
  let list = []
  try { list = files(directory) } catch { continue }
  for (const file of list) {
    const text = readFileSync(file, 'utf8')
    for (const [name, value] of secrets) if (text.includes(value)) leaks.push(`${relative(root, file)}: value of ${name}`)
    if (browser) for (const [label, pattern] of clientOnly) if (pattern.test(text)) leaks.push(`${relative(root, file)}: ${label}`)
  }
}
if (leaks.length) {
  console.error('A bundle carries a secret or a server-only credential:')
  for (const line of leaks) console.error(`  ${line}`)
  process.exitCode = 1
} else {
  console.log(`Bundles carry no local secret values (${secrets.length} checked) and the browser bundle names no server credential.`)
}
