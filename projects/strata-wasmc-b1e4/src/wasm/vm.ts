// A from-scratch WebAssembly virtual machine. It executes the decoded module
// (`decode.ts` + `disasm.ts`) on a hand-written stack machine, one instruction at
// a time, so it can serve two masters:
//
//   1. As a *third correctness oracle*. The reference tree-walking interpreter and
//      the host engine's `WebAssembly` already cross-check each other; this VM is
//      an independent re-implementation of the runtime, so a green Verify run now
//      means three engines — V8, the interpreter, and this — agree byte for byte.
//   2. As a *time-travel debugger*. Because `step()` advances exactly one wasm
//      instruction and the whole machine state is plain data, the UI can single-
//      step the real bytecode and show the operand stack, locals, globals, linear
//      memory and call stack as they evolve (and rewind by replaying from start).
//
// It implements precisely the opcode subset the Strata backend emits — every
// numeric op on i32/i64/f32/f64, the conversions, 128-bit SIMD, structured
// control flow, memory, globals, the funcref table + call_indirect, and the
// `print_*` host imports. i64 is a BigInt and f32 carries `Math.fround` rounding,
// exactly as the reference interpreter models them, so the three engines line up.

import {
  asI64, clz32, clz64, ctz32, ctz64, formatBool, formatFloat, formatInt, formatLong,
  i32 as toI32, I64_MIN, nearestEven, popcnt32, popcnt64, rotl32, rotl64, rotr32, rotr64,
  satTruncI32, satTruncI64,
} from '../compiler/interp';
import type { ValType, WasmModule } from './decode';
import { decodeModule } from './decode';
import { disassemble } from './disasm';
import type { Disasm, Instr } from './disasm';
import type { DebugInfo, LineEntry } from '../compiler/backend/codegen';

export type Value = number | bigint | Uint8Array;

const PAGE = 65536;

/** A control-flow scope (block / loop / if) active in a frame. */
interface Ctrl {
  isLoop: boolean;
  contPc: number; // loop: where a branch to this label resumes (body start)
  endPc: number; // index of the matching `end`
  baseSP: number; // operand-stack height when the scope was entered
}

/** An activation record — one per in-flight function call. */
export interface Frame {
  funcName: string;
  defIndex: number; // index into the module's defined functions
  dis: Disasm;
  pc: number;
  locals: Value[];
  localTypes: ValType[];
  stack: Value[];
  ctrl: Ctrl[];
  resultType: ValType | null;
}

function zeroVal(ty: ValType): Value {
  if (ty === 'i64') return 0n;
  if (ty === 'v128') return new Uint8Array(16);
  return 0;
}

const I32_MIN = -2147483648;

// --- v128 lane plumbing ------------------------------------------------------

function readLanes(shape: string, v: Uint8Array): (number | bigint)[] {
  const dv = new DataView(v.buffer, v.byteOffset, 16);
  const out: (number | bigint)[] = [];
  if (shape === 'i32x4') for (let i = 0; i < 4; i++) out.push(dv.getInt32(i * 4, true));
  else if (shape === 'f32x4') for (let i = 0; i < 4; i++) out.push(dv.getFloat32(i * 4, true));
  else if (shape === 'i64x2') for (let i = 0; i < 2; i++) out.push(dv.getBigInt64(i * 8, true));
  else for (let i = 0; i < 2; i++) out.push(dv.getFloat64(i * 8, true));
  return out;
}
function writeLanes(shape: string, arr: (number | bigint)[]): Uint8Array {
  const v = new Uint8Array(16);
  const dv = new DataView(v.buffer);
  if (shape === 'i32x4') for (let i = 0; i < 4; i++) dv.setInt32(i * 4, toI32(arr[i] as number), true);
  else if (shape === 'f32x4') for (let i = 0; i < 4; i++) dv.setFloat32(i * 4, Math.fround(arr[i] as number), true);
  else if (shape === 'i64x2') for (let i = 0; i < 2; i++) dv.setBigInt64(i * 8, asI64(arr[i] as bigint), true);
  else for (let i = 0; i < 2; i++) dv.setFloat64(i * 8, arr[i] as number, true);
  return v;
}

// magnitude of a, sign of b — wasm `copysign` (correct for ±0 / ±NaN).
const _sgnDV = new DataView(new ArrayBuffer(8));
function copysign(a: number, b: number): number {
  _sgnDV.setFloat64(0, b);
  const neg = (_sgnDV.getUint8(0) & 0x80) !== 0;
  const mag = Math.abs(a);
  return neg ? -mag : mag;
}

export class VMTrap extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'VMTrap';
  }
}

export interface VMState {
  steps: number;
  halted: boolean;
  trap?: string;
  result?: number;
  output: string[];
  frames: {
    funcName: string;
    defIndex: number; // index into the line table (DebugInfo.funcs)
    pc: number;
    line: number;
    lines: string[];
    srcLine?: number; // current source line (from the line table), if debug info present
    srcCol?: number;
    locals: SlotView[];
    stack: SlotView[];
  }[];
  /** Current source line of the innermost frame, if debug info is present. */
  srcLine?: number;
  globals: SlotView[];
  memory: Uint8Array; // a snapshot view of linear memory
  memUsed: number; // bytes worth showing (high-water mark of non-zero data)
}
export interface SlotView {
  name: string;
  ty: string;
  value: string;
}

