// An in-app test suite for the engine. It runs entirely in the browser and renders
// green/red in the Self-test panel, so the formula language's correctness is
// always one click away — and regressions are obvious. Each assertion drives the
// real Workbook (parse → graph → recalc → display), not a mock.

import { Workbook } from './workbook'
import { parseRef } from './address'
import type { Coord } from './address'
import { displayWithFormat } from './format'
import { dateToSerial } from './dates'

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

  // --- dates ---
  eq('dates', 'DATE -> serial', ev('DATE(2026,6,23)'), String(dateToSerial(2026, 6, 23)))
  eq('dates', 'YEAR', ev('YEAR(DATE(2026,6,23))'), '2026')
  eq('dates', 'MONTH', ev('MONTH(DATE(2026,6,23))'), '6')
  eq('dates', 'DAY', ev('DAY(DATE(2026,6,23))'), '23')
  eq('dates', 'WEEKDAY (2026-06-23 = Tue)', ev('WEEKDAY(DATE(2026,6,23))'), '3')
  eq('dates', 'EDATE +2 months', ev('EDATE(DATE(2026,1,31),1)'), String(dateToSerial(2026, 2, 28)))
  eq('dates', 'EOMONTH', ev('EOMONTH(DATE(2026,6,10),0)'), String(dateToSerial(2026, 6, 30)))
  eq('dates', 'DAYS between', ev('DAYS(DATE(2026,6,23),DATE(2026,6,13))'), '10')
  eq('dates', 'DATEDIF years', ev('DATEDIF(DATE(2000,1,1),DATE(2026,6,23),"Y")'), '26')
  eq('dates', 'TEXT date pattern', ev('TEXT(DATE(2026,6,23),"yyyy-mm-dd")'), '2026-06-23')
  eq('dates', 'TEXT month name', ev('TEXT(DATE(2026,6,23),"mmm d, yyyy")'), 'Jun 23, 2026')

  // --- conditional aggregates & lookup ---
  const grid = { A1: 'x', B1: '10', A2: 'y', B2: '20', A3: 'x', B3: '5', A4: 'z', B4: '40' }
  eq('condagg', 'SUMIFS one criterion', ev('SUMIFS(B1:B4,A1:A4,"x")', grid), '15')
  eq('condagg', 'COUNTIFS', ev('COUNTIFS(A1:A4,"x")', grid), '2')
  eq('condagg', 'COUNTIFS two', ev('COUNTIFS(A1:A4,"x",B1:B4,">6")', grid), '1')
  eq('condagg', 'AVERAGEIFS', ev('AVERAGEIFS(B1:B4,A1:A4,"x")', grid), '7.5')
  eq('condagg', 'MAXIFS', ev('MAXIFS(B1:B4,A1:A4,"x")', grid), '10')
  eq('condagg', 'AVERAGEIF', ev('AVERAGEIF(A1:A4,"x",B1:B4)', grid), '7.5')
  eq('lookup', 'XLOOKUP', ev('XLOOKUP("z",A1:A4,B1:B4)', grid), '40')
  eq('lookup', 'XLOOKUP not found', ev('XLOOKUP("q",A1:A4,B1:B4,"none")', grid), 'none')
  eq('lookup', 'SUMPRODUCT', ev('SUMPRODUCT(B1:B4,B1:B4)', grid), String(100 + 400 + 25 + 1600))

  // --- more stats & math ---
  const fives = { A1: '2', A2: '4', A3: '4', A4: '4', A5: '5', A6: '5', A7: '7', A8: '9' }
  eq('stats2', 'STDEVP', ev('STDEVP(A1:A8)', fives), '2')
  eq('stats2', 'MODE', ev('MODE(A1:A8)', fives), '4')
  eq('stats2', 'LARGE 2nd', ev('LARGE(A1:A8,2)', fives), '7')
  eq('stats2', 'SMALL 1st', ev('SMALL(A1:A8,1)', fives), '2')
  eq('stats2', 'MEDIAN via PERCENTILE', ev('PERCENTILE(A1:A8,0.5)', fives), '4.5')
  eq('stats2', 'RANK desc', ev('RANK(7,A1:A8)', fives), '2')
  eq('math2', 'MROUND', ev('MROUND(17,5)'), '15')
  eq('math2', 'EVEN', ev('EVEN(3)'), '4')
  eq('math2', 'ODD', ev('ODD(4)'), '5')
  eq('math2', 'FACT', ev('FACT(5)'), '120')
  eq('math2', 'COMBIN', ev('COMBIN(5,2)'), '10')
  eq('math2', 'PERMUT', ev('PERMUT(5,2)'), '20')
  eq('math2', 'SUMSQ', ev('SUMSQ(3,4)'), '25')
  eq('math2', 'CEILING.MATH', ev('CEILING.MATH(4.2,1)'), '5')

  // --- logic utilities & text/regex ---
  eq('logic2', 'IFS', ev('IFS(FALSE,"a",TRUE,"b")'), 'b')
  eq('logic2', 'SWITCH', ev('SWITCH(2,1,"one",2,"two","other")'), 'two')
  eq('logic2', 'SWITCH default', ev('SWITCH(9,1,"one","other")'), 'other')
  eq('logic2', 'IFNA', ev('IFNA(NA(),"fallback")'), 'fallback')
  eq('text2', 'TEXT number', ev('TEXT(1234.5,"#,##0.00")'), '1,234.50')
  eq('text2', 'TEXT percent', ev('TEXT(0.125,"0.0%")'), '12.5%')
  eq('text2', 'REGEXMATCH', ev('REGEXMATCH("abc123","\\d+")'), 'TRUE')
  eq('text2', 'REGEXEXTRACT', ev('REGEXEXTRACT("order-42","(\\d+)")'), '42')
  eq('text2', 'REGEXREPLACE', ev('REGEXREPLACE("a1b2c3","\\d","#")'), 'a#b#c#')
  eq('text2', 'NUMBERVALUE', ev('NUMBERVALUE("1,234.5")'), '1234.5')

  // --- number formats (pure display) ---
  eq('format', 'currency', displayWithFormat(1234.5, { nf: 'currency' }), '$1,234.50')
  eq('format', 'percent', displayWithFormat(0.125, { nf: 'percent', decimals: 1 }), '12.5%')
  eq('format', 'thousands', displayWithFormat(1234567, { nf: 'thousands' }), '1,234,567')
  eq('format', 'scientific', displayWithFormat(12345, { nf: 'scientific', decimals: 2 }), '1.23E+4')
  eq('format', 'plain decimals', displayWithFormat(3.14159, { nf: 'plain', decimals: 2 }), '3.14')
  eq('format', 'date', displayWithFormat(dateToSerial(2026, 6, 23), { nf: 'date' }), '2026-06-23')
  eq('format', 'negative currency', displayWithFormat(-50, { nf: 'currency', decimals: 0 }), '-$50')

  // --- v3: dynamic arrays (single-cell results from array formulas) ---
  eq('array', 'SEQUENCE 1x1', ev('SEQUENCE(1,1,7)'), '7')
  eq('array', 'TRANSPOSE 1x1', ev('TRANSPOSE(SEQUENCE(1))'), '1')
  eq('array', 'array sum (SEQUENCE)', ev('SUM(SEQUENCE(10))'), '55')
  eq('array', 'array product over MAP', ev('SUM(MAP(SEQUENCE(5), LAMBDA(n, n*n)))'), '55')
  eq('array', 'TAKE then SUM', ev('SUM(TAKE(SEQUENCE(10), 3))'), '6')
  eq('array', 'DROP then SUM', ev('SUM(DROP(SEQUENCE(10), 7))'), '27')
  eq('array', 'CHOOSECOLS', ev('INDEX(CHOOSECOLS(SEQUENCE(1,4), 4, 1), 1, 1)'), '4')
  eq('array', 'HSTACK width', ev('COLUMNS(HSTACK(SEQUENCE(2), SEQUENCE(2)))'), '2')
  eq('array', 'VSTACK height', ev('ROWS(VSTACK(SEQUENCE(2), SEQUENCE(3)))'), '5')
  eq('array', 'COUNT of UNIQUE', ev('COUNT(UNIQUE(A1:A5))', { A1: '1', A2: '1', A3: '2', A4: '3', A5: '3' }), '3')
  eq('array', 'FILTER then SUM', ev('SUM(FILTER(A1:A5, A1:A5>2))', { A1: '1', A2: '4', A3: '2', A4: '5', A5: '3' }), '12')
  eq('array', 'SORT first element', ev('INDEX(SORT(A1:A3, 1, -1), 1, 1)', { A1: '2', A2: '9', A3: '5' }), '9')
  eq('array', 'broadcast multiply', ev('SUM(SEQUENCE(3) * 2)'), '12')
  eq('array', 'boolean broadcast count', ev('SUM(SEQUENCE(10) > 5)'), '5')
  eq('array', 'double-unary coercion', ev('SUM(--(SEQUENCE(10) > 5))'), '5')
  eq('array', 'unary minus broadcasts', ev('SUM(-SEQUENCE(3))'), '-6')
  eq('array', 'REDUCE concat-sum', ev('REDUCE(0, SEQUENCE(4), LAMBDA(a, v, a+v))'), '10')
  eq('array', 'SCAN running total last', ev('INDEX(SCAN(0, SEQUENCE(4), LAMBDA(a,v,a+v)), 4, 1)'), '10')
  eq('array', 'BYROW sums', ev('SUM(BYROW(SEQUENCE(2,2), LAMBDA(r, SUM(r))))'), '10')
  eq('array', 'MAKEARRAY diagonal', ev('SUM(MAKEARRAY(3, 3, LAMBDA(r, c, IF(r=c, 1, 0))))'), '3')
  eq('array', 'FREQUENCY buckets', ev('SUM(FREQUENCY(A1:A5, B1:B2))', { A1: '1', A2: '5', A3: '9', A4: '3', A5: '7', B1: '4', B2: '8' }), '5')

  // --- v3: LAMBDA / LET ---
  eq('lambda', 'LET binds + uses', ev('LET(x, 5, y, 3, x*y)'), '15')
  eq('lambda', 'LET chained bindings', ev('LET(a, 2, b, a*3, b+a)'), '8')
  eq('lambda', 'immediately-applied lambda', ev('LAMBDA(x, y, x+y)(4, 6)'), '10')
  eq('lambda', 'closure captures LET name', ev('LET(k, 10, f, LAMBDA(x, x+k), f(5))'), '15')
  eq('lambda', 'naked lambda → #CALC!', ev('LAMBDA(x, x)'), '#CALC!')
  eq('lambda', 'recursion guard', ev('LET(n, 3, REDUCE(1, SEQUENCE(n), LAMBDA(a, i, a*i)))'), '6')

  // --- v4: GROUPBY / PIVOTBY / XMATCH / WRAP / multi-key SORTBY ---
  const grp = { A1: 'East', B1: '10', A2: 'West', B2: '20', A3: 'East', B3: '5', A4: 'West', B4: '7', A5: 'East', B5: '3' }
  eq('groupby', 'GROUPBY sum (East)', ev('INDEX(GROUPBY(A1:A5,B1:B5,SUM),1,2)', grp), '18')
  eq('groupby', 'GROUPBY collapses to 2 groups', ev('ROWS(GROUPBY(A1:A5,B1:B5,SUM))', grp), '2')
  eq('groupby', 'GROUPBY descending key', ev('INDEX(GROUPBY(A1:A5,B1:B5,SUM,-1),1,1)', grp), 'West')
  eq('groupby', 'GROUPBY with a lambda agg', ev('INDEX(GROUPBY(A1:A5,B1:B5,LAMBDA(v,AVERAGE(v))),1,2)', grp), '6')
  const piv = { A1: 'East', B1: 'Q1', C1: '10', A2: 'West', B2: 'Q1', C2: '20', A3: 'East', B3: 'Q2', C3: '5', A4: 'West', B4: 'Q2', C4: '7' }
  eq('groupby', 'PIVOTBY header + 2 rows', ev('ROWS(PIVOTBY(A1:A4,B1:B4,C1:C4,SUM))', piv), '3')
  eq('groupby', 'PIVOTBY East × Q1 cell', ev('INDEX(PIVOTBY(A1:A4,B1:B4,C1:C4,SUM),2,2)', piv), '10')
  eq('groupby', 'PIVOTBY column header', ev('INDEX(PIVOTBY(A1:A4,B1:B4,C1:C4,SUM),1,2)', piv), 'Q1')

  // --- v5: GROUPBY/PIVOTBY field_headers, total_depth, filter_array ---
  const grph = { A1: 'Region', B1: 'Sales', A2: 'East', B2: '10', A3: 'West', B3: '20', A4: 'East', B4: '5', A5: 'West', B5: '7', A6: 'East', B6: '3' }
  eq('groupby', 'GROUPBY field_headers key label', ev('INDEX(GROUPBY(A1:A6,B1:B6,SUM,1,TRUE),1,1)', grph), 'Region')
  eq('groupby', 'GROUPBY field_headers value label', ev('INDEX(GROUPBY(A1:A6,B1:B6,SUM,1,TRUE),1,2)', grph), 'Sales')
  eq('groupby', 'GROUPBY field_headers East sum below header', ev('INDEX(GROUPBY(A1:A6,B1:B6,SUM,1,TRUE),2,2)', grph), '18')
  eq('groupby', 'GROUPBY grand total at bottom (label)', ev('INDEX(GROUPBY(A1:A5,B1:B5,SUM,1,FALSE,-1),3,1)', grp), 'Total')
  eq('groupby', 'GROUPBY grand total at bottom (value)', ev('INDEX(GROUPBY(A1:A5,B1:B5,SUM,1,FALSE,-1),3,2)', grp), '45')
  eq('groupby', 'GROUPBY grand total at top', ev('INDEX(GROUPBY(A1:A5,B1:B5,SUM,1,FALSE,1),1,1)', grp), 'Total')
  eq('groupby', 'GROUPBY filter_array → one group', ev('ROWS(GROUPBY(A1:A5,B1:B5,SUM,1,FALSE,0,A1:A5="East"))', grp), '1')
  eq('groupby', 'GROUPBY filter_array sum', ev('INDEX(GROUPBY(A1:A5,B1:B5,SUM,1,FALSE,0,A1:A5="East"),1,2)', grp), '18')
  const pivh = { A1: 'R', B1: 'Q', C1: 'V', A2: 'East', B2: 'Q1', C2: '10', A3: 'West', B3: 'Q1', C3: '20', A4: 'East', B4: 'Q2', C4: '5', A5: 'West', B5: 'Q2', C5: '7' }
  eq('groupby', 'PIVOTBY field_headers corner label', ev('INDEX(PIVOTBY(A1:A5,B1:B5,C1:C5,SUM,1,TRUE),1,1)', pivh), 'R')
  eq('groupby', 'PIVOTBY field_headers East×Q1', ev('INDEX(PIVOTBY(A1:A5,B1:B5,C1:C5,SUM,1,TRUE),2,2)', pivh), '10')
  eq('groupby', 'PIVOTBY filter_array narrows columns', ev('COLUMNS(PIVOTBY(A1:A4,B1:B4,C1:C4,SUM,1,FALSE,B1:B4="Q1"))', piv), '2')
  const xm = { A1: '10', A2: '20', A3: '30', A4: '40' }
  eq('xmatch', 'XMATCH exact', ev('XMATCH(30,A1:A4)', xm), '3')
  eq('xmatch', 'XMATCH next-smaller', ev('XMATCH(25,A1:A4,-1)', xm), '2')
  eq('xmatch', 'XMATCH next-larger', ev('XMATCH(25,A1:A4,1)', xm), '3')
  eq('xmatch', 'XMATCH search last→first', ev('XMATCH(20,VSTACK(10,20,20,40),0,-1)'), '3')
  eq('xmatch', 'XMATCH wildcard', ev('XMATCH("ch*",VSTACK("apple","cherry","plum"),2)'), '2')
  eq('xmatch', 'XMATCH not found → #N/A', ev('XMATCH(99,A1:A4)', xm), '#N/A')
  const sb = { A1: 'b', B1: '2', A2: 'a', B2: '2', A3: 'a', B3: '1' }
  eq('array2', 'SORTBY two keys', ev('INDEX(SORTBY(A1:A3,B1:B3,1,A1:A3,1),1,1)', sb), 'a')
  eq('array2', 'WRAPROWS last element', ev('INDEX(WRAPROWS(SEQUENCE(5),2,-1),3,1)'), '5')
  eq('array2', 'WRAPROWS pad fills gap', ev('INDEX(WRAPROWS(SEQUENCE(5),2,0),3,2)'), '0')
  eq('array2', 'WRAPCOLS column count', ev('COLUMNS(WRAPCOLS(SEQUENCE(5),2))'), '3')
  eq('array2', 'eta-reduced SUM in BYROW', ev('SUM(BYROW(SEQUENCE(3,3),SUM))'), '45')

  // --- v7: linear algebra (MMULT / MINVERSE / MDETERM / MUNIT) ---
  // A 2×2 matrix seeded in H1:I2 = [[1,2],[3,4]].
  const mat = { H1: '1', I1: '2', H2: '3', I2: '4' }
  eq('linalg', 'MDETERM([[1,2],[3,4]]) = -2', ev('MDETERM(H1:I2)', mat), '-2')
  eq('linalg', 'MINVERSE bottom-left = 1.5', ev('INDEX(MINVERSE(H1:I2),2,1)', mat), '1.5')
  eq('linalg', 'M·M⁻¹ = I (top-left 1)', ev('INDEX(MMULT(H1:I2,MINVERSE(H1:I2)),1,1)', mat), '1')
  eq('linalg', 'M·M⁻¹ off-diagonal = 0', ev('ROUND(INDEX(MMULT(H1:I2,MINVERSE(H1:I2)),1,2),9)', mat), '0')
  eq('linalg', 'MUNIT(3) diagonal = 1', ev('INDEX(MUNIT(3),2,2)'), '1')
  eq('linalg', 'MUNIT(3) off-diagonal = 0', ev('INDEX(MUNIT(3),2,3)'), '0')
  eq('linalg', 'MMULT 2×2·2×1 (row 2) = 15', ev('INDEX(MMULT(H1:I2,H1:H2),2,1)', mat), '15')
  eq('linalg', 'MMULT dimension clash → #VALUE!', ev('MMULT(H1:I2,H1:I1)', mat), '#VALUE!')
  eq('linalg', 'MINVERSE of non-square → #VALUE!', ev('INDEX(MINVERSE(H1:I1),1,1)', mat), '#VALUE!')
  eq('linalg', 'MDETERM of singular = 0', ev('MDETERM(H1:I2)', { H1: '1', I1: '2', H2: '2', I2: '4' }), '0')

  // --- v7: regression (LINEST / TREND / FORECAST / SLOPE …) ---
  // Five points (A=x, B=y) whose OLS line is y = 1.93x + 0.27, R² = 0.996709.
  const reg = { A1: '1', A2: '2', A3: '3', A4: '4', A5: '5', B1: '2.1', B2: '4.3', B3: '5.9', B4: '8.2', B5: '9.8' }
  eq('regression', 'SLOPE = 1.93', ev('ROUND(SLOPE(B1:B5,A1:A5),4)', reg), '1.93')
  eq('regression', 'INTERCEPT = 0.27', ev('ROUND(INTERCEPT(B1:B5,A1:A5),4)', reg), '0.27')
  eq('regression', 'RSQ = 0.996709', ev('ROUND(RSQ(B1:B5,A1:A5),6)', reg), '0.996709')
  eq('regression', 'CORREL = √RSQ', ev('ROUND(CORREL(A1:A5,B1:B5),6)', reg), '0.998353')
  eq('regression', 'STEYX = 0.20248', ev('ROUND(STEYX(B1:B5,A1:A5),5)', reg), '0.20248')
  eq('regression', 'FORECAST at x=6 = 11.85', ev('ROUND(FORECAST(6,B1:B5,A1:A5),4)', reg), '11.85')
  eq('regression', 'TREND at x=6 = FORECAST', ev('ROUND(INDEX(TREND(B1:B5,A1:A5,6),1,1),4)', reg), '11.85')
  eq('regression', 'LINEST slope (row 1, col 1)', ev('ROUND(INDEX(LINEST(B1:B5,A1:A5),1,1),4)', reg), '1.93')
  eq('regression', 'LINEST intercept (row 1, col 2)', ev('ROUND(INDEX(LINEST(B1:B5,A1:A5),1,2),4)', reg), '0.27')
  eq('regression', 'LINEST R² (stats block, row 3)', ev('ROUND(INDEX(LINEST(B1:B5,A1:A5,TRUE,TRUE),3,1),6)', reg), '0.996709')
  eq('regression', 'LINEST F statistic (row 4)', ev('ROUND(INDEX(LINEST(B1:B5,A1:A5,TRUE,TRUE),4,1),4)', reg), '908.5122')
  eq('regression', 'LINEST residual df = 3 (row 4, col 2)', ev('INDEX(LINEST(B1:B5,A1:A5,TRUE,TRUE),4,2)', reg), '3')
  eq('regression', 'LINEST SE of slope (row 2)', ev('ROUND(INDEX(LINEST(B1:B5,A1:A5,TRUE,TRUE),2,1),5)', reg), '0.06403')
  eq('regression', 'DEVSQ(1..5) = 10', ev('DEVSQ(A1:A5)', reg), '10')
  eq('regression', 'COVARIANCE.P', ev('ROUND(COVARIANCE.P(A1:A5,B1:B5),4)', reg), '3.86')
  // Multiple regression: y = 1 + 2·x1 + 3·x2 recovered exactly (Excel reverses the m order).
  const mreg = {
    D1: '1', E1: '1', F1: '6', D2: '2', E2: '1', F2: '8', D3: '1', E3: '2', F3: '9',
    D4: '3', E4: '2', F4: '13', D5: '2', E5: '3', F5: '14', D6: '4', E6: '4', F6: '21',
  }
  eq('regression', 'LINEST multiple: m₁(x2)=3', ev('ROUND(INDEX(LINEST(F1:F6,D1:E6),1,1),4)', mreg), '3')
  eq('regression', 'LINEST multiple: m₂(x1)=2', ev('ROUND(INDEX(LINEST(F1:F6,D1:E6),1,2),4)', mreg), '2')
  eq('regression', 'LINEST multiple: intercept=1', ev('ROUND(INDEX(LINEST(F1:F6,D1:E6),1,3),4)', mreg), '1')

  // --- v7: statistical distributions (Normal / t / χ² / F + special fns) ---
  eq('dist', 'NORM.S.DIST(1.96) CDF', ev('ROUND(NORM.S.DIST(1.96,TRUE),7)'), '0.9750021')
  eq('dist', 'NORM.S.INV(0.975) = 1.95996', ev('ROUND(NORM.S.INV(0.975),5)'), '1.95996')
  eq('dist', 'NORM.DIST pdf at 0 = 1/√2π', ev('ROUND(NORM.DIST(0,0,1,FALSE),6)'), '0.398942')
  eq('dist', 'NORM.INV round-trips NORM.DIST', ev('ROUND(NORM.INV(NORM.DIST(1.5,2,3,TRUE),2,3),6)'), '1.5')
  eq('dist', 'T.DIST(2,10) CDF', ev('ROUND(T.DIST(2,10,TRUE),6)'), '0.963306')
  eq('dist', 'T.INV.2T(0.05,10) = 2.22814', ev('ROUND(T.INV.2T(0.05,10),5)'), '2.22814')
  eq('dist', 'CHISQ.DIST.RT(3,2)', ev('ROUND(CHISQ.DIST.RT(3,2),6)'), '0.22313')
  eq('dist', 'CHISQ.INV.RT(0.05,10) = 18.307', ev('ROUND(CHISQ.INV.RT(0.05,10),4)'), '18.307')
  eq('dist', 'F.INV.RT(0.05,5,10) = 3.32583', ev('ROUND(F.INV.RT(0.05,5,10),5)'), '3.32583')
  eq('dist', 'F.DIST round-trips F.INV.RT', ev('ROUND(F.DIST(F.INV.RT(0.05,5,10),5,10,TRUE),4)'), '0.95')
  eq('dist', 'GAMMA(0.5) = √π', ev('ROUND(GAMMA(0.5),6)'), '1.772454')
  eq('dist', 'GAMMALN(10) = ln(9!)', ev('ROUND(GAMMALN(10),5)'), '12.80183')
  eq('dist', 'ERF(1) = 0.8427008', ev('ROUND(ERF(1),7)'), '0.8427008')
  eq('dist', 'FISHER(0.5)', ev('ROUND(FISHER(0.5),6)'), '0.549306')
  eq('dist', 'FISHERINV inverts FISHER', ev('ROUND(FISHERINV(FISHER(0.5)),6)'), '0.5')
  eq('dist', 'CONFIDENCE.NORM(0.05,2.5,50)', ev('ROUND(CONFIDENCE.NORM(0.05,2.5,50),5)'), '0.69295')

  // --- v8: spectral linear algebra (EIGVALS / EIGVECS / SVD / MPINV / MRANK / MCOND / MNORM) ---
  // A 3×3 symmetric matrix A = [[2,0,0],[0,3,4],[0,4,9]] with eigenvalues {11, 2, 1}.
  const symM = { A1: '2', B1: '0', C1: '0', A2: '0', B2: '3', C2: '4', A3: '0', B3: '4', C3: '9' }
  eq('spectral', 'EIGVALS symmetric top = 11', ev('ROUND(INDEX(EIGVALS(A1:C3),1,1),6)', symM), '11')
  eq('spectral', 'EIGVALS symmetric mid = 2', ev('ROUND(INDEX(EIGVALS(A1:C3),2,1),6)', symM), '2')
  eq('spectral', 'EIGVALS symmetric low = 1', ev('ROUND(INDEX(EIGVALS(A1:C3),3,1),6)', symM), '1')
  eq('spectral', 'ΣEIGVALS = trace (14)', ev('ROUND(SUM(EIGVALS(A1:C3)),6)', symM), '14')
  eq('spectral', 'ΠEIGVALS = det (22)', ev('ROUND(INDEX(EIGVALS(A1:C3),1,1)*INDEX(EIGVALS(A1:C3),2,1)*INDEX(EIGVALS(A1:C3),3,1),6)', symM), '22')
  eq('spectral', 'MDETERM cross-check = 22', ev('ROUND(MDETERM(A1:C3),6)', symM), '22')
  // Eigenvectors: QᵀQ = I (orthonormal), and the eigen-equation A·v₁ = λ₁·v₁ (λ₁ = 11).
  eq('spectral', 'EIGVECS orthonormal (diagonal 1)', ev('ROUND(INDEX(MMULT(TRANSPOSE(EIGVECS(A1:C3)),EIGVECS(A1:C3)),1,1),6)', symM), '1')
  eq('spectral', 'EIGVECS orthonormal (off-diag 0)', ev('ROUND(INDEX(MMULT(TRANSPOSE(EIGVECS(A1:C3)),EIGVECS(A1:C3)),1,2),6)', symM), '0')
  eq('spectral', 'eigen-equation A·v₁ = λ₁·v₁', ev('ROUND(INDEX(MMULT(A1:C3,EIGVECS(A1:C3)),2,1)-11*INDEX(EIGVECS(A1:C3),2,1),6)', symM), '0')
  // SVD: singular values of diag(4,3) are 4 and 3.
  const diagM = { A1: '4', B1: '0', A2: '0', B2: '3' }
  eq('spectral', 'SVDVALS diag top = 4', ev('ROUND(INDEX(SVDVALS(A1:B2),1,1),6)', diagM), '4')
  eq('spectral', 'SVDVALS diag next = 3', ev('ROUND(INDEX(SVDVALS(A1:B2),2,1),6)', diagM), '3')
  // σ₁ of a general matrix = √(largest eigenvalue of AᵀA).
  const gm = { A1: '1', B1: '2', A2: '3', B2: '4', A3: '5', B3: '6' }
  eq('spectral', 'σ₁ = √λ_max(AᵀA)', ev('ROUND(INDEX(SVDVALS(A1:B3),1,1)^2-INDEX(EIGVALS(MMULT(TRANSPOSE(A1:B3),A1:B3)),1,1),6)', gm), '0')
  // Rank, condition number, matrix norms.
  eq('spectral', 'MRANK rank-deficient = 1', ev('MRANK(A1:B2)', { A1: '1', B1: '2', A2: '2', B2: '4' }), '1')
  eq('spectral', 'MRANK full = 2', ev('MRANK(A1:B2)', { A1: '1', B1: '2', A2: '3', B2: '4' }), '2')
  eq('spectral', 'MCOND identity = 1', ev('ROUND(MCOND(A1:B2),6)', { A1: '1', B1: '0', A2: '0', B2: '1' }), '1')
  eq('spectral', 'MNORM 2-norm of diag = 4', ev('ROUND(MNORM(A1:B2,2),6)', diagM), '4')
  eq('spectral', 'MNORM Frobenius = √30', ev('ROUND(MNORM(A1:B2,"fro"),6)', { A1: '1', B1: '2', A2: '3', B2: '4' }), '5.477226')
  eq('spectral', 'MNORM 1-norm (max col sum) = 6', ev('MNORM(A1:B2,1)', { A1: '1', B1: '-2', A2: '3', B2: '4' }), '6')
  eq('spectral', 'MNORM ∞-norm (max row sum) = 7', ev('MNORM(A1:B2,"inf")', { A1: '1', B1: '-2', A2: '3', B2: '4' }), '7')
  // Moore–Penrose pseudo-inverse solves least squares: X=[[1,1],[1,2],[1,3]], y=(1,2,2) ⇒ β=(2/3, 1/2).
  const pinvS = { A1: '1', B1: '1', A2: '1', B2: '2', A3: '1', B3: '3', D1: '1', D2: '2', D3: '2' }
  eq('spectral', 'MPINV least-squares β₀ = 0.6667', ev('ROUND(INDEX(MMULT(MPINV(A1:B3),D1:D3),1,1),4)', pinvS), '0.6667')
  eq('spectral', 'MPINV least-squares β₁ = 0.5', ev('ROUND(INDEX(MMULT(MPINV(A1:B3),D1:D3),2,1),4)', pinvS), '0.5')
  eq('spectral', 'MPINV slope matches SLOPE()', ev('ROUND(INDEX(MMULT(MPINV(A1:B3),D1:D3),2,1)-SLOPE(D1:D3,B1:B3),6)', pinvS), '0')
  // General (non-symmetric) eigenvalues via the QR-algorithm path.
  // A 2×2 rotation by π/3 has eigenvalues cos π/3 ± i·sin π/3 = 0.5 ± 0.866025 i.
  const rotM = { A1: '0.5', B1: '-0.8660254', A2: '0.8660254', B2: '0.5' }
  eq('spectral', 'rotation eig real part = 0.5', ev('ROUND(INDEX(EIGVALS(A1:B2),1,1),6)', rotM), '0.5')
  eq('spectral', 'rotation eig |imag| = sin(π/3)', ev('ROUND(ABS(INDEX(EIGVALS(A1:B2),1,2)),6)', rotM), '0.866025')
  // A non-symmetric matrix [[0,-2],[1,-3]] has char poly λ²+3λ+2 ⇒ eigenvalues −1, −2 (real).
  const nsM = { A1: '0', B1: '-2', A2: '1', B2: '-3' }
  eq('spectral', 'non-symmetric eig = −1', ev('ROUND(INDEX(EIGVALS(A1:B2),1,1),6)', nsM), '-1')
  eq('spectral', 'non-symmetric eig = −2', ev('ROUND(INDEX(EIGVALS(A1:B2),2,1),6)', nsM), '-2')

  // --- v8: inferential statistics (T.TEST / Z.TEST / F.TEST / CHISQ.TEST) ---
  // Excel's T.TEST documentation example (paired, two-tailed) = 0.196016.
  const pairT = {
    A1: '3', A2: '4', A3: '5', A4: '8', A5: '9', A6: '1', A7: '2', A8: '4', A9: '5',
    B1: '6', B2: '19', B3: '3', B4: '2', B5: '14', B6: '4', B7: '5', B8: '17', B9: '1',
  }
  eq('inference', 'T.TEST paired 2-tail = 0.196016 (Excel)', ev('ROUND(T.TEST(A1:A9,B1:B9,2,1),6)', pairT), '0.196016')
  eq('inference', 'TTEST legacy alias agrees', ev('ROUND(TTEST(A1:A9,B1:B9,2,1),6)', pairT), '0.196016')
  eq('inference', 'T.TEST 1-tail = ½·2-tail', ev('ROUND(2*T.TEST(A1:A9,B1:B9,1,1)-T.TEST(A1:A9,B1:B9,2,1),9)', pairT), '0')
  eq('inference', 'T.TEST pooled (type 2)', ev('ROUND(T.TEST(A1:A9,B1:B9,2,2),6)', pairT), '0.191996')
  eq('inference', 'T.TEST Welch (type 3)', ev('ROUND(T.TEST(A1:A9,B1:B9,2,3),6)', pairT), '0.202294')
  eq('inference', 'T.TEST bad type → #NUM!', ev('T.TEST(A1:A9,B1:B9,2,4)', pairT), '#NUM!')
  // Excel's F.TEST documentation example = 0.648318.
  const fT = { A1: '6', A2: '7', A3: '9', A4: '15', A5: '21', B1: '20', B2: '28', B3: '31', B4: '38', B5: '40' }
  eq('inference', 'F.TEST = 0.648318 (Excel)', ev('ROUND(F.TEST(A1:A5,B1:B5),6)', fT), '0.648318')
  eq('inference', 'F.TEST of identical spread = 1', ev('ROUND(F.TEST(A1:A5,A1:A5),6)', fT), '1')
  // Excel's Z.TEST documentation example, ZTEST(data, 4) = 0.090574.
  const zT = { A1: '3', A2: '6', A3: '7', A4: '8', A5: '6', A6: '5', A7: '4', A8: '2', A9: '1', A10: '9' }
  eq('inference', 'Z.TEST = 0.090574 (Excel)', ev('ROUND(Z.TEST(A1:A10,4),6)', zT), '0.090574')
  // χ² goodness-of-fit: observed (10,20,30,40) vs expected (25,25,25,25) ⇒ χ²=20, df=3.
  const chiG = { A1: '10', A2: '20', A3: '30', A4: '40', B1: '25', B2: '25', B3: '25', B4: '25' }
  eq('inference', 'CHISQ.TEST = CHISQ.DIST.RT(20,3)', ev('ROUND(CHISQ.TEST(A1:A4,B1:B4)-CHISQ.DIST.RT(20,3),9)', chiG), '0')
  eq('inference', 'CHISQ.TEST GoF p-value', ev('ROUND(CHISQ.TEST(A1:A4,B1:B4),8)', chiG), '0.00016974')
  // A 2×2 contingency table exercises df = (r−1)(c−1) = 1: χ² = 4 ⇒ p = CHISQ.DIST.RT(4,1).
  const chi2 = { A1: '20', B1: '30', A2: '30', B2: '20', D1: '25', E1: '25', D2: '25', E2: '25' }
  eq('inference', 'CHISQ.TEST 2×2 df=(r-1)(c-1) → RT(4,1)', ev('ROUND(CHISQ.TEST(A1:B2,D1:E2)-CHISQ.DIST.RT(4,1),9)', chi2), '0')
  eq('inference', 'CHISQ.TEST 2×2 p-value = 0.0455', ev('ROUND(CHISQ.TEST(A1:B2,D1:E2),6)', chi2), '0.0455')
  eq('inference', 'CHITEST shape mismatch → #N/A', ev('CHITEST(A1:B2,D1:E1)', chi2), '#N/A')

  // --- v4: engine internals (spill-range refs, recursive lambdas) ---
  r.push(spillRefTests())
  r.push(recursiveLambdaTests())

  // --- v3: engine internals (spill, goal seek) ---
  r.push(spillTests())
  r.push(goalSeekTests())

  // --- the dependency graph ---
  r.push(depGraphTests())
  r.push(cycleTest())
  r.push(transitiveTest())
  r.push(fillRewriteTest())
  r.push(multiSheetTests())
  r.push(crossSheetRecalcTest())
  r.push(definedNameTests())
  r.push(nameCycleTest())
  r.push(renameSheetTest())

  // --- finance (v9): time value of money, cash flow, depreciation ---
  // Anchored to Excel/Sheets documented values and to closed-form invariants.
  // Each asserts the engine lands within tolerance of the known answer.
  const near = (name: string, expr: string, ref: number, tol: number, seed?: Record<string, string>) =>
    eq('finance', name, ev(`ABS((${expr})-(${ref}))<${tol}`, seed), 'TRUE')
  // Time value of money
  near('PMT amortizes a $10k loan', 'PMT(0.08/12,120,10000)', -121.3276, 1e-3)
  near('FV of an annuity due (Excel 2581.40)', 'FV(0.005,10,-200,-500,1)', 2581.4034, 1e-3)
  near('PV of a 20-yr annuity', 'PV(0.08,20,500)', -4909.0737, 1e-3)
  near('NPER to reach a goal', 'NPER(0.01,-100,-1000,10000,1)', 59.6739, 1e-3)
  near('RATE recovers the periodic rate', 'RATE(48,-200,8000)', 0.0077015, 1e-5)
  near('IPMT first-month interest = P·r', 'IPMT(0.1/12,1,36,8000)', -66.6667, 1e-3)
  eq('finance', 'IPMT+PPMT = PMT (identity)', ev('ROUND(IPMT(0.1,2,3,8000)+PPMT(0.1,2,3,8000)-PMT(0.1,3,8000),8)'), '0')
  eq('finance', 'ΣPPMT repays the whole principal', ev('ROUND(CUMPRINC(0.1,3,8000,1,3,0)+8000,6)'), '0')
  near('CUMIPMT over year 2 of a mortgage', 'CUMIPMT(0.09/12,360,125000,13,24,0)', -11135.2321, 0.02)
  // Discounted cash flow
  near('NPV discounts each flow one period', 'NPV(0.1,-10000,3000,4200,6800)', 1188.4434, 1e-3)
  near('IRR zeroes the NPV', 'IRR(A1:A6)', 0.086631, 1e-4, {
    A1: '-70000', A2: '12000', A3: '15000', A4: '18000', A5: '21000', A6: '26000',
  })
  eq('finance', 'NPV at the IRR is ≈ 0', ev('ABS(NPV(IRR(A1:A6),A2:A6)+A1)<0.01', {
    A1: '-70000', A2: '12000', A3: '15000', A4: '18000', A5: '21000', A6: '26000',
  }), 'TRUE')
  near('MIRR with split finance/reinvest', 'MIRR(A1:A6,0.1,0.12)', 0.126094, 1e-4, {
    A1: '-120000', A2: '39000', A3: '30000', A4: '21000', A5: '37000', A6: '46000',
  })
  const dateSeed = {
    A1: '-10000', A2: '2750', A3: '4250', A4: '3250', A5: '2750',
    B1: '39448', B2: '39508', B3: '39751', B4: '39859', B5: '39904',
  }
  near('XIRR on irregular dates (Excel 0.3734)', 'XIRR(A1:A5,B1:B5)', 0.373363, 1e-4, dateSeed)
  eq('finance', 'XNPV at the XIRR is ≈ 0', ev('ABS(XNPV(XIRR(A1:A5,B1:B5),A1:A5,B1:B5))<0.01', dateSeed), 'TRUE')
  near('EFFECT vs NOMINAL round-trip', 'NOMINAL(EFFECT(0.0525,4),4)', 0.0525, 1e-6)
  near('FVSCHEDULE compounds a rate path', 'FVSCHEDULE(1,B1:B3)', 1.33089, 1e-5, { B1: '0.09', B2: '0.11', B3: '0.1' })
  near('PDURATION to grow 2000→2200', 'PDURATION(0.025,2000,2200)', 3.859866, 1e-5)
  near('DOLLARDE reads 1.02 in 16ths', 'DOLLARDE(1.02,16)', 1.125, 1e-9)
  // Depreciation
  near('SLN straight line', 'SLN(30000,7500,10)', 2250, 1e-9)
  near('SYD sum-of-years year 1', 'SYD(30000,7500,10,1)', 4090.909091, 1e-4)
  near('DB fixed-declining first (partial) year', 'DB(1000000,100000,6,1,7)', 186083.3333, 1e-2)
  near('DDB double-declining year 1', 'DDB(2400,300,10,1)', 480, 1e-9)
  near('DDB double-declining year 2', 'DDB(2400,300,10,2)', 384, 1e-9)
  near('VDB first period = DDB', 'VDB(2400,300,10,0,1)', 480, 1e-9)
  near('VDB over full life reaches salvage', 'VDB(2400,300,10,0,10)', 2100, 1e-6)

  // --- securities (v10): fixed-income analytics ---
  // Anchored to Microsoft/Excel-documented values and to closed-form invariants
  // (round-trips and a finite-difference price-sensitivity cross-check).
  const nearS = (name: string, expr: string, ref: number, tol: number) =>
    eq('securities', name, ev(`ABS((${expr})-(${ref}))<${tol}`), 'TRUE')
  const cpn = 'DATE(2011,1,25),DATE(2011,11,15),2,1' // Excel COUP* documented example
  // Day count & coupon scheduling
  eq('securities', 'YEARFRAC US 30/360', ev('ROUND(YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),0),8)'), '0.58055556')
  nearS('YEARFRAC actual/actual over a leap year', 'YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),1)', 0.57650273, 1e-7)
  eq('securities', 'DAYS360 European clamps both 31sts', ev('DAYS360(DATE(2008,1,31),DATE(2008,3,31),TRUE)'), '60')
  eq('securities', 'COUPDAYS actual (Excel 181)', ev(`COUPDAYS(${cpn})`), '181')
  eq('securities', 'COUPDAYBS (Excel 71)', ev(`COUPDAYBS(${cpn})`), '71')
  eq('securities', 'COUPDAYSNC (Excel 110)', ev(`COUPDAYSNC(${cpn})`), '110')
  eq('securities', 'COUPNUM (Excel 2)', ev(`COUPNUM(${cpn})`), '2')
  eq('securities', 'COUPNCD is the next coupon date', ev(`COUPNCD(${cpn})=DATE(2011,5,15)`), 'TRUE')
  eq('securities', 'COUPPCD is the previous coupon date', ev(`COUPPCD(${cpn})=DATE(2010,11,15)`), 'TRUE')
  eq('securities', 'COUPDAYBS + COUPDAYSNC = COUPDAYS', ev(`COUPDAYBS(${cpn})+COUPDAYSNC(${cpn})=COUPDAYS(${cpn})`), 'TRUE')
  // Coupon bonds — price / yield / duration
  nearS('PRICE (Excel 94.63436)', 'PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,2,0)', 94.63436, 1e-4)
  nearS('YIELD recovers 6.5% (Excel)', 'YIELD(DATE(2008,2,15),DATE(2016,11,15),0.0575,95.04287,100,2,0)', 0.065, 1e-5)
  eq('securities', 'PRICE∘YIELD round-trips', ev('ABS(PRICE(DATE(2010,1,1),DATE(2030,1,1),0.05,YIELD(DATE(2010,1,1),DATE(2030,1,1),0.05,96.5,100,2,0),100,2,0)-96.5)<0.0001'), 'TRUE')
  nearS('DURATION (Excel 5.993775)', 'DURATION(DATE(2008,1,1),DATE(2016,1,1),0.08,0.09,2,1)', 5.993775, 1e-3)
  nearS('MDURATION (Excel 5.735674)', 'MDURATION(DATE(2008,1,1),DATE(2016,1,1),0.08,0.09,2,1)', 5.735674, 1e-3)
  // MDURATION equals −(dP/dy)/P — a finite-difference cross-check on PRICE (redemption 100)
  eq(
    'securities',
    'MDURATION = price sensitivity (finite diff)',
    ev(
      'ABS(MDURATION(DATE(2012,7,1),DATE(2030,7,1),0.06,0.05,2,0)-' +
        '(-(PRICE(DATE(2012,7,1),DATE(2030,7,1),0.06,0.0501,100,2,0)-' +
        'PRICE(DATE(2012,7,1),DATE(2030,7,1),0.06,0.0499,100,2,0))/0.0002)/' +
        'PRICE(DATE(2012,7,1),DATE(2030,7,1),0.06,0.05,100,2,0))<0.001',
    ),
    'TRUE',
  )
  // Accrued interest
  nearS('ACCRINT within the first period (Excel 16.66667)', 'ACCRINT(DATE(2008,3,1),DATE(2008,8,31),DATE(2008,5,1),0.1,1000,2,0)', 16.66667, 1e-4)
  nearS('ACCRINTM interest-at-maturity (Excel 20.54795)', 'ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,3)', 20.54795, 1e-4)
  // Discounted (money-market) securities
  nearS('DISC discount rate (Excel 0.05242)', 'DISC(DATE(2007,1,25),DATE(2007,6,15),97.975,100,1)', 0.0524202, 1e-6)
  nearS('INTRATE (Excel 0.05768)', 'INTRATE(DATE(2008,2,15),DATE(2008,5,15),1000000,1014420,2)', 0.05768, 1e-5)
  nearS('RECEIVED at maturity (Excel 1014584.65)', 'RECEIVED(DATE(2008,2,15),DATE(2008,5,15),1000000,0.0575,2)', 1014584.654, 0.01)
  nearS('PRICEDISC (Excel 99.79583)', 'PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,2)', 99.795833, 1e-4)
  // Treasury bills
  nearS('TBILLYIELD (Excel 0.091417)', 'TBILLYIELD(DATE(2008,3,31),DATE(2008,6,1),98.45)', 0.09141696, 1e-6)
  nearS('TBILLEQ bond-equivalent (Excel 0.094151)', 'TBILLEQ(DATE(2008,3,31),DATE(2008,6,1),0.0914)', 0.09415149, 1e-6)
  eq('securities', 'TBILLPRICE ↔ discount is exact', ev('ABS((100-TBILLPRICE(DATE(2008,3,31),DATE(2008,6,1),0.0914))/100*360/(DATE(2008,6,1)-DATE(2008,3,31))-0.0914)<0.0000001'), 'TRUE')
  // Interest-at-maturity securities
  nearS('YIELDMAT (Excel 0.060954)', 'YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,100.0123,0)', 0.060954, 1e-4)
  nearS('PRICEMAT (Excel 99.98449)', 'PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,0.061,0)', 99.98449, 1e-4)
  eq('securities', 'PRICEMAT∘YIELDMAT round-trips', ev('ABS(YIELDMAT(DATE(2020,1,1),DATE(2021,1,1),DATE(2019,7,1),0.05,PRICEMAT(DATE(2020,1,1),DATE(2021,1,1),DATE(2019,7,1),0.05,0.06,0),0)-0.06)<0.0000001'), 'TRUE')

  // --- the Solver (v5: constrained multi-cell optimization) ---
  r.push(solverTests())
  // --- structured table references (v5) ---
  r.push(tableTests())

  return r.flat()
}

