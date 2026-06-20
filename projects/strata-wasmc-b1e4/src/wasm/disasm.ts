// Decode a single function body (raw bytes from the code section) into a flat
// array of instructions, with the structured-control-flow scopes resolved to
// explicit jump targets and a human-readable listing for the debugger. This is
// the bridge between the binary (`decode.ts`) and the stack machine (`vm.ts`):
// the VM executes this instruction array, and the debugger highlights the line
// at the program counter.
//
// The compiler emits only structured control flow with *void* block types, so
// every label has arity 0 — nothing flows across a branch on the operand stack.
// That single fact makes branch handling trivial: a `br` just truncates the
// operand stack to the target scope's base height and jumps.

import { Reader } from './decode';

export interface Instr {
  op: number; // primary opcode byte
  sub: number; // sub-opcode for the 0xfc (numeric) / 0xfd (SIMD) prefixes, else -1
  imm: number; // generic integer immediate (idx / depth / lane), else 0
  cv: number | bigint; // const payload for i32/i64/f32/f64.const
  // Structured-control links, filled by `link()`:
  match: number; // block/loop/if: instruction index of the matching `end`
  elsePc: number; // if: index of the matching `else`, else -1
  depth: number; // nesting depth (for listing indentation)
  text: string; // disassembly mnemonic
}

export interface Disasm {
  instrs: Instr[];
  /** One text line per instruction (parallel to `instrs`), indented by depth. */
  lines: string[];
}

