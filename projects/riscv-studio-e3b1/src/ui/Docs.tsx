// The ISA reference page: instruction groups, pseudo-instructions, directives, syscalls,
// the register ABI, and the memory map. Most of it is generated from the same tables the
// assembler and CPU use, so it can't drift out of date.

import { ABI_NAMES, REG_ROLES } from '../vm/registers';
import { SYSCALLS } from '../vm/syscalls';
import { DATA_BASE, FB_BASE, GLOBAL_POINTER, STACK_TOP, TEXT_BASE } from '../vm/constants';
import { hexWord } from '../vm/format';

interface InsDoc {
  m: string;
  desc: string;
}

const GROUPS: { title: string; items: InsDoc[] }[] = [
  {
    title: 'Integer register-register (R-type)',
    items: [
      { m: 'add / sub', desc: 'rd = rs1 ± rs2' },
      { m: 'and / or / xor', desc: 'bitwise logic' },
      { m: 'sll / srl / sra', desc: 'shift left / right logical / right arithmetic by rs2[4:0]' },
      { m: 'slt / sltu', desc: 'set-less-than, signed / unsigned (rd = 1 or 0)' },
    ],
  },
  {
    title: 'Integer register-immediate (I-type)',
    items: [
      { m: 'addi', desc: 'rd = rs1 + sext(imm12)' },
      { m: 'andi / ori / xori', desc: 'bitwise logic with a 12-bit immediate' },
      { m: 'slli / srli / srai', desc: 'shift by a 5-bit immediate' },
      { m: 'slti / sltiu', desc: 'set-less-than against an immediate' },
    ],
  },
  {
    title: 'Upper immediate',
    items: [
      { m: 'lui rd, imm20', desc: 'rd = imm20 << 12' },
      { m: 'auipc rd, imm20', desc: 'rd = pc + (imm20 << 12)' },
    ],
  },
  {
    title: 'Loads & stores',
    items: [
      { m: 'lb / lh / lw', desc: 'load 8/16/32-bit, sign-extended' },
      { m: 'lbu / lhu', desc: 'load 8/16-bit, zero-extended' },
      { m: 'sb / sh / sw', desc: 'store 8/16/32-bit  —  sw rs2, off(rs1)' },
    ],
  },
  {
    title: 'Control flow',
    items: [
      { m: 'beq / bne', desc: 'branch if (not) equal' },
      { m: 'blt / bge', desc: 'branch if signed < / ≥' },
      { m: 'bltu / bgeu', desc: 'branch if unsigned < / ≥' },
      { m: 'jal rd, label', desc: 'jump and link: rd = pc+4, pc = label' },
      { m: 'jalr rd, off(rs1)', desc: 'indirect jump and link' },
    ],
  },
  {
    title: 'M extension (multiply / divide)',
    items: [
      { m: 'mul', desc: 'low 32 bits of rs1 × rs2' },
      { m: 'mulh / mulhu / mulhsu', desc: 'high 32 bits (signed / unsigned / mixed)' },
      { m: 'div / divu', desc: 'signed / unsigned division (÷0 → −1)' },
      { m: 'rem / remu', desc: 'signed / unsigned remainder (rem ÷0 → dividend)' },
    ],
  },
  {
    title: 'System',
    items: [
      { m: 'ecall', desc: 'environment call — dispatched on a7 (see syscalls)' },
      { m: 'ebreak', desc: 'breakpoint — pauses the debugger' },
      { m: 'fence', desc: 'memory fence (a no-op on this single-hart machine)' },
    ],
  },
];