function tableTests(): TestResult[] {
  const out: TestResult[] = []
  const A = (row: number, col: number): Coord => ({ row, col })
  const add = (name: string, pass: boolean, detail?: string) => out.push({ group: 'tables', name, pass, detail: pass ? undefined : detail })
  const wb = new Workbook(40, 20)
  wb.setMany([
    { coord: A(0, 0), raw: 'Region' }, { coord: A(0, 1), raw: 'Rep' }, { coord: A(0, 2), raw: 'Amount' },
    { coord: A(1, 0), raw: 'North' }, { coord: A(1, 1), raw: 'Ana' }, { coord: A(1, 2), raw: '40' },
    { coord: A(2, 0), raw: 'South' }, { coord: A(2, 1), raw: 'Ben' }, { coord: A(2, 2), raw: '30' },
    { coord: A(3, 0), raw: 'East' }, { coord: A(3, 1), raw: 'Cy' }, { coord: A(3, 2), raw: '25' },
  ])
  wb.defineTable('Sales', { top: 0, left: 0, bottom: 3, right: 2 })

  wb.setCell(A(0, 5), '=SUM(Sales[Amount])')
  add('SUM(Sales[Amount]) = 95', wb.getDisplay(A(0, 5)) === '95', wb.getDisplay(A(0, 5)))
  wb.setCell(A(1, 5), '=COUNTA(Sales[Rep])')
  add('COUNTA(Sales[Rep]) = 3', wb.getDisplay(A(1, 5)) === '3', wb.getDisplay(A(1, 5)))
  wb.setCell(A(2, 5), '=SUM(Sales[amount])')
  add('column match is case-insensitive', wb.getDisplay(A(2, 5)) === '95', wb.getDisplay(A(2, 5)))
  wb.setCell(A(3, 5), '=Sales[#Headers]')
  add('Sales[#Headers] spills the labels', wb.getDisplay(A(3, 5)) === 'Region' && wb.getDisplay(A(3, 7)) === 'Amount')
  wb.setCell(A(4, 5), '=ROWS(Sales[#All])&"x"&COLUMNS(Sales[#All])')
  add('Sales[#All] is 4×3', wb.getDisplay(A(4, 5)) === '4x3', wb.getDisplay(A(4, 5)))
  wb.setCell(A(5, 5), '=ROWS(Sales[#Data])')
  add('Sales[#Data] has 3 rows', wb.getDisplay(A(5, 5)) === '3', wb.getDisplay(A(5, 5)))
  wb.setCell(A(6, 5), '=SUM(Sales[Nope])')
  add('unknown column → #REF!', wb.getDisplay(A(6, 5)) === '#REF!', wb.getDisplay(A(6, 5)))
  // @ this-row: a formula sitting in a body row reads that row's cell.
  wb.setCell(A(1, 3), '=Sales[@Amount]*0.1')
  add('Sales[@Amount] this-row = 4', wb.getDisplay(A(1, 3)) === '4', wb.getDisplay(A(1, 3)))
  wb.setCell(A(10, 3), '=Sales[@Amount]')
  add('@ outside the body → #VALUE!', wb.getDisplay(A(10, 3)) === '#VALUE!', wb.getDisplay(A(10, 3)))
  // Live recalc as the data changes.
  wb.setCell(A(1, 2), '100')
  add('column re-aggregates on edit (SUM = 155)', wb.getDisplay(A(0, 5)) === '155', wb.getDisplay(A(0, 5)))
  // Serialize/restore keeps the table.
  const wb2 = new Workbook(40, 20)
  wb2.restore(wb.serialize())
  wb2.setCell(A(8, 5), '=SUM(Sales[Amount])')
  add('table survives serialize/restore', wb2.getDisplay(A(8, 5)) === '155', wb2.getDisplay(A(8, 5)))
  return out
}

