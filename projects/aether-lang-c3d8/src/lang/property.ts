// Aether — type-directed property-based testing ("Aether Check").
//
// QuickCheck, written from scratch and driven entirely by the *inferred* types.
// You write `prop_*` functions that return `Bool`; this module reads each
// property's Hindley–Milner type, builds a random-value generator straight from
// that type (numbers, strings, lists, tuples, records, your own ADTs —
// recursively, with a size budget so recursive types like `Tree` terminate —
// and even functions, generated as a finite key→value table), runs hundreds of
// cases through the *real* VM, and on a failure performs integrated shrinking to
// a minimal counterexample. Everything is deterministic (a seeded RNG), so the
// same program always yields the same report.
//
// It reuses the exact execution path: a generated test is an ordinary Aether
// program (`prop x y z` applied to literal arguments) handed to
// `executeProgram`, so there is no second interpreter to keep in step.

import type { Expr } from './ast.ts'
import type { Span } from './lexer.ts'
import type { InferResult } from './infer.ts'
import { executeProgram, runPipeline } from './pipeline.ts'
import type { Scheme, Type } from './types.ts'
import {
  ARROW,
  LIST,
  RECORD,
  TUPLE,
  prune,
  rowLabelOf,
  schemeToString,
  tInt,
} from './types.ts'
import { listToArray } from './values.ts'

const SYNTH: Span = { start: 0, end: 0, line: 0, col: 0 }

// ---------------------------------------------------------------------------
// Generation types & values
// ---------------------------------------------------------------------------

/** A concrete, generatable type (the property's argument types, monomorphised). */
type GType =
  | { k: 'int' }
  | { k: 'float' }
  | { k: 'bool' }
  | { k: 'string' }
  | { k: 'unit' }
  | { k: 'list'; elem: GType }
  | { k: 'tuple'; elems: GType[] }
  | { k: 'record'; fields: { label: string; type: GType }[] }
  | { k: 'data'; typeName: string; typeArgs: Type[] }
  | { k: 'fn'; dom: GType; cod: GType }

/** A generated value — enough information to render it, run it and shrink it. */
type GValue =
  | { k: 'int'; n: number }
  | { k: 'float'; n: number }
  | { k: 'bool'; b: boolean }
  | { k: 'string'; s: string }
  | { k: 'unit' }
  | { k: 'list'; items: GValue[]; elem: GType }
  | { k: 'tuple'; items: GValue[] }
  | { k: 'record'; fields: { label: string; value: GValue }[] }
  | { k: 'data'; name: string; args: GValue[]; type: GType }
  // a generated function: a finite table of key→value plus a default, rendered
  // as `fn x -> if x == k1 then v1 else … else dflt`
  | { k: 'fn'; entries: { key: GValue; val: GValue }[]; dflt: GValue; dom: GType; cod: GType }

/** Constructor & type metadata needed to generate ADT values. */
interface GenCtx {
  ctorInfo: Map<string, { arity: number; scheme: Scheme }>
  typeCtors: InferResult['typeCtors']
}

class GenError extends Error {}

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32) — reproducible reports.
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1))
}

// ---------------------------------------------------------------------------
// Type → GType
// ---------------------------------------------------------------------------

function substType(t: Type, sub: Map<number, Type>): Type {
  const p = prune(t)
  if (p.kind === 'var') return sub.get(p.id) ?? p
  return { kind: 'con', name: p.name, args: p.args.map((a) => substType(a, sub)) }
}

function peelArrows(t: Type): { args: Type[]; result: Type } {
  const args: Type[] = []
  let cur = prune(t)
  while (cur.kind === 'con' && cur.name === ARROW && cur.args.length === 2) {
    args.push(cur.args[0])
    cur = prune(cur.args[1])
  }
  return { args, result: cur }
}

