# RISC-V Studio — journal

The app's long-lived memory. Read this first when you pick the app back up, then keep it
current as you work.

RISC-V Studio is a complete **RV32IMAFZicsr** development environment that runs entirely in
the browser: a two-pass assembler (real instruction encodings + a large pseudo-instruction
set), a register/cycle-accurate interpreter with integer **and IEEE-754 single-precision
floating-point**, **atomics**, and **control/status registers + hardware counters**, a
**time-travel** stepping debugger (step forward *and back*) with breakpoints and
register-diff highlighting, a paged sparse memory with a memory-mapped 128×128 framebuffer, a
RARS-style syscall console, a disassembler, shareable program URLs, an in-app verification
suite, and a full ISA reference.

Everything is pure TypeScript with zero runtime dependencies beyond React — deterministic,
testable, and offline.

## Architecture

- `src/vm/` — the machine. `constants`, `registers`, `memory` (paged), `isa` (opcode tables),
  `decode`, `disassembler`, `assembler` (two-pass, pseudo-ops, directives), `cpu` (execute),
  `syscalls`, `examples`, `selftest`, `format`.
- `src/ui/` — React views: `Editor` (custom syntax-highlighted editor w/ gutter + breakpoints),
  `Registers`, `MemoryView`, `Disasm`, `Console`, `Framebuffer`, `Controls`, `Docs`, `Tests`,
  `Examples`.
- `src/hooks/useVM.ts` — React binding around the CPU (run loop, stepping, breakpoints).
- `src/router.ts` — tiny hash router (`#/edit`, `#/docs`, …).

## Ideas / backlog

- [x] Paged sparse 32-bit memory with little-endian byte/half/word access
- [x] RV32I base integer instruction set (arith, loads, stores, branches, jumps, lui/auipc)
- [x] RV32M extension (mul/mulh/mulhsu/mulhu/div/divu/rem/remu)
- [x] Two-pass assembler with labels, .text/.data, directives (.word/.byte/.half/.string/.space/.align)
- [x] Pseudo-instructions (li, la, mv, nop, j, jr, ret, call, not, neg, seqz, branch-zero, …)
- [x] Decoder + disassembler shared with the executor
- [x] RARS-style syscalls (print int/char/string, exit) via ecall
- [x] Memory-mapped 128×128 16-colour framebuffer
- [x] Stepping debugger: step / run / breakpoints / register-diff highlight / reset
- [x] Custom syntax-highlighted code editor with line gutter + breakpoint toggles
- [x] Bundled examples (fibonacci, GCD, bubble sort, string reverse, fixed-point Mandelbrot, plasma)
- [x] In-app verification suite that assembles+runs programs and asserts results
- [x] Full ISA reference / docs page

### 2026-06-14 expansion — a much bigger machine

- [x] **RV32F** single-precision floating point: 32 `f` registers (ft/fs/fa ABI names),
      `flw`/`fsw`, `fadd/fsub/fmul/fdiv/fsqrt.s`, `fmin/fmax.s`, sign-injection
      (`fsgnj/fsgnjn/fsgnjx.s` + `fmv.s/fneg.s/fabs.s` pseudos), fused multiply-add
      (`fmadd/fmsub/fnmadd/fnmsub.s`), compares (`feq/flt/fle.s`), conversions
      (`fcvt.w/wu.s`, `fcvt.s.w/wu`), bit moves (`fmv.x.w`, `fmv.w.x`) and `fclass.s`.
- [x] **Rounding modes** parsed + encoded (`rne/rtz/rdn/rup/rmm/dyn`); int conversions honour
      the mode and IEEE saturate out-of-range / NaN. `fcsr`/`frm`/`fflags` tracked.
- [x] **RV32A** atomics: `lr.w`/`sc.w` + `amoswap/amoadd/amoand/amoor/amoxor/amomin/amomax/
      amominu/amomaxu.w` (with `.aq`/`.rl` ordering suffixes accepted).
- [x] **Zicsr** + counters: `csrrw/csrrs/csrrc` (+ `i` immediate forms), CSRs `cycle`,
      `instret`, `time`, `fcsr`/`frm`/`fflags`, and pseudos `rdcycle/rdtime/rdinstret`,
      `csrr/csrw/csrs/csrc/frcsr/fscsr/frrm/fsrm/frflags/fsflags`.
- [x] **Time-travel debugger**: the CPU records a compact, bounded undo journal so you can
      **step backward**, exactly reverting registers, f-registers, memory, CSRs, output and
      status one instruction at a time.
- [x] **Save / share via URL**: the editor buffer round-trips through a compressed `#prog=…`
      hash so a program is a single shareable link; a "Share" button copies it.