// Mnemonics for the single-byte numeric opcodes the backend emits. Anything not
// here is given a generic `op 0xNN` name (never reached for emitted code).
const NUM_NAMES: Record<number, string> = {
  // comparisons
  0x45: 'i32.eqz',
  0x46: 'i32.eq', 0x47: 'i32.ne', 0x48: 'i32.lt_s', 0x4a: 'i32.gt_s', 0x4c: 'i32.le_s', 0x4e: 'i32.ge_s',
  0x51: 'i64.eq', 0x52: 'i64.ne', 0x53: 'i64.lt_s', 0x55: 'i64.gt_s', 0x57: 'i64.le_s', 0x59: 'i64.ge_s',
  0x5b: 'f32.eq', 0x5c: 'f32.ne', 0x5d: 'f32.lt', 0x5e: 'f32.gt', 0x5f: 'f32.le', 0x60: 'f32.ge',
  0x61: 'f64.eq', 0x62: 'f64.ne', 0x63: 'f64.lt', 0x64: 'f64.gt', 0x65: 'f64.le', 0x66: 'f64.ge',
  // i32 arithmetic / bitwise
  0x67: 'i32.clz', 0x68: 'i32.ctz', 0x69: 'i32.popcnt',
  0x6a: 'i32.add', 0x6b: 'i32.sub', 0x6c: 'i32.mul', 0x6d: 'i32.div_s', 0x6f: 'i32.rem_s',
  0x71: 'i32.and', 0x72: 'i32.or', 0x73: 'i32.xor', 0x74: 'i32.shl', 0x75: 'i32.shr_s', 0x77: 'i32.rotl', 0x78: 'i32.rotr',
  // i64 arithmetic / bitwise
  0x79: 'i64.clz', 0x7a: 'i64.ctz', 0x7b: 'i64.popcnt',
  0x7c: 'i64.add', 0x7d: 'i64.sub', 0x7e: 'i64.mul', 0x7f: 'i64.div_s', 0x81: 'i64.rem_s',
  0x83: 'i64.and', 0x84: 'i64.or', 0x85: 'i64.xor', 0x86: 'i64.shl', 0x87: 'i64.shr_s', 0x89: 'i64.rotl', 0x8a: 'i64.rotr',
  // f32 / f64 arithmetic
  0x92: 'f32.add', 0x93: 'f32.sub', 0x94: 'f32.mul', 0x95: 'f32.div', 0x96: 'f32.min', 0x97: 'f32.max', 0x98: 'f32.copysign',
  0x99: 'f64.abs', 0x9b: 'f64.ceil', 0x9c: 'f64.floor', 0x9d: 'f64.trunc', 0x9e: 'f64.nearest', 0x9f: 'f64.sqrt',
  0xa0: 'f64.add', 0xa1: 'f64.sub', 0xa2: 'f64.mul', 0xa3: 'f64.div', 0xa4: 'f64.min', 0xa5: 'f64.max', 0xa6: 'f64.copysign',
  // conversions
  0xa7: 'i32.wrap_i64', 0xac: 'i64.extend_i32_s',
  0xb2: 'f32.convert_i32_s', 0xb4: 'f32.convert_i64_s', 0xb6: 'f32.demote_f64',
  0xb7: 'f64.convert_i32_s', 0xb9: 'f64.convert_i64_s', 0xbb: 'f64.promote_f32',
  0xbd: 'i64.reinterpret_f64', 0xbf: 'f64.reinterpret_i64',
};
const LOAD_NAMES: Record<number, string> = {
  0x28: 'i32.load', 0x29: 'i64.load', 0x2a: 'f32.load', 0x2b: 'f64.load', 0x2d: 'i32.load8_u',
};
const STORE_NAMES: Record<number, string> = {
  0x36: 'i32.store', 0x37: 'i64.store', 0x38: 'f32.store', 0x39: 'f64.store', 0x3a: 'i32.store8',
};
const TRUNC_SAT_NAMES: Record<number, string> = {
  0x00: 'i32.trunc_sat_f32_s', 0x02: 'i32.trunc_sat_f64_s', 0x04: 'i64.trunc_sat_f32_s', 0x06: 'i64.trunc_sat_f64_s',
};
// SIMD sub-opcode → mnemonic (the inverse of codegen's `SIMD` table).
const SIMD_NAMES: Record<number, string> = {
  0x11: 'i32x4.splat', 0x12: 'i64x2.splat', 0x13: 'f32x4.splat', 0x14: 'f64x2.splat',
  0x1b: 'i32x4.extract_lane', 0x1c: 'i32x4.replace_lane', 0x1d: 'i64x2.extract_lane', 0x1e: 'i64x2.replace_lane',
  0x1f: 'f32x4.extract_lane', 0x20: 'f32x4.replace_lane', 0x21: 'f64x2.extract_lane', 0x22: 'f64x2.replace_lane',
  0xa0: 'i32x4.abs', 0xa1: 'i32x4.neg', 0xae: 'i32x4.add', 0xb1: 'i32x4.sub', 0xb5: 'i32x4.mul', 0xb6: 'i32x4.min_s', 0xb8: 'i32x4.max_s',
  0xc0: 'i64x2.abs', 0xc1: 'i64x2.neg', 0xce: 'i64x2.add', 0xd1: 'i64x2.sub', 0xd5: 'i64x2.mul',
  0xe0: 'f32x4.abs', 0xe1: 'f32x4.neg', 0xe3: 'f32x4.sqrt', 0xe4: 'f32x4.add', 0xe5: 'f32x4.sub', 0xe6: 'f32x4.mul', 0xe7: 'f32x4.div', 0xe8: 'f32x4.min', 0xe9: 'f32x4.max',
  0xec: 'f64x2.abs', 0xed: 'f64x2.neg', 0xef: 'f64x2.sqrt', 0xf0: 'f64x2.add', 0xf1: 'f64x2.sub', 0xf2: 'f64x2.mul', 0xf3: 'f64x2.div', 0xf4: 'f64x2.min', 0xf5: 'f64x2.max',
  0x4d: 'v128.not', 0x4e: 'v128.and', 0x50: 'v128.or', 0x51: 'v128.xor', 0x52: 'v128.bitselect',
  0x37: 'i32x4.eq', 0x38: 'i32x4.ne', 0x39: 'i32x4.lt_s', 0x3b: 'i32x4.gt_s', 0x3d: 'i32x4.le_s', 0x3f: 'i32x4.ge_s',
  0xd6: 'i64x2.eq', 0xd7: 'i64x2.ne', 0xd8: 'i64x2.lt_s', 0xd9: 'i64x2.gt_s', 0xda: 'i64x2.le_s', 0xdb: 'i64x2.ge_s',
  0x41: 'f32x4.eq', 0x42: 'f32x4.ne', 0x43: 'f32x4.lt', 0x44: 'f32x4.gt', 0x45: 'f32x4.le', 0x46: 'f32x4.ge',
  0x47: 'f64x2.eq', 0x48: 'f64x2.ne', 0x49: 'f64x2.lt', 0x4a: 'f64x2.gt', 0x4b: 'f64x2.le', 0x4c: 'f64x2.ge',
  0xfa: 'f32x4.convert_i32x4_s', 0xf8: 'i32x4.trunc_sat_f32x4_s',
};
// SIMD sub-opcodes that carry a one-byte lane immediate (extract / replace lane).
const SIMD_LANE = new Set([0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22]);

const VT_NAME: Record<number, string> = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128' };

function mk(op: number): Instr {
  return { op, sub: -1, imm: 0, cv: 0, match: -1, elsePc: -1, depth: 0, text: '' };
}

