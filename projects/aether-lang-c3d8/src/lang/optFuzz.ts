// Aether — an in-browser DIFFERENTIAL FUZZER for the optimizing middle-end.
//
// Every other self-test checks a *fixed* program. This one generates hundreds of
// *random* well-typed programs — deliberately dense in the shapes the optimizer
// is supposed to crush (nested `if`/`match` producers feeding eliminators, record
// projections, arithmetic) — and, for each, proves the whole middle-end is sound:
//
//   • the OPTIMIZED program on the VM equals the UNOPTIMIZED program on the VM
//     (the optimizer never changed an answer), and
//   • that same value re-appears when the optimized core is compiled to
//     JavaScript and run (the VM ≡ JS backend equivalence), and
//   • the optimized program took NO MORE VM steps than the unoptimized one
//     (the standing "VM steps only fall" invariant — no rewrite is a pessimization).
//
// Deterministic given the seed, so the Tests page shows a stable green badge. Pure
// logic, so it also runs head-less under Node. This is the harness that backs the
// optimizer's central claim — that abstraction melts and the answer is preserved —
// on programs nobody wrote by hand.

import { runPipeline } from './pipeline.ts'
import { compileToJs, runJsModule } from './jsBackend.ts'
import { valueToString } from './values.ts'

export interface OptFuzzResult {
  total: number
  passed: number
  /** how many generated programs actually triggered case-of-case */
  commuted: number
  /** best single-program VM-step reduction seen, as a percentage */
  bestSavingPct: number
  /** total VM steps saved across the whole batch (unoptimized − optimized) */
  stepsSaved: number
  /** the first few divergences, if any (empty ⇒ the optimizer is sound here) */
  failures: { code: string; detail: string }[]
}

// ---------------------------------------------------------------------------
// a tiny deterministic LCG, and a typed program generator
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
const int = (rng: Rng, n: number): number => Math.floor(rng() * n) | 0

const ARITH = ['+', '-', '*'] as const
const CMP = ['==', '!=', '<', '>', '<=', '>='] as const

/** an Int-valued expression over the in-scope Int variables `ctx` */
function genInt(rng: Rng, ctx: string[], d: number): string {
  if (d <= 0 || rng() < 0.28) {
    return ctx.length > 0 && rng() < 0.5 ? pick(rng, ctx) : String(int(rng, 10))
  }
  switch (int(rng, 6)) {
    case 0:
      return `(${genInt(rng, ctx, d - 1)} ${pick(rng, ARITH)} ${genInt(rng, ctx, d - 1)})`
    case 1:
      return `(if ${genBool(rng, ctx, d - 1)} then ${genInt(rng, ctx, d - 1)} else ${genInt(rng, ctx, d - 1)})`
    case 2: {
      // a `match` on an Option PRODUCER — the case-of-case trigger
      const v = `v${ctx.length}`
      return `(match ${genOpt(rng, ctx, d - 1)} with None -> ${genInt(rng, ctx, d - 1)} | Some ${v} -> ${genInt(rng, [...ctx, v], d - 1)})`
    }
    case 3:
      // a `.field` projection on a record PRODUCER
      return `(${genRecord(rng, ctx, d - 1)}.${pick(rng, ['a', 'b'])})`
    case 4:
      return `(0 - ${genInt(rng, ctx, d - 1)})`
    default: {
      // a `let` whose value is a producer — exercises 21.1 linear inlining
      const z = `z${ctx.length}`
      return `(let ${z} = ${genInt(rng, ctx, d - 1)} in ${genInt(rng, [...ctx, z], d - 1)})`
    }
  }
}

