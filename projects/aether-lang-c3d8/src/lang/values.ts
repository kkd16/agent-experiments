// Aether — runtime values & effects
//
// The values the VM pushes around at runtime, plus structural equality/order
// used by the comparison opcodes, and the side-effecting "turtle" commands that
// drawing primitives emit. Kept separate from the VM so the prelude and the
// bytecode module can share these types without import cycles.

import type { FnProto } from './bytecode.ts'

export type Value =
  | { tag: 'int'; n: number }
  | { tag: 'float'; n: number }
  | { tag: 'bool'; b: boolean }
  | { tag: 'str'; s: string }
  | { tag: 'unit' }
  | { tag: 'nil' }
  | { tag: 'cons'; head: Value; tail: Value }
  | { tag: 'tuple'; items: Value[] }
  | { tag: 'closure'; proto: FnProto; upvalues: Upvalue[] }
  | { tag: 'native'; name: string; arity: number; applied: Value[]; fn: NativeFn }
  // a fully-applied data constructor (the runtime form of an ADT value)
  | { tag: 'data'; name: string; args: Value[] }
  // a partially-applied data constructor (still awaiting arguments)
  | { tag: 'ctor'; name: string; arity: number; args: Value[] }

/**
 * A captured variable. While "open" it points at a live VM stack slot; when the
 * slot is reclaimed the value is copied into `closed` and `location` is nulled.
 */
export class Upvalue {
  location: number | null
  closed: Value = UNIT
  constructor(location: number) {
    this.location = location
  }
}

export type NativeFn = (args: Value[], ctx: NativeCtx) => Value

export interface NativeCtx {
  print: (s: string) => void
  emit: (cmd: TurtleCmd) => void
}

export type TurtleCmd =
  | { op: 'forward'; dist: number }
  | { op: 'back'; dist: number }
  | { op: 'turn'; deg: number }
  | { op: 'penUp' }
  | { op: 'penDown' }
  | { op: 'push' }
  | { op: 'pop' }
  | { op: 'color'; r: number; g: number; b: number }
  | { op: 'width'; w: number }
  | { op: 'clear' }

// Singletons to avoid churn.
export const UNIT: Value = { tag: 'unit' }
export const NIL: Value = { tag: 'nil' }
export const TRUE: Value = { tag: 'bool', b: true }
export const FALSE: Value = { tag: 'bool', b: false }

export function vint(n: number): Value {
  return { tag: 'int', n: n | 0 }
}
export function vfloat(n: number): Value {
  return { tag: 'float', n }
}
export function vbool(b: boolean): Value {
  return b ? TRUE : FALSE
}
export function vstr(s: string): Value {
  return { tag: 'str', s }
}

export function listFromArray(items: Value[]): Value {
  let acc: Value = NIL
  for (let i = items.length - 1; i >= 0; i--) acc = { tag: 'cons', head: items[i], tail: acc }
  return acc
}

export function listToArray(v: Value): Value[] {
  const out: Value[] = []
  let cur = v
  while (cur.tag === 'cons') {
    out.push(cur.head)
    cur = cur.tail
  }
  return out
}

export class AetherRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AetherRuntimeError'
  }
}

/** Structural ordering: <0, 0, >0. Throws on functions. */
export function compareValues(a: Value, b: Value): number {
  if (a.tag !== b.tag) {
    // allow int/float cross comparison
    if ((a.tag === 'int' || a.tag === 'float') && (b.tag === 'int' || b.tag === 'float')) {
      return Math.sign(numOf(a) - numOf(b))
    }
    throw new AetherRuntimeError(`cannot compare ${a.tag} with ${b.tag}`)
  }
  switch (a.tag) {
    case 'int':
    case 'float':
      return Math.sign(a.n - (b as { n: number }).n)
    case 'bool':
      return (a.b ? 1 : 0) - ((b as { b: boolean }).b ? 1 : 0)
    case 'str':
      return a.s < (b as { s: string }).s ? -1 : a.s > (b as { s: string }).s ? 1 : 0
    case 'unit':
    case 'nil':
      return 0
    case 'cons': {
      let x: Value = a
      let y: Value = b
      while (x.tag === 'cons' && y.tag === 'cons') {
        const c = compareValues(x.head, y.head)
        if (c !== 0) return c
        x = x.tail
        y = y.tail
      }
      return (x.tag === 'cons' ? 1 : 0) - (y.tag === 'cons' ? 1 : 0)
    }
    case 'tuple': {
      const bs = (b as { items: Value[] }).items
      const n = Math.min(a.items.length, bs.length)
      for (let i = 0; i < n; i++) {
        const c = compareValues(a.items[i], bs[i])
        if (c !== 0) return c
      }
      return a.items.length - bs.length
    }
    case 'data': {
      const bd = b as { name: string; args: Value[] }
      if (a.name !== bd.name) return a.name < bd.name ? -1 : 1
      const n = Math.min(a.args.length, bd.args.length)
      for (let i = 0; i < n; i++) {
        const c = compareValues(a.args[i], bd.args[i])
        if (c !== 0) return c
      }
      return a.args.length - bd.args.length
    }
    default:
      throw new AetherRuntimeError('cannot compare functions')
  }
}

function numOf(v: Value): number {
  if (v.tag === 'int' || v.tag === 'float') return v.n
  throw new AetherRuntimeError(`expected a number, got ${v.tag}`)
}

export function valuesEqual(a: Value, b: Value): boolean {
  return compareValues(a, b) === 0
}

/** Render a value to source-like text for output panes. */
export function valueToString(v: Value): string {
  switch (v.tag) {
    case 'int':
      return String(v.n)
    case 'float':
      return formatFloat(v.n)
    case 'bool':
      return v.b ? 'true' : 'false'
    case 'str':
      return JSON.stringify(v.s)
    case 'unit':
      return '()'
    case 'nil':
      return '[]'
    case 'cons':
      return `[${listToArray(v).map(valueToString).join(', ')}]`
    case 'tuple':
      return `(${v.items.map(valueToString).join(', ')})`
    case 'closure':
      return `<fn ${v.proto.name}>`
    case 'native':
      return `<builtin ${v.name}>`
    case 'ctor':
      return `<ctor ${v.name}>`
    case 'data': {
      if (v.args.length === 0) return v.name
      const parts = v.args.map((a) => {
        const s = valueToString(a)
        const needsParen =
          (a.tag === 'data' && a.args.length > 0) || a.tag === 'ctor'
        return needsParen ? `(${s})` : s
      })
      return `${v.name} ${parts.join(' ')}`
    }
  }
}

function formatFloat(n: number): string {
  if (Number.isInteger(n)) return n.toFixed(1)
  return String(n)
}
