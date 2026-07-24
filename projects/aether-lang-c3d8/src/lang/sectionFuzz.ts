// Aether — an in-browser DIFFERENTIAL FUZZER for operator sections.
//
// Operator sections (Aether 30.1) are pure parser sugar: `(+ n)` becomes
// `fn x -> x + n`, `(op)` becomes `fn a b -> a op b`, `(.field)` becomes
// `fn r -> r.field`. Like every sugar, a wrong desugaring still type-checks and
// runs — it just computes the wrong thing — so this harness builds hundreds of
// random point-free PIPELINES out of sections and proves, for each:
//
//   • the compiled program's VM result equals an INDEPENDENT reference (the same
//     pipeline evaluated directly here in TypeScript, never touching the parser's
//     desugaring), and
//   • that value re-appears from the JavaScript backend (VM ≡ JS) — the check
//     that first surfaced (and now guards against) the fn-in-call-position
//     parenthesisation bug a bare `(op) x y` at top level would otherwise hit.
//
// Deterministic given the seed; pure logic, so it also runs head-less under Node.

import { runPipeline } from './pipeline.ts'
import { compileToJs, runJsModule } from './jsBackend.ts'
import { valueToString } from './values.ts'

export interface SectionFuzzResult {
  total: number
  passed: number
  /** how many pipelines ended in a fold to a scalar (vs. a list) */
  folded: number
  failures: { code: string; detail: string }[]
}

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

// A stage is a `map`/`filter` over an integer list, applied through a section, or
// a terminal `foldl` to a scalar. Each carries how to RENDER itself and how to
// RUN the reference.
type Stage =
  | { t: 'map'; op: '+' | '*' | 'subtract'; n: number }
  | { t: 'filter'; op: '>' | '<' | '==' | '!='; n: number }

function renderStage(s: Stage): string {
  if (s.t === 'map') {
    if (s.op === 'subtract') return `map (subtract ${s.n})`
    if (s.op === '*') return `map ( * ${s.n})` // star section needs the space
    return `map (${s.op} ${s.n})`
  }
  return `filter (${s.op} ${s.n})`
}

function runStage(s: Stage, xs: number[]): number[] {
  if (s.t === 'map') {
    const f =
      s.op === '+' ? (x: number) => x + s.n : s.op === '*' ? (x: number) => x * s.n : (x: number) => x - s.n
    return xs.map(f)
  }
  const p =
    s.op === '>'
      ? (x: number) => x > s.n
      : s.op === '<'
        ? (x: number) => x < s.n
        : s.op === '=='
          ? (x: number) => x === s.n
          : (x: number) => x !== s.n
  return xs.filter(p)
}

export function runSectionFuzz(runs = 200, seed = 0x5ec7104): SectionFuzzResult {
  const rng = makeRng(seed)
  let passed = 0
  let folded = 0
  const failures: { code: string; detail: string }[] = []

  for (let i = 0; i < runs; i++) {
    // a random non-negative int list
    const src: number[] = []
    for (let k = 0, n = int(rng, 0, 7); k < n; k++) src.push(int(rng, 0, 12))

    // a random chain of section stages
    const stages: Stage[] = []
    for (let k = 0, n = int(rng, 1, 4); k < n; k++) {
      if (rng() < 0.5) stages.push({ t: 'map', op: pick(rng, ['+', '*', 'subtract'] as const), n: int(rng, 0, 5) })
      else stages.push({ t: 'filter', op: pick(rng, ['>', '<', '==', '!='] as const), n: int(rng, 0, 8) })
    }
    const foldEnd = rng() < 0.5

    // reference
    let ref = src.slice()
    for (const s of stages) ref = runStage(s, ref)
    const refVal = foldEnd ? ref.reduce((a, b) => a + b, 0) : ref
    const expected = foldEnd ? String(refVal) : `[${(refVal as number[]).join(', ')}]`
    if (foldEnd) folded++

    // source
    let code = `[${src.join(', ')}]`
    for (const s of stages) code = `${code} |> ${renderStage(s)}`
    if (foldEnd) code = `${code} |> foldl (+) 0`

    let vm: string
    let coreAst
    try {
      const r = runPipeline(code, { execute: true })
      if (r.error) {
        if (failures.length < 8) failures.push({ code, detail: `${r.error.stage}: ${r.error.message}` })
        continue
      }
      coreAst = r.coreAst
      vm = r.run?.result ? valueToString(r.run.result) : '()'
    } catch (e) {
      if (failures.length < 8) failures.push({ code, detail: `threw: ${String(e)}` })
      continue
    }
    if (vm !== expected) {
      if (failures.length < 8) failures.push({ code, detail: `VM ${vm} ≠ reference ${expected}` })
      continue
    }
    try {
      const js = runJsModule(compileToJs(coreAst!).full)
      if (js.error === null && js.result === vm) passed++
      else if (failures.length < 8) failures.push({ code, detail: `JS ${js.error ?? js.result} ≠ VM ${vm}` })
    } catch (e) {
      if (failures.length < 8) failures.push({ code, detail: `JS threw: ${String(e)}` })
    }
  }

  return { total: runs, passed, folded, failures }
}
