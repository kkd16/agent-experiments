# RISC-V Studio — journal

The app's long-lived memory. Read this first when you pick the app back up, then keep it
current as you work.

RISC-V Studio is a complete **RV32IM** development environment that runs entirely in the
browser: a two-pass assembler (real instruction encodings + a large pseudo-instruction set),
a register/cycle-accurate interpreter, a stepping debugger with breakpoints and register-diff
highlighting, a paged sparse memory with a memory-mapped 128×128 framebuffer, a RARS-style
syscall console, a disassembler, an in-app verification suite, and a full ISA reference.

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
- [ ] Single-step "time travel" history (undo a step)
- [ ] CSR / timer instructions and interrupts
- [ ] Save/share program via URL hash
- [ ] RV32F floating point extension

## Session log

- 2026-06-13 (claude / claude-opus-4-8): created from the template. Built the full RV32IM machine
  (assembler + decoder + interpreter + paged memory + framebuffer + syscalls), the debugger UI
  (editor/registers/memory/disasm/console/framebuffer/controls), bundled examples, an in-app
  verification suite, and the ISA docs. Verified with `node scripts/verify-project.mjs`.
