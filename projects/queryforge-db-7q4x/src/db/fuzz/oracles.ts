// The metamorphic oracles — the heart of the fuzzer. None of them needs a "correct"
// answer to compare against: each is an *identity that must hold* for any sound
// engine, whatever the right answer is. A violation is a guaranteed bug.
//
//   TLP-WHERE     SQL's three-valued logic partitions every row into exactly one of
//                 { p, NOT p, p IS NULL }, so a scan equals the multiset-union of the
//                 three filtered scans.                       (Rigger & Su, FSE 2020)
//   TLP-AGG       The same partition, but checked through COUNT(*) and SUM over the
//                 parts vs. the whole (an aggregate must be partition-additive).
//   NoREC         The optimizer fires on a predicate only inside a WHERE; demote it to
//                 a CASE projection it can't touch and the counts must agree.
//                                                              (Rigger & Su, FSE 2020)
//   DISTINCT      `SELECT DISTINCT x` must equal the engine's own non-distinct scan,
//                 de-duplicated — the optimizer's DISTINCT vs. a ground-truth dedup.
//   OPT-DIFF      The very same query with `SET optimizer = off` (no reordering, no
//                 index paths) must return an identical multiset — a sound optimizer
//                 never changes a result.

import type { Engine } from '../engine'
import type { Row } from '../catalog'
import { hashKey, formatValue } from '../types'
import type { FuzzSchema, GTable } from './schema'
import { buildEngine } from './schema'
import { genPred, genProjection, predToSql, type Pred } from './gen'
import type { Rng } from './rng'

export type OracleKind = 'TLP-WHERE' | 'TLP-AGG' | 'NoREC' | 'DISTINCT' | 'OPT-DIFF'

export interface FuzzInstance {
  kind: OracleKind
  table: string
  projection: string[]
  pred: Pred
  /** An INTEGER column for the additive SUM checks (null if the table has none). */
  intCol: string | null
  /** A grouping column for the OPT-DIFF grouped variant. */
  groupCol: string | null
  /** OPT-DIFF query shape. */
  variant: 'where' | 'group' | 'join'
  /** OPT-DIFF join wiring (only when variant === 'join'). */
  join: { other: string; leftCol: string; rightCol: string } | null
}

export interface Counterexample {
  oracle: OracleKind
  /** The SQL statements that demonstrate the divergence (after the schema is built). */
  queries: string[]
  detail: string
  left: number
  right: number
  /** A few example rows that differ between the two sides. */
  sampleDiff: string[]
}

// --- result helpers ---------------------------------------------------------

function runRows(engine: Engine, sql: string): Row[] {
  const rs = engine.execute(sql)
  const last = rs[rs.length - 1]
  if (!last || last.kind !== 'rows') throw new Error(`expected rows from: ${sql}`)
  return last.rows
}

function scalarInt(engine: Engine, sql: string): number {
  const v = runRows(engine, sql)[0]?.[0]
  return typeof v === 'number' ? v : Number(v ?? 0)
}

/** A multiset of rows, keyed by the engine's own canonical row hash. */
function multiset(rows: Row[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) m.set(hashKey(r), (m.get(hashKey(r)) ?? 0) + 1)
  return m
}

function fmtRow(r: Row): string {
  return `(${r.map(formatValue).join(', ')})`
}

/** Compare two row lists as multisets; return null when equal, else a diff summary. */
function diffMultisets(a: Row[], b: Row[]): { detail: string; sample: string[] } | null {
  const ma = multiset(a)
  const mb = multiset(b)
  if (ma.size === mb.size && [...ma].every(([k, n]) => mb.get(k) === n)) return null
  // Build a human sample: rows whose counts differ, with a representative tuple.
  const repr = new Map<string, Row>()
  for (const r of a) if (!repr.has(hashKey(r))) repr.set(hashKey(r), r)
  for (const r of b) if (!repr.has(hashKey(r))) repr.set(hashKey(r), r)
  const sample: string[] = []
  const keys = new Set([...ma.keys(), ...mb.keys()])
  for (const k of keys) {
    const na = ma.get(k) ?? 0
    const nb = mb.get(k) ?? 0
    if (na !== nb) sample.push(`${fmtRow(repr.get(k)!)} ×${na} vs ×${nb}`)
    if (sample.length >= 6) break
  }
  return { detail: `multiset mismatch (left ${a.length} rows, right ${b.length} rows)`, sample }
}