/** Resolve a `Type` into a generatable `GType`, or throw `GenError`. */
function toGType(t: Type, ctx: GenCtx): GType {
  const p = prune(t)
  if (p.kind === 'var') return { k: 'int' } // leftover polymorphism defaults to Int
  switch (p.name) {
    case 'Int':
      return { k: 'int' }
    case 'Float':
      return { k: 'float' }
    case 'Bool':
      return { k: 'bool' }
    case 'String':
      return { k: 'string' }
    case 'Unit':
      return { k: 'unit' }
    case ARROW: {
      const dom = toGType(p.args[0], ctx)
      // the generated function decides via `==`, which cannot compare functions
      if (!comparable(dom)) throw new GenError('functions taking functions')
      return { k: 'fn', dom, cod: toGType(p.args[1], ctx) }
    }
    case LIST:
      return { k: 'list', elem: toGType(p.args[0], ctx) }
    case TUPLE:
      if (p.args.length === 0) return { k: 'unit' }
      return { k: 'tuple', elems: p.args.map((a) => toGType(a, ctx)) }
    case RECORD: {
      const fields: { label: string; type: GType }[] = []
      let row = prune(p.args[0])
      while (row.kind === 'con' && row.name.startsWith('row:')) {
        fields.push({ label: rowLabelOf(row.name), type: toGType(row.args[0], ctx) })
        row = prune(row.args[1])
      }
      return { k: 'record', fields }
    }
    default:
      if (ctx.typeCtors.has(p.name)) return { k: 'data', typeName: p.name, typeArgs: p.args }
      throw new GenError(p.name)
  }
}

interface Variant {
  name: string
  argTypes: GType[]
}

/** Instantiate a data type's constructors at the given type arguments. */
function variantsOf(typeName: string, typeArgs: Type[], ctx: GenCtx): Variant[] {
  const info = ctx.typeCtors.get(typeName)
  if (!info) throw new GenError(typeName)
  return info.ctors.map((c) => {
    const cinfo = ctx.ctorInfo.get(c.name)
    if (!cinfo) throw new GenError(c.name)
    const { args, result } = peelArrows(cinfo.scheme.type)
    // result is `tcon(typeName, [paramVar0, paramVar1, …])`; bind each to typeArgs.
    const sub = new Map<number, Type>()
    const rp = prune(result)
    if (rp.kind === 'con') {
      rp.args.forEach((pv, i) => {
        const v = prune(pv)
        if (v.kind === 'var' && i < typeArgs.length) sub.set(v.id, typeArgs[i])
      })
    }
    return { name: c.name, argTypes: args.map((a) => toGType(substType(a, sub), ctx)) }
  })
}

/** Does this GType (transitively) mention the named data type? (recursion check) */
function mentions(t: GType, typeName: string): boolean {
  switch (t.k) {
    case 'data':
      return t.typeName === typeName || t.typeArgs.some((a) => typeMentions(a, typeName))
    case 'list':
      return mentions(t.elem, typeName)
    case 'tuple':
      return t.elems.some((e) => mentions(e, typeName))
    case 'record':
      return t.fields.some((f) => mentions(f.type, typeName))
    case 'fn':
      return mentions(t.dom, typeName) || mentions(t.cod, typeName)
    default:
      return false
  }
}

/** Can values of this type be compared with `==`? (Functions cannot.) */
function comparable(t: GType): boolean {
  switch (t.k) {
    case 'fn':
      return false
    case 'list':
      return comparable(t.elem)
    case 'tuple':
      return t.elems.every(comparable)
    case 'record':
      return t.fields.every((f) => comparable(f.type))
    default:
      return true
  }
}
function typeMentions(t: Type, typeName: string): boolean {
  const p = prune(t)
  if (p.kind === 'var') return false
  return p.name === typeName || p.args.some((a) => typeMentions(a, typeName))
}

// ---------------------------------------------------------------------------
// Value generation (size-bounded)
// ---------------------------------------------------------------------------

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz '

