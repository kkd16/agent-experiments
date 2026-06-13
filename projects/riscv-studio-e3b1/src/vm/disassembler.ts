// Render a decoded instruction as human-readable assembly text.
//
// Used by the disassembly view to show what each word in the .text segment actually is —
// including the synthesised pseudo-instructions a reader expects (a `jal x0, .` shows as
// `j`, `addi x0,x0,0` shows as `nop`, and so on).

import { decode } from './decode';
import type { DecodedInstruction } from './decode';
import { ABI_NAMES } from './registers';
import { hexWord } from './format';

function reg(i: number): string {
  return ABI_NAMES[i];
}

/** Disassemble a raw word. `pc` lets jump/branch targets be shown as absolute addresses. */
export function disassemble(word: number, pc = 0): string {
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
      // Shift-immediate ops carry the shift amount in the rs2 bit-field, not the full imm.
      if (m === 'slli' || m === 'srli' || m === 'srai') {
        return `${m} ${reg(d.rd)}, ${reg(d.rs1)}, ${d.rs2}`;
      }
      if (m === 'addi' && d.rd === 0 && d.rs1 === 0 && d.imm === 0) return 'nop';
      if (m === 'addi' && d.rs1 === 0) return `li ${reg(d.rd)}, ${d.imm}`;
      if (m === 'addi' && d.imm === 0) return `mv ${reg(d.rd)}, ${reg(d.rs1)}`;
      return `${m} ${reg(d.rd)}, ${reg(d.rs1)}, ${d.imm}`;
    case 'R':
      if (m === 'sub' && d.rs1 === 0) return `neg ${reg(d.rd)}, ${reg(d.rs2)}`;
      return `${m} ${reg(d.rd)}, ${reg(d.rs1)}, ${reg(d.rs2)}`;
    case 'SYS':
      return m;
    case 'FENCE':
      return 'fence';
    default:
      return `.word ${hexWord(d.raw)}`;
  }
}
