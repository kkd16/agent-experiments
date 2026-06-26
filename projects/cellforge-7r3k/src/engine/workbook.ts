// The workbook model. v2 generalizes the v1 single grid into a *workbook* of many
// sheets that can reference one another. There is one global dependency graph and
// one value store spanning every sheet, keyed by a "global key" (sheetId ␟ row,col);
// the whole workbook is recomputed in topological order on each edit, so a change on
// one sheet ripples through formulas on any other. Cells also carry optional
// formatting, sheets carry charts, and the workbook carries a table of defined names.
// The model stays entirely free of React.

import type { Node } from './ast'
import type { Coord, RangeBox } from './address'
import { coordKey, keyToCoord, boxOf } from './address'
import type { RuntimeValue, Scalar, SparklineValue, MatrixValue } from './values'
import { BLANK, err, isSparkline, isMatrix, asScalar, matrix, displayValue } from './values'
import { solve } from './solver'
import type { GoalSeekResult } from './solver'
import { optimize } from './optimizer'
import type { Relation, VarBound, Constraint, OptStatus, OptMethod } from './optimizer'
import { parseFormula, ParseError } from './parser'
import { renameSheetInFormula } from './rewrite'
import { evaluate } from './evaluator'
import type { EvalContext } from './evaluator'
import type { CellFormat } from './format'
import { displayWithFormat, isEmptyFormat } from './format'
import type { ChartSpec } from './chart'

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

export interface SheetMeta {
  id: string
  name: string
}

export interface DefinedName {
  /** Display name (original case). */
  name: string
  /** Definition formula body (no leading `=`), e.g. `Sheet1!A1:A10` or `0.0825`. */
  formula: string
  /** Sheet that unqualified references in the definition bind to. */
  scopeSheetId: string
  ast: Node | null
  parseError: string | null
}

interface Sheet {
  id: string
  name: string
  cells: Map<string, CellRecord>
  formats: Map<string, CellFormat>
  charts: ChartSpec[]
}

/** A reference resolved to a concrete sheet + cell, for the dependency inspector. */
export interface ResolvedRef {
  sheetName: string
  sameSheet: boolean
  coord: Coord
}

/** Where a cell sits inside a spilled dynamic array, for the UI. */
export interface SpillInfo {
  /** Top-left cell of the array (the cell that holds the formula). */
  anchor: Coord
  /** True when *this* cell is the anchor; false for the cells it spilled into. */
  isAnchor: boolean
  /** The full rectangle the array occupies. */
  region: RangeBox
}

const NUMERIC_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/
const SEP = '␟' // global-key separator (a control char that never appears in ids)

const gkey = (sheetId: string, cellKey: string): string => sheetId + SEP + cellKey
function ungkey(gk: string): { sheetId: string; cellKey: string } {
  const idx = gk.indexOf(SEP)
  return { sheetId: gk.slice(0, idx), cellKey: gk.slice(idx + 1) }
}

export class Workbook {
  readonly rows: number
  readonly cols: number
  private sheets: Sheet[] = []
  private activeId = ''
  private nextSheetNum = 1
  private nextChartNum = 1
  private names = new Map<string, DefinedName>() // UPPERCASE name -> definition

  private values = new Map<string, Scalar | SparklineValue>() // gkey -> value
  private precedents = new Map<string, Set<string>>() // gkey -> precedent gkeys
  private dependents = new Map<string, Set<string>>() // gkey -> dependent gkeys

  // Dynamic-array spill bookkeeping (rebuilt every recompute, never serialized).
  private spillOwner = new Map<string, string>() // any covered gkey -> its anchor gkey
  private spillRegion = new Map<string, RangeBox>() // anchor gkey -> the rectangle it fills
  // The regions committed *so far* in the in-progress pass — read by `A1#` spill
  // references, which are always ordered after their anchor so the region exists.
  private liveRegions = new Map<string, RangeBox>()

  constructor(rows = 200, cols = 52) {
    this.rows = rows
    this.cols = cols
    const first = this.makeSheet('Sheet1')
    this.sheets.push(first)
    this.activeId = first.id
  }

  private makeSheet(name: string): Sheet {
    return { id: `s${this.nextSheetNum++}`, name, cells: new Map(), formats: new Map(), charts: [] }
  }

  // ---- sheet management -----------------------------------------------------

  get activeSheetId(): string {
    return this.activeId
  }

  sheetList(): SheetMeta[] {
    return this.sheets.map((s) => ({ id: s.id, name: s.name }))
  }

  sheetName(id: string): string {
    return this.sheets.find((s) => s.id === id)?.name ?? '?'
  }

  setActiveSheet(id: string): void {
    if (this.sheets.some((s) => s.id === id)) this.activeId = id
  }

  private sheet(id?: string): Sheet {
    const sid = id ?? this.activeId
    return this.sheets.find((s) => s.id === sid) ?? this.sheets[0]
  }

  private sheetByName(name: string): Sheet | undefined {
    const lower = name.toLowerCase()
    return this.sheets.find((s) => s.name.toLowerCase() === lower)
  }