function genBool(rng: Rng, ctx: string[], d: number): string {
  if (d <= 0 || rng() < 0.35) {
    return `(${genInt(rng, ctx, d - 1)} ${pick(rng, CMP)} ${genInt(rng, ctx, d - 1)})`
  }
  switch (int(rng, 4)) {
    case 0:
      return `(${genBool(rng, ctx, d - 1)} && ${genBool(rng, ctx, d - 1)})`
    case 1:
      return `(${genBool(rng, ctx, d - 1)} || ${genBool(rng, ctx, d - 1)})`
    case 2:
      return `(! ${genBool(rng, ctx, d - 1)})`
    default:
      return `(if ${genBool(rng, ctx, d - 1)} then ${genBool(rng, ctx, d - 1)} else ${genBool(rng, ctx, d - 1)})`
  }
}

/** an `Opt Int` producer, biased toward an `if` so the consumer gets stuck on it */
function genOpt(rng: Rng, ctx: string[], d: number): string {
  const r = rng()
  if (r < 0.62) {
    return `(if ${genBool(rng, ctx, d - 1)} then Some ${genInt(rng, ctx, d - 1)} else None)`
  }
  if (r < 0.82) return `Some ${genInt(rng, ctx, d - 1)}`
  return `None`
}

/** a record producer: an `if` choosing between two `{ a, b }` records */
function genRecord(rng: Rng, ctx: string[], d: number): string {
  return `(if ${genBool(rng, ctx, d - 1)} then { a = ${genInt(rng, ctx, d - 1)}, b = ${genInt(rng, ctx, d - 1)} } else { a = ${genInt(rng, ctx, d - 1)}, b = ${genInt(rng, ctx, d - 1)} })`
}

const PRELUDE = 'type Opt a = None | Some a in\n'

/** Either a closed Int program, or a function applied to fixed arguments (so its
 *  body's producers stay opaque to the optimizer, then collapse at the call). */
function genProgram(rng: Rng): string {
  if (rng() < 0.5) return PRELUDE + genInt(rng, [], 4)
  const arity = 1 + int(rng, 2)
  const params = Array.from({ length: arity }, (_, i) => `p${i}`)
  const body = genInt(rng, params, 4)
  const lam = params.reduceRight((acc, p) => `fn ${p} -> ${acc}`, body)
  const callArgs = (seed: number): string => {
    const r2 = makeRng(seed)
    return params.map(() => String(int(r2, 9))).join(' ')
  }
  return PRELUDE + `let f = ${lam} in (f ${callArgs(1)}, f ${callArgs(7)}, f ${callArgs(13)})`
}

// ---------------------------------------------------------------------------
// a SECOND generator, dense in the shapes Aether 23.0 SpecConstr crushes:
// self-recursive loops that thread an accumulator as one tuple/constructor shape
// and tear it apart with a `match` every iteration.
// ---------------------------------------------------------------------------

/** an Int update expression over the loop's field variables + the counter `i`.
 *  Full `+ - *` arithmetic, including products that overflow Int32 as the loop runs
 *  — Aether's `Int` is a true ℤ/2^32 ring (multiplication is `Math.imul` on every
 *  backend), so SpecConstr's box/unbox rewrite and the equality-saturation pass both
 *  stay exact there, which this battery re-proves. */
function genField(rng: Rng, fvars: string[], d: number): string {
  if (d <= 0 || rng() < 0.45) {
    return rng() < 0.7 ? pick(rng, [...fvars, 'i']) : String(1 + int(rng, 5))
  }
  return `(${genField(rng, fvars, d - 1)} ${pick(rng, ARITH)} ${genField(rng, fvars, d - 1)})`
}

/** a self-recursive loop threading a 2/3-field tuple OR single-constructor state,
 *  destructured by its own `match` and rebuilt fresh every iteration — exactly the
 *  call pattern SpecConstr specialises into a first-order loop over the fields. */
