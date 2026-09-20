import type { TableBlock } from './schema'

/** Spreadsheet-safe CSV; JSON export retains exact unmodified source text. */
export function tableCsv(table: TableBlock): string {
  const encode = (raw: string) => {
    const number = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)
    const safe = !number && (/^\s*[=+@-]/.test(raw) || /^[\t\r]/.test(raw)) ? `'${raw}` : raw
    return `"${safe.replaceAll('"', '""')}"`
  }
  return [table.columns.map((column) => column.label), ...table.rows.map((row) => row.cells.map((cell) => cell.text))].map((row) => row.map(encode).join(',')).join('\r\n')
}

export function tableJson(table: TableBlock): string {
  return JSON.stringify({ caption: table.caption, evidence: table.evidence, columns: table.columns, rows: table.rows }, null, 2)
}
