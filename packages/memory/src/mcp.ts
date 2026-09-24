import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { MEMORY_KINDS, MemoryError, type MemoryItem } from './contract.ts'
import type { ScopedMemory } from './core.ts'

/**
 * MCP server (stdio, JSON-RPC 2.0, one message per line) over one scoped
 * memory. The scope is fixed when the host builds the server; no tool takes
 * an identity, and any argument that is not in a tool's schema (a scopeId,
 * an owner, a tenant) is an error, not something quietly ignored. Outputs are
 * bounded; long histories are separate calls.
 *
 * stdio is not a security boundary by itself: whoever can launch the process
 * with this configuration can use this memory. Give each user their own
 * configuration and database.
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
const TEXT_LIMIT = 500
const REQUEST_ID = { type: 'string', pattern: '^[A-Za-z0-9-]{1,64}$', description: 'Optional: repeat the same value when retrying, so the write happens once.' }

interface Tool { name: string; description: string; inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false } }

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): Tool => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } })

export const MEMORY_TOOLS: readonly Tool[] = [
  tool('recall', 'Find remembered items about a question. Lexical search: an empty result does not prove something was never said.', { query: { type: 'string', maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, ['query']),
  tool('get', 'Read one remembered item by id.', { id: { type: 'string', maxLength: 200 } }, ['id']),
  tool('remember', 'Save something the user explicitly asked to remember.', { text: { type: 'string', maxLength: 1000 }, kind: { type: 'string', enum: [...MEMORY_KINDS] }, requestId: REQUEST_ID }, ['text']),
  tool('correct', "Change a remembered item. change='mistake' if it was never right, 'changed' if it was right and is no longer (give since).", { id: { type: 'string', maxLength: 200 }, expectedRevision: { type: 'integer', minimum: 1 }, text: { type: 'string', maxLength: 1000 }, change: { type: 'string', enum: ['mistake', 'changed'] }, since: { type: 'string', maxLength: 40 }, requestId: REQUEST_ID }, ['id', 'expectedRevision', 'text']),
  tool('forget', 'Forget a remembered item the user asked to forget. Its content is removed and it cannot come back through a retry or an old export.', { id: { type: 'string', maxLength: 200 }, expectedRevision: { type: 'integer', minimum: 1 }, requestId: REQUEST_ID }, ['id', 'expectedRevision']),
  tool('resume', 'Pick a topic back up: items related to it and the most recent items, bounded.', { topic: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, ['topic']),
  tool('explain', "Show one item's history: each revision, whether it was a correction or a real change, and when it was true.", { id: { type: 'string', maxLength: 200 } }, ['id']),
]

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

const clip = (text: string) => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text)
const line = (item: MemoryItem) => `- [${item.id} r${item.revision}${item.kind === 'fact' ? '' : ` ${item.kind}`}] ${clip(item.text)}`

function checkArguments(schema: Tool['inputSchema'], args: Record<string, unknown>): void {
  const unexpected = Object.keys(args).filter((key) => !(key in schema.properties))
  if (unexpected.length) throw new MemoryError('validation', `Unexpected argument ${unexpected.join(', ')}. This memory's identity comes from the connection, never from a tool argument.`)
  for (const key of schema.required) if (args[key] === undefined) throw new MemoryError('validation', `Missing argument ${key}.`)
  const limit = args.limit
  if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 8)) throw new MemoryError('validation', 'limit must be 1-8.')
  const requestId = args.requestId
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(requestId))) throw new MemoryError('validation', 'requestId must be 1-64 letters, digits or dashes.')
}

async function callTool(memory: ScopedMemory, name: string, args: Record<string, unknown>): Promise<{ text: string; data?: unknown }> {
  const found = MEMORY_TOOLS.find((item) => item.name === name)
  if (!found) throw new MemoryError('not_found', `Unknown tool ${name}.`)
  checkArguments(found.inputSchema, args)
  // Command ids from this surface live under mcp/, so a model cannot replay another client's command.
  const command = (prefix: string) => `mcp/${prefix}/${(args.requestId as string | undefined) ?? randomUUID()}`
  switch (name) {
    case 'recall': {
      const items = await memory.search(args.query as string, (args.limit as number | undefined) ?? 5)
      return { text: items.length ? items.map(line).join('\n') : 'No matching memory in this bounded search (that does not prove it was never said).', data: { items } }
    }
    case 'get': {
      const item = await memory.get(args.id as string)
      return { text: item ? line(item) : 'Not found.', data: { item } }
    }
    case 'remember': {
      const result = await memory.remember({ commandId: command('remember'), text: args.text as string, kind: args.kind as never })
      return { text: `${result.outcome === 'created' ? 'Saved' : result.outcome === 'duplicate' ? 'Already remembered' : 'Already saved'}: ${line(result.item)}`, data: result }
    }
    case 'correct': {
      const result = await memory.correct({ commandId: command('correct'), id: args.id as string, expectedRevision: args.expectedRevision as number, text: args.text as string, change: args.change as never, since: args.since as string | undefined })
      return { text: `Updated: ${line(result.item)}`, data: result }
    }
    case 'forget': {
      const result = await memory.forget({ commandId: command('forget'), id: args.id as string, expectedRevision: args.expectedRevision as number })
      return { text: `Forgotten: ${result.id}`, data: result }
    }
    case 'resume': {
      const limit = (args.limit as number | undefined) ?? 5
      const related = await memory.search(args.topic as string, limit)
      const recent = (await memory.list({ limit })).items.filter((item) => !related.some((other) => other.id === item.id))
      return { text: [`Related to "${clip(args.topic as string)}":`, ...(related.length ? related.map(line) : ['- nothing found']), 'Recent:', ...(recent.length ? recent.map(line) : ['- nothing else'])].join('\n'), data: { related, recent } }
    }
    default: {
      const revisions = (await memory.history(args.id as string)).slice(-20)
      if (!revisions.length) return { text: 'Not found.', data: { revisions } }
      return {
        text: revisions.map((revision) => `r${revision.revision} ${revision.basis}${revision.supersededAsMistake ? ' (replaced as a mistake)' : ''} valid ${revision.validFrom ?? 'unknown'} → ${revision.validUntil ?? 'now'}: ${revision.text === null ? '[forgotten]' : clip(revision.text)}`).join('\n'),
        data: { revisions },
      }
    }
  }
}

/** One JSON-RPC message in, at most one out (notifications get none). */
export function createMcpHandler(options: { memory: ScopedMemory; version?: string }) {
  return async (message: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
    const id = message.id ?? null
    const reply = (result: unknown): JsonRpcResponse | null => (message.id === undefined ? null : { jsonrpc: '2.0', id, result })
    const error = (code: number, text: string): JsonRpcResponse | null => (message.id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message: text } })
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid request.')
    switch (message.method) {
      case 'initialize': {
        const asked = message.params?.protocolVersion
        const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(asked as never) ? asked : MCP_PROTOCOL_VERSIONS[0]
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'gideon-memory', version: options.version ?? '0.1.0' },
          instructions: "Memory for one user. Save only what the user asks to remember; correct with the revision you read; never pass identities. Recall is bounded and lexical.",
        })
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: MEMORY_TOOLS })
      case 'tools/call': {
        const name = message.params?.name
        const args = message.params?.arguments ?? {}
        if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) return error(-32602, 'tools/call needs a name and an arguments object.')
        try {
          const result = await callTool(options.memory, name, args as Record<string, unknown>)
          return reply({ content: [{ type: 'text', text: result.text }], structuredContent: result.data, isError: false })
        } catch (caught) {
          const failure = caught instanceof MemoryError ? caught : new MemoryError('unavailable', 'The memory tool failed.')
          return reply({ content: [{ type: 'text', text: `${failure.code}: ${failure.message}` }], isError: true })
        }
      }
      default:
        return error(-32601, `Unknown method ${message.method}.`)
    }
  }
}

/** Serves MCP on a newline-delimited stream pair (stdio by default). */
export function runMcpStdio(options: { memory: ScopedMemory; input?: Readable; output?: Writable }): Promise<void> {
  const handle = createMcpHandler(options)
  const output = options.output ?? process.stdout
  const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity })
  let pending = Promise.resolve()
  lines.on('line', (text) => {
    if (!text.trim()) return
    pending = pending.then(async () => {
      let message: JsonRpcRequest
      try {
        message = JSON.parse(text) as JsonRpcRequest
      } catch {
        output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } })}\n`)
        return
      }
      const response = await handle(message)
      if (response) output.write(`${JSON.stringify(response)}\n`)
    })
  })
  return new Promise((resolve) => lines.on('close', () => { void pending.then(() => resolve()) }))
}
