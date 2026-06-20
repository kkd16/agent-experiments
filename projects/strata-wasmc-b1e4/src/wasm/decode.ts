// A from-scratch WebAssembly *binary decoder*. It reads the exact bytes the
// Strata backend emits (`backend/encoder.ts` + `backend/codegen.ts`) back into a
// structured module — every section the backend can produce: types, imports,
// functions, a funcref table, linear memory, globals, exports, an element
// segment, the code bodies, and a data segment. It is deliberately independent of
// the encoder: it re-parses the LEB128 integers and section framing from first
// principles, so a round-trip through it (decode → run on `vm.ts`) genuinely
// re-validates the assembled module, byte for byte.
//
// Scope: it handles precisely the subset of WebAssembly the compiler emits (a
// single memory, a single funcref table, no `memory.grow`, structured control
// flow with void block types). Anything outside that subset is rejected loudly,
// because by construction the compiler never produces it.

export type ValType = 'i32' | 'i64' | 'f32' | 'f64' | 'v128';

const VAL: Record<number, ValType> = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128' };

export interface FuncType {
  params: ValType[];
  results: ValType[];
}
export interface WasmImport {
  module: string;
  field: string;
  typeIdx: number;
}
export interface WasmGlobal {
  type: ValType;
  mutable: boolean;
  init: number | bigint;
}
export interface WasmExport {
  name: string;
  kind: number; // 0 = func, 2 = memory
  index: number;
}
export interface ElemSegment {
  offset: number;
  funcIndices: number[];
}
export interface DataSegment {
  offset: number;
  bytes: Uint8Array;
}
export interface CodeBody {
  /** Declared locals beyond the parameters, expanded one entry per local. */
  locals: ValType[];
  /** Raw bytes of the function body (instructions, *including* the trailing end). */
  body: Uint8Array;
}
export interface WasmModule {
  types: FuncType[];
  imports: WasmImport[];
  /** Type index of each *defined* function (parallel to `codes`). */
  funcTypes: number[];
  table?: { min: number };
  memory?: { min: number };
  globals: WasmGlobal[];
  exports: WasmExport[];
  elems: ElemSegment[];
  codes: CodeBody[];
  datas: DataSegment[];
}

/** A cursor over a byte buffer with the LEB128 / IEEE-754 readers wasm needs. */
export class Reader {
  pos = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }
  u8(): number {
    if (this.pos >= this.bytes.length) throw new Error('wasm decode: unexpected end of input');
    return this.bytes[this.pos++];
  }
  /** Unsigned LEB128. */
  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }
  /** Signed LEB128 (32-bit). */
  i32(): number {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.u8();
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    if (shift < 32 && b & 0x40) result |= -1 << shift; // sign-extend
    return result | 0;
  }
  /** Signed LEB128 (64-bit) as a BigInt. */
  i64(): bigint {
    let result = 0n;
    let shift = 0n;
    let b: number;
    do {
      b = this.u8();
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80);
    if (b & 0x40) result |= -1n << shift; // sign-extend
    return BigInt.asIntN(64, result);
  }
  f32(): number {
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }
  f64(): number {
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }
  name(): string {
    const len = this.u32();
    const slice = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return new TextDecoder().decode(slice);
  }
  take(n: number): Uint8Array {
    const slice = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }
}

function valType(b: number): ValType {
  const t = VAL[b];
  if (!t) throw new Error(`wasm decode: unknown value type 0x${b.toString(16)}`);
  return t;
}

// A constant init expression: a single numeric const followed by `end` (0x0b).
// Globals, element-segment offsets and data-segment offsets all use this shape.
function constExpr(r: Reader): number | bigint {
  const op = r.u8();
  let v: number | bigint;
  if (op === 0x41) v = r.i32();
  else if (op === 0x42) v = r.i64();
  else if (op === 0x43) v = r.f32();
  else if (op === 0x44) v = r.f64();
  else throw new Error(`wasm decode: unsupported const-expr opcode 0x${op.toString(16)}`);
  const end = r.u8();
  if (end !== 0x0b) throw new Error('wasm decode: const-expr missing end');
  return v;
}