function genValue(t: GType, rng: () => number, size: number): GValue {
  switch (t.k) {
    case 'int':
      return { k: 'int', n: randInt(rng, -(size * 3 + 1), size * 3 + 1) }
    case 'float': {
      const r = rng()
      if (r < 0.2) return { k: 'float', n: 0 }
      return { k: 'float', n: Math.round((rng() * 2 - 1) * size * 4 * 100) / 100 }
    }
    case 'bool':
      return { k: 'bool', b: rng() < 0.5 }
    case 'string': {
      const len = randInt(rng, 0, Math.max(0, size))
      let s = ''
      for (let i = 0; i < len; i++) s += ALPHABET[randInt(rng, 0, ALPHABET.length - 1)]
      return { k: 'string', s }
    }
    case 'unit':
      return { k: 'unit' }
    case 'list': {
      const len = randInt(rng, 0, Math.max(0, Math.min(size, 8)))
      const items: GValue[] = []
      for (let i = 0; i < len; i++) items.push(genValue(t.elem, rng, Math.max(0, size - 1)))
      return { k: 'list', items, elem: t.elem }
    }
    case 'tuple':
      return { k: 'tuple', items: t.elems.map((e) => genValue(e, rng, size)) }
    case 'record':
      return {
        k: 'record',
        fields: t.fields.map((f) => ({ label: f.label, value: genValue(f.type, rng, size) })),
      }
    case 'data': {
      const variants = variantsOf(t.typeName, t.typeArgs, ctxOf())
      const base = variants.filter((v) => !v.argTypes.some((a) => mentions(a, t.typeName)))
      let pool: Variant[]
      if (size <= 0) {
        if (base.length === 0) throw new GenError(`${t.typeName} (no finite base case)`)
        pool = base
      } else {
        // bias toward base cases so values stay small but still recurse
        pool = base.length > 0 && rng() < 0.35 ? base : variants
      }
      const v = pool[randInt(rng, 0, pool.length - 1)]
      const args = v.argTypes.map((a) => genValue(a, rng, Math.max(0, size - 1)))
      return { k: 'data', name: v.name, args, type: t }
    }
    case 'fn': {
      const n = randInt(rng, 0, Math.min(size, 4))
      const entries: { key: GValue; val: GValue }[] = []
      for (let i = 0; i < n; i++) {
        entries.push({
          key: genValue(t.dom, rng, Math.max(1, size - 1)),
          val: genValue(t.cod, rng, Math.max(1, size - 1)),
        })
      }
      return { k: 'fn', entries, dflt: genValue(t.cod, rng, Math.max(1, size - 1)), dom: t.dom, cod: t.cod }
    }
  }
}

// A data GType needs the GenCtx to resolve variants; we stash it on a module
// slot for the duration of a run (set by `runProperties`). This keeps GType a
// plain serialisable shape while still allowing lazy ADT expansion.
let CURRENT_CTX: GenCtx | null = null
function ctxOf(): GenCtx {
  if (!CURRENT_CTX) throw new GenError('no generation context')
  return CURRENT_CTX
}

// ---------------------------------------------------------------------------
// Shrinking
// ---------------------------------------------------------------------------

function shrink(v: GValue): GValue[] {
  switch (v.k) {
    case 'int': {
      const out: GValue[] = []
      if (v.n !== 0) out.push({ k: 'int', n: 0 })
      const half = Math.trunc(v.n / 2)
      if (half !== v.n && half !== 0) out.push({ k: 'int', n: half })
      const step = v.n > 0 ? v.n - 1 : v.n + 1
      if (step !== v.n && Math.abs(step) < Math.abs(v.n)) out.push({ k: 'int', n: step })
      return out
    }
    case 'float': {
      const out: GValue[] = []
      if (v.n !== 0) out.push({ k: 'float', n: 0 })
      const tr = Math.trunc(v.n)
      if (tr !== v.n) out.push({ k: 'float', n: tr })
      const half = Math.round((v.n / 2) * 100) / 100
      if (half !== v.n && half !== 0) out.push({ k: 'float', n: half })
      return out
    }
    case 'bool':
      return v.b ? [{ k: 'bool', b: false }] : []
    case 'string': {
      const out: GValue[] = []
      if (v.s.length > 0) {
        out.push({ k: 'string', s: '' })
        out.push({ k: 'string', s: v.s.slice(0, Math.floor(v.s.length / 2)) })
        out.push({ k: 'string', s: v.s.slice(1) })
        out.push({ k: 'string', s: v.s.slice(0, -1) })
      }
      return out
    }
    case 'unit':
      return []
    case 'list': {
      const out: GValue[] = []
      const n = v.items.length
      if (n > 0) {
        out.push({ k: 'list', items: [], elem: v.elem })
        if (n > 2) {
          out.push({ k: 'list', items: v.items.slice(0, Math.floor(n / 2)), elem: v.elem })
          out.push({ k: 'list', items: v.items.slice(Math.floor(n / 2)), elem: v.elem })
        }
        // drop each single element
        for (let i = 0; i < n; i++) {
          out.push({ k: 'list', items: v.items.filter((_, j) => j !== i), elem: v.elem })
        }
        // shrink each element in place
        for (let i = 0; i < n; i++) {
          for (const s of shrink(v.items[i])) {
            const items = v.items.slice()
            items[i] = s
            out.push({ k: 'list', items, elem: v.elem })
          }
        }
      }
      return out
    }
    case 'tuple': {
      const out: GValue[] = []
      v.items.forEach((it, i) => {
        for (const s of shrink(it)) {
          const items = v.items.slice()
          items[i] = s
          out.push({ k: 'tuple', items })
        }
      })
      return out
    }
    case 'record': {
      const out: GValue[] = []
      v.fields.forEach((f, i) => {
        for (const s of shrink(f.value)) {
          const fields = v.fields.slice()
          fields[i] = { label: f.label, value: s }
          out.push({ k: 'record', fields })
        }
      })
      return out
    }
    case 'data': {
      const out: GValue[] = []
      // subterm shrink: replace the value with a same-typed argument (e.g. a subtree)
      for (const a of v.args) {
        if (a.k === 'data' && sameDataType(a.type, v.type)) out.push(a)
      }
      // shrink each argument, keeping the constructor
      v.args.forEach((a, i) => {
        for (const s of shrink(a)) {
          const args = v.args.slice()
          args[i] = s
          out.push({ k: 'data', name: v.name, args, type: v.type })
        }
      })
      return out
    }
    case 'fn': {
      const out: GValue[] = []
      // fewer table entries (simpler function)
      v.entries.forEach((_, i) => {
        out.push({ ...v, entries: v.entries.filter((_, j) => j !== i) })
      })
      // shrink the default, then each table value
      for (const d of shrink(v.dflt)) out.push({ ...v, dflt: d })
      v.entries.forEach((e, i) => {
        for (const s of shrink(e.val)) {
          const entries = v.entries.slice()
          entries[i] = { key: e.key, val: s }
          out.push({ ...v, entries })
        }
      })
      return out
    }
  }
}

