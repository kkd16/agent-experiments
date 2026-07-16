// The symbolic executor — the heart of the Symbolic Studio.
//
// It walks every control-flow path of a Mini program, carrying a *symbolic*
// store that maps each program variable to an affine form `Lin` over the free
// inputs. Branch conditions become linear constraints; the running conjunction
// of guards is the **path condition** (PC). At each `assert(c)` the executor
// asks the Omega test whether `PC ∧ ¬c` is satisfiable over the integers — if
// so, a *model* of that system is a concrete input that drives the program to
// the failing assertion, i.e. a genuine counterexample. Loops are unrolled to a
// bound K, so a clean run is a proof of safety up to K iterations (bounded model
// checking); loop-free programs are verified for *all* inputs, unconditionally.
//
// Feasible-path pruning (an Omega SAT check at every fork) keeps the explored
// tree to paths that some real input actually takes, which is both faster and
// exactly what the studio wants to show. Every verdict is answerable to the
// concrete interpreter (interp.ts), which shares none of this code.

import type { BExpr, Expr, Program, RelOp, Stmt } from './ast'
import { bexprToString } from './ast'
import type { Cons, Lin } from '../lia'
import { OmegaBudgetError, add, constant, negate, omegaTest, scale, sub, variable } from '../lia'
import { addConst, isConst } from '../lia/lin'

export interface SymOptions {
  /** Loop-unrolling bound K (each `while` runs at most K times per path). */
  unroll?: number
  /** Hard cap on states dequeued (path-explosion guard). */
  maxStates?: number
  /** Hard cap on Omega feasibility/model queries. */
  maxOmega?: number
  /** Per-query Omega node budget. */
  omegaNodes?: number
  /** Prune infeasible forks eagerly (default true). */
  prune?: boolean
  /** Max counterexamples to collect. */
  maxCex?: number
  /** Max path summaries to retain for the UI. */
  maxPathSummaries?: number
}

export interface Counterexample {
  /** The source text of the violated assertion. */
  assertText: string
  /** Concrete input assignment that triggers the violation. */
  inputs: { name: string; value: bigint }[]
  /** Human-readable branch guards taken to reach the assertion. */
  guards: string[]
  /** The full path condition (for the model witness). */
  pc: Cons[]
  /** The Omega model over input-variable ids. */
  model: Map<number, bigint>
}

export interface PathSummary {
  kind: 'complete' | 'bounded' | 'violation'
  guards: string[]
  depth: number
}

export type Verdict = 'safe' | 'safe-bounded' | 'unsafe' | 'unknown'

export interface SymResult {
  verdict: Verdict
  counterexamples: Counterexample[]
  inputs: string[]
  unroll: number
  stats: {
    states: number
    completePaths: number
    boundedPaths: number
    violationPaths: number
    omegaCalls: number
    assertChecks: number
    truncated: boolean
  }
  /** A bounded sample of explored paths, for the path-tree view. */
  paths: PathSummary[]
  /** Non-fatal note (e.g. a non-linear expression aborted the run). */
  error?: string
}

interface Frame {
  stmts: Stmt[]
  ip: number
}

interface State {
  env: Map<string, Lin>
  pc: Cons[]
  guards: string[]
  cont: Frame[]
  loops: Map<number, number>
  depth: number
}

class NonLinear extends Error {}

const ge = (lin: Lin): Cons => ({ lin, op: 'ge' })
const eqC = (lin: Lin): Cons => ({ lin, op: 'eq' })

/** Evaluate an expression symbolically to an affine form over the inputs. */
function evalSym(e: Expr, env: Map<string, Lin>): Lin {
  switch (e.kind) {
    case 'num':
      return constant(e.value)
    case 'var':
      return env.get(e.name) ?? constant(0n) // undeclared reads default to 0
    case 'neg':
      return negate(evalSym(e.e, env))
    case 'bin': {
      const a = evalSym(e.a, env)
      const b = evalSym(e.b, env)
      if (e.op === '+') return add(a, b)
      if (e.op === '-') return sub(a, b)
      // '*': keep it linear — one side must be a constant.
      if (isConst(b)) return scale(a, b.c)
      if (isConst(a)) return scale(b, a.c)
      throw new NonLinear(`non-linear multiplication '${exprShape(e)}' — outside the QF_LIA fragment`)
    }
  }
}

function exprShape(e: Expr): string {
  return e.kind === 'bin' ? `${e.a.kind} ${e.op} ${e.b.kind}` : e.kind
}

// ---- Disjunctive normal form of a Boolean condition ----
// constrain(b, want) returns the DNF (a list of conjunctions, each a Cons[])
// under which `b` evaluates to `want`. An empty list means "unsatisfiable";
// a list containing the empty conjunction [[]] means "always true".

