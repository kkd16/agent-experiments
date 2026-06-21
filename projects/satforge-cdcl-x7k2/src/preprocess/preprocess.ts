// SatForge — Session 19: the Simplify Studio.
//
// A from-scratch CNF *preprocessing / inprocessing* engine — the simplification
// layer that, in every competitive SAT solver (SatELite, Lingeling, CaDiCaL,
// Kissat), runs before and between search and is responsible for a large share of
// real-world speed. None of these techniques *search*; they rewrite the formula
// into an equisatisfiable one with fewer variables and clauses, while recording
// just enough information to lift any model of the simplified formula back to a
// model of the original.
//
// The techniques implemented here, all by resolution / structural reasoning:
//
//   • unit propagation         — assign and remove unit clauses to a fixpoint
//   • pure-literal elimination — a variable of one polarity is set to satisfy it
//   • subsumption              — drop a clause implied by a shorter one (C ⊆ D)
//   • self-subsuming resolution— strengthen D by a resolvent that subsumes it
//   • bounded variable elim.   — resolve a variable away (the SatELite core)
//   • equivalent-literal subst.— collapse SCCs of the binary implication graph
//   • blocked-clause elim.     — drop a clause whose every resolvent is a taut.
//
// The crown jewel is **model reconstruction**: BVE, equivalence substitution and
// blocked-clause elimination do *not* preserve models, only satisfiability, so we
// push a witness onto a reconstruction stack and replay it in reverse to recover a
// full model of the original formula. `selfcheck.ts` verifies this exhaustively:
// every model of the simplified formula must reconstruct to a model of the
// original, on thousands of random instances.

import type { CNF } from '../sat/cnf'

export type Technique = 'unit' | 'pure' | 'subsume' | 'strengthen' | 'bve' | 'equiv' | 'bce'

export const ALL_TECHNIQUES: Technique[] = [
  'unit',
  'pure',
  'subsume',
  'strengthen',
  'bve',
  'equiv',
  'bce',
]

export const TECHNIQUE_LABEL: Record<Technique, string> = {
  unit: 'Unit propagation',
  pure: 'Pure-literal elimination',
  subsume: 'Subsumption',
  strengthen: 'Self-subsuming resolution',
  bve: 'Bounded variable elimination',
  equiv: 'Equivalent-literal substitution',
  bce: 'Blocked-clause elimination',
}

export interface SimplifyOptions {
  /** Which techniques to run (default: all). */
  techniques?: Partial<Record<Technique, boolean>>
  /** Max allowed net clause growth when eliminating one variable (default 0 — never grow). */
  bveGrowth?: number
  /** Skip a BVE candidate whose |occ⁺|·|occ⁻| exceeds this (default 4000, guards the UI). */
  bveProductCap?: number
  /** Skip a resolvent longer than this (0 = no cap, default 0). */
  bveMaxResolventLen?: number
  /** Fixpoint round cap (default 256). */
  maxRounds?: number
  /** Record a human-readable operation log (default true). */
  log?: boolean
}

export interface TechniqueStat {
  /** Number of times the operation fired. */
  applied: number
  varsRemoved: number
  clausesRemoved: number
  clausesAdded: number
  litsRemoved: number
}

function emptyStat(): TechniqueStat {
  return { applied: 0, varsRemoved: 0, clausesRemoved: 0, clausesAdded: 0, litsRemoved: 0 }
}

export interface CnfShape {
  vars: number
  clauses: number
  lits: number
}

export interface SimplifyStats {
  rounds: number
  before: CnfShape
  after: CnfShape & { activeVars: number }
  byTechnique: Record<Technique, TechniqueStat>
}

// A reconstruction step. The stack is built in application order and replayed in
// reverse to map a model of the simplified formula back onto the original.
export type ReconStep =
  | { kind: 'fix'; lit: number } // var(lit) := (lit > 0)  — units & pure literals
  | { kind: 'equiv'; var: number; posMap: number } // var follows literal posMap (the +var image)
  | { kind: 'bve'; var: number; pos: number[][]; neg: number[][] } // resolved-away variable
  | { kind: 'blocked'; lit: number; clause: number[] } // a removed blocked clause

export interface LogEntry {
  round: number
  technique: Technique
  detail: string
}

export interface SimplifyResult {
  status: 'simplified' | 'unsat' | 'trivial-sat'
  cnf: CNF
  stack: ReconStep[]
  stats: SimplifyStats
  log: LogEntry[]
  /** Variables that still appear in the simplified formula. */
  activeVars: number[]
}