  private uniqueName(base: string): string {
    let name = base
    let k = 2
    while (this.sheetByName(name)) name = `${base} ${k++}`
    return name
  }

  addSheet(name?: string): string {
    const s = this.makeSheet(this.uniqueName(name?.trim() || `Sheet${this.sheets.length + 1}`))
    this.sheets.push(s)
    this.activeId = s.id
    this.recompute()
    return s.id
  }

  /** Rename a sheet, rewriting every formula (across all sheets and names) that
   *  qualified a reference with the old name so links survive the rename. */
  renameSheet(id: string, rawName: string): boolean {
    const name = rawName.trim()
    const target = this.sheets.find((s) => s.id === id)
    if (!target || name === '' || name === target.name) return false
    if (this.sheetByName(name)) return false // name collision
    const oldName = target.name
    target.name = name
    this.rewriteFormulas((raw) => renameSheetInFormula(raw, oldName, name))
    this.recompute()
    return true
  }

  duplicateSheet(id: string): string | null {
    const src = this.sheets.find((s) => s.id === id)
    if (!src) return null
    const copy = this.makeSheet(this.uniqueName(`${src.name} copy`))
    copy.cells = new Map([...src.cells].map(([k, v]) => [k, { ...v }]))
    copy.formats = new Map([...src.formats].map(([k, v]) => [k, { ...v }]))
    copy.charts = src.charts.map((c) => ({ ...c, id: `c${this.nextChartNum++}` }))
    const at = this.sheets.findIndex((s) => s.id === id)
    this.sheets.splice(at + 1, 0, copy)
    this.activeId = copy.id
    this.recompute()
    return copy.id
  }

  deleteSheet(id: string): boolean {
    if (this.sheets.length <= 1) return false
    const at = this.sheets.findIndex((s) => s.id === id)
    if (at < 0) return false
    this.sheets.splice(at, 1)
    if (this.activeId === id) this.activeId = this.sheets[Math.max(0, at - 1)].id
    this.recompute()
    return true
  }

  moveSheet(id: string, toIndex: number): void {
    const from = this.sheets.findIndex((s) => s.id === id)
    if (from < 0) return
    const [s] = this.sheets.splice(from, 1)
    this.sheets.splice(Math.max(0, Math.min(this.sheets.length, toIndex)), 0, s)
  }

  // ---- reads ----------------------------------------------------------------

  getRaw(coord: Coord, sheetId?: string): string {
    return this.sheet(sheetId).cells.get(coordKey(coord.row, coord.col))?.raw ?? ''
  }

  isFormula(coord: Coord, sheetId?: string): boolean {
    return this.sheet(sheetId).cells.get(coordKey(coord.row, coord.col))?.ast != null
  }

  parseErrorAt(coord: Coord, sheetId?: string): string | null {
    return this.sheet(sheetId).cells.get(coordKey(coord.row, coord.col))?.parseError ?? null
  }

  getValue(coord: Coord, sheetId?: string): RuntimeValue {
    return this.values.get(gkey(sheetId ?? this.activeId, coordKey(coord.row, coord.col))) ?? BLANK
  }

  getFormat(coord: Coord, sheetId?: string): CellFormat | undefined {
    return this.sheet(sheetId).formats.get(coordKey(coord.row, coord.col))
  }

  getDisplay(coord: Coord, sheetId?: string): string {
    return displayWithFormat(this.getValue(coord, sheetId), this.getFormat(coord, sheetId))
  }

  private resolveList(set: Set<string> | undefined): ResolvedRef[] {
    if (!set) return []
    return [...set].map((gk) => {
      const { sheetId, cellKey } = ungkey(gk)
      return { sheetName: this.sheetName(sheetId), sameSheet: sheetId === this.activeId, coord: keyToCoord(cellKey) }
    })
  }

  precedentsOf(coord: Coord, sheetId?: string): ResolvedRef[] {
    return this.resolveList(this.precedents.get(gkey(sheetId ?? this.activeId, coordKey(coord.row, coord.col))))
  }

  dependentsOf(coord: Coord, sheetId?: string): ResolvedRef[] {
    return this.resolveList(this.dependents.get(gkey(sheetId ?? this.activeId, coordKey(coord.row, coord.col))))
  }

  /** Non-empty cells on the active sheet — for the status bar. */
  get population(): number {
    return this.sheet().cells.size
  }

  // ---- writes ---------------------------------------------------------------

  setCell(coord: Coord, raw: string, sheetId?: string): void {
    const sheet = this.sheet(sheetId)
    const key = coordKey(coord.row, coord.col)
    if (raw === '') sheet.cells.delete(key)
    else sheet.cells.set(key, compile(raw))
    this.recompute()
  }

  /** Bulk-set without recomputing between writes (used for loading & paste). */
  setMany(entries: Array<{ coord: Coord; raw: string }>, sheetId?: string): void {
    const sheet = this.sheet(sheetId)
    for (const { coord, raw } of entries) {
      const key = coordKey(coord.row, coord.col)
      if (raw === '') sheet.cells.delete(key)
      else sheet.cells.set(key, compile(raw))
    }
    this.recompute()
  }

