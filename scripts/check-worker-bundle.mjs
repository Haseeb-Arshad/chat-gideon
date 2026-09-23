import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Fails the Cloudflare build when the Worker bundle contains the Node-only
 * PostgreSQL memory authority. The Worker keeps its own account/Durable Object
 * memory; the `pg` driver and the canonical adapter belong to the Node host.
 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const bundle = join(root, 'dist', 'server')
const forbidden = [
  ['pg driver protocol', 'pg-protocol'],
  ['pg connection strings', 'pg-connection-string'],
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
