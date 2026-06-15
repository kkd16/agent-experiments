// A from-scratch DRAT proof checker.
//
// When SatForge proves a formula UNSAT, the CDCL engine can emit a DRAT proof:
// the ordered sequence of learnt clauses it added (`a`) and the clauses it later
// deleted (`d`), terminated by the empty clause. DRAT (Deletion Resolution
// Asymmetric Tautology) is the de-facto standard certificate format used by the
// SAT competition — a proof a *completely independent* checker can replay to be
// convinced the answer is correct without trusting the solver.
//
// This module is that independent checker, written from scratch:
//
//   • RUP (Reverse Unit Propagation): a clause C is redundant if assuming the
//     negation of all its literals and running unit propagation over the current
//     formula yields a conflict. Every clause a CDCL solver learns is RUP, so a
//     plain CDCL proof checks entirely by RUP.
//   • RAT (Resolution Asymmetric Tautology): the strictly more general rule that
//     makes DRAT complete for techniques like blocked-clause addition / extended
//     resolution. C is RAT on its first literal `p` if, for every clause D in the
//     formula containing ¬p, the resolvent (C ∪ D) \ {p, ¬p} is RUP.
//   • Unsat-core extraction: by recording which clauses each RUP derivation used
//     and walking that dependency graph backward from the final empty clause, we
//     recover the subset of *original* clauses that actually forced the
//     contradiction.
//
// Propagation uses the same two-watched-literal scheme as the solver, so the
// checker stays fast enough to verify proofs with hundreds of thousands of steps
// directly in the browser.

import type { CNF } from './cnf'

// ---- internal literal encoding (matches solver.ts) ----------------------------
const litVar = (l: number) => l >> 1
const neg = (l: number) => l ^ 1
const dimacsToLit = (d: number) => ((Math.abs(d) - 1) << 1) | (d < 0 ? 1 : 0)

/** One line of a DRAT proof. `lits` are DIMACS literals; an empty `lits` is the empty clause. */
export type ProofStep =
  | { a: 'a'; lits: number[] } // add (derive) a clause
  | { a: 'd'; lits: number[] } // delete a clause

export interface CoreInfo {
  /** Indices into the *original* CNF's `clauses` array that belong to the core. */
  originalIndices: number[]
  /** Size of the original formula. */
  numOriginal: number
  /** Total clauses (original + derived) marked as needed. */
  numNeeded: number
}

export interface DratResult {
  /** True iff the empty clause was derived and every proof step verified. */
  ok: boolean
  derivedEmpty: boolean
  steps: number
  additions: number
  deletions: number
  /** Additions that verified by RUP alone. */
  rupSteps: number
  /** Additions that required the (more general) RAT rule. */
  ratSteps: number
  /** First step that failed to verify, if any. */
  firstError?: { index: number; lits: number[]; message: string }
  core?: CoreInfo
  elapsedMs: number
}

/** Serialize a proof to canonical DRAT text (what `drat-trim` consumes). */
export function proofToDrat(proof: ProofStep[]): string {
  const out: string[] = []
  for (const s of proof) {
    const body = s.lits.join(' ')
    out.push(s.a === 'd' ? (body ? `d ${body} 0` : 'd 0') : body ? `${body} 0` : '0')
  }
  return out.join('\n') + '\n'
}

/** Parse DRAT text back into proof steps (tolerant of blank/comment lines). */
export function parseDrat(text: string): ProofStep[] {
  const steps: ProofStep[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('c')) continue
    let del = false
    let rest = line
    if (rest[0] === 'd' && (rest[1] === ' ' || rest.length === 1)) {
      del = true
      rest = rest.slice(1).trim()
    }
    const lits: number[] = []
    for (const tok of rest.split(/\s+/)) {
      if (tok === '') continue
      const n = Number(tok)
      if (!Number.isInteger(n)) continue
      if (n === 0) break
      lits.push(n)
    }
    steps.push(del ? { a: 'd', lits } : { a: 'a', lits })
  }
  return steps
}

interface CheckOptions {
  /** Also compute the unsat core (subset of original clauses). Default false. */
  extractCore?: boolean
}

