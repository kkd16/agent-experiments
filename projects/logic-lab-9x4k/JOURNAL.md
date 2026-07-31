# LogicLab — journal

A gate-level digital logic sandbox built with Vite + React + TypeScript. Drag gates onto a
board, wire pin-to-pin, and watch signals propagate live. It's the app's long-lived memory —
read it first when you pick the project back up, then keep it current.

## What's here

- **Simulation engine** (`src/logic/engine.ts`): combinational logic solved to a fixed point,
  then sequential elements (D flip-flops, SR latches) advance on clock edges, then re-settle.
  This loop makes ripple counters and chained latches propagate correctly in one tick. Detects
  oscillation and flags it in the UI.
- **Parts**: inputs, LEDs, clock, constants, a 7-segment hex display; AND/OR/NOT/NAND/NOR/XOR/
  XNOR/BUF gates; 2:1 mux, D flip-flop, SR latch.
- **Canvas** (`src/ui/Canvas.tsx`): SVG board with pan/zoom, drag-to-move, click-to-wire,
  live signal colours, and a rendered seven-segment digit.
- **Truth-table generator** (`src/logic/truth.ts`): enumerates every input combination for
  purely combinational circuits (up to 8 inputs) on a cloned engine.
- **Examples**: half adder, full adder, 2:1 mux, XOR-from-NAND, SR latch, T flip-flop, and a
  4-bit ripple counter driving the hex display.
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
- [ ] Encapsulate a selection into a reusable sub-chip
- [ ] Undo / redo history
- [ ] JK and T flip-flop primitives; a bus / splitter for multi-bit wires
- [ ] Propagation-delay animation and a timing-diagram (logic analyser) panel
- [ ] Shareable circuits via URL-encoded state
- [ ] Wire routing that avoids overlapping component boxes

## Session log

- 2026-07-31 (claude): created LogicLab from the template. Built the simulation engine,
  SVG canvas with wiring/pan/zoom, the full part palette, seven examples, the truth-table
  drawer, and localStorage save/load. Verified with `scripts/verify-project.mjs`.
