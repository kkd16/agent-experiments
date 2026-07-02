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

  // A structured table over the dataset — reference columns by name, no A1 ranges.
  wb.defineTable('Deals', { top: 2, left: 0, bottom: 3 + rows.length - 1, right: 3 }, id)
  set('F16', 'Structured table refs over Deals[…]')
  fmt('F16', 'F16', { bold: true })
  set('F17', '="Σ Deals[Sales] = " & SUM(Deals[Sales])')
  set('F18', '="rows = " & ROWS(Deals[#Data]) & " · avg = " & ROUND(AVERAGE(Deals[Sales]),1)')
  fmt('F17', 'F18', { color: '#97a0b8' })

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

// A single-sheet showcase of v6: mixed-integer programming + sensitivity. The headline
// is a 0/1 **capital-budgeting knapsack** — pick which projects to fund so total value is
// maximised without blowing the budget; each "Fund?" cell is a binary (0/1) decision the
// Solver's branch & bound nails exactly (the continuous relaxation would fund a *fraction*
// of a project — meaningless in the real world). A second block is the classic carpenter LP
// whose Solver "Sensitivity report" prints the shadow prices of the two binding resources.
function integerLab(): WorkbookSnapshot {
  const wb = new Workbook()
  const id = wb.activeSheetId
  wb.renameSheet(id, 'Integer Lab')
  const set = (a1: string, raw: string) => {
    const ref = parseRef(a1)
    if (ref) wb.setCell({ row: ref.row, col: ref.col }, raw, id)
  }
  const fmt = (a1: string, a2: string, patch: CellFormat) => {
    const f = parseRef(a1)!
    const t = parseRef(a2)!
    wb.applyFormat({ top: f.row, left: f.col, bottom: t.row, right: t.col }, patch, id)
  }

  // ---- 0/1 capital-budgeting knapsack (header row 2, projects rows 3..8) ----
  set('A1', 'Integer Programming Lab — open  ⚖ Solver, maximize B9 by changing C3:C8, with  C3:C8 bin  and  D9 ≤ G2')
  fmt('A1', 'A1', { bold: true })
  set('A2', 'Project')
  set('B2', 'Value ($M)')
  set('C2', 'Fund? (0/1)')
  set('D2', 'Used cost')
  fmt('A2', 'D2', { bold: true, align: 'center' })

  const projects: Array<[string, number, number]> = [
    ['Solar farm', 0.6, 4],
    ['Data center', 0.5, 3],
    ['Bridge retrofit', 0.4, 2],
    ['Fibre rollout', 0.35, 2.5],
    ['Desalination', 0.3, 2],
    ['Wind turbines', 0.45, 3.5],
  ]
  projects.forEach(([name, value, cost], i) => {
    const row = 3 + i
    set(`A${row}`, name)
    set(`B${row}`, String(value))
    set(`C${row}`, '0') // ← a binary changing cell
    set(`D${row}`, `=C${row}*${cost}`) // cost only counts if the project is funded
  })
  set('A9', 'TOTAL')
  set('B9', '=SUMPRODUCT(B3:B8,C3:C8)') // value funded — the objective
  set('D9', '=SUM(D3:D8)') // total cost used
  fmt('A9', 'D9', { bold: true })

  set('F2', 'Budget ($M)')
  set('G2', '8')
  fmt('F2', 'F2', { bold: true })
  set('F4', 'Solver setup → max B9 · change C3:C8 · constraints  C3:C8 bin  and  D9 ≤ G2')
  fmt('F4', 'F4', { color: '#97a0b8' })
  set('F5', 'Branch & bound finds the exact best subset of projects — not the fractional LP relaxation.')
  fmt('F5', 'F5', { color: '#97a0b8' })

  // ---- A continuous LP with a shadow-price story (the sensitivity report) ----
  set('A12', 'Carpenter LP — maximize profit, then read the Sensitivity report for shadow prices')
  fmt('A12', 'A12', { color: '#97a0b8' })
  set('A13', 'Product')
  set('B13', 'Make')
  set('C13', 'Profit/unit')
  set('D13', 'Profit')
  fmt('A13', 'D13', { bold: true, align: 'center' })
  set('A14', 'Chairs')
  set('B14', '0') // changing cell
  set('C14', '45')
  set('D14', '=B14*C14')
  set('A15', 'Tables')
  set('B15', '0') // changing cell
  set('C15', '80')
  set('D15', '=B15*C15')
  set('A16', 'TOTAL')
  set('D16', '=SUM(D14:D15)') // objective
  fmt('A16', 'D16', { bold: true })
  fmt('C14', 'D16', { nf: 'currency', decimals: 0 })
  set('A18', 'Resource')
  set('B18', 'Used')
  set('C18', 'Available')
  fmt('A18', 'C18', { bold: true, align: 'center' })
  set('A19', 'Wood')
  set('B19', '=5*B14+20*B15')
  set('C19', '400')
  set('A20', 'Labor')
  set('B20', '=10*B14+15*B15')
  set('C20', '450')
  set('A22', 'Solver: max D16 · change B14:B15 · constraints  B19 ≤ C19  and  B20 ≤ C20 → open Sensitivity report')
  fmt('A22', 'A22', { color: '#97a0b8' })
  set('A23', 'Shadow prices: wood $1/board-ft, labor $4/hour. The exact value of one more unit of each resource.')
  fmt('A23', 'A23', { color: '#97a0b8' })

  wb.setActiveSheet(id)
  return wb.serialize()
}

