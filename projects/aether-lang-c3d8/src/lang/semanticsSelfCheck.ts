// Aether — editor-semantics self-tests
//
// The hovers, occurrence links, go-to-definition, inlay hints, rename and
// completion the editor offers are only as trustworthy as the resolver behind
// them. These cases drive that resolver over real, type-checked programs and
// assert the answers it gives — so a regression in scope resolution or in the
// type a hover reports is caught by the in-app Tests page, exactly like the
// language's other engines. Everything runs in the browser.

import { runPipeline } from './pipeline.ts'
import { GLOBALS } from './prelude.ts'
import {
  buildSemanticIndex,
  completionItems,
  definitionAt,
  hoverAt,
  inlayHints,
  isValidName,
  occurrencesAt,
  renameBinder,
} from './semantics.ts'
import type { SemanticIndex } from './semantics.ts'

export interface SemSelfResult {
  name: string
  ok: boolean
  detail: string
}

function indexFor(code: string): SemanticIndex {
  const r = runPipeline(code, { execute: false })
  return buildSemanticIndex(r.ast, r.typeResult, code)
}

/** offset of the nth (0-based) occurrence of `needle` in `code` */
function nth(code: string, needle: string, n = 0): number {
  let idx = -1
  for (let i = 0; i <= n; i++) idx = code.indexOf(needle, idx + 1)
  return idx
}

