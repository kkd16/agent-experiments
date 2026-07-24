// Aether — an in-browser DIFFERENTIAL FUZZER for list comprehensions & ranges.
//
// The comprehension surface (Aether 30.0) is pure syntactic sugar: `[ e | q… ]`
// desugars in the parser to `concat`/`map`/`if`/`let`/`match`, and range literals
// `[a .. b]` / `[a, s .. b]` desugar to the `enumFromTo` / `enumFromThenTo`
// prelude functions. Sugar is exactly where a subtle bug hides — a wrong
// desugaring type-checks and runs, it just computes the wrong *set*. So this
// harness generates hundreds of random comprehensions and proves, for each:
//
//   • the compiled program's VM result equals an INDEPENDENT reference — the same
//     comprehension evaluated directly here in TypeScript by nested iteration,
//     never touching the parser's desugaring. This pins the sugar to its spec:
//     inclusive ranges, cartesian nesting, guards, `let`-qualifiers, refutable
//     pattern generators that drop non-matches (the list-monad `fail`); and
//   • that same value re-appears from the JavaScript backend (VM ≡ JS), so the
//     sugar is sound on *all* of Aether's backends, not just the tree-walker.
//
// Deterministic given the seed, so the Tests page shows a stable badge; pure
// logic, so it also runs head-less under Node.

import { runPipeline } from './pipeline.ts'
import { compileToJs, runJsModule } from './jsBackend.ts'
import { valueToString } from './values.ts'

export interface ComprehensionFuzzResult {
  total: number
  passed: number
  /** how many programs used a refutable (dropping) pattern generator */
  refutable: number
  /** how many programs used a non-trivial pattern generator (tuple / `Som` / cons) */
  patterned: number
  /** total number of list elements produced across the whole batch */
  elements: number
  /** the first few divergences, if any (empty ⇒ the sugar is sound here) */
  failures: { code: string; detail: string }[]
}

// ---------------------------------------------------------------------------
// a tiny deterministic LCG (same shape as the optimizer fuzzer's)
// ---------------------------------------------------------------------------

type Rng = () => number

function makeRng(seed: number): Rng {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const pick = <T,>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length) | 0]
const int = (rng: Rng, lo: number, hi: number): number => lo + (Math.floor(rng() * (hi - lo + 1)) | 0)

// ---------------------------------------------------------------------------
// a small Int/Bool expression language over the in-scope variables, with both
// an `emit` (to Aether source) and an `eval` (the reference). Kept syntactically
// identical on both sides — the whole point is that they must agree.
// ---------------------------------------------------------------------------

type Env = Record<string, number>

interface IntExpr {
  emit: () => string
  eval: (env: Env) => number
}
interface BoolExpr {
  emit: () => string
  eval: (env: Env) => boolean
}

const ARITH: readonly ['+' | '-' | '*', (a: number, b: number) => number][] = [
  ['+', (a, b) => a + b],
  ['-', (a, b) => a - b],
  ['*', (a, b) => a * b],
]
const CMP: readonly ['==' | '!=' | '<' | '>' | '<=' | '>=', (a: number, b: number) => boolean][] = [
  ['==', (a, b) => a === b],
  ['!=', (a, b) => a !== b],
  ['<', (a, b) => a < b],
  ['>', (a, b) => a > b],
  ['<=', (a, b) => a <= b],
  ['>=', (a, b) => a >= b],
]

// an Int expression over `ctx` (guaranteed non-empty when this is reached);
// literals are kept NON-NEGATIVE so `Som n`-style constructor args never lex as
// a subtraction and every emitted atom is a plain juxtaposable token.
function genInt(rng: Rng, ctx: string[], d: number): IntExpr {
  if (d <= 0 || rng() < 0.4) {
    if (ctx.length > 0 && rng() < 0.6) {
      const v = pick(rng, ctx)
      return { emit: () => v, eval: (env) => env[v] }
    }
    const n = int(rng, 0, 6)
    return { emit: () => String(n), eval: () => n }
  }
  const [op, fn] = pick(rng, ARITH)
  const l = genInt(rng, ctx, d - 1)
  const r = genInt(rng, ctx, d - 1)
  return {
    emit: () => `(${l.emit()} ${op} ${r.emit()})`,
    eval: (env) => fn(l.eval(env), r.eval(env)),
  }
}