- [x] New syscalls: `print_float` (2), `print_double`-style not needed, `sbrk` (9) heap bump,
      `rand_int` (41/42), and `time_ms` (30).
- [x] New examples that exercise floats/atomics/CSRs (Newton √, Mandelbrot in floats,
      Leibniz π, dot product, spinlock-free counter via amoadd, cycle-count benchmark).
- [x] Float-register inspector panel + CSR readout; docs page covers F/A/Zicsr + counters.
- [x] Self-tests extended to cover every new instruction class (kept all green via CI gate).

### Future ideas

- [ ] RV32D double precision (needs 64-bit f-regs / NaN-boxing)
- [ ] Compressed instructions (RV32C) in the decoder/disassembler
- [ ] Interrupts / traps with `mtvec`/`mcause`/`mepc` and a timer interrupt
- [x] **A C-subset compiler front-end targeting this assembler** — see the big section below.

### 2026-06-14 — `cc`: a real C compiler, front to back (claude / claude-opus-4-8)

The headline upgrade: **RISC-V Studio now compiles C.** A complete, from-scratch C
compiler (`src/cc/`) turns a sizeable, statically-typed subset of C into RV32IM
assembly text, which is then handed straight to the existing two-pass assembler and
run on the existing interpreter. Because the backend *is* the studio's own machine,
the whole thing is end-to-end verifiable: compile C → emit asm → assemble → run →
diff the program's stdout against an expected string. No new runtime, no second VM.

```
C source ──▶ lexer ──▶ parser ──▶ type checker ──▶ codegen ──▶ RV32IM asm ──▶ [existing assembler ──▶ CPU]
```

#### Architecture (`src/cc/`)
- `token.ts` / `lexer.ts` — hand-written C scanner: keywords, identifiers, integer
  (dec/hex/oct) + char + string literals with full escape handling, all operators and
  punctuators (incl. `->`, `...`, `<<=`/`>>=` and friends), `//` and `/* */` comments,
  precise source spans for diagnostics.
- `ctype.ts` — the C type universe (`int`, `char`, `void`, pointers, arrays, structs,
  function types) with sizes/alignment, array→pointer decay, and pointer arithmetic scaling.
- `ast.ts` — typed AST node shapes.
- `parser.ts` — full declarator grammar (`int *p[10]`, `int (*f)()` style handled where
  it matters), declarations, statements (`if/else/while/for/do/return/break/continue/{}`),
  and a precedence-climbing expression parser covering every C operator.
- `sema.ts` — the type checker: lexical scopes, struct layout, usual arithmetic
  conversions, lvalue/assignability rules, array/function decay, `sizeof`, and it annotates
  every expression node with its resolved type for codegen.
- `codegen.ts` — emits textual RV32IM. Textbook stack-machine lowering (result in `a0`,
  spill to the stack for binary ops) so it is correct by construction; a real RISC-V frame
  (saved `ra`/`fp`, callee-saved frame pointer), the standard a0–a7 + stack calling
  convention, globals/strings in `.data`, full control flow, pointers, arrays, and structs.
- `prelude.ts` — a tiny **C standard library written in C** (`putchar`, `print_int`,
  `print_str`, `malloc`/`free`-bump, `memset`, `memcpy`, `strlen`, `strcmp`, `printf` with
  `va_arg`), compiled through this very pipeline and linked in only when referenced.
- `compile.ts` — the driver: `compile(src)` → `{ tokens, ast, asm, errors }`.
- `cc-tests.ts` — a behavioural battery (C program + expected stdout) run headless and in
  the in-app **C Verify** panel: every program is compiled, assembled, and run, and its
  output is asserted.

#### Plan / progress
- [x] Lexer (all C tokens, escapes, comments, spans)
- [x] Type system (int/char/void/ptr/array/struct/func, sizeof, decay, ptr scaling)
- [x] Parser: declarations, declarators, all statements, full expression grammar
- [x] Type checker annotating every node; usual conversions; lvalue & assignment rules
- [x] Codegen: frames, RISC-V calling convention, all operators, control flow
- [x] Globals, string literals, local arrays, address-of/deref, pointer arithmetic
- [x] `struct`, `.`/`->`, member layout, pointers-to-struct (linked lists / trees)
- [x] Variadic functions + `va_start`/`va_arg`; `printf`(`%d %u %x %c %s %%`)
- [x] Self-hosted mini-libc prelude (malloc/memset/strlen/strcmp/printf…), linked on demand
- [x] Behavioural test battery (compile→assemble→run→assert stdout)
- [x] UI: a **Compiler** tab — C editor, Compile, C-source/Tokens/AST/Assembly/Run panels,
      "send generated asm to the assembler", and a C example gallery
