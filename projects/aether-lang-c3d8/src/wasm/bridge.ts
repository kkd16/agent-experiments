// Aether — WebAssembly ⇄ JS value bridge
//
// The host side of the WASM backend. It knows the heap layout (`layout.ts`) and
// can read a pointer into the VM's `Value` model (`decode`) and write a `Value`
// back into linear memory (`encode`). On top of that it provides the module's
// imports — the inherently host-side operations the emitted code delegates to:
//
//   • `print` / `show` formatting              → reuse `valueToString`
//   • structural / lexicographic comparison    → reuse `compareValues`
//   • float math, string ops, the turtle       → reuse the VM's own native `fn`s
//
// Because every import decodes WASM cells into the *exact* `Value`s the VM uses
// and runs the *exact* native implementation, the WASM backend's result, output
// and drawing match the bytecode VM byte-for-byte by construction.

import { GLOBALS } from '../lang/prelude.ts'
import type { TurtleCmd, Value } from '../lang/values.ts'
import { AetherRuntimeError, NIL, UNIT, compareValues, listFromArray } from '../lang/values.ts'
import { OFF, SIZE, TAG, dataSize, recordSize, tupleSize } from './layout.ts'

/** The native (function) builtins, in a stable order shared with codegen. */
export const NATIVE_GLOBALS = GLOBALS.filter((g) => g.value.tag === 'native')

/** Mutable handle filled in after instantiation but before `main` runs. */
export interface WasmCtx {
  memory: WebAssembly.Memory | null
  alloc: ((n: number) => number) | null
}

export interface Bridge {
  ctx: WasmCtx
  imports: WebAssembly.Imports
  output: string[]
  effects: TurtleCmd[]
  decode: (ptr: number) => Value
  encode: (v: Value) => number
  /** the runtime string pool (seeded with codegen's literals) */
  strings: string[]
  error: { message: string } | null
}

export interface BridgeTables {
  /** string literals, indexed by the id codegen baked into the module */
  stringLiterals: string[]
  /** constructor names, indexed by name id */
  ctorNames: string[]
  /** record labels, indexed by label id */
  labels: string[]
}

