// The Omega test (William Pugh, 1991) — a complete, exact decision procedure
// for quantifier-free linear *integer* arithmetic (QF_LIA): given a conjunction
// of linear equalities and inequalities over the integers, decide whether an
// integer solution exists, and if so produce one.
//
// Linear arithmetic over the *rationals* is easy — Fourier–Motzkin or simplex
// projects a variable away exactly. Over the integers it is not: the rational
// projection (the "real shadow") can be satisfiable while the integer problem
// is not, because the surviving interval for the eliminated variable, though
// nonempty, may straddle no integer. The Omega test closes that gap with two
// further projections:
//
//   • the DARK SHADOW — a tightened combination `β·U − α·L ≥ (α−1)(β−1)` that is
//     *sound for SAT*: if it has an integer point, the original does too (the
//     interval is provably wide enough to contain an integer);
//   • the GRAY / SPLINTER cases — when the dark shadow is empty but the real
//     shadow is not, any integer solution must pin the variable tight against a
//     bound, so we enumerate a finite family of equality-constrained subproblems
//     (Pugh's exact-projection theorem) and recurse.
//
// Equalities are removed first by a Euclid-style reduction (`centered`) that
// never loses integer solutions. Everything is BigInt, so a chain of
// dark-shadow products never overflows or rounds. The result carries a concrete
// integer model on SAT, which the caller (and the self-check) re-validates
// against the *original* constraints — so a SAT verdict is certificate-checked.

import {
  type Lin,
  addConst,
  ceilDiv,
  cloneLin,
  coeff,
  dropVar,
  evalLin,
  floorDiv,
  formatLin,
  negate,
  scale,
  sub,
  varGcd,
  gcdBig,
  centered,
} from './lin'

/** A single constraint: the affine form is `= 0` (eq) or `≥ 0` (ge). */
export interface Cons {
  lin: Lin
  op: 'eq' | 'ge'
}

export interface OmegaOptions {
  /** Record a human-readable elimination trace (off for bulk self-checks). */
  trace?: boolean
  /** Hard ceiling on recursive nodes; throws OmegaBudgetError past it. */
  maxNodes?: number
  /** Max trace lines kept (older lines past this are dropped). */
  maxTrace?: number
}

export type OmegaResult =
  | { status: 'sat'; model: Map<number, bigint>; nodes: number; trace: string[] }
  | { status: 'unsat'; nodes: number; trace: string[] }

export class OmegaBudgetError extends Error {
  readonly nodes: number
  constructor(nodes: number) {
    super(`Omega test exceeded ${nodes} nodes — problem too large for the in-browser budget`)
    this.name = 'OmegaBudgetError'
    this.nodes = nodes
  }
}

interface Ctx {
  next: number // next fresh variable id
  nodes: number
  maxNodes: number
  trace: string[] | null
  maxTrace: number
  names: (v: number) => string
}

function note(ctx: Ctx, depth: number, msg: string): void {
  if (!ctx.trace) return
  if (ctx.trace.length >= ctx.maxTrace) return
  ctx.trace.push(`${'  '.repeat(Math.min(depth, 8))}${msg}`)
}

const fmt = (ctx: Ctx, a: Lin): string => formatLin(a, ctx.names)

function consStr(ctx: Ctx, c: Cons): string {
  return `${fmt(ctx, c.lin)} ${c.op === 'eq' ? '= 0' : '≥ 0'}`
}

/**
 * Normalize one constraint in place-ish (returns a fresh Cons) and report
 * triviality. For an equality we divide by the gcd of the variable coefficients
 * and fail fast when that gcd does not divide the constant (no integer root).
 * For an inequality we divide by the gcd and FLOOR the constant — the exact
 * integer tightening of `Σ aᵢxᵢ + c ≥ 0` (the left side is a multiple of g).
 */