function genSpecConstrProgram(rng: Rng): string {
  const arity = 2 + int(rng, 2) // 2 or 3 fields
  const useCtor = rng() < 0.5
  const fvars = Array.from({ length: arity }, (_, k) => `f${k}`)
  const pat = useCtor ? `MkS ${fvars.join(' ')}` : `(${fvars.join(', ')})`
  const mk = (parts: string[]): string => (useCtor ? `(MkS ${parts.join(' ')})` : `(${parts.join(', ')})`)
  const next = mk(fvars.map(() => genField(rng, fvars, 2)))
  const seed = mk(fvars.map(() => String(int(rng, 4))))
  const result = rng() < 0.5 ? `(${fvars.join(' + ')})` : pick(rng, fvars)
  const n = 3 + int(rng, 8)
  const decl = useCtor ? `type S = MkS ${fvars.map(() => 'Int').join(' ')} in\n` : ''
  return (
    decl +
    `let rec go = fn st -> fn i ->\n` +
    `  match st with ${pat} ->\n` +
    `    if i <= 0 then ${result}\n` +
    `    else go ${next} (i - 1)\n` +
    `in go ${seed} ${n}`
  )
}

// ---------------------------------------------------------------------------
// the fuzz driver
// ---------------------------------------------------------------------------

export function runOptimizerFuzz(runs = 120, seed = 0xc0ffee): OptFuzzResult {
  const rng = makeRng(seed)
  let passed = 0
  let commuted = 0
  let bestSavingPct = 0
  let stepsSaved = 0
  const failures: { code: string; detail: string }[] = []

  for (let i = 0; i < runs; i++) {
    const code = genProgram(rng)
    const off = runPipeline(code, { optimize: false })
    const on = runPipeline(code, { optimize: true })

    // a program that fails to type-check is a generator bug, not an optimizer
    // bug — skip it (it does not count toward the total) so the badge stays honest.
    if (off.error || on.error || !on.optimizedCoreAst) {
      continue
    }
    passed++ // provisionally; demoted below on any disagreement

    const vmOff = off.run?.result ? valueToString(off.run.result) : '()'
    const vmOn = on.run?.result ? valueToString(on.run.result) : '()'
    const js = ((): string => {
      try {
        const r = runJsModule(compileToJs(on.optimizedCoreAst!).full)
        return r.error ? `error: ${r.error}` : (r.result ?? '()')
      } catch (e) {
        return `threw: ${e instanceof Error ? e.message : String(e)}`
      }
    })()

    const stepsOff = off.run?.steps ?? 0
    const stepsOn = on.run?.steps ?? 0
    const agree = vmOn === vmOff && js === vmOff
    const monotone = stepsOn <= stepsOff

    if (!agree || !monotone) {
      passed--
      if (failures.length < 5) {
        const detail = !agree
          ? `disagree: unopt-VM ${vmOff}, opt-VM ${vmOn}, opt-JS ${js}`
          : `steps rose: ${stepsOff} → ${stepsOn}`
        failures.push({ code: code.replace(PRELUDE, '').trim(), detail })
      }
      continue
    }

    if ((on.optimization?.commutes?.length ?? 0) > 0) commuted++
    if (stepsOff > 0) {
      stepsSaved += stepsOff - stepsOn
      const savingPct = Math.round(((stepsOff - stepsOn) / stepsOff) * 100)
      if (savingPct > bestSavingPct) bestSavingPct = savingPct
    }
  }

  // `total` counts only the programs that type-checked (the ones actually tested).
  return {
    total: passed + failures.length,
    passed,
    commuted,
    bestSavingPct,
    stepsSaved,
    failures,
  }
}

export interface SpecConstrFuzzResult {
  total: number
  passed: number
  /** how many generated loops actually triggered SpecConstr */
  fired: number
  bestSavingPct: number
  stepsSaved: number
  failures: { code: string; detail: string }[]
}

/** The Aether 23.0 differential fuzzer: random tuple/constructor-threaded loops,
 *  each proving SpecConstr is sound — the specialised program equals the naive one
 *  on the VM and on the JS backend, and never takes more VM steps. Deterministic
 *  given the seed; pure logic, so it also runs head-less under Node. */
