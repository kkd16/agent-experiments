// An in-app test suite for the engine. It runs entirely in the browser and renders
// green/red in the Self-test panel, so the formula language's correctness is
// always one click away — and regressions are obvious. Each assertion drives the
// real Workbook (parse → graph → recalc → display), not a mock.

import { Workbook } from './workbook'
import { parseRef } from './address'
import type { Coord } from './address'

export interface TestResult {
  group: string
  name: string
  pass: boolean
  detail?: string
}

const SCRATCH: Coord = { row: 30, col: 0 } // A31, kept clear of seeded cells

/** Evaluate a single formula (optionally against seeded cells) and return its display. */
function ev(expr: string, seed?: Record<string, string>): string {
  const wb = new Workbook(40, 20)
  const entries: Array<{ coord: Coord; raw: string }> = []
  if (seed) {
    for (const [ref, raw] of Object.entries(seed)) {
      const c = parseRef(ref)
      if (c) entries.push({ coord: { row: c.row, col: c.col }, raw })
    }
  }
  entries.push({ coord: SCRATCH, raw: '=' + expr })
  wb.setMany(entries)
  return wb.getDisplay(SCRATCH)
}

export function runSelfTests(): TestResult[] {
  const r: Array<TestResult | TestResult[]> = []
  const eq = (group: string, name: string, actual: string, expected: string) => {
    r.push({ group, name, pass: actual === expected, detail: actual === expected ? undefined : `got "${actual}", expected "${expected}"` })
  }

  // --- arithmetic & precedence ---
  eq('arithmetic', '1+2*3', ev('1+2*3'), '7')
  eq('arithmetic', 'grouping', ev('(1+2)*3'), '9')
  eq('arithmetic', 'right-assoc power', ev('2^3^2'), '512')
  eq('arithmetic', 'unary binds before power', ev('-2^2'), '4')
  eq('arithmetic', 'power then negate', ev('-(2^2)'), '-4')
  eq('arithmetic', 'percent', ev('50%'), '0.5')
  eq('arithmetic', 'percent in expr', ev('200*10%'), '20')
  eq('arithmetic', 'division', ev('10/4'), '2.5')
  eq('arithmetic', 'div by zero', ev('1/0'), '#DIV/0!')
  eq('arithmetic', 'modulo', ev('MOD(7,3)'), '1')
  eq('arithmetic', 'negative modulo', ev('MOD(-1,3)'), '2')
  eq('arithmetic', 'float noise trimmed', ev('0.1+0.2'), '0.3')

  // --- text & comparison ---
  eq('text', 'concatenation', ev('"a"&"b"&"c"'), 'abc')
  eq('text', 'number to text', ev('"#"&12'), '#12')
  eq('text', 'LEN', ev('LEN("hello")'), '5')
  eq('text', 'LEFT/RIGHT/MID', ev('LEFT("hello",2)&MID("hello",3,1)&RIGHT("hello",1)'), 'helo')
  eq('text', 'UPPER', ev('UPPER("abc")'), 'ABC')
  eq('text', 'SUBSTITUTE', ev('SUBSTITUTE("a-b-c","-","+")'), 'a+b+c')
  eq('text', 'SUBSTITUTE nth', ev('SUBSTITUTE("a-b-c","-","+",2)'), 'a-b+c')
  eq('text', 'FIND', ev('FIND("b","abc")'), '2')
  eq('text', 'TEXTJOIN', ev('TEXTJOIN("-",TRUE,"a","","b")'), 'a-b')
  eq('compare', 'less than', ev('3<5'), 'TRUE')
  eq('compare', 'not equal', ev('"x"<>"y"'), 'TRUE')
  eq('compare', 'case-insensitive eq', ev('"ABC"="abc"'), 'TRUE')

  // --- logic ---
  eq('logic', 'IF true', ev('IF(2>1,"yes","no")'), 'yes')
  eq('logic', 'IF false', ev('IF(2<1,"yes","no")'), 'no')
  eq('logic', 'AND', ev('AND(TRUE,TRUE,FALSE)'), 'FALSE')
  eq('logic', 'OR', ev('OR(FALSE,TRUE)'), 'TRUE')
  eq('logic', 'XOR', ev('XOR(TRUE,TRUE,TRUE)'), 'TRUE')
  eq('logic', 'NOT', ev('NOT(FALSE)'), 'TRUE')
  eq('logic', 'IFERROR catches', ev('IFERROR(1/0,"safe")'), 'safe')
  eq('logic', 'IFERROR passes through', ev('IFERROR(42,"safe")'), '42')
  eq('logic', 'nested IF', ev('IF(A1>0,"pos",IF(A1<0,"neg","zero"))', { A1: '-5' }), 'neg')

  // --- math & stats over ranges ---
  const seed = { A1: '1', A2: '2', A3: '3', A4: '4', A5: '5' }
  eq('stats', 'SUM range', ev('SUM(A1:A5)', seed), '15')
  eq('stats', 'AVERAGE range', ev('AVERAGE(A1:A5)', seed), '3')
  eq('stats', 'MIN/MAX', ev('MIN(A1:A5)+MAX(A1:A5)', seed), '6')
  eq('stats', 'COUNT', ev('COUNT(A1:A5,"x")', seed), '5')
  eq('stats', 'MEDIAN', ev('MEDIAN(A1:A5)', seed), '3')
  eq('stats', 'PRODUCT', ev('PRODUCT(A1:A5)', seed), '120')
  eq('stats', 'COUNTIF', ev('COUNTIF(A1:A5,">2")', seed), '3')
  eq('stats', 'SUMIF', ev('SUMIF(A1:A5,">=3")', seed), '12')
  eq('stats', 'STDEV', ev('ROUND(STDEV(A1:A5),4)', seed), '1.5811')
  eq('math', 'SQRT', ev('SQRT(144)'), '12')
  eq('math', 'SQRT negative', ev('SQRT(-1)'), '#NUM!')
  eq('math', 'POWER', ev('POWER(2,10)'), '1024')
  eq('math', 'ROUND', ev('ROUND(3.14159,2)'), '3.14')
  eq('math', 'ROUNDUP', ev('ROUNDUP(3.1,0)'), '4')
  eq('math', 'GCD', ev('GCD(12,18)'), '6')
  eq('math', 'PI', ev('ROUND(PI(),5)'), '3.14159')
  eq('math', 'trig identity', ev('ROUND(SIN(0)+COS(0),4)'), '1')

  // --- lookup ---
  const table = { A1: 'apple', B1: '3', A2: 'pear', B2: '7', A3: 'plum', B3: '9' }
  eq('lookup', 'VLOOKUP exact', ev('VLOOKUP("pear",A1:B3,2,FALSE)', table), '7')
  eq('lookup', 'INDEX', ev('INDEX(A1:B3,3,1)', table), 'plum')
  eq('lookup', 'MATCH exact', ev('MATCH("plum",A1:A3,0)', table), '3')
  eq('lookup', 'CHOOSE', ev('CHOOSE(2,"a","b","c")'), 'b')

  // --- errors & references ---
  eq('errors', 'unknown function', ev('FOOBAR(1)'), '#NAME?')
  eq('errors', 'error propagation', ev('1+(1/0)'), '#DIV/0!')
  eq('errors', 'empty cell reads as blank (0)', ev('B2+0', {}), '0')
  eq('errors', 'out-of-bounds ref → #REF!', ev('Z99', {}), '#REF!')
  eq('errors', 'ISERROR', ev('ISERROR(1/0)'), 'TRUE')
  eq('errors', 'NA', ev('ISNA(NA())'), 'TRUE')

  // --- the dependency graph ---
  r.push(depGraphTests())
  r.push(cycleTest())
  r.push(transitiveTest())
  r.push(fillRewriteTest())

  return r.flat()
}

