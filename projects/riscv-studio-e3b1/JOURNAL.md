# RISC-V Studio — journal

The app's long-lived memory. Read this first when you pick the app back up, then keep it
current as you work.

RISC-V Studio is a complete **RV32IMAFCV + Zicsr + Zb** development environment with a full
**three-ring privilege architecture (M/S/U)** and a real hardware **Sv32 MMU** that runs
entirely in the browser: a two-pass assembler (real instruction encodings + a large
pseudo-instruction set + the **compressed C extension**, hand-written or auto-compressed), a
register/cycle-accurate interpreter with integer **and IEEE-754 single-precision
floating-point**, **atomics**, the **V (vector / RVV 1.0) extension** — length-agnostic SIMD
with a 32-register vector file, the `vtype`/`vl` config model, LMUL grouping, masking, reductions,
gather/scatter and strided/indexed vector memory — **control/status registers + hardware
counters**, a machine-mode **trap & interrupt** architecture with a memory-mapped **CLINT
timer**, and **supervisor mode + virtual memory**: a two-level page-table walker (4 KiB pages and
4 MiB megapages) with V/R/W/X/U/G/A/D permission bits, a TLB, page-fault exceptions and trap
delegation. It also has a **time-travel** stepping debugger (step forward *and back*, exact
across page-table walks) with breakpoints and register-diff highlighting, a paged sparse
memory with a memory-mapped 128×128 framebuffer, a RARS-style syscall console, a disassembler,
shareable program URLs, an in-app verification suite, and a full ISA reference.

Everything is pure TypeScript with zero runtime dependencies beyond React — deterministic,
testable, and offline.

## Architecture

- `src/vm/` — the machine. `constants`, `registers`, `memory` (paged), `isa` (opcode tables),
  `decode`, `disassembler`, `assembler` (two-pass, pseudo-ops, directives), `cpu` (execute, plus
  an opt-in `tracer` retire-hook), `vector` (the RVV encoding source of truth + assemble/decode
  helpers; `cpu.executeVector` is the engine), `syscalls`, `examples`, `selftest`, `format`.
- `src/perf/` — the **microarchitecture timing model** (a pure function of the retired trace,
  never touches execution): `isa-classes` (per-instruction micro-op shape), `predictor` (branch
  predictors + BTB), `cache` (set-associative I$/D$), `pipeline` (the 5-stage scheduler),
  `analyze` (trace capture + orchestration), `perf-tests` (hand-computed cycle oracles).
- `src/opt/` — **Forge, the optimizing back end** (operates on the studio's own assembly text,
  strictly additive): `ir` (structured assembly IR + printer), `parse` (text → IR), `semantics`
  (the per-mnemonic defs/uses/effects truth table), `cfg` (basic blocks + edges), `liveness`
  (global backward data-flow), `edit` (label-preserving deletion), `passes/` (simplify, propagate,
  cse, stack, control, dce), `optimize` (the fixpoint driver), `equiv` (the differential oracle),
  `demos`, `opt-tests` (unit + equivalence + randomized fuzz).
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

- [x] RV32D double precision (FLEN=64 + NaN-boxing) — **shipped 11.0** (see the plan + session log)
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

### 2026-06-17 plan — RISC-V Studio 6.0: a microarchitecture **performance lab** (pipeline, hazards, branch prediction, caches)

So far the studio has only ever told you *what* a program computes — never *how fast the
hardware would run it*. Real RISC-V chips are pipelined, speculate across branches, and live
or die by their caches; a single-cycle interpreter hides all of that. This session adds a
**trace-driven microarchitecture timing model** that turns the studio into a teaching-grade
performance analyzer: a classic 5-stage in-order pipeline (IF/ID/EX/MEM/WB) with hazard
detection and data forwarding, configurable **branch predictors** (static, 1-bit, 2-bit
bimodal, gshare) over a BTB, and a configurable **I-cache + D-cache** hierarchy — all reported
as cycles, CPI, a stall breakdown, prediction accuracy and cache hit rates, and visualised as
the textbook **instruction × cycle pipeline diagram**.

The design is **strictly decoupled and additive**, the same discipline as the MMU work: the
functional interpreter is the single source of truth and is left **byte-for-byte unchanged**.
The timing model never executes anything — it consumes the *retired-instruction trace* the
interpreter emits (an opt-in, null-guarded hook that is dormant during normal
debugging/running) and computes timing from that real dynamic instruction stream. Correctness
of *results* is therefore impossible to regress; only the *timing numbers* are new. The model
is a pure function of (trace, config), so it is exhaustively unit-testable against
hand-computed cycle counts.

Steps (each fully implemented + self-tested this session — all ✅ shipped):

- [x] **Retire-trace hook (`src/vm/cpu.ts`).** An optional `tracer` callback the CPU invokes
      once per retired instruction with `{ pc, size, raw, mnemonic, format, rd, rs1, rs2, rs3,
      base=regs[rs1], imm, nextPc }`. Null by default (zero cost on the live path); set only by
      the analyzer's throwaway CPU. No semantic change whatsoever — proven by a differential
      self-test.
- [x] **Instruction classification (`src/perf/isa-classes.ts`).** A pure `classify(mnemonic,
      format, rd, rs1, rs2, rs3)` mapping every RV32IMAFC instruction to its micro-op shape:
      which source registers it really reads and in which file (integer `x` vs float `f`), what
      it writes, and whether it is a load / store / conditional branch / jump / multi-cycle unit
      (mul, div, fp-add/mul/div). This is what makes the hazard and forwarding logic correct
      per-class (and keeps the two register files from aliasing).
- [x] **Branch predictors + BTB (`src/perf/predictor.ts`).** A shared interface with five
      direction predictors — static not-taken/taken, 1-bit, 2-bit saturating bimodal, and
      **gshare** (global-history ⊕ PC index) — plus a direct-mapped **BTB** for taken targets,
      so a misprediction is *direction* or *target* wrong (split out for the UI). Tiny, exact,
      table-driven; all sizes configurable.
- [x] **Cache simulator (`src/perf/cache.ts`).** A set-associative cache with configurable
      size / block / associativity, LRU or FIFO replacement, and write-back/write-allocate or
      write-through/no-allocate policies; reports hits, misses, miss rate and writebacks.
      Instantiated twice (I-cache on fetch addresses, D-cache on load/store addresses).
- [x] **The pipeline timing model (`src/perf/pipeline.ts`).** An in-order single-issue scheduler
      over the trace using the textbook stage-entry recurrence (each instruction's IF/ID/EX/MEM/WB
      entry cycle is the max of: its previous stage finishing, the prior instruction vacating that
      stage, and any data/control/cache hazard bound). Models full forwarding (EX→EX and MEM→EX)
      with the unavoidable **1-cycle load-use bubble**, the no-forwarding write-before-read regfile
      path, multi-cycle EX latencies, branch-resolve stage (ID or EX), misprediction flush penalty,
      and I/D-cache miss penalties folded into stage latency. Emits exact total cycles, CPI, a
      per-class stall breakdown, and the per-instruction stage spans that drive the diagram.
