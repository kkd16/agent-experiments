// The workbook model. It owns the grid of raw cell inputs, parses formulas, builds
// the precedent/dependent dependency graph, and recomputes values in topological
// order — marking every cell caught in a circular reference as #CIRC!. The whole
// sheet is recomputed on each edit; with a few thousand live cells this is
// instantaneous, and it keeps the invariant ("values always reflect inputs") dead
// simple and impossible to get subtly wrong.

import type { Node } from './ast'
import type { Coord } from './address'
import { coordKey, keyToCoord, boxOf } from './address'
import type { RuntimeValue, Scalar, SparklineValue } from './values'
import { BLANK, err, isSparkline, asScalar, displayValue } from './values'
import { parseFormula, collectRefs, ParseError } from './parser'
import { evaluate } from './evaluator'
import type { EvalContext } from './evaluator'

export interface CellRecord {
  /** Exactly what the user typed (with leading `=` for formulas). */
  raw: string
  /** Parsed AST for formulas, else null. */
  ast: Node | null
  /** Human-readable parse error, if the formula didn't parse. */
  parseError: string | null
  /** Literal value for non-formula cells (number/text/boolean). */
  literal: Scalar | null
}

const NUMERIC_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/

export class Workbook {
  readonly rows: number
  readonly cols: number
  private cells = new Map<string, CellRecord>()
  private values = new Map<string, Scalar | SparklineValue>()
  private precedents = new Map<string, Set<string>>()
  private dependents = new Map<string, Set<string>>()

  constructor(rows = 200, cols = 52) {
    this.rows = rows
    this.cols = cols
  }

  // ---- reads ----------------------------------------------------------------

  getRaw(coord: Coord): string {
    return this.cells.get(coordKey(coord.row, coord.col))?.raw ?? ''
  }

  isFormula(coord: Coord): boolean {
    return this.cells.get(coordKey(coord.row, coord.col))?.ast != null
  }

  parseErrorAt(coord: Coord): string | null {
    return this.cells.get(coordKey(coord.row, coord.col))?.parseError ?? null
  }

  getValue(coord: Coord): RuntimeValue {
    return this.values.get(coordKey(coord.row, coord.col)) ?? BLANK
  }

  getDisplay(coord: Coord): string {
    return displayValue(this.getValue(coord))
  }

  precedentsOf(coord: Coord): Coord[] {
    const set = this.precedents.get(coordKey(coord.row, coord.col))
    return set ? [...set].map(keyToCoord) : []
  }

  dependentsOf(coord: Coord): Coord[] {
    const set = this.dependents.get(coordKey(coord.row, coord.col))
    return set ? [...set].map(keyToCoord) : []
  }

  /** Total count of non-empty cells — handy for the status bar. */
  get population(): number {
    return this.cells.size
  }

  // ---- writes ---------------------------------------------------------------

  setCell(coord: Coord, raw: string): void {
    const key = coordKey(coord.row, coord.col)
    if (raw === '') {
      this.cells.delete(key)
    } else {
      this.cells.set(key, this.compile(raw))
    }
    this.recompute()
  }

  /** Bulk-set without recomputing between writes (used for loading & paste). */
  setMany(entries: Array<{ coord: Coord; raw: string }>): void {
    for (const { coord, raw } of entries) {
      const key = coordKey(coord.row, coord.col)
      if (raw === '') this.cells.delete(key)
      else this.cells.set(key, this.compile(raw))
    }
    this.recompute()
  }

  clear(): void {
    this.cells.clear()
    this.recompute()
  }

  private compile(raw: string): CellRecord {
    if (raw.startsWith('=')) {
      try {
        const ast = parseFormula(raw.slice(1))
        return { raw, ast, parseError: null, literal: null }
      } catch (e) {
        const msg = e instanceof ParseError ? e.message : String(e)
        return { raw, ast: null, parseError: msg, literal: null }
      }
    }
    return { raw, ast: null, parseError: null, literal: literalOf(raw) }
  }

  // ---- the recompute engine -------------------------------------------------

