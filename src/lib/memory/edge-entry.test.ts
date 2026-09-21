import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '.')

async function reachable(file: string, seen = new Set<string>()): Promise<Set<string>> {
  const absolute = resolve(file)
  if (seen.has(absolute)) return seen
  seen.add(absolute)
  const source = await readFile(absolute, 'utf8')
  const imports = [...source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((match) => match[1]).filter(Boolean)
  for (const specifier of imports) {
    if (!specifier!.startsWith('.')) continue
    const candidate = resolve(dirname(absolute), specifier!)
    const withExtension = extname(candidate) ? candidate : `${candidate}.ts`
    await reachable(withExtension, seen)
  }
  return seen
}

describe('edge-safe memory entry point', () => {
  it('does not reach Node, filesystem, database, provider, or secret modules', async () => {
    const files = await reachable(join(root, 'index.ts'))
    const forbidden = [...files].filter((file) => /node_modules|src[\\/]server|node:|postgres|pgvector|fs|secret/i.test(file))
    expect(forbidden).toEqual([])
    expect([...files].some((file) => file.endsWith('test-adapter.ts'))).toBe(false)
  })
})
