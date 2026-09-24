/**
 * Runs the memory MCP server over stdio for one person, on a SQLite file.
 *
 *   GIDEON_MEMORY_MCP_DB=~/.gideon/memory.db \
 *   GIDEON_MEMORY_MCP_SCOPE=me \
 *   [GIDEON_MEMORY_MCP_GRANTS=read,write,forget] \
 *   node node_modules/jiti/lib/jiti-cli.mjs packages/memory/bin/mcp-sqlite.ts
 *
 * The scope is fixed here, by whoever configures the process; tools cannot
 * change it. Logs go to stderr so stdout carries only protocol messages.
 */
import { resolve } from 'node:path'
import type { Grant } from '../src/contract.ts'
import { openMemory } from '../src/core.ts'
import { runMcpStdio } from '../src/mcp.ts'
import { SqliteMemoryBackend } from '../src/sqlite.ts'

const path = process.env.GIDEON_MEMORY_MCP_DB?.trim()
const scope = process.env.GIDEON_MEMORY_MCP_SCOPE?.trim()
if (!path || !scope) {
  process.stderr.write('Set GIDEON_MEMORY_MCP_DB and GIDEON_MEMORY_MCP_SCOPE.\n')
  process.exit(2)
}
const grants = (process.env.GIDEON_MEMORY_MCP_GRANTS ?? 'read,write,forget').split(',').map((grant) => grant.trim()).filter(Boolean) as Grant[]
const backend = new SqliteMemoryBackend({ path: resolve(path) })
const memory = openMemory({ backend, scopeId: scope, principalId: scope, grants })
await runMcpStdio({ memory })
await backend.close()