// ---------------------------------------------------------------------------
// Clause utilities (clauses are kept sorted by |literal|; no variable appears
// twice, so a clause never contains both x and ¬x — tautologies are dropped).
// ---------------------------------------------------------------------------

/** Normalise a clause: drop duplicate literals, detect a tautology. Returns null for a tautology. */
function normClause(lits: number[]): number[] | null {
  const seen = new Set<number>()
  for (const l of lits) {
    if (seen.has(-l)) return null // x ∨ ¬x — a tautology
    seen.add(l)
  }
  return [...seen].sort((a, b) => Math.abs(a) - Math.abs(b))
}

/** Is the sorted clause a satisfied/true under a 1-based boolean model? */
function clauseSat(clause: number[], m: boolean[]): boolean {
  for (const l of clause) {
    if (l > 0 ? m[l] : !m[-l]) return true
  }
  return false
}

/** Is the clause satisfied by some literal *other than* `except`? */
function clauseSatExcept(clause: number[], m: boolean[], except: number): boolean {
  for (const l of clause) {
    if (l === except) continue
    if (l > 0 ? m[l] : !m[-l]) return true
  }
  return false
}

/** Sorted-subset test: is `a` (sorted by |lit|) a subset of `b` (sorted by |lit|)? */
function subset(a: number[], b: number[]): boolean {
  if (a.length > b.length) return false
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const va = Math.abs(a[i])
    const vb = Math.abs(b[j])
    if (vb > va) return false // a[i] has no match in b
    if (vb < va) {
      j++
      continue
    }
    // same variable — must be the same literal (same sign)
    if (a[i] !== b[j]) return false
    i++
    j++
  }
  return i === a.length
}

/** Resolve clauses `c` (containing +x) and `d` (containing -x) on variable x. null if tautological. */
function resolve(c: number[], d: number[], x: number): number[] | null {
  const out: number[] = []
  const seen = new Set<number>()
  for (const l of c) {
    if (l === x) continue
    if (seen.has(-l)) return null
    if (!seen.has(l)) {
      seen.add(l)
      out.push(l)
    }
  }
  for (const l of d) {
    if (l === -x) continue
    if (seen.has(-l)) return null
    if (!seen.has(l)) {
      seen.add(l)
      out.push(l)
    }
  }
  out.sort((a, b) => Math.abs(a) - Math.abs(b))
  return out
}

// ---------------------------------------------------------------------------
// The working formula: clauses plus per-literal occurrence lists.
// ---------------------------------------------------------------------------

class Working {
  numVars: number
  clauses: (number[] | null)[] = []
  occ = new Map<number, Set<number>>()
  live = 0
  emptyDerived = false

  constructor(cnf: CNF) {
    this.numVars = cnf.numVars
    for (const c of cnf.clauses) this.add(c)
  }

  private occOf(lit: number): Set<number> {
    let s = this.occ.get(lit)
    if (!s) {
      s = new Set()
      this.occ.set(lit, s)
    }
    return s
  }

  occList(lit: number): number[] {
    const s = this.occ.get(lit)
    return s ? [...s] : []
  }

  occCount(lit: number): number {
    return this.occ.get(lit)?.size ?? 0
  }

  /** Add a raw (un-normalised) clause. Returns its index, or -1 if it was a tautology. */
  add(lits: number[]): number {
    const norm = normClause(lits)
    if (norm === null) return -1 // tautology — vacuously true, skip
    const ci = this.clauses.length
    this.clauses.push(norm)
    this.live++
    if (norm.length === 0) this.emptyDerived = true
    for (const l of norm) this.occOf(l).add(ci)
    return ci
  }

  remove(ci: number): void {
    const c = this.clauses[ci]
    if (c === null) return
    for (const l of c) this.occ.get(l)?.delete(ci)
    this.clauses[ci] = null
    this.live--
  }

  /** Replace clause ci with a strengthened (already-normalised) version. */
  replace(ci: number, lits: number[]): void {
    const c = this.clauses[ci]
    if (c === null) return
    for (const l of c) this.occ.get(l)?.delete(ci)
    this.clauses[ci] = lits
    if (lits.length === 0) this.emptyDerived = true
    for (const l of lits) this.occOf(l).add(ci)
  }

  /** All live clause indices. */
  liveClauses(): number[] {
    const out: number[] = []
    for (let i = 0; i < this.clauses.length; i++) if (this.clauses[i] !== null) out.push(i)
    return out
  }