function sameDataType(a: GType, b: GType): boolean {
  return a.k === 'data' && b.k === 'data' && a.typeName === b.typeName
}

// ---------------------------------------------------------------------------
// GValue → Expr / display string
// ---------------------------------------------------------------------------

function toExpr(v: GValue): Expr {
  switch (v.k) {
    case 'int':
      return { kind: 'int', value: v.n, span: SYNTH }
    case 'float':
      return { kind: 'float', value: v.n, span: SYNTH }
    case 'bool':
      return { kind: 'bool', value: v.b, span: SYNTH }
    case 'string':
      return { kind: 'str', value: v.s, span: SYNTH }
    case 'unit':
      return { kind: 'unit', span: SYNTH }
    case 'list':
      return { kind: 'list', elements: v.items.map(toExpr), span: SYNTH }
    case 'tuple':
      return { kind: 'tuple', elements: v.items.map(toExpr), span: SYNTH }
    case 'record':
      return {
        kind: 'record',
        fields: v.fields.map((f) => ({ label: f.label, value: toExpr(f.value) })),
        span: SYNTH,
      }
    case 'data': {
      let e: Expr = { kind: 'var', name: v.name, span: SYNTH }
      for (const a of v.args) e = { kind: 'app', fn: e, arg: toExpr(a), span: SYNTH }
      return e
    }
    case 'fn': {
      // fn __arg -> if __arg == k1 then v1 else … else dflt
      const param = '__arg'
      const argVar: Expr = { kind: 'var', name: param, span: SYNTH }
      let body = toExpr(v.dflt)
      for (let i = v.entries.length - 1; i >= 0; i--) {
        const e = v.entries[i]
        const cond: Expr = {
          kind: 'binop',
          op: '==',
          left: argVar,
          right: toExpr(e.key),
          span: SYNTH,
        }
        body = { kind: 'if', cond, then: toExpr(e.val), else: body, span: SYNTH }
      }
      return { kind: 'lambda', param, body, span: SYNTH }
    }
  }
}