// --- instance generation ----------------------------------------------------

function intColumns(t: GTable): string[] {
  return ['id', ...t.cols.filter((c) => c.type === 'INTEGER' || c.type === 'REAL').map((c) => c.name)]
}

/** Pick a random oracle instance over the schema. */
export function genInstance(rng: Rng, schema: FuzzSchema, kind?: OracleKind): FuzzInstance {
  const k: OracleKind = kind ?? rng.pick(['TLP-WHERE', 'TLP-AGG', 'NoREC', 'DISTINCT', 'OPT-DIFF'])
  const table = rng.pick(schema.tables)
  const ints = intColumns(table)
  const inst: FuzzInstance = {
    kind: k,
    table: table.name,
    projection: genProjection(rng, table),
    pred: genPred(rng, table.cols),
    intCol: ints.length ? rng.pick(ints) : null,
    groupCol: rng.pick(['id', ...table.cols.map((c) => c.name)]),
    variant: 'where',
    join: null,
  }
  if (k === 'OPT-DIFF') {
    const r = rng.next()
    if (r < 0.4) inst.variant = 'where'
    else if (r < 0.75) inst.variant = 'group'
    else {
      // A 2-table join, when a second table with a join-able integer column exists.
      const other = schema.tables.find((t) => t.name !== table.name)
      const lInts = ints
      const rInts = other ? intColumns(other) : []
      if (other && lInts.length && rInts.length) {
        inst.variant = 'join'
        inst.join = { other: other.name, leftCol: rng.pick(lInts), rightCol: rng.pick(rInts) }
      } else {
        inst.variant = 'group'
      }
    }
  }
  return inst
}

// --- per-oracle checks ------------------------------------------------------

function checkTlpWhere(engine: Engine, inst: FuzzInstance): Counterexample | null {
  const proj = inst.projection.join(', ')
  const T = inst.table
  const p = predToSql(inst.pred)
  const base = `SELECT ${proj} FROM ${T}`
  const q1 = `${base} WHERE (${p})`
  const q2 = `${base} WHERE (NOT (${p}))`
  const q3 = `${base} WHERE (${p}) IS NULL`
  const whole = runRows(engine, base)
  const parts = [...runRows(engine, q1), ...runRows(engine, q2), ...runRows(engine, q3)]
  const d = diffMultisets(whole, parts)
  if (!d) return null
  return { oracle: 'TLP-WHERE', queries: [base, q1, q2, q3], detail: d.detail, left: whole.length, right: parts.length, sampleDiff: d.sample }
}

function checkTlpAgg(engine: Engine, inst: FuzzInstance): Counterexample | null {
  const T = inst.table
  const p = predToSql(inst.pred)
  const where = [`(${p})`, `(NOT (${p}))`, `(${p}) IS NULL`]
  // COUNT(*) is partition-additive.
  const cWhole = scalarInt(engine, `SELECT COUNT(*) FROM ${T}`)
  const cParts = where.reduce((s, w) => s + scalarInt(engine, `SELECT COUNT(*) FROM ${T} WHERE ${w}`), 0)
  if (cWhole !== cParts) {
    return {
      oracle: 'TLP-AGG',
      queries: [`SELECT COUNT(*) FROM ${T}`, ...where.map((w) => `SELECT COUNT(*) FROM ${T} WHERE ${w}`)],
      detail: `COUNT(*) not partition-additive: whole=${cWhole}, parts=${cParts}`,
      left: cWhole,
      right: cParts,
      sampleDiff: [],
    }
  }
  // SUM over an integer column is partition-additive too (exact integer arithmetic).
  if (inst.intCol) {
    const ic = inst.intCol
    const sWhole = scalarInt(engine, `SELECT COALESCE(SUM(${ic}), 0) FROM ${T}`)
    const sParts = where.reduce((s, w) => s + scalarInt(engine, `SELECT COALESCE(SUM(${ic}), 0) FROM ${T} WHERE ${w}`), 0)
    if (sWhole !== sParts) {
      return {
        oracle: 'TLP-AGG',
        queries: [`SELECT COALESCE(SUM(${ic}),0) FROM ${T}`, ...where.map((w) => `SELECT COALESCE(SUM(${ic}),0) FROM ${T} WHERE ${w}`)],
        detail: `SUM(${ic}) not partition-additive: whole=${sWhole}, parts=${sParts}`,
        left: sWhole,
        right: sParts,
        sampleDiff: [],
      }
    }
  }
  return null
}