export class WasmVM {
  private readonly mod: WasmModule;
  private readonly importCount: number;
  private readonly disByDef: Disasm[]; // one per defined function
  private readonly mem: Uint8Array;
  private readonly memDV: DataView;
  private readonly globals: { type: ValType; value: Value }[];
  private readonly table: (number | null)[]; // wasm function index per slot
  private readonly importFields: string[];
  // Optional line table, indexed by defined-function index (`defIndex`) then by
  // instruction index (`pc`). Present when the VM was built with the compiler's
  // debug info; it powers source-line mapping and source breakpoints.
  private readonly lineTable: ((LineEntry | null)[])[] | null;

  frames: Frame[] = [];
  output: string[] = [];
  steps = 0;
  halted = false;
  trap?: string;
  result?: number;

  constructor(mod: WasmModule, entry = 'main', args: Value[] = [], debug?: DebugInfo) {
    this.mod = mod;
    this.importCount = mod.imports.length;
    this.importFields = mod.imports.map((im) => im.field);
    this.disByDef = mod.codes.map((c) => disassemble(c.body));
    // The compiler emits one DebugInfo function per defined function, in the same
    // order as the code section (= `defIndex`), so a positional map is exact.
    this.lineTable = debug ? debug.funcs.map((f) => f.spans) : null;

    // Linear memory + the static data segments (string literals).
    const pages = mod.memory ? mod.memory.min : 0;
    this.mem = new Uint8Array(pages * PAGE);
    this.memDV = new DataView(this.mem.buffer);
    for (const d of mod.datas) this.mem.set(d.bytes, d.offset);

    // Globals from their constant initializers.
    this.globals = mod.globals.map((g) => ({ type: g.type, value: g.init }));

    // The funcref table: slot 0 is the null sentinel; the element segment fills
    // the rest with concrete function indices.
    this.table = mod.table ? new Array(mod.table.min).fill(null) : [];
    for (const e of mod.elems) e.funcIndices.forEach((fi, j) => (this.table[e.offset + j] = fi));

    const ex = mod.exports.find((x) => x.name === entry && x.kind === 0);
    if (!ex) {
      this.halted = true;
      this.trap = `no export '${entry}'`;
      return;
    }
    this.pushCall(ex.index, args);
  }

  // --- public driving API ---

  /** Execute one wasm instruction. Returns false once the program has halted. */
  step(): boolean {
    if (this.halted) return false;
    try {
      this.exec();
    } catch (e) {
      this.halted = true;
      this.trap = e instanceof VMTrap ? e.message : String((e as Error)?.message ?? e);
    }
    return !this.halted;
  }

  /** Run to completion (or the step budget). */
  runToEnd(maxSteps = 50_000_000): void {
    let n = 0;
    while (!this.halted && n++ < maxSteps) this.step();
    if (!this.halted) {
      this.halted = true;
      this.trap = 'step limit exceeded (possible infinite loop)';
    }
  }

  private top(): Frame {
    return this.frames[this.frames.length - 1];
  }

  /** Whether the VM was built with source debug info. */
  hasDebug(): boolean {
    return this.lineTable !== null;
  }

  /** The source location of a given function/pc — the nearest mapped entry at or
   *  before `pc`, so structural `end`/`else` instructions still report the line
   *  of the statement they close. Returns null when no debug info is present or
   *  nothing maps. */
  private posAt(defIndex: number, pc: number): LineEntry | null {
    const table = this.lineTable?.[defIndex];
    if (!table) return null;
    for (let i = Math.min(pc, table.length - 1); i >= 0; i--) if (table[i]) return table[i];
    return null;
  }

  /** Current source line of the innermost frame (1-based), or undefined. */
  currentLine(): number | undefined {
    if (this.lineTable === null || this.frames.length === 0) return undefined;
    const f = this.top();
    return this.posAt(f.defIndex, f.pc)?.line;
  }

  /** Step until the innermost frame's source line is one of `lines` (a source
   *  breakpoint), or the program halts, or the budget is exhausted. Always makes
   *  progress (steps at least once) so "continue" doesn't stall on the line it
   *  is already parked on. Returns the line it stopped on, if any. */
  continueToBreakpoints(lines: Set<number>, maxSteps = 50_000_000): number | undefined {
    let n = 0;
    while (!this.halted && n++ < maxSteps) {
      this.step();
      if (this.halted) break;
      const ln = this.currentLine();
      if (ln !== undefined && lines.has(ln)) return ln;
    }
    return this.currentLine();
  }

  private hitsBreakpoint(lines?: Set<number>): boolean {
    if (!lines || lines.size === 0) return false;
    const ln = this.currentLine();
    return ln !== undefined && lines.has(ln);
  }