function normalize(c: Cons): { cons: Cons; verdict?: 'true' | 'false' } {
  const g = varGcd(c.lin)
  if (g === 0n) {
    // Constant constraint — decide it outright.
    if (c.op === 'eq') return { cons: c, verdict: c.lin.c === 0n ? 'true' : 'false' }
    return { cons: c, verdict: c.lin.c >= 0n ? 'true' : 'false' }
  }
  if (c.op === 'eq') {
    if (c.lin.c % g !== 0n) return { cons: c, verdict: 'false' }
    const t = new Map<number, bigint>()
    for (const [v, k] of c.lin.t) t.set(v, k / g)
    return { cons: { lin: { c: c.lin.c / g, t }, op: 'eq' } }
  }
  // ge: divide by g and floor the constant.
  const t = new Map<number, bigint>()
  for (const [v, k] of c.lin.t) t.set(v, k / g)
  return { cons: { lin: { c: floorDiv(c.lin.c, g), t }, op: 'ge' } }
}

/** Normalize every constraint; drop trivially-true; bail on trivially-false. */
function normalizeAll(cons: Cons[]): Cons[] | null {
  const out: Cons[] = []
  for (const c of cons) {
    const { cons: nc, verdict } = normalize(c)
    if (verdict === 'false') return null
    if (verdict === 'true') continue
    out.push(nc)
  }
  return out
}

/** Substitute `x_v ↦ expr` across every constraint (expr must not contain v). */
function substituteAll(cons: Cons[], v: number, expr: Lin): Cons[] {
  return cons.map((c) => {
    const k = coeff(c.lin, v)
    if (k === 0n) return { lin: cloneLin(c.lin), op: c.op }
    // lin' = (lin without v) + k·expr
    const base = dropVar(c.lin, v)
    return { lin: { c: base.c + k * expr.c, t: addInto(base.t, expr.t, k) }, op: c.op }
  })
}

function addInto(into: Map<number, bigint>, from: Map<number, bigint>, s: bigint): Map<number, bigint> {
  const out = new Map(into)
  for (const [v, k] of from) {
    const nk = (out.get(v) ?? 0n) + s * k
    if (nk === 0n) out.delete(v)
    else out.set(v, nk)
  }
  return out
}

function collectVars(cons: Cons[]): Set<number> {
  const s = new Set<number>()
  for (const c of cons) for (const v of c.lin.t.keys()) s.add(v)
  return s
}

interface Bound {
  k: bigint // positive coefficient of z
  e: Lin // the bounding form (β z ≥ L → L ; α z ≤ U → U)
}

/**
 * The core recursion. Returns a model over exactly the variables that occur in
 * `cons` (free / vanished variables are simply absent and default to 0).
 */