- [x] **Analyzer/orchestrator (`src/perf/analyze.ts`).** Runs the current program on a fresh,
      history-free CPU with the tracer attached (bounded 300k-instruction trace budget), then feeds
      the captured trace through the pipeline + caches + the *selected* predictor, and **also**
      replays the branch trace through *all* predictors for a side-by-side accuracy comparison.
      Pure data out; no React.
- [x] **Performance self-tests (`src/perf/perf-tests.ts`).** Hand-computed cycle oracles wired
      into the in-app Verify suite (11 checks): a dependence-free stream costs exactly *n + 4*
      cycles; forwarded back-to-back dependent ALU ops stall **zero**; a load-use pair stalls
      **exactly one**; no-forwarding strictly increases that; multi-cycle EX lengthens the schedule
      monotonically (and a 5-cycle mul adds exactly 4 FU-latency cycles); a 2-bit predictor misses
      only the cold + final branch of a loop where always-not-taken misses all 9 taken ones; a
      same-line re-access hits while the cold one misses; one I-fetch per retired instruction and a
      larger penalty costs more; and — the keystone — the tracer leaves the interpreter's registers,
      pc and console output **byte-for-byte unchanged**.
- [x] **The Pipeline tab (`src/ui/Perf.tsx` + `App.tsx` + CSS).** A new top-level tab that analyzes
      the loaded program and shows: headline cycles / CPI / IPC / branch-accuracy / I$ & D$ miss
      cards, a stacked **where-the-cycles-go** breakdown (data, load-use, control, I$, D$, FU
      latency, structural), the **branch-prediction** comparison table, **cache** hit/miss tables,
      and a colour-coded **pipeline diagram** (instruction rows × cycle columns) with held-stage
      stalls and mispredictions flagged. Presets (Ideal core / Default / No forwarding) and live
      knobs (forwarding, predictor + BHT size, resolve stage, mul/div latency, miss penalty, I$/D$
      geometry) re-run the model instantly.
- [x] **Docs.** A "Microarchitecture & performance" section in the ISA reference explaining the
      pipeline model, the hazard/forwarding rules, every predictor, the cache parameters, and —
      importantly — that the timing layer is a model layered on the **unchanged** functional core.

#### Design rule (kept throughout)
The interpreter is authoritative and untouched; the timing model is a *pure function of the
retired trace* and never affects execution. So every prior self-test and example stays
byte-for-byte identical, and the new numbers are independently unit-tested against
hand-derived cycle counts.

### 2026-06-19 plan — RISC-V Studio 7.0: an **out-of-order superscalar** core (Tomasulo · ROB · LSQ)

The Performance Lab so far models a single-issue **in-order** 5-stage pipeline: it tells you how
fast a simple core would run a program, and a single long-latency op or one true dependence
stalls *everything behind it*. Real high-performance cores are nothing like that — they fetch and
retire several instructions per cycle, **rename** registers to dissolve false (WAR/WAW)
dependences, and **dynamically schedule** instructions out of program order so independent work
keeps flowing *under the shadow* of a cache miss or a 20-cycle divide. This session adds a second,
fully independent timing engine: a from-scratch **out-of-order superscalar** model in the
classic Tomasulo style with a **reorder buffer** for precise, in-order commit and a **load/store
queue** with address disambiguation and store-to-load forwarding. It runs beside the in-order
model on the *same* retired trace, so the Pipeline tab can now show, side by side, how much
**instruction-level parallelism** a real machine extracts from the very same program — IPC climbs
above 1, and the "where the cycles go" story becomes "what is the *bottleneck*: the ROB, the issue
queue, the functional units, the memory order, or the branch predictor?"

Same iron discipline as the MMU and the in-order model: **strictly decoupled and additive.** The
functional interpreter is never touched; the OoO engine is a pure function of `(trace, config)`,
so results stay byte-for-byte identical and only new *timing* numbers appear — each unit-tested
against hand-derived cycle counts and a battery of structural invariants.

Steps (each fully implemented + self-tested this session):

- [x] **The OoO engine (`src/perf/ooo.ts`).** A genuine cycle-driven Tomasulo simulator over the
      retired trace: in-order fetch (I$ + a front-end that squashes past a mispredicted branch
      until it *resolves*), in-order dispatch into a **reorder buffer** + unified **reservation
      stations**, **register renaming** via a producer map (so WAR/WAW false dependences simply
      do not exist), out-of-order **wakeup/select** (oldest-ready-first) onto a configurable pool
      of typed, pipelined-or-iterative **functional units**, a **common-data-bus** broadcast with
      bandwidth contention, and **in-order commit** (precise state). Memory goes through a
      **load/store queue**: stores drain to the D-cache at commit; loads do real **address
      disambiguation** and **store-to-load forwarding** out of the store buffer (with an
      in-order-memory mode for contrast). The mispredict penalty is *dynamic* — it depends on how
      late the branch resolves, the headline OoO insight a fixed-penalty in-order model can't show.
- [x] **OoO self-tests (`src/perf/ooo-tests.ts`).** Hand-computed oracles + invariants wired into
      the Verify suite: an independent stream reaches IPC → issue width while a true dependence
      chain stays at IPC ≈ 1 no matter how wide the machine; WAR/WAW false deps cost **zero**
      (renaming proven); a 20-cycle divide is fully **hidden** by independent work behind it (and
      *not* hidden once the ROB is too small to see past it); store→load forwarding beats an
      in-order-memory model; a late-resolving (data-dependent) branch costs **more** than an
      early one; plus whole-program structural invariants on every bundled example (fetch ≤
      dispatch ≤ issue ≤ complete ≤ commit, commit in order, exactly *n* instructions retired,
      IPC ≤ width).
- [x] **The Out-of-order view (`src/ui/Perf.tsx`).** A mode toggle on the Pipeline tab switches
      between the **5-stage in-order** model and the new **out-of-order superscalar** model. The
      OoO view shows headline cycles / IPC with the **speed-up over in-order**, the ILP achieved,
      a **bottleneck breakdown** (ROB-full / IQ-full / LSQ-full / front-end-starved dispatch
      stalls), **functional-unit utilization**, store-forwarding and memory-order stats, the
      branch-predictor comparison and caches (shared), and a colour-coded **instruction-lifetime
      (Gantt) diagram** — fetch → in reservation station → executing → waiting in the ROB →
      commit — with mispredicts, forwards and cache misses flagged. Live knobs: issue width, ROB /
      IQ / LSQ sizes, per-class FU counts, memory model, and the existing predictor/cache/latency
      controls re-run the model instantly.
- [x] **Docs.** A "Dynamic scheduling: the out-of-order superscalar core" section in the ISA
      reference explaining renaming, the ROB, reservation stations, the LSQ + forwarding, the CDB,
      and why the OoO mispredict penalty is dynamic — and, as always, that this is a *model* over
      the **unchanged** functional core.

#### Design rule (kept throughout, again)
Two independent timing models now read the one authoritative retired trace; neither can change a
single architectural bit. The OoO engine is a separate pure module with its own oracle suite, so
the in-order model and every prior test stay exactly as they were.

