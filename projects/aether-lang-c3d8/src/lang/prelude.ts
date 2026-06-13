// Aether — prelude
//
// Two layers of "standard library":
//   1. Primitives — implemented in TypeScript (I/O, list deconstruction, float
//      math, and the side-effecting turtle graphics). Each has a fixed type
//      scheme (for inference) and a runtime native value (for the VM).
//   2. Library — higher-order functions (map, filter, fold, …) written *in
//      Aether itself* on top of the primitives, compiled into every program.

import type { Scheme, Type, TVar } from './types.ts'
import { freeVars, freshVar, tArrow, tBool, tFloat, tInt, tList, tString, tUnit } from './types.ts'
import type { NativeFn, Value } from './values.ts'
import {
  AetherRuntimeError,
  UNIT,
  vbool,
  vfloat,
  vint,
  vstr,
  valueToString,
} from './values.ts'

function mono(t: Type): Scheme {
  return { vars: [], type: t }
}
function poly(build: (tv: () => TVar) => Type): Scheme {
  const t = build(freshVar)
  return { vars: [...freeVars(t)], type: t }
}

function num(v: Value): number {
  if (v.tag === 'int' || v.tag === 'float') return v.n
  throw new AetherRuntimeError(`expected a number, got ${v.tag}`)
}

interface Primitive {
  name: string
  arity: number
  scheme: Scheme
  fn: NativeFn
}

const PRIMITIVES: Primitive[] = [
  {
    name: 'print',
    arity: 1,
    scheme: poly((tv) => tArrow(tv(), tUnit)),
    fn: (args, ctx) => {
      const a = args[0]
      ctx.print(a.tag === 'str' ? a.s : valueToString(a))
      return UNIT
    },
  },
  {
    name: 'show',
    arity: 1,
    scheme: poly((tv) => tArrow(tv(), tString)),
    fn: (args) => vstr(valueToString(args[0])),
  },
  {
    name: 'head',
    arity: 1,
    scheme: poly((tv) => {
      const a = tv()
      return tArrow(tList(a), a)
    }),
    fn: (args) => {
      const v = args[0]
      if (v.tag === 'cons') return v.head
      throw new AetherRuntimeError('head: empty list')
    },
  },
  {
    name: 'tail',
    arity: 1,
    scheme: poly((tv) => {
      const a = tv()
      return tArrow(tList(a), tList(a))
    }),
    fn: (args) => {
      const v = args[0]
      if (v.tag === 'cons') return v.tail
      throw new AetherRuntimeError('tail: empty list')
    },
  },
  {
    name: 'empty',
    arity: 1,
    scheme: poly((tv) => tArrow(tList(tv()), tBool)),
    fn: (args) => vbool(args[0].tag === 'nil'),
  },
  { name: 'sqrt', arity: 1, scheme: mono(tArrow(tFloat, tFloat)), fn: (a) => vfloat(Math.sqrt(num(a[0]))) },
  { name: 'sin', arity: 1, scheme: mono(tArrow(tFloat, tFloat)), fn: (a) => vfloat(Math.sin(num(a[0]))) },
  { name: 'cos', arity: 1, scheme: mono(tArrow(tFloat, tFloat)), fn: (a) => vfloat(Math.cos(num(a[0]))) },
  { name: 'floor', arity: 1, scheme: mono(tArrow(tFloat, tInt)), fn: (a) => vint(Math.floor(num(a[0]))) },
  { name: 'toFloat', arity: 1, scheme: mono(tArrow(tInt, tFloat)), fn: (a) => vfloat(num(a[0])) },
  // turtle graphics — side effects emitted to the VM's effect log
  { name: 'forward', arity: 1, scheme: mono(tArrow(tFloat, tUnit)), fn: (a, c) => emitR(c, { op: 'forward', dist: num(a[0]) }) },
  { name: 'back', arity: 1, scheme: mono(tArrow(tFloat, tUnit)), fn: (a, c) => emitR(c, { op: 'back', dist: num(a[0]) }) },
  { name: 'turn', arity: 1, scheme: mono(tArrow(tFloat, tUnit)), fn: (a, c) => emitR(c, { op: 'turn', deg: num(a[0]) }) },
  { name: 'width', arity: 1, scheme: mono(tArrow(tFloat, tUnit)), fn: (a, c) => emitR(c, { op: 'width', w: num(a[0]) }) },
  { name: 'penUp', arity: 1, scheme: mono(tArrow(tUnit, tUnit)), fn: (_a, c) => emitR(c, { op: 'penUp' }) },
  { name: 'penDown', arity: 1, scheme: mono(tArrow(tUnit, tUnit)), fn: (_a, c) => emitR(c, { op: 'penDown' }) },
  { name: 'push', arity: 1, scheme: mono(tArrow(tUnit, tUnit)), fn: (_a, c) => emitR(c, { op: 'push' }) },
  { name: 'pop', arity: 1, scheme: mono(tArrow(tUnit, tUnit)), fn: (_a, c) => emitR(c, { op: 'pop' }) },
  { name: 'clear', arity: 1, scheme: mono(tArrow(tUnit, tUnit)), fn: (_a, c) => emitR(c, { op: 'clear' }) },
  {
    name: 'color',
    arity: 3,
    scheme: mono(tArrow(tInt, tArrow(tInt, tArrow(tInt, tUnit)))),
    fn: (a, c) => emitR(c, { op: 'color', r: num(a[0]) | 0, g: num(a[1]) | 0, b: num(a[2]) | 0 }),
  },
]

