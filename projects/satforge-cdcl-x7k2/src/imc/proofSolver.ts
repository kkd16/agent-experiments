// A compact, self-contained CDCL SAT solver that records a *resolution
// refutation* when it reports UNSAT. This is the engine behind Craig
// interpolation: McMillan's algorithm reads an interpolant straight off the
// resolution proof, so we need the proof DAG with pivots — something the main
// SatForge solver (tuned for speed, not proof shape) does not expose. The two
// are cross-checked against each other and against brute force in the self-test.
//
// Two-watched-literal propagation, 1-UIP conflict analysis, VSIDS-ish activity
// bumping and geometric restarts — enough to dispatch the modest CNFs produced
// by bounded model checking while keeping the proof bookkeeping honest.

/** A clause tagged with which side of an interpolation partition it came from. */
export interface InputClause {
  lits: number[]
  part: 'A' | 'B'
}

/** A node in the recorded resolution proof. */
export type ProofNode =
  | { kind: 'leaf'; lits: number[]; part: 'A' | 'B' }
  | { kind: 'res'; pivot: number; left: number; right: number }

export interface SatResult {
  status: 'sat' | 'unsat'
  /** model[v] for v in 1..numVars (index 0 unused); present iff sat. */
  model?: boolean[]
  /** Resolution proof; present iff unsat. */
  proof?: ProofNode[]
  /** Index into `proof` of the derived empty clause; present iff unsat. */
  emptyNode?: number
}

const litIdx = (l: number): number => (Math.abs(l) << 1) | (l < 0 ? 1 : 0)

export class ProofSolver {
  private nVars: number
  private clauseLits: number[][] = []
  private clauseNode: number[] = [] // proof-node id for each clause
  private proof: ProofNode[] = []

  private value: Int8Array // 0 unassigned, 1 true, -1 false (indexed by var)
  private level: Int32Array
  private reason: Int32Array // clause index that forced the var, or -1
  private trail: number[] = []
  private trailPos: Int32Array // position of each var in the trail
  private qhead = 0
  private decisionLevel = 0

  private watches: number[][] = [] // indexed by litIdx -> clause indices
  private activity: Float64Array
  private varInc = 1
  private seen: Uint8Array

  private emptyNode = -1

  constructor(numVars: number, clauses: InputClause[]) {
    this.nVars = numVars
    this.value = new Int8Array(numVars + 1)
    this.level = new Int32Array(numVars + 1)
    this.reason = new Int32Array(numVars + 1).fill(-1)
    this.trailPos = new Int32Array(numVars + 1).fill(-1)
    this.activity = new Float64Array(numVars + 1)
    this.seen = new Uint8Array(numVars + 1)
    this.watches = Array.from({ length: 2 * (numVars + 1) }, () => [])
    for (const c of clauses) this.addInputClause(c.lits, c.part)
  }

  private mkLeaf(lits: number[], part: 'A' | 'B'): number {
    this.proof.push({ kind: 'leaf', lits: [...lits], part })
    return this.proof.length - 1
  }

  private mkRes(pivot: number, left: number, right: number): number {
    this.proof.push({ kind: 'res', pivot, left, right })
    return this.proof.length - 1
  }

  private addInputClause(lits: number[], part: 'A' | 'B'): void {
    // Normalise: drop duplicate literals, detect tautologies.
    const seen = new Map<number, number>()
    const norm: number[] = []
    for (const l of lits) {
      const prev = seen.get(Math.abs(l))
      if (prev === undefined) {
        seen.set(Math.abs(l), l)
        norm.push(l)
      } else if (prev !== l) {
        return // tautology (x and ¬x) — never participates in a refutation
      }
    }
    const node = this.mkLeaf(norm, part)
    this.addClause(norm, node)
  }

  /** Register a clause (input or learnt) with its proof node, set up watches. */
  private addClause(lits: number[], node: number): number {
    const idx = this.clauseLits.length
    this.clauseLits.push(lits)
    this.clauseNode.push(node)
    if (lits.length <= 1) {
      // Empty -> contradiction; unit -> handled by enqueueing, never watched
      // (its literal can never be the one that flips to false unassigned).
      if (lits.length === 0 && this.emptyNode === -1) this.emptyNode = node
    } else {
      this.watches[litIdx(lits[0])].push(idx)
      this.watches[litIdx(lits[1])].push(idx)
    }
    return idx
  }

