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

// A single-sheet tour of v3: dynamic arrays that spill, LAMBDA/MAP/REDUCE, the
// array-query functions (UNIQUE/SORT/FILTER), and a model wired up for Goal Seek.
function dynamicArrays(): WorkbookSnapshot {
  const wb = new Workbook()
  const id = wb.activeSheetId
  wb.renameSheet(id, 'Arrays')
  const set = (a1: string, raw: string) => {
    const ref = parseRef(a1)
    if (ref) wb.setCell({ row: ref.row, col: ref.col }, raw, id)
  }
  const fmt = (a1: string, a2: string, patch: CellFormat) => {
    const f = parseRef(a1)!
    const t = parseRef(a2)!
    wb.applyFormat({ top: f.row, left: f.col, bottom: t.row, right: t.col }, patch, id)
  }

  set('A1', 'Dynamic arrays — one formula fills a whole region (the blue outline is the spill)')
  fmt('A1', 'A1', { bold: true })

  // SEQUENCE / MAP / REDUCE — each anchor spills to the right or down.
  set('A3', 'SEQUENCE(1,8)')
  set('C3', '=SEQUENCE(1,8)')
  set('A5', 'n² with MAP + LAMBDA')
  set('C5', '=MAP(SEQUENCE(1,8), LAMBDA(n, n*n))')
  set('A7', 'Σ n³ with REDUCE')
  set('C7', '=REDUCE(0, SEQUENCE(8), LAMBDA(acc, n, acc + n^3))')
  fmt('A3', 'A7', { color: '#97a0b8' })

  // A little dataset to query with array functions.
  const rows = [
    ['North', 'Ana', 64],
    ['South', 'Ben', 38],
    ['East', 'Cy', 72],
    ['West', 'Dee', 45],
    ['North', 'Eli', 51],
    ['South', 'Fay', 29],
    ['East', 'Gus', 58],
    ['West', 'Hana', 80],
    ['North', 'Ivy', 47],
  ]
  set('A10', 'Region')
  set('B10', 'Rep')
  set('C10', 'Sales')
  rows.forEach((r, i) => {
    const row = 11 + i
    set(`A${row}`, String(r[0]))
    set(`B${row}`, String(r[1]))
    set(`C${row}`, String(r[2]))
  })
  fmt('A10', 'C10', { bold: true, align: 'center' })
  fmt('C11', 'C19', { nf: 'plain', decimals: 0 })

  set('E10', 'Distinct regions')
  set('E11', '=UNIQUE(A11:A19)')
  set('G10', 'Big deals (>50), sorted')
  set('G11', '=SORT(FILTER(C11:C19, C11:C19>50), 1, -1)')
  set('I10', 'Total of big deals')
  set('I11', '=SUM(FILTER(C11:C19, C11:C19>50))')
  fmt('E10', 'I10', { bold: true })
  fmt('G11', 'G19', { nf: 'plain', decimals: 0 })

  // A LET expression that names intermediates, and a Goal-Seek-ready model. Placed
  // below the UNIQUE spill (E11:E14) so the dynamic array has room to grow.
  set('E17', 'LET summary')
  set('E18', '=LET(avg, AVERAGE(C11:C19), n, COUNT(C11:C19), "avg " & ROUND(avg,1) & " across " & n & " deals")')
  fmt('E17', 'E17', { bold: true })

  set('A22', 'Break-even model  ·  try Goal Seek: set B26 to 0 by changing B25')
  fmt('A22', 'A22', { bold: true })
  set('A23', 'Price / unit')
  set('B23', '12')
  set('A24', 'Fixed cost')
  set('B24', '500')
  set('A25', 'Units sold')
  set('B25', '60')
  set('A26', 'Profit')
  set('B26', '=B23*B25 - B24')
  fmt('A23', 'A26', { color: '#97a0b8' })
  fmt('B23', 'B26', { nf: 'currency', decimals: 0 })

  wb.setActiveSheet(id)
  return wb.serialize()
}

