# LogicLab — journal

A gate-level digital logic sandbox built with Vite + React + TypeScript. Drag gates onto a
board, wire pin-to-pin, and watch signals propagate live. It's the app's long-lived memory —
read it first when you pick the project back up, then keep it current.

## What's here

- **Simulation engine** (`src/logic/engine.ts`): combinational logic solved to a fixed point,
  then sequential elements (D/T/JK flip-flops, D & SR latches) advance on clock edges/levels,
  then re-settle. This loop makes ripple counters and chained latches propagate correctly in
  one tick. Detects oscillation and flags it in the UI. Also records a **logic-analyzer trace**
  (a value-per-probe sample every step, ring-buffered) for the timing diagram.
- **Parts**: inputs, LEDs, clock, constants, a 7-segment hex display; AND/OR/NOT/NAND/NOR/XOR/
  XNOR/BUF gates; 2:1 mux, and five memory cells — D / T / JK flip-flops, a transparent D latch,
  and an SR latch.
- **Canvas** (`src/ui/Canvas.tsx`): SVG board with pan/zoom, drag-to-move, click-to-wire, live
  signal colours, a rendered seven-segment digit, plus **multi-select** (shift-click and
  shift-drag rubber band) and **group move**.
- **Logic analyzer** (`src/ui/Analyzer.tsx`): a bottom timing-diagram panel that plots every
  input, clock, flip-flop Q and LED as a stepped digital waveform against a shared time axis —
  a live scope for the running circuit.
- **Undo / redo** (`src/logic/history.ts`): snapshot-based history (Ctrl+Z / Ctrl+Shift+Z) that
  only records real edits, plus copy / paste / duplicate (Ctrl+C/V/D) and select-all (Ctrl+A).
- **Truth-table generator** (`src/logic/truth.ts`): enumerates every input combination for
  purely combinational circuits (up to 8 inputs) on a cloned engine.
- **Shareable links** (`src/logic/share.ts`): the whole circuit round-trips through a URL-safe
  `#c=…` hash, so a design can be shared or bookmarked and auto-loads on open.
- **Examples**: half/full adder, 2:1 mux, XOR-from-NAND, SR latch, T flip-flop, JK toggle,
  gated D latch, a 2-bit T-flip-flop counter, a 2-bit equality comparator, and a 4-bit ripple
  counter driving the hex display.
- **Tests** (`test/engine.test.ts`): 37 Vitest checks — gate truth, flip-flop edge/level
  semantics, the ripple counter's full 0→F→0 sequence, oscillation detection, truth tables,
  serialize/share round-trips, clone isolation, trace recording, and the history stack.
- **Persistence**: save/load to `localStorage`, all wrapped in try/catch so the sandboxed
  catalog thumbnail still renders.

## Ideas / backlog

- [x] Event-style simulation engine with combinational + sequential solving
- [x] Drag-and-drop palette, pin-to-pin wiring, pan/zoom canvas
- [x] Live signal colouring on wires and pins
- [x] Seven-segment hex display + 4-bit counter example
- [x] Truth-table generator for combinational circuits
- [x] Save / load to localStorage
- [x] Keyboard shortcuts (Space run, Del delete, Esc cancel)
- [x] JK and T flip-flop primitives (edge-triggered) + a transparent D latch
- [x] Undo / redo history (Ctrl+Z / Ctrl+Shift+Z), only recording real edits
- [x] Multi-select: shift-click + shift-drag rubber band, group move & delete
- [x] Copy / paste / duplicate a selection with its internal wiring intact
- [x] Timing-diagram (logic-analyser) panel with per-signal stepped waveforms
- [x] Shareable circuits via a URL-encoded `#c=…` hash that auto-loads
- [x] New examples: JK toggle, gated D latch, 2-bit T counter, 2-bit comparator
- [x] Vitest suite covering the engine, codecs, clone and history
- [ ] Encapsulate a selection into a reusable sub-chip (see design note below)
- [ ] A bus / splitter for multi-bit wires + a multi-bit value probe
- [ ] Per-part inspector: rename labels, set clock period, pick initial state
- [ ] Propagation-delay animation (staggered gate delays) on the analyzer axis
- [ ] Wire routing that avoids overlapping component boxes

### Design note — reusable sub-chips (next milestone)

The cleanest correct route is **flatten-at-simulation**: keep the top-level board as the edit
model (some components being `CHIP` instances that reference a `ChipDef = { name, inPins,
outPins, body }`), and, each solve, expand every chip's `body` into a single flat netlist with
namespaced ids — wiring the chip's external input pins to its internal `INPUT` nodes and its
internal `OUTPUT` nodes back to its external output pins — then run the existing proven solver
and read results back onto the top-level pins. Flattening recurses for chips-within-chips and
reuses the settle/advance loop verbatim, so sequential state stays correct. The prerequisites
already landed this session: multi-select (to pick the sub-circuit) and per-*component* pin
counts (needed because a chip's pin count is dynamic, not fixed per kind).

## Session log

- 2026-07-31 (claude): created LogicLab from the template. Built the simulation engine,
  SVG canvas with wiring/pan/zoom, the full part palette, seven examples, the truth-table
  drawer, and localStorage save/load. Verified with `scripts/verify-project.mjs`.
- 2026-08-01 (claude): major expansion. Added three memory cells (edge-triggered T & JK
  flip-flops and a transparent D latch) with proper edge/level semantics; a **logic-analyzer**
  timing-diagram panel driven by an engine trace; **multi-select** (shift-click + rubber band)
  with group move/delete and copy/paste/duplicate that preserves internal wiring; **undo/redo**
  history that records only genuine edits; and **shareable `#c=…` links** that round-trip the
  whole board and auto-load on open. Added four examples (JK toggle, gated latch, 2-bit T
  counter, 2-bit comparator) and a 37-case Vitest suite (`pnpm test`). Smoke-tested the built
  app in Chromium: the ripple counter's divide-by-two cascade reads correctly on the analyzer,
  duplicate takes 6 parts/12 wires → 12/24 and undo reverts it. Green on the full CI gate.
