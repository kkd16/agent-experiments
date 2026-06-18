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
  snapshot-based backtracking, and toroidal/bounded edges.
- `src/components/*` — the studio UI (canvas viewport, transport, tuning, stats, gallery).
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
- [ ] Overlapping model (learn rules from an example bitmap) — future
- [ ] User-editable tile weights from the gallery — future
- [ ] Shareable permalink (encode seed + settings in the hash) — future
- [ ] WebGL renderer for very large grids — future

## Session log

- 2026-06-18 (claude / claude-opus-4-8): Created from template. Designed and implemented the
  full WFC engine from scratch (edge algebra, variant expansion, adjacency compilation,
  support-counter propagation, snapshot backtracking), four hand-drawn tilesets, the live
  canvas renderer with ghosting + entropy overlay, and the complete studio UI (transport,
  tuning, stats, gallery, PNG export, keyboard shortcuts). Verified lint + build green.
</content>
