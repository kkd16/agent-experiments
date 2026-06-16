// Aether — WebAssembly binary encoder
//
// A from-scratch encoder for the WebAssembly *binary* format (a `.wasm` module),
// with no external libraries (`wabt`/`binaryen`/parser-generators are all
// forbidden by the project and unnecessary). It is the substrate of Aether's
// third compilation target: `codegen.ts` builds function bodies with the `Code`
// instruction builder below and assembles them into a `Module`, which serialises
// to bytes a real WebAssembly engine instantiates.
//
// The format is the canonical WebAssembly 1.0 module: a magic + version header
// followed by a fixed sequence of sections (type, import, function, table,
// memory, global, export, start, element, code). Every vector is length-prefixed
// and integers are LEB128. References:
//   https://webassembly.github.io/spec/core/binary/index.html

// ---------------------------------------------------------------------------
// Value & block types
// ---------------------------------------------------------------------------

export const I32 = 0x7f
export const I64 = 0x7e
export const F32 = 0x7d
export const F64 = 0x7c
export type ValType = number

/** A block's result type: empty (no value) or a single value type. */
export const EMPTY_BLOCK = 0x40

// ---------------------------------------------------------------------------
// LEB128 + primitive writers
// ---------------------------------------------------------------------------

/** Unsigned LEB128. */
export function uleb(n: number): number[] {
  const out: number[] = []
  let v = n >>> 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v !== 0) byte |= 0x80
    out.push(byte)
  } while (v !== 0)
  return out
}

/** Signed LEB128. */
export function sleb(value: number): number[] {
  const out: number[] = []
  let more = true
  let n = value
  while (more) {
    let byte = n & 0x7f
    // arithmetic shift keeps the sign
    n >>= 7
    const signBit = byte & 0x40
    if ((n === 0 && signBit === 0) || (n === -1 && signBit !== 0)) {
      more = false
    } else {
      byte |= 0x80
    }
    out.push(byte)
  }
  return out
}

/** IEEE-754 double, little-endian (8 bytes). */
export function f64Bytes(x: number): number[] {
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, x, true)
  return Array.from(new Uint8Array(buf))
}

/** A UTF-8, length-prefixed name (WebAssembly `name`). */
export function encodeName(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s))
  return [...uleb(bytes.length), ...bytes]
}

/** A length-prefixed vector of already-encoded items. */
function vec(items: number[][]): number[] {
  const out = uleb(items.length)
  for (const it of items) out.push(...it)
  return out
}

// ---------------------------------------------------------------------------
// Instruction builder
// ---------------------------------------------------------------------------

/**
 * A growable byte buffer with one method per WebAssembly instruction we emit.
 * Methods return `this` so bodies can be written fluently. Memory accesses take
 * a byte offset; alignment is fixed to the natural log2 (i32 ⇒ 2, f64 ⇒ 3).
 */
export class Code {
  bytes: number[] = []

  private op(...b: number[]): this {
    for (const x of b) this.bytes.push(x)
    return this
  }

  // — constants —
  i32_const(n: number): this {
    return this.op(0x41).put(sleb(n))
  }
  f64_const(x: number): this {
    return this.op(0x44).put(f64Bytes(x))
  }

  // — locals / globals —
  local_get(i: number): this {
    return this.op(0x20).put(uleb(i))
  }
  local_set(i: number): this {
    return this.op(0x21).put(uleb(i))
  }
  local_tee(i: number): this {
    return this.op(0x22).put(uleb(i))
  }
  global_get(i: number): this {
    return this.op(0x23).put(uleb(i))
  }
  global_set(i: number): this {
    return this.op(0x24).put(uleb(i))
  }

  // — calls —
  call(i: number): this {
    return this.op(0x10).put(uleb(i))
  }
  call_indirect(typeIdx: number): this {
    return this.op(0x11).put(uleb(typeIdx)).op(0x00) // table 0
  }
  // tail-call proposal: replace the current frame instead of growing the stack
  return_call(i: number): this {
    return this.op(0x12).put(uleb(i))
  }
  return_call_indirect(typeIdx: number): this {
    return this.op(0x13).put(uleb(typeIdx)).op(0x00) // table 0
  }