  clear(sheetId?: string): void {
    const sheet = this.sheet(sheetId)
    sheet.cells.clear()
    sheet.formats.clear()
    sheet.charts = []
    this.recompute()
  }

  // ---- formatting -----------------------------------------------------------

  /** Merge a partial format patch into every cell of a box. A field set to
   *  `undefined` in the patch is left unchanged; clearing is done via patches that
   *  set fields to their default. */
  applyFormat(box: RangeBox, patch: CellFormat, sheetId?: string): void {
    const sheet = this.sheet(sheetId)
    for (let r = box.top; r <= box.bottom; r++) {
      for (let c = box.left; c <= box.right; c++) {
        const key = coordKey(r, c)
        const merged: CellFormat = { ...(sheet.formats.get(key) ?? {}), ...patch }
        if (isEmptyFormat(merged)) sheet.formats.delete(key)
        else sheet.formats.set(key, merged)
      }
    }
  }

  clearFormat(box: RangeBox, sheetId?: string): void {
    const sheet = this.sheet(sheetId)
    for (let r = box.top; r <= box.bottom; r++)
      for (let c = box.left; c <= box.right; c++) sheet.formats.delete(coordKey(r, c))
  }

  // ---- charts ---------------------------------------------------------------

  chartsOf(sheetId?: string): ChartSpec[] {
    return this.sheet(sheetId).charts
  }

  addChart(spec: Omit<ChartSpec, 'id'>, sheetId?: string): string {
    const id = `c${this.nextChartNum++}`
    this.sheet(sheetId).charts.push({ ...spec, id })
    return id
  }

  updateChart(id: string, patch: Partial<ChartSpec>, sheetId?: string): void {
    const charts = this.sheet(sheetId).charts
    const idx = charts.findIndex((c) => c.id === id)
    if (idx >= 0) charts[idx] = { ...charts[idx], ...patch }
  }

  deleteChart(id: string, sheetId?: string): void {
    const sheet = this.sheet(sheetId)
    sheet.charts = sheet.charts.filter((c) => c.id !== id)
  }

  // ---- defined names --------------------------------------------------------

  listNames(): DefinedName[] {
    return [...this.names.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Whether a string is a legal defined-name identifier (and not a cell ref). */
  static isValidName(name: string): boolean {
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) return false
    if (/^\$?[A-Za-z]+\$?\d+$/.test(name)) return false // looks like a cell reference
    const up = name.toUpperCase()
    return up !== 'TRUE' && up !== 'FALSE'
  }

  setName(name: string, formula: string, scopeSheetId?: string): boolean {
    if (!Workbook.isValidName(name)) return false
    const body = formula.startsWith('=') ? formula.slice(1) : formula
    let ast: Node | null = null
    let parseError: string | null = null
    try {
      ast = parseFormula(body)
    } catch (e) {
      parseError = e instanceof ParseError ? e.message : String(e)
    }
    this.names.set(name.toUpperCase(), {
      name,
      formula: body,
      scopeSheetId: scopeSheetId ?? this.activeId,
      ast,
      parseError,
    })
    this.recompute()
    return true
  }

  deleteName(name: string): void {
    this.names.delete(name.toUpperCase())
    this.recompute()
  }

  // ---- the recompute engine -------------------------------------------------

  private recordAt(gk: string): CellRecord | undefined {
    const { sheetId, cellKey } = ungkey(gk)
    return this.sheets.find((s) => s.id === sheetId)?.cells.get(cellKey)
  }

  /** Recompute every value in the workbook. Dynamic arrays make this iterative: a
   *  formula can return a matrix that *spills* into neighbouring cells, and another
   *  formula may read one of those spilled-into cells. A single topological pass gets
   *  this right whenever the reader references the array's anchor; the rare case where
   *  it only touches an interior spilled cell is resolved by re-running with the spill
   *  ownership discovered last time, which converges in a couple of passes. */
  private recompute(): void {
    const MAX_PASSES = 8
    let ownership = new Map<string, string>()
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const next = this.evalPass(ownership)
      this.spillOwner = next.ownership
      this.spillRegion = next.regions
      if (mapsEqual(next.ownership, ownership)) return
      ownership = next.ownership
    }
  }

