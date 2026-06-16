# RISC-V Studio — journal

The app's long-lived memory. Read this first when you pick the app back up, then keep it
current as you work.

RISC-V Studio is a complete **RV32IMAFC + Zicsr** development environment with a full
**three-ring privilege architecture (M/S/U)** and a real hardware **Sv32 MMU** that runs
entirely in the browser: a two-pass assembler (real instruction encodings + a large
pseudo-instruction set + the **compressed C extension**, hand-written or auto-compressed), a
register/cycle-accurate interpreter with integer **and IEEE-754 single-precision
floating-point**, **atomics**, **control/status registers + hardware counters**, a
machine-mode **trap & interrupt** architecture with a memory-mapped **CLINT timer**, and —
new — **supervisor mode + virtual memory**: a two-level page-table walker (4 KiB pages and
4 MiB megapages) with V/R/W/X/U/G/A/D permission bits, a TLB, page-fault exceptions and trap
delegation. It also has a **time-travel** stepping debugger (step forward *and back*, exact
across page-table walks) with breakpoints and register-diff highlighting, a paged sparse
memory with a memory-mapped 128×128 framebuffer, a RARS-style syscall console, a disassembler,
shareable program URLs, an in-app verification suite, and a full ISA reference.

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
- [x] Compressed instructions (RV32C) in the assembler/decoder/disassembler — shipped 4.0
- [x] Interrupts / traps with `mtvec`/`mcause`/`mepc` and a timer interrupt — shipped 4.0
- [x] **A C-subset compiler front-end targeting this assembler** — see the big section below.

### 2026-06-16 plan — RISC-V Studio 5.0: Supervisor mode + an Sv32 MMU

The machine has only ever run in machine mode against physical memory. This session adds the
two pieces that turn it from a bare-metal microcontroller into something that can boot an OS
kernel: a **three-ring privilege architecture (M / S / U)** and a real **Sv32 hardware MMU**
that walks two-level page tables in memory, caches translations in a TLB, sets the A/D bits,
and raises genuine page-fault exceptions. Every bit of it is verifiable from assembly and
proven by the in-app suite. Designed to be **strictly additive**: with `satp` in Bare mode and
the machine reset to M-mode (as it always has been), behaviour is byte-for-byte unchanged, so
all 46 existing self-tests and every example keep passing.

Steps (each fully implemented + self-tested this session — all ✅ shipped):

- [x] **Privilege levels.** Track the current privilege ring (`priv` ∈ {U=0, S=1, M=3}),
      reset to M. CSR-access and privileged-instruction permission checks keyed on it
      (lower rings trapping `illegal` on M-CSRs, `satp`, `sret`, `sfence.vma`).
- [x] **S-mode CSRs.** `sstatus` (a WARL view of `mstatus`), `sie`/`sip` (views of `mie`/`mip`
      masked to the S-interrupt bits), `stvec`, `sepc`, `scause`, `stval`, `sscratch`, `satp`,
      plus `medeleg`/`mideleg` for trap delegation. `mstatus` grows the SIE/SPIE/SPP/MPP(2-bit)/
      MPRV/SUM/MXR fields.
- [x] **Instructions.** `sret` (S-mode trap return), `sfence.vma` (TLB fence), decoded,
      disassembled, assembled, highlighted; `mret` updated to restore the real `MPP` privilege.
- [x] **Sv32 MMU (`src/vm/mmu.ts` + `cpu` integration).** A two-level page-table walker:
      4 KiB pages and 4 MiB megapages, the V/R/W/X/U/G/A/D PTE bits, permission checks honouring
      privilege + `SUM` (supervisor user-memory access) + `MXR` (make-executable-readable),
      hardware A/D-bit updates written back through the time-travel journal, misaligned-superpage
      and reserved-encoding faults, and `MPRV` redirection of M-mode loads/stores.
- [x] **A TLB** that caches leaf translations (flushed by `sfence.vma`, by `satp` writes, and on
      every `stepBack` so time-travel stays exact).