  /** Source-debugger "step to next line": advance the real bytecode until the
   *  innermost frame's source line changes — stepping OVER deeper calls (a call
   *  that pushes a frame runs to completion unless it hits a breakpoint) and
   *  stopping early if control returns out of the current function. */
  stepSourceLine(breakpoints?: Set<number>, maxSteps = 50_000_000): void {
    if (this.halted) return;
    const startDepth = this.frames.length;
    const startLine = this.currentLine();
    let n = 0;
    while (!this.halted && n++ < maxSteps) {
      this.step();
      if (this.halted) break;
      if (this.hitsBreakpoint(breakpoints)) break;
      if (this.frames.length < startDepth) break; // returned out of the function
      if (this.frames.length === startDepth) {
        const ln = this.currentLine();
        if (ln !== undefined && ln !== startLine) break; // reached a new source line
      }
    }
  }

  /** Run until the current function returns (frame depth decreases), or a
   *  breakpoint is hit, or the program halts. */
  stepOut(breakpoints?: Set<number>, maxSteps = 50_000_000): void {
    if (this.halted || this.frames.length === 0) return;
    const depth = this.frames.length;
    let n = 0;
    while (!this.halted && n++ < maxSteps) {
      this.step();
      if (this.halted) break;
      if (this.hitsBreakpoint(breakpoints)) break;
      if (this.frames.length < depth) break;
    }
  }

  // --- call / return ---

  private pushCall(wasmFuncIndex: number, args: Value[]): void {
    const defIndex = wasmFuncIndex - this.importCount;
    if (defIndex < 0 || defIndex >= this.mod.codes.length) throw new VMTrap('call to invalid function index');
    const ft = this.mod.types[this.mod.funcTypes[defIndex]];
    const code = this.mod.codes[defIndex];
    const localTypes: ValType[] = [...ft.params, ...code.locals];
    const locals: Value[] = ft.params.map((_, i) => args[i] ?? 0);
    for (const lt of code.locals) locals.push(zeroVal(lt));
    this.frames.push({
      funcName: this.nameOf(wasmFuncIndex),
      defIndex,
      dis: this.disByDef[defIndex],
      pc: 0,
      locals,
      localTypes,
      stack: [],
      ctrl: [],
      resultType: ft.results.length ? ft.results[0] : null,
    });
  }

  private nameOf(wasmFuncIndex: number): string {
    const ex = this.mod.exports.find((x) => x.kind === 0 && x.index === wasmFuncIndex);
    return ex ? ex.name : `func[${wasmFuncIndex}]`;
  }

  private finishFrame(): void {
    const f = this.frames.pop()!;
    let result: Value | undefined;
    if (f.resultType !== null) result = f.stack.pop();
    if (this.frames.length === 0) {
      this.halted = true;
      this.result = typeof result === 'number' ? result : undefined;
    } else if (result !== undefined) {
      this.top().stack.push(result);
    }
  }

  // --- the instruction dispatcher ---