  /** One full evaluation pass. `priorOwnership` (from the previous pass) lets us add
   *  the dependency edges that link an array anchor to formulas reading its interior. */
  private evalPass(priorOwnership: Map<string, string>): { ownership: Map<string, string>; regions: Map<string, RangeBox> } {
    this.values.clear()
    this.precedents.clear()
    this.dependents.clear()

    // Seed literal values; collect every formula cell across all sheets (as gkeys).
    const formulaKeys: string[] = []
    for (const sheet of this.sheets) {
      for (const [key, rec] of sheet.cells) {
        const gk = gkey(sheet.id, key)
        if (rec.ast) formulaKeys.push(gk)
        else if (rec.literal !== null) this.values.set(gk, rec.literal)
      }
    }

    // Build the dependency graph: a formula's precedents are the gkeys of every cell
    // it reads (ranges expanded, sheet qualifiers + defined names resolved).
    const formulaSet = new Set(formulaKeys)
    const indegree = new Map<string, number>()
    const edges = new Map<string, Set<string>>()
    for (const gk of formulaKeys) indegree.set(gk, 0)
    const addEdge = (from: string, to: string): void => {
      if (!formulaSet.has(from) || from === to) return
      if (!edges.has(from)) edges.set(from, new Set())
      if (!edges.get(from)!.has(to)) {
        edges.get(from)!.add(to)
        indegree.set(to, (indegree.get(to) ?? 0) + 1)
      }
    }

    for (const gk of formulaKeys) {
      const { sheetId } = ungkey(gk)
      const rec = this.recordAt(gk)!
      const precedentKeys = new Set<string>()
      this.collectPrecedents(rec.ast!, sheetId, precedentKeys, new Set())
      this.precedents.set(gk, precedentKeys)
      for (const p of precedentKeys) {
        if (!this.dependents.has(p)) this.dependents.set(p, new Set())
        this.dependents.get(p)!.add(gk)
        addEdge(p, gk)
        // If `p` was an interior cell of a spilled array last pass, this formula also
        // depends on that array's anchor — order the anchor first so the value exists.
        const anchor = priorOwnership.get(p)
        if (anchor) addEdge(anchor, gk)
      }
    }

    // Kahn's algorithm for a topological order over all formula cells.
    const queue: string[] = []
    for (const gk of formulaKeys) if ((indegree.get(gk) ?? 0) === 0) queue.push(gk)
    const order: string[] = []
    while (queue.length) {
      const gk = queue.shift()!
      order.push(gk)
      for (const dep of edges.get(gk) ?? []) {
        const d = (indegree.get(dep) ?? 0) - 1
        indegree.set(dep, d)
        if (d === 0) queue.push(dep)
      }
    }

    // Anything not emitted is part of a cycle → #CIRC! (set first so dependents read it).
    const ordered = new Set(order)
    for (const gk of formulaKeys) {
      if (!ordered.has(gk)) this.values.set(gk, err('#CIRC!', 'circular reference'))
    }

    const ownership = new Map<string, string>()
    const regions = new Map<string, RangeBox>()
    this.liveRegions = regions // `A1#` references read regions as they are committed
    const claimed = new Set<string>() // cells claimed by some spill this pass

    for (const gk of order) {
      const rec = this.recordAt(gk)!
      const { sheetId, cellKey } = ungkey(gk)
      if (rec.parseError) {
        this.values.set(gk, err('#PARSE!', rec.parseError))
        continue
      }
      const ctx = this.contextFor(sheetId, keyToCoord(cellKey))
      const result = evaluate(rec.ast!, ctx)
      if (isMatrix(result) && (result.rows > 1 || result.cols > 1)) {
        this.spillInto(gk, sheetId, keyToCoord(cellKey), result, ownership, regions, claimed)
      } else {
        this.values.set(gk, isSparkline(result) ? result : asScalar(result))
      }
    }
    return { ownership, regions }
  }

  /** Attempt to spill a matrix result from its anchor cell. On any obstruction the
   *  anchor becomes `#SPILL!` and nothing is written; otherwise every cell of the
   *  rectangle gets its value and is recorded as owned by this anchor. */
  private spillInto(
    gk: string,
    sheetId: string,
    anchor: Coord,
    m: MatrixValue,
    ownership: Map<string, string>,
    regions: Map<string, RangeBox>,
    claimed: Set<string>,
  ): void {
    const bottom = anchor.row + m.rows - 1
    const right = anchor.col + m.cols - 1
    if (bottom >= this.rows || right >= this.cols) {
      this.values.set(gk, err('#SPILL!', 'the array would extend past the sheet'))
      return
    }
    const sheet = this.sheets.find((s) => s.id === sheetId)!
    // Obstruction check: any non-anchor cell in the rectangle that already holds its
    // own content, or that another array already claimed this pass, blocks the spill.
    for (let r = anchor.row; r <= bottom; r++) {
      for (let c = anchor.col; c <= right; c++) {
        if (r === anchor.row && c === anchor.col) continue
        const ck = coordKey(r, c)
        if (sheet.cells.has(ck) || claimed.has(gkey(sheetId, ck))) {
          this.values.set(gk, err('#SPILL!', 'a value is in the way of the array'))
          return
        }
      }
    }
    // Commit the spill.
    for (let r = anchor.row; r <= bottom; r++) {
      for (let c = anchor.col; c <= right; c++) {
        const tgk = gkey(sheetId, coordKey(r, c))
        this.values.set(tgk, m.data[r - anchor.row][c - anchor.col])
        ownership.set(tgk, gk)
        claimed.add(tgk)
      }
    }
    regions.set(gk, { top: anchor.row, left: anchor.col, bottom, right })
  }