- [x] **Page-fault traps** (causes 12/13/15 for fetch/load/store) routed through a rewritten
      trap path with **delegation**: when `priv ≤ S` and the matching `medeleg`/`mideleg` bit is
      set, the trap vectors to S-mode (`stvec`/`sepc`/`scause`/`stval`) instead of M-mode.
- [x] **Time-travel correctness.** The undo journal grows to snapshot the full S-mode + privilege
      state and the new `satp`, and to record *multiple* memory writes per step (a store can now
      touch a PTE's A/D bits *and* the datum), so stepping backward through a page-table walk is
      exact.
- [x] **A worked example** — `paging`: build a root + leaf page table by hand, identity-map the
      kernel, map one virtual page to a different physical frame, enable Sv32, drop to S-mode,
      prove the alias reads the aliased frame, then deliberately touch an unmapped page and let
      the S-mode page-fault handler catch it and print the faulting address.
- [x] **Self-tests** (18 new, 64 total): identity-map round trip, a 4 MiB megapage, an aliased
      mapping, the right page-fault cause per access, a read-only page faulting on write, a
      misaligned superpage, `SUM`/`MXR` semantics, `MPRV` redirection, A/D-bit setting, a real
      two-level walk that follows a re-pointed table, `sret` to U-mode restoring SIE, a U-mode
      illegal-CSR trap, `sret`/`sfence.vma` encode/decode round trips, and exact `stepBack`
      reversal across the whole paging example.
- [x] **UI + Docs.** The register inspector grows a privilege badge + an S-mode/`satp` CSR block
      and a live **address-translation tracer** that walks `satp` for the PC and shows each
      page-table level; the ISA reference gained a "Supervisor mode & the Sv32 MMU" section.

#### Implementation notes (where things live)
- `src/vm/mmu.ts` — Sv32 constants, PTE/VA/`satp` bit helpers, the `TlbEntry`/`TranslationTrace`
  shapes, and the `PageFault` sentinel. Pure encoding; no machine state.
- `src/vm/cpu.ts` — the live MMU: `translate()` (TLB-cached walk + perms + A/D, identity
  fast-path when paging is off), `walk()`, `checkPerms()`, `updateAD()`, the `vmLoad`/`vmStore`/
  `fetchHalf`/`fetchWord` access layer, `explainTranslation()` (read-only walk for the UI), the
  rewritten `enterTrap`/`trapTarget`/`takeInterruptIfPending`/`trapException` delegation path,
  and `sret`/`sfence.vma`/updated `mret`/`ecall`/`ebreak`.
- Design rule kept throughout: **strictly additive.** `satp` MODE=Bare or M-effective-privilege
  ⇒ `translate()` is the identity after a single branch, so every pre-existing test/example is
  byte-for-byte unchanged. The page tables live in ordinary RAM and are built by hand in asm.

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

### 2026-06-15 — RISC-V Studio 4.0: the **C extension** + **machine-mode traps & interrupts**

This session turns the studio from RV32IMAF+Zicsr into a machine that runs **real,
compiler-grade RISC-V**: the compressed (**C**) extension that ~30% of every distributed
RISC-V binary is built from, and a genuine **machine-mode trap architecture** — exceptions,
interrupts, a CLINT timer, and `mret` — so the studio can run an interrupt handler. Every
piece is wired through the assembler, decoder, disassembler, interpreter, time-travel
journal, verification suite, examples and docs so it is observable and proven.

#### Part A — RV32C (the compressed extension)
- [x] `rvc.ts` — a complete RV32C codec: `isCompressed`, `expandCompressed` (16-bit ⇒ the
      canonical 32-bit base instruction, so the existing executor runs it unchanged),
      `compressedName` (disassembly), `encodeCompressed` (assembler ⇒ 16-bit), and
      `tryCompress` (an automatic peephole that shrinks base instructions to RVC).
- [x] Full quadrant 0/1/2 integer set: `c.addi4spn/c.lw/c.sw`, `c.addi/c.jal/c.li/
      c.addi16sp/c.lui/c.srli/c.srai/c.andi/c.sub/c.xor/c.or/c.and/c.j/c.beqz/c.bnez`,
      `c.slli/c.lwsp/c.jr/c.mv/c.ebreak/c.jalr/c.add/c.swsp`, plus `c.nop`/`c.unimp`.
- [x] Variable-length fetch: `Cpu.step` reads a half-word, detects the 2-bit length code,
      and advances the pc by **2 or 4**. Link instructions (`c.jal`/`c.jalr`) thread the real
      instruction size so the return address is `pc+2`, not `pc+4`.
- [x] Assembler emits compressed: explicit `c.*` mnemonics, **and** an automatic
      `.option rvc` / "Compress (RVC)" toggle that re-encodes compressible base instructions
      to 16 bits (no branch relaxation needed — only address-independent forms compress).
      Instruction alignment relaxed to IALIGN=16; labels/relocations stay exact.
- [x] Size-aware disassembler + Disasm view (2-byte words render as `c.*`); RVC keywords in
      the editor highlighter; a hand-written RVC example and an auto-compressed showcase.
- [x] Self-tests: every `c.*` ⇄ its base instruction equivalence, a full compressed program,
      and an "auto-compress shrinks the binary and runs identically" differential check.

#### Part B — machine-mode traps & interrupts (the privileged core)
- [x] M-mode CSRs: `mstatus` (MIE/MPIE/MPP), `mie`, `mip`, `mtvec` (direct + vectored),
      `mepc`, `mcause`, `mtval`, `mscratch`, `misa`, `mhartid`, `mvendorid`/`marchid`/`mimpid`.
- [x] `mret` instruction (restores the interrupt-enable stack and jumps to `mepc`); `wfi`
      (a no-op that just advances). Synchronous **exception traps**: illegal instruction,
      breakpoint (`ebreak`), `ecall`-from-M (opt-in), and load/store/fetch address-misaligned
      — each sets `mcause`/`mepc`/`mtval` and vectors to `mtvec` *iff* a handler is installed.
- [x] A memory-mapped **CLINT** (`mtime`/`mtimecmp`/`msip`) that drives a real **timer
      interrupt** and **software interrupt**; the run loop checks for a pending, enabled,
      globally-unmasked interrupt before each instruction and takes it.
- [x] Time-travel covers the whole privileged state (CSRs + the trap redirect undo exactly).
- [x] A worked **interrupt example** (install a timer handler, `wfi`, count ticks), trap
      self-tests, and a Docs section on the privileged ISA + the CLINT memory map.

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
- 2026-06-15 (claude / claude-opus-4-8): **RISC-V Studio 4.0 — the C extension + machine-mode
  traps & interrupts.** Two big additions, each wired end to end and proven by the in-app suite.
  **(A) RV32C (compressed):** a complete 16-bit codec (`src/vm/rvc.ts`) with paired pack/unpack
  scrambles for every CI/CIW/CL/CS/CSS/CJ/CB format; the CPU now does variable-length fetch
  (a half-word length code selects 2- vs 4-byte instructions, the pc advances by the real width,
  and `c.jal`/`c.jalr` link `pc+2`); `expandCompressed` lowers each RVC op to its canonical
  32-bit form so the existing executor runs it unchanged; the assembler accepts explicit `c.*`
  mnemonics **and** auto-compresses eligible base instructions via a layout-independent peephole
  (`.option rvc` directive or a "Compress (RVC)" toolbar toggle — no branch relaxation needed,
  ~25–30% smaller, byte-for-byte identical behaviour); a size-aware disassembler + Disasm view,
  RVC syntax highlighting, an example, and self-tests (round-trip equivalence + a differential
  "compress shrinks & behaves identically" check). Coverage is the full RV32**C** integer set
  plus **RV32FC** compressed single-precision float load/store (`c.flw/c.fsw/c.flwsp/c.fswsp`,
  hand-written or auto-compressed). **(B) machine-mode traps:** the privileged
  CSRs (`mstatus`/`mie`/`mip`/`mtvec`/`mepc`/`mcause`/`mtval`/`mscratch`/`misa`/`mhartid`), the
  `mret`/`wfi` instructions, synchronous exception traps (illegal instruction → cause 2,
  `ebreak` → cause 3, both vectoring to `mtvec` only when a handler is armed), and a
  memory-mapped **CLINT** (`msip`/`mtimecmp`/`mtime`) that raises real **timer** and **software**
  interrupts checked at each instruction boundary; the time-travel journal snapshots the whole
  privileged + CLINT state so stepping backward through a trap is exact; a worked timer-interrupt
  example, a trap-CSR inspector panel, Docs coverage, and 6 trap self-tests. Verified headless
  (46/46 self-tests + 103 RVC codec checks + a 49,152-case decode fuzz with no crashes) and via
  `node scripts/verify-project.mjs riscv-studio-e3b1` (scope + conformance + lint + build).
- 2026-06-16 (claude / claude-opus-4-8): **RISC-V Studio 5.0 — supervisor mode + a real Sv32
  MMU.** The machine grew from a bare-metal microcontroller into something that could host an OS
  kernel: a full **three-ring privilege architecture (M/S/U)** and a hardware **memory-management
  unit**. New `src/vm/mmu.ts` holds the Sv32 encoding (PTE/VA/`satp` bit helpers, the TLB-entry
  and translation-trace shapes, the `PageFault` sentinel); the interpreter gained a TLB-cached
  two-level **page-table walker** (4 KiB pages + 4 MiB megapages, the `V/R/W/X/U/G/A/D` bits),
  permission checks honouring privilege plus `SUM`/`MXR`, **hardware A/D-bit updates**,
  misaligned-superpage/reserved-encoding faults, `MPRV`-redirected M-mode data accesses, a **TLB**
  fenced by `sfence.vma`/`satp` writes, and genuine **page-fault exceptions** (cause 12/13/15).
  The whole trap path was rewritten for **delegation** — `medeleg`/`mideleg` vector a trap to
  S-mode (`stvec`/`sepc`/`scause`/`stval`, returned by `sret`) instead of M-mode — and `ecall`/
  `ebreak`/`mret` learned about privilege. Added the S-mode CSRs (`sstatus`/`sie`/`sip` as masked
  views, `stvec`/`sepc`/`scause`/`stval`/`sscratch`/`satp`), grew `mstatus` (SIE/SPIE/SPP/2-bit
  MPP/MPRV/SUM/MXR), and the `sret` + `sfence.vma` instructions (assemble/decode/disassemble/
  highlight). The time-travel journal now snapshots the full privilege + S-mode + `satp` state and
  records **multiple** memory writes per step (a paged store touches a PTE's A/D bits *and* the
  datum), so stepping backward through a page-table walk is exact. Shipped a hand-built **`paging`
  example** (build a page table → enable Sv32 → drop to S-mode → read through an alias → fault on
  an unmapped page → recover in the S handler), an inspector **privilege badge + S-mode/`satp` CSR
  block + a live page-table-walk tracer for the pc**, and a Docs section. Kept **strictly
  additive**: Bare `satp`/M-mode ⇒ translation is the identity after one branch, so every prior
  test and example is byte-for-byte unchanged. Verified headless (**64/64 self-tests**, +18 new
  covering identity/megapage/alias/fault-cause/RO-write/misaligned-superpage/SUM/MXR/MPRV/A-D/
  two-level-walk/`sret`/U-mode-illegal-CSR/encoding/full-rewind) and via
  `node scripts/verify-project.mjs riscv-studio-e3b1` (scope + conformance + lint + build).