  private exec(): void {
    const f = this.top();
    const ins = f.dis.instrs[f.pc];
    if (!ins) {
      // Fell off the end of the body (the backend appends a trailing `end`, so
      // this is the implicit function return).
      this.finishFrame();
      return;
    }
    this.steps++;
    const s = f.stack;
    switch (ins.op) {
      // ---- control flow ----
      case 0x00:
        throw new VMTrap('unreachable');
      case 0x01: // nop
        f.pc++;
        return;
      case 0x02: // block
        f.ctrl.push({ isLoop: false, contPc: f.pc + 1, endPc: ins.match, baseSP: s.length });
        f.pc++;
        return;
      case 0x03: // loop
        f.ctrl.push({ isLoop: true, contPc: f.pc + 1, endPc: ins.match, baseSP: s.length });
        f.pc++;
        return;
      case 0x04: { // if
        const cond = s.pop() as number;
        f.ctrl.push({ isLoop: false, contPc: f.pc + 1, endPc: ins.match, baseSP: s.length });
        if (cond !== 0) f.pc++;
        else f.pc = ins.elsePc >= 0 ? ins.elsePc + 1 : ins.match;
        return;
      }
      case 0x05: // else (reached by finishing the then-arm: jump to the matching end)
        f.pc = f.ctrl[f.ctrl.length - 1].endPc;
        return;
      case 0x0b: // end
        if (f.ctrl.length === 0) {
          this.finishFrame();
          return;
        }
        f.ctrl.pop();
        f.pc++;
        return;
      case 0x0c: { // br
        this.branch(f, ins.imm);
        return;
      }
      case 0x0d: { // br_if (not emitted, but cheap to support)
        const c = s.pop() as number;
        if (c !== 0) this.branch(f, ins.imm);
        else f.pc++;
        return;
      }
      case 0x0f: { // return
        if (f.resultType !== null) {
          const r = s.pop();
          this.frames.pop();
          if (this.frames.length === 0) {
            this.halted = true;
            this.result = typeof r === 'number' ? r : undefined;
          } else if (r !== undefined) this.top().stack.push(r);
        } else {
          this.frames.pop();
          if (this.frames.length === 0) this.halted = true;
        }
        return;
      }
      case 0x10: { // call
        if (ins.imm < this.importCount) {
          this.hostCall(ins.imm, f);
          f.pc++;
        } else {
          f.pc++; // advance the caller past the call before entering the callee
          const ft = this.mod.types[this.mod.funcTypes[ins.imm - this.importCount]];
          const args = ft.params.map(() => undefined as unknown as Value);
          for (let k = ft.params.length - 1; k >= 0; k--) args[k] = s.pop()!;
          this.pushCall(ins.imm, args);
        }
        return;
      }
      case 0x11: { // call_indirect (type index in ins.imm)
        const slot = s.pop() as number;
        const ft = this.mod.types[ins.imm];
        const args = ft.params.map(() => undefined as unknown as Value);
        for (let k = ft.params.length - 1; k >= 0; k--) args[k] = s.pop()!;
        const target = this.table[slot];
        if (target === null || target === undefined) throw new VMTrap('uninitialized element (call through a null function pointer)');
        const calleeType = this.mod.types[this.mod.funcTypes[target - this.importCount]];
        if (!sameType(calleeType, ft)) throw new VMTrap('indirect call type mismatch');
        f.pc++;
        this.pushCall(target, args);
        return;
      }

      // ---- locals / globals ----
      case 0x20: s.push(f.locals[ins.imm]); f.pc++; return; // local.get
      case 0x21: f.locals[ins.imm] = s.pop()!; f.pc++; return; // local.set
      case 0x22: f.locals[ins.imm] = s[s.length - 1]; f.pc++; return; // local.tee
      case 0x23: s.push(this.globals[ins.imm].value); f.pc++; return; // global.get
      case 0x24: this.globals[ins.imm].value = s.pop()!; f.pc++; return; // global.set

      // ---- constants ----
      case 0x41: s.push(ins.cv as number); f.pc++; return;
      case 0x42: s.push(ins.cv as bigint); f.pc++; return;
      case 0x43: s.push(Math.fround(ins.cv as number)); f.pc++; return;
      case 0x44: s.push(ins.cv as number); f.pc++; return;

      // ---- memory ----
      case 0x28: { const a = s.pop() as number; s.push(this.memDV.getInt32(a, true)); f.pc++; return; }
      case 0x29: { const a = s.pop() as number; s.push(this.memDV.getBigInt64(a, true)); f.pc++; return; }
      case 0x2a: { const a = s.pop() as number; s.push(this.memDV.getFloat32(a, true)); f.pc++; return; }
      case 0x2b: { const a = s.pop() as number; s.push(this.memDV.getFloat64(a, true)); f.pc++; return; }
      case 0x2d: { const a = s.pop() as number; s.push(this.mem[a]); f.pc++; return; }
      case 0x36: { const v = s.pop() as number; const a = s.pop() as number; this.memDV.setInt32(a, v | 0, true); f.pc++; return; }
      case 0x37: { const v = s.pop() as bigint; const a = s.pop() as number; this.memDV.setBigInt64(a, asI64(v), true); f.pc++; return; }
      case 0x38: { const v = s.pop() as number; const a = s.pop() as number; this.memDV.setFloat32(a, v, true); f.pc++; return; }
      case 0x39: { const v = s.pop() as number; const a = s.pop() as number; this.memDV.setFloat64(a, v, true); f.pc++; return; }
      case 0x3a: { const v = s.pop() as number; const a = s.pop() as number; this.mem[a] = v & 0xff; f.pc++; return; }

      // ---- select ----
      case 0x1b:
      case 0x1c: { // (typed) select
        const cond = s.pop() as number;
        const b = s.pop()!;
        const a = s.pop()!;
        s.push(cond !== 0 ? a : b);
        f.pc++;
        return;
      }

      // ---- SIMD ----
      case 0xfd:
        this.execSimd(ins, s);
        f.pc++;
        return;

      // ---- saturating truncations (0xfc prefix) ----
      case 0xfc: {
        const a = s.pop() as number;
        if (ins.sub === 0x00) s.push(satTruncI32(a)); // i32.trunc_sat_f32_s
        else if (ins.sub === 0x02) s.push(satTruncI32(a)); // i32.trunc_sat_f64_s
        else if (ins.sub === 0x04) s.push(satTruncI64(a)); // i64.trunc_sat_f32_s
        else if (ins.sub === 0x06) s.push(satTruncI64(a)); // i64.trunc_sat_f64_s
        else throw new VMTrap(`unsupported fc.${ins.sub}`);
        f.pc++;
        return;
      }

      // ---- everything else: a plain numeric opcode ----
      default:
        this.execNumeric(ins.op, s);
        f.pc++;
        return;
    }
  }

  private branch(f: Frame, depth: number): void {
    const idx = f.ctrl.length - 1 - depth;
    const target = f.ctrl[idx];
    f.stack.length = target.baseSP; // labels are arity 0 (void block types)
    if (target.isLoop) {
      f.ctrl.length = idx + 1; // keep the loop frame; pop inner scopes
      f.pc = target.contPc;
    } else {
      f.ctrl.length = idx; // exit the block/if scope entirely
      f.pc = target.endPc + 1;
    }
  }

