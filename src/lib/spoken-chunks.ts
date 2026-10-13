/** The opening chunk is cut aggressively so speech starts sooner. */
const FIRST_CHUNK_MAX = 48
const FIRST_CHUNK_MIN = 24
const CHUNK_MAX = 220
const CHUNK_MIN = 90

export interface SpeakableChunk {
  text: string
  /** Index in the fed text immediately after this chunk. */
  end: number
  /** Exact source span occupied by `text`, excluding consumed whitespace. */
  startChar: number
  endChar: number
}

/**
 * Pulls complete speakable chunks off the front of a buffer.
 * `first` uses the tighter opening budget; `flush` releases the tail.
 */
export function splitSpeakable(
  value: string,
  options: { flush?: boolean; first?: boolean } = {},
): { chunks: SpeakableChunk[]; remainder: string; consumed: number } {
  const { flush = false, first = false } = options
  const chunks: SpeakableChunk[] = []
  let consumed = 0
  let opening = first

  const budget = () => (opening ? FIRST_CHUNK_MAX : CHUNK_MAX)
  const floor = () => (opening ? FIRST_CHUNK_MIN : CHUNK_MIN)

  const take = (upTo: number) => {
    const raw = value.slice(consumed, upTo)
    const text = raw.trim()
    consumed = upTo
    if (text) {
      const leading = raw.length - raw.trimStart().length
      const trailing = raw.trimEnd().length
      chunks.push({ text, end: consumed, startChar: consumed - raw.length + leading, endChar: consumed - raw.length + trailing })
      opening = false
    }
  }

  for (;;) {
    const rest = value.slice(consumed)
    if (!rest.trim()) break

    // A sentence ending inside the current budget is always the best cut.
    const sentence = /[.!?](?:["')\]]+)?(?=\s|$)/g
    sentence.lastIndex = 0
    let sentenceEnd = -1
    let match: RegExpExecArray | null
    while ((match = sentence.exec(rest))) {
      const end = match.index + match[0].length
      if (end <= budget()) sentenceEnd = end
      break
    }
    if (sentenceEnd > 0) {
      take(consumed + sentenceEnd)
      continue
    }

    if (rest.length <= budget()) break

    // No sentence in range: cut at the latest clause break, then whitespace.
    const window = rest.slice(0, budget())
    const clause = Math.max(
      window.lastIndexOf(', '),
      window.lastIndexOf('; '),
      window.lastIndexOf(': '),
      window.lastIndexOf(' — '),
    )
    const space = window.lastIndexOf(' ')
    const cut =
      clause >= floor() ? clause + 1 : space >= floor() ? space : budget()
    take(consumed + cut)
  }

  if (flush && value.slice(consumed).trim()) take(value.length)

  return { chunks, remainder: value.slice(consumed), consumed }
}


