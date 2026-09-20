import { expect, it } from 'vitest'
import { captureTables } from './table-mediation'
import { sourceNumber } from './data-values'
const source = { title: 'Export', url: 'https://example.org/export', fetchedAt: '2026-09-20' }
it('captures quoted CSV with literal separators, newlines, and source line numbers', () => {
  const [t] = captureTables('Name,Value\n"A, B",1.20\n"Multi\nline",0\n', source, 'csv')
  expect(t.rows).toEqual([{ id: 'r2', line: 2, cells: ['A, B', '1.20'] }, { id: 'r3', line: 3, cells: ['Multi\nline', '0'] }])
})
it('captures TSV and flat JSON preserving numeric lexemes and actual record lines', () => {
  expect(captureTables('Name\tValue\nA\t2', source, 'tsv')[0].rows[0].cells).toEqual(['A', '2'])
  const [t] = captureTables('[\n {"Name":"A", "Value":1.20},\n {"Value":null, "Name":"B"}\n]', source, 'json')
  expect(t.rows.map(r => [r.line, ...r.cells])).toEqual([[2, 'A', '1.20'], [3, 'B', 'null']])
})
it.each(['A,B\n"open,2', 'A,B\n1,2,3', '[{"A":"x","B":{"nested":2}}]', '[{"A":1,"A":2,"B":3}]'])('refuses malformed or ambiguous export %s', text => expect(captureTables(text, source, 'bad')).toEqual([]))
it('retains 400 rows without clipping', () => expect(captureTables(`A,B\n${Array.from({ length: 400 }, (_, i) => `${i},1`).join('\n')}`, source, 'large')[0].rows).toHaveLength(400))
it('requires explicit numeric locale and reconciles scale annotations', () => {
  expect(sourceNumber('1,234.50', '', 'en-US')?.value).toBe(1234.5)
  expect(sourceNumber('1.234,50', '', 'de-DE')?.value).toBe(1234.5)
  expect(sourceNumber('1 234,50', '', 'fr-FR')?.value).toBe(1234.5)
  expect(sourceNumber('1,234')).toBeNull()
  expect(sourceNumber('2', 'Revenue (millions USD)')?.value).toBe(2e6)
  expect(sourceNumber('2 billion USD', 'Revenue (millions USD)')).toBeNull()
})
