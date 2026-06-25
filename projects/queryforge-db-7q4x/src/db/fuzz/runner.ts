// The fuzz runner: a seed → a random database → thousands of random queries, each
// checked against the metamorphic oracles. A single integer seed reproduces the entire
// run; any counterexample is shrunk to a minimal, paste-able repro script. This is the
// engine behind both the Fuzz Lab UI and the `fuzz` self-test group.

import type { Engine } from '../engine'
import { buildEngine, genSchema, schemaToSql, type FuzzSchema } from './schema'
import { checkInstance, genInstance, type Counterexample, type FuzzInstance, type OracleKind } from './oracles'
import { shrink } from './shrink'
import { Rng } from './rng'

const ORACLES: OracleKind[] = ['TLP-WHERE', 'TLP-AGG', 'NoREC', 'DISTINCT', 'OPT-DIFF']

export interface ReproducedBug {
  oracle: OracleKind
  detail: string
  sampleDiff: string[]
  /** A complete, minimized SQL script: schema DDL/DML + the diverging queries. */
  reproSql: string[]
  /** How many rows survived shrinking (across all tables). */
  rowsAfterShrink: number
}

export interface FuzzError {
  detail: string
  oracle: OracleKind
}

export interface FuzzReport {
  seed: number
  iterations: number
  /** Total SQL statements the engine executed during the run. */
  queriesRun: number
  /** Per-oracle instance counts. */
  oracleChecks: Record<OracleKind, number>
  counterexamples: ReproducedBug[]
  /** Unexpected engine errors on a generated (valid) query — also a defect. */
  errors: FuzzError[]
}

export interface FuzzOptions {
  /** Stop early after collecting this many distinct counterexamples (0 = no limit). */
  maxBugs?: number
  /** Skip shrinking (faster; the self-tests don't need it since they expect zero bugs). */
  shrinkBugs?: boolean
}

function rowsOf(schema: FuzzSchema): number {
  return schema.tables.reduce((n, t) => n + t.rows.length, 0)
}

function reproOf(schema: FuzzSchema, ce: Counterexample): string[] {
  return [...schemaToSql(schema).map((s) => s + ';'), ...ce.queries.map((q) => (q.endsWith(';') ? q : q + ';'))]
}

/** Run the fuzzer for one seed. Fully deterministic. */
export function runFuzz(seed: number, iterations: number, opts: FuzzOptions = {}): FuzzReport {
  const { maxBugs = 10, shrinkBugs = true } = opts
  const rng = new Rng(seed)
  const schema = genSchema(rng)

  const engine: Engine = buildEngine(schema)
  // Count every statement the engine runs from here on (the schema build is excluded).
  let queriesRun = 0
  const origExec = engine.execute.bind(engine)
  ;(engine as unknown as { execute: Engine['execute'] }).execute = (sql: string) => {
    queriesRun++
    return origExec(sql)
  }

  const oracleChecks: Record<OracleKind, number> = {
    'TLP-WHERE': 0,
    'TLP-AGG': 0,
    NoREC: 0,
    DISTINCT: 0,
    'OPT-DIFF': 0,
  }
  const counterexamples: ReproducedBug[] = []
  const errors: FuzzError[] = []
  // De-dup repeated manifestations of the same defect so a report isn't 1000 copies.
  const seenBugs = new Set<string>()

  for (let i = 0; i < iterations; i++) {
    const inst: FuzzInstance = genInstance(rng, schema)
    oracleChecks[inst.kind]++
    let ce: Counterexample | null
    try {
      ce = checkInstance(engine, inst)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      const key = `${inst.kind}:err:${detail}`
      if (!seenBugs.has(key)) {
        seenBugs.add(key)
        errors.push({ oracle: inst.kind, detail })
      }
      continue
    }
    if (!ce) continue
    const key = `${ce.oracle}:${ce.detail}`
    if (seenBugs.has(key)) continue
    seenBugs.add(key)
    const reduced = shrinkBugs ? shrink(schema, inst) : { schema, counterexample: ce }
    counterexamples.push({
      oracle: ce.oracle,
      detail: reduced.counterexample.detail,
      sampleDiff: reduced.counterexample.sampleDiff,
      reproSql: reproOf(reduced.schema, reduced.counterexample),
      rowsAfterShrink: rowsOf(reduced.schema),
    })
    if (maxBugs && counterexamples.length >= maxBugs) break
  }

  return { seed, iterations, queriesRun, oracleChecks, counterexamples, errors }
}

/** Convenience: a clean pass returns true (no counterexamples and no errors). */
export function fuzzClean(seed: number, iterations: number): boolean {
  const r = runFuzz(seed, iterations, { shrinkBugs: false, maxBugs: 1 })
  return r.counterexamples.length === 0 && r.errors.length === 0
}

export { ORACLES }