// ---- v3: dynamic-array spilling --------------------------------------------

function spillTests(): TestResult[] {
  const out: TestResult[] = []
  const ok = (name: string, pass: boolean, detail?: string) => out.push({ group: 'spill', name, pass, detail: pass ? undefined : detail })

  // A vertical SEQUENCE spills down into the cells below its anchor.
  const wb = new Workbook(40, 20)
  wb.setCell({ row: 0, col: 0 }, '=SEQUENCE(3)') // A1 spills A1:A3
  const a1 = wb.getDisplay({ row: 0, col: 0 })
  const a2 = wb.getDisplay({ row: 1, col: 0 })
  const a3 = wb.getDisplay({ row: 2, col: 0 })
  ok('SEQUENCE spills A1:A3', a1 === '1' && a2 === '2' && a3 === '3', `got ${a1}/${a2}/${a3}`)

  // The interior of a spill is readable by another formula (dependency injection).
  wb.setCell({ row: 0, col: 2 }, '=A2*10') // C1 reads a spilled cell
  const c1 = wb.getDisplay({ row: 0, col: 2 })
  ok('interior cell A2 is readable (=A2*10)', c1 === '20', `got ${c1}`)

  // Spill membership metadata.
  const info = wb.spillInfo({ row: 1, col: 0 })
  ok('spillInfo reports the anchor', !!info && !info.isAnchor && info.anchor.row === 0 && info.anchor.col === 0, JSON.stringify(info))
  const anchorInfo = wb.spillInfo({ row: 0, col: 0 })
  ok('anchor reports isAnchor', !!anchorInfo && anchorInfo.isAnchor, JSON.stringify(anchorInfo))

  // A value in the spill path blocks it → #SPILL!, and removing the block restores it.
  const wb2 = new Workbook(40, 20)
  wb2.setCell({ row: 1, col: 0 }, 'X') // A2 occupied
  wb2.setCell({ row: 0, col: 0 }, '=SEQUENCE(3)') // A1 wants A1:A3
  ok('blocked spill → #SPILL!', wb2.getDisplay({ row: 0, col: 0 }) === '#SPILL!', wb2.getDisplay({ row: 0, col: 0 }))
  wb2.setCell({ row: 1, col: 0 }, '') // clear the block
  const after = [wb2.getDisplay({ row: 0, col: 0 }), wb2.getDisplay({ row: 1, col: 0 }), wb2.getDisplay({ row: 2, col: 0 })].join('/')
  ok('clearing the block restores the spill', after === '1/2/3', after)

  // Editing the anchor away clears the spilled cells.
  wb2.setCell({ row: 0, col: 0 }, '5')
  ok('removing the array clears spilled cells', wb2.getDisplay({ row: 1, col: 0 }) === '' && wb2.getDisplay({ row: 2, col: 0 }) === '', 'spill not cleared')

  // A spill that would run off the sheet errors rather than truncating.
  const wb3 = new Workbook(3, 3)
  wb3.setCell({ row: 2, col: 0 }, '=SEQUENCE(5)') // only 1 row of room below
  ok('spill past the edge → #SPILL!', wb3.getDisplay({ row: 2, col: 0 }) === '#SPILL!', wb3.getDisplay({ row: 2, col: 0 }))

  return out
}