### 2026-06-23 plan — RISC-V Studio 8.0: the **B (bit-manipulation) extension** (Zba · Zbb · Zbc · Zbs)

The machine speaks RV32**IMAFC** + Zicsr + the privileged/MMU stack, but it has never had the one
extension that turns whole loops into single instructions: **B**, the ratified bit-manipulation
groups. A `popcount` was a shift-and-mask loop; counting leading zeros, rotating a word, reversing
byte order, or computing a CRC step each took a small subroutine. Real RISC-V cores ship `Zba`
(shift-and-add address generation), `Zbb` (counts, rotates, min/max, sign/zero extend, byte ops),
`Zbc` (carry-less multiply — the GF(2)/CRC kernel) and `Zbs` (single-bit ops). This session adds
**all four**, end to end.

The encodings are the genuine Zb* layouts, slotted into the existing `OP` / `OP-IMM` opcode space
and disambiguated purely by `funct3`/`funct7` (and, for the single-operand forms, the fixed `rs2`
selector). Because the whole studio is **table-driven off one `INSTRUCTIONS` spec**, the assembler,
decoder, disassembler, the syntax highlighter, and *both* timing models pick the new ops up almost
for free — strictly additive, every prior test and program byte-for-byte unchanged.

Steps (each fully implemented + self-tested this session):

- [x] **Encoding source of truth (`src/vm/isa.ts`).** Added a new `UNARY` instruction format (for
      single-operand `op rd, rs1` ops with a fixed 12-bit funct) and an optional `rs2` selector to
      `InstrSpec`, then specified every Zb op once: **Zba** `sh1add/sh2add/sh3add`; **Zbb**
      `andn/orn/xnor`, `min/minu/max/maxu`, `rol/ror/rori`, `clz/ctz/cpop`, `sext.b/sext.h/zext.h`,
      `orc.b/rev8`; **Zbc** `clmul/clmulh/clmulr`; **Zbs** `bclr/bset/binv/bext` (+ `*i` immediate
      forms). Exposed `ZB_MNEMONICS` / `ZB_UNARY_MNEMONICS` / `ZB_SHIFT_IMM_MNEMONICS`.
- [x] **Decoder (`src/vm/decode.ts`).** A `ZB_OP` table resolves the R-type Zb ops in the `OP`
      opcode by `(funct7, funct3)`, and the `OP-IMM` path now distinguishes the shift-immediate
      (`rori/bclri/bseti/binvi/bexti`) and single-operand (`clz/ctz/cpop/sext.*/orc.b/rev8`) forms
      by `funct7`/`rs2` before falling back to the base `slli/srli/srai`.
- [x] **Executor (`src/vm/cpu.ts`).** Pure 32-bit primitives (`popcount32`, `rotl/rotr32`, `orcb`,
      `byteReverse`, and `clmul/clmulh/clmulr` straight from the spec pseudocode) plus an execute
      case per mnemonic — `clz` via `Math.clz32`, `min/max` signed & unsigned, single-bit ops by
      index, etc. Zero-shift rotates are guarded against the `>>> 32` no-op trap.
- [x] **Assembler (`src/vm/assembler.ts`).** The generic `R`/`SHIFT` paths already encode the
      three-operand and shift-immediate Zb ops; added a `UNARY` path that parses `rd, rs1` and
      emits the fixed-funct12 word (covers `clz…rev8` and `zext.h`).
- [x] **Disassembler (`src/vm/disassembler.ts`).** Renders the single-operand ops as `op rd, rs1`,
      the shift-immediate ops with the shamt from the rs2 field, and `zext.h` as a one-source op —
      so every Zb word round-trips assemble→decode→disassemble→**re-assemble** to the same bits.
- [x] **Timing model (`src/perf/isa-classes.ts`).** Classified the Zb ops for the pipeline/OoO
      hazard logic: `clmul*` as multi-cycle `mul`, the single-operand ops as one-source ALU, the
      rest as two-source ALU — so cycle accounting stays correct.
- [x] **Worked example (`src/vm/examples.ts`).** A guided **Bit manipulation (Zb)** program that
      prints `cpop/clz/ctz/rev8/ror/max/clmul` results with labels — living documentation you can
      single-step.
- [x] **Self-tests (`src/vm/selftest.ts`).** 40+ new checks: execution results for every op
      (hand-obvious values), `clmul/clmulh/clmulr` against the spec, and a full
      encode→decode→disassemble→re-assemble round-trip for all 32 Zb mnemonics, plus a test that
      the bundled example runs. **90/90** total.
- [x] **Docs + branding (`src/ui/Docs.tsx`, `src/App.tsx`, `project.json`).** A new "B extension"
      instruction group + an explanatory section; the header/footer and catalog card now read
      RV32IMAFC **+ Zb** + Zicsr.

#### Design rule (kept, once more)
The new ops are data in the one `INSTRUCTIONS` table; nothing about the base machine changed, so
with no Zb instruction in a program the studio is byte-for-byte the RV32IMAFC it always was.

### 2026-06-25 plan — RISC-V Studio 9.0: the **V (vector) extension** (RVV 1.0 subset) — SIMD comes to the studio

The machine has grown from RV32I to RV32**IMAFC** + Zb + Zicsr + the M/S/U privileged stack and a
real Sv32 MMU, with two microarchitecture timing models on top. But it has never had the one piece
of modern RISC-V everyone is building silicon for: **V**, the ratified vector extension — the
*length-agnostic* SIMD ISA where one instruction processes a whole register's worth of elements and
the *same binary* runs unchanged on a machine with wider vectors. This session adds a faithful,
genuinely-executing **RVV 1.0 subset** end to end: a 32-register vector file with a configurable
`VLEN`, the `vtype`/`vl` dynamic configuration model, vector loads/stores (unit-stride, strided,
**indexed** scatter/gather — through the existing MMU), the integer arithmetic core, mask-producing
compares + the full mask-register algebra, reductions, slides, register gather, and the
vector↔scalar moves. Every op is the **genuine RVV encoding** in the `OP-V` (0x57) major opcode and
the vector width-encoded load/store opcodes (so it coexists with scalar `flw`/`fsw` exactly as real
hardware does), and the whole thing is woven through the assembler, decoder, disassembler, the
interpreter, the **time-travel journal**, the two timing models, the syntax highlighter, examples,
the verification suite and the docs.

Same iron discipline as every prior expansion — **strictly additive**: with no vector instruction
in a program the machine is byte-for-byte the RV32IMAFC it always was, and the `tracer`/timing
layer never affects results. The vector engine lives in its own `src/vm/vector.ts` module (the
encoding/spec source of truth, mirroring `fp.ts`/`mmu.ts`), and `cpu.ts` gains a self-contained
`executeVector` dispatch plus vector-register/vector-CSR undo so stepping backward through a vector
op is exact.