  // — control flow —
  block(rt: number = EMPTY_BLOCK): this {
    return this.op(0x02, rt)
  }
  loop(rt: number = EMPTY_BLOCK): this {
    return this.op(0x03, rt)
  }
  if_(rt: number = EMPTY_BLOCK): this {
    return this.op(0x04, rt)
  }
  else_(): this {
    return this.op(0x05)
  }
  end(): this {
    return this.op(0x0b)
  }
  br(depth: number): this {
    return this.op(0x0c).put(uleb(depth))
  }
  br_if(depth: number): this {
    return this.op(0x0d).put(uleb(depth))
  }
  return_(): this {
    return this.op(0x0f)
  }
  unreachable(): this {
    return this.op(0x00)
  }
  drop(): this {
    return this.op(0x1a)
  }
  select(): this {
    return this.op(0x1b)
  }

  // — memory —
  i32_load(offset = 0): this {
    return this.op(0x28).put(uleb(2)).put(uleb(offset))
  }
  f64_load(offset = 0): this {
    return this.op(0x2b).put(uleb(3)).put(uleb(offset))
  }
  i32_store(offset = 0): this {
    return this.op(0x36).put(uleb(2)).put(uleb(offset))
  }
  f64_store(offset = 0): this {
    return this.op(0x39).put(uleb(3)).put(uleb(offset))
  }
  memory_size(): this {
    return this.op(0x3f, 0x00)
  }
  memory_grow(): this {
    return this.op(0x40, 0x00)
  }

  // — i32 arithmetic / comparison —
  i32_eqz(): this {
    return this.op(0x45)
  }
  i32_eq(): this {
    return this.op(0x46)
  }
  i32_ne(): this {
    return this.op(0x47)
  }
  i32_lt_s(): this {
    return this.op(0x48)
  }
  i32_gt_s(): this {
    return this.op(0x4a)
  }
  i32_gt_u(): this {
    return this.op(0x4b)
  }
  i32_lt_u(): this {
    return this.op(0x49)
  }
  i32_le_s(): this {
    return this.op(0x4c)
  }
  i32_ge_s(): this {
    return this.op(0x4e)
  }
  i32_add(): this {
    return this.op(0x6a)
  }
  i32_sub(): this {
    return this.op(0x6b)
  }
  i32_mul(): this {
    return this.op(0x6c)
  }
  i32_div_s(): this {
    return this.op(0x6d)
  }
  i32_rem_s(): this {
    return this.op(0x6f)
  }
  i32_and(): this {
    return this.op(0x71)
  }
  i32_or(): this {
    return this.op(0x72)
  }
  i32_shl(): this {
    return this.op(0x74)
  }
  i32_shr_s(): this {
    return this.op(0x75)
  }
  i32_shr_u(): this {
    return this.op(0x76)
  }

  // — f64 arithmetic / comparison / conversion —
  f64_eq(): this {
    return this.op(0x61)
  }
  f64_lt(): this {
    return this.op(0x63)
  }
  f64_add(): this {
    return this.op(0xa0)
  }
  f64_sub(): this {
    return this.op(0xa1)
  }
  f64_mul(): this {
    return this.op(0xa2)
  }
  f64_div(): this {
    return this.op(0xa3)
  }
  i32_trunc_f64_s(): this {
    return this.op(0xaa)
  }
  f64_convert_i32_s(): this {
    return this.op(0xb7)
  }

  /** Append raw bytes (an already-encoded immediate). */
  put(bytes: number[]): this {
    for (const b of bytes) this.bytes.push(b)
    return this
  }

  /** Splice another Code's bytes in (for composing fragments). */
  append(other: Code): this {
    return this.put(other.bytes)
  }
}

// ---------------------------------------------------------------------------
// Module builder
// ---------------------------------------------------------------------------