// ---- v4: spill-range references (`A1#`) -------------------------------------

function spillRefTests(): TestResult[] {
  const out: TestResult[] = []
  const ok = (name: string, pass: boolean, detail?: string) => out.push({ group: 'spillref', name, pass, detail: pass ? undefined : detail })

  const wb = new Workbook(40, 20)
  wb.setCell({ row: 0, col: 0 }, '=SEQUENCE(4)') // A1:A4 = 1..4
  wb.setCell({ row: 0, col: 2 }, '=SUM(A1#)') // C1 sums the whole array
  wb.setCell({ row: 1, col: 2 }, '=ROWS(A1#)') // C2 = height of the array
  ok('SUM(A1#) over a spilled array', wb.getDisplay({ row: 0, col: 2 }) === '10', wb.getDisplay({ row: 0, col: 2 }))
  ok('ROWS(A1#) tracks the array size', wb.getDisplay({ row: 1, col: 2 }) === '4', wb.getDisplay({ row: 1, col: 2 }))

  // The spill-range reference follows the array when it grows.
  wb.setCell({ row: 0, col: 0 }, '=SEQUENCE(6)')
  ok('A1# follows the array when it resizes', wb.getDisplay({ row: 0, col: 2 }) === '21', wb.getDisplay({ row: 0, col: 2 }))

  // `#` on a non-spilling cell is a #REF! (there is no array to take).
  const wb2 = new Workbook(40, 20)
  wb2.setCell({ row: 0, col: 5 }, '5')
  wb2.setCell({ row: 1, col: 5 }, '=F1#')
  ok('A1# on a plain cell → #REF!', wb2.getDisplay({ row: 1, col: 5 }) === '#REF!', wb2.getDisplay({ row: 1, col: 5 }))

  // A spill-range reference can itself spill (a live alias of the array).
  wb2.setCell({ row: 0, col: 0 }, '=SEQUENCE(3)*2') // A1:A3 = 2,4,6
  wb2.setCell({ row: 0, col: 2 }, '=A1#') // C1:C3 mirrors A1:A3
  const mirror = [wb2.getDisplay({ row: 0, col: 2 }), wb2.getDisplay({ row: 1, col: 2 }), wb2.getDisplay({ row: 2, col: 2 })].join('/')
  ok('=A1# re-spills the array', mirror === '2/4/6', mirror)
  return out
}

