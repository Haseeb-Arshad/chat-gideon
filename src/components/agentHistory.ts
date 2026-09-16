import type { ChatRole } from '../lib/openrouter'

export interface Message {
  id: string
  role: ChatRole
  content: string
  createdAt: string
}

export const INTERRUPTED = /\s*\[interrupted\]$/
const STORAGE_KEY = 'gideon-conversation-v2'

function isStoredMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<Message>
  return typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    typeof message.content === 'string' && typeof message.createdAt === 'string'
}

export function clearHistory() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* Storage is optional. */ }
}

export function restoreHistory(): Message[] | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    const parsed: unknown = JSON.parse(stored)
    if (Array.isArray(parsed) && parsed.length && parsed.every(isStoredMessage)) {
      return parsed.slice(-40)
    }
    clearHistory()
  } catch { clearHistory() }
  return null
}

export function persistHistory(messages: Message[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40))) } catch { /* Storage is optional. */ }
}
