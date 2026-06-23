// Three preloaded demo sheets that double as a tour of the engine: SUM/percent
// math (Budget), self-referential formula chains + a line sparkline (Fibonacci),
// and mixed absolute/relative references (Times table). Each returns A1-keyed raw
// inputs ready to hand to Workbook.loadJSON via coordKey conversion in App.

import { parseRef, coordKey } from './engine/address'

export interface Demo {
  id: string
  name: string
  blurb: string
  build: () => Record<string, string> // A1 ref -> raw input
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

export const DEMOS: Demo[] = [
  { id: 'budget', name: 'Monthly Budget', blurb: 'SUM, percentages, IF and a bar sparkline', build: budget },
  { id: 'fib', name: 'Fibonacci & Stats', blurb: 'Self-referential formula chains and a line sparkline', build: fibonacci },
  { id: 'times', name: 'Times Table', blurb: 'A 10×10 grid from one mixed-reference formula', build: timesTable },
]

/** Convert an A1-keyed demo into the coordKey-keyed cell map Workbook.loadJSON wants. */
export function demoToCells(demo: Demo): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [a1, raw] of Object.entries(demo.build())) {
    const ref = parseRef(a1)
    if (ref) out[coordKey(ref.row, ref.col)] = raw
  }
  return out
}
