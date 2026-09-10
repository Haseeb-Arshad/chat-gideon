#!/usr/bin/env node

/**
 * Small, dependency-free OpenRouter benchmark for GIDEON's chat models.
 *
 * It deliberately measures the streaming path used by the app, keeps the
 * prompt sequence identical for every model, and disables reasoning. The
 * output is a compact comparison matrix plus the actual answers for a human
 * quality check. It never prints the API key or writes a result file.
 */

import fs from 'node:fs'
import { performance } from 'node:perf_hooks'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_REPS = 3

const MODELS = [
  { id: 'inception/mercury-2.5', label: 'Mercury 2.5' },
  { id: 'openai/gpt-4.1', label: 'GPT-4.1' },
  { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 mini' },
]

const SYSTEM_PROMPT = `You are benchmarking a voice assistant. Answer directly in plain text, with no markdown, no emojis, and no chain-of-thought. Keep each answer concise and natural to speak aloud.`

// The second and third turns intentionally depend on the same conversation.
// That catches a model that is quick on an isolated prompt but awkward in use.
const TURNS = [
  {
    key: 'criterion',
    prompt: 'Give one practical rule for making a voice assistant feel fast. Keep it under 20 words.',
  },
  {
    key: 'tradeoff',
    prompt:
      'Model A starts in 400 ms and then produces 40 tokens per second. Model B starts in 1,200 ms and then produces 200 tokens per second. Which feels faster for a 50-word spoken reply? Explain in two short sentences.',
  },
  {
    key: 'integration',
    prompt: 'Turn that recommendation into one implementation rule for this app. Keep it under 25 words.',
  },
]

function parseArgs(argv) {
  const options = { reps: DEFAULT_REPS, format: 'markdown', modelIds: null }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.format = 'json'
    else if (arg === '--markdown') options.format = 'markdown'
    else if (arg === '--reps') options.reps = Math.max(1, Number(argv[++index] ?? DEFAULT_REPS))
    else if (arg.startsWith('--reps=')) options.reps = Math.max(1, Number(arg.slice(7)))
    else if (arg === '--models') options.modelIds = String(argv[++index] ?? '').split(',').filter(Boolean)
    else if (arg.startsWith('--models=')) options.modelIds = arg.slice(9).split(',').filter(Boolean)
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: npm run benchmark:models -- [options]

Options:
  --reps N                 Complete conversations per model (default: ${DEFAULT_REPS})
  --models ID,ID           Limit the run to selected model IDs
  --json                   Print machine-readable JSON instead of Markdown
  --help                   Show this help

Reasoning is sent as { effort: "none", exclude: true } for every request.`)
      process.exit(0)
    }
  }

  if (!Number.isFinite(options.reps)) options.reps = DEFAULT_REPS
  return options
}

function loadApiKey() {
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim()

  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/)
      if (!match) continue
      const value = match[1].replace(/^['"]|['"]$/g, '').trim()
      if (value) return value
    }
  } catch {
    // The error below is more useful than an fs error when no .env exists.
  }

  return ''
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))])
}

function round(value) {
  return Math.round(value * 10) / 10
}

function cleanError(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320)
}

async function responseError(response) {
  const raw = await response.text()
  try {
    const body = JSON.parse(raw)
    const providerRaw = body?.error?.metadata?.raw
    return cleanError(providerRaw || body?.error?.message || raw)
  } catch {
    return cleanError(raw)
  }
}

function readUsage(usage) {
  if (!usage || typeof usage !== 'object') return { outputTokens: null, reasoningTokens: null }
  const details = usage.completion_tokens_details
  return {
    outputTokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
    reasoningTokens:
      Number.isFinite(usage.reasoning_tokens)
        ? usage.reasoning_tokens
        : Number.isFinite(details?.reasoning_tokens)
          ? details.reasoning_tokens
          : null,
  }
}

async function runTurn({ apiKey, model, messages, rep, turn }) {
  const started = performance.now()
  let firstEventAt = null
  let firstTextAt = null
  let answer = ''
  let usage = null
  let selectedModel = null
  let reasoningObserved = false

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'GIDEON model benchmark',
      },
      body: JSON.stringify({
        model,
        messages,
        // The benchmark is specifically for the no-thinking voice path.
        reasoning: { effort: 'none', exclude: true },
        provider: { sort: 'latency', allow_fallbacks: true },
        temperature: 0.2,
        max_tokens: 80,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok || !response.body) {
      return {
        model,
        selectedModel,
        rep,
        turn: turn.key,
        status: response.status,
        ok: false,
        firstEventMs: null,
        ttftMs: null,
        totalMs: Math.round(performance.now() - started),
        generationMs: null,
        outputTokens: null,
        reasoningTokens: null,
        tokensPerSecond: null,
        reasoningObserved,
        answer: '',
        error: await responseError(response),
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const consume = (line) => {
      if (!line.startsWith('data:')) return
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') return

      let chunk
      try {
        chunk = JSON.parse(raw)
      } catch {
        return
      }

      if (firstEventAt === null) firstEventAt = performance.now()
      if (typeof chunk.model === 'string') selectedModel = chunk.model
      if (chunk.usage) {
        usage = chunk.usage
        if (readUsage(usage).reasoningTokens > 0) reasoningObserved = true
      }

      const delta = chunk.choices?.[0]?.delta
      if (delta?.reasoning || delta?.reasoning_details?.length) reasoningObserved = true
      if (typeof delta?.content === 'string' && delta.content) {
        if (firstTextAt === null) firstTextAt = performance.now()
        answer += delta.content
      }
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consume(line.trimEnd())
    }
    buffer += decoder.decode()
    if (buffer) consume(buffer.trimEnd())

    const finished = performance.now()
    const totalMs = Math.round(finished - started)
    const ttftMs = firstTextAt === null ? null : Math.round(firstTextAt - started)
    const firstEventMs = firstEventAt === null ? null : Math.round(firstEventAt - started)
    const { outputTokens, reasoningTokens } = readUsage(usage)
    const generationMs = ttftMs === null ? null : Math.max(0, totalMs - ttftMs)

    return {
      model,
      selectedModel,
      rep,
      turn: turn.key,
      status: response.status,
      ok: Boolean(answer.trim()),
      firstEventMs,
      ttftMs,
      totalMs,
      generationMs,
      outputTokens,
      reasoningTokens,
      tokensPerSecond:
        outputTokens !== null && generationMs > 0
          ? round(outputTokens / (generationMs / 1000))
          : null,
      reasoningObserved,
      answer: answer.trim(),
      error: answer.trim() ? '' : 'The stream completed without answer text.',
    }
  } catch (error) {
    return {
      model,
      selectedModel,
      rep,
      turn: turn.key,
      status: 0,
      ok: false,
      firstEventMs: null,
      ttftMs: null,
      totalMs: Math.round(performance.now() - started),
      generationMs: null,
      outputTokens: null,
      reasoningTokens: null,
      tokensPerSecond: null,
      reasoningObserved,
      answer: '',
      error: cleanError(error instanceof Error ? error.message : error),
    }
  }
}

async function runConversation({ apiKey, model, rep }) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]
  const rows = []

  for (const turn of TURNS) {
    const userMessage = { role: 'user', content: turn.prompt }
    const row = await runTurn({ apiKey, model: model.id, messages: [...messages, userMessage], rep, turn })
    rows.push({ ...row, modelLabel: model.label })
    messages.push(userMessage)
    if (row.answer) messages.push({ role: 'assistant', content: row.answer })
  }

  return rows
}

function values(rows, key) {
  return rows.map((row) => row[key]).filter((value) => typeof value === 'number')
}

function modelSummary(model, rows) {
  const successful = rows.filter((row) => row.ok)
  const ttft = values(successful, 'ttftMs')
  const total = values(successful, 'totalMs')
  const generation = values(successful, 'generationMs')
  const rates = values(successful, 'tokensPerSecond')
  const reasoningRows = rows.filter((row) => row.reasoningObserved || (row.reasoningTokens ?? 0) > 0)
  const errors = rows.filter((row) => !row.ok && row.error).map((row) => row.error)

  return {
    id: model.id,
    label: model.label,
    requests: rows.length,
    successes: successful.length,
    ttftP50Ms: percentile(ttft, 50),
    ttftP95Ms: percentile(ttft, 95),
    totalP50Ms: percentile(total, 50),
    totalP95Ms: percentile(total, 95),
    generationP50Ms: percentile(generation, 50),
    tokensPerSecondP50: percentile(rates, 50),
    reasoningObserved: reasoningRows.length > 0,
    reasoningRows: reasoningRows.length,
    errors: [...new Set(errors)].slice(0, 2),
  }
}

function cell(value, suffix = '') {
  return value === null || value === undefined ? '—' : `${value}${suffix}`
}

function markdownReport({ options, summaries, rows }) {
  const lines = [
    '# OpenRouter model benchmark',
    '',
    `No-thinking streaming test, ${options.reps} conversation${options.reps === 1 ? '' : 's'} per model.`,
    '',
    '| model | success | TTFT p50 / p95 | total p50 / p95 | generation p50 | output tok/s p50 | thinking observed |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ]

  for (const summary of summaries) {
    lines.push(
      `| ${summary.label} | ${summary.successes}/${summary.requests} | ${cell(summary.ttftP50Ms, ' ms')} / ${cell(summary.ttftP95Ms, ' ms')} | ${cell(summary.totalP50Ms, ' ms')} / ${cell(summary.totalP95Ms, ' ms')} | ${cell(summary.generationP50Ms, ' ms')} | ${cell(summary.tokensPerSecondP50)} | ${summary.reasoningObserved ? `yes (${summary.reasoningRows})` : 'no'} |`,
    )
    for (const error of summary.errors) lines.push(`| ↳ error |  | ${error} |  |  |  |  |`)
  }

  lines.push('', '## Answer samples', '')
  for (const model of summaries) {
    lines.push(`### ${model.label}`, '')
    for (const turn of TURNS) {
      const sample = rows.find((row) => row.model === model.id && row.turn === turn.key && row.answer)
      lines.push(`- ${turn.key}: ${sample?.answer || '(no answer)'}`)
    }
    lines.push('')
  }

  lines.push(
    'Metrics: TTFT is time to the first non-empty text chunk; total is request start to stream end; generation is total minus TTFT; throughput uses provider completion-token usage when returned.',
    'Thinking is checked from streamed reasoning fields and usage, not inferred from the model name.',
  )
  return lines.join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const apiKey = loadApiKey()
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is required in the environment or .env')
    process.exitCode = 1
    return
  }

  const models = MODELS.filter((model) => !options.modelIds || options.modelIds.includes(model.id))
  if (!models.length) {
    console.error('No selected model matches the benchmark model list.')
    process.exitCode = 1
    return
  }

  const rows = []
  for (let rep = 1; rep <= options.reps; rep += 1) {
    for (const model of models) {
      process.stderr.write(`Testing ${model.label}, conversation ${rep}/${options.reps}...\n`)
      rows.push(...(await runConversation({ apiKey, model, rep })))
    }
  }

  const summaries = models.map((model) => modelSummary(model, rows.filter((row) => row.model === model.id)))
  const report = {
    generatedAt: new Date().toISOString(),
    reasoning: { effort: 'none', exclude: true },
    repetitions: options.reps,
    turns: TURNS.map(({ key, prompt }) => ({ key, prompt })),
    summaries,
    rows,
  }

  if (options.format === 'json') console.log(JSON.stringify(report, null, 2))
  else console.log(markdownReport({ options, summaries, rows }))
}

await main()
