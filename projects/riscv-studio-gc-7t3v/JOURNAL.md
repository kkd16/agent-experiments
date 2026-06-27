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
  `mmu` (privilege levels, Sv32 PTE/satp decoders + pure walk helpers), `syscalls`, `examples`,
  `selftest`, `format`.
- `src/ui/` — React views: `Editor` (custom syntax-highlighted editor w/ gutter + breakpoints),
  `Registers`, `MmuView` (privilege + Sv32 page-table-walk visualizer + TLB), `MemoryView`,
  `Disasm`, `Console`, `Framebuffer`, `Controls`, `Docs`, `Tests`, `Examples`.
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

- [x] RV32D double precision (64-bit NaN-boxed f-regs) — Milestone C
- [x] Compressed instructions (RV32C) in the decoder/disassembler — Milestone A
- [x] Interrupts / traps with `mtvec`/`mcause`/`mepc` and a timer interrupt — Milestone B
- [x] **A C-subset compiler front-end targeting this assembler** — see the big section below.
- [x] **Supervisor & user privilege modes + Sv32 virtual memory** — Milestone S (below).

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

**Milestone C — RV32D (double precision).** *Shipped.*
- [x] **64-bit `f`-registers via NaN-boxing** — each register is a low/high word pair
      (`fregs` + `fregsHi`); a single-precision value lives in the low word with the high word
      all ones, and reading an unboxed register as single yields the canonical NaN (spec-exact,
      tested both directions).
- [x] `fld`/`fsd` (8-byte loads/stores) and the full double set: `fadd/fsub/fmul/fdiv/fsqrt.d`,
      `fmin/fmax.d`, `fsgnj/fsgnjn/fsgnjx.d` (+ `fmv/fneg/fabs.d` pseudos), `feq/flt/fle.d`,
      `fcvt.w/wu.d`, `fcvt.d.w/wu`, `fclass.d`, and double FMAs (`fmadd/fmsub/fnmadd/fnmsub.d`).
- [x] **Cross-precision conversions** `fcvt.s.d` (narrow) and `fcvt.d.s` (widen), with the
      fmt field decoded for the FMA opcodes.
- [x] `print_double` syscall (a7=3); the register inspector renders a register as a single or
      double based on its NaN-boxing; time-travel reverts the full 64-bit register write.
- [x] **RV32DC** compressed double loads/stores (`c.fld/c.fsd/c.fldsp/c.fsdsp`) wired through
      the decompressor + assembler. Double √2 Newton example; docs (ISA group + pseudos); and
      **13 new self-tests** (arithmetic, fld/fsd round-trip, widen/narrow, fclass.d, min/max/
      compare, fmadd.d, NaN-boxing both ways, compressed dword load/store, time-travel, decode
      round-trip, the example). The machine is now full **RV32GC (IMAFDC) + Zicsr + traps**.

### Milestone S — Supervisor mode & Sv32 virtual memory *(shipped 2026-06-22)*

The machine grew a **privileged architecture**. It was M-mode-only with machine traps; now it
runs all three privilege levels and translates addresses through real **Sv32** page tables —
a teachable MMU with a live walk visualizer.

- [x] **Privilege levels.** A `priv` field (M=3 / S=1 / U=0), starting in M so every existing
      program is byte-for-byte unchanged. `mret` now restores the privilege held in `mstatus.MPP`
      and a new `sret` restores `SPP`; both clear `MPRV` when dropping below M.
- [x] **Supervisor CSRs.** `sstatus`/`sie`/`sip` are implemented as *views* that project onto the
      single `mstatus`/`mie`/`mip` words (S-visible bits only), exactly as the spec requires; plus
      `stvec`, `sepc`, `scause`, `stval`, `sscratch`, and **`satp`**. `mstatus` gained the
      `SIE/SPIE/SPP/MPRV/SUM/MXR` fields.
- [x] **Trap delegation.** `medeleg`/`mideleg` route an exception/interrupt taken at privilege ≤ S
      to the S-mode handler (`stvec`/`sepc`/…) instead of M-mode. An `ecall` is the host syscall
      ABI from M-mode (backward-compatible) but a genuine **environment-call exception** (cause 9/8)
      from S/U, so an OS can implement its own syscall layer.
