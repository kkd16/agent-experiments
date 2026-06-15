// The ISA reference page: instruction groups, pseudo-instructions, directives, syscalls,
// the register ABI, and the memory map. Most of it is generated from the same tables the
// assembler and CPU use, so it can't drift out of date.

import { ABI_NAMES, REG_ROLES, FREG_ABI_NAMES, FREG_ROLES } from '../vm/registers';
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
    title: 'F extension — single-precision float (RV32F)',
    items: [
      { m: 'flw / fsw', desc: 'load / store a 32-bit float  —  flw fd, off(rs1)' },
      { m: 'fadd / fsub / fmul / fdiv .s', desc: 'IEEE-754 arithmetic on f-registers' },
      { m: 'fsqrt.s', desc: 'square root' },
      { m: 'fmadd / fmsub / fnmadd / fnmsub .s', desc: 'fused multiply-add (rd = ±rs1·rs2 ± rs3)' },
      { m: 'fmin / fmax .s', desc: 'minimum / maximum (NaN- and ±0-aware)' },
      { m: 'fsgnj / fsgnjn / fsgnjx .s', desc: 'sign-injection (basis of fmv/fneg/fabs.s)' },
      { m: 'feq / flt / fle .s', desc: 'compares → an integer 0/1 in rd' },
      { m: 'fcvt.w.s / fcvt.wu.s', desc: 'float → signed / unsigned int (saturating)' },
      { m: 'fcvt.s.w / fcvt.s.wu', desc: 'signed / unsigned int → float' },
      { m: 'fmv.x.w / fmv.w.x', desc: 'copy raw bits between an x- and an f-register' },
      { m: 'fclass.s', desc: 'classify rs1 → a 10-bit mask in rd' },
    ],
  },
  {
    title: 'A extension — atomics (RV32A)',
    items: [
      { m: 'lr.w / sc.w', desc: 'load-reserved / store-conditional (sc → 0 on success)' },
      { m: 'amoswap.w', desc: 'atomic swap; rd = old memory value' },
      { m: 'amoadd / amoand / amoor / amoxor .w', desc: 'atomic read-modify-write; rd = old value' },
      { m: 'amomin / amomax / amominu / amomaxu .w', desc: 'atomic signed / unsigned min & max' },
    ],
  },
  {
    title: 'Zicsr — control & status registers',
    items: [
      { m: 'csrrw / csrrs / csrrc', desc: 'atomic read-then-write / set-bits / clear-bits' },
      { m: 'csrrwi / csrrsi / csrrci', desc: 'the same, with a 5-bit immediate' },
      { m: 'cycle / time / instret', desc: 'read-only hardware counters (plus the high words)' },
      { m: 'fcsr / frm / fflags', desc: 'float control: rounding mode + accrued exceptions' },
    ],
  },
  {
    title: 'C extension — compressed 16-bit instructions (RV32C)',
    items: [
      { m: 'c.addi / c.li / c.lui', desc: 'compressed add-immediate / load-immediate / load-upper' },
      { m: 'c.addi16sp / c.addi4spn', desc: 'stack-pointer adjust / frame slot address' },
      { m: 'c.mv / c.add / c.sub / c.and / c.or / c.xor', desc: 'register-register ALU (c.sub/and/or/xor use x8–x15)' },
      { m: 'c.andi / c.slli / c.srli / c.srai', desc: 'immediate logic & shifts' },
      { m: 'c.lw / c.sw / c.lwsp / c.swsp', desc: 'word load/store (compact regs, or sp-relative)' },
      { m: 'c.j / c.jal / c.jr / c.jalr', desc: 'compressed jumps (link writes pc+2)' },
      { m: 'c.beqz / c.bnez', desc: 'compare a compact register against zero & branch' },
      { m: 'c.nop / c.ebreak / c.unimp', desc: 'compressed no-op / breakpoint / trap' },
    ],
  },
  {
    title: 'Privileged — machine-mode traps & interrupts',
    items: [
      { m: 'mret', desc: 'return from a trap: restore MIE from MPIE, pc ← mepc' },
      { m: 'wfi', desc: 'wait-for-interrupt (advances; the timer keeps ticking)' },
      { m: 'mstatus / mie / mip', desc: 'global & per-source interrupt enable / pending bits' },
      { m: 'mtvec / mepc / mcause / mtval', desc: 'trap vector, return pc, cause code, faulting value' },
      { m: 'mscratch / mhartid / misa', desc: 'scratch word, hart id (0), ISA string (RV32IMAFC)' },
    ],
  },
  {
    title: 'System',
    items: [
      { m: 'ecall', desc: 'environment call — dispatched on a7 (or traps to mtvec when armed)' },
      { m: 'ebreak', desc: 'breakpoint — pauses the debugger (or traps when a handler is installed)' },
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
  { m: 'fmv.s / fneg.s / fabs.s', desc: 'float copy / negate / absolute (via fsgnj*.s)' },
  { m: 'rdcycle / rdtime / rdinstret', desc: 'read a hardware counter into rd' },
  { m: 'csrr / csrw / csrs / csrc', desc: 'read / write / set / clear a CSR' },
  { m: 'frcsr / fscsr / frrm / fsrm / frflags / fsflags', desc: 'float CSR read/write shorthands' },
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
  { m: '.option rvc / norvc', desc: 'enable / disable automatic RV32C compression for the file' },
];

export default function Docs() {
  return (
    <div className="panel docs">
      <div className="panel-head">
        <h2>RV32IMAFC + Zicsr reference</h2>
      </div>
      <div className="docs-scroll">
        <p className="docs-intro">
          This studio implements the <strong>RV32I</strong> base integer ISA plus the{' '}
          <strong>M</strong> (multiply/divide), <strong>A</strong> (atomics),{' '}
          <strong>F</strong> (single-precision float) and <strong>C</strong> (compressed 16-bit)
          extensions, together with <strong>Zicsr</strong>, the hardware counters, and a
          machine-mode <strong>trap &amp; interrupt</strong> architecture — every instruction below
          executes on the built-in interpreter. Float ops take an optional rounding-mode operand
          (<code>rne·rtz·rdn·rup·rmm·dyn</code>); the debugger can also <strong>step backward</strong>{' '}
          to undo instructions one at a time. The assembler accepts the full pseudo-instruction
          set and common GNU/RARS directives.
        </p>
        <section>
          <h3>The C (compressed) extension</h3>
          <p className="docs-intro">
            RV32C gives the 26 most common instructions a 16-bit alias, so real binaries are
            ~25–30% smaller. Two ways to use it here: write <code>c.*</code> mnemonics by hand, or
            let the assembler shrink eligible instructions for you — flip the{' '}
            <strong>Compress (RVC)</strong> toolbar toggle or add <code>.option rvc</code> to your
            source. Compressed and 32-bit instructions interleave freely (IALIGN = 16); the
            Disassembly tab shows each instruction's true width, and behaviour is identical either
            way (the verification suite proves it with a differential check).
          </p>
        </section>
        <section>
          <h3>Machine-mode traps &amp; interrupts</h3>
          <p className="docs-intro">
            Install a handler address in <code>mtvec</code>, enable interrupts in{' '}
            <code>mstatus</code>/<code>mie</code>, and the machine takes real traps: synchronous
            exceptions (illegal instruction, <code>ebreak</code>, misaligned load/store) and
            asynchronous interrupts from a memory-mapped <strong>CLINT</strong>. A trap saves the
            pc to <code>mepc</code>, the reason to <code>mcause</code>, and vectors to{' '}
            <code>mtvec</code>; <code>mret</code> returns. The CLINT lives at{' '}
            <code>{hexWord(0x0200_0000)}</code>: <code>msip</code> (software interrupt) at +0x0,{' '}
            <code>mtimecmp</code> at +0x4000, and the 64-bit <code>mtime</code> at +0xbff8. When{' '}
            <code>mtime ≥ mtimecmp</code> the timer interrupt (mcause 7) fires; the studio advances{' '}
            <code>mtime</code> by one per instruction so timers are fully deterministic.
          </p>
        </section>

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
          <h3>Float register ABI (RV32F)</h3>
          <table className="doc-table reg-doc">
            <tbody>
              {FREG_ABI_NAMES.map((name, i) => (
                <tr key={i}>
                  <td className="doc-m">
                    f{i} / {name}
                  </td>
                  <td className="doc-d">{FREG_ROLES[i]}</td>
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

        <section>
          <h3>The C compiler (Compiler tab)</h3>
          <p className="docs-intro">
            The <strong>Compiler</strong> tab is a from-scratch C compiler that lowers a
            statically-typed subset of C to the very RV32IM the assembler above accepts — lex →
            parse → type-check → codegen, all in the browser. Generated assembly is handed to
            this same assembler and run on this same CPU, so you can <em>Open in Assembler</em>{' '}
            and single-step the compiled output. The calling convention is the standard one
            (args in <code>a0–a7</code> then the stack, return value in <code>a0</code>, a real
            saved-<code>ra</code>/<code>fp</code> frame).
          </p>
          <table className="doc-table">
            <tbody>
              <tr>
                <td className="doc-m">types</td>
                <td className="doc-d">int (32-bit), char (8-bit), void, pointers, arrays, struct, function pointers</td>
              </tr>
              <tr>
                <td className="doc-m">statements</td>
                <td className="doc-d">if/else, while, do/while, for, return, break, continue, blocks, locals</td>
              </tr>
              <tr>
                <td className="doc-m">operators</td>
                <td className="doc-d">full C set incl. ++/--, ?:, &amp;&amp;/||, all compound assigns, comma, sizeof, casts</td>
              </tr>
              <tr>
                <td className="doc-m">structs</td>
                <td className="doc-d">members, <code>.</code> / <code>-&gt;</code>, layout + alignment, pointers-to-struct</td>
              </tr>
              <tr>
                <td className="doc-m">library</td>
                <td className="doc-d">a self-hosted mini-libc (written in C): printf (%d %u %x %c %s %%), malloc, memset/memcpy, strlen/strcmp/strcpy, putchar/print_int/print_str, rand, exit</td>
              </tr>
              <tr>
                <td className="doc-m">variadics</td>
                <td className="doc-d">va_list / va_start / va_arg — printf is ordinary C compiled by the same pipeline</td>
              </tr>
            </tbody>
          </table>
          <p className="docs-intro">
            The lowest-level primitives (<code>__sys_print_int</code>, <code>__sys_sbrk</code>, …)
            are builtins the back end expands inline to <code>ecall</code> sequences; everything
            else — including printf and its <code>va_arg</code> loop — is plain C linked in front
            of your program. The <strong>C Verify</strong> panel compiles, assembles, runs, and
            diffs the stdout of a battery of real programs (recursion, sieve, quicksort, linked
            lists, …) to prove the pipeline end to end.
          </p>
        </section>
      </div>
    </div>
  );
}