export function runSemanticsSelfCheck(): SemSelfResult[] {
  const out: SemSelfResult[] = []
  const check = (name: string, fn: () => string | true): void => {
    try {
      const r = fn()
      out.push({ name, ok: r === true, detail: r === true ? 'ok' : r })
    } catch (e) {
      out.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  check('hover on a let binding shows its generalised scheme', () => {
    const code = 'let twice = fn f -> fn x -> f (f x) in twice'
    const idx = indexFor(code)
    const h = hoverAt(idx, nth(code, 'twice', 1) + 1) // the use after `in`
    if (!h) return 'no hover'
    if (h.scheme !== '∀ a. (a -> a) -> a -> a') return `scheme = ${h.scheme}`
    return true
  })

  check('hover reports the monomorphic type at a use site', () => {
    const code = 'let id = fn x -> x in id 5'
    const idx = indexFor(code)
    const h = hoverAt(idx, nth(code, 'id', 1)) // `id 5`
    if (!h) return 'no hover'
    if (h.type !== 'Int -> Int') return `use type = ${h.type}`
    return true
  })

  check('hover on a literal gives its primitive type', () => {
    const code = 'let n = 42 in n'
    const idx = indexFor(code)
    const h = hoverAt(idx, nth(code, '42') + 1)
    if (!h || h.type !== 'Int') return `type = ${h?.type}`
    return true
  })

  check('hover on a lambda parameter is identified as a parameter', () => {
    const code = 'let f = fn n -> n + 1 in f 0'
    const idx = indexFor(code)
    const h = hoverAt(idx, code.indexOf('fn n') + 3) // the binder `n`
    if (!h) return 'no hover'
    if (h.origin !== 'lambda parameter') return `origin = ${h.origin}`
    return true
  })

  check('occurrences link a definition to every use', () => {
    const code = 'let inc = fn n -> n + 1 in inc (inc 0)'
    const idx = indexFor(code)
    const occ = occurrencesAt(idx, nth(code, 'inc')) // def
    if (!occ) return 'no occurrences'
    if (occ.length !== 3) return `found ${occ.length}, expected 3`
    return true
  })

  check('go-to-definition jumps from a use back to the binder', () => {
    const code = 'let answer = 7 in answer + answer'
    const idx = indexFor(code)
    const def = definitionAt(idx, nth(code, 'answer', 2)) // 2nd use
    if (!def) return 'no definition'
    if (def.start !== nth(code, 'answer', 0)) return `def at ${def.start}`
    return true
  })

  check('shadowing: an inner binding is resolved independently', () => {
    const code = 'let x = 1 in let f = fn x -> x + 1 in f x'
    const idx = indexFor(code)
    const paramOff = nth(code, 'x', 1) // the `x` in `fn x`
    const occ = occurrencesAt(idx, paramOff)
    if (!occ) return 'no occurrences for param'
    // param x: its binder + the `x` in `x + 1` — NOT the outer `x` in `f x`
    const outerX = nth(code, 'x', 3)
    if (occ.some((s) => s.start === outerX)) return 'param leaked into outer use'
    if (occ.length !== 2) return `param occ = ${occ.length}, expected 2`
    return true
  })

  check('recursive let sees its own name inside its body', () => {
    const code = 'let rec loop = fn n -> if n == 0 then 0 else loop (n - 1) in loop 3'
    const idx = indexFor(code)
    const occ = occurrencesAt(idx, nth(code, 'loop')) // def
    if (!occ) return 'no occurrences'
    if (occ.length !== 3) return `loop occ = ${occ.length}, expected 3`
    return true
  })

  check('pattern variables in a match are bound and hoverable', () => {
    const code = 'match [1, 2] with [] -> 0 | h :: t -> h'
    const idx = indexFor(code)
    const h = hoverAt(idx, code.indexOf('h :: t')) // the pattern `h`
    if (!h) return 'no hover on pattern var'
    if (h.origin !== 'pattern variable') return `origin = ${h.origin}`
    return true
  })

  check('inlay hints carry each binding’s scheme', () => {
    const code = 'let sq = fn x -> x * x in let n = sq 9 in n'
    const idx = indexFor(code)
    const hints = inlayHints(idx)
    const sq = hints.find((hh) => hh.anchor === nth(code, 'sq'))
    if (!sq) return 'no inlay for sq'
    if (sq.text !== ': Int -> Int') return `sq hint = ${sq.text}`
    return true
  })

  check('completion filters by the identifier prefix', () => {
    const code = 'let twice = fn f -> f in tw'
    const idx = indexFor(code)
    const res = completionItems(idx, code, code.length, GLOBALS)
    if (res.prefix !== 'tw') return `prefix = ${res.prefix}`
    if (!res.items.some((i) => i.label === 'twice' && i.kind === 'local')) return 'twice missing'
    return true
  })

  check('completion offers prelude library functions', () => {
    const code = 'let xs = [1] in ma'
    const idx = indexFor(code)
    const res = completionItems(idx, code, code.length, GLOBALS)
    const map = res.items.find((i) => i.label === 'map')
    if (!map) return 'map missing'
    if (map.kind !== 'prelude') return `map kind = ${map.kind}`
    return true
  })

  check('completion offers TypeScript primitives with their scheme', () => {
    const code = 'sq'
    const idx = indexFor(code)
    const res = completionItems(idx, code, code.length, GLOBALS)
    const sqrt = res.items.find((i) => i.label === 'sqrt')
    if (!sqrt) return 'sqrt missing'
    if (!sqrt.detail.includes('Float')) return `sqrt detail = ${sqrt.detail}`
    return true
  })

  check('completion surfaces user data constructors', () => {
    const code = 'type Color = Red | Green | Blue\nin Gr'
    const idx = indexFor(code)
    const res = completionItems(idx, code, code.length, GLOBALS)
    if (!res.items.some((i) => i.label === 'Green' && i.kind === 'ctor')) return 'Green missing'
    return true
  })

  check('locals rank above globals in completion order', () => {
    // `max` is a global; introduce a local also starting with `ma`
    const code = 'let mapper = fn x -> x in ma'
    const idx = indexFor(code)
    const res = completionItems(idx, code, code.length, GLOBALS)
    const li = res.items.findIndex((i) => i.label === 'mapper')
    const gi = res.items.findIndex((i) => i.label === 'max')
    if (li < 0) return 'local mapper missing'
    if (gi >= 0 && li > gi) return 'global ranked above local'
    return true
  })

  check('rename rewrites every occurrence and nothing else', () => {
    const code = 'let inc = fn n -> n + 1 in inc (inc 0)'
    const idx = indexFor(code)
    const res = renameBinder(idx, nth(code, 'inc'), 'bump')
    if (!res) return 'rename returned null'
    const expected = 'let bump = fn n -> n + 1 in bump (bump 0)'
    if (res.source !== expected) return `got: ${res.source}`
    // the renamed program must still type-check
    const re = runPipeline(res.source, { execute: false })
    if (re.error) return `renamed program broke: ${re.error.message}`
    return true
  })

  check('rename respects shadowing (inner param only)', () => {
    const code = 'let x = 1 in let f = fn x -> x + x in f x'
    const idx = indexFor(code)
    const res = renameBinder(idx, nth(code, 'x', 1), 'y') // the param
    if (!res) return 'rename returned null'
    const expected = 'let x = 1 in let f = fn y -> y + y in f x'
    if (res.source !== expected) return `got: ${res.source}`
    return true
  })

  check('isValidName accepts identifiers and rejects junk', () => {
    if (!isValidName('foo') || !isValidName("x'") || !isValidName('Cons')) return 'rejected valid'
    if (isValidName('2bad') || isValidName('a b') || isValidName('')) return 'accepted invalid'
    return true
  })

  check('an unparseable buffer degrades without throwing', () => {
    const idx = indexFor('let x = in in in')
    const occ = occurrencesAt(idx, 5)
    const res = completionItems(idx, 'let x = in in in', 4, GLOBALS)
    // no crash; completion still offers globals/keywords
    if (occ !== null && occ.length === 0) return 'unexpected occ shape'
    if (res.items.length === 0) return 'no fallback completions'
    return true
  })

  return out
}