Model choices (documented, all legal RVV implementation choices): **VLEN = 128**, **ELEN = 32**
(SEW ∈ {8,16,32}; SEW=64 ⇒ `vill`). **LMUL ∈ {1,2,4,8, 1/2,1/4,1/8}** with register grouping and
the `SEW ≤ LMUL·ELEN` legality rule. **Tail and inactive (masked-off) elements are left
undisturbed** (an always-legal realization of the `ta`/`ma` *agnostic* policy), so behaviour is
fully deterministic and time-travel stays exact. `vstart` is modelled as always 0 (no mid-vector
traps in this deterministic core).

Steps (each fully implemented + self-tested this session):

- [x] **`src/vm/vector.ts` — the encoding source of truth.** `VLEN/VLENB/ELEN` constants; `vtype`
      field helpers (`vsew`/`vlmul`/`vta`/`vma`/`vill`), `SEW`/`LMUL` decode + `VLMAX` and the
      legality check; a `VEC_SPECS` table mapping every vector mnemonic to its `(funct6, category,
      operand-form)`; `encodeVector(mnemonic, operands)` → a fully-resolved 32-bit word (vectors
      reference no labels, so they encode at parse time); `decodeVectorMnemonic(raw)` for the
      decoder/disassembler; `isVectorOpcode(opcode, funct3)`; and the `V_MNEMONICS` set.
- [x] **Configuration: `vsetvli` / `vsetivli` / `vsetvl`.** Parse the `e8/e16/e32, mf8…m8, ta/tu,
      ma/mu` vtype token list; compute `VLMAX`, apply the AVL→`vl` rule (`vl = min(AVL, VLMAX)`,
      with the `rs1=x0`/`rd=x0` keep-vl and set-max special cases), write `vl` to `rd`, set the
      `vtype`/`vl`/`vstart` CSRs, and mark `vill` on an unsupported config.
- [x] **Vector loads / stores (through the MMU).** Unit-stride `vle{8,16,32}.v` / `vse{8,16,32}.v`,
      strided `vlse…`/`vsse…` (byte stride from `rs2`), **indexed** `vluxei…`/`vsuxei…`/`vloxei…`/
      `vsoxei…` (gather/scatter; index EEW from the mnemonic, data EEW = SEW), and the mask
      load/store `vlm.v`/`vsm.v`. All masked (`v0.t`) and all routed through `vmLoad`/`vmStore` so
      they honour Sv32 translation + page faults.
- [x] **Integer arithmetic (`OPIVV`/`OPIVX`/`OPIVI`).** `vadd`/`vsub`/`vrsub`, `vand`/`vor`/`vxor`,
      `vsll`/`vsrl`/`vsra`, `vminu`/`vmin`/`vmaxu`/`vmax`, the `vmerge`/`vmv.v.*` family — all with
      vector-vector, vector-scalar (`x`), and vector-immediate (5-bit) operand forms and masking.
- [x] **Multiply / divide / multiply-accumulate (`OPMVV`/`OPMVX`).** `vmul`/`vmulh`/`vmulhu`/
      `vmulhsu`, `vdivu`/`vdiv`/`vremu`/`vrem`, and the fused `vmacc`/`vnmsac`/`vmadd`/`vnmsub`.
- [x] **Mask-producing compares + the mask algebra.** `vmseq`/`vmsne`/`vmsltu`/`vmslt`/`vmsleu`/
      `vmsle`/`vmsgtu`/`vmsgt` (write a packed mask register), and the mask logical ops
      `vmand`/`vmnand`/`vmandn`/`vmor`/`vmnor`/`vmorn`/`vmxor`/`vmxnor`.
- [x] **Reductions + mask-population + element moves.** `vredsum`/`vredand`/`vredor`/`vredxor`/
      `vredminu`/`vredmin`/`vredmaxu`/`vredmax`; `vcpop.m`/`vfirst.m`; `vid.v`/`viota.m`;
      `vmsbf.m`/`vmsif.m`/`vmsof.m`; and `vmv.x.s`/`vmv.s.x` (scalar ↔ element 0).
- [x] **Permutes: slides + gather.** `vslideup`/`vslidedown` (`.vx`/`.vi`), `vslide1up`/
      `vslide1down` (`.vx`), and `vrgather` (`.vv`/`.vx`/`.vi`).
- [x] **Decoder / disassembler / assembler / highlighter.** Route `OP-V` + vector load/store
      opcodes to a new `'V'` `DecodedFormat`; render every vector form (incl. the `e32,m1,ta,ma`
      vtype on `vset*` and `v0.t` mask tails); a `expandVector` path in the assembler emitting the
      precomputed word; vector mnemonics + `v0.t`/vtype tokens highlighted in the editor.
- [x] **Vector CSRs + time-travel.** `vstart`(0x008)/`vxsat`(0x009)/`vxrm`(0x00A)/`vcsr`(0x00F)/
      `vl`(0xC20)/`vtype`(0xC21)/`vlenb`(0xC22) wired into `readCsr`/`writeCsr`; the undo journal
      snapshots the vector CSRs and records the exact vector-register bytes a vector op overwrites,
      so `stepBack` reverses a vector instruction byte-for-byte.
- [x] **Timing model.** Classify `'V'` ops in `isa-classes.ts` (vector loads/stores as `load`/
      `store` reading the `x` base — so the cache model still sees the address; `vsetvl*` and
      `vmv.x.s`/`vmv.s.x` as `alu` touching the `x` file; the rest as register-hazard-free `alu`),
      so both the in-order and OoO models schedule vector programs without aliasing the integer
      register file.
- [x] **A Vector register inspector + Docs.** A new inspector panel that renders `vtype`
      (decoded SEW/LMUL/ta/ma/vill), `vl`/`vlenb`/`vstart`, and each `v0..v31` register laid out as
      its current-SEW element lanes; an ISA-reference "V (vector) extension" section; RV32IMAFC
      **+ V** branding on the header/footer + catalog card.
- [x] **Worked examples.** SAXPY (`y = a·x + y` with `vmacc`/strip-mining over `vsetvli`), a vector
      dot-product via `vredsum`, a vectorized `memcpy`, a `vrgather` table permute, and a masked
      `vcompress`-style select — guided, single-steppable living documentation.
- [x] **Self-tests.** A large battery: `vset*` `vl`/`vtype`/`vill` semantics; arithmetic /
      multiply / mac results across SEW and LMUL>1 register grouping; compares + mask algebra;
      reductions; slides + gather; unit-stride / strided / **indexed** load-store round trips
      through memory; masking (`v0.t`) leaving inactive + tail elements undisturbed; exact
      `stepBack` reversal of a vector op; and an assemble→decode→disassemble→**re-assemble**
      round-trip for every vector mnemonic.

#### Design rule (kept, yet again)
The vector engine is a separate module + a self-contained `executeVector`; the base ISA tables are
untouched, so with no vector op a program is byte-for-byte the RV32IMAFC it always was. The timing
models still read only the retired trace and never change an architectural bit.

### 2026-06-26 plan — RISC-V Studio 10.0: an **optimizing compiler back end & assembly optimizer** (Forge)