  private litVal(l: number): number {
    const v = this.value[Math.abs(l)]
    return l < 0 ? -v : v
  }

  private enqueue(l: number, reasonIdx: number): void {
    const v = Math.abs(l)
    this.value[v] = l < 0 ? -1 : 1
    this.level[v] = this.decisionLevel
    this.reason[v] = reasonIdx
    this.trailPos[v] = this.trail.length
    this.trail.push(l)
  }

  /** Unit propagation. Returns the conflicting clause index, or -1. */
  private propagate(): number {
    while (this.qhead < this.trail.length) {
      const p = this.trail[this.qhead++]
      const negIdx = litIdx(-p) // clauses watching ¬p may now be unit/conflict
      const ws = this.watches[negIdx]
      let keep = 0
      for (let wi = 0; wi < ws.length; wi++) {
        const cidx = ws[wi]
        const lits = this.clauseLits[cidx]
        // Ensure lits[1] is the watched literal that just went false.
        if (lits[0] === -p) {
          lits[0] = lits[1]
          lits[1] = -p
        }
        // If the other watch is already true, clause is satisfied; keep watch.
        if (this.litVal(lits[0]) === 1) {
          ws[keep++] = cidx
          continue
        }
        // Look for a new, non-false literal to watch.
        let found = false
        for (let k = 2; k < lits.length; k++) {
          if (this.litVal(lits[k]) !== -1) {
            lits[1] = lits[k]
            lits[k] = -p
            this.watches[litIdx(lits[1])].push(cidx)
            found = true
            break
          }
        }
        if (found) continue
        // No replacement: clause is unit or conflicting on lits[0].
        ws[keep++] = cidx
        if (this.litVal(lits[0]) === -1) {
          // Conflict: restore the rest of the watch list and report.
          for (let j = wi + 1; j < ws.length; j++) ws[keep++] = ws[j]
          ws.length = keep
          return cidx
        }
        this.enqueue(lits[0], cidx)
      }
      ws.length = keep
    }
    return -1
  }

  private bump(v: number): void {
    this.activity[v] += this.varInc
    if (this.activity[v] > 1e100) {
      for (let i = 1; i <= this.nVars; i++) this.activity[i] *= 1e-100
      this.varInc *= 1e-100
    }
  }

  /** 1-UIP analysis. Returns the learnt clause, its proof node, backjump level. */
  private analyze(conflict: number): { learnt: number[]; node: number; backjump: number } {
    let pathCount = 0
    let p = 0 // the literal whose reason we resolve next (0 = the conflict clause)
    const learnt: number[] = [0] // slot 0 reserved for the asserting literal (¬UIP)
    let node = this.clauseNode[conflict]
    let confl = conflict
    let index = this.trail.length - 1

    do {
      const lits = this.clauseLits[confl]
      if (p !== 0) node = this.mkRes(Math.abs(p), node, this.clauseNode[confl])
      for (const q of lits) {
        const v = Math.abs(q)
        if (v === Math.abs(p)) continue
        if (this.seen[v] === 0 && this.level[v] > 0) {
          this.seen[v] = 1
          this.bump(v)
          if (this.level[v] >= this.decisionLevel) pathCount++
          else learnt.push(q)
        }
      }
      // Find the next seen literal, scanning the trail downward.
      while (this.seen[Math.abs(this.trail[index])] === 0) index--
      p = this.trail[index]
      const pv = Math.abs(p)
      this.seen[pv] = 0
      index--
      pathCount--
      if (pathCount > 0) confl = this.reason[pv]
    } while (pathCount > 0)

    learnt[0] = -p // asserting literal = negation of the UIP
    this.varInc *= 1 / 0.95

    // Backjump level = second-highest decision level in the learnt clause.
    let backjump = 0
    for (let i = 1; i < learnt.length; i++) {
      const lv = this.level[Math.abs(learnt[i])]
      if (lv > backjump) backjump = lv
    }
    for (let i = 1; i < learnt.length; i++) this.seen[Math.abs(learnt[i])] = 0
    return { learnt, node, backjump }
  }

