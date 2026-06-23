// Three preloaded demo sheets that double as a tour of the engine: SUM/percent
// math (Budget), self-referential formula chains + a line sparkline (Fibonacci),
// and mixed absolute/relative references (Times table). Each returns A1-keyed raw
// inputs ready to hand to Workbook.loadJSON via coordKey conversion in App.

import { parseRef, coordKey } from './engine/address'
import type { RangeBox } from './engine/address'
import { Workbook } from './engine/workbook'
import type { WorkbookSnapshot } from './engine/workbook'
import type { CellFormat } from './engine/format'

export interface Demo {
  id: string
  name: string
  blurb: string
  build?: () => Record<string, string> // A1 ref -> raw input (single-sheet demos)
  snapshot?: () => WorkbookSnapshot // full multi-sheet workbooks
}

const budget = (): Record<string, string> => ({
  A1: 'Category',
  B1: 'Budget',
  C1: 'Spent',
  D1: 'Remaining',
  E1: 'Used',
  A2: 'Rent',
  B2: '1800',
  C2: '1800',
  A3: 'Groceries',
  B3: '600',
  C3: '542',
  A4: 'Transit',
  B4: '120',
  C4: '96',
  A5: 'Fun',
  B5: '250',
  C5: '310',
  A6: 'Savings',
  B6: '400',
  C6: '400',
  D2: '=B2-C2',
  D3: '=B3-C3',
  D4: '=B4-C4',
  D5: '=B5-C5',
  D6: '=B6-C6',
  E2: '=ROUND(C2/B2*100,0)&"%"',
  E3: '=ROUND(C3/B3*100,0)&"%"',
  E4: '=ROUND(C4/B4*100,0)&"%"',
  E5: '=ROUND(C5/B5*100,0)&"%"',
  E6: '=ROUND(C6/B6*100,0)&"%"',
  A8: 'TOTAL',
  B8: '=SUM(B2:B6)',
  C8: '=SUM(C2:C6)',
  D8: '=B8-C8',
  E8: '=ROUND(C8/B8*100,0)&"%"',
  G1: 'Spending',
  G2: '=SPARKLINE(C2:C6,"bar")',
  G4: 'Over budget?',
  G5: '=IF(C5>B5,"Fun: over by "&(C5-B5),"on track")',
})

const fibonacci = (): Record<string, string> => {
  const cells: Record<string, string> = { A1: 'n', B1: 'fib(n)', D1: 'Statistics' }
  cells.A2 = '1'
  cells.B2 = '0'
  cells.A3 = '2'
  cells.B3 = '1'
  for (let i = 4; i <= 15; i++) {
    cells['A' + i] = `=A${i - 1}+1`
    cells['B' + i] = `=B${i - 1}+B${i - 2}`
  }
  cells.D2 = 'sum'
  cells.E2 = '=SUM(B2:B15)'
  cells.D3 = 'max'
  cells.E3 = '=MAX(B2:B15)'
  cells.D4 = 'average'
  cells.E4 = '=ROUND(AVERAGE(B2:B15),2)'
  cells.D5 = 'golden ratio'
  cells.E5 = '=ROUND(B15/B14,6)'
  cells.D7 = 'growth'
  cells.E7 = '=SPARKLINE(B2:B15,"line")'
  return cells
}

const timesTable = (): Record<string, string> => {
  const cells: Record<string, string> = { A1: '×' }
  for (let k = 1; k <= 10; k++) {
    // header row B1..K1 and header column A2..A11
    const col = String.fromCharCode(65 + k) // B..K
    cells[`${col}1`] = String(k)
    cells[`A${k + 1}`] = String(k)
  }
  for (let r = 2; r <= 11; r++) {
    for (let k = 1; k <= 10; k++) {
      const col = String.fromCharCode(65 + k)
      // $A2 locks the column to A; B$1 locks the row to 1 — classic fill pattern.
      cells[`${col}${r}`] = `=$A${r}*${col}$1`
    }
  }
  cells.A13 = 'Diagonal sum'
  cells.B13 = '=B2+C3+D4+E5+F6+G7+H8+I9+J10+K11'
  return cells
}

