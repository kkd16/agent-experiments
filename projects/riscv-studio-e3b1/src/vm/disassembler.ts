// Render a decoded instruction as human-readable assembly text.
//
// Used by the disassembly view to show what each word in the .text segment actually is —
// including the synthesised pseudo-instructions a reader expects (a `jal x0, .` shows as
// `j`, `addi x0,x0,0` shows as `nop`, and so on).

import { decode } from './decode';
import type { DecodedInstruction } from './decode';
import { ABI_NAMES, FREG_ABI_NAMES } from './registers';
import { hexWord, signExtend } from './format';
import { FP_SPECS, RM_NAMES } from './fp';
import { CSR_NUMBERS, ZB_UNARY_MNEMONICS, ZB_SHIFT_IMM_MNEMONICS } from './isa';
import { VEC_SPECS, vmemSpec, vtypeTokens } from './vector';
import { formatCompressed } from './rvc';

function reg(i: number): string {
  return ABI_NAMES[i];
}

function freg(i: number): string {
  return FREG_ABI_NAMES[i];
}

const CSR_NAME_BY_ADDR: Record<number, string> = Object.fromEntries(
  Object.entries(CSR_NUMBERS).map(([name, addr]) => [addr, name]),
);

/**
 * Disassemble a raw instruction. `pc` lets jump/branch targets be shown as absolute
 * addresses. `size` is the encoded length: 2 selects the compressed (`c.*`) renderer.
 */
export function disassemble(word: number, pc = 0, size = 4): string {
  if (size === 2) return formatCompressed(word & 0xffff, pc);
  const d = decode(word);
  return render(d, pc);
}

function render(d: DecodedInstruction, pc: number): string {
  const m = d.mnemonic;
  switch (d.format) {
    case 'U':
      return `${m} ${reg(d.rd)}, 0x${(d.imm >>> 12).toString(16)}`;
    case 'J': {
      // jal x0, off → j ; jal x1, off → jal
      const target = hexWord((pc + d.imm) >>> 0);
      if (d.rd === 0) return `j ${target}`;
      if (d.rd === 1) return `jal ${target}`;
      return `jal ${reg(d.rd)}, ${target}`;
    }
    case 'B': {
      const target = hexWord((pc + d.imm) >>> 0);
      return `${m} ${reg(d.rs1)}, ${reg(d.rs2)}, ${target}`;
    }
    case 'S':
      return `${m} ${reg(d.rs2)}, ${d.imm}(${reg(d.rs1)})`;
    case 'I':
      if (d.opcode === 0x03) return `${m} ${reg(d.rd)}, ${d.imm}(${reg(d.rs1)})`; // loads
      if (m === 'jalr') {
        if (d.rd === 0 && d.imm === 0 && d.rs1 === 1) return 'ret';
        if (d.rd === 0 && d.imm === 0) return `jr ${reg(d.rs1)}`;
        return `jalr ${reg(d.rd)}, ${d.imm}(${reg(d.rs1)})`;
      }
      // Single-operand Zbb ops (clz/ctz/cpop/sext.b/sext.h/orc.b/rev8) take just `rd, rs1`.
      if (ZB_UNARY_MNEMONICS.has(m)) return `${m} ${reg(d.rd)}, ${reg(d.rs1)}`;
      // Shift-immediate ops carry the shift amount in the rs2 bit-field, not the full imm.
      if (m === 'slli' || m === 'srli' || m === 'srai' || ZB_SHIFT_IMM_MNEMONICS.has(m)) {
        return `${m} ${reg(d.rd)}, ${reg(d.rs1)}, ${d.rs2}`;
      }
      if (m === 'addi' && d.rd === 0 && d.rs1 === 0 && d.imm === 0) return 'nop';
      if (m === 'addi' && d.rs1 === 0) return `li ${reg(d.rd)}, ${d.imm}`;
      if (m === 'addi' && d.imm === 0) return `mv ${reg(d.rd)}, ${reg(d.rs1)}`;
      return `${m} ${reg(d.rd)}, ${reg(d.rs1)}, ${d.imm}`;
    case 'R':
      if (m === 'sub' && d.rs1 === 0) return `neg ${reg(d.rd)}, ${reg(d.rs2)}`;
      // zext.h is the one R-type Zbb op with a single source operand.
      if (m === 'zext.h') return `zext.h ${reg(d.rd)}, ${reg(d.rs1)}`;
      return `${m} ${reg(d.rd)}, ${reg(d.rs1)}, ${reg(d.rs2)}`;
    case 'SYS':
      return m;
    case 'FENCE':
      return 'fence';
    case 'FP':
      return renderFp(d);
    case 'V':
      return renderVector(d);
    case 'AMO':
      return renderAmo(d);
    case 'CSR':
      return renderCsr(d);
    default:
      return `.word ${hexWord(d.raw)}`;
  }
}