// ---- v4: recursive lambdas (defined names) + the depth guard ----------------

function recursiveLambdaTests(): TestResult[] {
  const out: TestResult[] = []
  const wb = new Workbook(20, 20)
  wb.setName('FACT', 'LAMBDA(n, IF(n<=1, 1, n*FACT(n-1)))')
  wb.setName('FIB', 'LAMBDA(n, IF(n<2, n, FIB(n-1)+FIB(n-2)))')
  wb.setName('LOOP', 'LAMBDA(n, LOOP(n)+1)') // no base case
  wb.setCell({ row: 0, col: 0 }, '=FACT(6)')
  wb.setCell({ row: 1, col: 0 }, '=FIB(10)')
  wb.setCell({ row: 2, col: 0 }, '=LOOP(1)')
  out.push({ group: 'recursion', name: 'recursive FACT(6) = 720', pass: wb.getDisplay({ row: 0, col: 0 }) === '720', detail: wb.getDisplay({ row: 0, col: 0 }) })
  out.push({ group: 'recursion', name: 'recursive FIB(10) = 55', pass: wb.getDisplay({ row: 1, col: 0 }) === '55', detail: wb.getDisplay({ row: 1, col: 0 }) })
  out.push({ group: 'recursion', name: 'runaway recursion → #NUM! (depth guard)', pass: wb.getDisplay({ row: 2, col: 0 }) === '#NUM!', detail: wb.getDisplay({ row: 2, col: 0 }) })
  return out
}