export interface FuncType {
  params: ValType[]
  results: ValType[]
}

interface ImportEntry {
  module: string
  field: string
  typeIdx: number
  /** debug name for the `name` section (defaults to the field) */
  name?: string
}

interface FuncEntry {
  typeIdx: number
  locals: ValType[]
  body: Code
  /** export name, if any */
  exportName?: string
  /** debug name for the `name` section */
  name?: string
  /** debug names for locals (indices 0… are the params), for the `name` section */
  localNames?: (string | null)[]
}

interface GlobalEntry {
  valtype: ValType
  mutable: boolean
  init: Code
  /** debug name for the `name` section */
  name?: string
}

/**
 * Assembles a complete WebAssembly module. Function indices are assigned with
 * imported functions first (indices `0 .. importCount-1`), then defined
 * functions — exactly as the spec requires. An element segment maps every
 * function index into table position `i`, so `call_indirect` can dispatch by
 * function index directly.
 */
export class Module {
  private types: FuncType[] = []
  private imports: ImportEntry[] = []
  private funcs: FuncEntry[] = []
  private globals: GlobalEntry[] = []
  private memMinPages = 16
  private memExportName = 'memory'

  /** Intern a function type, returning its type index. */
  typeIndex(params: ValType[], results: ValType[]): number {
    const key = (t: FuncType): string => `${t.params.join(',')}->${t.results.join(',')}`
    const want = key({ params, results })
    for (let i = 0; i < this.types.length; i++) if (key(this.types[i]) === want) return i
    this.types.push({ params, results })
    return this.types.length - 1
  }

  /** Declare an imported function; returns its function index. */
  importFunc(module: string, field: string, params: ValType[], results: ValType[], name?: string): number {
    if (this.funcs.length > 0) throw new Error('all imports must be declared before any defined function')
    const typeIdx = this.typeIndex(params, results)
    this.imports.push({ module, field, typeIdx, name })
    return this.imports.length - 1
  }

  /** Reserve the next defined-function index without a body yet (for forward references). */
  reserveFunc(): number {
    return this.imports.length + this.funcs.length
  }

  /** Define a function. Returns its function index. */
  addFunc(
    params: ValType[],
    results: ValType[],
    locals: ValType[],
    body: Code,
    exportName?: string,
    name?: string,
    localNames?: (string | null)[],
  ): number {
    const typeIdx = this.typeIndex(params, results)
    const idx = this.imports.length + this.funcs.length
    this.funcs.push({ typeIdx, locals, body, exportName, name: name ?? exportName, localNames })
    return idx
  }

  /** Define a global. Returns its global index. */
  addGlobal(valtype: ValType, mutable: boolean, init: Code, name?: string): number {
    this.globals.push({ valtype, mutable, init, name })
    return this.globals.length - 1
  }

  /** Attach a debug name to an already-defined global (index from `addGlobal`). */
  setGlobalName(idx: number, name: string): void {
    if (this.globals[idx]) this.globals[idx].name = name
  }

  get definedFuncCount(): number {
    return this.funcs.length
  }
  get importCount(): number {
    return this.imports.length
  }
  get totalFuncCount(): number {
    return this.imports.length + this.funcs.length
  }

  // — serialisation —

  private section(id: number, content: number[]): number[] {
    return [id, ...uleb(content.length), ...content]
  }

  emit(): Uint8Array {
    const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00] // magic + version

    // 1 — type
    out.push(
      ...this.section(
        1,
        vec(this.types.map((t) => [0x60, ...vec(t.params.map((p) => [p])), ...vec(t.results.map((r) => [r]))])),
      ),
    )

    // 2 — import (functions only)
    if (this.imports.length > 0) {
      out.push(
        ...this.section(
          2,
          vec(this.imports.map((im) => [...encodeName(im.module), ...encodeName(im.field), 0x00, ...uleb(im.typeIdx)])),
        ),
      )
    }

    // 3 — function (type index per defined function)
    out.push(...this.section(3, vec(this.funcs.map((f) => uleb(f.typeIdx)))))