function atomDNF(a: Expr, op: RelOp, b: Expr, env: Map<string, Lin>): Cons[][] {
  const la = evalSym(a, env)
  const lb = evalSym(b, env)
  const diff = sub(la, lb) // la - lb
  switch (op) {
    case '<=':
      return [[ge(negate(diff))]] // lb - la >= 0
    case '>=':
      return [[ge(diff)]] // la - lb >= 0
    case '<':
      return [[ge(addConst(negate(diff), -1n))]] // lb - la - 1 >= 0
    case '>':
      return [[ge(addConst(diff, -1n))]] // la - lb - 1 >= 0
    case '==':
      return [[eqC(diff)]] // la - lb = 0
    case '!=':
      return [[ge(addConst(diff, -1n))], [ge(addConst(negate(diff), -1n))]] // la > lb OR la < lb
  }
}

const NEG: Record<RelOp, RelOp> = {
  '==': '!=',
  '!=': '==',
  '<=': '>',
  '>=': '<',
  '<': '>=',
  '>': '<=',
}

function constrain(b: BExpr, want: boolean, env: Map<string, Lin>): Cons[][] {
  switch (b.kind) {
    case 'blit':
      return b.value === want ? [[]] : []
    case 'not':
      return constrain(b.e, !want, env)
    case 'cmp':
      return atomDNF(b.a, want ? b.op : NEG[b.op], b.b, env)
    case 'and':
      // true  → both true (cross product); false → ¬a ∨ ¬b (union)
      return want ? cross(constrain(b.a, true, env), constrain(b.b, true, env)) : constrain(b.a, false, env).concat(constrain(b.b, false, env))
    case 'or':
      // true  → a ∨ b (union); false → both false (cross product)
      return want ? constrain(b.a, true, env).concat(constrain(b.b, true, env)) : cross(constrain(b.a, false, env), constrain(b.b, false, env))
  }
}

function cross(x: Cons[][], y: Cons[][]): Cons[][] {
  const out: Cons[][] = []
  for (const cx of x) for (const cy of y) out.push(cx.concat(cy))
  return out
}

// ---- control-stack helpers (treated immutably) ----
function normalize(cont: Frame[]): Frame[] {
  let top = cont.length - 1
  while (top >= 0 && cont[top].ip >= cont[top].stmts.length) top--
  return top === cont.length - 1 ? cont : cont.slice(0, top + 1)
}
function advanceTop(cont: Frame[]): Frame[] {
  const c = cont.slice()
  const t = c[c.length - 1]
  c[c.length - 1] = { stmts: t.stmts, ip: t.ip + 1 }
  return c
}
function pushBlock(cont: Frame[], stmts: Stmt[]): Frame[] {
  return cont.concat([{ stmts, ip: 0 }])
}

