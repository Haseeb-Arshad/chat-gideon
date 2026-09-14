import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import type { TableBlock, TableRow } from '../../../lib/cards/schema'
import { rise } from '../stagger'

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

  const sortable = (index: number) =>
    block.columns[index].kind === 'number' && block.rows.every((row) => Number.isFinite(row.cells[index]?.value))

  const rows = sorted(block, order)
  const shown = open ? rows : rows.slice(0, SHOWN_ROWS)

  const toggle = (key: string) =>
    setOrder((current) => {
      if (current?.key !== key) return { key, direction: 'descending' }
      if (current.direction === 'descending') return { key, direction: 'ascending' }
      return null
    })

  return (
    <figure className="card-table-block" style={rise(start)}>
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
                    </th>
                  ) : (
                    <td key={column.key} data-kind={column.kind}>
                      {cell.text || '—'}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > SHOWN_ROWS ? (
        <button type="button" className="card-table-more" onClick={() => setOpen((value) => !value)}>
          {open ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      ) : null}
    </figure>
  )
}

function sorted(block: TableBlock, order: Order): TableRow[] {
  if (!order) return block.rows
  const index = block.columns.findIndex((column) => column.key === order.key)
  if (index < 0) return block.rows
  const sign = order.direction === 'descending' ? -1 : 1
  return [...block.rows].sort((a, b) => sign * ((a.cells[index].value ?? 0) - (b.cells[index].value ?? 0)))
}