// A single-sheet tour of v4: GROUPBY/PIVOTBY pivots, a spill-range reference (`A1#`)
// that names a whole dynamic array, recursive lambdas via defined names, XMATCH, and
// a model ready to explore with the Data Table dialog.
function analysisLab(): WorkbookSnapshot {
  const wb = new Workbook()
  const id = wb.activeSheetId
  wb.renameSheet(id, 'Analysis')
  const set = (a1: string, raw: string) => {
    const ref = parseRef(a1)
    if (ref) wb.setCell({ row: ref.row, col: ref.col }, raw, id)
  }
  const fmt = (a1: string, a2: string, patch: CellFormat) => {
    const f = parseRef(a1)!
    const t = parseRef(a2)!
    wb.applyFormat({ top: f.row, left: f.col, bottom: t.row, right: t.col }, patch, id)
  }

  set('A1', 'Analysis Lab — pivots, spill-range refs (A1#) and recursive lambdas, all live')
  fmt('A1', 'A1', { bold: true })

  // Source dataset: Region · Quarter · Rep · Sales.
  const rows: Array<[string, string, string, number]> = [
    ['North', 'Q1', 'Ana', 40],
    ['South', 'Q1', 'Ben', 30],
    ['East', 'Q1', 'Cy', 25],
    ['North', 'Q2', 'Dee', 55],
    ['South', 'Q2', 'Eli', 33],
    ['East', 'Q2', 'Fay', 41],
    ['North', 'Q1', 'Gus', 20],
    ['South', 'Q2', 'Hana', 22],
    ['East', 'Q1', 'Ivy', 30],
    ['North', 'Q2', 'Jo', 18],
    ['South', 'Q1', 'Kim', 27],
    ['East', 'Q2', 'Lee', 19],
  ]
  set('A3', 'Region')
  set('B3', 'Quarter')
  set('C3', 'Rep')
  set('D3', 'Sales')
  rows.forEach((r, i) => {
    const row = 4 + i
    set(`A${row}`, r[0])
    set(`B${row}`, r[1])
    set(`C${row}`, r[2])
    set(`D${row}`, String(r[3]))
  })
  fmt('A3', 'D3', { bold: true, align: 'center' })
  fmt('D4', `D${3 + rows.length}`, { nf: 'currency', decimals: 0 })

  // GROUPBY — one spilling formula collapses the rows to a total per region.
  set('F3', 'GROUPBY region → total')
  set('F4', '=GROUPBY(A4:A15, D4:D15, SUM)')
  fmt('F3', 'F3', { bold: true })

  // A spill-range reference (`F4#`) names the WHOLE GROUPBY array — sum its 2nd
  // column for a grand total that tracks the pivot as the data changes.
  set('F8', 'Grand total via F4#')
  set('G8', '=SUM(CHOOSECOLS(F4#, 2))')
  fmt('F8', 'F8', { bold: true })
  fmt('G8', 'G8', { nf: 'currency', decimals: 0 })

  // PIVOTBY — a 2-D pivot: regions down, quarters across.
  set('F11', 'PIVOTBY region × quarter')
  set('F12', '=PIVOTBY(A4:A15, B4:B15, D4:D15, SUM)')
  fmt('F11', 'F11', { bold: true })

  // Recursive lambdas, defined as workbook names (the depth guard stops runaways).
  wb.setName('FACT', 'LAMBDA(n, IF(n<=1, 1, n*FACT(n-1)))', id)
  wb.setName('FIB', 'LAMBDA(n, IF(n<2, n, FIB(n-1)+FIB(n-2)))', id)
  set('A18', 'Recursive lambdas (defined names)')
  fmt('A18', 'A18', { bold: true })
  set('A19', '="FACT(8) = " & FACT(8)')
  set('A20', '="FIB(12) = " & FIB(12)')
  set('A21', '="top rep = " & INDEX(C4:C15, XMATCH(MAX(D4:D15), D4:D15))')
  fmt('A19', 'A21', { color: '#97a0b8' })

  // A what-if model — open the Data Table dialog to sweep price × units.
  set('A24', 'Profit model  ·  try Data Table: formula B29, col input B25, row input B28')
  fmt('A24', 'A24', { bold: true })
  set('A25', 'Price / unit')
  set('B25', '14')
  set('A26', 'Variable cost')
  set('B26', '6')
  set('A27', 'Fixed cost')
  set('B27', '500')
  set('A28', 'Units sold')
  set('B28', '90')
  set('A29', 'Profit')
  set('B29', '=(B25-B26)*B28 - B27')
  fmt('A25', 'A29', { color: '#97a0b8' })
  fmt('B25', 'B29', { nf: 'currency', decimals: 0 })

  wb.setActiveSheet(id)
  return wb.serialize()
}