The studio can *describe* how fast hardware would run a program (the performance lab + the
out-of-order core), and it can *compile* C to RISC-V — but the C back end is a deliberately naive
**stack machine**: every expression lands in `a0`, every binary operator spills its left operand
to the stack. That is correct-by-construction and great for teaching, but it leaves an enormous
amount of obviously-removable work on the floor (push/pop spill pairs, `mv` chains, dead `li`s,
`addi rd,rs,0`, redundant reloads). **10.0 closes the loop**: a real optimizing back end —
*Forge* — that takes the studio's own assembly, builds a control-flow graph, runs textbook
data-flow analyses and a fixpoint of optimization passes, and emits faster assembly that is
**provably equivalent** (assemble+run both, assert byte-for-byte identical registers / memory /
console output). Then it *measures the win* by feeding both versions through the existing
performance model — the optimizer and the timing lab finally meet. Everything is purely additive:
a new `src/opt/` library, a new **Optimizer** tab, and a new self-test suite. The interpreter, the
assembler and every existing example are untouched.

Core IR & analysis:
- [x] `src/opt/ir.ts` — a structured assembly IR (operands: int/float regs, immediates, symbols
  with `%hi`/`%lo`, `off(reg)` memory, csr); lossless line model that round-trips data/unknown lines verbatim
- [x] `src/opt/parse.ts` — parse the studio's own assembly text into the IR (labels-on-instruction,
  directives, sections, comments preserved) and a printer that re-emits assembler-legal text
- [x] `src/opt/semantics.ts` — a precise per-mnemonic semantics table over the RV32IM + pseudo
  subset: defs/uses, memory read/write, side effects, terminator/branch/call/fallthrough facts,
  and an `eliminable` flag — the single source of truth that keeps every pass correct
- [x] `src/opt/cfg.ts` — split each function into basic blocks, compute leaders/edges/terminators,
  unreachable-block detection, and a printable CFG for the UI
- [x] `src/opt/liveness.ts` — backward live-variable data-flow over the CFG, calling-convention
  aware (caller-saved clobbered across calls; `a0`/`ra`/`sp`/`s0`+callee-saved live at returns)
- [x] `src/opt/values.ts` — forward constant/copy lattice + a conservative alias model proving the
  stack-machine's `sp`-relative spill slots can never alias `s0`-locals or the heap

Optimization passes (run to a fixpoint, each logging what it changed):
- [x] Peephole simplification — `addi rd,rs,0`→`mv`, `mv rd,rd`/`addi rd,rd,0` drop, `x0`/identity
  algebra (`add rd,rs,x0`, `mul rd,rs,x0`→`li 0`, `or rd,rs,x0`, …), `li`+op folding
- [x] Constant folding & propagation — track known register constants, fold `li`/`addi`/`add`/
  `sub`/`and`/`or`/`xor`/shifts/`mul`/`slt` on constants, rewrite uses, retarget `beqz`/`bnez`
- [x] Copy propagation — replace reads of a `mv`-copied register with its source where safe
- [x] Algebraic strength reduction — `mul`/`div`/`rem` by a power of two → shift/mask, `*0`,`*1`,`+0`
- [x] **Stack-slot promotion / store-to-load forwarding** — collapse the codegen's
  `addi sp,sp,-4; sw a0,0(sp)` … `lw a1,0(sp); addi sp,sp,4` push/pop idiom into register moves by
  tracking the abstract stack depth within a block (the headline win against the naive back end)
- [x] Dead-store elimination on provably-private spill slots
- [x] Dead-code elimination — drop any instruction whose only effect is a register def that is dead
  out (liveness-driven), iterated to a fixpoint
- [x] Local value numbering / CSE — within a block, reuse an already-computed identical value
- [x] Control-flow simplification — drop `j .Lnext` to the following label, thread jump-to-jump,
  fold constant `beqz`/`bnez`, delete unreachable blocks and now-unused labels
- [x] `src/opt/optimize.ts` — the driver: a configurable pass pipeline iterated to a fixpoint with a
  structured per-pass change log and before/after instruction & block counts

Verification & UI:
- [x] `src/opt/equiv.ts` — the differential oracle: assemble+run original and optimized on a
  throwaway history-free CPU, assert byte-for-byte identical registers / console output / status /
  touched memory; returns a verdict the UI shows as a "provably equivalent" badge
- [x] `src/opt/opt-tests.ts` — a self-test suite: transform unit tests (each pass fires on a minimal
  case), end-to-end equivalence over every bundled C example + hand asm, and idempotence/fixpoint
  checks — wired into the in-app **Verify** tab so the count and green bar grow
- [x] `src/ui/Optimizer.tsx` — the **Optimizer** tab: pick a source (compile a C snippet, pull the
  current editor program, or a curated example), see a before→after side-by-side with removed/
  rewritten lines flagged, the per-pass transformation log, the instruction-count / static-size
  reduction, the **cycle win** measured through the existing performance model (CPI/cycles before
  vs after), the equivalence badge, and the rendered CFG; a "send optimized asm to the debugger"
  button reuses the existing seam
- [x] Docs section explaining each pass and the safety/alias model; tags + description refresh

### 2026-06-28 plan — RISC-V Studio 11.0: the **D (double-precision) extension** — RV32D, FLEN=64 + NaN-boxing

This is the last unticked item on the original backlog, and the one that makes the machine a real
**RV32IMAFDC + Zicsr + Zb** core. The D extension widens the floating-point register file to 64 bits
(FLEN = 64) and adds the IEEE-754 *double* counterpart of every F instruction. The interesting part
is **NaN-boxing**: with FLEN now wider than a single, a 32-bit `f` value lives in the low 32 bits with
the high 32 bits set to all-ones (`0xFFFF_FFFF`); a single-precision op that reads an improperly-boxed
register must treat the input as the canonical single NaN. Getting that exactly right — so the whole
existing F test-suite still passes bit-for-bit while D rides on top — is the headline correctness win.

**Architecture decisions (recorded up front):**

- The f-register file becomes **two `Uint32Array(32)`** — `fregs` (low word) and `fregsHi` (high word) —
  rather than a `BigUint64Array`. This keeps the hot single path branch-free *and* keeps `cpu.fregs[i]`
  reading the single's bits for the few external consumers (the inspector, `print_float`), while the
  high word carries the NaN-box / the upper half of a double. A small set of typed accessors
  (`singleBits`/`single`/`double` reads, `setSingleBits`/`setSingle`/`setDoubleBits`/`setDouble` writes)
  funnel every f-register touch through one `writeFreg(i, lo, hi)` that logs `{i, prevLo, prevHi}` so
  **time-travel** reverts a 64-bit write exactly.
- A correct **fused multiply-add for doubles** (`fmaD`) via the standard error-free transforms
  (Veltkamp split → two-product → two-sum, then a single rounding). Naive `a*b+c` double-rounds, which
  is the *whole point* the FMA instruction exists to avoid; for the 32-bit path JS doubles already
  carry the extra precision, but for the 64-bit path there is no wider type, so the EFT matters.
- `fld`/`fsd` are an aligned **pair of 32-bit `vmLoad`/`vmStore`** so they inherit the existing MMU
  translation, MMIO, page-fault and time-travel-record machinery per word for free.

**Implementation steps (each lands green through the CI gate):**