export function decodeModule(bytes: Uint8Array): WasmModule {
  const r = new Reader(bytes);
  for (const expect of [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]) {
    if (r.u8() !== expect) throw new Error('wasm decode: bad magic / version');
  }
  const mod: WasmModule = {
    types: [],
    imports: [],
    funcTypes: [],
    globals: [],
    exports: [],
    elems: [],
    codes: [],
    datas: [],
  };

  while (!r.eof) {
    const id = r.u8();
    const size = r.u32();
    const end = r.pos + size;
    switch (id) {
      case 1: { // type
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          if (r.u8() !== 0x60) throw new Error('wasm decode: bad functype');
          const params: ValType[] = [];
          const np = r.u32();
          for (let j = 0; j < np; j++) params.push(valType(r.u8()));
          const results: ValType[] = [];
          const nr = r.u32();
          for (let j = 0; j < nr; j++) results.push(valType(r.u8()));
          mod.types.push({ params, results });
        }
        break;
      }
      case 2: { // import
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const module = r.name();
          const field = r.name();
          const kind = r.u8();
          if (kind !== 0x00) throw new Error('wasm decode: only function imports are supported');
          mod.imports.push({ module, field, typeIdx: r.u32() });
        }
        break;
      }
      case 3: { // function
        const n = r.u32();
        for (let i = 0; i < n; i++) mod.funcTypes.push(r.u32());
        break;
      }
      case 4: { // table
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          if (r.u8() !== 0x70) throw new Error('wasm decode: only funcref tables are supported');
          const flags = r.u8();
          const min = r.u32();
          if (flags === 0x01) r.u32(); // max (unused)
          mod.table = { min };
        }
        break;
      }
      case 5: { // memory
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const flags = r.u8();
          const min = r.u32();
          if (flags === 0x01) r.u32(); // max (unused)
          mod.memory = { min };
        }
        break;
      }
      case 6: { // global
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const type = valType(r.u8());
          const mutable = r.u8() === 0x01;
          mod.globals.push({ type, mutable, init: constExpr(r) });
        }
        break;
      }
      case 7: { // export
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const name = r.name();
          const kind = r.u8();
          mod.exports.push({ name, kind, index: r.u32() });
        }
        break;
      }
      case 9: { // element
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const flags = r.u32();
          if (flags !== 0x00) throw new Error('wasm decode: only active element segments are supported');
          const offset = constExpr(r) as number;
          const m = r.u32();
          const funcIndices: number[] = [];
          for (let j = 0; j < m; j++) funcIndices.push(r.u32());
          mod.elems.push({ offset, funcIndices });
        }
        break;
      }
      case 10: { // code
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const bodySize = r.u32();
          const bodyEnd = r.pos + bodySize;
          const localDecls = r.u32();
          const locals: ValType[] = [];
          for (let j = 0; j < localDecls; j++) {
            const count = r.u32();
            const ty = valType(r.u8());
            for (let k = 0; k < count; k++) locals.push(ty);
          }
          const body = r.bytes.subarray(r.pos, bodyEnd);
          r.pos = bodyEnd;
          mod.codes.push({ locals, body });
        }
        break;
      }
      case 11: { // data
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const flags = r.u32();
          if (flags !== 0x00) throw new Error('wasm decode: only active data segments are supported');
          const offset = constExpr(r) as number;
          const len = r.u32();
          mod.datas.push({ offset, bytes: r.take(len).slice() });
        }
        break;
      }
      default:
        // Unknown / custom section: skip its body wholesale.
        r.pos = end;
        break;
    }
    if (r.pos !== end) {
      // A decode bug would desynchronize the cursor; fail fast rather than
      // silently mis-parse the rest of the module.
      throw new Error(`wasm decode: section ${id} over/under-ran (${r.pos} vs ${end})`);
    }
  }
  return mod;
}
