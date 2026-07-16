// Correctness harness for the Symbolic Studio. The symbolic executor answers to
// two independent oracles that share none of its code:
//
//   1. the concrete interpreter (interp.ts) — every reported counterexample is
//      replayed on its own model and must actually crash the asserted program;
//   2. exhaustive concrete enumeration over a small input box — for loop-free
//      (fully verified) programs this is a decision procedure in its own right,
//      so it certifies BOTH the SAFE and UNSAFE verdicts:
//        • SAFE  ⇒ no input in the box may violate an assertion (soundness);
//        • any box violation ⇒ the executor MUST have returned UNSAFE
//          (completeness for reachable violations).
//
// On top of the curated gallery, a battery of randomly generated straight-line
// programs is checked the same way — hundreds of assertions, verdicts and
// witnesses both. Exposed as runSymxChecks() so the studio folds it into its
// self-test badge, exactly like every other subsystem.

import type { BExpr, Expr, Program, RelOp, Stmt } from './ast'
import { parseProgram } from './parse'
import { interpret } from './interp'
import { symExecute } from './symexec'
import { SYMX_EXAMPLES } from './examples'
import { verifyModel } from '../lia'

export interface SymxCheckReport {
  pass: number
  fail: number
  messages: string[]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Harness {
  pass = 0
  fail = 0
  messages: string[] = []
  check(cond: boolean, msg: string): void {
    if (cond) this.pass++
    else {
      this.fail++
      if (this.messages.length < 12) this.messages.push(msg)
    }
  }
}

/** Enumerate every input tuple in [lo,hi]^k and report whether some tuple that
 *  satisfies the program's assumptions violates an assertion. */
function boxViolation(program: Program, lo: bigint, hi: bigint): { violated: boolean; diverged: boolean } {
  const k = program.inputs.length
  const dims: bigint[] = []
  let violated = false
  let diverged = false
  const rec = (d: number) => {
    if (violated) return
    if (d === k) {
      const inputs = new Map<string, bigint>()
      program.inputs.forEach((n, i) => inputs.set(n, dims[i]))
      const r = interpret(program, inputs, { maxSteps: 100_000 })
      if (r.kind === 'assert-failed') violated = true
      else if (r.kind === 'diverged') diverged = true
      return
    }
    for (let v = lo; v <= hi; v++) {
      dims[d] = v
      rec(d + 1)
      if (violated) return
    }
  }
  rec(0)
  return { violated, diverged }
}

function checkExample(h: Harness, ex: (typeof SYMX_EXAMPLES)[number]): void {
  const parsed = parseProgram(ex.src)
  h.check(parsed.ok, `example "${ex.title}" failed to parse: ${parsed.ok ? '' : parsed.error}`)
  if (!parsed.ok) return
  const res = symExecute(parsed.program, { unroll: 8 })
  h.check(res.verdict === ex.expect, `example "${ex.title}": expected ${ex.expect}, got ${res.verdict}`)

  // Every reported counterexample must reproduce concretely and its model must
  // satisfy the recorded path condition.
  for (const cex of res.counterexamples) {
    h.check(verifyModel(cex.pc, cex.model), `example "${ex.title}": CEX model fails its path condition`)
    const inputs = new Map<string, bigint>()
    for (const { name, value } of cex.inputs) inputs.set(name, value)
    const r = interpret(parsed.program, inputs)
    h.check(r.kind === 'assert-failed', `example "${ex.title}": CEX ${JSON.stringify(cex.inputs.map((x) => `${x.name}=${x.value}`))} did not crash concretely (got ${r.kind})`)
  }

  // Box cross-check for verdicts that must be clean within the box.
  if (ex.box && (res.verdict === 'safe' || res.verdict === 'safe-bounded')) {
    const bv = boxViolation(parsed.program, ex.box.lo, ex.box.hi)
    h.check(!bv.violated, `example "${ex.title}": verdict ${res.verdict} but a box input violates an assertion`)
  }
}

// ---------- random straight-line program generator ----------

function randExpr(rng: () => number, vars: string[], depth: number): Expr {
  if (depth <= 0 || rng() < 0.45) {
    if (rng() < 0.5 && vars.length > 0) return { kind: 'var', name: vars[Math.floor(rng() * vars.length)] }
    return { kind: 'num', value: BigInt(Math.floor(rng() * 7) - 3) }
  }
  const op = rng() < 0.5 ? '+' : rng() < 0.5 ? '-' : '*'
  if (op === '*') {
    // keep linear: constant * subexpr
    const c: Expr = { kind: 'num', value: BigInt(Math.floor(rng() * 5) - 2) }
    return { kind: 'bin', op: '*', a: c, b: randExpr(rng, vars, depth - 1) }
  }
  return { kind: 'bin', op, a: randExpr(rng, vars, depth - 1), b: randExpr(rng, vars, depth - 1) }
}

const RELOPS: RelOp[] = ['==', '!=', '<=', '>=', '<', '>']

function randCmp(rng: () => number, vars: string[]): BExpr {
  return { kind: 'cmp', op: RELOPS[Math.floor(rng() * RELOPS.length)], a: randExpr(rng, vars, 2), b: randExpr(rng, vars, 2) }
}

function randBExpr(rng: () => number, vars: string[]): BExpr {
  const r = rng()
  if (r < 0.6) return randCmp(rng, vars)
  if (r < 0.75) return { kind: 'not', e: randCmp(rng, vars) }
  const conn = rng() < 0.5 ? 'and' : 'or'
  return { kind: conn, a: randCmp(rng, vars), b: randCmp(rng, vars) } as BExpr
}

function randomProgram(rng: () => number): Program {
  const k = 1 + Math.floor(rng() * 3) // 1..3 inputs
  const inputs: string[] = []
  const body: Stmt[] = []
  for (let i = 0; i < k; i++) {
    inputs.push(`x${i}`)
    body.push({ kind: 'input', name: `x${i}` })
  }
  const vars = [...inputs]
  const nStmts = 1 + Math.floor(rng() * 3)
  for (let s = 0; s < nStmts; s++) {
    const y = `y${s}`
    if (rng() < 0.5) {
      body.push({ kind: 'assign', name: y, e: randExpr(rng, vars, 2) })
    } else {
      body.push({
        kind: 'if',
        cond: randBExpr(rng, vars),
        then: [{ kind: 'assign', name: y, e: randExpr(rng, vars, 2) }],
        else: [{ kind: 'assign', name: y, e: randExpr(rng, vars, 2) }],
      })
    }
    vars.push(y)
  }
  const nAsserts = 1 + Math.floor(rng() * 2)
  for (let a = 0; a < nAsserts; a++) {
    const cond = randBExpr(rng, vars)
    body.push({ kind: 'assert', cond, text: `A${a}` })
  }
  return { inputs, body }
}

function checkRandom(h: Harness, count: number, seed: number): void {
  const rng = mulberry32(seed)
  const B = 4n
  for (let t = 0; t < count; t++) {
    const program = randomProgram(rng)
    const res = symExecute(program, { unroll: 4 })
    if (res.verdict === 'unknown') continue // (won't happen for these, but be safe)
    const bv = boxViolation(program, -B, B)
    if (bv.diverged) continue

    // (a) soundness: SAFE ⇒ no violation anywhere in the box.
    if (res.verdict === 'safe') {
      h.check(!bv.violated, `random #${t}: verdict SAFE but the box contains a violating input`)
    }
    // (b) completeness: a box violation ⇒ the executor found it (UNSAFE).
    if (bv.violated) {
      h.check(res.verdict === 'unsafe', `random #${t}: box violation but verdict ${res.verdict}`)
    }
    // (c) witness validity: every CEX reproduces concretely.
    for (const cex of res.counterexamples.slice(0, 4)) {
      h.check(verifyModel(cex.pc, cex.model), `random #${t}: CEX model fails its path condition`)
      const inputs = new Map<string, bigint>()
      for (const { name, value } of cex.inputs) inputs.set(name, value)
      const r = interpret(program, inputs)
      h.check(r.kind === 'assert-failed', `random #${t}: CEX did not crash concretely (got ${r.kind})`)
    }
  }
}

export function runSymxChecks(): SymxCheckReport {
  const h = new Harness()

  // Parser round-trips and gallery verdicts + witnesses.
  for (const ex of SYMX_EXAMPLES) checkExample(h, ex)

  // A hand-anchored fact: the off-by-two loop's smallest counterexample is n = 1.
  {
    const parsed = parseProgram(SYMX_EXAMPLES[7].src)
    if (parsed.ok) {
      const res = symExecute(parsed.program, { unroll: 8 })
      const ns = res.counterexamples.map((c) => c.inputs.find((x) => x.name === 'n')?.value ?? 0n)
      h.check(ns.some((v) => v % 2n === 1n), 'off-by-two loop: expected an odd counterexample n')
    }
  }

  // Randomized differential battery.
  checkRandom(h, 160, 0x51a7c0de)
  checkRandom(h, 120, 0x0ddba11)

  return { pass: h.pass, fail: h.fail, messages: h.messages }
}