    // 4 — table: one funcref table sized to hold every function index
    const tableSize = this.totalFuncCount
    out.push(...this.section(4, vec([[0x70, 0x00, ...uleb(tableSize)]])))

    // 5 — memory: one memory, min pages, no max
    out.push(...this.section(5, vec([[0x00, ...uleb(this.memMinPages)]])))

    // 6 — global
    if (this.globals.length > 0) {
      out.push(
        ...this.section(
          6,
          vec(
            this.globals.map((g) => [g.valtype, g.mutable ? 0x01 : 0x00, ...g.init.bytes, 0x0b]),
          ),
        ),
      )
    }

    // 7 — export: memory + every named function
    const exports: number[][] = [[...encodeName(this.memExportName), 0x02, ...uleb(0)]]
    this.funcs.forEach((f, i) => {
      if (f.exportName) exports.push([...encodeName(f.exportName), 0x00, ...uleb(this.imports.length + i)])
    })
    out.push(...this.section(7, vec(exports)))

    // 9 — element: active segment on table 0, offset 0, every function index in order
    const allIdx = Array.from({ length: tableSize }, (_, i) => i)
    const elemSeg = [0x00, 0x41, ...sleb(0), 0x0b, ...vec(allIdx.map((i) => uleb(i)))]
    out.push(...this.section(9, vec([elemSeg])))

    // 10 — code
    const codes = this.funcs.map((f) => {
      // group consecutive locals of the same type into (count, type) runs
      const runs: number[][] = []
      let i = 0
      while (i < f.locals.length) {
        let j = i
        while (j < f.locals.length && f.locals[j] === f.locals[i]) j++
        runs.push([...uleb(j - i), f.locals[i]])
        i = j
      }
      const body = [...vec(runs), ...f.body.bytes, 0x0b]
      return [...uleb(body.length), ...body]
    })
    out.push(...this.section(10, vec(codes)))

    // 0 — the `name` custom section (DWARF-free debug names). Optional per the
    // spec, but it is what lets the disassembler print `$map` instead of `(call 27)`.
    const nameSec = this.nameSection()
    if (nameSec) out.push(...this.section(0, nameSec))

    return new Uint8Array(out)
  }

  /** Build the body of the `name` custom section, or `null` if there is nothing to name. */
  private nameSection(): number[] | null {
    // a namemap is a vec of (index, name) pairs, indices strictly increasing
    const nameMap = (pairs: [number, string][]): number[] =>
      vec(pairs.sort((a, b) => a[0] - b[0]).map(([i, n]) => [...uleb(i), ...encodeName(n)]))

    // sub-section 1 — function names (imports first, then defined functions)
    const funcPairs: [number, string][] = []
    this.imports.forEach((im, i) => funcPairs.push([i, im.name ?? im.field]))
    this.funcs.forEach((f, i) => {
      if (f.name) funcPairs.push([this.imports.length + i, f.name])
    })

    // sub-section 2 — local names (an indirectnamemap: per function, a namemap)
    const localEntries: number[][] = []
    this.funcs.forEach((f, i) => {
      if (!f.localNames) return
      const pairs: [number, string][] = []
      f.localNames.forEach((n, li) => {
        if (n) pairs.push([li, n])
      })
      if (pairs.length) localEntries.push([...uleb(this.imports.length + i), ...nameMap(pairs)])
    })

    // sub-section 7 — global names
    const globalPairs: [number, string][] = []
    this.globals.forEach((g, i) => {
      if (g.name) globalPairs.push([i, g.name])
    })

    const subs: number[] = []
    const sub = (id: number, content: number[]): void => {
      subs.push(id, ...uleb(content.length), ...content)
    }
    if (funcPairs.length) sub(1, nameMap(funcPairs))
    if (localEntries.length) sub(2, vec(localEntries))
    if (globalPairs.length) sub(7, nameMap(globalPairs))
    if (subs.length === 0) return null
    return [...encodeName('name'), ...subs]
  }
}