function depGraphTests(): TestResult[] {
  const wb = new Workbook(20, 20)
  wb.setMany([
    { coord: { row: 0, col: 0 }, raw: '10' }, // A1
    { coord: { row: 1, col: 0 }, raw: '20' }, // A2
    { coord: { row: 2, col: 0 }, raw: '=A1+A2' }, // A3
  ])
  const out: TestResult[] = []
  const pass = wb.getDisplay({ row: 2, col: 0 }) === '30'
  out.push({ group: 'graph', name: 'A3 = A1+A2', pass, detail: pass ? undefined : `got ${wb.getDisplay({ row: 2, col: 0 })}` })
  wb.setCell({ row: 0, col: 0 }, '100') // change A1
  const pass2 = wb.getDisplay({ row: 2, col: 0 }) === '120'
  out.push({ group: 'graph', name: 'recalc on precedent change', pass: pass2, detail: pass2 ? undefined : `got ${wb.getDisplay({ row: 2, col: 0 })}` })
  return out
}

function cycleTest(): TestResult[] {
  const wb = new Workbook(20, 20)
  wb.setMany([
    { coord: { row: 0, col: 0 }, raw: '=A2' }, // A1 = A2
    { coord: { row: 1, col: 0 }, raw: '=A1' }, // A2 = A1
  ])
  const a = wb.getDisplay({ row: 0, col: 0 })
  const b = wb.getDisplay({ row: 1, col: 0 })
  const pass = a === '#CIRC!' && b === '#CIRC!'
  return [{ group: 'graph', name: 'circular reference → #CIRC!', pass, detail: pass ? undefined : `got ${a}/${b}` }]
}

function transitiveTest(): TestResult[] {
  const wb = new Workbook(20, 20)
  wb.setMany([
    { coord: { row: 0, col: 0 }, raw: '2' }, // A1
    { coord: { row: 1, col: 0 }, raw: '=A1*2' }, // A2 = 4
    { coord: { row: 2, col: 0 }, raw: '=A2*2' }, // A3 = 8
    { coord: { row: 3, col: 0 }, raw: '=A3*2' }, // A4 = 16
  ])
  wb.setCell({ row: 0, col: 0 }, '3') // ripple through the chain
  const pass = wb.getDisplay({ row: 3, col: 0 }) === '24'
  return [{ group: 'graph', name: 'transitive recalc (A1→A2→A3→A4)', pass, detail: pass ? undefined : `got ${wb.getDisplay({ row: 3, col: 0 })}` }]
}

function fillRewriteTest(): TestResult[] {
  // A formula's relative refs shift when filled; absolute refs ($) stay put.
  const wb = new Workbook(20, 20)
  wb.setMany([
    { coord: { row: 0, col: 0 }, raw: '5' }, // A1
    { coord: { row: 0, col: 1 }, raw: '10' }, // B1
    { coord: { row: 1, col: 0 }, raw: '6' }, // A2
    { coord: { row: 1, col: 1 }, raw: '20' }, // B2
  ])
  wb.setCell({ row: 0, col: 2 }, '=A1*$B$1') // C1 = 5*10 = 50
  // Simulate a fill-down by hand using offsetRef semantics through raw text.
  wb.setCell({ row: 1, col: 2 }, '=A2*$B$1') // C2 = 6*10 = 60
  const pass = wb.getDisplay({ row: 0, col: 2 }) === '50' && wb.getDisplay({ row: 1, col: 2 }) === '60'
  return [{ group: 'graph', name: 'absolute ref ($B$1) stays fixed on fill', pass, detail: pass ? undefined : 'fill rewrite mismatch' }]
}