  private hostCall(importIdx: number, f: Frame): void {
    const arg = f.stack.pop();
    const field = this.importFields[importIdx];
    switch (field) {
      case 'print_int': this.output.push(formatInt(arg as number)); break;
      case 'print_long': this.output.push(formatLong(arg as bigint)); break;
      case 'print_float': this.output.push(formatFloat(arg as number)); break;
      case 'print_bool': this.output.push(formatBool(arg as number)); break;
      case 'print_str': this.output.push(this.readStr(arg as number)); break;
      default: throw new VMTrap(`unknown import '${field}'`);
    }
  }

  private readStr(ptr: number): string {
    const len = this.memDV.getInt32(ptr, true);
    let str = '';
    for (let i = 0; i < len; i++) str += String.fromCharCode(this.mem[ptr + 8 + i]);
    return str;
  }

  // --- scalar numeric opcodes ---
  private execNumeric(op: number, s: Value[]): void {
    // i32 comparisons
    if (op >= 0x46 && op <= 0x4e) { const b = s.pop() as number, a = s.pop() as number; s.push(icmp32(op, a, b)); return; }
    // i64 comparisons
    if (op >= 0x51 && op <= 0x59) { const b = s.pop() as bigint, a = s.pop() as bigint; s.push(icmp64(op, a, b)); return; }
    // f32 comparisons
    if (op >= 0x5b && op <= 0x60) { const b = s.pop() as number, a = s.pop() as number; s.push(fcmp(op - 0x5b, a, b)); return; }
    // f64 comparisons
    if (op >= 0x61 && op <= 0x66) { const b = s.pop() as number, a = s.pop() as number; s.push(fcmp(op - 0x61, a, b)); return; }

    switch (op) {
      // i32 unary
      case 0x45: s.push((s.pop() as number) === 0 ? 1 : 0); return; // i32.eqz
      case 0x67: s.push(clz32(s.pop() as number)); return;
      case 0x68: s.push(ctz32(s.pop() as number)); return;
      case 0x69: s.push(popcnt32(s.pop() as number)); return;
      // i64 unary
      case 0x79: s.push(clz64(s.pop() as bigint)); return;
      case 0x7a: s.push(ctz64(s.pop() as bigint)); return;
      case 0x7b: s.push(popcnt64(s.pop() as bigint)); return;
      // f64 unary
      case 0x99: s.push(Math.abs(s.pop() as number)); return;
      case 0x9b: s.push(Math.ceil(s.pop() as number)); return;
      case 0x9c: s.push(Math.floor(s.pop() as number)); return;
      case 0x9d: s.push(Math.trunc(s.pop() as number)); return;
      case 0x9e: s.push(nearestEven(s.pop() as number)); return;
      case 0x9f: s.push(Math.sqrt(s.pop() as number)); return;
      // conversions
      case 0xa7: s.push(Number(BigInt.asIntN(32, s.pop() as bigint))); return; // i32.wrap_i64
      case 0xac: s.push(asI64(BigInt(s.pop() as number))); return; // i64.extend_i32_s
      case 0xb2: s.push(Math.fround(s.pop() as number)); return; // f32.convert_i32_s
      case 0xb4: s.push(Math.fround(Number(s.pop() as bigint))); return; // f32.convert_i64_s
      case 0xb6: s.push(Math.fround(s.pop() as number)); return; // f32.demote_f64
      case 0xb7: s.push(s.pop() as number); return; // f64.convert_i32_s (exact)
      case 0xb9: s.push(Number(s.pop() as bigint)); return; // f64.convert_i64_s
      case 0xbb: s.push(s.pop() as number); return; // f64.promote_f32 (exact)
      case 0xbd: { _sgnDV.setFloat64(0, s.pop() as number, true); s.push(_sgnDV.getBigInt64(0, true)); return; } // i64.reinterpret_f64
      case 0xbf: { _sgnDV.setBigInt64(0, s.pop() as bigint, true); s.push(_sgnDV.getFloat64(0, true)); return; } // f64.reinterpret_i64
    }

    // i32 binary
    if ((op >= 0x6a && op <= 0x78)) { const b = s.pop() as number, a = s.pop() as number; s.push(ibin32(op, a, b)); return; }
    // i64 binary
    if ((op >= 0x7c && op <= 0x8a)) { const b = s.pop() as bigint, a = s.pop() as bigint; s.push(ibin64(op, a, b)); return; }
    // f32 binary
    if (op >= 0x92 && op <= 0x98) { const b = s.pop() as number, a = s.pop() as number; s.push(Math.fround(fbin(op - 0x92, a, b))); return; }
    // f64 binary
    if (op >= 0xa0 && op <= 0xa6) { const b = s.pop() as number, a = s.pop() as number; s.push(fbin(op - 0xa0, a, b)); return; }

    throw new VMTrap(`unhandled opcode 0x${op.toString(16)}`);
  }