  private recompute(): void {
    this.values.clear()
    this.precedents.clear()
    this.dependents.clear()

    // Seed literal values; collect the formula cells.
    const formulaKeys: string[] = []
    for (const [key, rec] of this.cells) {
      if (rec.ast) formulaKeys.push(key)
      else if (rec.literal !== null) this.values.set(key, rec.literal)
    }

    // Build the dependency graph. precedents = every cell a formula reads
    // (ranges expanded); edges for ordering only matter between formula cells.
    const formulaSet = new Set(formulaKeys)
    const indegree = new Map<string, number>()
    const edges = new Map<string, Set<string>>() // precedent -> dependents (formula only)
    for (const key of formulaKeys) indegree.set(key, 0)

    for (const key of formulaKeys) {
      const rec = this.cells.get(key)!
      const precedentKeys = new Set<string>()
      // Single-cell refs (and range corners) from a static collect...
      for (const ref of collectRefs(rec.ast!)) precedentKeys.add(coordKey(ref.row, ref.col))
      // ...then expand every range node into the full set of cells it covers.
      expandRangeRefs(rec.ast!, precedentKeys)

      this.precedents.set(key, precedentKeys)
      for (const p of precedentKeys) {
        if (!this.dependents.has(p)) this.dependents.set(p, new Set())
        this.dependents.get(p)!.add(key)
        if (formulaSet.has(p)) {
          if (!edges.has(p)) edges.set(p, new Set())
          if (!edges.get(p)!.has(key)) {
            edges.get(p)!.add(key)
            indegree.set(key, (indegree.get(key) ?? 0) + 1)
          }
        }
      }
    }

    // Kahn's algorithm for a topological order over formula cells.
    const queue: string[] = []
    for (const key of formulaKeys) if ((indegree.get(key) ?? 0) === 0) queue.push(key)
    const order: string[] = []
    while (queue.length) {
      const key = queue.shift()!
      order.push(key)
      for (const dep of edges.get(key) ?? []) {
        const d = (indegree.get(dep) ?? 0) - 1
        indegree.set(dep, d)
        if (d === 0) queue.push(dep)
      }
    }

    // Anything not emitted is part of a cycle → #CIRC! (set first so dependents read it).
    const ordered = new Set(order)
    for (const key of formulaKeys) {
      if (!ordered.has(key)) this.values.set(key, err('#CIRC!', 'circular reference'))
    }

    const ctxBase: Omit<EvalContext, 'current'> = {
      rows: this.rows,
      cols: this.cols,
      getCell: (c) => {
        const v = this.values.get(coordKey(c.row, c.col))
        if (v === undefined) return BLANK
        return isSparkline(v) ? err('#VALUE!') : v
      },
    }

    for (const key of order) {
      const rec = this.cells.get(key)!
      const coord = keyToCoord(key)
      if (rec.parseError) {
        this.values.set(key, err('#PARSE!', rec.parseError))
        continue
      }
      const result = evaluate(rec.ast!, { ...ctxBase, current: coord })
      this.values.set(key, isSparkline(result) ? result : asScalar(result))
    }
  }

  // ---- serialization --------------------------------------------------------

  toJSON(): { rows: number; cols: number; cells: Record<string, string> } {
    const out: Record<string, string> = {}
    for (const [key, rec] of this.cells) out[key] = rec.raw
    return { rows: this.rows, cols: this.cols, cells: out }
  }

  loadJSON(data: { cells: Record<string, string> }): void {
    this.cells.clear()
    for (const [key, raw] of Object.entries(data.cells ?? {})) {
      if (raw !== '') this.cells.set(key, this.compile(raw))
    }
    this.recompute()
  }
}

function literalOf(raw: string): Scalar {
  if (raw.startsWith("'")) return raw.slice(1) // forced text
  const t = raw.trim()
  const upper = t.toUpperCase()
  if (upper === 'TRUE') return true
  if (upper === 'FALSE') return false
  if (NUMERIC_RE.test(t)) {
    const n = Number(t)
    if (Number.isFinite(n)) return n
  }
  return raw
}

// collectRefs alone can't tell a range's two corners apart from two stray refs,
// so we walk the AST once more to expand range nodes into their full cell sets.
function expandRangeRefs(node: Node, into: Set<string>): void {
  switch (node.type) {
    case 'range': {
      const box = boxOf({ row: node.from.row, col: node.from.col }, { row: node.to.row, col: node.to.col })
      for (let r = box.top; r <= box.bottom; r++) {
        for (let c = box.left; c <= box.right; c++) into.add(coordKey(r, c))
      }
      break
    }
    case 'unary':
    case 'percent':
      expandRangeRefs(node.operand, into)
      break
    case 'binary':
      expandRangeRefs(node.left, into)
      expandRangeRefs(node.right, into)
      break
    case 'call':
      for (const a of node.args) expandRangeRefs(a, into)
      break
    default:
      break
  }
}