- [x] `fp.ts`: 64-bit soft-float boundary (`f64FromBits`/`bitsFromF64`), the canonical double NaN, the
      NaN-box predicate, a 64-bit `fclass64`, 64-bit min/max, the `fmaD` error-free FMA, the `FpSpec`
      `fmt` field, all D `FP_SPECS` rows, and a `decodeFpMnemonic` rewrite that resolves S vs D from the
      `fmt` bit (and the two cross-precision casts `fcvt.s.d` / `fcvt.d.s`).
- [x] `cpu.ts`: widen the register file to `fregs`/`fregsHi`; typed accessors + `writeFreg`; widen the
      undo record + `stepBack`; rewrite `executeFp` to box-check every single read and to implement the
      full D opcode set (arith, sqrt, sign-inject, min/max, compares, all four rounding-mode int casts,
      the int→double casts, the S↔D casts, `fclass.d`, and the four D fused multiply-adds). Also set the
      **D bit in `misa`** (now RV32IMAFDC).
- [x] `decode.ts`/`disassembler.ts`: a `cvt.ff` render kind + `fmv.d`/`fneg.d`/`fabs.d` disasm pseudos.
- [x] `assembler.ts`: D load/store width from the spec, the FMA `fmt` encode bit, the `cvt.ff` operand
      shape, and the `fmv.d`/`fneg.d`/`fabs.d` sign-injection pseudos.
- [x] `perf/isa-classes.ts`: classify every D mnemonic (so the pipeline / OoO labs model D latency).
- [x] `syscalls.ts`: `print_double` (ecall #3, RARS convention) reading `fa0` as a 64-bit double.
- [x] `Registers.tsx`: a **precision-aware** float inspector — full 64-bit hex, a *double* reading, and
      a NaN-box badge when the high word marks a boxed single. `highlight.ts` learns the `.d` pseudos.
- [x] RV32C **double** load/stores: `c.fld`/`c.fsd`/`c.fldsp`/`c.fsdsp` end-to-end (rvc.ts + assembler)
      — their own ×8-scaled CL/CS/CI/CSS immediate codecs, with paired pack/unpack so encode and decode
      agree.
- [x] `examples.ts`: a double-precision showcase — `double-e` (Σ 1/k! to ~15 digits, far past a float's
      ~7) and `double-fma` (the EFT-fused `fmadd.d` recovers the exact integer that `fmul.d`+`fadd.d`
      loses by 1 ulp).
- [x] `selftest.ts`: a 13-strong D test group — arithmetic, S↔D round-trips, NaN-boxing (a single op
      reading a double-occupied register yields a quiet NaN), `print_double`, `fclass.d`, **byte-exact**
      encode⇄decode⇄disassemble⇄re-assemble round-trips, the FMA single-rounding property, 64-bit
      time-travel, and the compressed-D load/store path. 166/166 green.
- [x] `Docs.tsx`: the D extension + `print_double` on the ISA reference page; headline ISA string bumped
      to `RV32IMAFDCV` across the app (header, status bar, docs, `misa`).

## Session log

- 2026-06-28 (claude / claude-opus-4-8): **RISC-V Studio 11.0 — the D (double-precision) extension.**
  Closed the last open item on the original backlog: the machine is now a real **RV32IMAFDC + Zicsr +
  Zb** core. The headline is the floating-point register file growing to **FLEN = 64** with correct
  **NaN-boxing**: `fregs`/`fregsHi` parallel word arrays, a small set of typed accessors
  (`singleBits`/`singleVal`/`doubleVal` reads, `setSingle*`/`setDouble*` writes) that funnel every
  touch through one `writeFreg(i, lo, hi)`, so a single occupies the low word with the high word
  all-ones and a `.s` op that reads an improperly-boxed register sees the canonical NaN — which is
  exactly why the entire pre-existing F suite still passes bit-for-bit while D rides on top. Shipped
  end to end: all OP-FP doubles (`fadd/fsub/fmul/fdiv/fsqrt.d`, sign-injection, `fmin/fmax.d`,
  `feq/flt/fle.d`, the four rounding-mode int casts `fcvt.w/wu.d` + `fcvt.d.w/wu`, the cross-precision
  casts `fcvt.s.d`/`fcvt.d.s`, `fclass.d`), `fld`/`fsd` as aligned word pairs through the MMU, and the
  four D fused multiply-adds — backed by a genuine **error-free-transform `fmaD`** (Veltkamp split →
  two-product → two-sum, single rounding) so the fused op is *actually* fused, not naive `a*b+c` that
  double-rounds. The encoding tables stay the single source of truth: `decodeFpMnemonic` resolves S/D
  from the `fmt` bit, the assembler reads load/store width and the FMA `fmt` from the spec, and a new
  `cvt.ff` kind handles the precision casts; `fmv.d`/`fneg.d`/`fabs.d` join the sign-injection pseudos.
  Also landed the **RV32DC** compressed double load/stores (`c.fld`/`c.fsd`/`c.fldsp`/`c.fsdsp`) with
  their own ×8-scaled immediate codecs (paired pack/unpack), the perf lab's instruction classifier for
  every D mnemonic, a `print_double` syscall (#3), a **precision-aware** float inspector (auto-detects a
  boxed single vs a double, shows the full 64-bit hex + a `d` badge), the D bit in `misa`, two showcase
  examples (`double-e`, `double-fma`), and the docs. Two things worth recording for next time: (a) the
  64-bit time-travel test must **step explicitly** up to the instruction under test — running the whole
  program and then `stepBack()` reverts the trailing `ecall`, not the `fdiv.d`; (b) a naive forward
  `Σ 1/k!` lands one ulp off true `e` (2.7182818284590455 vs …45), which is the expected
  accumulation error and itself a nice demonstration that the depth is real. The self-test suite grew
  to **166/166 green**, including byte-exact encode⇄decode⇄disassemble⇄re-assemble round-trips for the
  full D instruction set. All strictly additive; the gate (conformance + lint + build) is clean.

- 2026-06-26 (claude / claude-opus-4-8): **RISC-V Studio 10.0 — Forge, an optimizing compiler back
  end & assembly optimizer.** Closed the loop between the studio's two halves: the compiler can now
  *describe* code (the C back end) and the perf lab can *score* it, and Forge makes the code itself
  faster, provably. New `src/opt/` library (zero new deps, strictly additive): a structured assembly
  IR + parser/printer that round-trips the studio's own assembly byte-for-byte (opaque vector/atomic
  forms re-emit verbatim; only instructions a pass actually rewrites are re-rendered), a precise
  per-mnemonic `semantics` table (exact `defs` for DCE vs a wider `clobbers` for value-prop —
  the two-approximation distinction that keeps liveness and propagation both sound), a CFG builder,
  global backward **liveness**, and the passes: peephole + algebraic simplification; block-local
  **value propagation** (constant + copy lattice + a base+offset address lattice → constant folding,
  copy propagation, ×/÷/% by a power of two → shift/mask, address-mode folding `addi rT,rB,K; lw
  rD,0(rT)` → `lw rD,K(rB)`, and constant-branch resolution); **CSE** by value numbering;
  **stack-slot forwarding** — the headline win against the naive stack machine, proving the
  `sp`-relative spill temporaries private (addresses never taken; a region disjoint from the
  `s0`-frame and heap) so every pop is rematerialised (`li`/`addi`/`mv`) and the dead spill store
  removed; **dead stack-slot** elimination of the now-useless `sp` adjustments; **control-flow**
  simplification (jump-to-next, jump threading, unreachable-block deletion); and liveness-driven
  **dead-code elimination** — all iterated to a fixpoint with a structured per-pass change log.
  Correctness is enforced by a **differential oracle** (`equiv.ts`): the original and optimized
  programs run on throwaway CPUs and must produce byte-identical console output + exit code (compare
  only *observable* behaviour, never dead temporaries). Two subtle soundness fixes worth recording:
  (a) `sp`/`s0` are kept as *opaque pointer bases* — never re-expressed as `base+offset` — so frame
  refs are never mis-aliased as stack temps (this bug first showed up as a corrupted `0(sp)` and a
  frozen example); (b) **loads are non-eliminable** because a load can *trap* (a page fault under an
  active MMU is an observable control transfer), which the Sv32 example caught immediately when a
  dead-result load was wrongly removed. Shipped the **Optimizer tab** (`src/ui/Optimizer.tsx`):
  C-or-assembly input, a before→after metric strip (static instructions, code-size bytes, retired
  instructions, **and cycles measured through the existing pipeline model**), the green "provably
  equivalent" badge, the optimized listing, a side-by-side diff, the per-pass transformation log,
  and the rendered CFG; "send optimized asm to the debugger" reuses the existing seam. Added a Docs
  section and a self-test suite (`opt-tests.ts`): a unit test per pass, end-to-end equivalence over
  every bundled C + assembly example, an idempotence/fixpoint check, and a **randomized differential
  fuzzer** over 200 pseudo-random programs (with balanced stack traffic) — wired into the Verify tab
  (now **151/151 green** in-browser, verified with Chromium). Forge removes **~37–42% of the static
  instructions** on the bundled C programs and a comparable share of the modelled cycle count
  (e.g. the spill demo: 1076→660 instrs, 890→573 cycles). Verified via
  `node scripts/verify-project.mjs riscv-studio-e3b1` (scope + conformance + lint + build) and a
  headless browser smoke test of the Optimizer + Verify tabs. Strictly additive: the interpreter,
  assembler and every prior example are untouched.