function emitR(ctx: Parameters<NativeFn>[1], cmd: Parameters<Parameters<NativeFn>[1]['emit']>[0]): Value {
  ctx.emit(cmd)
  return UNIT
}

// `pi` is a value, not a function.
const PI_VALUE: Value = vfloat(Math.PI)

export interface GlobalEntry {
  name: string
  scheme: Scheme
  value: Value
}

export const GLOBALS: GlobalEntry[] = [
  ...PRIMITIVES.map((p) => ({
    name: p.name,
    scheme: p.scheme,
    value: { tag: 'native', name: p.name, arity: p.arity, applied: [], fn: p.fn } as Value,
  })),
  { name: 'pi', scheme: mono(tFloat), value: PI_VALUE },
]

export const GLOBAL_INDEX: Map<string, number> = new Map(GLOBALS.map((g, i) => [g.name, i]))

// Library functions written in Aether, layered in lexical order so each may use
// the ones above it. Compiled into every program; the editor's AST/token views
// show only the user's own source.
export interface PreludeDef {
  name: string
  recursive: boolean
  src: string
  doc: string
}

export const PRELUDE_DEFS: PreludeDef[] = [
  {
    name: 'map',
    recursive: true,
    doc: 'map f xs — apply f to every element',
    src: 'fn f xs -> if empty xs then [] else f (head xs) :: map f (tail xs)',
  },
  {
    name: 'filter',
    recursive: true,
    doc: 'filter p xs — keep elements where p is true',
    src: 'fn p xs -> if empty xs then [] else if p (head xs) then head xs :: filter p (tail xs) else filter p (tail xs)',
  },
  {
    name: 'foldl',
    recursive: true,
    doc: 'foldl f acc xs — left fold',
    src: 'fn f acc xs -> if empty xs then acc else foldl f (f acc (head xs)) (tail xs)',
  },
  {
    name: 'foldr',
    recursive: true,
    doc: 'foldr f acc xs — right fold',
    src: 'fn f acc xs -> if empty xs then acc else f (head xs) (foldr f acc (tail xs))',
  },
  {
    name: 'length',
    recursive: true,
    doc: 'length xs — number of elements',
    src: 'fn xs -> if empty xs then 0 else 1 + length (tail xs)',
  },
  {
    name: 'append',
    recursive: true,
    doc: 'append xs ys — concatenate two lists',
    src: 'fn xs ys -> if empty xs then ys else head xs :: append (tail xs) ys',
  },
  {
    name: 'reverse',
    recursive: false,
    doc: 'reverse xs',
    src: 'foldl (fn acc x -> x :: acc) []',
  },
  {
    name: 'sum',
    recursive: false,
    doc: 'sum xs — total of an Int list',
    src: 'foldl (fn a x -> a + x) 0',
  },
  {
    name: 'range',
    recursive: true,
    doc: 'range a b — the ints [a, b)',
    src: 'fn a b -> if a >= b then [] else a :: range (a + 1) b',
  },
]