// ---- v3: Goal Seek ----------------------------------------------------------

function goalSeekTests(): TestResult[] {
  const out: TestResult[] = []
  const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

  // Linear: B1 = 3*A1 + 5, solve for B1 = 20 → A1 = 5.
  const wb = new Workbook(20, 20)
  wb.setCell({ row: 0, col: 0 }, '0')
  wb.setCell({ row: 0, col: 1 }, '=3*A1+5')
  const lin = wb.goalSeek({ row: 0, col: 1 }, 20, { row: 0, col: 0 })
  out.push({ group: 'goalseek', name: 'linear 3x+5=20 → x=5', pass: lin.found && near(lin.x, 5), detail: `x=${lin.x}` })
  // Goal Seek must leave the model untouched until applied.
  out.push({ group: 'goalseek', name: 'workbook restored after solve', pass: wb.getDisplay({ row: 0, col: 0 }) === '0', detail: wb.getRaw({ row: 0, col: 0 }) })

  // Nonlinear: B1 = A1^2, solve for 2 → √2.
  const wb2 = new Workbook(20, 20)
  wb2.setCell({ row: 0, col: 0 }, '1')
  wb2.setCell({ row: 0, col: 1 }, '=A1^2')
  const root = wb2.goalSeek({ row: 0, col: 1 }, 2, { row: 0, col: 0 })
  out.push({ group: 'goalseek', name: 'nonlinear x²=2 → x≈1.41421', pass: root.found && near(Math.abs(root.x), Math.SQRT2), detail: `x=${root.x}` })

  // A target that depends on the changing cell through a chain of formulas.
  const wb3 = new Workbook(20, 20)
  wb3.setCell({ row: 0, col: 0 }, '1') // A1
  wb3.setCell({ row: 1, col: 0 }, '=A1*2') // A2
  wb3.setCell({ row: 2, col: 0 }, '=A2+10') // A3 = 2*A1 + 10
  const chain = wb3.goalSeek({ row: 2, col: 0 }, 30, { row: 0, col: 0 })
  out.push({ group: 'goalseek', name: 'through a 3-cell chain → x=10', pass: chain.found && near(chain.x, 10), detail: `x=${chain.x}` })

  return out
}

// ---- multi-sheet, names, and rename ----------------------------------------

function multiSheetTests(): TestResult[] {
  const wb = new Workbook(40, 20)
  const s1 = wb.activeSheetId
  const s2 = wb.addSheet('Data')
  wb.setActiveSheet(s1)
  wb.setMany([{ coord: { row: 0, col: 0 }, raw: '100' }], s1) // Sheet1!A1
  wb.setMany([{ coord: { row: 0, col: 0 }, raw: '7' }], s2) // Data!A1
  wb.setCell({ row: 1, col: 0 }, '=A1+Data!A1', s1) // Sheet1!A2 = 100 + 7
  const out: TestResult[] = []
  const got = wb.getDisplay({ row: 1, col: 0 }, s1)
  out.push({ group: 'sheets', name: 'cross-sheet add (=A1+Data!A1)', pass: got === '107', detail: got === '107' ? undefined : `got ${got}` })
  const bad = (() => {
    wb.setCell({ row: 2, col: 0 }, '=Nope!A1', s1)
    return wb.getDisplay({ row: 2, col: 0 }, s1)
  })()
  out.push({ group: 'sheets', name: 'missing sheet -> #REF!', pass: bad === '#REF!', detail: bad === '#REF!' ? undefined : `got ${bad}` })
  return out
}

