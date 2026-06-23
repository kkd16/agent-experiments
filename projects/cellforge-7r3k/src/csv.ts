// CSV / TSV serialization. Export writes computed display values (so the file
// carries data, not formulas); import drops raw text at A1. Both are RFC-4180-ish:
// fields with commas, quotes, or newlines are double-quoted with "" escaping.

import type { Coord } from './engine/address'
import type { Workbook } from './engine/workbook'

function quoteField(s: string, delim: string): string {
  if (s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

/** Tight bounding box of all non-empty cells, or null when the sheet is empty. */
export function usedBounds(wb: Workbook): { rows: number; cols: number } | null {
  let maxRow = -1
  let maxCol = -1
  for (let r = 0; r < wb.rows; r++) {
    for (let c = 0; c < wb.cols; c++) {
      if (wb.getRaw({ row: r, col: c }) !== '') {
        if (r > maxRow) maxRow = r
        if (c > maxCol) maxCol = c
      }
    }
  }
  if (maxRow < 0) return null
  return { rows: maxRow + 1, cols: maxCol + 1 }
}

export function toCSV(wb: Workbook, delim = ','): string {
  const bounds = usedBounds(wb)
  if (!bounds) return ''
  const lines: string[] = []
  for (let r = 0; r < bounds.rows; r++) {
    const row: string[] = []
    for (let c = 0; c < bounds.cols; c++) {
      row.push(quoteField(wb.getDisplay({ row: r, col: c }), delim))
    }
    lines.push(row.join(delim))
  }
  return lines.join('\n')
}

/** Parse delimited text into a grid of string fields (handles quoted fields). */
export function parseDelimited(text: string, delim = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === delim) {
      pushField()
      i++
      continue
    }
    if (ch === '\r') {
      i++
      continue
    }
    if (ch === '\n') {
      pushRow()
      i++
      continue
    }
    field += ch
    i++
  }
  // flush the trailing field/row (unless the text ended on a clean newline)
  if (field !== '' || row.length > 0) pushRow()
  return rows
}

/** Turn a parsed grid into workbook entries anchored at `origin`. */
export function gridToEntries(grid: string[][], origin: Coord = { row: 0, col: 0 }): Array<{ coord: Coord; raw: string }> {
  const entries: Array<{ coord: Coord; raw: string }> = []
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const raw = grid[r][c]
      if (raw !== '') entries.push({ coord: { row: origin.row + r, col: origin.col + c }, raw })
    }
  }
  return entries
}

/** Build a TSV blob for the OS clipboard from a rectangular selection of display values. */
export function selectionToTSV(wb: Workbook, top: number, left: number, bottom: number, right: number): string {
  const lines: string[] = []
  for (let r = top; r <= bottom; r++) {
    const row: string[] = []
    for (let c = left; c <= right; c++) row.push(wb.getDisplay({ row: r, col: c }))
    lines.push(row.join('\t'))
  }
  return lines.join('\n')
}