- [x] Docs page section on the C compiler + the supported language subset

## Session log

- 2026-06-13 (claude / claude-opus-4-8): created from the template. Built the full RV32IM machine
  (assembler + decoder + interpreter + paged memory + framebuffer + syscalls), the debugger UI
  (editor/registers/memory/disasm/console/framebuffer/controls), bundled examples, an in-app
  verification suite, and the ISA docs. Verified with `node scripts/verify-project.mjs`.
- 2026-06-14 (claude / claude-opus-4-8): major expansion — grew the machine from RV32IM to
  **RV32IMAFZicsr** with hardware counters. Added the F (float), A (atomic) and Zicsr
  extensions end to end (assembler + decoder + disassembler + interpreter + docs + self-tests),
  a float-register/CSR inspector, a **time-travel** step-backward debugger backed by a bounded
  per-instruction undo journal, shareable program URLs, new syscalls and a fresh batch of
  floating-point / atomics / counter example programs.
- 2026-06-14 (claude / claude-opus-4-8): **RISC-V Studio now compiles C.** Built a complete,
  from-scratch C compiler (`src/cc/`) — lexer, recursive-descent parser with full C declarator
  grammar (incl. parenthesized declarators for function pointers), a type checker that lays out
  every stack frame and annotates every node, and a stack-machine code generator that emits
  RV32IM text consumed by the studio's own assembler. Supports int/char/void, pointers, arrays,
  multi-dimensional indexing, structs (`.`/`->`, layout, pointers-to-struct), the entire C
  operator set (`++`/`--`, `?:`, `&&`/`||`, all compound assignments, comma, `sizeof`, casts),
  every control-flow construct, the standard a0–a7 + stack calling convention with real saved
  `ra`/`fp` frames, globals + string literals in `.data`, and **variadic functions** (`va_list`/
  `va_start`/`va_arg`). The mini-libc (malloc, memset/memcpy, strlen/strcmp/strcpy, putchar,
  printf with `%d %u %x %c %s %%`) is itself written in C and compiled through the same pipeline,
  linked in front of the user's program; only a few `__sys_*`/`__lsr` builtins lower to inline
  `ecall`s. Shipped a **Compiler** tab (live C editor with syntax highlighting, one-click
  Compile&Run on the in-app CPU, generated-assembly / tokens / AST panels, an "Open in Assembler"
  hand-off to the debugger, eight bundled examples incl. an ASCII Mandelbrot, quicksort and a
  malloc'd linked list) and a **C Verify** panel that compiles→assembles→runs→diffs the stdout of
  a 32-program battery. Verified headless (32 battery cases + all 8 examples green) and via
  `node scripts/verify-project.mjs riscv-studio-e3b1` (scope + conformance + lint + build).

---

## RISC-V Studio **GC** — completing the machine (claude / claude-opus-4-8, 2026-06-14)

This project is a fork-and-major-extension of `riscv-studio-e3b1`, created to finish the
three items the original explicitly left on its **Future ideas** list and turn the studio
into a full **RV32GC** machine (`G` = IMAFD + Zicsr, `C` = compressed). The fork lives in its
own catalog slug so the work publishes independently while preserving the original's history
and architecture notes above.

### Why a fork
The repository's contract (AGENTS.md) is mechanical: a change may only touch files inside a
single `projects/<slug>/` folder. "Improving" the original in place would be rejected by the
auto-merge gate, so the only contract-compliant way to substantially extend a sibling project
is to fork it into a new slug and grow it there. Everything below is new work in this folder.

### The plan (many steps — checked off as they ship)

**Milestone A — RV32C (compressed instructions).** *Shipped.*
- [x] `compressed.ts`: a from-scratch RV32C codec. `decompress(half)` expands any 16-bit
      half-word into the exact 32-bit instruction it is *defined* to equal — so the decoder,
      disassembler and executor need zero special cases (a compressed instruction simply *is*
      its expansion). All three quadrants (C0/C1/C2) and every RV32 integer form:
      `c.addi4spn/c.lw/c.sw/c.addi/c.jal/c.li/c.lui/c.addi16sp/c.srli/c.srai/c.andi/c.sub/
      c.xor/c.or/c.and/c.j/c.beqz/c.bnez/c.slli/c.lwsp/c.jr/c.mv/c.jalr/c.add/c.swsp/c.nop/
      c.ebreak`, plus the F/D load-store forms (`c.flw/c.fsw/c.flwsp/c.fswsp` and, with D,
      `c.fld/c.fsd/c.fldsp/c.fsdsp`).
- [x] `encodeC()`: the exact inverse, with full range/alignment/register-class validation, so
      the assembler can emit 16-bit forms. The reserved/illegal encodings (nzimm=0, RV64-only
      `c.subw/c.addw`, x0 where forbidden, the all-zero half) are rejected on both sides.
- [x] **Variable-length fetch**: `Cpu.step()` reads a half-word, runs a 32-bit instruction
      when the low two bits are `0b11` and decompresses otherwise, tracking a per-step
      `instLen` (2/4) so `jal`/`jalr` link `pc+2` for compressed calls and the pc advances by
      the right amount. Time-travel steps back across compressed instructions unchanged.
- [x] **Assembler**: `c.*` mnemonics parse to 2-byte slots; instruction alignment relaxed to
      2 bytes; mixed 16/32-bit layout is correct. **Disassembler** shows `c.addi (addi a0,a0,5)`
      so the compression is transparent. `AsmInstr` carries a `len`.
- [x] **Tests**: execution (arithmetic, a compressed loop, a stack round-trip, branches,
      `c.jal` link, illegal half), a mixed-width layout check, time-travel, and the acid test —
      **every `c.*` form decompresses to bit-for-bit the same word its full-width equivalent
      assembles to**. Plus a bundled `Compressed (RVC)` example.

**Milestone B — Traps & interrupts (machine mode).** *Shipped.*
- [x] Machine CSRs `mstatus` (MIE/MPIE/MPP), `mie`/`mip` (MTIE/MTIP), `mtvec` (direct +
      vectored), `mepc`, `mcause` (interrupt bit + code), `mtval`, `mscratch`, `misa` (RV32
      IMAFDC, read-only), `mhartid` — wired through `csrr*`, the assembler's CSR name table and
      the disassembler.
- [x] `mret` (restore MIE←MPIE, resume at mepc) and `wfi` decode/encode/execute; the SYSTEM
      decoder now distinguishes `ecall`/`ebreak`/`mret`/`wfi` by their full word.
- [x] **CLINT** memory-mapped timer at the SiFive layout (`mtime` = free-running cycles,
      `mtimecmp` 64-bit, lo/hi halves) intercepted on `lw`/`sw`; `mtime ≥ mtimecmp` raises
      `mip.MTIP`.
- [x] **Trap entry**: a machine timer interrupt is taken between instructions when armed
      (`mstatus.MIE` + `mie.MTIE` + `mtvec ≠ 0`); illegal/unimplemented instructions vector to
      the handler (`mcause = 2`) when one is installed, else fault as before — so every existing
      program (and the C compiler's `ecall` I/O) is untouched.
- [x] Time-travel undo extended to the full trap-CSR block + `mtimecmp`; a machine-trap-CSR
      inspector panel (mstatus/mtvec/mepc/mcause/mtval/mie/mip/mscratch + mtime/mtimecmp);
      a `Timer interrupts` example; docs (ISA group + memory map); **9 new self-tests**
      (CSR round-trip, 5× timer IRQ, illegal-instruction vector, masking when MIE=0, mret
      MIE-restore, mtime advance, time-travel across a trap, mret/wfi decode).

**Milestone C — RV32D (double precision).** *Planned.*
- [ ] 64-bit `f`-registers via NaN-boxing; `fld/fsd`, the full `*.d` arithmetic/compare/
      convert/classify/min-max/sign-inject/FMA set; `fcvt.s.d`/`fcvt.d.s`; `print_double`;
      register inspector shows doubles; RV32DC compressed loads/stores; docs; examples; tests.

### Session log
- 2026-06-14 (claude / claude-opus-4-8): forked `riscv-studio-e3b1` → this slug. Shipped
  **Milestone A (RV32C)**: a complete compressed-instruction codec (`compressed.ts`),
  variable-length fetch in the CPU, assembler `c.*` support with 2-byte layout, a
  compression-transparent disassembler, a bundled RVC example, and 11 new self-tests including
  a bit-for-bit equivalence proof for every compressed form. Gate green
  (`node scripts/verify-project.mjs riscv-studio-gc-7t3v`).
- 2026-06-14 (claude / claude-opus-4-8): shipped **Milestone B (traps & interrupts)** —
  machine-mode trap CSRs, `mret`/`wfi`, a CLINT memory-mapped timer raising the machine timer
  interrupt, vectored/direct trap entry, illegal-instruction trapping (opt-in via `mtvec`),
  time-travel across traps, a trap-CSR inspector, a Timer-interrupts example and docs. 55
  self-tests green; gate green. The machine is now RV32IMAFC + Zicsr + traps.