- 2026-06-25 (claude / claude-opus-4-8): **RISC-V Studio 9.0 — the V (vector) extension (RVV 1.0
  subset).** Added a faithful, genuinely-executing vector ISA end to end — the single most
  recognizable piece of modern RISC-V. New `src/vm/vector.ts` is the encoding source of truth (the
  `VEC_SPECS`/load-store tables, `assembleVector` → a fully-resolved word, `decodeVectorMnemonic`,
  the `vtype` decode + `VLMAX`/legality helpers, the `e32,m1,ta,ma` vtype-token parser); `cpu.ts`
  gained a 32-register **vector file** (`Uint8Array`, VLEN=128), the vector CSRs
  (`vstart/vxsat/vxrm/vcsr/vl/vtype/vlenb`), and a self-contained **`executeVector`** dispatch. The
  model is **VLEN=128, ELEN=32** (SEW e8/e16/e32; e64⇒vill) with **LMUL ∈ {1,2,4,8,½,¼,⅛}** register
  grouping and the `SEW ≤ LMUL·ELEN` rule; tail + masked-off elements are left **undisturbed** (a
  legal ta/ma realization), so it is deterministic and time-travel-exact. Implemented:
  `vsetvli/vsetivli/vsetvl` (AVL→vl with the x0/x0 keep-vl and set-max cases); vector loads/stores
  through the **MMU** — unit-stride `vle{8,16,32}.v`/`vse…`, strided `vlse/vsse`, **indexed**
  gather/scatter `vluxei/vsuxei/vloxei/vsoxei`, and packed-mask `vlm.v`/`vsm.v`; the integer core
  (`vadd/vsub/vrsub`, `vand/vor/vxor`, `vsll/vsrl/vsra`, `vmin/vmax{,u}`, `vmul/vmulh{,u,su}`,
  `vdiv{,u}/vrem{,u}`) in `.vv`/`.vx`/`.vi` forms with masking; fused MAC (`vmacc/vnmsac/vmadd/
  vnmsub`); mask-producing compares (`vmseq…vmsgt`) + the full mask algebra (`vm{and,nand,andn,or,
  nor,orn,xor,xnor}.mm`, `vcpop.m`, `vfirst.m`, `vid.v`, `viota.m`, `vmsbf/vmsif/vmsof.m`);
  reductions (`vredsum/and/or/xor/min{,u}/max{,u}.vs`); permutes (`vslideup/down`, `vslide1up/down`,
  `vrgather.{vv,vx,vi}`); and the moves (`vmv.x.s`/`vmv.s.x`, `vmv.v.{v,x,i}`, `vmerge.v{v,x,i}m`).
  Every op is the genuine RVV encoding in the `OP-V` (0x57) opcode (vector loads/stores ride the FP
  load/store opcodes, width-disambiguated so they coexist with scalar `flw`/`fsw` exactly as real
  hardware does), woven into the decoder (new `'V'` format), disassembler, assembler (a `vecWord`
  micro carrying the precomputed encoding), the syntax highlighter, and **both** timing models
  (vector mem reads the `x` base so the cache model sees a real address; the rest carry no spurious
  integer-register hazards). The **time-travel** journal snapshots the vector CSRs and records the
  exact vector-register bytes each op overwrites, so `stepBack` reverses a vector instruction
  byte-for-byte. Shipped a live **vector inspector** (decoded vtype + `vl`/`vlenb`/`vstart` + each
  `v0..v31` as its current-SEW lanes), a Docs "V extension" section + reference group, a strip-mined
  **SAXPY + `vredsum`** example, and **22 new self-tests** (vset `vl`/`vtype`/`vill`; arithmetic /
  multiply / MAC across SEW and LMUL>1 grouping; compares + mask logic; reductions; slides + gather;
  unit-stride / strided / indexed memory round trips; masking leaving inactive + tail elements
  undisturbed; exact `stepBack` reversal of a whole vector program; and an assemble→decode→disasm→
  **re-assemble** round-trip for *every* vector mnemonic). Strictly additive: with no vector op a
  program is byte-for-byte the RV32IMAFC it always was. Verified headless (**112/112** in-app
  self-tests — 90 prior + 22 vector — plus the timing models scheduling the vector example cleanly)
  and via `node scripts/verify-project.mjs riscv-studio-e3b1` (scope + conformance + lint + build).