class DratChecker {
  private clauseLits: number[][] = []
  private deleted: boolean[] = []
  /** For original clauses: their index in the source CNF; else -1. */
  private originalIndex: number[] = []
  private watch: number[][] = []
  /** Clause ids that are unit clauses (length 1) — enqueued at the start of each check. */
  private unitClauses: number[] = []
  private hasEmptyOriginal = false
  private emptyOriginalIndex = -1

  private value: Int8Array
  private reasonOf: Int32Array
  private trail: number[] = []
  private qhead = 0

  private readonly trackCore: boolean
  /** Per derived clause id: the clause ids whose propagation justified it. */
  private deps: number[][] = []

  constructor(cnf: CNF, proof: ProofStep[], trackCore: boolean) {
    this.trackCore = trackCore
    let maxVar = cnf.numVars
    for (const c of cnf.clauses) for (const d of c) maxVar = Math.max(maxVar, Math.abs(d))
    for (const s of proof) for (const d of s.lits) maxVar = Math.max(maxVar, Math.abs(d))
    this.value = new Int8Array(maxVar)
    this.reasonOf = new Int32Array(maxVar).fill(-1)
    this.watch = Array.from({ length: 2 * maxVar }, () => [])

    // Load the original formula.
    for (let i = 0; i < cnf.clauses.length; i++) {
      this.addClause(cnf.clauses[i], i)
    }
  }

  private litValue(l: number): number {
    const vv = this.value[litVar(l)]
    if (vv === 0) return 0
    return l & 1 ? -vv : vv
  }

  /** Internalize, dedupe, drop tautologies. Returns internal lits or null for a tautology. */
  private internalize(dimacs: number[]): number[] | null {
    const lits: number[] = []
    const present = new Set<number>()
    for (const d of dimacs) {
      if (d === 0) continue
      const l = dimacsToLit(d)
      if (present.has(neg(l))) return null // tautology
      if (present.has(l)) continue
      present.add(l)
      lits.push(l)
    }
    return lits
  }

  /** Add a clause to the live database. `origIdx` ≥ 0 marks an original clause. Returns its id or -1. */
  private addClause(dimacs: number[], origIdx: number): number {
    const lits = this.internalize(dimacs)
    if (lits === null) return -1 // tautology — never needed
    if (lits.length === 0) {
      if (origIdx >= 0 && !this.hasEmptyOriginal) {
        this.hasEmptyOriginal = true
        this.emptyOriginalIndex = origIdx
      }
      return -1
    }
    const id = this.clauseLits.length
    this.clauseLits.push(lits)
    this.deleted.push(false)
    this.originalIndex.push(origIdx)
    if (this.trackCore) this.deps.push([])
    if (lits.length === 1) {
      this.unitClauses.push(id)
    } else {
      this.watch[neg(lits[0])].push(id)
      this.watch[neg(lits[1])].push(id)
    }
    return id
  }

  /** Delete the first live clause whose literal set matches `dimacs`. */
  private deleteClause(dimacs: number[]): void {
    const lits = this.internalize(dimacs)
    if (lits === null || lits.length === 0) return
    const key = [...lits].sort((a, b) => a - b).join(',')
    for (let c = 0; c < this.clauseLits.length; c++) {
      if (this.deleted[c]) continue
      const cl = this.clauseLits[c]
      if (cl.length !== lits.length) continue
      if ([...cl].sort((a, b) => a - b).join(',') === key) {
        this.deleted[c] = true
        return
      }
    }
  }

  private enqueue(lit: number, reason: number): void {
    const v = litVar(lit)
    this.value[v] = lit & 1 ? -1 : 1
    this.reasonOf[v] = reason
    this.trail.push(lit)
  }