  /** Spill membership for a cell, or null if it isn't part of a dynamic array. */
  spillInfo(coord: Coord, sheetId?: string): SpillInfo | null {
    const sid = sheetId ?? this.activeId
    const gk = gkey(sid, coordKey(coord.row, coord.col))
    const owner = this.spillOwner.get(gk)
    if (!owner) return null
    const anchorCoord = keyToCoord(ungkey(owner).cellKey)
    const region = this.spillRegion.get(owner) ?? boxOf(anchorCoord, anchorCoord)
    return { anchor: anchorCoord, isAnchor: owner === gk, region }
  }

  // ---- what-if: Goal Seek ---------------------------------------------------

  /** Find the value of the `changing` cell that drives the `target` cell to
   *  `targetValue`. The workbook is restored to its original state before returning,
   *  so the caller decides whether to apply the result (via `setCell`). */
  goalSeek(target: Coord, targetValue: number, changing: Coord, sheetId?: string): GoalSeekResult & { achieved: number } {
    const sid = sheetId ?? this.activeId
    const savedRaw = this.getRaw(changing, sid)
    const readTarget = (x: number): number => {
      this.setCell(changing, String(x), sid)
      const v = this.getValue(target, sid)
      return typeof v === 'number' ? v : NaN
    }
    const cur = this.getValue(changing, sid)
    const start = typeof cur === 'number' ? cur : 0
    const res = solve(readTarget, targetValue, start)
    this.setCell(changing, savedRaw, sid) // leave the model untouched
    return { ...res, achieved: res.fx }
  }

  // ---- what-if: Data Table (sensitivity grid) -------------------------------

  /** Evaluate a model formula across a grid of substituted inputs — a one- or
   *  two-variable "data table". For every column value (and, when given, every row
   *  value) the input cell(s) are set, the workbook recalculates, and the formula's
   *  resulting value is captured. The model is fully restored before returning, so
   *  the caller materializes the grid wherever it likes. Returns unformatted display
   *  strings (numbers stay numeric when written back as literals). */
  computeDataTable(
    formula: Coord,
    colInput: Coord | null,
    colValues: string[],
    rowInput: Coord | null,
    rowValues: string[],
    sheetId?: string,
  ): string[][] {
    const sid = sheetId ?? this.activeId
    const savedCol = colInput ? this.getRaw(colInput, sid) : null
    const savedRow = rowInput ? this.getRaw(rowInput, sid) : null
    const rows = rowInput ? rowValues : ['']
    const grid: string[][] = []
    for (const cv of colValues) {
      if (colInput) this.setCell(colInput, cv, sid)
      const line: string[] = []
      for (const rv of rows) {
        if (rowInput) this.setCell(rowInput, rv, sid)
        line.push(displayValue(this.getValue(formula, sid)))
      }
      grid.push(line)
    }
    // Restore the model exactly as it was.
    if (colInput && savedCol !== null) this.setCell(colInput, savedCol, sid)
    if (rowInput && savedRow !== null) this.setCell(rowInput, savedRow, sid)
    return grid
  }

  // ---- what-if: the Solver (constrained multi-cell optimization) ------------