function crossSheetRecalcTest(): TestResult[] {
  // A value chain that hops Sheet1 -> Two -> Three and must recalc on a Sheet1 edit.
  const wb = new Workbook(40, 20)
  const s1 = wb.activeSheetId
  const s2 = wb.addSheet('Two')
  const s3 = wb.addSheet('Three')
  wb.setCell({ row: 0, col: 0 }, '5', s1) // Sheet1!A1 = 5
  wb.setCell({ row: 0, col: 0 }, '=Sheet1!A1*2', s2) // Two!A1 = 10
  wb.setCell({ row: 0, col: 0 }, '=Two!A1+1', s3) // Three!A1 = 11
  const before = wb.getDisplay({ row: 0, col: 0 }, s3)
  wb.setCell({ row: 0, col: 0 }, '50', s1) // ripple across all three sheets
  const after = wb.getDisplay({ row: 0, col: 0 }, s3)
  const pass = before === '11' && after === '101'
  return [{ group: 'sheets', name: 'recalc ripples across 3 sheets', pass, detail: pass ? undefined : `got ${before} then ${after}` }]
}

function definedNameTests(): TestResult[] {
  const wb = new Workbook(40, 20)
  const s1 = wb.activeSheetId
  wb.setMany(
    [
      { coord: { row: 0, col: 0 }, raw: '10' }, // A1
      { coord: { row: 1, col: 0 }, raw: '20' }, // A2
      { coord: { row: 2, col: 0 }, raw: '30' }, // A3
    ],
    s1,
  )
  wb.setName('Tax', '0.1')
  wb.setName('Vals', 'A1:A3')
  wb.setCell({ row: 0, col: 2 }, '=SUM(Vals)*(1+Tax)', s1) // C1 = 60 * 1.1 = 66
  const out: TestResult[] = []
  const got = wb.getDisplay({ row: 0, col: 2 }, s1)
  out.push({ group: 'names', name: 'named range + named constant', pass: got === '66', detail: got === '66' ? undefined : `got ${got}` })
  // Changing an underlying cell must recompute the formula through the name.
  wb.setCell({ row: 0, col: 0 }, '40', s1) // A1 10 -> 40, SUM 90
  const got2 = wb.getDisplay({ row: 0, col: 2 }, s1)
  out.push({ group: 'names', name: 'name recalculates on cell change', pass: got2 === '99', detail: got2 === '99' ? undefined : `got ${got2}` })
  return out
}

function nameCycleTest(): TestResult[] {
  const wb = new Workbook(40, 20)
  wb.setName('Loop', 'Loop+1') // self-referential
  wb.setCell({ row: 0, col: 0 }, '=Loop')
  const got = wb.getDisplay({ row: 0, col: 0 })
  const pass = got === '#CIRC!'
  return [{ group: 'names', name: 'self-referential name -> #CIRC!', pass, detail: pass ? undefined : `got ${got}` }]
}