const PSEUDO: InsDoc[] = [
  { m: 'li rd, imm', desc: 'load any 32-bit immediate (addi, or lui+addi)' },
  { m: 'la rd, sym', desc: 'load the address of a label (lui+addi)' },
  { m: 'mv rd, rs', desc: 'addi rd, rs, 0' },
  { m: 'nop', desc: 'addi x0, x0, 0' },
  { m: 'not / neg rd, rs', desc: 'bitwise / arithmetic negation' },
  { m: 'seqz / snez / sltz / sgtz', desc: 'set rd from a comparison with zero' },
  { m: 'j / jr / ret', desc: 'unconditional / register / return jumps' },
  { m: 'call sym', desc: 'lui+jalr; sets ra' },
  { m: 'beqz / bnez / blez / bgez / bltz / bgtz', desc: 'branch comparing rs against zero' },
  { m: 'bgt / ble / bgtu / bleu', desc: 'branches with swapped operands' },
];

const DIRECTIVES: InsDoc[] = [
  { m: '.text / .data', desc: 'select the code / data segment' },
  { m: '.word / .half / .byte', desc: 'emit 32 / 16 / 8-bit values (.word accepts labels)' },
  { m: '.string / .asciz', desc: 'emit a NUL-terminated string' },
  { m: '.ascii', desc: 'emit a string without a terminator' },
  { m: '.space N / .zero N', desc: 'reserve N zero bytes' },
  { m: '.align n / .balign N', desc: 'align to 2ⁿ / N bytes' },
  { m: '.equ NAME, v  ·  NAME = v', desc: 'define an assembler constant' },
  { m: '.globl name', desc: 'mark a symbol global (accepted, informational)' },
];

export default function Docs() {
  return (
    <div className="panel docs">
      <div className="panel-head">
        <h2>RV32IM reference</h2>
      </div>
      <div className="docs-scroll">
        <p className="docs-intro">
          This studio implements the <strong>RV32I</strong> base integer ISA plus the{' '}
          <strong>M</strong> (multiply/divide) extension — every instruction below executes on
          the built-in interpreter. The assembler accepts the full pseudo-instruction set and
          common GNU/RARS directives.
        </p>

        {GROUPS.map((grp) => (
          <section key={grp.title}>
            <h3>{grp.title}</h3>
            <table className="doc-table">
              <tbody>
                {grp.items.map((it) => (
                  <tr key={it.m}>
                    <td className="doc-m">{it.m}</td>
                    <td className="doc-d">{it.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}

        <section>
          <h3>Pseudo-instructions</h3>
          <table className="doc-table">
            <tbody>
              {PSEUDO.map((it) => (
                <tr key={it.m}>
                  <td className="doc-m">{it.m}</td>
                  <td className="doc-d">{it.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3>Assembler directives</h3>
          <table className="doc-table">
            <tbody>
              {DIRECTIVES.map((it) => (
                <tr key={it.m}>
                  <td className="doc-m">{it.m}</td>
                  <td className="doc-d">{it.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3>Syscalls (ecall — number in a7, argument in a0)</h3>
          <table className="doc-table">
            <tbody>
              {SYSCALLS.map((sc) => (
                <tr key={sc.id}>
                  <td className="doc-m">
                    a7={sc.id} · {sc.name}
                  </td>
                  <td className="doc-d">{sc.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3>Register ABI</h3>
          <table className="doc-table reg-doc">
            <tbody>
              {ABI_NAMES.map((name, i) => (
                <tr key={i}>
                  <td className="doc-m">
                    x{i} / {name}
                  </td>
                  <td className="doc-d">{REG_ROLES[i]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3>Memory map</h3>
          <table className="doc-table">
            <tbody>
              <tr>
                <td className="doc-m">{hexWord(TEXT_BASE)}</td>
                <td className="doc-d">.text — assembled code is linked here</td>
              </tr>
              <tr>
                <td className="doc-m">{hexWord(DATA_BASE)}</td>
                <td className="doc-d">.data — globals; the initial gp = {hexWord(GLOBAL_POINTER)}</td>
              </tr>
              <tr>
                <td className="doc-m">{hexWord(FB_BASE)}</td>
                <td className="doc-d">framebuffer — 128×128 palette bytes (MMIO)</td>
              </tr>
              <tr>
                <td className="doc-m">{hexWord(STACK_TOP)}</td>
                <td className="doc-d">initial sp — the stack grows downward</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