  /**
   * Optimize a model: find values for the `variables` (changing) cells that maximize,
   * minimize, or drive the `objective` cell to a target, subject to `constraints`. The
   * model is treated as a black box — each candidate point sets the variable cells,
   * recomputes the whole workbook, and reads the objective + constraint cells back. The
   * engine auto-detects whether the model is *linear* (by probing) and, if so, solves it
   * to the exact vertex optimum with the simplex method; otherwise it runs the nonlinear
   * penalty/Nelder–Mead search. The workbook is fully restored before returning, so the
   * caller decides whether to apply the solution (via `setMany`).
   */
  solve(spec: SolverSpec): SolverResult {
    const sid = spec.sheetId ?? this.activeId
    const vars = spec.variables
    const n = vars.length
    if (n === 0) return solverError('No changing cells were given.')
    if (spec.objective && this.cellInList(spec.objective, vars))
      return solverError('The objective cell cannot also be a changing cell.')

    // Save the raw text of every variable cell so we can restore the model exactly.
    const savedVars = vars.map((c) => this.getRaw(c, sid))

    // Coordinates we read out of each recompute: the objective + every constraint's
    // LHS and (when the RHS is a cell rather than a literal) its RHS.
    const readCoords: Coord[] = []
    const addRead = (c: Coord): number => {
      const idx = readCoords.findIndex((r) => r.row === c.row && r.col === c.col)
      if (idx >= 0) return idx
      readCoords.push(c)
      return readCoords.length - 1
    }
    const objIdx = spec.objective ? addRead(spec.objective) : -1
    const consMeta = spec.constraints.map((c) => ({
      lhsIdx: addRead(c.lhs),
      rhsIdx: c.rhs.kind === 'cell' ? addRead(c.rhs.coord) : -1,
      rhsConst: c.rhs.kind === 'num' ? c.rhs.value : 0,
      rel: c.rel,
    }))

    // A memoized sampler: set the variable cells, recompute once, read every coord.
    let memoX: number[] | null = null
    let memoVals: number[] = []
    const sampleAt = (x: number[]): number[] => {
      if (memoX && memoX.length === x.length && memoX.every((v, i) => v === x[i])) return memoVals
      this.setMany(vars.map((c, i) => ({ coord: c, raw: numToRaw(x[i]) })), sid)
      memoVals = readCoords.map((c) => {
        const v = this.getValue(c, sid)
        return typeof v === 'number' && Number.isFinite(v) ? v : NaN
      })
      memoX = x.slice()
      return memoVals
    }

    const objAt = (x: number[]): number => (objIdx < 0 ? 0 : sampleAt(x)[objIdx])
    const constraints: Constraint[] = consMeta.map((m) => ({
      rel: m.rel,
      rhs: m.rhsIdx < 0 ? m.rhsConst : 0,
      fn: (x: number[]) => {
        const vals = sampleAt(x)
        const lhs = vals[m.lhsIdx]
        return m.rhsIdx < 0 ? lhs : lhs - vals[m.rhsIdx]
      },
    }))

    const bounds: VarBound[] = vars.map(() => ({ lo: spec.nonNegative ? 0 : -Infinity, hi: Infinity }))
    const x0 = vars.map((c) => {
      const v = this.getValue(c, sid)
      return typeof v === 'number' && Number.isFinite(v) ? v : 0
    })

    // Try to extract a linear model (skipped for the 'value' goal, which is nonlinear).
    const linear = spec.sense === 'value' ? null : this.extractLinear(objAt, constraints, n)

    const result = optimize({
      objective: objAt,
      sense: spec.sense,
      target: spec.target,
      x0,
      bounds,
      constraints,
      linear: linear ?? undefined,
    })

    // Read the constraint LHS/RHS at the solution for the report, then restore the model.
    const finalVals = sampleAt(result.x)
    const report: SolverConstraintReport[] = consMeta.map((m) => {
      const lhs = finalVals[m.lhsIdx]
      const rhs = m.rhsIdx < 0 ? m.rhsConst : finalVals[m.rhsIdx]
      const satisfied =
        m.rel === '<=' ? lhs <= rhs + 1e-6 : m.rel === '>=' ? lhs >= rhs - 1e-6 : Math.abs(lhs - rhs) <= 1e-6
      return { lhs, rel: m.rel, rhs, satisfied }
    })
    this.setMany(vars.map((c, i) => ({ coord: c, raw: savedVars[i] })), sid)

    return {
      status: result.status,
      method: result.method,
      variables: vars.map((c, i) => ({ coord: c, value: result.x[i] })),
      objective: result.fx,
      feasible: result.feasible,
      maxViolation: result.maxViolation,
      iterations: result.iterations,
      constraints: report,
    }
  }

  private cellInList(c: Coord, list: Coord[]): boolean {
    return list.some((v) => v.row === c.row && v.col === c.col)
  }

  /**
   * Probe a black-box model to decide whether it is linear, and if so return its exact
   * coefficients. We sample the objective and every constraint at the origin and at each
   * unit vector (so coefficient_j = f(eⱼ) − f(0)), then verify the affine prediction at a
   * fresh test point. Any non-finite reading, or a prediction that misses, means "treat
   * it as nonlinear" — we lose nothing, since the nonlinear solver still handles it.
   */
  private extractLinear(
    objAt: (x: number[]) => number,
    constraints: Constraint[],
    n: number,
  ): { c: number[]; c0: number; A: number[][]; rel: Relation[]; b: number[] } | null {
    const zero = Array(n).fill(0)
    const obj0 = objAt(zero)
    const g0 = constraints.map((c) => c.fn(zero))
    if (!Number.isFinite(obj0) || g0.some((g) => !Number.isFinite(g))) return null

    const cObj = Array(n).fill(0)
    const A: number[][] = constraints.map(() => Array(n).fill(0))
    for (let j = 0; j < n; j++) {
      const e = Array(n).fill(0)
      e[j] = 1
      const objE = objAt(e)
      if (!Number.isFinite(objE)) return null
      cObj[j] = objE - obj0
      for (let k = 0; k < constraints.length; k++) {
        const gE = constraints[k].fn(e)
        if (!Number.isFinite(gE)) return null
        A[k][j] = gE - g0[k]
      }
    }

    // Verify affinity at a non-trivial test point.
    const test = Array.from({ length: n }, (_, j) => (j % 2 === 0 ? 1 : -1) * (1 + 0.37 * j) + 0.5)
    const predObj = obj0 + cObj.reduce((s, a, j) => s + a * test[j], 0)
    const actObj = objAt(test)
    if (!Number.isFinite(actObj) || Math.abs(predObj - actObj) > 1e-6 * (1 + Math.abs(actObj))) return null
    for (let k = 0; k < constraints.length; k++) {
      const predG = g0[k] + A[k].reduce((s, a, j) => s + a * test[j], 0)
      const actG = constraints[k].fn(test)
      if (!Number.isFinite(actG) || Math.abs(predG - actG) > 1e-6 * (1 + Math.abs(actG))) return null
    }

    // Constraint k: g(x) rel rhs ⇒ A·x rel (rhs − g0). Objective constant is obj0.
    const rel = constraints.map((c) => c.rel)
    const b = constraints.map((c, k) => c.rhs - g0[k])
    return { c: cObj, c0: obj0, A, rel, b }
  }

