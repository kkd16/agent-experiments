// Aether — WebAssembly disassembler (binary → WAT text)
//
// The exact mirror image of `encoder.ts`. Where the encoder *writes* a `.wasm`
// module byte by byte, this module *reads* one back: it parses the binary format
// — magic/version, then the type / import / function / table / memory / global /
// export / element / code and `name` sections — and renders canonical, indented
// WebAssembly **text format** (WAT). No `wabt`, no `wasm2wat`, no libraries —
// the same rule the encoder lives by.
//
// It decodes exactly the instruction set the `Code` builder can emit (consts,
// locals/globals, calls + `call_indirect`/`return_call`, structured control flow,
// `memarg` loads/stores, `memory.size`/`grow`, and the i32/f64 arithmetic,
// comparison and conversion ops), resolving function / global / local indices to
// the `$names` carried in the module's `name` section. An unrecognised opcode is
// surfaced loudly (the harness asserts none ever appears in a real module).

// ---------------------------------------------------------------------------
// A little-endian byte reader with LEB128 + UTF-8 helpers
// ---------------------------------------------------------------------------

class Reader {
  pos = 0
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  eof(): boolean {
    return this.pos >= this.bytes.length
  }
  byte(): number {
    if (this.pos >= this.bytes.length) throw new Error('unexpected end of module')
    return this.bytes[this.pos++]
  }
  /** Unsigned LEB128. */
  uleb(): number {
    let result = 0
    let shift = 0
    for (;;) {
      const b = this.byte()
      result |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7
    }
    return result >>> 0
  }
  /** Signed LEB128. */
  sleb(): number {
    let result = 0
    let shift = 0
    let b: number
    for (;;) {
      b = this.byte()
      result |= (b & 0x7f) << shift
      shift += 7
      if ((b & 0x80) === 0) break
    }
    // sign-extend if the sign bit of the last byte is set
    if (shift < 32 && b & 0x40) result |= -1 << shift
    return result
  }
  f64(): number {
    const dv = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8)
    this.pos += 8
    return dv.getFloat64(0, true)
  }
  /** A length-prefixed UTF-8 name. */
  name(): string {
    const len = this.uleb()
    const slice = this.bytes.subarray(this.pos, this.pos + len)
    this.pos += len
    return new TextDecoder().decode(slice)
  }
  take(n: number): Uint8Array {
    const slice = this.bytes.subarray(this.pos, this.pos + n)
    this.pos += n
    return slice
  }
}

// ---------------------------------------------------------------------------
// Module IR (just enough to render)
// ---------------------------------------------------------------------------

interface DType {
  params: number[]
  results: number[]
}
interface DImport {
  module: string
  field: string
  typeIdx: number
}
interface DGlobal {
  valtype: number
  mutable: boolean
  init: Uint8Array
}
interface DExport {
  name: string
  kind: number
  index: number
}
interface DFunc {
  typeIdx: number
  localDecls: { count: number; type: number }[]
  body: Uint8Array
}
interface DNames {
  funcs: Map<number, string>
  locals: Map<number, Map<number, string>>
  globals: Map<number, string>
}

interface DModule {
  types: DType[]
  imports: DImport[]
  funcTypeIdx: number[]
  tableSize: number
  memMin: number
  globals: DGlobal[]
  exports: DExport[]
  names: DNames
}

export interface WatFunc {
  /** the function's index in the module (imports first, then defined) */
  index: number
  name: string
  signature: string
  /** the rendered WAT body (one instruction per line, already indented) */
  wat: string
}

export interface WatModule {
  /** module-level declarations (types, imports, memory, table, globals, exports) */
  header: string
  funcs: WatFunc[]
  /** the entire module rendered as one WAT string */
  text: string
  /** total instructions decoded across all function bodies */
  instructions: number
  /** unrecognised opcodes encountered — must be 0 for a module we emitted */
  unknown: number
}

// ---------------------------------------------------------------------------
// Value-type & opcode tables
// ---------------------------------------------------------------------------

function valtype(b: number): string {
  switch (b) {
    case 0x7f:
      return 'i32'
    case 0x7e:
      return 'i64'
    case 0x7d:
      return 'f32'
    case 0x7c:
      return 'f64'
    default:
      return `t${b.toString(16)}`
  }
}

function blocktype(b: number): string {
  if (b === 0x40) return ''
  return ` (result ${valtype(b)})`
}