  // --- SIMD ---
  private execSimd(ins: Instr, s: Value[]): void {
    const sub = ins.sub;
    // v128 memory access — 16 contiguous little-endian bytes. (offset is always 0.)
    if (sub === 0x00) { const a = s.pop() as number; s.push(this.mem.slice(a, a + 16)); return; } // v128.load
    if (sub === 0x0b) { const v = s.pop() as Uint8Array; const a = s.pop() as number; this.mem.set(v, a); return; } // v128.store
    // splat
    if (sub === 0x11) { const x = s.pop() as number; s.push(writeLanes('i32x4', [x, x, x, x])); return; }
    if (sub === 0x12) { const x = s.pop() as bigint; s.push(writeLanes('i64x2', [x, x])); return; }
    if (sub === 0x13) { const x = s.pop() as number; s.push(writeLanes('f32x4', [x, x, x, x])); return; }
    if (sub === 0x14) { const x = s.pop() as number; s.push(writeLanes('f64x2', [x, x])); return; }
    // extract_lane
    if (sub === 0x1b) { s.push(readLanes('i32x4', s.pop() as Uint8Array)[ins.imm] as number); return; }
    if (sub === 0x1d) { s.push(readLanes('i64x2', s.pop() as Uint8Array)[ins.imm] as bigint); return; }
    if (sub === 0x1f) { s.push(readLanes('f32x4', s.pop() as Uint8Array)[ins.imm] as number); return; }
    if (sub === 0x21) { s.push(readLanes('f64x2', s.pop() as Uint8Array)[ins.imm] as number); return; }
    // replace_lane
    if (sub === 0x1c || sub === 0x1e || sub === 0x20 || sub === 0x22) {
      const shape = sub === 0x1c ? 'i32x4' : sub === 0x1e ? 'i64x2' : sub === 0x20 ? 'f32x4' : 'f64x2';
      const x = s.pop() as number | bigint;
      const lanes = readLanes(shape, s.pop() as Uint8Array);
      lanes[ins.imm] = x;
      s.push(writeLanes(shape, lanes));
      return;
    }
    // whole-vector bitwise
    if (sub === 0x4d) { const a = s.pop() as Uint8Array; const r = new Uint8Array(16); for (let i = 0; i < 16; i++) r[i] = ~a[i] & 0xff; s.push(r); return; }
    if (sub === 0x4e || sub === 0x50 || sub === 0x51) {
      const b = s.pop() as Uint8Array, a = s.pop() as Uint8Array, r = new Uint8Array(16);
      for (let i = 0; i < 16; i++) r[i] = sub === 0x4e ? a[i] & b[i] : sub === 0x50 ? a[i] | b[i] : a[i] ^ b[i];
      s.push(r);
      return;
    }
    if (sub === 0x52) { // bitselect: (a & mask) | (b & ~mask)
      const mask = s.pop() as Uint8Array, b = s.pop() as Uint8Array, a = s.pop() as Uint8Array, r = new Uint8Array(16);
      for (let i = 0; i < 16; i++) r[i] = (a[i] & mask[i]) | (b[i] & ~mask[i]);
      s.push(r);
      return;
    }
    // conversions
    if (sub === 0xfa) { const a = readLanes('i32x4', s.pop() as Uint8Array); s.push(writeLanes('f32x4', a.map((x) => Math.fround(x as number)))); return; }
    if (sub === 0xf8) { const a = readLanes('f32x4', s.pop() as Uint8Array); s.push(writeLanes('i32x4', a.map((x) => satTruncI32(x as number)))); return; }

    const name = SIMD_OP_NAME[sub];
    if (!name) throw new VMTrap(`unsupported SIMD op 0x${sub.toString(16)}`);
    const dot = name.indexOf('.');
    const shape = name.slice(0, dot);
    const op = name.slice(dot + 1);

    // unary lanewise
    if (op === 'abs' || op === 'neg' || op === 'sqrt') {
      const a = readLanes(shape, s.pop() as Uint8Array);
      s.push(writeLanes(shape, a.map((x) => simdUnary(op, x))));
      return;
    }
    // comparisons → integer all-ones / zero mask
    if (['eq', 'ne', 'lt_s', 'gt_s', 'le_s', 'ge_s', 'lt', 'gt', 'le', 'ge'].includes(op)) {
      const b = readLanes(shape, s.pop() as Uint8Array);
      const a = readLanes(shape, s.pop() as Uint8Array);
      const intShape = shape === 'f64x2' || shape === 'i64x2' ? 'i64x2' : 'i32x4';
      const ones: number | bigint = intShape === 'i64x2' ? -1n : -1;
      const zero: number | bigint = intShape === 'i64x2' ? 0n : 0;
      s.push(writeLanes(intShape, a.map((x, i) => (simdCmp(op, x, b[i]) ? ones : zero))));
      return;
    }
    // binary lanewise arithmetic
    const b = readLanes(shape, s.pop() as Uint8Array);
    const a = readLanes(shape, s.pop() as Uint8Array);
    s.push(writeLanes(shape, a.map((x, i) => simdBin(op, x, b[i]))));
  }