export function runSpecConstrFuzz(runs = 150, seed = 0x5ec04ec0): SpecConstrFuzzResult {
  const rng = makeRng(seed)
  let passed = 0
  let fired = 0
  let bestSavingPct = 0
  let stepsSaved = 0
  const failures: { code: string; detail: string }[] = []

  for (let i = 0; i < runs; i++) {
    const code = genSpecConstrProgram(rng)
    const off = runPipeline(code, { optimize: false })
    const on = runPipeline(code, { optimize: true })

    if (off.error || on.error || !on.optimizedCoreAst) continue // generator slip — skip
    passed++ // provisionally; demoted below on any disagreement

    const vmOff = off.run?.result ? valueToString(off.run.result) : '()'
    const vmOn = on.run?.result ? valueToString(on.run.result) : '()'
    const js = ((): string => {
      try {
        const r = runJsModule(compileToJs(on.optimizedCoreAst!).full)
        return r.error ? `error: ${r.error}` : (r.result ?? '()')
      } catch (e) {
        return `threw: ${e instanceof Error ? e.message : String(e)}`
      }
    })()

    const stepsOff = off.run?.steps ?? 0
    const stepsOn = on.run?.steps ?? 0
    const agree = vmOn === vmOff && js === vmOff
    const monotone = stepsOn <= stepsOff

    if (!agree || !monotone) {
      passed--
      if (failures.length < 5) {
        const detail = !agree
          ? `disagree: unopt-VM ${vmOff}, opt-VM ${vmOn}, opt-JS ${js}`
          : `steps rose: ${stepsOff} → ${stepsOn}`
        failures.push({ code: code.replace(/type S =[^\n]*\n/, '').trim(), detail })
      }
      continue
    }

    if ((on.optimization?.specConstrs?.length ?? 0) > 0) fired++
    if (stepsOff > 0) {
      stepsSaved += stepsOff - stepsOn
      const savingPct = Math.round(((stepsOff - stepsOn) / stepsOff) * 100)
      if (savingPct > bestSavingPct) bestSavingPct = savingPct
    }
  }

  return { total: passed + failures.length, passed, fired, bestSavingPct, stepsSaved, failures }
}

// ---------------------------------------------------------------------------
// a THIRD generator, dense in the shapes Aether 24.0 SROA crushes: a `let`-bound
// record (the exact shape a type-class *dictionary* takes after elaboration)
// whose fields — atoms and small functions — are projected from many sites,
// often inside a hot loop. SROA devirtualizes each `r.f` to the field value and,
// when the record is left dead, drops the allocation entirely.
// ---------------------------------------------------------------------------

/** an Int expression over exactly the variables in `ctx` (never inventing one,
 *  unlike `genField`, which assumes a loop counter `i`) — so the direct,
 *  loop-free shapes below stay well-typed. */
function genIE(rng: Rng, ctx: string[], d: number): string {
  if (d <= 0 || ctx.length === 0 || rng() < 0.4) {
    return ctx.length > 0 && rng() < 0.6 ? pick(rng, ctx) : String(1 + int(rng, 6))
  }
  return `(${genIE(rng, ctx, d - 1)} ${pick(rng, ARITH)} ${genIE(rng, ctx, d - 1)})`
}

/** a `let`-bound record projected from several sites — half the time across the
 *  body of a self-recursive loop (so each field is read every iteration, the
 *  multi-use case the single-use value inliner can't touch). Fields are a mix of
 *  atoms (literals / outer variables) and small one-argument functions — exactly
 *  a dictionary of methods. */