/** Append a rounding-mode suffix when it isn't the default (dynamic). */
function rmSuffix(d: DecodedInstruction): string {
  const spec = FP_SPECS[d.mnemonic];
  if (!spec?.hasRm || d.funct3 === 7) return '';
  return `, ${RM_NAMES[d.funct3] ?? d.funct3}`;
}

function renderFp(d: DecodedInstruction): string {
  const m = d.mnemonic;
  const spec = FP_SPECS[m];
  if (!spec) return `.word ${hexWord(d.raw)}`;
  switch (spec.kind) {
    case 'load':
      return `${m} ${freg(d.rd)}, ${d.imm}(${reg(d.rs1)})`;
    case 'store':
      return `${m} ${freg(d.rs2)}, ${d.imm}(${reg(d.rs1)})`;
    case 'r-rm':
      return `${m} ${freg(d.rd)}, ${freg(d.rs1)}, ${freg(d.rs2)}${rmSuffix(d)}`;
    case 'sqrt':
      return `${m} ${freg(d.rd)}, ${freg(d.rs1)}${rmSuffix(d)}`;
    case 'sgnj':
      // fsgnj rd, rs, rs disassembles to the friendly fmv/fneg/fabs pseudo.
      if (d.rs1 === d.rs2) {
        if (m === 'fsgnj.s') return `fmv.s ${freg(d.rd)}, ${freg(d.rs1)}`;
        if (m === 'fsgnjn.s') return `fneg.s ${freg(d.rd)}, ${freg(d.rs1)}`;
        if (m === 'fsgnjx.s') return `fabs.s ${freg(d.rd)}, ${freg(d.rs1)}`;
        if (m === 'fsgnj.d') return `fmv.d ${freg(d.rd)}, ${freg(d.rs1)}`;
        if (m === 'fsgnjn.d') return `fneg.d ${freg(d.rd)}, ${freg(d.rs1)}`;
        if (m === 'fsgnjx.d') return `fabs.d ${freg(d.rd)}, ${freg(d.rs1)}`;
      }
      return `${m} ${freg(d.rd)}, ${freg(d.rs1)}, ${freg(d.rs2)}`;
    case 'minmax':
      return `${m} ${freg(d.rd)}, ${freg(d.rs1)}, ${freg(d.rs2)}`;
    case 'cmp':
      return `${m} ${reg(d.rd)}, ${freg(d.rs1)}, ${freg(d.rs2)}`;
    case 'cvt.w':
      return `${m} ${reg(d.rd)}, ${freg(d.rs1)}${rmSuffix(d)}`;
    case 'cvt.s':
      return `${m} ${freg(d.rd)}, ${reg(d.rs1)}${rmSuffix(d)}`;
    case 'cvt.ff':
      return `${m} ${freg(d.rd)}, ${freg(d.rs1)}${rmSuffix(d)}`;
    case 'mv.x':
    case 'fclass':
      return `${m} ${reg(d.rd)}, ${freg(d.rs1)}`;
    case 'mv.f':
      return `${m} ${freg(d.rd)}, ${reg(d.rs1)}`;
    case 'fma':
      return `${m} ${freg(d.rd)}, ${freg(d.rs1)}, ${freg(d.rs2)}, ${freg(d.rs3)}${rmSuffix(d)}`;
  }
}