  // --- snapshot for the UI ---
  state(): VMState {
    const frames = this.frames.map((f) => {
      const pos = this.posAt(f.defIndex, f.pc);
      return {
        funcName: f.funcName,
        defIndex: f.defIndex,
        pc: f.pc,
        line: f.pc,
        lines: f.dis.lines,
        srcLine: pos?.line,
        srcCol: pos?.col,
        locals: f.locals.map((v, i) => ({ name: `local ${i}`, ty: f.localTypes[i], value: fmtValue(v, f.localTypes[i]) })),
        stack: f.stack.map((v, i) => ({ name: `${i}`, ty: tyOf(v), value: fmtValue(v, tyOf(v)) })),
      };
    });
    let used = 0;
    for (let i = this.mem.length - 1; i >= 0; i--) if (this.mem[i] !== 0) { used = i + 1; break; }
    return {
      steps: this.steps,
      halted: this.halted,
      trap: this.trap,
      result: this.result,
      output: this.output,
      frames,
      srcLine: this.currentLine(),
      globals: this.globals.map((g, i) => ({ name: `global ${i}`, ty: g.type, value: fmtValue(g.value, g.type) })),
      memory: this.mem,
      memUsed: used,
    };
  }
}

// --- pure opcode helpers -----------------------------------------------------

function icmp32(op: number, a: number, b: number): number {
  switch (op) {
    case 0x46: return a === b ? 1 : 0;
    case 0x47: return a !== b ? 1 : 0;
    case 0x48: return a < b ? 1 : 0;
    case 0x4a: return a > b ? 1 : 0;
    case 0x4c: return a <= b ? 1 : 0;
    case 0x4e: return a >= b ? 1 : 0;
  }
  return 0;
}
function icmp64(op: number, a: bigint, b: bigint): number {
  switch (op) {
    case 0x51: return a === b ? 1 : 0;
    case 0x52: return a !== b ? 1 : 0;
    case 0x53: return a < b ? 1 : 0;
    case 0x55: return a > b ? 1 : 0;
    case 0x57: return a <= b ? 1 : 0;
    case 0x59: return a >= b ? 1 : 0;
  }
  return 0;
}
// shared f32/f64 comparison (index 0..5 = eq ne lt gt le ge)
function fcmp(idx: number, a: number, b: number): number {
  switch (idx) {
    case 0: return a === b ? 1 : 0;
    case 1: return a !== b ? 1 : 0;
    case 2: return a < b ? 1 : 0;
    case 3: return a > b ? 1 : 0;
    case 4: return a <= b ? 1 : 0;
    case 5: return a >= b ? 1 : 0;
  }
  return 0;
}
function ibin32(op: number, a: number, b: number): number {
  switch (op) {
    case 0x6a: return (a + b) | 0;
    case 0x6b: return (a - b) | 0;
    case 0x6c: return Math.imul(a, b);
    case 0x6d: // div_s
      if (b === 0) throw new VMTrap('integer divide by zero');
      if (a === I32_MIN && b === -1) throw new VMTrap('integer overflow');
      return toI32(Math.trunc(a / b));
    case 0x6f: // rem_s
      if (b === 0) throw new VMTrap('integer divide by zero');
      if (a === I32_MIN && b === -1) return 0;
      return (a % b) | 0;
    case 0x71: return a & b;
    case 0x72: return a | b;
    case 0x73: return a ^ b;
    case 0x74: return a << (b & 31);
    case 0x75: return a >> (b & 31);
    case 0x77: return rotl32(a, b);
    case 0x78: return rotr32(a, b);
  }
  return 0;
}
function ibin64(op: number, a: bigint, b: bigint): bigint {
  switch (op) {
    case 0x7c: return asI64(a + b);
    case 0x7d: return asI64(a - b);
    case 0x7e: return asI64(a * b);
    case 0x7f: // div_s
      if (b === 0n) throw new VMTrap('integer divide by zero');
      if (a === I64_MIN && b === -1n) throw new VMTrap('integer overflow');
      return asI64(a / b);
    case 0x81: // rem_s
      if (b === 0n) throw new VMTrap('integer divide by zero');
      if (a === I64_MIN && b === -1n) return 0n;
      return asI64(a % b);
    case 0x83: return asI64(a & b);
    case 0x84: return asI64(a | b);
    case 0x85: return asI64(a ^ b);
    case 0x86: return asI64(a << (b & 63n));
    case 0x87: return asI64(a >> (b & 63n));
    case 0x89: return rotl64(a, b);
    case 0x8a: return rotr64(a, b);
  }
  return 0n;
}
// shared f32/f64 binary (index 0..6 = add sub mul div min max copysign)
function fbin(idx: number, a: number, b: number): number {
  switch (idx) {
    case 0: return a + b;
    case 1: return a - b;
    case 2: return a * b;
    case 3: return a / b;
    case 4: return Math.min(a, b);
    case 5: return Math.max(a, b);
    case 6: return copysign(a, b);
  }
  return 0;
}