  /** Build an EvalContext for a formula living at (sheetId, coord). */
  private contextFor(sheetId: string, coord: Coord): EvalContext {
    return {
      rows: this.rows,
      cols: this.cols,
      current: coord,
      currentSheet: sheetId,
      getCellAt: (sid, c) => {
        const v = this.values.get(gkey(sid, coordKey(c.row, c.col)))
        if (v === undefined) return BLANK
        return isSparkline(v) ? err('#VALUE!') : v
      },
      getSpillRange: (sid, c) => {
        const region = this.liveRegions.get(gkey(sid, coordKey(c.row, c.col)))
        if (!region) return null
        const data: Scalar[][] = []
        for (let r = region.top; r <= region.bottom; r++) {
          const row: Scalar[] = []
          for (let col = region.left; col <= region.right; col++) {
            const v = this.values.get(gkey(sid, coordKey(r, col)))
            row.push(v === undefined || isSparkline(v) ? BLANK : v)
          }
          data.push(row)
        }
        return matrix(data)
      },
      resolveSheetId: (name) => this.sheetByName(name)?.id ?? null,
      resolveName: (upper) => {
        const dn = this.names.get(upper)
        return dn?.ast ? { ast: dn.ast, scopeSheet: dn.scopeSheetId } : null
      },
    }
  }

  /** Walk an AST, resolving every reference (sheet qualifiers + defined names) into
   *  the global-key set of cells it depends on. `nameStack` guards against a name
   *  that refers to itself, directly or transitively. */
  private collectPrecedents(node: Node, homeSheetId: string, into: Set<string>, nameStack: Set<string>): void {
    switch (node.type) {
      case 'ref':
      case 'spillref': {
        const sid = node.ref.sheet ? this.sheetByName(node.ref.sheet)?.id : homeSheetId
        if (sid && inSheet(node.ref.row, node.ref.col, this.rows, this.cols)) into.add(gkey(sid, coordKey(node.ref.row, node.ref.col)))
        break
      }
      case 'range': {
        const sid = node.from.sheet ? this.sheetByName(node.from.sheet)?.id : homeSheetId
        if (!sid) break
        const box = boxOf({ row: node.from.row, col: node.from.col }, { row: node.to.row, col: node.to.col })
        const top = Math.max(0, box.top)
        const left = Math.max(0, box.left)
        const bottom = Math.min(this.rows - 1, box.bottom)
        const right = Math.min(this.cols - 1, box.right)
        for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) into.add(gkey(sid, coordKey(r, c)))
        break
      }
      case 'name': {
        const upper = node.name.toUpperCase()
        if (nameStack.has(upper)) break
        const dn = this.names.get(upper)
        if (dn?.ast) {
          const next = new Set(nameStack)
          next.add(upper)
          this.collectPrecedents(dn.ast, dn.scopeSheetId, into, next)
        }
        break
      }
      case 'unary':
      case 'percent':
        this.collectPrecedents(node.operand, homeSheetId, into, nameStack)
        break
      case 'binary':
        this.collectPrecedents(node.left, homeSheetId, into, nameStack)
        this.collectPrecedents(node.right, homeSheetId, into, nameStack)
        break
      case 'call':
        for (const a of node.args) this.collectPrecedents(a, homeSheetId, into, nameStack)
        break
      case 'apply':
        this.collectPrecedents(node.fn, homeSheetId, into, nameStack)
        for (const a of node.args) this.collectPrecedents(a, homeSheetId, into, nameStack)
        break
      default:
        break
    }
  }

  /** Apply a text transform to every formula in the workbook (cells + names). */
  private rewriteFormulas(transform: (raw: string) => string): void {
    for (const sheet of this.sheets) {
      for (const [key, rec] of sheet.cells) {
        if (rec.raw.startsWith('=')) {
          const next = transform(rec.raw)
          if (next !== rec.raw) sheet.cells.set(key, compile(next))
        }
      }
    }
    for (const [k, dn] of this.names) {
      const next = transform('=' + dn.formula)
      const body = next.startsWith('=') ? next.slice(1) : next
      if (body !== dn.formula) this.names.set(k, { ...dn, ...compileName(dn, body) })
    }
  }

  // ---- serialization --------------------------------------------------------

  /** A complete, structurally-cloneable snapshot — the unit of undo/redo + persistence. */
  serialize(): WorkbookSnapshot {
    return {
      v: 2,
      rows: this.rows,
      cols: this.cols,
      activeId: this.activeId,
      nextSheetNum: this.nextSheetNum,
      nextChartNum: this.nextChartNum,
      sheets: this.sheets.map((s) => ({
        id: s.id,
        name: s.name,
        cells: Object.fromEntries([...s.cells].map(([k, rec]) => [k, rec.raw])),
        formats: Object.fromEntries([...s.formats]),
        charts: s.charts.map((c) => ({ ...c })),
      })),
      names: [...this.names.values()].map((n) => ({ name: n.name, formula: n.formula, scopeSheetId: n.scopeSheetId })),
    }
  }

  restore(snap: WorkbookSnapshot): void {
    this.sheets = (snap.sheets ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      cells: new Map(Object.entries(s.cells ?? {}).map(([k, raw]) => [k, compile(raw)])),
      formats: new Map(Object.entries(s.formats ?? {})),
      charts: (s.charts ?? []).map((c) => ({ ...c })),
    }))
    if (this.sheets.length === 0) this.sheets.push(this.makeSheet('Sheet1'))
    this.activeId = this.sheets.some((s) => s.id === snap.activeId) ? snap.activeId : this.sheets[0].id
    this.nextSheetNum = Math.max(snap.nextSheetNum ?? 1, this.maxNumericId() + 1)
    this.nextChartNum = snap.nextChartNum ?? 1
    this.names = new Map(
      (snap.names ?? []).map((n) => {
        const dn = compileName({ name: n.name, formula: n.formula, scopeSheetId: n.scopeSheetId, ast: null, parseError: null }, n.formula)
        return [n.name.toUpperCase(), { name: n.name, scopeSheetId: n.scopeSheetId, ...dn }]
      }),
    )
    this.recompute()
  }

  private maxNumericId(): number {
    let max = 0
    for (const s of this.sheets) {
      const m = /^s(\d+)$/.exec(s.id)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return max
  }

  /** Back-compat: emit the full v2 snapshot. */
  toJSON(): WorkbookSnapshot {
    return this.serialize()
  }

  /** Load either a v2 snapshot or a legacy `{ cells }` single-sheet payload. */
  loadJSON(data: WorkbookSnapshot | { cells: Record<string, string> }): void {
    if ('sheets' in data && Array.isArray(data.sheets)) {
      this.restore(data as WorkbookSnapshot)
      return
    }
    // Legacy single-sheet shape — drop it onto a fresh Sheet1.
    const legacy = data as { cells: Record<string, string> }
    const sheet = this.makeSheet('Sheet1')
    this.sheets = [sheet]
    this.activeId = sheet.id
    this.names.clear()
    for (const [key, raw] of Object.entries(legacy.cells ?? {})) {
      if (raw !== '') sheet.cells.set(key, compile(raw))
    }
    this.recompute()
  }
}