// A single-sheet tour of v5: a linear program wired for the Solver. A small factory
// chooses how many of two products to make to maximize profit, limited by two shared
// resources. The Solver auto-detects the model is linear and finds the exact optimum
// (chairs = 24, tables = 14, profit = $2,200) with the simplex method. A second block
// is a nonlinear least-squares fit the Solver minimizes with its Nelder–Mead engine.
function optimizationLab(): WorkbookSnapshot {
  const wb = new Workbook()
  const id = wb.activeSheetId
  wb.renameSheet(id, 'Optimize')
  const set = (a1: string, raw: string) => {
    const ref = parseRef(a1)
    if (ref) wb.setCell({ row: ref.row, col: ref.col }, raw, id)
  }
  const fmt = (a1: string, a2: string, patch: CellFormat) => {
    const f = parseRef(a1)!
    const t = parseRef(a2)!
    wb.applyFormat({ top: f.row, left: f.col, bottom: t.row, right: t.col }, patch, id)
  }

  set('A1', 'Optimization Lab — open  ⚖ Solver  and maximize D7 by changing B5:B6, subject to the resource rows')
  fmt('A1', 'A1', { bold: true })

  // ---- A linear production-mix model (the headline LP) ----
  set('A3', 'Production plan — how many of each product to make for the most profit')
  fmt('A3', 'A3', { color: '#97a0b8' })
  set('A4', 'Product')
  set('B4', 'Make')
  set('C4', 'Profit / unit')
  set('D4', 'Profit')
  set('A5', 'Chairs')
  set('B5', '0') // ← a changing cell
  set('C5', '45')
  set('D5', '=B5*C5')
  set('A6', 'Tables')
  set('B6', '0') // ← a changing cell
  set('C6', '80')
  set('D6', '=B6*C6')
  set('A7', 'TOTAL')
  set('D7', '=SUM(D5:D6)') // ← the objective
  fmt('A4', 'D4', { bold: true, align: 'center' })
  fmt('A7', 'D7', { bold: true })
  fmt('C5', 'D7', { nf: 'currency', decimals: 0 })

  set('A9', 'Resource')
  set('B9', 'Used')
  set('C9', 'Available')
  set('D9', 'Slack')
  set('A10', 'Wood (board-ft)')
  set('B10', '=5*B5+20*B6') // chairs use 5, tables 20
  set('C10', '400')
  set('D10', '=C10-B10')
  set('A11', 'Labor (hours)')
  set('B11', '=10*B5+15*B6') // chairs use 10, tables 15
  set('C11', '450')
  set('D11', '=C11-B11')
  fmt('A9', 'D9', { bold: true, align: 'center' })

  set('A13', 'Solver setup → objective D7 · Max · changing B5:B6 · constraints  B10 ≤ C10  and  B11 ≤ C11')
  fmt('A13', 'A13', { color: '#97a0b8' })
  set('A14', 'Exact optimum (simplex): Chairs 24, Tables 14 → $2,200 profit. Both resources bind.')
  fmt('A14', 'A14', { color: '#97a0b8' })

  // ---- A nonlinear model: least-squares line fit, minimized by the Solver ----
  set('F3', 'Nonlinear fit — find slope & intercept that minimize squared error (J3)')
  fmt('F3', 'F3', { color: '#97a0b8' })
  set('F4', 'x')
  set('G4', 'y')
  set('H4', 'ŷ = m·x + b')
  set('I4', 'error²')
  const xs = [1, 2, 3, 4, 5]
  const ys = [2.1, 4.3, 5.9, 8.2, 9.8]
  xs.forEach((x, i) => {
    const row = 5 + i
    set(`F${row}`, String(x))
    set(`G${row}`, String(ys[i]))
    set(`H${row}`, `=$I$1*F${row}+$I$2`)
    set(`I${row}`, `=(G${row}-H${row})^2`)
  })
  fmt('F4', 'I4', { bold: true, align: 'center' })
  set('H1', 'slope m')
  set('I1', '0') // ← changing cell
  set('H2', 'intercept b')
  set('I2', '0') // ← changing cell
  set('F11', 'SSE (minimize)')
  set('I11', '=SUM(I5:I9)') // ← the objective for the nonlinear solve
  fmt('F11', 'I11', { bold: true })
  set('F12', 'Solver setup → objective I11 · Min · changing I1:I2 · no constraints, uncheck non-negative')
  fmt('F12', 'F12', { color: '#97a0b8' })
  fmt('H1', 'H2', { color: '#97a0b8' })

  wb.setActiveSheet(id)
  return wb.serialize()
}

export const DEMOS: Demo[] = [
  { id: 'optimize', name: 'Optimization Lab', blurb: 'A linear program + a nonlinear fit, both solved by the ⚖ Solver (exact simplex & Nelder–Mead)', snapshot: optimizationLab },
  { id: 'analysis', name: 'Analysis Lab', blurb: 'GROUPBY/PIVOTBY pivots, spill-range refs (A1#), recursive lambdas & a Data-Table model', snapshot: analysisLab },
  { id: 'arrays', name: 'Dynamic Arrays', blurb: 'SEQUENCE/FILTER/SORT/UNIQUE spilling + LAMBDA/MAP and a Goal-Seek model', snapshot: dynamicArrays },
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