export function symExecute(program: Program, opts: SymOptions = {}): SymResult {
  const unroll = opts.unroll ?? 8
  const maxStates = opts.maxStates ?? 40_000
  const maxOmega = opts.maxOmega ?? 400_000
  const omegaNodes = opts.omegaNodes ?? 40_000
  const prune = opts.prune ?? true
  const maxCex = opts.maxCex ?? 64
  const maxPathSummaries = opts.maxPathSummaries ?? 400

  const names = (v: number) => program.inputs[v] ?? `σ${v}`
  const idOf = new Map<string, number>()
  program.inputs.forEach((n, i) => idOf.set(n, i))

  const initEnv = new Map<string, Lin>()
  program.inputs.forEach((n, i) => initEnv.set(n, variable(i)))

  const stats = {
    states: 0,
    completePaths: 0,
    boundedPaths: 0,
    violationPaths: 0,
    omegaCalls: 0,
    assertChecks: 0,
    truncated: false,
  }
  const counterexamples: Counterexample[] = []
  const cexKeys = new Set<string>()
  const paths: PathSummary[] = []

  // Omega helpers with budgets. `feasible` returns true when the constraint set
  // has an integer point; on a budget error it conservatively reports feasible
  // (so we never drop a real path) and marks the result truncated.
  const solve = (pc: Cons[]): Map<number, bigint> | null => {
    if (stats.omegaCalls >= maxOmega) {
      stats.truncated = true
      return new Map() // treat as feasible with an empty (all-zero) model
    }
    stats.omegaCalls++
    try {
      const r = omegaTest(pc, program.inputs.length, names, { maxNodes: omegaNodes })
      return r.status === 'sat' ? r.model : null
    } catch (e) {
      if (e instanceof OmegaBudgetError) {
        stats.truncated = true
        return new Map()
      }
      throw e
    }
  }
  const feasible = (pc: Cons[]): boolean => (prune ? solve(pc) !== null : true)

  const addPath = (kind: PathSummary['kind'], st: State) => {
    if (paths.length < maxPathSummaries) paths.push({ kind, guards: st.guards, depth: st.depth })
  }

  const stack: State[] = [{ env: initEnv, pc: [], guards: [], cont: [{ stmts: program.body, ip: 0 }], loops: new Map(), depth: 0 }]

  try {
    while (stack.length > 0) {
      if (stats.states >= maxStates) {
        stats.truncated = true
        break
      }
      stats.states++
      const st = stack.pop()!
      const cont = normalize(st.cont)
      if (cont.length === 0) {
        stats.completePaths++
        addPath('complete', st)
        continue
      }
      const top = cont[cont.length - 1]
      const stmt = top.stmts[top.ip]
      const rest = advanceTop(cont) // control after this statement

      switch (stmt.kind) {
        case 'input':
          stack.push({ ...st, cont: rest })
          break
        case 'assign': {
          const env = new Map(st.env)
          env.set(stmt.name, evalSym(stmt.e, env))
          stack.push({ ...st, env, cont: rest })
          break
        }
        case 'assume': {
          for (const atoms of constrain(stmt.cond, true, st.env)) {
            const pc = st.pc.concat(atoms)
            if (feasible(pc)) stack.push({ ...st, pc, cont: rest, guards: st.guards.concat(`assume ${stmt.text}`) })
          }
          break
        }
        case 'if': {
          for (const atoms of constrain(stmt.cond, true, st.env)) {
            const pc = st.pc.concat(atoms)
            if (feasible(pc)) stack.push({ ...st, pc, cont: pushBlock(rest, stmt.then), guards: st.guards.concat(bexprToString(stmt.cond)), depth: st.depth + 1 })
          }
          for (const atoms of constrain(stmt.cond, false, st.env)) {
            const pc = st.pc.concat(atoms)
            if (feasible(pc)) stack.push({ ...st, pc, cont: pushBlock(rest, stmt.else), guards: st.guards.concat(`!(${bexprToString(stmt.cond)})`), depth: st.depth + 1 })
          }
          break
        }
        case 'while': {
          const iters = st.loops.get(stmt.id) ?? 0
          // Exit branch: condition false → continue after the loop, reset counter.
          for (const atoms of constrain(stmt.cond, false, st.env)) {
            const pc = st.pc.concat(atoms)
            if (feasible(pc)) {
              const loops = new Map(st.loops)
              loops.delete(stmt.id)
              stack.push({ ...st, pc, cont: rest, guards: st.guards.concat(`!(${bexprToString(stmt.cond)})`), loops })
            }
          }
          // Enter branch: condition true.
          for (const atoms of constrain(stmt.cond, true, st.env)) {
            const pc = st.pc.concat(atoms)
            if (!feasible(pc)) continue
            if (iters >= unroll) {
              // Reached the unroll bound with the loop still live → bounded-out.
              stats.boundedPaths++
              addPath('bounded', { ...st, guards: st.guards.concat(`${bexprToString(stmt.cond)} [bound ${unroll} reached]`) })
              continue
            }
            const loops = new Map(st.loops)
            loops.set(stmt.id, iters + 1)
            // Re-enter the same while after the body, so the loop keeps unrolling.
            const cont2 = pushBlock(pushBlock(cont, [stmt]), stmt.body)
            stack.push({ ...st, pc, cont: cont2, guards: st.guards.concat(bexprToString(stmt.cond)), loops, depth: st.depth + 1 })
          }
          break
        }
        case 'assert': {
          stats.assertChecks++
          // Proof obligation: is PC ∧ ¬assert satisfiable?
          let violated = false
          for (const atoms of constrain(stmt.cond, false, st.env)) {
            if (counterexamples.length >= maxCex) break
            const badPc = st.pc.concat(atoms)
            const model = solve(badPc)
            if (model) {
              const inputs = program.inputs.map((n, i) => ({ name: n, value: model.get(i) ?? 0n }))
              const key = `${stmt.text}|${inputs.map((x) => x.value).join(',')}`
              if (!cexKeys.has(key)) {
                cexKeys.add(key)
                counterexamples.push({ assertText: stmt.text, inputs, guards: st.guards.slice(), pc: badPc, model })
              }
              violated = true
            }
          }
          if (violated) {
            stats.violationPaths++
            addPath('violation', { ...st, guards: st.guards.concat(`✗ assert ${stmt.text}`) })
          }
          // Continuation: assume the assertion held and carry on.
          for (const atoms of constrain(stmt.cond, true, st.env)) {
            const pc = st.pc.concat(atoms)
            if (feasible(pc)) stack.push({ ...st, pc, cont: rest, guards: st.guards.concat(`assert ${stmt.text}`) })
          }
          break
        }
      }
    }
  } catch (e) {
    if (e instanceof NonLinear) {
      return {
        verdict: 'unknown',
        counterexamples,
        inputs: program.inputs,
        unroll,
        stats,
        paths,
        error: e.message,
      }
    }
    throw e
  }

  let verdict: Verdict
  if (counterexamples.length > 0) verdict = 'unsafe'
  else if (stats.truncated) verdict = 'unknown'
  else if (stats.boundedPaths > 0) verdict = 'safe-bounded'
  else verdict = 'safe'

  return { verdict, counterexamples, inputs: program.inputs, unroll, stats, paths, error: undefined }
}