function decide(cons: Cons[], ctx: Ctx, depth: number): Map<number, bigint> | null {
  if (++ctx.nodes > ctx.maxNodes) throw new OmegaBudgetError(ctx.nodes)

  const norm = normalizeAll(cons)
  if (norm === null) {
    note(ctx, depth, '⊥ a constraint is unsatisfiable after normalization')
    return null
  }
  cons = norm

  // ---- 1. Eliminate an equality, if any has a variable. ----
  const eqIdx = cons.findIndex((c) => c.op === 'eq' && c.lin.t.size > 0)
  if (eqIdx >= 0) {
    const eq = cons[eqIdx]
    // pivot = variable of smallest |coefficient|
    let pivot = -1
    let best = 0n
    for (const [v, k] of eq.lin.t) {
      const a = k < 0n ? -k : k
      if (pivot < 0 || a < best) {
        pivot = v
        best = a
      }
    }
    const ak = coeff(eq.lin, pivot)

    if (best === 1n) {
      // x_pivot = −(1/ak)(c + Σ_{i≠pivot} aᵢ xᵢ),  ak = ±1  ⇒  1/ak = ak.
      const restForm = dropVar(eq.lin, pivot)
      const expr = scale(restForm, -ak) // = −ak·rest  (constant carried along)
      note(
        ctx,
        depth,
        `eq ${consStr(ctx, eq)}: solve ${ctx.names(pivot)} = ${fmt(ctx, expr)}`,
      )
      const rest = cons.filter((_, i) => i !== eqIdx)
      const reduced = substituteAll(rest, pivot, expr)
      const model = decide(reduced, ctx, depth + 1)
      if (!model) return null
      model.set(pivot, evalLin(expr, model))
      return model
    }

    // |ak| ≥ 2: Euclid-style reduction. Make the pivot positive, introduce a
    // fresh variable f with  x_pivot = f − Σ qᵢ xᵢ,  where qᵢ = round(aᵢ / ak).
    // Substituting shrinks every other coefficient to its centered remainder,
    // so the smallest |coefficient| strictly decreases — termination by Euclid.
    const e = ak < 0n ? scale(eq.lin, -1n) : cloneLin(eq.lin)
    const m = coeff(e, pivot) // > 0
    const f = ctx.next++
    const exprT = new Map<number, bigint>([[f, 1n]])
    for (const [v, k] of e.t) {
      if (v === pivot) continue
      const { q } = centered(k, m)
      if (q !== 0n) exprT.set(v, -q)
    }
    const expr: Lin = { c: 0n, t: exprT } // x_pivot = f − Σ qᵢ xᵢ
    note(
      ctx,
      depth,
      `eq ${consStr(ctx, eq)}: reduce ${ctx.names(pivot)} via ${ctx.names(f)} (m=${m})`,
    )
    const reduced = substituteAll(cons, pivot, expr)
    const model = decide(reduced, ctx, depth + 1)
    if (!model) return null
    model.set(pivot, evalLin(expr, model))
    return model
  }

  // ---- 2. Only inequalities remain. Pick a variable to project away. ----
  const vars = collectVars(cons)
  if (vars.size === 0) {
    // All constraints are constant and already verified true by normalize.
    return new Map()
  }

  // Choose z minimizing (#lower · #upper) to limit Fourier–Motzkin blow-up.
  let z = -1
  let zCost = Infinity
  let zLo: Bound[] = []
  let zHi: Bound[] = []
  let zRest: Cons[] = []
  for (const cand of vars) {
    const lo: Bound[] = []
    const hi: Bound[] = []
    const rest: Cons[] = []
    for (const c of cons) {
      const k = coeff(c.lin, cand)
      if (k === 0n) {
        rest.push(c)
        continue
      }
      const restForm = dropVar(c.lin, cand)
      if (k > 0n) lo.push({ k, e: negate(restForm) }) // k·z ≥ −rest  ⇒ L = −rest
      else hi.push({ k: -k, e: restForm }) // (−k)·z ≤ rest        ⇒ U = rest
    }
    const cost = lo.length * hi.length
    if (cost < zCost) {
      zCost = cost
      z = cand
      zLo = lo
      zHi = hi
      zRest = rest
    }
  }

  note(
    ctx,
    depth,
    `project ${ctx.names(z)}: ${zLo.length} lower × ${zHi.length} upper bound(s)`,
  )

  // Helper: build the shadow constraints for the current pairs.
  const pairConstraints = (dark: boolean): Cons[] => {
    const out = zRest.map((c) => ({ lin: cloneLin(c.lin), op: c.op }) as Cons)
    for (const { k: beta, e: L } of zLo) {
      for (const { k: alpha, e: U } of zHi) {
        // β·U − α·L  (≥ 0 real shadow); dark shadow subtracts (α−1)(β−1).
        let s = sub(scale(U, beta), scale(L, alpha))
        if (dark) s = addConst(s, -((alpha - 1n) * (beta - 1n)))
        out.push({ lin: s, op: 'ge' })
      }
    }
    return out
  }

  // 2a. Dark shadow: sound for SAT. If it has an integer point, so does the original.
  const darkModel = decide(pairConstraints(true), ctx, depth + 1)
  if (darkModel) {
    reconstructZ(z, zLo, zHi, darkModel)
    note(ctx, depth, `  ${ctx.names(z)} fixed from dark shadow = ${darkModel.get(z)}`)
    return darkModel
  }

  // No pairs (a one-sided variable) ⇒ dark == real == rest; already decided unsat.
  const exact = zLo.every((l) => l.k === 1n) || zHi.every((h) => h.k === 1n)
  if (zLo.length === 0 || zHi.length === 0 || exact) {
    note(ctx, depth, `  exact projection of ${ctx.names(z)}: unsat`)
    return null
  }

  // 2b. Real shadow: sound for UNSAT. If even the rational projection is empty,
  // the integer problem is empty.
  note(ctx, depth, `  dark shadow empty; checking real shadow of ${ctx.names(z)}`)
  if (!decide(pairConstraints(false), ctx, depth + 1)) {
    note(ctx, depth, `  real shadow of ${ctx.names(z)} empty: unsat`)
    return null
  }

  // 2c. Gray shadow / splinters. Any integer solution pins z against a bound:
  // for the largest coefficient m of z, and each lower bound β·z ≥ L, the value
  // β·z = L + i for i in 0 .. ⌊(m·β − m − β)/m⌋ covers every gap solution.
  let m = 0n
  for (const b of [...zLo, ...zHi]) if (b.k > m) m = b.k
  note(ctx, depth, `  real shadow nonempty; enumerating splinters (m=${m})`)
  for (const { k: beta, e: L } of zLo) {
    const hi = floorDiv(m * beta - m - beta, m)
    for (let i = 0n; i <= hi; i++) {
      // Add equality β·z − L − i = 0 to the FULL constraint set and recurse.
      const eqForm = addConst(sub(scale({ c: 0n, t: new Map([[z, 1n]]) }, beta), L), -i)
      const splinter: Cons[] = [...cons.map((c) => ({ lin: cloneLin(c.lin), op: c.op }) as Cons), {
        lin: eqForm,
        op: 'eq',
      }]
      note(ctx, depth, `    splinter ${beta}·${ctx.names(z)} = ${fmt(ctx, addConst(L, i))}`)
      const model = decide(splinter, ctx, depth + 1)
      if (model) return model
    }
  }
  note(ctx, depth, `  all splinters of ${ctx.names(z)} unsat`)
  return null
}