  toCnf(): CNF {
    const clauses: number[][] = []
    for (const c of this.clauses) if (c !== null) clauses.push(c.slice())
    return { numVars: this.numVars, clauses }
  }

  activeVars(): number[] {
    const seen = new Set<number>()
    for (const c of this.clauses) {
      if (c === null) continue
      for (const l of c) seen.add(Math.abs(l))
    }
    return [...seen].sort((a, b) => a - b)
  }
}

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

export function simplify(input: CNF, options: SimplifyOptions = {}): SimplifyResult {
  const enabled: Record<Technique, boolean> = {
    unit: true,
    pure: true,
    subsume: true,
    strengthen: true,
    bve: true,
    equiv: true,
    bce: true,
    ...(options.techniques as Record<Technique, boolean> | undefined),
  }
  const bveGrowth = options.bveGrowth ?? 0
  const productCap = options.bveProductCap ?? 4000
  const maxResolventLen = options.bveMaxResolventLen ?? 0
  const maxRounds = options.maxRounds ?? 256
  const doLog = options.log ?? true

  const w = new Working(input)
  const stack: ReconStep[] = []
  const log: LogEntry[] = []
  const byTechnique: Record<Technique, TechniqueStat> = {
    unit: emptyStat(),
    pure: emptyStat(),
    subsume: emptyStat(),
    strengthen: emptyStat(),
    bve: emptyStat(),
    equiv: emptyStat(),
    bce: emptyStat(),
  }
  const eliminated = new Set<number>() // variables removed (fixed / resolved / substituted)

  const before: CnfShape = shapeOf(input)
  let round = 0

  const logIt = (technique: Technique, detail: string) => {
    if (doLog) log.push({ round, technique, detail })
  }

  // --- unit propagation -----------------------------------------------------
  const unitProp = (): boolean => {
    let changed = false
    for (;;) {
      if (w.emptyDerived) return changed
      // find a unit clause
      let unit = 0
      let uci = -1
      for (const ci of w.liveClauses()) {
        const c = w.clauses[ci]!
        if (c.length === 1) {
          unit = c[0]
          uci = ci
          break
        }
      }
      if (uci < 0) break
      changed = true
      const v = Math.abs(unit)
      // assign `unit` true: satisfied clauses go away, ¬unit is removed from others.
      stack.push({ kind: 'fix', lit: unit })
      eliminated.add(v)
      const st = byTechnique.unit
      st.applied++
      st.varsRemoved++
      for (const ci of w.occList(unit)) {
        st.clausesRemoved++
        w.remove(ci)
      }
      for (const ci of w.occList(-unit)) {
        const c = w.clauses[ci]
        if (!c) continue
        st.litsRemoved++
        w.replace(
          ci,
          c.filter((l) => l !== -unit),
        )
      }
      logIt('unit', `${litStr(unit)} forced; ${st.clausesRemoved} satisfied clauses dropped`)
    }
    return changed
  }

  // --- pure-literal elimination --------------------------------------------
  const pureLiteral = (): boolean => {
    let changed = false
    for (let v = 1; v <= w.numVars; v++) {
      if (eliminated.has(v)) continue
      const pos = w.occCount(v)
      const neg = w.occCount(-v)
      if (pos === 0 && neg === 0) continue
      let lit: number
      if (neg === 0) lit = v
      else if (pos === 0) lit = -v
      else continue
      changed = true
      stack.push({ kind: 'fix', lit })
      eliminated.add(v)
      const st = byTechnique.pure
      st.applied++
      st.varsRemoved++
      const removed = w.occList(lit)
      for (const ci of removed) {
        st.clausesRemoved++
        w.remove(ci)
      }
      logIt('pure', `${litStr(lit)} is pure; ${removed.length} clauses satisfied`)
    }
    return changed
  }

  // --- subsumption: drop D when some C ⊆ D ----------------------------------
  const subsumption = (): boolean => {
    let changed = false
    const st = byTechnique.subsume
    for (const ci of w.liveClauses()) {
      const c = w.clauses[ci]
      if (!c || c.length === 0) continue
      // pick the literal of C with the smallest occurrence list as the pivot
      let pivot = c[0]
      let best = w.occCount(c[0])
      for (const l of c) {
        const cnt = w.occCount(l)
        if (cnt < best) {
          best = cnt
          pivot = l
        }
      }
      for (const di of w.occList(pivot)) {
        if (di === ci) continue
        const d = w.clauses[di]
        if (!d) continue
        // delete the larger (or higher-indexed on a tie) to avoid mutual deletion
        if (d.length < c.length || (d.length === c.length && di < ci)) continue
        if (subset(c, d)) {
          st.applied++
          st.clausesRemoved++
          st.litsRemoved += d.length
          w.remove(di)
          changed = true
        }
      }
    }
    if (changed) logIt('subsume', `${st.applied} subsumed clauses removed`)
    return changed
  }

  // --- self-subsuming resolution: strengthen D := D \ {¬l} ------------------
  const strengthen = (): boolean => {
    let changed = false
    const st = byTechnique.strengthen
    for (const ci of w.liveClauses()) {
      const c = w.clauses[ci]
      if (!c || c.length === 0) continue
      for (const l of c) {
        // candidates: clauses containing ¬l, with (C \ {l}) ⊆ D
        const cMinus = c.filter((x) => x !== l)
        for (const di of w.occList(-l)) {
          if (di === ci) continue
          const d = w.clauses[di]
          if (!d) continue
          if (subset(cMinus, d)) {
            // resolvent (C\{l}) ∪ (D\{¬l}) = D\{¬l} subsumes D — strengthen D.
            st.applied++
            st.litsRemoved++
            w.replace(
              di,
              d.filter((x) => x !== -l),
            )
            changed = true
          }
        }
      }
    }
    if (changed) logIt('strengthen', `${st.applied} literals removed by self-subsumption`)
    return changed
  }

  // --- equivalent-literal substitution via SCCs of the binary impl. graph ---
  const equivSubst = (): boolean => {
    // Edges: a binary clause {a,b} means ¬a → b and ¬b → a.
    const nodes: number[] = []
    for (let v = 1; v <= w.numVars; v++) {
      if (eliminated.has(v)) continue
      if (w.occCount(v) || w.occCount(-v)) {
        nodes.push(v, -v)
      }
    }
    if (nodes.length === 0) return false
    const adj = new Map<number, number[]>()
    for (const n of nodes) adj.set(n, [])
    let anyBinary = false
    for (const ci of w.liveClauses()) {
      const c = w.clauses[ci]!
      if (c.length !== 2) continue
      anyBinary = true
      const [a, b] = c
      adj.get(-a)?.push(b)
      adj.get(-b)?.push(a)
    }
    if (!anyBinary) return false

    // Tarjan SCC (iterative).
    const index = new Map<number, number>()
    const low = new Map<number, number>()
    const onStack = new Set<number>()
    const sstack: number[] = []
    const comp = new Map<number, number>()
    let counter = 0
    let nComp = 0
    for (const start of nodes) {
      if (index.has(start)) continue
      const work: { node: number; i: number }[] = [{ node: start, i: 0 }]
      while (work.length) {
        const frame = work[work.length - 1]
        const u = frame.node
        if (frame.i === 0) {
          index.set(u, counter)
          low.set(u, counter)
          counter++
          sstack.push(u)
          onStack.add(u)
        }
        const neigh = adj.get(u)!
        if (frame.i < neigh.length) {
          const v = neigh[frame.i]
          frame.i++
          if (!index.has(v)) {
            work.push({ node: v, i: 0 })
          } else if (onStack.has(v)) {
            low.set(u, Math.min(low.get(u)!, index.get(v)!))
          }
        } else {
          if (low.get(u) === index.get(u)) {
            for (;;) {
              const v = sstack.pop()!
              onStack.delete(v)
              comp.set(v, nComp)
              if (v === u) break
            }
            nComp++
          }
          work.pop()
          if (work.length) {
            const parent = work[work.length - 1].node
            low.set(parent, Math.min(low.get(parent)!, low.get(u)!))
          }
        }
      }
    }

    // Within an SCC every literal is equivalent. v and ¬v in the same SCC ⇒ UNSAT.
    // Choose a representative literal per component: smallest |lit|, positive on a tie.
    const repOfComp = new Map<number, number>()
    for (const n of nodes) {
      const cmp = comp.get(n)!
      const cur = repOfComp.get(cmp)
      if (cur === undefined) repOfComp.set(cmp, n)
      else {
        const better =
          Math.abs(n) < Math.abs(cur) || (Math.abs(n) === Math.abs(cur) && n > cur)
        if (better) repOfComp.set(cmp, n)
      }
    }
    for (let v = 1; v <= w.numVars; v++) {
      if (comp.has(v) && comp.has(-v) && comp.get(v) === comp.get(-v)) {
        // v ≡ ¬v — contradiction.
        w.emptyDerived = true
        logIt('equiv', `${litStr(v)} ≡ ${litStr(-v)} → UNSAT`)
        return true
      }
    }

    // posMap[v] = the literal that +v maps to (truth-preserving).
    const posMap = new Map<number, number>()
    for (let v = 1; v <= w.numVars; v++) {
      if (!comp.has(v)) continue
      const rep = repOfComp.get(comp.get(v)!)!
      if (Math.abs(rep) === v) continue // v is its own representative
      posMap.set(v, rep)
    }
    if (posMap.size === 0) return false

    const st = byTechnique.equiv
    // Record reconstruction steps, then rewrite every clause.
    for (const [v, pm] of posMap) {
      stack.push({ kind: 'equiv', var: v, posMap: pm })
      eliminated.add(v)
      st.applied++
      st.varsRemoved++
    }
    const mapLit = (l: number): number => {
      const v = Math.abs(l)
      const pm = posMap.get(v)
      if (pm === undefined) return l
      return l > 0 ? pm : -pm
    }
    for (const ci of w.liveClauses()) {
      const c = w.clauses[ci]!
      let touched = false
      for (const l of c) {
        if (posMap.has(Math.abs(l))) {
          touched = true
          break
        }
      }
      if (!touched) continue
      const mapped = normClause(c.map(mapLit))
      if (mapped === null) {
        // became a tautology — clause is now always true, drop it.
        st.clausesRemoved++
        w.remove(ci)
      } else {
        st.litsRemoved += c.length - mapped.length
        w.replace(ci, mapped)
      }
    }
    logIt('equiv', `${posMap.size} variables folded into ${repOfComp.size} representatives`)
    return true
  }

  // --- bounded variable elimination (the SatELite core) --------------------
  const bve = (): boolean => {
    let changed = false
    const st = byTechnique.bve
    // Process variables cheapest-first by occurrence product.
    const cands: { v: number; cost: number }[] = []
    for (let v = 1; v <= w.numVars; v++) {
      if (eliminated.has(v)) continue
      const p = w.occCount(v)
      const n = w.occCount(-v)
      if (p === 0 || n === 0) continue // pure / absent — handled elsewhere
      cands.push({ v, cost: p * n })
    }
    cands.sort((a, b) => a.cost - b.cost)
    for (const { v } of cands) {
      if (eliminated.has(v)) continue
      const posIdx = w.occList(v)
      const negIdx = w.occList(-v)
      const p = posIdx.length
      const n = negIdx.length
      if (p === 0 || n === 0) continue
      if (p * n > productCap) continue
      const posClauses = posIdx.map((i) => w.clauses[i]!.slice())
      const negClauses = negIdx.map((i) => w.clauses[i]!.slice())
      // Build the non-tautological resolvents.
      const resolvents: number[][] = []
      let tooLong = false
      for (const c of posClauses) {
        for (const d of negClauses) {
          const r = resolve(c, d, v)
          if (r === null) continue // tautology
          if (maxResolventLen > 0 && r.length > maxResolventLen) {
            tooLong = true
            break
          }
          resolvents.push(r)
        }
        if (tooLong) break
      }
      if (tooLong) continue
      // Only eliminate if the formula does not grow beyond the budget.
      if (resolvents.length - (p + n) > bveGrowth) continue
      // Commit: remove the variable's clauses, add the resolvents, push a witness.
      stack.push({ kind: 'bve', var: v, pos: posClauses, neg: negClauses })
      eliminated.add(v)
      for (const i of posIdx) w.remove(i)
      for (const i of negIdx) w.remove(i)
      let added = 0
      for (const r of resolvents) {
        if (w.add(r) >= 0) added++ // -1 only for tautology, already filtered
      }
      st.applied++
      st.varsRemoved++
      st.clausesRemoved += p + n
      st.clausesAdded += added
      changed = true
      logIt(
        'bve',
        `eliminated ${litStr(v)}: ${p + n} clauses → ${added} resolvents (${
          added - (p + n) >= 0 ? '+' : ''
        }${added - (p + n)})`,
      )
    }
    return changed
  }

  // --- blocked-clause elimination ------------------------------------------
  const bce = (): boolean => {
    let changed = false
    const st = byTechnique.bce
    let again = true
    while (again) {
      again = false
      for (const ci of w.liveClauses()) {
        const c = w.clauses[ci]
        if (!c || c.length === 0) continue
        for (const l of c) {
          // C is blocked on l iff every clause D with ¬l resolves to a tautology with C.
          let blocked = true
          for (const di of w.occList(-l)) {
            const d = w.clauses[di]
            if (!d) continue
            // resolvent tautological ⇔ ∃ k ∈ C, k ≠ l, with ¬k ∈ D
            let taut = false
            for (const k of c) {
              if (k === l) continue
              if (hasLit(d, -k)) {
                taut = true
                break
              }
            }
            if (!taut) {
              blocked = false
              break
            }
          }
          if (blocked) {
            stack.push({ kind: 'blocked', lit: l, clause: c.slice() })
            st.applied++
            st.clausesRemoved++
            st.litsRemoved += c.length
            w.remove(ci)
            changed = true
            again = true
            break
          }
        }
      }
    }
    if (changed) logIt('bce', `${st.applied} blocked clauses removed`)
    return changed
  }

  // --- the fixpoint driver --------------------------------------------------
  for (; round < maxRounds; round++) {
    if (w.emptyDerived) break
    let changed = false
    if (enabled.unit) changed = unitProp() || changed
    if (w.emptyDerived) break
    if (enabled.pure) changed = pureLiteral() || changed
    if (enabled.equiv) changed = equivSubst() || changed
    if (w.emptyDerived) break
    if (enabled.subsume) changed = subsumption() || changed
    if (enabled.strengthen) changed = strengthen() || changed
    if (w.emptyDerived) break
    if (enabled.bce) changed = bce() || changed
    if (enabled.bve) changed = bve() || changed
    if (!changed) {
      round++
      break
    }
  }

  const cnf = w.toCnf()
  const active = w.activeVars()
  let status: SimplifyResult['status']
  if (w.emptyDerived) status = 'unsat'
  else if (cnf.clauses.length === 0) status = 'trivial-sat'
  else status = 'simplified'

  const after = shapeOf(cnf)
  const stats: SimplifyStats = {
    rounds: round,
    before,
    after: { ...after, activeVars: active.length },
    byTechnique,
  }
  return { status, cnf, stack, stats, log, activeVars: active }
}