function genBool(rng: Rng, ctx: string[]): BoolExpr {
  const [op, fn] = pick(rng, CMP)
  const l = genInt(rng, ctx, 2)
  const r = genInt(rng, ctx, 2)
  return {
    emit: () => `${l.emit()} ${op} ${r.emit()}`,
    eval: (env) => fn(l.eval(env), r.eval(env)),
  }
}

// ---------------------------------------------------------------------------
// qualifiers — each carries how to render itself AND how to drive the reference
// iteration (bind a variable and recurse, or filter, or skip)
// ---------------------------------------------------------------------------

type Qual =
  | { t: 'range'; v: string; lo: number; hi: number }
  | { t: 'step'; v: string; a: number; then: number; hi: number }
  | { t: 'pair'; v1: string; v2: string; pairs: [number, number][] }
  | { t: 'opt'; v: string; items: (number | null)[] }
  | { t: 'cons'; v: string; lists: number[][] }
  | { t: 'let'; v: string; expr: IntExpr }
  | { t: 'guard'; expr: BoolExpr }

// the inclusive integer sequence a, then, … bounded by hi — the exact spec of
// the `enumFromThenTo` prelude helper the `[a, s .. b]` literal desugars to.
function stepSeq(a: number, then: number, hi: number): number[] {
  const step = then - a
  if (step === 0) return []
  const out: number[] = []
  let x = a
  if (step > 0) for (; x <= hi; x += step) out.push(x)
  else for (; x >= hi; x += step) out.push(x)
  return out
}

function emitQual(q: Qual): string {
  switch (q.t) {
    case 'range':
      return `${q.v} <- [${q.lo} .. ${q.hi}]`
    case 'step':
      return `${q.v} <- [${q.a}, ${q.then} .. ${q.hi}]`
    case 'pair':
      return `(${q.v1}, ${q.v2}) <- [${q.pairs.map(([a, b]) => `(${a}, ${b})`).join(', ')}]`
    case 'opt':
      return `Som ${q.v} <- [${q.items.map((i) => (i === null ? 'Non' : `Som ${i}`)).join(', ')}]`
    case 'cons':
      return `${q.v} :: _ <- [${q.lists.map((l) => `[${l.join(', ')}]`).join(', ')}]`
    case 'let':
      return `let ${q.v} = ${q.expr.emit()}`
    case 'guard':
      return q.expr.emit()
  }
}

// drive the reference: fold the qualifiers left-to-right over the environment,
// pushing `out.eval(env)` once every qualifier has been satisfied.
function referenceRun(quals: Qual[], out: IntExpr): number[] {
  const acc: number[] = []
  const go = (i: number, env: Env): void => {
    if (i >= quals.length) {
      acc.push(out.eval(env))
      return
    }
    const q = quals[i]
    switch (q.t) {
      case 'range':
        for (let x = q.lo; x <= q.hi; x++) go(i + 1, { ...env, [q.v]: x })
        break
      case 'step':
        for (const x of stepSeq(q.a, q.then, q.hi)) go(i + 1, { ...env, [q.v]: x })
        break
      case 'pair':
        for (const [a, b] of q.pairs) go(i + 1, { ...env, [q.v1]: a, [q.v2]: b })
        break
      case 'opt':
        for (const it of q.items) if (it !== null) go(i + 1, { ...env, [q.v]: it })
        break
      case 'cons':
        for (const l of q.lists) if (l.length > 0) go(i + 1, { ...env, [q.v]: l[0] })
        break
      case 'let':
        go(i + 1, { ...env, [q.v]: q.expr.eval(env) })
        break
      case 'guard':
        if (q.expr.eval(env)) go(i + 1, env)
        break
    }
  }
  go(0, {})
  return acc
}

// ---------------------------------------------------------------------------
// generate one random comprehension: a program string + its reference value
// ---------------------------------------------------------------------------

interface Generated {
  code: string
  reference: number[]
  usedOpt: boolean
  usedPattern: boolean
}