/** Pick an integer for z inside [max ⌈L/β⌉, min ⌊U/α⌋] (guaranteed nonempty). */
function reconstructZ(z: number, lo: Bound[], hi: Bound[], model: Map<number, bigint>): void {
  let low: bigint | null = null
  let high: bigint | null = null
  for (const { k: beta, e: L } of lo) {
    const v = ceilDiv(evalLin(L, model), beta)
    low = low === null || v > low ? v : low
  }
  for (const { k: alpha, e: U } of hi) {
    const v = floorDiv(evalLin(U, model), alpha)
    high = high === null || v < high ? v : high
  }
  const val = low !== null ? low : high !== null ? high : 0n
  model.set(z, val)
}

/**
 * Decide a QF_LIA problem. `numInputVars` names variables 0..n−1 as the
 * user-facing ones; fresh variables get ids ≥ n. On SAT the returned model is
 * guaranteed to assign every input variable (free ones default to 0).
 */
export function omegaTest(
  constraints: Cons[],
  numInputVars: number,
  names: (v: number) => string,
  opts: OmegaOptions = {},
): OmegaResult {
  const trace: string[] | null = opts.trace ? [] : null
  const ctx: Ctx = {
    next: Math.max(numInputVars, ...constraints.flatMap((c) => [...c.lin.t.keys()]).map((v) => v + 1), 0),
    nodes: 0,
    maxNodes: opts.maxNodes ?? 200_000,
    trace,
    maxTrace: opts.maxTrace ?? 400,
    names: (v) => (v < numInputVars ? names(v) : `σ${v - numInputVars + 1}`),
  }
  const model = decide(
    constraints.map((c) => ({ lin: cloneLin(c.lin), op: c.op })),
    ctx,
    0,
  )
  if (!model) return { status: 'unsat', nodes: ctx.nodes, trace: trace ?? [] }
  const out = new Map<number, bigint>()
  for (let v = 0; v < numInputVars; v++) out.set(v, model.get(v) ?? 0n)
  return { status: 'sat', model: out, nodes: ctx.nodes, trace: trace ?? [] }
}

/** Re-check a model against the original constraints (the SAT certificate). */
export function verifyModel(constraints: Cons[], model: Map<number, bigint>): boolean {
  for (const c of constraints) {
    const v = evalLin(c.lin, model)
    if (c.op === 'eq' ? v !== 0n : v < 0n) return false
  }
  return true
}

export { gcdBig }