function renderVector(d: DecodedInstruction): string {
  const w = d.raw >>> 0;
  const m = d.mnemonic;
  const vd = (w >>> 7) & 0x1f;
  const s1 = (w >>> 15) & 0x1f;
  const vs2 = (w >>> 20) & 0x1f;
  const vm = (w >>> 25) & 1;
  const V = (n: number) => `v${n}`;
  const tail = vm === 0 ? ', v0.t' : '';

  if (m === 'vsetvli') return `vsetvli ${reg(vd)}, ${reg(s1)}, ${vtypeTokens((w >>> 20) & 0x7ff)}`;
  if (m === 'vsetivli') return `vsetivli ${reg(vd)}, ${s1}, ${vtypeTokens((w >>> 20) & 0x3ff)}`;
  if (m === 'vsetvl') return `vsetvl ${reg(vd)}, ${reg(s1)}, ${reg(vs2)}`;

  const mem = vmemSpec(m);
  if (mem) {
    if (mem.kind === 'unit' || mem.kind === 'mask') return `${m} ${V(vd)}, (${reg(s1)})${tail}`;
    if (mem.kind === 'strided') return `${m} ${V(vd)}, (${reg(s1)}), ${reg(vs2)}${tail}`;
    return `${m} ${V(vd)}, (${reg(s1)}), ${V(vs2)}${tail}`;
  }

  const spec = VEC_SPECS[m];
  if (!spec) return `.word ${hexWord(d.raw)}`;
  const simm = signExtend(s1, 5);
  switch (spec.form) {
    case 'vv':
    case 'vs':
      return `${m} ${V(vd)}, ${V(vs2)}, ${V(s1)}${tail}`;
    case 'vx':
      return `${m} ${V(vd)}, ${V(vs2)}, ${reg(s1)}${tail}`;
    case 'vi':
      return `${m} ${V(vd)}, ${V(vs2)}, ${simm}${tail}`;
    case 'vviu':
      return `${m} ${V(vd)}, ${V(vs2)}, ${s1}${tail}`;
    case 'macvv':
      return `${m} ${V(vd)}, ${V(s1)}, ${V(vs2)}${tail}`;
    case 'macvx':
      return `${m} ${V(vd)}, ${reg(s1)}, ${V(vs2)}${tail}`;
    case 'mm':
      return `${m} ${V(vd)}, ${V(vs2)}, ${V(s1)}`;
    case 'vvm':
      return `${m} ${V(vd)}, ${V(vs2)}, ${V(s1)}, v0`;
    case 'vxm':
      return `${m} ${V(vd)}, ${V(vs2)}, ${reg(s1)}, v0`;
    case 'vim':
      return `${m} ${V(vd)}, ${V(vs2)}, ${simm}, v0`;
    case 'movv':
      return `${m} ${V(vd)}, ${V(s1)}`;
    case 'movx':
      return `${m} ${V(vd)}, ${reg(s1)}`;
    case 'movi':
      return `${m} ${V(vd)}, ${simm}`;
    case 'wxs':
      return `${m} ${reg(vd)}, ${V(vs2)}`;
    case 'wsx':
      return `${m} ${V(vd)}, ${reg(s1)}`;
    case 'pop':
      return `${m} ${reg(vd)}, ${V(vs2)}${tail}`;
    case 'vid':
      return `${m} ${V(vd)}${tail}`;
    case 'mvs2':
      return `${m} ${V(vd)}, ${V(vs2)}${tail}`;
  }
}

function renderAmo(d: DecodedInstruction): string {
  if (d.mnemonic === 'lr.w') return `${d.mnemonic} ${reg(d.rd)}, (${reg(d.rs1)})`;
  return `${d.mnemonic} ${reg(d.rd)}, ${reg(d.rs2)}, (${reg(d.rs1)})`;
}

function renderCsr(d: DecodedInstruction): string {
  const csr = CSR_NAME_BY_ADDR[d.imm] ?? `0x${d.imm.toString(16)}`;
  const imm = d.mnemonic.endsWith('i');
  // csrr/csrw pseudo forms read nicer.
  if (d.mnemonic === 'csrrs' && d.rs1 === 0) return `csrr ${reg(d.rd)}, ${csr}`;
  if (d.mnemonic === 'csrrw' && d.rd === 0) return `csrw ${csr}, ${reg(d.rs1)}`;
  if (imm) return `${d.mnemonic} ${reg(d.rd)}, ${csr}, ${d.rs1}`;
  return `${d.mnemonic} ${reg(d.rd)}, ${csr}, ${reg(d.rs1)}`;
}