function generate(rng: Rng): Generated {
  const quals: Qual[] = []
  const scope: string[] = []
  let counter = 0
  const fresh = (): string => `v${counter++}`
  let usedOpt = false
  let usedPattern = false

  const nGen = int(rng, 1, 3) // 1–3 generators keeps the cartesian product small
  let gensSoFar = 0
  const maxQuals = nGen + int(rng, 0, 3)

  while (quals.length < maxQuals) {
    const needGen = gensSoFar < nGen && (gensSoFar === 0 || rng() < 0.7)
    if (needGen) {
      gensSoFar++
      const kind = pick(rng, ['range', 'range', 'step', 'pair', 'opt', 'cons'] as const)
      if (kind === 'range') {
        const lo = int(rng, 0, 5)
        quals.push({ t: 'range', v: pushVar(), lo, hi: lo + int(rng, 0, 5) })
      } else if (kind === 'step') {
        const a = int(rng, 0, 4)
        const step = int(rng, 1, 3)
        quals.push({ t: 'step', v: pushVar(), a, then: a + step, hi: a + int(rng, 0, 9) })
      } else if (kind === 'pair') {
        usedPattern = true
        const n = int(rng, 1, 4)
        const pairs: [number, number][] = []
        for (let k = 0; k < n; k++) pairs.push([int(rng, 0, 6), int(rng, 0, 6)])
        const v1 = pushVar()
        const v2 = pushVar()
        quals.push({ t: 'pair', v1, v2, pairs })
      } else if (kind === 'opt') {
        usedPattern = true
        usedOpt = true
        const n = int(rng, 1, 5)
        const items: (number | null)[] = []
        for (let k = 0; k < n; k++) items.push(rng() < 0.4 ? null : int(rng, 0, 6))
        quals.push({ t: 'opt', v: pushVar(), items })
      } else {
        usedPattern = true
        const n = int(rng, 1, 4)
        const lists: number[][] = []
        for (let k = 0; k < n; k++) {
          const len = int(rng, 0, 3)
          const l: number[] = []
          for (let j = 0; j < len; j++) l.push(int(rng, 0, 6))
          lists.push(l)
        }
        quals.push({ t: 'cons', v: pushVar(), lists })
      }
    } else if (scope.length > 0 && rng() < 0.5) {
      // a let-qualifier binds a fresh variable to an expression over the scope
      const expr = genInt(rng, scope, 2)
      quals.push({ t: 'let', v: pushVar(), expr })
    } else if (scope.length > 0) {
      quals.push({ t: 'guard', expr: genBool(rng, scope) })
    } else {
      continue
    }
  }

  const out = genInt(rng, scope, 3)
  const prefix = usedOpt ? 'type Opt = Non | Som Int in\n' : ''
  const code = `${prefix}[ ${out.emit()} | ${quals.map(emitQual).join(', ')} ]`
  return { code, reference: referenceRun(quals, out), usedOpt, usedPattern }

  // helper: allocate a fresh variable and bring it into scope for later exprs
  function pushVar(): string {
    const v = fresh()
    scope.push(v)
    return v
  }
}

// ---------------------------------------------------------------------------
// the batch
// ---------------------------------------------------------------------------

export function runComprehensionFuzz(runs = 200, seed = 0xc0117e): ComprehensionFuzzResult {
  const rng = makeRng(seed)
  let passed = 0
  let refutable = 0
  let patterned = 0
  let elements = 0
  const failures: { code: string; detail: string }[] = []

  for (let i = 0; i < runs; i++) {
    const g = generate(rng)
    if (g.usedOpt) refutable++
    if (g.usedPattern) patterned++
    const expected = `[${g.reference.join(', ')}]`
    elements += g.reference.length

    let vm: string
    let coreAst
    try {
      const r = runPipeline(g.code, { execute: true })
      if (r.error) {
        if (failures.length < 8) failures.push({ code: g.code, detail: `${r.error.stage}: ${r.error.message}` })
        continue
      }
      coreAst = r.optimizedCoreAst ?? r.coreAst
      vm = r.run?.result ? valueToString(r.run.result) : '()'
    } catch (e) {
      if (failures.length < 8) failures.push({ code: g.code, detail: `threw: ${String(e)}` })
      continue
    }

    if (vm !== expected) {
      if (failures.length < 8) failures.push({ code: g.code, detail: `VM ${vm} ≠ reference ${expected}` })
      continue
    }

    // VM ≡ JS backend
    let jsOk = false
    try {
      const js = runJsModule(compileToJs(coreAst!).full)
      jsOk = js.error === null && js.result === vm
      if (!jsOk && failures.length < 8) {
        failures.push({ code: g.code, detail: `JS ${js.error ?? js.result} ≠ VM ${vm}` })
      }
    } catch (e) {
      if (failures.length < 8) failures.push({ code: g.code, detail: `JS threw: ${String(e)}` })
    }
    if (jsOk) passed++
  }

  return { total: runs, passed, refutable, patterned, elements, failures }
}