- 2026-06-23 (claude / claude-opus-4-8): **RISC-V Studio 8.0 — the B (bit-manipulation) extension.**
  Added the full ratified **Zba + Zbb + Zbc + Zbs** instruction set end to end — ~40 new mnemonics —
  woven into the existing `OP`/`OP-IMM` opcode space and driven entirely off the one `INSTRUCTIONS`
  spec table, so the change is strictly additive and every prior test/program is byte-for-byte
  unchanged. **Zba** shift-and-add address generation (`sh1add/sh2add/sh3add`); **Zbb** logic-with-
  negate (`andn/orn/xnor`), bit counts (`clz/ctz/cpop`), signed & unsigned `min/max`, rotates
  (`rol/ror/rori`), sign/zero extension (`sext.b/sext.h/zext.h`) and byte ops (`orc.b/rev8`);
  **Zbc** carry-less multiply (`clmul/clmulh/clmulr`, the CRC/GF(2) kernel, implemented straight
  from the spec pseudocode); **Zbs** single-bit set/clear/invert/extract (`bset/bclr/binv/bext` +
  `*i`). Touched only the data path the design always intended: a new `UNARY` instruction format +
  `rs2` selector in `isa.ts`; a `ZB_OP` decode table and refined `OP-IMM` `funct7`/`rs2`
  disambiguation in `decode.ts`; pure 32-bit primitives + an execute case per op in `cpu.ts`; a
  `UNARY` encode/parse path in `assembler.ts`; single-operand / shift-immediate / `zext.h` rendering
  in `disassembler.ts`; and a Zb classification (clmul = multi-cycle, the rest ALU) in the
  pipeline/OoO `isa-classes.ts`. The syntax highlighter and both timing models picked the ops up for
  free. Shipped a guided **Bit manipulation (Zb)** example (`cpop/clz/ctz/rev8/ror/max/clmul` with
  labels) and **40+ new self-tests** — execution results with hand-obvious values, `clmul*` against
  the spec, and a full assemble→decode→disassemble→**re-assemble** round-trip for all 32 Zb
  mnemonics — plus Docs ("B extension" group + section) and RV32IMAFC **+ Zb** branding. Verified
  headless (**90/90 self-tests**, 75 prior + 15 new groups) and via
  `node scripts/verify-project.mjs riscv-studio-e3b1` (scope + conformance + lint + build all green).

- 2026-06-19 (claude / claude-opus-4-8): **RISC-V Studio 7.0 — an out-of-order superscalar core.**
  Added a second, fully independent microarchitecture timing engine beside the in-order pipeline: a
  from-scratch **Tomasulo** dynamically-scheduled machine in `src/perf/ooo.ts` (~640 LOC) that reads
  the *same* retired trace, so the functional core stays byte-for-byte untouched. It models genuine
  out-of-order execution end to end — superscalar in-order fetch (I$ + a front-end that squashes
  past a mispredicted branch until it *resolves*), in-order dispatch into a bounded **reorder
  buffer** + unified **reservation stations**, **register renaming** via a producer map (WAR/WAW
  false dependences vanish), out-of-order **wakeup/select** (oldest-ready-first) onto a configurable
  pool of typed pipelined/iterative **functional units**, a bandwidth-limited **common data bus**,
  in-order **commit** for precise state, and a **load/store queue** with address disambiguation +
  store-to-load forwarding (with an in-order-memory mode for contrast). The misprediction penalty is
  **dynamic** — charged from the cycle the branch actually resolves — so a branch that waits on a
  slow multiply costs far more than one resolved early. The Pipeline tab gained a **mode toggle**
  (`src/ui/Perf.tsx`): the new view shows IPC + **speed-up over in-order**, ROB occupancy, store-
  forward / memory-order stats, **functional-unit utilization**, a dispatch-**bottleneck** breakdown
  (ROB/RS/LSQ-full, front-end-starved), and a colour-coded **instruction-lifetime (Gantt) diagram**
  (fetch → reservation station → executing → ROB wait → commit, with mispredicts/forwards/misses
  flagged). Wrote 10 hand-derived **oracle + invariant** self-tests (`src/perf/ooo-tests.ts`):
  IPC → issue width on independent work while a true chain stays ≈1; renaming costs zero; a 20-cycle
  divide is hidden behind independent work (and *not* once the ROB is too small); store→load
  forwarding; disambiguation beats in-order memory; a late-resolving branch costs more; and
  whole-program structural invariants (fetch ≤ dispatch < issue < complete ≤ commit, in-order
  commit, exactly *n* retired, IPC ≤ width, wider-never-slower) on every bundled example. Added a
  Docs section. Verified headless (**85/85** in-app self-tests — 64 core + 11 in-order + 10 OoO — all
  17 example programs schedule with invariants intact and no scheduler bail) and via
  `node scripts/verify-project.mjs riscv-studio-e3b1` (scope + conformance + lint + build).
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
- 2026-06-17 (claude / claude-opus-4-8): **RISC-V Studio 6.0 — a microarchitecture performance
  lab.** Added a **trace-driven timing model** (`src/perf/`) that turns the studio into a
  teaching-grade performance analyzer without touching the functional core. The interpreter
  gained a single new seam — an opt-in, null-guarded `tracer` hook (`src/vm/cpu.ts`) that emits a
  `RetireEvent` per retired instruction — and the timing layer is a *pure function* of that real
  dynamic stream, so architectural results are provably unchanged (a differential self-test checks
  registers/pc/output byte-for-byte). The model is a classic **5-stage in-order pipeline**
  (`pipeline.ts`) scheduled by the textbook stage-entry recurrence: data hazards with optional
  **forwarding** (EX→EX and MEM→EX, including the unavoidable one-cycle load-use bubble) or the
  no-forwarding write-before-read path, multi-cycle EX latencies (mul/div, fp add/mul/div),
  **branch prediction** (`predictor.ts`: static, 1-bit, 2-bit bimodal, gshare + a BTB; a miss is
  direction- or target-wrong) with a misprediction flush penalty (ID- or EX-resolve), and a
  set-associative **I-cache + D-cache** (`cache.ts`: size/block/ways/LRU-FIFO/write-back-through)
  whose miss penalty folds into stage latency. A per-instruction classifier (`isa-classes.ts`)
  keeps the integer and float register files from aliasing in the hazard logic. The analyzer
  (`analyze.ts`) runs the program on a throwaway history-free CPU (300k-instruction trace cap),
  feeds the trace through the pipeline + caches + selected predictor, and replays the branch trace
  through *all* predictors for a comparison. Shipped the **Pipeline tab** (`src/ui/Perf.tsx`):
  cycles/CPI/IPC + branch-acc + I$/D$-miss cards, a where-the-cycles-go stall breakdown, the
  all-predictors accuracy table, cache hit/miss tables, and the colour-coded instruction × cycle
  **pipeline diagram** with held-stage stalls and ⚡-flagged mispredictions — all driven by live
  presets/knobs. Added an ISA-reference Docs section. Verified headless (the 11 hand-computed cycle
  oracles all green; the analyzer smoke-run clean across every bundled example — floats, atomics,
  paging, compressed, framebuffer — with sensible CPI/cache numbers and the 300k cap engaging on
  the infinite demos) and via `node scripts/verify-project.mjs riscv-studio-e3b1` (scope +
  conformance + lint + build; **75/75** self-tests, 64 prior + 11 new).