export interface WorkbookSnapshot {
  v?: number
  rows: number
  cols: number
  activeId: string
  nextSheetNum: number
  nextChartNum: number
  sheets: Array<{
    id: string
    name: string
    cells: Record<string, string>
    formats: Record<string, CellFormat>
    charts: ChartSpec[]
  }>
  names: Array<{ name: string; formula: string; scopeSheetId: string }>
}

// ---- Solver public types -----------------------------------------------------

/** The right-hand side of a Solver constraint: a literal or another cell. */
export type SolverRhs = { kind: 'num'; value: number } | { kind: 'cell'; coord: Coord }

export interface SolverConstraintInput {
  /** The cell whose value forms the left-hand side (usually a formula). */
  lhs: Coord
  rel: Relation
  rhs: SolverRhs
}

export interface SolverSpec {
  /** The cell to optimize. */
  objective: Coord
  sense: 'max' | 'min' | 'value'
  /** Target value when `sense === 'value'`. */
  target?: number
  /** The changing cells. */
  variables: Coord[]
  /** Constrain changing cells to be ≥ 0 (Excel's "make unconstrained variables non-negative"). */
  nonNegative: boolean
  constraints: SolverConstraintInput[]
  sheetId?: string
}

export interface SolverConstraintReport {
  lhs: number
  rel: Relation
  rhs: number
  satisfied: boolean
}

export interface SolverResult {
  status: OptStatus
  method: OptMethod
  variables: Array<{ coord: Coord; value: number }>
  objective: number
  feasible: boolean
  maxViolation: number
  iterations: number
  constraints: SolverConstraintReport[]
  message?: string
}

function solverError(message: string): SolverResult {
  return { status: 'error', method: 'nelder-mead', variables: [], objective: NaN, feasible: false, maxViolation: Infinity, iterations: 0, constraints: [], message }
}

/** Render a solved numeric variable value as cell input, rounding away float noise and
 *  snapping values that are within tolerance of an integer (the common Solver outcome). */
function numToRaw(x: number): string {
  if (!Number.isFinite(x)) return '0'
  const r = Math.round(x)
  if (Math.abs(x - r) < 1e-7) return String(r)
  return String(Number(x.toPrecision(12)))
}

// ---- module-level helpers ---------------------------------------------------

function inSheet(row: number, col: number, rows: number, cols: number): boolean {
  return row >= 0 && col >= 0 && row < rows && col < cols
}

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

function compile(raw: string): CellRecord {
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

function compileName(_dn: DefinedName, body: string): { formula: string; ast: Node | null; parseError: string | null } {
  try {
    return { formula: body, ast: parseFormula(body), parseError: null }
  } catch (e) {
    return { formula: body, ast: null, parseError: e instanceof ParseError ? e.message : String(e) }
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