// A single-sheet showcase of v7: the new statistics & linear-algebra engine. The headline
// is a **live multiple regression** — `LINEST` spills the full Excel statistics block
// (coefficients, standard errors, R², F, residual df and sums of squares) straight into the
// grid, with `TREND` forecasting beyond the data. A second block runs a real **one-sample
// t-test** (t statistic → two-tailed p via `T.DIST.2T`, plus a 95% CI via `CONFIDENCE.T`),
// and a third **solves a 3×3 linear system** Ax = b with `MINVERSE`/`MMULT` and checks it
// against the textbook answer. A scatter chart sits over the regression data.
function statisticsLab(): WorkbookSnapshot {
  const wb = new Workbook()
  const id = wb.activeSheetId
  wb.renameSheet(id, 'Statistics Lab')
  const set = (a1: string, raw: string) => {
    const ref = parseRef(a1)
    if (ref) wb.setCell({ row: ref.row, col: ref.col }, raw, id)
  }
  const fmt = (a1: string, a2: string, patch: CellFormat) => {
    const f = parseRef(a1)!
    const t = parseRef(a2)!
    wb.applyFormat({ top: f.row, left: f.col, bottom: t.row, right: t.col }, patch, id)
  }
  const box = (a1: string, a2: string): RangeBox => {
    const f = parseRef(a1)!
    const t = parseRef(a2)!
    return { top: f.row, left: f.col, bottom: t.row, right: t.col }
  }

  // ---- Live multiple regression: ice-cream sales vs temperature & weekend ----
  set('A1', 'Statistics Lab — a live regression (LINEST), a t-test, and a solved linear system')
  fmt('A1', 'A1', { bold: true })
  set('A2', 'Predict daily sales from the day’s temperature and whether it’s a weekend. LINEST spills the full stats block →')
  fmt('A2', 'A2', { color: '#97a0b8' })

  set('A3', 'Temp °C (x₁)')
  set('B3', 'Weekend (x₂)')
  set('C3', 'Sales $ (y)')
  fmt('A3', 'C3', { bold: true, align: 'center' })
  const data: Array<[number, number, number]> = [
    [17, 0, 182],
    [21, 0, 215],
    [24, 1, 312],
    [28, 0, 264],
    [30, 1, 372],
    [22, 0, 221],
    [26, 1, 330],
    [19, 0, 196],
    [31, 0, 289],
    [27, 1, 341],
  ]
  data.forEach(([t, w, s], i) => {
    const row = 4 + i
    set(`A${row}`, String(t))
    set(`B${row}`, String(w))
    set(`C${row}`, String(s))
  })
  fmt('A4', 'C13', { align: 'center' })
  fmt('C4', 'C13', { nf: 'currency', decimals: 0 })

  // The marquee: one formula spills the 5×3 LINEST statistics block.
  set('E3', 'LINEST(C4:C13, A4:B13, TRUE, TRUE) — spills →')
  fmt('E3', 'E3', { color: '#97a0b8' })
  set('E4', '=LINEST(C4:C13,A4:B13,TRUE,TRUE)')
  // Annotate what each spilled row means.
  set('I4', '← m₂(weekend), m₁(temp), intercept')
  set('I5', '← standard errors')
  set('I6', '← R² · std error of estimate')
  set('I7', '← F statistic · residual df')
  set('I8', '← SSregression · SSresidual')
  fmt('I4', 'I8', { color: '#97a0b8' })
  fmt('E4', 'G8', { decimals: 3 })

  set('E10', 'Read-offs')
  fmt('E10', 'E10', { bold: true })
  set('E11', 'R² (fit quality)')
  set('G11', '=INDEX(E4#,3,1)')
  set('E12', 'Temp coefficient ($/°C)')
  set('G12', '=INDEX(E4#,1,2)')
  set('E13', 'Weekend premium ($)')
  set('G13', '=INDEX(E4#,1,1)')
  fmt('G11', 'G13', { decimals: 2 })

  // TREND: forecast sales for two new scenarios beyond the data. The scenario inputs
  // (temp, weekend) live in A18:B19; TREND predicts y for both rows at once.
  set('A15', 'Forecast (TREND) — predict beyond the data')
  fmt('A15', 'A15', { bold: true })
  set('A18', '33')
  set('B18', '0')
  set('A19', '33')
  set('B19', '1')
  fmt('A18', 'B19', { color: '#5b6480' })
  set('A16', 'Weekday @33°C')
  set('C16', '=ROUND(INDEX(TREND(C4:C13,A4:B13,A18:B19),1,1),0)')
  set('A17', 'Weekend @33°C')
  set('C17', '=ROUND(INDEX(TREND(C4:C13,A4:B13,A18:B19),2,1),0)')
  fmt('C16', 'C17', { nf: 'currency', decimals: 0 })

  // ---- One-sample t-test: is mean sales different from $250? ----
  set('E15', 'One-sample t-test — is mean daily sales ≠ $250?')
  fmt('E15', 'E15', { bold: true })
  set('E16', 'n')
  set('G16', '=COUNT(C4:C13)')
  set('E17', 'sample mean')
  set('G17', '=AVERAGE(C4:C13)')
  set('E18', 'sample sd')
  set('G18', '=STDEV(C4:C13)')
  set('E19', 'hypothesised µ₀')
  set('G19', '250')
  set('E20', 't = (x̄−µ₀)/(s/√n)')
  set('G20', '=(G17-G19)/(G18/SQRT(G16))')
  set('E21', 'two-tailed p')
  set('G21', '=ROUND(T.DIST.2T(ABS(G20),G16-1),4)')
  set('E22', '95% CI half-width')
  set('G22', '=ROUND(CONFIDENCE.T(0.05,G18,G16),1)')
  set('E23', 'verdict')
  set('G23', '=IF(G21<0.05,"reject H₀","cannot reject H₀")')
  fmt('E16', 'E23', { color: '#cdd3e6' })
  fmt('G17', 'G18', { nf: 'currency', decimals: 1 })
  fmt('G20', 'G20', { decimals: 3 })

  // ---- Solve a 3×3 linear system Ax = b with MINVERSE / MMULT ----
  set('A25', 'Solve a 3×3 system  A·x = b  (x = A⁻¹·b) — matrix algebra from scratch')
  fmt('A25', 'A25', { bold: true })
  set('A26', 'A =')
  set('E26', 'b =')
  fmt('A26', 'A28', { bold: true })
  fmt('E26', 'E28', { bold: true })
  // A well-conditioned system whose exact solution is x = (1, 2, 3).
  const A = [
    [2, 1, 1],
    [1, 3, 2],
    [1, 0, 2],
  ]
  const xExact = [1, 2, 3]
  A.forEach((rowVals, i) => {
    rowVals.forEach((v, j) => set(`${String.fromCharCode(66 + j)}${26 + i}`, String(v))) // B..D, rows 26..28
    const b = rowVals.reduce((s, v, j) => s + v * xExact[j], 0)
    set(`F${26 + i}`, String(b)) // b vector in F26:F28
  })
  set('A30', 'x = MINVERSE(A)·b →')
  set('B30', '=INDEX(MMULT(MINVERSE(B26:D28),F26:F28),1,1)')
  set('C30', '=INDEX(MMULT(MINVERSE(B26:D28),F26:F28),2,1)')
  set('D30', '=INDEX(MMULT(MINVERSE(B26:D28),F26:F28),3,1)')
  fmt('B30', 'D30', { bold: true, decimals: 0 })
  set('A31', 'det(A) =')
  set('B31', '=MDETERM(B26:D28)')
  set('A32', 'x should read 1, 2, 3 — exactly.')
  fmt('A32', 'A32', { color: '#97a0b8' })

  // A scatter of sales vs temperature with the data the regression fits.
  set('K3', 'Temp')
  set('L3', 'Sales')
  data.forEach(([t, , s], i) => {
    set(`K${4 + i}`, String(t))
    set(`L${4 + i}`, String(s))
  })
  fmt('K3', 'L3', { bold: true })
  wb.addChart(
    { type: 'scatter', range: box('K3', 'L13'), title: 'Sales vs temperature', x: 720, y: 30, w: 360, h: 260, headers: true, labels: true },
    id,
  )

  wb.setActiveSheet(id)
  return wb.serialize()
}

