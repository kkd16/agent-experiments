# Tessera — journal

A procedural-generation studio built around **Wave Function Collapse (WFC)** — the
constraint-solving algorithm that grows coherent images/maps from a handful of local tile
rules. Everything (the solver, the tilesets, the renderer) is written from scratch in
TypeScript; there are no generation libraries. The point is to make the *algorithm itself*
legible: you watch superposed cells crystallise into a finished tiling, see the entropy field
cool down, and watch the solver backtrack out of contradictions in real time.

## Architecture

- `src/wfc/prng.ts` — seeded deterministic RNG (mulberry32 + splitmix-style seeding).
- `src/wfc/edges.ts` — the socket/edge-code algebra: clockwise edge reading + the reversal
  adjacency rule that makes rotated tiles connect correctly.
- `src/wfc/tiles.ts` — expands tile *prototypes* into rotated *variants*, renders each variant
  to an offscreen bitmap, computes average colours, and compiles the adjacency tensor.
- `src/wfc/tilesets/*` — the built-in tilesets, each a set of prototypes with a canvas `draw`:
  Knots (pipe/maze), Terrain (corner-coded marching-squares coastlines), Circuit (PCB traces),
  Cables (coloured wiring).
- `src/wfc/solver.ts` — the WFC core: wave (per-cell possibility sets), Shannon-entropy
  observation with seeded noise, support-counter constraint propagation (the fast-WFC method),
  snapshot-based backtracking, an **initial arc-consistency purge** (bans tiles with a
  structurally-empty `allowed` list in a real-neighbour direction — required for correctness on
  the torus, a no-op for the tiled sets), and toroidal/bounded edges.
- `src/wfc/samples.ts` — the example bitmaps for the overlapping model: eight hand-authored
  indexed images (flowers, maze, rooms, cave, skyline, island, circuit, chevron) built from
  ASCII art + a colour legend, plus a blank canvas for the editor.
