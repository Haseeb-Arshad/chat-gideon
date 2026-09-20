import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import type { TableBlock, TableRow } from '../../../lib/cards/schema'
import { rise } from '../stagger'
import { tableCsv, tableJson } from '../../../lib/cards/table-export'

/** Past this many rows a table is folded, and opened by asking for the rest. */
const SHOWN_ROWS = 12

type Order = { key: string; direction: 'descending' | 'ascending' } | null

/**
 * Rows and columns, in a well.
 *
 * Numbers sit right-aligned in tabular figures with their unit said once in
 * the header. A number column can be sorted when every row has a value for
 * it: largest first, then smallest first, then back to the order the table
 * came in, which is the order its source gave.
 */
export function Table({ block, start, said }: { block: TableBlock; start: number; said?: Set<string> }) {
  const [order, setOrder] = useState<Order>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [locators, setLocators] = useState(false)

  const sortable = (index: number) =>
    block.columns[index].kind === 'number' && block.rows.every((row) => Number.isFinite(row.cells[index]?.value))

  const rows = sorted(block, order).filter((row) => !query || row.cells.some((cell) => cell.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
  const safePage = Math.min(page, Math.max(0, Math.ceil(rows.length / 50) - 1))
  const shown = open ? rows.slice(safePage * 50, safePage * 50 + 50) : rows.slice(0, SHOWN_ROWS)
  const download = (format: 'csv' | 'json') => {
    const blob = new Blob([format === 'csv' ? tableCsv(block) : tableJson(block)], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' })
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = `source-data.${format}`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const toggle = (key: string) =>
    setOrder((current) => {
      if (current?.key !== key) return { key, direction: 'descending' }
      if (current.direction === 'descending') return { key, direction: 'ascending' }
      return null
    })

  return (
    <figure className="card-table-block" style={rise(start)}>
      {block.evidence || block.rows.length > SHOWN_ROWS ? <div className="table-explore">
        <label>Filter rows <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} /></label>
        {query ? <><span role="status">{rows.length} of {block.rows.length} rows</span><button type="button" onClick={() => { setQuery(''); setPage(0) }}>Reset filter</button></> : null}
        <button type="button" onClick={() => download('csv')}>Export full CSV</button><button type="button" onClick={() => download('json')}>Export full JSON</button>
        {block.evidence ? <label><input type="checkbox" checked={locators} onChange={(event) => setLocators(event.target.checked)} />Source locators</label> : null}
      </div> : null}
      <div className="card-well card-table-scroll">
        <table className="card-table" data-row-headers={block.rowHeaders ? 'true' : undefined}>
          {block.caption ? <caption>{block.caption}</caption> : null}
          <thead>
            <tr>
              {block.columns.map((column, index) => {
                const direction = order?.key === column.key ? order.direction : undefined
                const heading = (
                  <>
                    <span>{column.label}</span>
                    {column.unit ? <small>{column.unit}</small> : null}
                  </>
                )
                return (
                  <th
                    key={column.key}
                    scope="col"
                    data-kind={column.kind}
                    title={locators ? `Source column ${index + 1}` : undefined}
                    aria-sort={sortable(index) ? (direction ?? 'none') : undefined}
                  >
                    {sortable(index) ? (
                      <button type="button" onClick={() => toggle(column.key)}>
                        {heading}
                        {direction === 'descending' ? (
                          <ArrowDown size={11} aria-hidden="true" />
                        ) : direction === 'ascending' ? (
                          <ArrowUp size={11} aria-hidden="true" />
                        ) : (
                          <ArrowUpDown size={11} aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      heading
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, rowIndex) => (
              <tr key={row.id} style={{ '--row': rowIndex } as CSSProperties} data-said={said?.has(row.id) ? 'true' : undefined}>
                {row.cells.map((cell, index) => {
                  const column = block.columns[index]
                  return index === 0 && block.rowHeaders ? (
                    <th key={column.key} scope="row">
                      {cell.text}
                      {locators && row.sourceLine ? <small className="source-locator">source line {row.sourceLine}</small> : null}
                    </th>
                  ) : (
                    <td key={column.key} data-kind={column.kind} title={locators && row.sourceLine ? `Source line ${row.sourceLine}, column ${index + 1}` : undefined}>
                      {column.visual === 'bar' && cell.value != null ? <InlineBar value={cell.value} values={block.rows.flatMap((row) => row.cells[index].value == null ? [] : [row.cells[index].value!])} /> : null}
                      <span className="table-cell-text">{cell.text || '—'}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length ? <p className="card-chart-summary">No source rows match this filter.</p> : null}
      {rows.length > SHOWN_ROWS ? (
        <button type="button" className="card-table-more" onClick={() => setOpen((value) => !value)}>
          {open ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      ) : null}
      {open && rows.length > 50 ? <nav className="table-explore" aria-label="Table pages"><button type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Previous rows</button><span>{safePage * 50 + 1}–{Math.min(rows.length, safePage * 50 + 50)} of {rows.length}</span><button type="button" disabled={(safePage + 1) * 50 >= rows.length} onClick={() => setPage(safePage + 1)}>Next rows</button></nav> : null}
      {block.evidence ? <details className="dataset-evidence"><summary>Data and methodology</summary><p>Dataset {block.evidence.datasetId} · version {block.evidence.version}</p><p>Retrieved {block.evidence.fetchedAt}</p><a href={block.evidence.sourceUrl} target="_blank" rel="noopener noreferrer">Open source</a><ul>{block.evidence.transforms.map((text, i) => <li key={i}>{text}</li>)}</ul><p>CSV protects spreadsheet formula cells; JSON preserves original cell text and provenance.</p></details> : null}
    </figure>
  )
}

function InlineBar({ value, values }: { value: number; values: number[] }) {
  const min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1
  const zero = -min / span * 100, point = (value - min) / span * 100
  return <i className="table-inline-bar" aria-hidden="true" style={{ left: `${Math.min(zero, point)}%`, width: `${Math.abs(point - zero)}%` }} />
}

function sorted(block: TableBlock, order: Order): TableRow[] {
  if (!order) return block.rows
  const index = block.columns.findIndex((column) => column.key === order.key)
  if (index < 0) return block.rows
  const sign = order.direction === 'descending' ? -1 : 1
  return [...block.rows].sort((a, b) => sign * ((a.cells[index].value ?? 0) - (b.cells[index].value ?? 0)))
}