export function gvalueToString(v: GValue): string {
  switch (v.k) {
    case 'int':
      return String(v.n)
    case 'float':
      return Number.isInteger(v.n) ? v.n.toFixed(1) : String(v.n)
    case 'bool':
      return v.b ? 'true' : 'false'
    case 'string':
      return JSON.stringify(v.s)
    case 'unit':
      return '()'
    case 'list':
      return `[${v.items.map(gvalueToString).join(', ')}]`
    case 'tuple':
      return `(${v.items.map(gvalueToString).join(', ')})`
    case 'record':
      return `{ ${v.fields.map((f) => `${f.label} = ${gvalueToString(f.value)}`).join(', ')} }`
    case 'data': {
      if (v.args.length === 0) return v.name
      const parts = v.args.map((a) => {
        const s = gvalueToString(a)
        return a.k === 'data' && a.args.length > 0 ? `(${s})` : s
      })
      return `${v.name} ${parts.join(' ')}`
    }
    case 'fn': {
      const rows = v.entries.map((e) => `${gvalueToString(e.key)}→${gvalueToString(e.val)}`)
      rows.push(`_→${gvalueToString(v.dflt)}`)
      return `{${rows.join(', ')}}`
    }
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface PropOutcome {
  name: string
  status: 'pass' | 'fail' | 'skip' | 'error'
  /** number of cases executed (until failure, or the full run on success) */
  tests: number
  signature: string
  argTypes: string[]
  counterexample?: string[]
  shrinks?: number
  /** runtime error raised by the minimal counterexample, if any */
  runtimeError?: string
  /** reason a property was skipped or errored */
  message?: string
}

export interface PropReport {
  outcomes: PropOutcome[]
  /** a top-level lex/parse/type error that prevented any testing */
  error: string | null
  total: number
  passed: number
}

export interface PropOptions {
  runs?: number
  seed?: number
  maxSize?: number
}

/** Rebuild a let/type/class/instance prefix chain with a new terminal body. */
function withBody(ast: Expr, body: Expr): Expr {
  switch (ast.kind) {
    case 'let':
    case 'letrec':
    case 'typedecl':
    case 'classdecl':
    case 'instancedecl':
      return { ...ast, body: withBody(ast.body, body) }
    default:
      return body
  }
}

interface TopBinding {
  name: string
  scheme: Scheme | undefined
}

function collectTopLevel(ast: Expr, inferred: InferResult): TopBinding[] {
  const out: TopBinding[] = []
  let node: Expr = ast
  for (;;) {
    if (node.kind === 'let') {
      out.push({ name: node.name, scheme: inferred.bindingSchemes.get(node) })
      node = node.body
    } else if (node.kind === 'letrec') {
      for (const b of node.bindings) {
        out.push({ name: b.name, scheme: inferred.bindingSchemes.get(b.value) })
      }
      node = node.body
    } else if (
      node.kind === 'typedecl' ||
      node.kind === 'classdecl' ||
      node.kind === 'instancedecl'
    ) {
      node = node.body
    } else {
      break
    }
  }
  return out
}

function appOf(name: string, args: GValue[]): Expr {
  let e: Expr = { kind: 'var', name, span: SYNTH }
  for (const a of args) e = { kind: 'app', fn: e, arg: toExpr(a), span: SYNTH }
  return e
}

/** Did a single argument tuple make the property fail (return false or crash)? */
function failsTuple(
  ast: Expr,
  name: string,
  args: GValue[],
): { failed: boolean; error: string | null } {
  const program = withBody(ast, appOf(name, args))
  const { result, error } = executeProgram(program)
  if (error) return { failed: true, error }
  const failed = !(result !== null && result.tag === 'bool' && result.b)
  return { failed, error: null }
}

function minimize(
  ast: Expr,
  name: string,
  seed: GValue[],
): { args: GValue[]; shrinks: number } {
  let current = seed
  let shrinks = 0
  const CAP = 2000
  outer: while (shrinks < CAP) {
    // generate candidate tuples by shrinking one component at a time
    for (let i = 0; i < current.length; i++) {
      for (const s of shrink(current[i])) {
        const cand = current.slice()
        cand[i] = s
        if (failsTuple(ast, name, cand).failed) {
          current = cand
          shrinks++
          continue outer
        }
      }
    }
    break
  }
  return { args: current, shrinks }
}

function sizeFor(i: number, runs: number, maxSize: number): number {
  return 1 + Math.floor((i / Math.max(1, runs)) * maxSize)
}

function checkProperty(
  ast: Expr,
  b: TopBinding,
  ctx: GenCtx,
  rng: () => number,
  runs: number,
  maxSize: number,
): PropOutcome {
  const signature = b.scheme ? schemeToString(b.scheme) : '?'
  const base: PropOutcome = { name: b.name, status: 'skip', tests: 0, signature, argTypes: [] }
  if (!b.scheme) return { ...base, message: 'no inferred type' }

  // monomorphise: default all quantified variables to Int
  const sub = new Map<number, Type>()
  for (const id of b.scheme.vars) sub.set(id, tInt)
  const { args: argTys, result } = peelArrows(substType(b.scheme.type, sub))

  const rp = prune(result)
  if (!(rp.kind === 'con' && rp.name === 'Bool')) {
    return { ...base, message: 'a property must return Bool' }
  }
  if (argTys.length === 0) {
    return { ...base, message: 'a property must take at least one argument' }
  }

  let gtypes: GType[]
  try {
    gtypes = argTys.map((t) => toGType(t, ctx))
  } catch (e) {
    return { ...base, message: `cannot generate ${e instanceof GenError ? e.message : 'arguments'}` }
  }
  const argTypeStrings = gtypes.map(describeGType)

  // generate inputs
  const cases: GValue[][] = []
  try {
    for (let i = 0; i < runs; i++) {
      const size = sizeFor(i, runs, maxSize)
      cases.push(gtypes.map((t) => genValue(t, rng, size)))
    }
  } catch (e) {
    return {
      ...base,
      status: 'skip',
      argTypes: argTypeStrings,
      message: `cannot generate ${e instanceof GenError ? e.message : 'arguments'}`,
    }
  }

  // fast path: batch every case into one VM run and read back a list of Bools
  const batchBody: Expr = {
    kind: 'list',
    elements: cases.map((args) => appOf(b.name, args)),
    span: SYNTH,
  }
  const batch = executeProgram(withBody(ast, batchBody))

  let failIndex = -1
  if (batch.error || batch.result === null) {
    // a case crashed; find the first culprit case by linear search
    for (let i = 0; i < cases.length; i++) {
      if (failsTuple(ast, b.name, cases[i]).failed) {
        failIndex = i
        break
      }
    }
    if (failIndex === -1) {
      return { ...base, status: 'error', argTypes: argTypeStrings, message: batch.error ?? 'run failed' }
    }
  } else {
    const results = listToArray(batch.result)
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (!(r.tag === 'bool' && r.b)) {
        failIndex = i
        break
      }
    }
  }

  if (failIndex === -1) {
    return { name: b.name, status: 'pass', tests: runs, signature, argTypes: argTypeStrings }
  }

  // shrink the failing case to a minimal counterexample
  const { args: minimal, shrinks } = minimize(ast, b.name, cases[failIndex])
  const { error } = failsTuple(ast, b.name, minimal)
  return {
    name: b.name,
    status: 'fail',
    tests: failIndex + 1,
    signature,
    argTypes: argTypeStrings,
    counterexample: minimal.map(gvalueToString),
    shrinks,
    runtimeError: error ?? undefined,
  }
}

function describeGType(t: GType): string {
  switch (t.k) {
    case 'int':
      return 'Int'
    case 'float':
      return 'Float'
    case 'bool':
      return 'Bool'
    case 'string':
      return 'String'
    case 'unit':
      return 'Unit'
    case 'list':
      return `List ${describeGType(t.elem)}`
    case 'tuple':
      return `(${t.elems.map(describeGType).join(', ')})`
    case 'record':
      return `{ ${t.fields.map((f) => `${f.label}: ${describeGType(f.type)}`).join(', ')} }`
    case 'data':
      return t.typeName
    case 'fn':
      return `(${describeGType(t.dom)} -> ${describeGType(t.cod)})`
  }
}

/**
 * Discover every `prop_*` binding in `source` and test it. A property is any
 * top-level binding whose name starts with `prop` and whose type is
 * `arg1 -> … -> Bool`. Deterministic given the same `seed`.
 */
export function runProperties(source: string, opts: PropOptions = {}): PropReport {
  const runs = opts.runs ?? 100
  const maxSize = opts.maxSize ?? 12
  const seed = opts.seed ?? 0x5eed

  const base = runPipeline(source, { execute: false, optimize: false })
  if (base.error) {
    return { outcomes: [], error: `${base.error.stage}: ${base.error.message}`, total: 0, passed: 0 }
  }
  if (!base.ast || !base.typeResult) {
    return { outcomes: [], error: 'could not analyse the program', total: 0, passed: 0 }
  }

  const ctx: GenCtx = {
    ctorInfo: base.typeResult.ctorInfo,
    typeCtors: base.typeResult.typeCtors,
  }
  CURRENT_CTX = ctx
  try {
    const bindings = collectTopLevel(base.ast, base.typeResult)
    const props = bindings.filter((b) => /^prop/i.test(b.name))
    const rng = makeRng(seed)
    const outcomes = props.map((b) => checkProperty(base.ast!, b, ctx, rng, runs, maxSize))
    const passed = outcomes.filter((o) => o.status === 'pass').length
    return { outcomes, error: null, total: outcomes.length, passed }
  } finally {
    CURRENT_CTX = null
  }
}