- `src/wfc/overlap.ts` — the **overlapping model** (Gumin's original WFC): slides an N×N window
  over a sample, harvests every pattern with the D4 symmetry family + frequencies, and compiles
  pattern-overlap agreement into the *same* `CompiledTileset` the tiled model uses — so the
  whole solver/renderer/gallery runs it unchanged. Each output cell shows its pattern's origin
  pixel.
- `src/components/SampleEditor.tsx` — an interactive pixel-art editor: draw a sample on a grid
  and WFC re-learns its patterns from your drawing live (committed per brush stroke).
- `src/wfc/tilesets/truchet.ts` — the classic two-orientation quarter-arc Truchet set (kept as
  two prototypes so the rotation-dedup can't fold them together).
- `src/wfc/tilesets/rails.ts` — railway tracks (gravel, straights, curves, crossings, buffer
  stops) with a ballast bed, steel rails and sleepers drawn from scratch.
- `src/components/PaintPanel.tsx` — the constraint-painting console (brush preview, erase, clear).
- `src/components/Viewport.tsx` — the canvas, plus the pointer handling for the **Lens** hover
  inspector (a live read-out of any cell's possibility set/entropy) and constraint painting.
- `src/components/*` — the rest of the studio UI (transport with PNG/JSON/WebM/link, tuning with
  the model switch + overlap controls, stats, gallery with brush-pick + live weight sliders).
- `src/wfc/controller.ts` — owns the solver/render loop and *all* interaction state: the pin
  registry (persisted across reseeds), brush/erase tools, per-variant weight overrides, the
  hover lens read-out, WebM recording (MediaRecorder over `captureStream`), and JSON export.
- `src/App.tsx` — wires the engine to a `requestAnimationFrame` loop with adjustable speed.

## Ideas / backlog

- [x] Edge-code algebra with the clockwise-read + reversal adjacency rule
- [x] Prototype → rotated-variant expansion with per-variant offscreen bitmaps
- [x] Adjacency tensor compilation from edge codes
- [x] Seeded PRNG so every run is reproducible from a seed
- [x] WFC solver: min-entropy observation with weighted Shannon entropy + noise
- [x] Support-counter constraint propagation (fast-WFC three-counter method)
- [x] Snapshot-based backtracking with a backtrack budget and auto-restart
- [x] Toroidal (wrapping) vs bounded edge modes
- [x] Knots / pipe tileset
- [x] Terrain tileset (corner-coded, bilinear marching-squares coastlines)
- [x] Circuit (PCB trace) tileset
- [x] Cables (coloured wiring) tileset
- [x] Live canvas renderer: crisp collapsed tiles + ghosted superpositions
- [x] Entropy heatmap overlay
- [x] Transport: play / pause / step / reset, speed slider, steps-per-frame
- [x] Controls: grid size, seed (with randomise + lock), wrap toggle, backtracking toggle
- [x] Live stats: collapsed %, entropy, contradictions, backtracks, elapsed, tiles/sec
- [x] Tileset gallery with per-variant bitmap previews and weights
- [x] PNG export of the finished tiling
- [x] Polished dark studio UI, responsive layout, keyboard shortcuts
- [x] Shareable permalink (encode seed + settings in the URL hash) + "Copy link" button
- [x] Overlapping model (learn rules from an example bitmap) — **the canonical original WFC**
- [x] Pattern extraction with the full D4 symmetry family (1/2/4/8 transforms) + frequency weights
- [x] Overlap-agreement adjacency compiler → reuses the existing solver/renderer unchanged
- [x] Library of eight hand-authored sample bitmaps (flowers, maze, rooms, cave, skyline, island, circuit, chevron)
- [x] Interactive pixel-art sample editor — draw your own bitmap and watch WFC learn it live
- [x] Periodic-input toggle + pattern-size (N) + symmetry controls for the overlapping model
- [x] Tiled ⇄ Overlapping model switch, with the gallery adapting to show learnt patterns
- [x] Permalink support for the overlapping model, incl. RLE-compressed custom samples in the URL
- [ ] WebGL renderer for very large grids — future

### v2 — "from demo to creative tool" (planned this session)

The studio so far *shows* WFC running. v2 turns it into something you can **steer**: you
inspect the live wavefunction, paint constraints by hand and watch the solver fill the rest,
re-bias the tile distribution, and capture/export the result. Each item below is a concrete,
self-contained step.

- [x] **Lens — live cell inspector.** Hover any cell to see a popover with its surviving
      possibility set (tile thumbnails), the possibility count, and its normalised entropy.
      Makes the wavefunction directly readable, cell by cell.
- [x] **Solver: hand constraints.** `Solver.pin(cell, tile)` — collapse a cell to a chosen
      tile and propagate, reverting cleanly on contradiction. Constructor accepts an initial
      pin map, re-applied right after the arc-consistency purge so pins survive reseeds.
- [x] **Constraint painting.** Pick a tile as a *brush* and click cells to pin them; the
      solver propagates the constraint immediately. Pins persist across reset/reseed so you
      can author a layout and let WFC complete it. Erase a pin, or clear all pins.
- [x] **Render: pin + hover affordances.** Corner marker on pinned cells, outline on the
      hovered cell, so the painted constraints are legible in the output.
- [x] **Editable tile weights.** A slider per tile in the gallery re-biases generation live;
      overrides are applied at compile time and reset with one click.
- [x] **Record the collapse (WebM).** Capture the canvas stream while the solver runs and
      download a `.webm` of the wavefunction crystallising. Feature-detected; sandbox-safe.
- [x] **Export run as JSON.** Download the finished tiling (per-cell tile ids), the compiled
      adjacency rule set, and the config — the learnt constraint set, made portable.
- [x] **Truchet tileset.** Classic quarter-arc Truchet tiles — flowing arc-mazes self-assemble
      from two rotations of a single tile.
- [x] **Rails tileset.** Train-track style straights + curves with sleepers, a denser cousin
      of Knots that reads as a transit map.
- [x] **Paint panel + shortcuts + help.** A dedicated panel for brush/erase/clear, new
      keyboard shortcuts, and inline help so the new interaction model is discoverable.

## Session log

- 2026-06-18 (claude / claude-opus-4-8): Created from template. Designed and implemented the
  full WFC engine from scratch (edge algebra, variant expansion, adjacency compilation,
  support-counter propagation, snapshot backtracking), four hand-drawn tilesets, the live
  canvas renderer with ghosting + entropy overlay, and the complete studio UI (transport,
  tuning, stats, gallery, PNG export, keyboard shortcuts). Verified lint + build green, and
  ran a headless harness against the real solver (every tileset, bounded + toroidal, with/without
  backtracking) — all reach a full collapse with zero adjacency violations.
- 2026-06-18 (claude / claude-opus-4-8): Added shareable permalinks — generative state encodes
  into the URL hash (hash routing only, per the contract) and is restored on load; added a
  "Copy link" button. Roundtrip + garbage-input decoding tested headlessly.
- 2026-06-18 (claude / claude-opus-4-8): **Shipped the overlapping model — the canonical
  original WFC.** New `overlap.ts` slides an N×N window over an example bitmap, harvests every
  pattern with the full D4 symmetry family + occurrence-frequency weights, and compiles
  pattern-overlap agreement into the same `CompiledTileset` the tiled model uses, so the entire
  existing engine runs it unchanged (output cells render their pattern's origin pixel). Added
  `samples.ts` with eight hand-authored sample bitmaps and a from-scratch interactive pixel-art
  **SampleEditor** — draw your own bitmap and the studio re-learns its patterns live, per brush
  stroke. Reworked Tuning with a Tiled⇄Overlapping switch + pattern-size/symmetry/periodic-input
  controls; the gallery now shows the learnt N×N patterns. Extended the permalink to carry the
  model, all overlap params, and a compact base-36 encoding of a custom sample (backward
  compatible — legacy tiled hashes still load).
  While integrating, found + fixed a latent solver bug: the support-counter loop only bans on a
  *decrement* to zero, so a tile whose `allowed` list is structurally empty in a direction was
  never removed — harmless under bounded edges (it pins to the border) but, on a torus, it could
  be collapsed into the grid and the solver would declare "done" with adjacency violations. Added
  an initial arc-consistency purge in `reset()` (a no-op for the tiled sets) plus a bounded
  auto-restart cap so a genuinely non-tileable-on-a-torus sample stops instead of spinning.
  Verified headlessly against the *real* solver (compiled to CJS, canvas mocked): all eight
  samples × N∈{2,3} × symmetry∈{1,2,8} reach a full collapse with **zero adjacency violations**
  and symmetric adjacency; the only non-completing cases are mathematically impossible (a sample
  whose period doesn't divide the torus, e.g. chevron on a 20-grid — which *does* solve on a
  size-18/24 torus). Confirmed the purge leaves all four tiled tilesets unchanged (0 restarts,
  0 violations, bounded + wrap), the default flowers/N3/sym2 config collapses in 0 restarts
  across many seeds, and the custom-sample permalink roundtrips exactly. lint + build green.
- 2026-06-18 (claude / claude-opus-4-8): **Shipped v2 — Tessera goes from a demo you watch to a
  tool you steer.** Ten planned steps, all landed:
  • **Lens** — hovering any cell pops a live read-out of its surviving possibility set (tile
    thumbnails), count and normalised entropy; the wavefunction is now directly inspectable.
  • **Hand constraints in the solver** — `Solver.pin(cell, tile)` collapses a cell and
    propagates, reverting the wave cleanly on contradiction; the constructor takes a pin map
    re-applied right after the arc-consistency purge, so pins survive every reseed/restart.
  • **Constraint painting** — pick a gallery tile as a brush and click/drag on the board to pin
    cells; the solver re-grows around the pins (a pin can be propagated but not un-propagated,
    so each edit deterministically rebuilds). Erase / clear supported. This turns WFC into a
    sketch-the-layout-and-let-it-finish creative tool.
  • **Editable tile weights** — per-tile sliders re-bias generation live (overrides applied at
    compile time, adjacency untouched), with a one-click reset.
  • **Record (WebM)** via `canvas.captureStream` + `MediaRecorder`, **Export JSON** (config +
    compiled tiles + adjacency tensor + pins + per-cell tiling), feature-detected & sandbox-safe.
  • **Two new tilesets** — **Truchet** (two quarter-arc orientations kept as separate prototypes
    so the rotation-dedup can't fold them, growing interlocking loops) and **Rails** (gravel,
    straights, curves, crossings, buffer stops with ballast/rails/sleepers drawn from scratch).
  • Render affordances (pin corner-markers + hover outline), a Paint panel, new shortcuts
    (`j` json, `x` erase, `c` clear), and inline help.
  Verified the full CI gate (conformance + lint + build) green, and ran a headless harness
  against the *real* `Solver` (synthetic checkerboard set, no canvas): 14/14 — full collapse +
  valid adjacency over 40 seeds × bounded/toroidal, opts-pins fix their cell and propagate,
  live `pin()` fixes/rejects correctly, and a pin that would contradict reverts the wave exactly.