// ---------------------------------------------------------------------------
// Model reconstruction: replay the witness stack in reverse.
// ---------------------------------------------------------------------------

/**
 * Lift a model of the simplified formula back to a full model of the original.
 * `model` is 1-based (`model[v]` is the truth value of variable v); values for
 * eliminated variables are ignored and overwritten. Returns a fresh 1-based array.
 */
export function reconstruct(numVars: number, stack: ReconStep[], model: boolean[]): boolean[] {
  const m = new Array<boolean>(numVars + 1).fill(false)
  for (let v = 1; v <= numVars; v++) m[v] = !!model[v]
  for (let i = stack.length - 1; i >= 0; i--) {
    const step = stack[i]
    switch (step.kind) {
      case 'fix':
        m[Math.abs(step.lit)] = step.lit > 0
        break
      case 'equiv': {
        const pm = step.posMap
        const repTrue = pm > 0 ? m[pm] : !m[-pm]
        m[step.var] = repTrue
        break
      }
      case 'blocked':
        if (!clauseSat(step.clause, m)) m[Math.abs(step.lit)] = step.lit > 0
        break
      case 'bve': {
        const x = step.var
        // Set x = true iff every clause containing ¬x is already satisfied without ¬x;
        // otherwise x = false (which always satisfies the ¬x clauses). One of the two
        // is guaranteed to satisfy all of x's original clauses (the resolvent argument).
        let negOk = true
        for (const d of step.neg) {
          if (!clauseSatExcept(d, m, -x)) {
            negOk = false
            break
          }
        }
        m[x] = negOk
        break
      }
    }
  }
  return m
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function shapeOf(cnf: CNF): CnfShape {
  let lits = 0
  for (const c of cnf.clauses) lits += c.length
  return { vars: cnf.numVars, clauses: cnf.clauses.length, lits }
}

function litStr(l: number): string {
  return l > 0 ? `x${l}` : `¬x${-l}`
}

/** Membership scan over a (small, sorted) clause — used by blocked-clause elimination. */
function hasLit(clause: number[], lit: number): boolean {
  for (const l of clause) if (l === lit) return true
  return false
}