  /** Two-watched-literal propagation. Returns a conflicting clause id, or -1. */
  private propagate(): number {
    while (this.qhead < this.trail.length) {
      const p = this.trail[this.qhead++] // p is now true
      const falseLit = neg(p) // ...so falseLit is now false
      const ws = this.watch[p] // clauses watching falseLit are registered under watch[neg(falseLit)] = watch[p]
      let i = 0
      let j = 0
      scan: while (i < ws.length) {
        const cidx = ws[i]
        if (this.deleted[cidx]) {
          i++
          continue // drop deleted clauses from the watch list
        }
        const clause = this.clauseLits[cidx]
        if (clause[0] === falseLit) {
          clause[0] = clause[1]
          clause[1] = falseLit
        }
        const first = clause[0]
        if (this.litValue(first) === 1) {
          ws[j++] = cidx
          i++
          continue
        }
        for (let k = 2; k < clause.length; k++) {
          if (this.litValue(clause[k]) !== -1) {
            clause[1] = clause[k]
            clause[k] = falseLit
            this.watch[neg(clause[1])].push(cidx)
            i++
            continue scan
          }
        }
        ws[j++] = cidx
        i++
        if (this.litValue(first) === -1) {
          while (i < ws.length) ws[j++] = ws[i++]
          ws.length = j
          return cidx
        }
        this.enqueue(first, cidx)
      }
      ws.length = j
    }
    return -1
  }

  private undo(): void {
    for (const lit of this.trail) {
      const v = litVar(lit)
      this.value[v] = 0
      this.reasonOf[v] = -1
    }
    this.trail.length = 0
    this.qhead = 0
  }

  /** Walk the reason graph from a conflict, collecting every clause id involved. */
  private collect(confl: number): number[] {
    if (confl < 0) return []
    const used = new Set<number>()
    const stack = [confl]
    while (stack.length) {
      const c = stack.pop()!
      if (used.has(c)) continue
      used.add(c)
      for (const l of this.clauseLits[c]) {
        const r = this.reasonOf[litVar(l)]
        if (r >= 0) stack.push(r)
      }
    }
    return [...used]
  }

  /**
   * Is `candidate` (internal lits) RUP? Enqueues every unit clause and the
   * negation of each candidate literal, then propagates to a fixpoint. Returns
   * the justifying clause ids (when tracking the core) or an empty array.
   */
  private rupCheck(candidate: number[]): { held: boolean; deps: number[] } {
    let confl = -1
    // Top-level unit facts must always fire.
    for (const cid of this.unitClauses) {
      if (this.deleted[cid]) continue
      const l = this.clauseLits[cid][0]
      const v = litVar(l)
      const want = l & 1 ? -1 : 1
      if (this.value[v] === 0) this.enqueue(l, cid)
      else if (this.value[v] !== want) {
        confl = cid
        break
      }
    }
    if (confl === -1) {
      for (const l of candidate) {
        const nl = neg(l)
        const v = litVar(nl)
        const want = nl & 1 ? -1 : 1
        if (this.value[v] === 0) this.enqueue(nl, -1)
        else if (this.value[v] !== want) {
          confl = this.reasonOf[v] // opposing fact already on the trail
          break
        }
      }
    }
    if (confl === -1) confl = this.propagate()
    const held = confl !== -1
    const deps = held && this.trackCore ? this.collect(confl) : []
    this.undo()
    return { held, deps }
  }

  /**
   * RAT check on the candidate's first literal `pivot`: every clause D with ¬pivot
   * must yield a RUP resolvent. Returns the union of justifying clause ids.
   */
  private ratCheck(candidate: number[]): { held: boolean; deps: number[] } {
    const pivot = candidate[0]
    const negPivot = neg(pivot)
    const deps = new Set<number>()
    for (let c = 0; c < this.clauseLits.length; c++) {
      if (this.deleted[c]) continue
      const D = this.clauseLits[c]
      if (!D.includes(negPivot)) continue
      // Resolvent = (candidate \ {pivot}) ∪ (D \ {¬pivot}); skip if tautological.
      const resolvent: number[] = []
      const seen = new Set<number>()
      let taut = false
      const push = (l: number) => {
        if (seen.has(neg(l))) taut = true
        if (!seen.has(l)) {
          seen.add(l)
          resolvent.push(l)
        }
      }
      for (const l of candidate) if (l !== pivot) push(l)
      for (const l of D) if (l !== negPivot) push(l)
      if (taut) {
        if (this.trackCore) deps.add(c)
        continue
      }
      const r = this.rupCheck(resolvent)
      if (!r.held) return { held: false, deps: [] }
      if (this.trackCore) {
        deps.add(c)
        for (const d of r.deps) deps.add(d)
      }
    }
    return { held: true, deps: [...deps] }
  }