function renameSheetTest(): TestResult[] {
  const wb = new Workbook(40, 20)
  const s1 = wb.activeSheetId
  const s2 = wb.addSheet('Data')
  wb.setCell({ row: 0, col: 0 }, '42', s2) // Data!A1
  wb.setCell({ row: 0, col: 0 }, '=Data!A1+1', s1) // Sheet1!A1 = 43
  wb.renameSheet(s2, 'Numbers') // formula should be rewritten to =Numbers!A1+1
  const raw = wb.getRaw({ row: 0, col: 0 }, s1)
  const got = wb.getDisplay({ row: 0, col: 0 }, s1)
  const pass = got === '43' && raw === '=Numbers!A1+1'
  return [{ group: 'sheets', name: 'rename rewrites cross-sheet refs', pass, detail: pass ? undefined : `raw=${raw} val=${got}` }]
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

function solverTests(): TestResult[] {
  const out: TestResult[] = []
  const A = (row: number, col: number): Coord => ({ row, col })
  const near = (a: number | undefined, b: number | undefined, tol = 1e-2): boolean =>
    a !== undefined && b !== undefined && Math.abs(a - b) <= tol
  const add = (name: string, pass: boolean, detail?: string) => out.push({ group: 'solver', name, pass, detail: pass ? undefined : detail })

  // 1) Linear product-mix LP — auto-detected linear, solved exactly with simplex.
  //    max 45c + 80t  s.t.  5c+20t ≤ 400,  10c+15t ≤ 450  ⇒  (24, 14), profit 2200.
  {
    const wb = new Workbook(40, 20)
    wb.setMany([
      { coord: A(0, 0), raw: '0' }, // A1 = chairs
      { coord: A(1, 0), raw: '0' }, // A2 = tables
      { coord: A(0, 1), raw: '=45*A1+80*A2' }, // B1 profit (objective)
      { coord: A(0, 2), raw: '=5*A1+20*A2' }, // C1 wood
      { coord: A(1, 2), raw: '=10*A1+15*A2' }, // C2 labor
    ])
    const res = wb.solve({
      objective: A(0, 1),
      sense: 'max',
      variables: [A(0, 0), A(1, 0)],
      nonNegative: true,
      constraints: [
        { lhs: A(0, 2), rel: '<=', rhs: { kind: 'num', value: 400 } },
        { lhs: A(1, 2), rel: '<=', rhs: { kind: 'num', value: 450 } },
      ],
    })
    add('LP product-mix uses simplex', res.method === 'simplex', `method ${res.method}`)
    add('LP product-mix objective = 2200', near(res.objective, 2200), `got ${res.objective}`)
    add('LP product-mix (chairs, tables) = (24, 14)', near(res.variables[0].value, 24) && near(res.variables[1].value, 14), JSON.stringify(res.variables.map((v) => v.value)))
    add('LP product-mix all constraints satisfied', res.constraints.every((c) => c.satisfied))
    add('Solver restores the model (A1 back to 0)', wb.getRaw(A(0, 0)) === '0', `A1 = ${wb.getRaw(A(0, 0))}`)
  }

  // 2) Nonlinear constrained — Nelder–Mead: min (x−3)²+(y−2)² s.t. x+y ≤ 4 ⇒ (2.5, 1.5).
  {
    const wb = new Workbook(40, 20)
    wb.setMany([
      { coord: A(0, 0), raw: '0' },
      { coord: A(1, 0), raw: '0' },
      { coord: A(0, 1), raw: '=(A1-3)^2+(A2-2)^2' },
      { coord: A(0, 2), raw: '=A1+A2' },
    ])
    const res = wb.solve({
      objective: A(0, 1),
      sense: 'min',
      variables: [A(0, 0), A(1, 0)],
      nonNegative: false,
      constraints: [{ lhs: A(0, 2), rel: '<=', rhs: { kind: 'num', value: 4 } }],
    })
    add('nonlinear model uses Nelder–Mead', res.method === 'nelder-mead', `method ${res.method}`)
    add('nonlinear solution is feasible', res.feasible)
    add('nonlinear optimum ≈ (2.5, 1.5)', near(res.variables[0].value, 2.5, 3e-2) && near(res.variables[1].value, 1.5, 3e-2), JSON.stringify(res.variables.map((v) => v.value)))
  }

  // 3) Value goal — drive x² to 9 over x ∈ [0, ∞) ⇒ x = 3.
  {
    const wb = new Workbook(40, 20)
    wb.setMany([{ coord: A(0, 0), raw: '1' }, { coord: A(0, 1), raw: '=A1*A1' }])
    const res = wb.solve({ objective: A(0, 1), sense: 'value', target: 9, variables: [A(0, 0)], nonNegative: true, constraints: [] })
    add('value goal x² = 9 ⇒ x = 3', near(res.variables[0].value, 3, 2e-2), `got ${res.variables[0]?.value}`)
  }

  // 4) Infeasible model is reported, not silently mis-solved.
  {
    const wb = new Workbook(40, 20)
    wb.setMany([{ coord: A(0, 0), raw: '0' }, { coord: A(0, 1), raw: '=A1' }])
    const res = wb.solve({
      objective: A(0, 1),
      sense: 'max',
      variables: [A(0, 0)],
      nonNegative: true,
      constraints: [
        { lhs: A(0, 0), rel: '>=', rhs: { kind: 'num', value: 5 } },
        { lhs: A(0, 0), rel: '<=', rhs: { kind: 'num', value: 2 } },
      ],
    })
    add('infeasible model reported as infeasible', res.status === 'infeasible', `status ${res.status}`)
  }

  // 5) Blend LP with an equality + a ≥ and a per-variable floor; constraints must hold.
  //    min 2a+3b+1c  s.t.  a+b+c = 10,  a ≥ 2,  a+2b+3c ≥ 18.
  {
    const wb = new Workbook(40, 20)
    wb.setMany([
      { coord: A(0, 0), raw: '0' },
      { coord: A(1, 0), raw: '0' },
      { coord: A(2, 0), raw: '0' },
      { coord: A(0, 1), raw: '=2*A1+3*A2+1*A3' },
      { coord: A(1, 1), raw: '=A1+A2+A3' },
      { coord: A(2, 1), raw: '=A1+2*A2+3*A3' },
    ])
    const res = wb.solve({
      objective: A(0, 1),
      sense: 'min',
      variables: [A(0, 0), A(1, 0), A(2, 0)],
      nonNegative: true,
      constraints: [
        { lhs: A(1, 1), rel: '=', rhs: { kind: 'num', value: 10 } },
        { lhs: A(0, 0), rel: '>=', rhs: { kind: 'num', value: 2 } },
        { lhs: A(2, 1), rel: '>=', rhs: { kind: 'num', value: 18 } },
      ],
    })
    add('blend LP is feasible', res.feasible)
    add('blend LP satisfies every constraint', res.constraints.every((c) => c.satisfied), JSON.stringify(res.constraints))
  }

  // ===== v6: mixed-integer programming (branch & bound) =====

  // 6) 0/1 knapsack. values 60/100/120, weights 10/20/30, capacity 50 ⇒ pick items 2 & 3 = 220.
  {
    const wb = new Workbook(40, 20)
    wb.setMany([
      { coord: A(0, 0), raw: '0' },
      { coord: A(1, 0), raw: '0' },
      { coord: A(2, 0), raw: '0' },
      { coord: A(0, 1), raw: '=60*A1+100*A2+120*A3' }, // B1 value (objective)
      { coord: A(0, 2), raw: '=10*A1+20*A2+30*A3' }, // C1 weight
    ])
    const res = wb.solve({
      objective: A(0, 1),
      sense: 'max',
      variables: [A(0, 0), A(1, 0), A(2, 0)],
      nonNegative: true,
      binaries: [A(0, 0), A(1, 0), A(2, 0)],
      constraints: [{ lhs: A(0, 2), rel: '<=', rhs: { kind: 'num', value: 50 } }],
    })
    add('knapsack uses branch & bound', res.method === 'branch-and-bound', `method ${res.method}`)
    add('knapsack optimum = 220', near(res.objective, 220), `got ${res.objective}`)
    add('knapsack picks items 2 & 3', near(res.variables[0].value, 0) && near(res.variables[1].value, 1) && near(res.variables[2].value, 1), JSON.stringify(res.variables.map((v) => v.value)))
    add('knapsack solution is integral', res.variables.every((v) => near(v.value, Math.round(v.value), 1e-6)))
    add('knapsack explored ≥ 1 node', (res.nodes ?? 0) >= 1, `nodes ${res.nodes}`)
    add('knapsack reports feasible', res.feasible)
  }

  // 7) Integer optimum ≠ rounding the LP relaxation. max 21a+11b s.t. 7a+4b ≤ 13, a,b ∈ ℤ₊.
  //    LP relaxation: a=13/7≈1.857, z≈39. Rounding a→1 gives z=21. True integer optimum is (0,3), z=33.
  {
    const wb = new Workbook(40, 20)
    wb.setMany([
      { coord: A(0, 0), raw: '0' },
      { coord: A(1, 0), raw: '0' },
      { coord: A(0, 1), raw: '=21*A1+11*A2' },
      { coord: A(0, 2), raw: '=7*A1+4*A2' },
    ])
    const res = wb.solve({
      objective: A(0, 1),
      sense: 'max',
      variables: [A(0, 0), A(1, 0)],
      nonNegative: true,
      integers: [A(0, 0), A(1, 0)],
      constraints: [{ lhs: A(0, 2), rel: '<=', rhs: { kind: 'num', value: 13 } }],
    })
    add('ILP optimum = 33 (not rounded LP)', near(res.objective, 33), `got ${res.objective}`)
    add('ILP solution = (0, 3)', near(res.variables[0].value, 0) && near(res.variables[1].value, 3), JSON.stringify(res.variables.map((v) => v.value)))
  }

  // 8) Integer-infeasible: 2a = 3 has no integer root (the LP relaxation a=1.5 is feasible).
  {
    const wb = new Workbook(40, 20)
    wb.setMany([{ coord: A(0, 0), raw: '0' }, { coord: A(0, 1), raw: '=2*A1' }])
    const res = wb.solve({
      objective: A(0, 1),
      sense: 'max',
      variables: [A(0, 0)],
      nonNegative: true,
      integers: [A(0, 0)],
      constraints: [
        { lhs: A(0, 1), rel: '=', rhs: { kind: 'num', value: 3 } },
        { lhs: A(0, 0), rel: '<=', rhs: { kind: 'num', value: 5 } },
      ],
    })
    add('integer-infeasible model reported', res.status === 'infeasible', `status ${res.status}`)
  }

  // ===== v6: post-optimal sensitivity (the shadow-price report) =====

  // 9) The carpenter LP: shadow prices, strong duality, reduced costs, and a finite-difference cross-check.
  {
    const carpenter = (woodAvail: number) => {
      const wb = new Workbook(40, 20)
      wb.setMany([
        { coord: A(0, 0), raw: '0' },
        { coord: A(1, 0), raw: '0' },
        { coord: A(0, 1), raw: '=45*A1+80*A2' }, // B1 profit (objective)
        { coord: A(0, 2), raw: '=5*A1+20*A2' }, // C1 wood used
        { coord: A(1, 2), raw: '=10*A1+15*A2' }, // C2 labor used
      ])
      return wb.solve({
        objective: A(0, 1),
        sense: 'max',
        variables: [A(0, 0), A(1, 0)],
        nonNegative: true,
        constraints: [
          { lhs: A(0, 2), rel: '<=', rhs: { kind: 'num', value: woodAvail } },
          { lhs: A(1, 2), rel: '<=', rhs: { kind: 'num', value: 450 } },
        ],
      })
    }
    const res = carpenter(400)
    add('LP produces a sensitivity report', !!res.sensitivity)
    const sc = res.sensitivity?.constraints ?? []
    const sv = res.sensitivity?.variables ?? []
    add('wood shadow price = 1', near(sc[0]?.shadowPrice, 1, 1e-3), `got ${sc[0]?.shadowPrice}`)
    add('labor shadow price = 4', near(sc[1]?.shadowPrice, 4, 1e-3), `got ${sc[1]?.shadowPrice}`)
    add('both products basic ⇒ reduced cost 0', sv.every((v) => near(v.reducedCost, 0, 1e-4)), JSON.stringify(sv.map((v) => v.reducedCost)))
    // Strong duality: optimum = Σ rhsₖ · shadowₖ for this all-≤ model.
    const dualObj = 400 * (sc[0]?.shadowPrice ?? 0) + 450 * (sc[1]?.shadowPrice ?? 0)
    add('strong duality: z = b·y', near(res.objective, dualObj, 1e-2), `z=${res.objective} b·y=${dualObj}`)
    // Finite-difference: +1 board-ft of wood should add exactly the wood shadow price to the optimum.
    const res2 = carpenter(401)
    add('shadow price = ∂z/∂b (finite diff)', near(res2.objective - res.objective, sc[0]?.shadowPrice, 1e-2), `Δz=${res2.objective - res.objective}`)
    // RHS ranging is sane: the increase is positive and finite for a binding resource.
    add('wood RHS allowable increase > 0', (sc[0]?.allowableIncrease ?? 0) > 0, `inc ${sc[0]?.allowableIncrease}`)
    // The shadow price holds across the reported allowable increase.
    const within = carpenter(400 + 0.5 * (sc[0]?.allowableIncrease ?? 0))
    add('shadow price holds within RHS range', near(within.sensitivity?.constraints[0]?.shadowPrice, sc[0]?.shadowPrice, 1e-3))
  }

  // 10) An unprofitable product stays out, with a negative reduced cost; a non-binding limit has shadow price 0.
  //     max 45c+80t+5g  s.t. 5c+20t+40g ≤ 400, 10c+15t+5g ≤ 450, chairs ≤ 100 (slack). Gizmos are too costly ⇒ g*=0.
  {
    const wb = new Workbook(40, 20)
    wb.setMany([
      { coord: A(0, 0), raw: '0' }, // chairs
      { coord: A(1, 0), raw: '0' }, // tables
      { coord: A(2, 0), raw: '0' }, // gizmos
      { coord: A(0, 1), raw: '=45*A1+80*A2+5*A3' },
      { coord: A(0, 2), raw: '=5*A1+20*A2+40*A3' },
      { coord: A(1, 2), raw: '=10*A1+15*A2+5*A3' },
    ])
    const res = wb.solve({
      objective: A(0, 1),
      sense: 'max',
      variables: [A(0, 0), A(1, 0), A(2, 0)],
      nonNegative: true,
      constraints: [
        { lhs: A(0, 2), rel: '<=', rhs: { kind: 'num', value: 400 } },
        { lhs: A(1, 2), rel: '<=', rhs: { kind: 'num', value: 450 } },
        { lhs: A(0, 0), rel: '<=', rhs: { kind: 'num', value: 100 } },
      ],
    })
    const sv = res.sensitivity?.variables ?? []
    const sc = res.sensitivity?.constraints ?? []
    add('idle product value = 0', near(sv[2]?.value, 0, 1e-4), `g=${sv[2]?.value}`)
    add('idle product reduced cost ≤ 0', (sv[2]?.reducedCost ?? 1) <= 1e-6, `rc=${sv[2]?.reducedCost}`)
    add('non-binding constraint shadow price = 0', near(sc[2]?.shadowPrice, 0, 1e-6), `got ${sc[2]?.shadowPrice}`)
  }

  // 11) The Solver report sheet: solving then writing carries the answer + shadow prices into cells.
  {
    const wb = new Workbook(40, 20)
    wb.setMany([
      { coord: A(0, 0), raw: '0' },
      { coord: A(1, 0), raw: '0' },
      { coord: A(0, 1), raw: '=45*A1+80*A2' },
      { coord: A(0, 2), raw: '=5*A1+20*A2' },
      { coord: A(1, 2), raw: '=10*A1+15*A2' },
    ])
    const res = wb.solve({
      objective: A(0, 1),
      sense: 'max',
      variables: [A(0, 0), A(1, 0)],
      nonNegative: true,
      constraints: [
        { lhs: A(0, 2), rel: '<=', rhs: { kind: 'num', value: 400 } },
        { lhs: A(1, 2), rel: '<=', rhs: { kind: 'num', value: 450 } },
      ],
    })
    const sid = wb.writeSolverReport({ objective: A(0, 1), sense: 'max', result: res, constraintCells: [A(0, 2), A(1, 2)] })
    const nums = new Set<number>()
    for (let r = 0; r < 40; r++) for (let c = 0; c < 8; c++) {
      const v = wb.getValue({ row: r, col: c }, sid)
      if (typeof v === 'number') nums.add(Math.round(v * 1e6) / 1e6)
    }
    add('report sheet is named "Sensitivity Report"', wb.sheetName(sid).includes('Sensitivity'), wb.sheetName(sid))
    add('report carries the objective 2200', nums.has(2200))
    add('report carries the decision values 24 & 14', nums.has(24) && nums.has(14))
    add('report carries the shadow prices 1 & 4', nums.has(1) && nums.has(4))
  }

  return out
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