export function makeBridge(tables: BridgeTables): Bridge {
  const ctx: WasmCtx = { memory: null, alloc: null }
  const output: string[] = []
  const effects: TurtleCmd[] = []
  const strings: string[] = [...tables.stringLiterals]
  const labelId = new Map(tables.labels.map((l, i) => [l, i]))
  const bridge: Bridge = {
    ctx,
    output,
    effects,
    strings,
    error: null,
    imports: {},
    decode: () => UNIT,
    encode: () => 0,
  }

  // — low-level memory access (re-grab the buffer; it detaches on memory.grow) —
  const view = (): DataView => new DataView(ctx.memory!.buffer)
  const i32 = (ptr: number): number => view().getInt32(ptr, true)
  const f64 = (ptr: number): number => view().getFloat64(ptr, true)
  const setI32 = (ptr: number, v: number): void => view().setInt32(ptr, v | 0, true)
  const setF64 = (ptr: number, v: number): void => view().setFloat64(ptr, v, true)

  const internStr = (s: string): number => {
    const id = strings.length
    strings.push(s)
    return id
  }

  // — decode: pointer → Value —
  const decode = (ptr: number): Value => {
    const tag = i32(ptr + OFF.TAG)
    switch (tag) {
      case TAG.INT:
        return { tag: 'int', n: i32(ptr + OFF.INT_VAL) }
      case TAG.FLOAT:
        return { tag: 'float', n: f64(ptr + OFF.FLOAT_VAL) }
      case TAG.BOOL:
        return { tag: 'bool', b: i32(ptr + OFF.BOOL_VAL) !== 0 }
      case TAG.UNIT:
        return UNIT
      case TAG.NIL:
        return NIL
      case TAG.STR:
        return { tag: 'str', s: strings[i32(ptr + OFF.STR_ID)] ?? '' }
      case TAG.CONS: {
        const items: Value[] = []
        let cur = ptr
        while (i32(cur + OFF.TAG) === TAG.CONS) {
          items.push(decode(i32(cur + OFF.CONS_HEAD)))
          cur = i32(cur + OFF.CONS_TAIL)
        }
        return listFromArray(items)
      }
      case TAG.TUPLE: {
        const len = i32(ptr + OFF.TUPLE_LEN)
        const items: Value[] = []
        for (let i = 0; i < len; i++) items.push(decode(i32(ptr + OFF.TUPLE_ITEMS + 4 * i)))
        return { tag: 'tuple', items }
      }
      case TAG.DATA: {
        const name = tables.ctorNames[i32(ptr + OFF.DATA_NAME)]
        const argc = i32(ptr + OFF.DATA_ARGC)
        const args: Value[] = []
        for (let i = 0; i < argc; i++) args.push(decode(i32(ptr + OFF.DATA_ARGS + 4 * i)))
        return { tag: 'data', name, args }
      }
      case TAG.RECORD: {
        const count = i32(ptr + OFF.RECORD_COUNT)
        const fields: Record<string, Value> = {}
        for (let i = 0; i < count; i++) {
          const base = ptr + OFF.RECORD_PAIRS + 8 * i
          fields[tables.labels[i32(base)]] = decode(i32(base + 4))
        }
        return { tag: 'record', fields }
      }
      case TAG.CTOR:
        return { tag: 'ctor', name: tables.ctorNames[i32(ptr + OFF.PAP_ID)], arity: i32(ptr + OFF.PAP_ARITY), args: [] }
      case TAG.NATIVE:
        return { tag: 'native', name: '<native>', arity: i32(ptr + OFF.PAP_ARITY), applied: [], fn: () => UNIT }
      case TAG.CLOSURE:
        return { tag: 'closure', proto: { name: '<wasm>' } as never, upvalues: [] }
      default:
        throw new AetherRuntimeError(`bad heap tag ${tag} @ ${ptr}`)
    }
  }

  // — encode: Value → freshly-allocated pointer —
  const encode = (v: Value): number => {
    const alloc = ctx.alloc!
    switch (v.tag) {
      case 'int': {
        const p = alloc(SIZE.INT)
        setI32(p + OFF.TAG, TAG.INT)
        setI32(p + OFF.INT_VAL, v.n)
        return p
      }
      case 'float': {
        const p = alloc(SIZE.FLOAT)
        setI32(p + OFF.TAG, TAG.FLOAT)
        setF64(p + OFF.FLOAT_VAL, v.n)
        return p
      }
      case 'bool': {
        const p = alloc(SIZE.BOOL)
        setI32(p + OFF.TAG, TAG.BOOL)
        setI32(p + OFF.BOOL_VAL, v.b ? 1 : 0)
        return p
      }
      case 'unit': {
        const p = alloc(SIZE.UNIT)
        setI32(p + OFF.TAG, TAG.UNIT)
        return p
      }
      case 'nil': {
        const p = alloc(SIZE.NIL)
        setI32(p + OFF.TAG, TAG.NIL)
        return p
      }
      case 'str': {
        const p = alloc(SIZE.STR)
        setI32(p + OFF.TAG, TAG.STR)
        setI32(p + OFF.STR_ID, internStr(v.s))
        return p
      }
      case 'cons': {
        const head = encode(v.head)
        const tail = encode(v.tail)
        const p = alloc(SIZE.CONS)
        setI32(p + OFF.TAG, TAG.CONS)
        setI32(p + OFF.CONS_HEAD, head)
        setI32(p + OFF.CONS_TAIL, tail)
        return p
      }
      case 'tuple': {
        const items = v.items.map(encode)
        const p = alloc(tupleSize(items.length))
        setI32(p + OFF.TAG, TAG.TUPLE)
        setI32(p + OFF.TUPLE_LEN, items.length)
        items.forEach((it, i) => setI32(p + OFF.TUPLE_ITEMS + 4 * i, it))
        return p
      }
      case 'data': {
        const args = v.args.map(encode)
        const name = tables.ctorNames.indexOf(v.name)
        const p = alloc(dataSize(args.length))
        setI32(p + OFF.TAG, TAG.DATA)
        setI32(p + OFF.DATA_NAME, name)
        setI32(p + OFF.DATA_ARGC, args.length)
        args.forEach((a, i) => setI32(p + OFF.DATA_ARGS + 4 * i, a))
        return p
      }
      case 'record': {
        const entries = Object.entries(v.fields).map(([k, val]) => [labelId.get(k) ?? -1, encode(val)] as const)
        const p = alloc(recordSize(entries.length))
        setI32(p + OFF.TAG, TAG.RECORD)
        setI32(p + OFF.RECORD_COUNT, entries.length)
        entries.forEach(([lid, val], i) => {
          setI32(p + OFF.RECORD_PAIRS + 8 * i, lid)
          setI32(p + OFF.RECORD_PAIRS + 8 * i + 4, val)
        })
        return p
      }
      default:
        throw new AetherRuntimeError(`cannot encode a ${v.tag} value`)
    }
  }

  bridge.decode = decode
  bridge.encode = encode

  // — imports —
  const nativeCtx = {
    print: (s: string) => output.push(s),
    emit: (cmd: TurtleCmd) => effects.push(cmd),
  }

  // A saturated native partial-application cell: read its id + args, run the
  // VM's own native `fn`, encode the result.
  const callNative = (cellPtr: number): number => {
    const id = i32(cellPtr + OFF.PAP_ID)
    const arity = i32(cellPtr + OFF.PAP_ARITY)
    const args: Value[] = []
    for (let i = 0; i < arity; i++) args.push(decode(i32(cellPtr + OFF.PAP_ARGS + 4 * i)))
    const g = NATIVE_GLOBALS[id]
    if (!g || g.value.tag !== 'native') throw new AetherRuntimeError(`bad native id ${id}`)
    return encode(g.value.fn(args, nativeCtx))
  }

  const valueCmp = (a: number, b: number): number => compareValues(decode(a), decode(b))

  const strConcat = (a: number, b: number): number => {
    const p = ctx.alloc!(SIZE.STR)
    setI32(p + OFF.TAG, TAG.STR)
    setI32(p + OFF.STR_ID, internStr(strings[a] + strings[b]))
    return p
  }

  // `print`/`show` are themselves native globals, dispatched through `callNative`;
  // the only imports are the three host services WASM cannot do itself.
  bridge.imports = {
    env: { callNative, valueCmp, strConcat },
  }

  return bridge
}