  run(proof: ProofStep[]): DratResult {
    const t0 = now()
    let additions = 0
    let deletions = 0
    let rupSteps = 0
    let ratSteps = 0
    let derivedEmpty = false
    let firstError: DratResult['firstError']
    // The final empty clause's justifying clauses (root of the core dependency graph).
    let emptyDeps: number[] = []

    // A formula that literally contains the empty clause is trivially UNSAT.
    if (this.hasEmptyOriginal) {
      derivedEmpty = true
    }

    for (let i = 0; i < proof.length && !firstError; i++) {
      const step = proof[i]
      if (step.a === 'd') {
        deletions++
        this.deleteClause(step.lits)
        continue
      }
      additions++
      const lits = this.internalize(step.lits)
      if (lits === null) {
        // Tautology: trivially redundant, nothing to add.
        rupSteps++
        continue
      }
      if (lits.length === 0) {
        // The empty clause: must follow by RUP from the current database.
        const r = this.rupCheck([])
        if (!r.held && !this.hasEmptyOriginal) {
          firstError = { index: i, lits: step.lits, message: 'empty clause is not implied (RUP failed)' }
          break
        }
        derivedEmpty = true
        rupSteps++
        if (this.trackCore) emptyDeps = r.deps
        continue
      }
      // Try RUP first, then fall back to the (more general) RAT rule.
      const rup = this.rupCheck(lits)
      let deps: number[]
      if (rup.held) {
        rupSteps++
        deps = rup.deps
      } else {
        const rat = this.ratCheck(lits)
        if (!rat.held) {
          firstError = {
            index: i,
            lits: step.lits,
            message: 'clause is neither RUP nor RAT on its first literal',
          }
          break
        }
        ratSteps++
        deps = rat.deps
      }
      const id = this.addClause(step.lits, -1)
      if (this.trackCore && id >= 0) this.deps[id] = deps
    }

    const result: DratResult = {
      ok: !firstError && derivedEmpty,
      derivedEmpty,
      steps: proof.length,
      additions,
      deletions,
      rupSteps,
      ratSteps,
      firstError,
      elapsedMs: now() - t0,
    }
    if (this.trackCore && result.ok) {
      result.core = this.buildCore(emptyDeps)
    }
    return result
  }

  /** Backward pass: mark every clause transitively needed by the empty derivation. */
  private buildCore(emptyDeps: number[]): CoreInfo {
    const needed = new Uint8Array(this.clauseLits.length)
    const stack = [...emptyDeps]
    while (stack.length) {
      const c = stack.pop()!
      if (needed[c]) continue
      needed[c] = 1
      const d = this.deps[c]
      if (d) for (const x of d) stack.push(x)
    }
    const originalIndices: number[] = []
    let numNeeded = 0
    let numOriginal = 0
    for (let c = 0; c < this.clauseLits.length; c++) {
      if (this.originalIndex[c] >= 0) numOriginal++
      if (needed[c]) {
        numNeeded++
        if (this.originalIndex[c] >= 0) originalIndices.push(this.originalIndex[c])
      }
    }
    if (this.hasEmptyOriginal) {
      originalIndices.push(this.emptyOriginalIndex)
      numNeeded++
    }
    originalIndices.sort((a, b) => a - b)
    return { originalIndices, numOriginal: numOriginal + (this.hasEmptyOriginal ? 1 : 0), numNeeded }
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * Verify a DRAT proof against a CNF. Returns whether the empty clause is derived
 * and every step is a valid RUP/RAT inference, optionally with the unsat core.
 */
export function checkProof(cnf: CNF, proof: ProofStep[], opts: CheckOptions = {}): DratResult {
  const checker = new DratChecker(cnf, proof, opts.extractCore ?? false)
  return checker.run(proof)
}