function checkNoRec(engine: Engine, inst: FuzzInstance): Counterexample | null {
  const T = inst.table
  const p = predToSql(inst.pred)
  const optimized = `SELECT COUNT(*) FROM ${T} WHERE (${p})`
  const naive = `SELECT COALESCE(SUM(CASE WHEN (${p}) THEN 1 ELSE 0 END), 0) FROM ${T}`
  const a = scalarInt(engine, optimized)
  const b = scalarInt(engine, naive)
  if (a === b) return null
  return { oracle: 'NoREC', queries: [optimized, naive], detail: `WHERE count ${a} ≠ CASE-sum ${b}`, left: a, right: b, sampleDiff: [] }
}

function checkDistinct(engine: Engine, inst: FuzzInstance): Counterexample | null {
  const proj = inst.projection.join(', ')
  const T = inst.table
  const distinctSql = `SELECT DISTINCT ${proj} FROM ${T}`
  const plainSql = `SELECT ${proj} FROM ${T}`
  const distinctRows = runRows(engine, distinctSql)
  // Ground-truth dedup of the plain scan, by the engine's own canonical key.
  const seen = new Set<string>()
  const dedup: Row[] = []
  for (const r of runRows(engine, plainSql)) {
    const k = hashKey(r)
    if (!seen.has(k)) {
      seen.add(k)
      dedup.push(r)
    }
  }
  const d = diffMultisets(distinctRows, dedup)
  if (!d) return null
  return { oracle: 'DISTINCT', queries: [distinctSql, plainSql], detail: d.detail, left: distinctRows.length, right: dedup.length, sampleDiff: d.sample }
}

function optDiffSql(inst: FuzzInstance): string {
  const T = inst.table
  const p = predToSql(inst.pred)
  if (inst.variant === 'join' && inst.join) {
    const j = inst.join
    const pa = predToSql(inst.pred, 'a')
    return `SELECT a.id AS aid, b.id AS bid FROM ${T} a JOIN ${j.other} b ON a.${j.leftCol} = b.${j.rightCol} WHERE (${pa})`
  }
  if (inst.variant === 'group' && inst.groupCol) {
    const g = inst.groupCol
    const sumCol = inst.intCol ?? 'id'
    return `SELECT ${g}, COUNT(*) AS n, COALESCE(SUM(${sumCol}), 0) AS s FROM ${T} WHERE (${p}) GROUP BY ${g}`
  }
  return `SELECT * FROM ${T} WHERE (${p})`
}

function checkOptDiff(engine: Engine, inst: FuzzInstance): Counterexample | null {
  const sql = optDiffSql(inst)
  const saved = engine.settings.optimizer
  try {
    engine.settings.optimizer = true
    const on = runRows(engine, sql)
    engine.settings.optimizer = false
    const off = runRows(engine, sql)
    const d = diffMultisets(on, off)
    if (!d) return null
    return {
      oracle: 'OPT-DIFF',
      queries: [`SET optimizer = on;  ${sql}`, `SET optimizer = off; ${sql}`],
      detail: d.detail,
      left: on.length,
      right: off.length,
      sampleDiff: d.sample,
    }
  } finally {
    engine.settings.optimizer = saved
  }
}

/** Run the oracle named by the instance against an engine that already holds the schema. */
export function checkInstance(engine: Engine, inst: FuzzInstance): Counterexample | null {
  switch (inst.kind) {
    case 'TLP-WHERE':
      return checkTlpWhere(engine, inst)
    case 'TLP-AGG':
      return checkTlpAgg(engine, inst)
    case 'NoREC':
      return checkNoRec(engine, inst)
    case 'DISTINCT':
      return checkDistinct(engine, inst)
    case 'OPT-DIFF':
      return checkOptDiff(engine, inst)
  }
}

/** Build a fresh engine for a (possibly reduced) schema and check the instance.
 *  Used by both the runner and the shrinker. */
export function checkOn(schema: FuzzSchema, inst: FuzzInstance): Counterexample | null {
  return checkInstance(buildEngine(schema), inst)
}
