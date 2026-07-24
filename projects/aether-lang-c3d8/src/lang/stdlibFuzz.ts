// Aether — an in-browser DIFFERENTIAL FUZZER for the 30.2 list standard library.
//
// The new combinators (`sort`, `partition`, `span`, `takeWhile`/`dropWhile`,
// `scanl`, `zipWith`, `insert`, `product`, `maximum`/`minimum`, …) are written in
// Aether itself and compiled into every program. This harness generates hundreds
// of random calls to them and proves, for each:
//
//   • the compiled program's VM result equals an INDEPENDENT reference (the same
//     operation computed directly here in TypeScript), and
//   • that value re-appears from the JavaScript backend (VM ≡ JS).
//
// So the library isn't merely "tested" — every call is checked against a second,
// separate implementation of what it should mean, on two backends. Deterministic
// given the seed; pure logic, so it also runs head-less under Node.

import { runPipeline } from './pipeline.ts'
import { compileToJs, runJsModule } from './jsBackend.ts'
import { valueToString } from './values.ts'

export interface StdlibFuzzResult {
  total: number
  passed: number
  /** distinct combinators exercised across the batch */
  covered: number
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
const int = (rng: Rng, lo: number, hi: number): number => lo + (Math.floor(rng() * (hi - lo + 1)) | 0)
const randList = (rng: Rng, maxLen: number, hi: number): number[] => {
  const n = int(rng, 0, maxLen)
  const xs: number[] = []
  for (let i = 0; i < n; i++) xs.push(int(rng, 0, hi))
  return xs
}

const fmtList = (xs: number[]): string => `[${xs.join(', ')}]`
const fmtLit = (xs: number[]): string => `[${xs.join(', ')}]`
const pairLL = (a: number[], b: number[]): string => `(${fmtList(a)}, ${fmtList(b)})`

// each op: build the Aether source and the reference string, from fresh randoms
const OPS: readonly ((rng: Rng) => { code: string; expected: string })[] = [
  // sort
  (rng) => {
    const xs = randList(rng, 8, 9)
    return { code: `sort ${fmtLit(xs)}`, expected: fmtList([...xs].sort((a, b) => a - b)) }
  },
  // insert into a sorted list
  (rng) => {
    const xs = randList(rng, 7, 9).sort((a, b) => a - b)
    const k = int(rng, 0, 9)
    const out = [...xs]
    let i = 0
    while (i < out.length && out[i] < k) i++
    out.splice(i, 0, k)
    return { code: `insert ${k} ${fmtLit(xs)}`, expected: fmtList(out) }
  },
  // partition on parity
  (rng) => {
    const xs = randList(rng, 8, 9)
    return {
      code: `partition (fn x -> x % 2 == 0) ${fmtLit(xs)}`,
      expected: pairLL(xs.filter((x) => x % 2 === 0), xs.filter((x) => x % 2 !== 0)),
    }
  },
  // span (< k)
  (rng) => {
    const xs = randList(rng, 8, 9)
    const k = int(rng, 0, 9)
    let i = 0
    while (i < xs.length && xs[i] < k) i++
    return { code: `span (< ${k}) ${fmtLit(xs)}`, expected: pairLL(xs.slice(0, i), xs.slice(i)) }
  },
  // takeWhile (< k)
  (rng) => {
    const xs = randList(rng, 8, 9)
    const k = int(rng, 0, 9)
    let i = 0
    while (i < xs.length && xs[i] < k) i++
    return { code: `takeWhile (< ${k}) ${fmtLit(xs)}`, expected: fmtList(xs.slice(0, i)) }
  },
  // dropWhile (< k)
  (rng) => {
    const xs = randList(rng, 8, 9)
    const k = int(rng, 0, 9)
    let i = 0
    while (i < xs.length && xs[i] < k) i++
    return { code: `dropWhile (< ${k}) ${fmtLit(xs)}`, expected: fmtList(xs.slice(i)) }
  },
  // scanl (+) z
  (rng) => {
    const xs = randList(rng, 7, 6)
    const z = int(rng, 0, 5)
    const acc: number[] = [z]
    let s = z
    for (const x of xs) {
      s += x
      acc.push(s)
    }
    return { code: `scanl (+) ${z} ${fmtLit(xs)}`, expected: fmtList(acc) }
  },
  // zipWith (+)
  (rng) => {
    const xs = randList(rng, 8, 9)
    const ys = randList(rng, 8, 9)
    const n = Math.min(xs.length, ys.length)
    const out: number[] = []
    for (let i = 0; i < n; i++) out.push(xs[i] + ys[i])
    return { code: `zipWith (+) ${fmtLit(xs)} ${fmtLit(ys)}`, expected: fmtList(out) }
  },
  // product
  (rng) => {
    const xs = randList(rng, 6, 5)
    return { code: `product ${fmtLit(xs)}`, expected: String(xs.reduce((a, b) => a * b, 1)) }
  },
  // maximum of a guaranteed-non-empty list
  (rng) => {
    const xs = randList(rng, 7, 20)
    xs.push(int(rng, 0, 20))
    return { code: `maximum ${fmtLit(xs)}`, expected: String(Math.max(...xs)) }
  },
  // minimum of a guaranteed-non-empty list
  (rng) => {
    const xs = randList(rng, 7, 20)
    xs.push(int(rng, 0, 20))
    return { code: `minimum ${fmtLit(xs)}`, expected: String(Math.min(...xs)) }
  },
]

export function runStdlibFuzz(runs = 200, seed = 0x57d11b): StdlibFuzzResult {
  const rng = makeRng(seed)
  let passed = 0
  const usedOps = new Set<number>()
  const failures: { code: string; detail: string }[] = []

  for (let i = 0; i < runs; i++) {
    const opIdx = int(rng, 0, OPS.length - 1)
    usedOps.add(opIdx)
    const { code, expected } = OPS[opIdx](rng)

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

  return { total: runs, passed, covered: usedOps.size, failures }
}