  /** Resolve a level-0 conflict all the way down to the empty clause. */
  private deriveEmpty(conflict: number): void {
    let cur = [...this.clauseLits[conflict]]
    let node = this.clauseNode[conflict]
    // Resolve away literals in reverse assignment order until nothing is left.
    while (cur.length > 0) {
      // Pick the literal assigned latest (highest trail position).
      let best = -1
      let bestPos = -1
      for (let i = 0; i < cur.length; i++) {
        const v = Math.abs(cur[i])
        const pos = this.trailPos[v]
        if (pos > bestPos) {
          bestPos = pos
          best = i
        }
      }
      const l = cur[best]
      const v = Math.abs(l)
      const r = this.reason[v]
      // A level-0 conflict means every variable here was unit-propagated.
      node = this.mkRes(v, node, this.clauseNode[r])
      // Resolvent = (cur \ {l}) ∪ (reason \ {¬l}), dropping the pivot variable.
      const next = new Map<number, number>()
      for (const x of cur) if (Math.abs(x) !== v) next.set(Math.abs(x), x)
      for (const x of this.clauseLits[r]) if (Math.abs(x) !== v) next.set(Math.abs(x), x)
      cur = [...next.values()]
    }
    this.emptyNode = node
  }

  private cancelUntil(lvl: number): void {
    if (this.decisionLevel <= lvl) return
    let i = this.trail.length - 1
    while (i >= 0 && this.level[Math.abs(this.trail[i])] > lvl) {
      const v = Math.abs(this.trail[i])
      this.value[v] = 0
      this.reason[v] = -1
      this.trailPos[v] = -1
      i--
    }
    this.trail.length = i + 1
    this.qhead = this.trail.length
    this.decisionLevel = lvl
  }

  private pickBranch(): number {
    let best = 0
    let bestAct = -1
    for (let v = 1; v <= this.nVars; v++) {
      if (this.value[v] === 0 && this.activity[v] > bestAct) {
        bestAct = this.activity[v]
        best = v
      }
    }
    return best // 0 means all assigned
  }

  solve(): SatResult {
    if (this.emptyNode !== -1) return { status: 'unsat', proof: this.proof, emptyNode: this.emptyNode }

    // Enqueue input units at level 0.
    for (let i = 0; i < this.clauseLits.length; i++) {
      const lits = this.clauseLits[i]
      if (lits.length === 1) {
        const val = this.litVal(lits[0])
        if (val === -1) {
          this.deriveEmpty(i)
          return { status: 'unsat', proof: this.proof, emptyNode: this.emptyNode }
        }
        if (val === 0) this.enqueue(lits[0], i)
      }
    }

    let restartLimit = 100
    let sinceRestart = 0

    for (;;) {
      const conflict = this.propagate()
      if (conflict !== -1) {
        sinceRestart++
        if (this.decisionLevel === 0) {
          this.deriveEmpty(conflict)
          return { status: 'unsat', proof: this.proof, emptyNode: this.emptyNode }
        }
        const { learnt, node, backjump } = this.analyze(conflict)
        this.cancelUntil(backjump)
        const cidx = this.addClause(learnt, node)
        // Asserting literal is now unit at the backjump level.
        this.enqueue(learnt[0], cidx)
      } else {
        if (sinceRestart >= restartLimit) {
          sinceRestart = 0
          restartLimit = Math.floor(restartLimit * 1.5)
          this.cancelUntil(0)
        }
        const v = this.pickBranch()
        if (v === 0) {
          const model: boolean[] = new Array(this.nVars + 1).fill(false)
          for (let i = 1; i <= this.nVars; i++) model[i] = this.value[i] === 1
          return { status: 'sat', model }
        }
        this.decisionLevel++
        // Phase: prefer false (tends to be a good default for these CNFs).
        this.enqueue(-v, -1)
      }
    }
  }
}

/** Convenience: solve an unpartitioned CNF (everything labelled 'A'). */
export function solveCnf(numVars: number, clauses: number[][]): SatResult {
  return new ProofSolver(
    numVars,
    clauses.map((lits) => ({ lits, part: 'A' as const })),
  ).solve()
}