function simdUnary(op: string, x: number | bigint): number | bigint {
  if (op === 'abs') return typeof x === 'bigint' ? (x < 0n ? -x : x) : Math.abs(x);
  if (op === 'neg') return typeof x === 'bigint' ? -x : -x;
  if (op === 'sqrt') return Math.sqrt(x as number);
  return x;
}
function simdBin(op: string, a: number | bigint, b: number | bigint): number | bigint {
  if (typeof a === 'bigint') {
    const bb = b as bigint;
    switch (op) { case 'add': return a + bb; case 'sub': return a - bb; case 'mul': return a * bb; }
    return a;
  }
  const bb = b as number;
  switch (op) {
    case 'add': return a + bb;
    case 'sub': return a - bb;
    case 'mul': return a * bb;
    case 'div': return a / bb;
    case 'min': return Math.min(a, bb);
    case 'max': return Math.max(a, bb);
    case 'min_s': return Math.min(a, bb);
    case 'max_s': return Math.max(a, bb);
  }
  return a;
}
function simdCmp(op: string, a: number | bigint, b: number | bigint): boolean {
  switch (op) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'lt_s': case 'lt': return a < b;
    case 'gt_s': case 'gt': return a > b;
    case 'le_s': case 'le': return a <= b;
    case 'ge_s': case 'ge': return a >= b;
  }
  return false;
}

// SIMD sub-opcode → mnemonic, for the arithmetic / compare dispatch above.
const SIMD_OP_NAME: Record<number, string> = {
  0xa0: 'i32x4.abs', 0xa1: 'i32x4.neg', 0xae: 'i32x4.add', 0xb1: 'i32x4.sub', 0xb5: 'i32x4.mul', 0xb6: 'i32x4.min_s', 0xb8: 'i32x4.max_s',
  0xc0: 'i64x2.abs', 0xc1: 'i64x2.neg', 0xce: 'i64x2.add', 0xd1: 'i64x2.sub', 0xd5: 'i64x2.mul',
  0xe0: 'f32x4.abs', 0xe1: 'f32x4.neg', 0xe3: 'f32x4.sqrt', 0xe4: 'f32x4.add', 0xe5: 'f32x4.sub', 0xe6: 'f32x4.mul', 0xe7: 'f32x4.div', 0xe8: 'f32x4.min', 0xe9: 'f32x4.max',
  0xec: 'f64x2.abs', 0xed: 'f64x2.neg', 0xef: 'f64x2.sqrt', 0xf0: 'f64x2.add', 0xf1: 'f64x2.sub', 0xf2: 'f64x2.mul', 0xf3: 'f64x2.div', 0xf4: 'f64x2.min', 0xf5: 'f64x2.max',
  0x37: 'i32x4.eq', 0x38: 'i32x4.ne', 0x39: 'i32x4.lt_s', 0x3b: 'i32x4.gt_s', 0x3d: 'i32x4.le_s', 0x3f: 'i32x4.ge_s',
  0xd6: 'i64x2.eq', 0xd7: 'i64x2.ne', 0xd8: 'i64x2.lt_s', 0xd9: 'i64x2.gt_s', 0xda: 'i64x2.le_s', 0xdb: 'i64x2.ge_s',
  0x41: 'f32x4.eq', 0x42: 'f32x4.ne', 0x43: 'f32x4.lt', 0x44: 'f32x4.gt', 0x45: 'f32x4.le', 0x46: 'f32x4.ge',
  0x47: 'f64x2.eq', 0x48: 'f64x2.ne', 0x49: 'f64x2.lt', 0x4a: 'f64x2.gt', 0x4b: 'f64x2.le', 0x4c: 'f64x2.ge',
};

function sameType(a: { params: ValType[]; results: ValType[] }, b: { params: ValType[]; results: ValType[] }): boolean {
  return a.params.length === b.params.length && a.results.length === b.results.length &&
    a.params.every((p, i) => p === b.params[i]) && a.results.every((r, i) => r === b.results[i]);
}

function tyOf(v: Value): ValType {
  if (typeof v === 'bigint') return 'i64';
  if (v instanceof Uint8Array) return 'v128';
  return 'i32'; // a float and an i32 are indistinguishable as JS numbers on the stack
}

function fmtValue(v: Value, ty: ValType): string {
  if (v instanceof Uint8Array) return '[' + Array.from(readLanes('i32x4', v) as number[], (x) => (x >>> 0).toString(16).padStart(8, '0')).join(' ') + ']';
  if (ty === 'i64') return formatLong(v as bigint);
  if (ty === 'f64' || ty === 'f32') return formatFloat(v as number);
  return formatInt(v as number);
}

/** Decode + instantiate + run to completion. The third differential oracle. */
export interface VMRunResult {
  output: string[];
  result: number | undefined;
  error?: string;
}
export function runOnVm(bytes: Uint8Array, entry = 'main', args: Value[] = []): VMRunResult {
  try {
    const mod = decodeModule(bytes);
    const vm = new WasmVM(mod, entry, args);
    vm.runToEnd();
    return { output: vm.output, result: vm.result, error: vm.trap };
  } catch (e) {
    return { output: [], result: undefined, error: (e as Error).message };
  }
}