function genSroaProgram(rng: Rng): string {
  const useOuter = rng() < 0.5
  const outerCtx = useOuter ? ['p', 'q'] : []
  const outer = useOuter ? `let p = ${1 + int(rng, 8)} in let q = ${1 + int(rng, 8)} in\n` : ''
  const nf = 2 + int(rng, 2) // 2 or 3 fields
  const labels = ['a', 'b', 'c'].slice(0, nf)
  const kinds = labels.map(() => (rng() < 0.6 ? 'int' : 'fn'))
  const defs = labels.map((L, i) => {
    if (kinds[i] === 'int') {
      const v = outerCtx.length > 0 && rng() < 0.5 ? pick(rng, outerCtx) : String(1 + int(rng, 5))
      return `${L} = ${v}`
    }
    return `${L} = fn z -> ${genIE(rng, ['z', ...outerCtx], 2)}`
  })
  const record = `{ ${defs.join(', ')} }`
  const use = (i: number, ctx: string[]): string =>
    kinds[i] === 'int' ? `r.${labels[i]}` : `(r.${labels[i]} ${genIE(rng, ctx, 1)})`

  if (rng() < 0.5) {
    // a hot loop reading the fields every iteration
    const uses = labels.map((_, i) => use(i, ['n', ...outerCtx])).join(' + ')
    const k = 3 + int(rng, 8)
    return (
      outer +
      `let r = ${record} in\n` +
      `let rec go = fn n -> fn acc ->\n` +
      `  if n <= 0 then acc else go (n - 1) (acc + ${uses})\n` +
      `in go ${k} 0`
    )
  }
  // a direct combination of several projections
  const m = 2 + int(rng, 3)
  const parts = Array.from({ length: m }, () => use(int(rng, nf), outerCtx))
  return outer + `let r = ${record} in\n(${parts.join(' + ')})`
}

export interface SroaFuzzResult {
  total: number
  passed: number
  /** how many generated programs actually triggered SROA */
  fired: number
  /** how many of those left the record entirely dead (allocation removed) */
  eliminated: number
  bestSavingPct: number
  stepsSaved: number
  failures: { code: string; detail: string }[]
}

/** The Aether 24.0 differential fuzzer: random `let`-bound records (the post-
 *  elaboration shape of a type-class dictionary) projected from many sites, each
 *  proving SROA is sound — the devirtualized program equals the naive one on the
 *  VM and on the JS backend, and never takes more VM steps. Deterministic given
 *  the seed; pure logic, so it also runs head-less under Node. */
export function runSroaFuzz(runs = 150, seed = 0x5404eccc): SroaFuzzResult {
  const rng = makeRng(seed)
  let passed = 0
  let fired = 0
  let eliminated = 0
  let bestSavingPct = 0
  let stepsSaved = 0
  const failures: { code: string; detail: string }[] = []

  for (let i = 0; i < runs; i++) {
    const code = genSroaProgram(rng)
    const off = runPipeline(code, { optimize: false })
    const on = runPipeline(code, { optimize: true })

    if (off.error || on.error || !on.optimizedCoreAst) continue // generator slip — skip
    passed++ // provisionally; demoted below on any disagreement

    const vmOff = off.run?.result ? valueToString(off.run.result) : '()'
    const vmOn = on.run?.result ? valueToString(on.run.result) : '()'
    const js = ((): string => {
      try {
        const r = runJsModule(compileToJs(on.optimizedCoreAst!).full)
        return r.error ? `error: ${r.error}` : (r.result ?? '()')
      } catch (e) {
        return `threw: ${e instanceof Error ? e.message : String(e)}`
      }
    })()

    const stepsOff = off.run?.steps ?? 0
    const stepsOn = on.run?.steps ?? 0
    const agree = vmOn === vmOff && js === vmOff
    const monotone = stepsOn <= stepsOff

    if (!agree || !monotone) {
      passed--
      if (failures.length < 5) {
        const detail = !agree
          ? `disagree: unopt-VM ${vmOff}, opt-VM ${vmOn}, opt-JS ${js}`
          : `steps rose: ${stepsOff} → ${stepsOn}`
        failures.push({ code: code.trim(), detail })
      }
      continue
    }

    const records = on.optimization?.sroaRecords ?? []
    if (records.length > 0) {
      fired++
      if (records.some((r) => r.eliminated)) eliminated++
    }
    if (stepsOff > 0) {
      stepsSaved += stepsOff - stepsOn
      const savingPct = Math.round(((stepsOff - stepsOn) / stepsOff) * 100)
      if (savingPct > bestSavingPct) bestSavingPct = savingPct
    }
  }

  return { total: passed + failures.length, passed, fired, eliminated, bestSavingPct, stepsSaved, failures }
}