// A multi-sheet workbook: raw regional sales on one sheet, cross-sheet aggregates +
// a defined name + formatting + a chart on another. Built through the real API and
// serialized, so it exercises exactly the features it shows off.
function salesDashboard(): WorkbookSnapshot {
  const wb = new Workbook()
  const sales = wb.activeSheetId
  wb.renameSheet(sales, 'Sales')

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']
  const north = [42, 48, 51, 60, 66, 71]
  const south = [30, 33, 38, 41, 47, 52]
  const west = [25, 29, 31, 36, 44, 49]
  const set = (a1: string, raw: string) => {
    const ref = parseRef(a1)
    if (ref) wb.setCell({ row: ref.row, col: ref.col }, raw, sales)
  }
  set('A1', 'Month')
  set('B1', 'North')
  set('C1', 'South')
  set('D1', 'West')
  set('E1', 'Total')
  months.forEach((m, i) => {
    const row = i + 2
    set(`A${row}`, m)
    set(`B${row}`, String(north[i] * 1000))
    set(`C${row}`, String(south[i] * 1000))
    set(`D${row}`, String(west[i] * 1000))
    set(`E${row}`, `=SUM(B${row}:D${row})`)
  })
  set('A8', 'Total')
  set('B8', '=SUM(B2:B7)')
  set('C8', '=SUM(C2:C7)')
  set('D8', '=SUM(D2:D7)')
  set('E8', '=SUM(E2:E7)')

  const box = (a1: string, a2: string): RangeBox => {
    const f = parseRef(a1)!
    const t = parseRef(a2)!
    return { top: f.row, left: f.col, bottom: t.row, right: t.col }
  }
  wb.applyFormat(box('A1', 'E1'), { bold: true, align: 'center' }, sales)
  wb.applyFormat(box('B2', 'E8'), { nf: 'currency', decimals: 0 }, sales)
  wb.applyFormat(box('A8', 'E8'), { bold: true }, sales)

  // A defined name spanning the monthly totals.
  wb.setName('Revenue', 'Sales!E2:E7', sales)

  // A summary sheet that reads across via cross-sheet refs and a name.
  const summary = wb.addSheet('Summary')
  const sset = (a1: string, raw: string) => {
    const ref = parseRef(a1)
    if (ref) wb.setCell({ row: ref.row, col: ref.col }, raw, summary)
  }
  sset('A1', 'Region')
  sset('B1', 'Revenue')
  sset('C1', 'Share')
  sset('A2', 'North')
  sset('B2', '=Sales!B8')
  sset('A3', 'South')
  sset('B3', '=Sales!C8')
  sset('A4', 'West')
  sset('B4', '=Sales!D8')
  sset('C2', '=B2/$B$5')
  sset('C3', '=B3/$B$5')
  sset('C4', '=B4/$B$5')
  sset('A5', 'Total')
  sset('B5', '=SUM(Revenue)')
  sset('A7', 'Best month')
  sset('B7', '=TEXT(INDEX(Sales!A2:A7,MATCH(MAX(Revenue),Revenue,0)),"@")')
  sset('A8', 'Avg / month')
  sset('B8', '=AVERAGE(Revenue)')

  const sfmt = (a1: string, a2: string, patch: CellFormat) => {
    const f = parseRef(a1)!
    const t = parseRef(a2)!
    wb.applyFormat({ top: f.row, left: f.col, bottom: t.row, right: t.col }, patch, summary)
  }
  sfmt('A1', 'C1', { bold: true, align: 'center' })
  sfmt('B2', 'B5', { nf: 'currency', decimals: 0 })
  sfmt('C2', 'C4', { nf: 'percent', decimals: 1 })
  sfmt('A5', 'B5', { bold: true })
  sfmt('B8', 'B8', { nf: 'currency', decimals: 0 })

  wb.addChart(
    { type: 'column', range: box('A1', 'B4'), title: 'Revenue by region', x: 360, y: 30, w: 380, h: 250, headers: true, labels: true },
    summary,
  )
  wb.addChart(
    { type: 'pie', range: box('A2', 'B4'), title: 'Share', x: 360, y: 300, w: 380, h: 230, headers: false, labels: true },
    summary,
  )

  wb.setActiveSheet(summary)
  return wb.serialize()
}

export const DEMOS: Demo[] = [
  { id: 'sales', name: 'Sales Dashboard', blurb: 'Multi-sheet: cross-sheet refs, a named range, formatting & charts', snapshot: salesDashboard },
  { id: 'budget', name: 'Monthly Budget', blurb: 'SUM, percentages, IF and a bar sparkline', build: budget },
  { id: 'fib', name: 'Fibonacci & Stats', blurb: 'Self-referential formula chains and a line sparkline', build: fibonacci },
  { id: 'times', name: 'Times Table', blurb: 'A 10×10 grid from one mixed-reference formula', build: timesTable },
]

/** Convert an A1-keyed demo into the coordKey-keyed cell map Workbook.loadJSON wants. */
export function demoToCells(demo: Demo): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [a1, raw] of Object.entries(demo.build?.() ?? {})) {
    const ref = parseRef(a1)
    if (ref) out[coordKey(ref.row, ref.col)] = raw
  }
  return out
}
