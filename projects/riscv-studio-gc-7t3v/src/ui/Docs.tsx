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
    title: 'D extension — double-precision float (RV32D)',
    items: [
      { m: 'fld / fsd', desc: 'load / store a 64-bit double — fld fd, off(rs1)' },
      { m: 'fadd / fsub / fmul / fdiv .d', desc: 'IEEE-754 double arithmetic' },
      { m: 'fsqrt.d', desc: 'double square root' },
      { m: 'fmadd / fmsub / fnmadd / fnmsub .d', desc: 'fused multiply-add in double' },
      { m: 'fmin / fmax .d', desc: 'minimum / maximum (NaN- and ±0-aware)' },
      { m: 'fsgnj / fsgnjn / fsgnjx .d', desc: 'sign-injection (fmv/fneg/fabs.d)' },
      { m: 'feq / flt / fle .d', desc: 'compares → an integer 0/1 in rd' },
      { m: 'fcvt.w.d / fcvt.wu.d', desc: 'double → signed / unsigned int (saturating)' },
      { m: 'fcvt.d.w / fcvt.d.wu', desc: 'signed / unsigned int → double' },
      { m: 'fcvt.s.d / fcvt.d.s', desc: 'narrow double → single / widen single → double' },
      { m: 'fclass.d', desc: 'classify rs1 → a 10-bit mask in rd' },
    ],
  },
  {
    title: 'C extension — compressed 16-bit instructions (RV32C)',
    items: [
      { m: 'c.li / c.lui / c.mv', desc: 'load small immediate / upper immediate / register copy' },
      { m: 'c.addi / c.addi16sp / c.addi4spn', desc: 'add immediate; stack-pointer adjust forms' },
      { m: 'c.add / c.sub / c.and / c.or / c.xor', desc: 'register-register ALU (rd = rd op rs2)' },
      { m: 'c.slli / c.srli / c.srai / c.andi', desc: 'shifts & andi by an immediate' },
      { m: 'c.lw / c.sw / c.lwsp / c.swsp', desc: 'word load/store (rs1′-based or sp-based)' },
      { m: 'c.flw / c.fsw / c.fld / c.fsd (+sp)', desc: 'compressed float (F) and double (D) load/store' },
      { m: 'c.j / c.jal / c.jr / c.jalr', desc: 'compressed jumps (c.jal/c.jalr link pc+2)' },
      { m: 'c.beqz / c.bnez', desc: 'branch on (non-)zero against a 3-bit register' },
      { m: 'c.nop / c.ebreak', desc: 'compressed no-op / breakpoint' },
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
    title: 'Machine-mode traps & interrupts',
    items: [
      { m: 'mstatus', desc: 'MIE (global enable), MPIE (previous), MPP (previous mode)' },
      { m: 'mtvec', desc: 'trap-vector base (+ mode: 0 = direct, 1 = vectored for interrupts)' },
      { m: 'mepc / mcause / mtval', desc: 'saved pc / cause (bit 31 = interrupt) / trap value' },
      { m: 'mie / mip', desc: 'interrupt enable / pending (MTIE/MTIP = machine timer)' },
      { m: 'mscratch / mhartid / misa', desc: 'scratch word / hart id (0) / ISA id (read-only)' },
      { m: 'mret', desc: 'return from trap: restore MIE from MPIE, jump to mepc' },
      { m: 'wfi', desc: 'wait-for-interrupt (a no-op here; the timer keeps ticking)' },
      { m: 'mtime / mtimecmp', desc: 'CLINT MMIO 64-bit timer & compare (0x0200_bff8 / 0x0200_4000)' },
    ],
  },
  {
    title: 'Supervisor mode & Sv32 virtual memory',
    items: [
      { m: 'satp', desc: 'address translation: MODE[31] (0=Bare, 1=Sv32) · ASID · root PPN[21:0]' },
      { m: 'sstatus', desc: 'a restricted view of mstatus (SIE/SPIE/SPP/SUM/MXR)' },
      { m: 'stvec / sepc / scause / stval', desc: 'supervisor trap vector / pc / cause / value' },
      { m: 'sie / sip / sscratch', desc: 'supervisor interrupt enable / pending / scratch' },
      { m: 'medeleg / mideleg', desc: 'cause bitmaps: which traps are handled in S- instead of M-mode' },
      { m: 'sret', desc: 'return from a supervisor trap: restore SIE from SPIE, drop to SPP' },
      { m: 'sfence.vma', desc: 'flush the (incoherent) TLB after editing a page table' },
    ],
  },
  {
    title: 'System',
    items: [
      { m: 'ecall', desc: 'environment call: a host syscall from M-mode, an exception from S/U' },
      { m: 'ebreak', desc: 'breakpoint — pauses the debugger' },
      { m: 'mret', desc: 'return from a machine trap: restore MIE from MPIE, drop to MPP' },
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
  { m: 'fmv.d / fneg.d / fabs.d', desc: 'double copy / negate / absolute (via fsgnj*.d)' },
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
  { m: '.option rvc / norvc', desc: 'enable / disable automatic RV32C compression (= the ⊟ RVC toggle)' },
];

export default function Docs() {
  return (
    <div className="panel docs">
      <div className="panel-head">
        <h2>RV32GC (IMAFDC) + Zicsr · M/S/U + Sv32 reference</h2>
      </div>
      <div className="docs-scroll">
        <p className="docs-intro">
          This studio implements the <strong>RV32I</strong> base integer ISA plus the{' '}
          <strong>M</strong> (multiply/divide), <strong>A</strong> (atomics),{' '}
          <strong>F</strong>/<strong>D</strong> (single- and double-precision float) and{' '}
          <strong>C</strong> (16-bit compressed) extensions, together with <strong>Zicsr</strong>,
          the hardware counters, <strong>traps &amp; interrupts</strong>, all three{' '}
          <strong>privilege modes</strong> (M/S/U) and <strong>Sv32 virtual memory</strong> — every
          instruction below executes on the built-in interpreter. Compressed (<code>c.*</code>)
          instructions are decoded and disassembled inline; float ops take an optional
          rounding-mode operand (<code>rne·rtz·rdn·rup·rmm·dyn</code>); and the debugger can
          <strong> step backward</strong> to undo instructions one at a time. The assembler
          accepts the full pseudo-instruction set and common GNU/RARS directives, and the
          <strong> ⊟ RVC</strong> toggle (or <code>.option rvc</code>) auto-compresses eligible
          instructions to 16-bit forms, shrinking code the way a real <code>-march=…c</code>{' '}
          toolchain does.
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
                <td className="doc-m">0x02000000</td>
                <td className="doc-d">CLINT — mtimecmp (+0x4000) &amp; mtime (+0xbff8), the machine timer (MMIO)</td>
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
          <h3>Privilege modes &amp; Sv32 paging (the MMU tab)</h3>
          <p className="docs-intro">
            The hart runs at one of three privilege levels — <strong>M</strong>achine,{' '}
            <strong>S</strong>upervisor, <strong>U</strong>ser — shown live on the{' '}
            <strong>MMU</strong> tab and in the register inspector. A program starts in M-mode.{' '}
            <code>mret</code>/<code>sret</code> drop to the privilege held in{' '}
            <code>mstatus.MPP</code>/<code>SPP</code>, so an M-mode boot stub can hand control to
            a supervisor, which can in turn enter user code.
          </p>
          <p className="docs-intro">
            Synchronous exceptions (page faults, illegal instructions, environment calls) and the
            timer interrupt trap to M-mode by default, but each cause can be{' '}
            <strong>delegated</strong> to S-mode through <code>medeleg</code>/<code>mideleg</code>.
            An <code>ecall</code> from M-mode is the studio&rsquo;s host syscall ABI (so every
            existing program is unchanged); from S- or U-mode it is a real{' '}
            <em>environment-call exception</em> (cause 9 / 8), letting an operating system build
            its own syscall layer — the <em>Sv32 virtual memory</em> example does exactly that with
            an M-mode &ldquo;supervisor-call gate&rdquo;.
          </p>
          <p className="docs-intro">
            When <code>satp.MODE = Sv32</code> and the effective privilege is S or U, every fetch
            and load/store is translated by a two-level <strong>Sv32</strong> page-table walk:{' '}
            <code>VA = vpn1(10) · vpn0(10) · offset(12)</code>. A level-1 leaf is a 4&nbsp;MiB
            superpage; a level-0 leaf is a 4&nbsp;KiB page. Each PTE carries{' '}
            <code>V R W X U G A D</code> permission bits; a violation raises an instruction
            (12), load (13) or store (15) <strong>page fault</strong> with the faulting address in{' '}
            <code>*tval</code>. <code>SUM</code> lets supervisor code touch user pages and{' '}
            <code>MXR</code> makes execute-only pages readable. Translations are cached in a small{' '}
            <strong>TLB</strong> that, like real hardware, is <em>not</em> kept coherent with
            page-table writes — software must issue <code>sfence.vma</code> (or rewrite{' '}
            <code>satp</code>) to flush it. The MMU tab probes any virtual address and shows the
            walk PTE-by-PTE, the resulting physical address (or fault), and the TLB&rsquo;s
            contents and hit-rate.
          </p>
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
