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
import type { RuntimeValue, Scalar, SparklineValue } from './values'
import { BLANK, err, isSparkline, asScalar } from './values'
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

  private recompute(): void {
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

    for (const gk of formulaKeys) {
      const { sheetId } = ungkey(gk)
      const rec = this.recordAt(gk)!
      const precedentKeys = new Set<string>()
      this.collectPrecedents(rec.ast!, sheetId, precedentKeys, new Set())
      this.precedents.set(gk, precedentKeys)
      for (const p of precedentKeys) {
        if (!this.dependents.has(p)) this.dependents.set(p, new Set())
        this.dependents.get(p)!.add(gk)
        if (formulaSet.has(p)) {
          if (!edges.has(p)) edges.set(p, new Set())
          if (!edges.get(p)!.has(gk)) {
            edges.get(p)!.add(gk)
            indegree.set(gk, (indegree.get(gk) ?? 0) + 1)
          }
        }
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

    for (const gk of order) {
      const rec = this.recordAt(gk)!
      const { sheetId, cellKey } = ungkey(gk)
      if (rec.parseError) {
        this.values.set(gk, err('#PARSE!', rec.parseError))
        continue
      }
      const ctx = this.contextFor(sheetId, keyToCoord(cellKey))
      const result = evaluate(rec.ast!, ctx)
      this.values.set(gk, isSparkline(result) ? result : asScalar(result))
    }
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
      case 'ref': {
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

// ---- module-level helpers ---------------------------------------------------

function inSheet(row: number, col: number, rows: number, cols: number): boolean {
  return row >= 0 && col >= 0 && row < rows && col < cols
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