/** Decode + structure-link a function body into an executable instruction array. */
export function disassemble(body: Uint8Array): Disasm {
  const r = new Reader(body);
  const instrs: Instr[] = [];

  while (!r.eof) {
    const op = r.u8();
    const ins = mk(op);
    switch (op) {
      case 0x00: ins.text = 'unreachable'; break;
      case 0x0f: ins.text = 'return'; break;
      case 0x01: ins.text = 'nop'; break;
      case 0x02: r.u8(); ins.text = 'block'; break; // skip blocktype (0x40)
      case 0x03: r.u8(); ins.text = 'loop'; break;
      case 0x04: r.u8(); ins.text = 'if'; break;
      case 0x05: ins.text = 'else'; break;
      case 0x0b: ins.text = 'end'; break;
      case 0x0c: ins.imm = r.u32(); ins.text = `br ${ins.imm}`; break;
      case 0x0d: ins.imm = r.u32(); ins.text = `br_if ${ins.imm}`; break;
      case 0x10: ins.imm = r.u32(); ins.text = `call ${ins.imm}`; break;
      case 0x11: ins.imm = r.u32(); r.u32(); ins.text = `call_indirect (type ${ins.imm})`; break;
      case 0x1b: ins.text = 'select'; break;
      case 0x1c: { r.u32(); ins.sub = r.u8(); ins.text = `select (result ${VT_NAME[ins.sub]})`; break; }
      case 0x20: ins.imm = r.u32(); ins.text = `local.get ${ins.imm}`; break;
      case 0x21: ins.imm = r.u32(); ins.text = `local.set ${ins.imm}`; break;
      case 0x22: ins.imm = r.u32(); ins.text = `local.tee ${ins.imm}`; break;
      case 0x23: ins.imm = r.u32(); ins.text = `global.get ${ins.imm}`; break;
      case 0x24: ins.imm = r.u32(); ins.text = `global.set ${ins.imm}`; break;
      case 0x41: ins.cv = r.i32(); ins.text = `i32.const ${ins.cv}`; break;
      case 0x42: ins.cv = r.i64(); ins.text = `i64.const ${ins.cv}`; break;
      case 0x43: ins.cv = r.f32(); ins.text = `f32.const ${ins.cv}`; break;
      case 0x44: ins.cv = r.f64(); ins.text = `f64.const ${ins.cv}`; break;
      case 0xfc: { ins.sub = r.u32(); ins.text = TRUNC_SAT_NAMES[ins.sub] ?? `fc.${ins.sub}`; break; }
      case 0xfd: {
        ins.sub = r.u32();
        if (SIMD_LANE.has(ins.sub)) ins.imm = r.u8();
        ins.text = (SIMD_NAMES[ins.sub] ?? `simd.${ins.sub}`) + (SIMD_LANE.has(ins.sub) ? ` ${ins.imm}` : '');
        break;
      }
      default:
        if (LOAD_NAMES[op] !== undefined) { r.u32(); r.u32(); ins.text = LOAD_NAMES[op]; }
        else if (STORE_NAMES[op] !== undefined) { r.u32(); r.u32(); ins.text = STORE_NAMES[op]; }
        else if (NUM_NAMES[op] !== undefined) { ins.text = NUM_NAMES[op]; }
        else throw new Error(`wasm disasm: unhandled opcode 0x${op.toString(16)}`);
        break;
    }
    instrs.push(ins);
  }

  link(instrs);
  const lines = instrs.map((ins) => '  '.repeat(ins.depth) + ins.text);
  return { instrs, lines };
}

// Resolve block/loop/if scopes: match each opener to its `else`/`end`, and record
// nesting depth for the listing's indentation. `end`/`else` are printed at the
// depth of their opener (one level out from the body they close).
function link(instrs: Instr[]): void {
  const stack: number[] = [];
  let depth = 0;
  for (let pc = 0; pc < instrs.length; pc++) {
    const ins = instrs[pc];
    if (ins.op === 0x02 || ins.op === 0x03 || ins.op === 0x04) {
      ins.depth = depth;
      stack.push(pc);
      depth++;
    } else if (ins.op === 0x05) {
      // `else` belongs to the enclosing `if`.
      const opener = stack[stack.length - 1];
      ins.depth = depth - 1;
      if (opener !== undefined) instrs[opener].elsePc = pc;
    } else if (ins.op === 0x0b) {
      const opener = stack.pop();
      depth = Math.max(0, depth - 1);
      ins.depth = depth;
      if (opener !== undefined) instrs[opener].match = pc;
    } else {
      ins.depth = depth;
    }
  }
}
