/** Deterministic flat exports only: nested objects and ambiguous headers are refused. */
export function structuredRows(text: string): Array<{ line: number; cells: string[] }> | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    try {
      const data: unknown = JSON.parse(trimmed)
      if (!Array.isArray(data) || !data.length || data.length > 400 || !data.every(r => r && typeof r === 'object' && !Array.isArray(r))) return null
      const headers = Object.keys(data[0])
      if (headers.length < 2 || headers.length > 16 || data.some(r => Object.keys(r).length !== headers.length || headers.some(h => !Object.hasOwn(r, h)))) return null
      if (data.some(r => Object.values(r).some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v)))) return null
      // Preserve numeric lexemes (1.20 stays 1.20) and actual object-start lines.
      const records: Array<{ line: number; cells: string[] }> = []
      let inString = false, escaped = false, start = -1, line = 1, recordLine = 1
      for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (c === '\n') line++
        if (inString) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') inString = false; continue }
        if (c === '"') inString = true
        else if (c === '{') { start = i; recordLine = line }
        else if (c === '}') {
          const fields = new Map<string, string>()
          for (const m of text.slice(start, i + 1).matchAll(/("(?:\\.|[^"\\])*")\s*:\s*("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
            const key = JSON.parse(m[1])
            if (fields.has(key)) return null
            fields.set(key, m[2].startsWith('"') ? JSON.parse(m[2]) : m[2])
          }
          if (fields.size !== headers.length || headers.some(h => !fields.has(h))) return null
          records.push({ line: recordLine, cells: headers.map(h => fields.get(h)!) })
        }
      }
      return [{ line: 1, cells: headers }, ...records]
    } catch { return null }
  }
  const first = text.split(/\r?\n/, 1)[0]
  const separator = first.includes('\t') ? '\t' : first.includes(',') ? ',' : null
  if (!separator) return null
  const rows: Array<{ line: number; cells: string[] }> = []
  let cells: string[] = [], cell = '', quoted = false, closed = false, line = 1, start = 1
  const pushCell = () => { cells.push(cell); cell = ''; closed = false }
  const pushRow = () => { pushCell(); rows.push({ line: start, cells }); cells = []; start = line + 1 }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else { quoted = false; closed = true } }
      else { cell += c; if (c === '\n') line++ }
    } else if (c === '"') { if (cell || closed) return null; quoted = true }
    else if (c === separator) pushCell()
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; pushRow(); line++ }
    else { if (closed) return null; cell += c }
    if (rows.length > 400 || cells.length > 16 || cell.length > 1000) return null
  }
  if (quoted) return null
  if (cell || cells.length || closed) pushRow()
  return rows.length >= 2 ? rows : null
}