// opcodes with no immediates → mnemonic
const SIMPLE: Record<number, string> = {
  0x00: 'unreachable',
  0x01: 'nop',
  0x05: 'else',
  0x0b: 'end',
  0x0f: 'return',
  0x1a: 'drop',
  0x1b: 'select',
  0x45: 'i32.eqz',
  0x46: 'i32.eq',
  0x47: 'i32.ne',
  0x48: 'i32.lt_s',
  0x49: 'i32.lt_u',
  0x4a: 'i32.gt_s',
  0x4b: 'i32.gt_u',
  0x4c: 'i32.le_s',
  0x4e: 'i32.ge_s',
  0x6a: 'i32.add',
  0x6b: 'i32.sub',
  0x6c: 'i32.mul',
  0x6d: 'i32.div_s',
  0x6f: 'i32.rem_s',
  0x71: 'i32.and',
  0x72: 'i32.or',
  0x74: 'i32.shl',
  0x75: 'i32.shr_s',
  0x76: 'i32.shr_u',
  0x61: 'f64.eq',
  0x63: 'f64.lt',
  0xa0: 'f64.add',
  0xa1: 'f64.sub',
  0xa2: 'f64.mul',
  0xa3: 'f64.div',
  0xaa: 'i32.trunc_f64_s',
  0xb7: 'f64.convert_i32_s',
}

// ---------------------------------------------------------------------------
// Section decoding
// ---------------------------------------------------------------------------

function parseModule(bytes: Uint8Array): DModule {
  const r = new Reader(bytes)
  // magic + version
  const magic = [r.byte(), r.byte(), r.byte(), r.byte()].join(',')
  if (magic !== '0,97,115,109') throw new Error('not a WebAssembly module (bad magic)')
  r.take(4) // version

  const mod: DModule = {
    types: [],
    imports: [],
    funcTypeIdx: [],
    tableSize: 0,
    memMin: 0,
    globals: [],
    exports: [],
    names: { funcs: new Map(), locals: new Map(), globals: new Map() },
  }

  while (!r.eof()) {
    const id = r.byte()
    const size = r.uleb()
    const sec = new Reader(r.take(size))
    switch (id) {
      case 1: {
        const n = sec.uleb()
        for (let i = 0; i < n; i++) {
          sec.byte() // 0x60 func form
          const np = sec.uleb()
          const params: number[] = []
          for (let p = 0; p < np; p++) params.push(sec.byte())
          const nr = sec.uleb()
          const results: number[] = []
          for (let p = 0; p < nr; p++) results.push(sec.byte())
          mod.types.push({ params, results })
        }
        break
      }
      case 2: {
        const n = sec.uleb()
        for (let i = 0; i < n; i++) {
          const module = sec.name()
          const field = sec.name()
          const kind = sec.byte()
          if (kind === 0x00) mod.imports.push({ module, field, typeIdx: sec.uleb() })
          else throw new Error(`unsupported import kind ${kind}`)
        }
        break
      }
      case 3: {
        const n = sec.uleb()
        for (let i = 0; i < n; i++) mod.funcTypeIdx.push(sec.uleb())
        break
      }
      case 4: {
        const n = sec.uleb()
        for (let i = 0; i < n; i++) {
          sec.byte() // elemtype 0x70 funcref
          const flags = sec.byte()
          mod.tableSize = sec.uleb() // min
          if (flags === 0x01) sec.uleb() // max
        }
        break
      }
      case 5: {
        const n = sec.uleb()
        for (let i = 0; i < n; i++) {
          const flags = sec.byte()
          mod.memMin = sec.uleb()
          if (flags === 0x01) sec.uleb()
        }
        break
      }
      case 6: {
        const n = sec.uleb()
        for (let i = 0; i < n; i++) {
          const vt = sec.byte()
          const mut = sec.byte() === 0x01
          // the init is a constant expression terminated by the `end` *opcode*; we
          // must skip each instruction's immediate (an `end`-valued byte can appear
          // inside a LEB immediate), so decode at instruction granularity.
          const start = sec.pos
          for (;;) {
            const op = sec.byte()
            if (op === 0x0b) break // end
            if (op === 0x41) sec.sleb() // i32.const
            else if (op === 0x44) sec.f64() // f64.const
            else if (op === 0x23) sec.uleb() // global.get
          }
          const init = sec.bytes.subarray(start, sec.pos - 1)
          mod.globals.push({ valtype: vt, mutable: mut, init })
        }
        break
      }
      case 7: {
        const n = sec.uleb()
        for (let i = 0; i < n; i++) {
          const name = sec.name()
          const kind = sec.byte()
          const index = sec.uleb()
          mod.exports.push({ name, kind, index })
        }
        break
      }
      case 10: {
        // code section — keep its (already-extracted) content for lazy decoding
        mod.codeSection = sec.bytes
        break
      }
      case 0: {
        // custom section — only "name" is decoded
        const cname = sec.name()
        if (cname === 'name') parseNameSection(sec, mod.names)
        break
      }
      // 9 (element) is not needed to read the program
      default:
        break
    }
  }
  return mod
}