function inferenceLab(): WorkbookSnapshot {
  const wb = new Workbook()
  const id = wb.activeSheetId
  wb.renameSheet(id, 'Inference Lab')
  const set = (a1: string, raw: string) => {
    const ref = parseRef(a1)
    if (ref) wb.setCell({ row: ref.row, col: ref.col }, raw, id)
  }
  const fmt = (a1: string, a2: string, patch: CellFormat) => {
    const f = parseRef(a1)!
    const t = parseRef(a2)!
    wb.applyFormat({ top: f.row, left: f.col, bottom: t.row, right: t.col }, patch, id)
  }
  const box = (a1: string, a2: string): RangeBox => {
    const f = parseRef(a1)!
    const t = parseRef(a2)!
    return { top: f.row, left: f.col, bottom: t.row, right: t.col }
  }
  const muted = '#97a0b8'

  set('A1', 'Inference Lab — hypothesis tests, a spectral decomposition, and a prediction interval, all from scratch')
  fmt('A1', 'A1', { bold: true })
  set('A2', 'Every p-value, eigenvalue and confidence band below is computed live by the engine — no stats library, no charts library.')
  fmt('A2', 'A2', { color: muted })

  // ---- ① Two independent samples: T.TEST (pooled & Welch) gated by an F.TEST ----
  set('A4', '① Two independent samples — do two teaching methods differ in exam scores?')
  fmt('A4', 'A4', { bold: true })
  set('A5', 'Method A')
  set('B5', 'Method B')
  fmt('A5', 'B5', { bold: true, align: 'center' })
  const methodA = [72, 75, 68, 80, 77, 73, 79, 71, 74, 76]
  const methodB = [82, 85, 79, 88, 84, 90, 83, 86, 81, 87]
  methodA.forEach((v, i) => set(`A${6 + i}`, String(v)))
  methodB.forEach((v, i) => set(`B${6 + i}`, String(v)))
  fmt('A6', 'B15', { align: 'center' })
  set('D5', 'F-test: equal variances? (p)')
  set('F5', '=ROUND(F.TEST(A6:A15,B6:B15),4)')
  set('D6', 'chosen test')
  set('F6', '=IF(F5>0.05,"pooled t","Welch t")')
  set('D7', 'mean A')
  set('F7', '=ROUND(AVERAGE(A6:A15),2)')
  set('D8', 'mean B')
  set('F8', '=ROUND(AVERAGE(B6:B15),2)')
  set('D9', 'pooled t-test p (2-tail)')
  set('F9', '=ROUND(T.TEST(A6:A15,B6:B15,2,2),5)')
  set('D10', 'Welch t-test p (2-tail)')
  set('F10', '=ROUND(T.TEST(A6:A15,B6:B15,2,3),5)')
  set('D11', 'verdict (α = 0.05)')
  set('F11', '=IF(MIN(F9,F10)<0.05,"means differ","no evidence")')
  fmt('D5', 'D11', { color: '#cdd3e6' })
  fmt('F11', 'F11', { bold: true })

  // ---- ② Paired samples: T.TEST type 1 on the before/after differences ----
  set('A17', '② Paired samples — weight (lb) before vs after an 8-week program')
  fmt('A17', 'A17', { bold: true })
  set('A18', 'Before')
  set('B18', 'After')
  set('C18', 'Δ')
  fmt('A18', 'C18', { bold: true, align: 'center' })
  const before = [210, 195, 180, 220, 205, 190, 200, 215]
  const after = [201, 190, 178, 210, 197, 185, 194, 205]
  before.forEach((v, i) => {
    set(`A${19 + i}`, String(v))
    set(`B${19 + i}`, String(after[i]))
    set(`C${19 + i}`, `=B${19 + i}-A${19 + i}`)
  })
  fmt('A19', 'C26', { align: 'center' })
  set('D18', 'mean Δ (lb)')
  set('F18', '=ROUND(AVERAGE(C19:C26),2)')
  set('D19', 'paired t-test p (2-tail)')
  set('F19', '=ROUND(T.TEST(A19:A26,B19:B26,2,1),6)')
  set('D20', 'verdict (α = 0.05)')
  set('F20', '=IF(F19<0.05,"significant loss","no evidence")')
  fmt('D18', 'D20', { color: '#cdd3e6' })
  fmt('F20', 'F20', { bold: true })

  // ---- ③ Chi-square test of independence on a 2×3 contingency table ----
  set('A28', '③ χ² test of independence — drink preference by group (expected from the margins)')
  fmt('A28', 'A28', { bold: true })
  set('B29', 'Coffee')
  set('C29', 'Tea')
  set('D29', 'Water')
  set('E29', 'row Σ')
  fmt('B29', 'E29', { bold: true, align: 'center' })
  set('A30', 'Men')
  set('B30', '40')
  set('C30', '20')
  set('D30', '40')
  set('E30', '=SUM(B30:D30)')
  set('A31', 'Women')
  set('B31', '30')
  set('C31', '50')
  set('D31', '20')
  set('E31', '=SUM(B31:D31)')
  set('A32', 'col Σ')
  set('B32', '=SUM(B30:B31)')
  set('C32', '=SUM(C30:C31)')
  set('D32', '=SUM(D30:D31)')
  set('E32', '=SUM(E30:E31)')
  fmt('A30', 'A32', { bold: true })
  fmt('E30', 'E32', { color: muted })
  fmt('B32', 'D32', { color: muted })
  set('A33', 'Expected (row Σ × col Σ ÷ grand):')
  fmt('A33', 'A33', { color: muted })
  // Expected counts under independence, computed from the marginals.
  set('B34', '=E30*B32/$E$32')
  set('C34', '=E30*C32/$E$32')
  set('D34', '=E30*D32/$E$32')
  set('B35', '=E31*B32/$E$32')
  set('C35', '=E31*C32/$E$32')
  set('D35', '=E31*D32/$E$32')
  fmt('B34', 'D35', { decimals: 1, align: 'center', color: muted })
  set('D37', 'χ² test p-value')
  set('F37', '=ROUND(CHISQ.TEST(B30:D31,B34:D35),6)')
  set('D38', 'df = (r−1)(c−1)')
  set('F38', '2')
  set('D39', 'verdict (α = 0.05)')
  set('F39', '=IF(F37<0.05,"not independent","independent")')
  fmt('D37', 'D39', { color: '#cdd3e6' })
  fmt('F39', 'F39', { bold: true })

  // ---- ④ Spectral decomposition of a symmetric matrix ----
  set('H4', '④ Spectral decomposition — a symmetric 3×3 matrix A = QΛQᵀ')
  fmt('H4', 'H4', { bold: true })
  set('H5', 'A =')
  fmt('H5', 'H5', { bold: true })
  const symA = [
    [4, 1, 0],
    [1, 3, 1],
    [0, 1, 2],
  ]
  symA.forEach((row, i) => row.forEach((v, j) => set(`${String.fromCharCode(72 + j)}${6 + i}`, String(v)))) // H..J, rows 6..8
  fmt('H6', 'J8', { align: 'center' })
  set('L5', 'eigenvalues λ (EIGVALS) ↓')
  fmt('L5', 'L5', { color: muted })
  set('L6', '=EIGVALS(H6:J8)') // spills L6:L8
  fmt('L6', 'L8', { decimals: 4 })
  set('H10', 'eigenvectors Q (EIGVECS) — one per column')
  fmt('H10', 'H10', { color: muted })
  set('H11', '=EIGVECS(H6:J8)') // spills H11:J13
  fmt('H11', 'J13', { decimals: 4, align: 'center' })
  set('L10', 'singular values σ (SVDVALS) ↓')
  fmt('L10', 'L10', { color: muted })
  set('L11', '=SVDVALS(H6:J8)') // spills L11:L13
  fmt('L11', 'L13', { decimals: 4 })
  set('H15', 'rank')
  set('I15', '=MRANK(H6:J8)')
  set('H16', 'cond₂(A)')
  set('I16', '=ROUND(MCOND(H6:J8),4)')
  set('H17', '‖A‖₂')
  set('I17', '=ROUND(MNORM(H6:J8,2),4)')
  set('H18', 'trace = Σλ')
  set('I18', '=ROUND(SUM(L6:L8),4)')
  fmt('H15', 'H18', { color: '#cdd3e6' })

  // ---- ⑤ Least squares by the Moore–Penrose pseudo-inverse ----
  set('H20', '⑤ Least squares by pseudo-inverse — β = A⁺·y (any shape, any rank)')
  fmt('H20', 'H20', { bold: true })
  set('H21', 'A (design)')
  set('K21', 'y')
  fmt('H21', 'K21', { color: muted })
  // Overdetermined system: rows [1, xᵢ], best-fit line through 4 noisy points.
  const design: Array<[number, number]> = [
    [1, 1],
    [1, 2],
    [1, 3],
    [1, 4],
  ]
  const yObs = [2.1, 3.9, 6.1, 7.9]
  design.forEach(([a, b], i) => {
    set(`H${22 + i}`, String(a))
    set(`I${22 + i}`, String(b))
    set(`K${22 + i}`, String(yObs[i]))
  })
  fmt('H22', 'K25', { align: 'center' })
  set('M22', 'β = MPINV(A)·y ↓')
  fmt('M22', 'M22', { color: muted })
  set('N22', '=MMULT(MPINV(H22:I25),K22:K25)') // spills N22:N23 (intercept, slope)
  fmt('N22', 'N23', { decimals: 4 })
  set('M24', 'slope check = SLOPE()')
  set('N24', '=ROUND(SLOPE(K22:K25,I22:I25),4)')
  fmt('M24', 'M24', { color: muted })

  // ---- ⑥ Prediction interval around a TREND forecast ----
  set('H27', '⑥ 95% prediction interval around a forecast (STEYX · leverage · T.INV)')
  fmt('H27', 'H27', { bold: true })
  set('H28', 'x')
  set('I28', 'y')
  fmt('H28', 'I28', { bold: true, align: 'center' })
  const px = [1, 2, 3, 4, 5, 6, 7, 8]
  const py = [2.3, 4.1, 5.6, 8.2, 9.4, 11.7, 13.1, 15.0]
  px.forEach((v, i) => {
    set(`H${29 + i}`, String(v))
    set(`I${29 + i}`, String(py[i]))
  })
  fmt('H29', 'I36', { align: 'center' })
  set('K28', 'forecast at x* = 9')
  set('M28', '=ROUND(FORECAST(9,I29:I36,H29:H36),3)')
  set('K29', 'std error (STEYX)')
  set('M29', '=ROUND(STEYX(I29:I36,H29:H36),4)')
  set('K30', 't₀.₉₇₅ (df = n−2)')
  set('M30', '=ROUND(T.INV.2T(0.05,COUNT(H29:H36)-2),4)')
  set('K31', 'PI half-width')
  set('M31', '=ROUND(M30*M29*SQRT(1+1/COUNT(H29:H36)+(9-AVERAGE(H29:H36))^2/DEVSQ(H29:H36)),3)')
  set('K32', 'lower 95%')
  set('M32', '=ROUND(M28-M31,3)')
  set('K33', 'upper 95%')
  set('M33', '=ROUND(M28+M31,3)')
  fmt('K28', 'K33', { color: '#cdd3e6' })
  fmt('M28', 'M33', { bold: true })

  // A scatter of the ⑥ data with the least-squares trendline + R² turned on.
  wb.addChart(
    { type: 'scatter', range: box('H28', 'I36'), title: 'Linear trend (OLS + R²)', x: 640, y: 470, w: 380, h: 260, headers: true, labels: true, trendline: true },
    id,
  )

  wb.setActiveSheet(id)
  return wb.serialize()
}

export const DEMOS: Demo[] = [
  { id: 'inference', name: 'Inference Lab', blurb: 'Two-sample/paired T.TEST, F.TEST & a χ² test; a symmetric eigen/SVD spectral block with MPINV least squares; and a 95% prediction interval + OLS trendline', snapshot: inferenceLab },
  { id: 'stats', name: 'Statistics Lab', blurb: 'A live multiple regression (LINEST full stats block), a one-sample t-test, and a 3×3 linear system solved with MINVERSE/MMULT', snapshot: statisticsLab },
  { id: 'integer', name: 'Integer Programming Lab', blurb: 'A 0/1 capital-budgeting knapsack solved by branch & bound, plus an LP with a shadow-price sensitivity report', snapshot: integerLab },
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