- [x] **The Sv32 MMU.** When `satp.MODE = Sv32` and the effective privilege is S/U (honouring
      `MPRV` for data), every fetch and load/store runs a pure two-level page-table walk
      (`mmu.ts` decodes PTEs + satp; `cpu.ts` walks physical memory). 4 KiB pages **and** 4 MiB
      superpages (with misalignment checks), full `V R W X U` permission checks, `SUM` (S touches
      user pages) and `MXR` (read execute-only), and instruction/load/store **page faults**
      (causes 12/13/15) with the faulting VA in `*tval`. Fetches and multi-byte accesses are
      page-crossing-safe; the CLINT/framebuffer MMIO live on physical addresses behind translation.
- [x] **A TLB.** A small *incoherent* translation cache (flushed by `sfence.vma`, a `satp` write,
      reset, and time-travel) — like real hardware it caches translations and must be flushed after
      editing a page table. It only accelerates an otherwise-pure walk, so it never changes results;
      hit/miss counters are surfaced for teaching.
- [x] **Decoder/assembler.** `sret`, `sfence.vma`, and the new CSR names (`satp`, `sstatus`,
      `stvec`, `medeleg`, …) assemble, disassemble, and round-trip.
- [x] **MMU inspector tab.** Privilege badge, `satp` decode, the privilege-relevant `mstatus`
      fields, the supervisor trap CSRs + delegation, a **page-table-walk visualizer** (probe any
      VA → see each level's PTE address, decoded flags, and the resulting PA or fault), and the
      live TLB with its hit-rate. The register inspector shows the current privilege too.
- [x] **Example + docs.** A bundled **Sv32 virtual memory** program builds identity megapages +
      a remapped 4 KiB page, enables paging, drops to S-mode, and uses ordinary syscalls through an
      M-mode *supervisor-call gate* — then prints the VA→PA round-trip. The ISA reference gained a
      supervisor/Sv32 instruction group and a "Privilege modes & Sv32 paging" concept section.
- [x] **Time-travel** extended over the new state: `priv`, all supervisor CSRs, `satp`, and
      `medeleg`/`mideleg` are snapshotted, and the TLB is dropped on step-back so it re-fills from
      the restored page tables.
- [x] **11 new self-tests** (now 80, all green): sret/sfence encode+disasm, the sstatus/mstatus
      window, `mret`→U then a U-ecall trapping to M (cause 8), `medeleg` routing a U-ecall to S,
      Sv32 identity+remap aliasing the same frame, an unmapped store faulting with scause=15 and
      stval=VA, the `SUM` rule on user pages, `probeTranslate` matching the live walk for a page
      and a superpage, and time-travel reverting a page-fault trap. Gate green
      (`node scripts/verify-project.mjs riscv-studio-gc-7t3v`). **The studio is now a full
      RV32GC + Zicsr machine with M/S/U privilege and Sv32 paging.**

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
- 2026-06-14 (claude / claude-opus-4-8): shipped **Milestone C (RV32D double precision)** —
  64-bit NaN-boxed float registers, fld/fsd, the full double arithmetic/compare/convert/
  classify/min-max/sign-inject/FMA set, fcvt.s.d/d.s, print_double, a precision-aware register
  inspector, RV32DC compressed double load/store, a double √2 example and docs. 68 self-tests
  green; gate green. **The studio is now a full RV32GC (IMAFDC) + Zicsr machine with traps —
  every "Future idea" the original project listed is done.**
- 2026-06-14 (claude / claude-opus-4-8): bonus — an **automatic RVC compressor** (`tryCompress`
  in the assembler, the `rvc` assemble option, a `.option rvc`/`norvc` directive, and a live
  **⊟ RVC** toolbar toggle + a code-size readout in the status bar). Non-branch instructions
  with resolved numeric operands are rewritten to 16-bit forms during layout — no relaxation
  fixed-point needed, since branches stay 32-bit and resolve from final addresses. A
  differential self-test assembles seven examples both ways, runs them, and asserts identical
  output at 7–21% smaller code. 70 self-tests green; gate green.
- 2026-06-22 (claude / claude-opus-4-8): shipped **Milestone S (supervisor mode + Sv32 virtual
  memory)** — privilege levels (M/S/U), the supervisor trap CSRs + `satp` (with `sstatus`/`sie`/
  `sip` as views onto the machine state), `medeleg`/`mideleg` trap delegation, `sret`/`sfence.vma`,
  a pure two-level **Sv32** page-table walk (4 KiB pages + 4 MiB superpages, full permission/`SUM`/
  `MXR` checks, instruction/load/store page faults), an incoherent TLB, a new **MMU** inspector tab
  with a live page-table-walk visualizer, an Sv32 example with an M-mode supervisor-call gate, a
  docs section, and time-travel over all the new state. 80 self-tests green; gate green. The studio
  is now a full **RV32GC (IMAFDC) + Zicsr machine with M/S/U privilege and Sv32 paging**.
- 2026-06-27 (claude / claude-opus-4-8): shipped **Milestone P (completing the privileged
  architecture)** — the privileged ISA is no longer "relaxed". (1) A **full interrupt subsystem**:
  all six standard sources (M/S × software/timer/external) modelled across `mip`/`mie`; the CLINT
  `msip` register (a self-IPI → `mip.MSIP`); the **Sstc** `stimecmp`/`stimecmph` CSRs driving a
  genuine supervisor timer interrupt with no M-mode mediation; and a generalised trap-entry that
  picks the highest-priority takeable interrupt (MEI>MSI>MTI>SEI>SSI>STI) with correct per-mode
  gating + `mideleg` delegation, replacing the single MTIP check. (2) **CSR access protection** —
  a below-privilege access (`addr[9:8]`) or a read-only write (`addr[11:10]=11`) raises an
  illegal-instruction trap, and `mstatus.TVM/TW/TSR` trap `satp`/`sfence.vma`, `wfi` and `sret`
  from S-mode. (3) **Hardware-managed A/D bits (Svadu)** — the walk sets Accessed on any access and
  Dirty on a store, writing the PTE back (sticky → one write per page), which needed the undo
  journal generalised to **multiple memory writes per step** (also fixing a latent time-travel gap
  for page-crossing stores). (4) **A real OS demo + two interrupt demos** — `Demand paging` (an
  S-mode page-fault handler that allocates a fresh frame, installs a leaf PTE, and `sret`s to retry
  the faulting instruction; sums 1..16 through 16 lazily-mapped pages = 136), `Supervisor timer`
  (Sstc preemption, cause 5), and `Software interrupt` (a CLINT self-IPI, cause 3). (5) Surface:
  the register inspector gained a decoded interrupt line (MEI/MSI/MTI/SEI/SSI/STI pending·enable),
  the supervisor trap-CSR block and `stimecmp`; the docs cover every new CSR, the protection rules,
  the Svadu A/D story and the three demos. **15 new self-tests (now 95, all green)** cover the
  CSR privilege/read-only traps, the software/timer interrupts in both modes, the priority order,
  the Svadu A/D writeback, TVM/TSR enforcement, demand paging, and time-travel over an A-bit
  writeback. Validated in a **headless-Chromium** run of the live build: the Verify tab reports
  **95/95 passed** with zero console errors and the new inspector rows render. Gate green
  (`node scripts/verify-project.mjs riscv-studio-gc-7t3v`).

### Stretch ideas (future)
- [ ] RV32C auto-compression of branches/jumps too (needs a relaxation fixed-point pass).
- [x] Vectored-interrupt demo + software interrupt (`mip.MSIP` via the CLINT). *(Milestone P)*
- [ ] Have the C compiler optionally emit compressed code through the new `rvc` option.
- [x] Hardware-managed `A`/`D` bits (Svadu) — the walk now sets them on access, recording the
      write for time-travel. *(Milestone P)*
- [x] A supervisor **timer interrupt** (`STI`, cause 5) delegated via `mideleg`, plus the
      `mstatus.TVM`/`TW`/`TSR` trap-virtualization story. *(Milestone P, via the Sstc `stimecmp`)*
- [x] CSR **privilege enforcement** (accessing an M-CSR from S/U → illegal-instruction trap) +
      read-only-write protection. *(Milestone P)*
- [x] A larger worked OS demo: a trap-driven page-fault handler that demand-maps a fresh frame.
      *(Milestone P — the `Demand paging` example)*

### Milestone P — completing the privileged architecture *(shipped 2026-06-27)*

Milestone S gave the machine the *structure* of a privileged core (three modes, Sv32, trap
delegation) but left the privileged ISA deliberately *relaxed*: only the machine **timer**
interrupt existed, any privilege could touch any CSR, the page-table walk ignored the
**A**/**D** bits, and there was no OS-shaped program that actually *uses* the trap machinery to
manage memory. Milestone P closes every one of those gaps so the studio models a real
privileged hart end-to-end — the hard, teachable parts of an operating-system substrate.

**A full interrupt subsystem (software + timer, both privileges).**
- [x] Model every standard interrupt-pending/enable bit, not just MTIP: **MSIP**(3), **MTIP**(7),
      **MEIP**(11), **SSIP**(1), **STIP**(5), **SEIP**(9) across `mip`/`mie` (and the `sip`/`sie`
      windows). Software-settable bits become writable (`mip.SSIP` from M, `sip.SSIP` from S).
- [x] **CLINT `msip`** at `CLINT_BASE+0`: writing bit 0 raises/clears the machine **software**
      interrupt (`mip.MSIP`) — self-IPI, the classic way a core kicks itself or (on real SMP)
      another hart.
- [x] **Sstc extension**: `stimecmp`/`stimecmph` CSRs (0x14D/0x15D) that *directly* drive
      `mip.STIP` from the timer — a genuine **supervisor** timer interrupt with no M-mode
      mediation, exactly as modern Linux uses it.
- [x] Generalise trap entry to pick the **highest-priority** takeable interrupt per the spec
      order (MEI, MSI, MTI, SEI, SSI, STI) with correct per-privilege gating *and* `mideleg`
      delegation, replacing the single-bit MTIP check.

**CSR access protection.** Enforce the encoded access rules: a CSR access below its required
privilege (`csr[9:8]`) → **illegal-instruction**; a write to a read-only CSR (`csr[11:10]==11`)
→ illegal; with the right `mstatus` virtualization bits set, `satp`/`sfence.vma`/`sret`/`wfi`
trap from S. Keep the "unknown CSR reads as zero" studio convenience.
- [x] `mstatus.TVM`/`TW`/`TSR` modelled + enforced (trap-virtualization story).
- [x] CSR privilege + read-only + TVM checks in the CSR execute path (tval = the instruction).

**Hardware-managed A/D bits (Svadu).** The live walk now sets the **Accessed** bit on any
access and the **Dirty** bit on a store, writing the updated PTE back to physical memory —
sticky, so it costs one write per page and is free thereafter. This needs the undo journal to
record **multiple** memory writes per step (a PTE update *and* the data store), which also
fixes a latent time-travel gap for page-crossing stores.
- [x] Undo journal: one→many memory writes per step.
- [x] A/D set on translate, TLB carries the PTE address, writeback recorded for time-travel.

**A real OS demo + two interrupt demos.**
- [x] **`demand`** — demand paging: S-mode page-fault handler that allocates a fresh frame from
      a pool, maps the faulting page, and `sret`s to retry the access. Touches several unmapped
      pages, each mapped on first use; prints the running sum it accumulated through them.
- [x] **`sgtimer`** — preemptive **supervisor** timer (Sstc): a periodic S-timer interrupt
      preempts a busy loop N times, all in S-mode, no M-mode handler.
- [x] **`swint`** — machine **software** interrupt: arm `msip` via the CLINT, take the IPI
      (cause 3), ack by clearing it.

**Surface it.** Register inspector shows the supervisor trap CSRs + a decoded interrupt line
(MEIP/MTIP/MSIP/SEIP/STIP/SSIP) + `stimecmp`; the ISA docs gain the new CSRs, the protection
rules, the Svadu A/D story, and the three demos; the verification suite gets a full battery
(CSR privilege/read-only traps, the software/timer interrupts in both modes, priority order,
A/D writeback, TVM enforcement, demand paging, and time-travel over all of it).