// the code section content is decoded on demand by the renderer (kept as raw bytes)
interface DModule {
  codeSection?: Uint8Array
}

function parseNameSection(sec: Reader, names: DNames): void {
  while (!sec.eof()) {
    const subId = sec.byte()
    const subSize = sec.uleb()
    const sub = new Reader(sec.take(subSize))
    if (subId === 1) {
      const n = sub.uleb()
      for (let i = 0; i < n; i++) names.funcs.set(sub.uleb(), sub.name())
    } else if (subId === 2) {
      const nf = sub.uleb()
      for (let i = 0; i < nf; i++) {
        const fidx = sub.uleb()
        const nl = sub.uleb()
        const m = new Map<number, string>()
        for (let j = 0; j < nl; j++) m.set(sub.uleb(), sub.name())
        names.locals.set(fidx, m)
      }
    } else if (subId === 7) {
      const n = sub.uleb()
      for (let i = 0; i < n; i++) names.globals.set(sub.uleb(), sub.name())
    }
  }
}

function decodeFuncs(mod: DModule): DFunc[] {
  if (!mod.codeSection) return []
  // codeSection holds the section *content*: a vector of function bodies
  const r = new Reader(mod.codeSection)
  const n = r.uleb()
  const funcs: DFunc[] = []
  for (let i = 0; i < n; i++) {
    const bodySize = r.uleb()
    const bodyStart = r.pos
    const nDecls = r.uleb()
    const localDecls: { count: number; type: number }[] = []
    for (let d = 0; d < nDecls; d++) localDecls.push({ count: r.uleb(), type: r.byte() })
    const body = r.bytes.subarray(r.pos, bodyStart + bodySize - 1) // minus the trailing 0x0b
    r.pos = bodyStart + bodySize
    funcs.push({ typeIdx: mod.funcTypeIdx[i], localDecls, body })
  }
  return funcs
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function funcRef(mod: DModule, idx: number): string {
  const name = mod.names.funcs.get(idx)
  return name ? `$${sanitize(name)}` : `${idx}`
}
function globalRef(mod: DModule, idx: number): string {
  const name = mod.names.globals.get(idx)
  return name ? `$${sanitize(name)}` : `${idx}`
}
function localRef(localNames: Map<number, string> | undefined, idx: number): string {
  const name = localNames?.get(idx)
  return name ? `$${sanitize(name)}` : `${idx}`
}
function sanitize(name: string): string {
  // WAT identifiers are fairly liberal; keep it readable and brace-free
  return name.replace(/[^A-Za-z0-9_$.\-λ]/g, '_')
}

interface BodyResult {
  lines: string[]
  count: number
  unknown: number
}

/** Decode one function/const-expression body into indented WAT lines. */
function disasmBody(mod: DModule, body: Uint8Array, localNames: Map<number, string> | undefined, baseIndent: number): BodyResult {
  const r = new Reader(body)
  const lines: string[] = []
  let depth = baseIndent
  let count = 0
  let unknown = 0
  const pad = (d: number): string => '  '.repeat(Math.max(d, 0))
  const emit = (d: number, text: string): void => {
    lines.push(pad(d) + text)
  }

  while (!r.eof()) {
    const op = r.byte()
    count++
    switch (op) {
      case 0x02:
      case 0x03:
      case 0x04: {
        const bt = r.byte()
        const kw = op === 0x02 ? 'block' : op === 0x03 ? 'loop' : 'if'
        emit(depth, kw + blocktype(bt))
        depth++
        break
      }
      case 0x05: // else
        emit(depth - 1, 'else')
        break
      case 0x0b: // end
        depth--
        emit(depth, 'end')
        break
      case 0x0c:
        emit(depth, `br ${r.uleb()}`)
        break
      case 0x0d:
        emit(depth, `br_if ${r.uleb()}`)
        break
      case 0x10:
        emit(depth, `call ${funcRef(mod, r.uleb())}`)
        break
      case 0x11: {
        const t = r.uleb()
        r.byte() // table index 0
        emit(depth, `call_indirect (type ${t})`)
        break
      }
      case 0x12:
        emit(depth, `return_call ${funcRef(mod, r.uleb())}`)
        break
      case 0x13: {
        const t = r.uleb()
        r.byte()
        emit(depth, `return_call_indirect (type ${t})`)
        break
      }
      case 0x20:
        emit(depth, `local.get ${localRef(localNames, r.uleb())}`)
        break
      case 0x21:
        emit(depth, `local.set ${localRef(localNames, r.uleb())}`)
        break
      case 0x22:
        emit(depth, `local.tee ${localRef(localNames, r.uleb())}`)
        break
      case 0x23:
        emit(depth, `global.get ${globalRef(mod, r.uleb())}`)
        break
      case 0x24:
        emit(depth, `global.set ${globalRef(mod, r.uleb())}`)
        break
      case 0x28:
      case 0x2b:
      case 0x36:
      case 0x39: {
        const mnem = op === 0x28 ? 'i32.load' : op === 0x2b ? 'f64.load' : op === 0x36 ? 'i32.store' : 'f64.store'
        r.uleb() // align (natural)
        const offset = r.uleb()
        emit(depth, offset ? `${mnem} offset=${offset}` : mnem)
        break
      }
      case 0x3f:
        r.byte()
        emit(depth, 'memory.size')
        break
      case 0x40:
        r.byte()
        emit(depth, 'memory.grow')
        break
      case 0x41:
        emit(depth, `i32.const ${r.sleb()}`)
        break
      case 0x44:
        emit(depth, `f64.const ${formatF64(r.f64())}`)
        break
      default: {
        const simple = SIMPLE[op]
        if (simple) emit(depth, simple)
        else {
          unknown++
          emit(depth, `;; unknown opcode 0x${op.toString(16).padStart(2, '0')}`)
        }
      }
    }
  }
  return { lines, count, unknown }
}

function formatF64(x: number): string {
  if (Number.isInteger(x)) return `${x}.0`
  return String(x)
}

function typeSig(t: DType | undefined): { params: string; results: string } {
  if (!t) return { params: '', results: '' }
  return {
    params: t.params.map(valtype).join(' '),
    results: t.results.map(valtype).join(' '),
  }
}

/** Disassemble a `.wasm` module into structured + textual WAT. */
export function disassemble(bytes: Uint8Array): WatModule {
  const mod = parseModule(bytes)
  const dfuncs = decodeFuncs(mod)
  const importCount = mod.imports.length

  // — header: types, imports, table, memory, globals, exports —
  const header: string[] = ['(module']
  mod.types.forEach((t, i) => {
    const { params, results } = typeSig(t)
    const p = params ? ` (param ${params})` : ''
    const res = results ? ` (result ${results})` : ''
    header.push(`  (type ${i} (func${p}${res}))`)
  })
  mod.imports.forEach((im, i) => {
    header.push(`  (import "${im.module}" "${im.field}" (func ${funcRef(mod, i)} (type ${im.typeIdx})))`)
  })
  header.push(`  (memory $memory ${mod.memMin})`)
  mod.globals.forEach((g, i) => {
    const init = disasmBody(mod, g.init, undefined, 0).lines.join(' ').trim()
    const ty = g.mutable ? `(mut ${valtype(g.valtype)})` : valtype(g.valtype)
    header.push(`  (global ${globalRef(mod, i)} ${ty} (${init}))`)
  })
  mod.exports.forEach((e) => {
    const kindName = e.kind === 0x00 ? 'func' : e.kind === 0x02 ? 'memory' : `kind${e.kind}`
    const ref = e.kind === 0x00 ? funcRef(mod, e.index) : `${e.index}`
    header.push(`  (export "${e.name}" (${kindName} ${ref}))`)
  })

  // — functions —
  const funcs: WatFunc[] = []
  let instructions = 0
  let unknown = 0
  dfuncs.forEach((f, i) => {
    const index = importCount + i
    const type = mod.types[f.typeIdx]
    const localNames = mod.names.locals.get(index)
    const nParams = type ? type.params.length : 0

    // signature line: (func $name (param $a i32) … (result i32))
    const parts: string[] = [`(func ${funcRef(mod, index)} (type ${f.typeIdx})`]
    if (type) {
      type.params.forEach((p, pi) => parts.push(`(param ${localRef(localNames, pi)} ${valtype(p)})`))
      if (type.results.length) parts.push(`(result ${type.results.map(valtype).join(' ')})`)
    }
    const signature = parts.join(' ')

    // locals (after the params)
    const localLines: string[] = []
    let li = nParams
    for (const d of f.localDecls) {
      for (let k = 0; k < d.count; k++) {
        localLines.push(`  (local ${localRef(localNames, li)} ${valtype(d.type)})`)
        li++
      }
    }

    const decoded = disasmBody(mod, f.body, localNames, 1)
    instructions += decoded.count
    unknown += decoded.unknown
    const wat = [signature, ...localLines, ...decoded.lines, ')'].join('\n')
    funcs.push({ index, name: mod.names.funcs.get(index) ?? `func${index}`, signature, wat })
  })

  const headerText = header.join('\n')
  const text = [headerText, ...funcs.map((f) => f.wat.split('\n').map((l) => '  ' + l).join('\n')), ')'].join('\n\n')
  return { header: headerText, funcs, text, instructions, unknown }
}
