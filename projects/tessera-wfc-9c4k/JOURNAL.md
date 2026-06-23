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
- `src/App.tsx` — wires the engine to a `requestAnimationFrame` loop with adjustable speed, and
  hosts the top-level **2D ⇄ 3D** mode switch.

### The infinite engine (`src/infinite/*`, `src/components/InfiniteStudio.tsx` + `InfiniteViewport.tsx`)

A third, self-contained engine that runs WFC on an **endless plane** you pan around — the 2D/3D
code is untouched. It carves the plane into a CW-complex so every cell is a pure function of
`(seed, x, y)`:

- `infinite/coords.ts` — the coordinate + sub-seed algebra. A global cell is classified, by its
  offset inside a chunk of size `G`, into a **junction** (lattice corner), a **vertical/horizontal
  seam** cell (on a `G`-line between junctions), or a **chunk interior** cell — a partition with no
  overlaps. `subSeed` weaves the master seed with a tag + coordinates so each unit gets its own
  deterministic stream.
- `infinite/world.ts` — `InfiniteWorld`, the generator. Junctions take the set's **ground** tile
  (one adjacency-compatible with itself in all four directions, so the solves below are always
  satisfiable); **seams** are real 1-D WFC strips pinned to their two junction endpoints; **chunks**
  are `(G+1)²` solves whose entire border ring is pinned to the surrounding junctions + seams, then
  the interior is kept. Because borders are *shared* between abutting chunks and only a
  fully-collapsed, pin-honouring solve is accepted, every cross-chunk adjacency is valid by
  construction. All three reuse the existing `Solver`/`compile` unchanged; everything is memoised
  (LRU on chunks) and order-independent.
- `infinite/sets.ts` — the curated roster (`terrain, knots, circuit, truchet, rails, maze`): sets
  with a ground tile *and* an empirically-zero chunk-fallback rate. (`cables` has a ground tile but
  its capless wires strand on random borders, so it is intentionally omitted.)
- `infinite/controller_inf.ts` — `ControllerInf`: owns the world + a floating-point camera (centre
  in cell units + zoom), paints the visible slice lazily, handles pan/zoom/auto-pan, the minimap,
  origin crosshair, and PNG export.
- `infinite/permalink_inf.ts` — the `m=i` shareable hash (set / seed / chunk size / zoom / camera).
- `infinite/tests_inf.ts` — the in-app **Infinite Proof Lab** (15 checks on the real generator).

### The 3D engine (`src/wfc3d/*`, `src/components/Studio3D.tsx` + `Viewport3D.tsx`)

A self-contained second engine running WFC on a voxel lattice — the 2D code is untouched.

- `wfc3d/dirs3.ts` — the 6-direction lattice algebra (±X/±Y/±Z), opposites, and the Y-axis
  90° rotation permutation.
- `wfc3d/sockets3.ts` — the cube-group socket scheme: symmetric/flipped **horizontal** seams +
  rotation-indexed **vertical** seams, with a reverse-consistent `connects()` rule.
- `wfc3d/voxel.ts` — the R³ packed-colour voxel model, a fluent builder, and `rotateY`.
- `wfc3d/types3.ts` / `compile3.ts` — prototype/variant/compiled types and the compiler that
  expands Y-rotations (deduped) and builds the 6-direction adjacency tensor.
- `wfc3d/solver3.ts` — the WFC core on six neighbours (support-counter propagation, min-entropy
  observation, arc-consistency purge, snapshot backtracking).
- `wfc3d/tilesets3/*` — the hand-authored volumetric sets: Terraces, Castle, Pipes3D.
- `wfc3d/camera.ts` / `field.ts` / `raster.ts` — the from-scratch software renderer: an
  orthographic orbit camera, the merged voxel field, and the surface-extracting, back-face-culling,
  painter's-ordered, Lambert-shaded rasteriser. `thumb3.ts` reuses it for gallery thumbnails.
- `wfc3d/controller3.ts` — owns the 3D solver/render loop, camera, weight overrides, PNG export.
- `wfc3d/tests3.ts` — the in-app **3D Proof Lab** (socket/rotation/adjacency/solver guarantees).
- `wfc3d/permalink3.ts` — the `m=3` shareable hash for the 3D studio (now also owns the shared
  `Mode` union and `hashMode`, including `m=h` for the hex engine).

### The hex engine (`src/hex/*`, `src/components/HexStudio.tsx` + `HexViewport.tsx`)

A fourth, self-contained engine running WFC on a **hexagonal lattice** — the square/voxel/infinite
code is untouched. Hexes are the third regular tiling of the plane and the one the studio had never
visited; this is the square engine's edge-code algebra carried onto six neighbours with a 60°
rotation group.

- `hex/hexgrid.ts` — the lattice algebra: **axial** coordinates (uniform integer steps, no row
  parity), six clockwise directions (`E SE SW W NW NE`) with `opposite(d) = (d+3) mod 6`, the
  clockwise edge-code scheme with `fits(a,b,d) = a[d] === reverse(b[opposite(d)])`, a 60°-CW edge
  rotation that is a pure cyclic shift, and pointy-top hex geometry (centres, corners, edge
  midpoints, the hex path).
- `hex/types_hex.ts` / `compile_hex.ts` — prototype/variant/compiled types and the compiler:
  expand each prototype into its distinct 60° rotations, render each into a transparent-cornered
  hex bitmap (clipped to the hexagon, so a tile never bleeds into a neighbour), dedup by edges +
  a pixel hash so visually-identical rotations fold together, and build the 6-direction adjacency
  tensor from the edge rule.
- `hex/hexsolver.ts` — the WFC core on six hex neighbours: support-counter propagation (six
  counters/tile), weighted min-Shannon-entropy observation with seeded noise, the arc-consistency
  purge, and snapshot backtracking — the same guarantees as the square core, one more fold of
  symmetry. Bounded vs toroidal (axial wrap).
- `hex/tilesets/*` — hand-authored hex sets: **Terrain** (grass/water with curved coastlines),
  **Paths** (a road network of bends/chicanes/T-junctions/roundabouts), **Weave** (a hexagonal
  Truchet — every edge a connector, three matchings interlacing into knotwork), and **Pipes**
  (two colours of conduit that only meet their own kind). `tilesets/draw.ts` holds the shared
  ribbon/spoke/coastline drawing helpers built against the same hex geometry the compiler uses.
- `hex/hexraster.ts` — the from-scratch pointy-top renderer: fit the rhombus board into the
  backing store, blit each collapsed cell's hex bitmap, ghost or entropy-tint the superposed ones,
  optional hairline lattice. `cellCenter`/`layoutHex` are shared with the controller's hit-test.
- `hex/controller_hex.ts` — owns the solver/render loop, view toggles, weight overrides, PNG
  export, and a pixel→cell hit-test (cube-coordinate rounding) powering the hover lens.
- `hex/tests_hex.ts` — the in-app **Hex Proof Lab** (lattice algebra, adjacency tensor, solver
  guarantees incl. toroidal-seam validity).
- `hex/permalink_hex.ts` — the `m=h` shareable hash for the hex studio.

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

### v4 — "the third dimension" (planned + shipped this session)

The whole studio so far lives on a 2D grid. v4 grows Tessera a **second, parallel engine that
runs Wave Function Collapse in true 3D** — a 6-neighbour voxel lattice with a proper cube-group
socket algebra, hand-authored volumetric tilesets, and a **from-scratch software voxel renderer**
(no Three.js, no WebGL — orthographic orbit camera, painter's-ordered cube rasteriser with face
culling + Lambert shading) so the from-scratch ethos holds in 3D too. A top-level **2D ⇄ 3D**
switch picks the engine; the 3D side is self-contained so the 2D studio is untouched. Each item
below is a concrete, self-contained step.

- [x] 6-direction lattice algebra (±X, ±Y, ±Z) with `opposite` + Y-axis 90° rotation maps
- [x] Marian42-style socket scheme: symmetric/flipped **horizontal** faces + rotation-indexed **vertical** faces, with a provably reverse-consistent `connects()` rule
- [x] Voxel model type + colour helpers + a 90°-CW `rotateY` that rotates geometry *and* sockets coherently
- [x] Prototype→variant compiler: expand each tile into its distinct Y-rotations (dedup), build the 6-direction adjacency tensor, weights, per-variant average colour
- [x] 3D WFC solver: 6-neighbour support-counter propagation, min-entropy observation, snapshot backtracking, bounded vs wrapped lattice (mirrors the 2D core's guarantees in 3D)
- [x] Hand-authored **Castle** tileset — floors, walls, corners, crenellations, towers, pillars, arches, air (grows little keeps)
- [x] Hand-authored **Pipes3D** tileset — a 3D conduit network (straights, elbows, tees, caps) that connects across all six faces
- [x] Hand-authored **Terraces** tileset — stepped ground/grass/rock/water blocks (landscape-like)
- [x] Orthographic **orbit camera** (yaw + pitch + zoom) with mouse-drag + wheel control
- [x] From-scratch **software voxel rasteriser**: merge collapsed cells into a voxel field, extract only surface faces (interior culling), depth-sort + paint with Lambert shading and a soft sky/ground tint
- [x] Incremental voxel field that accumulates collapsed cells as the solve runs (live build-up)
- [x] Per-variant **isometric sprite** thumbnails (the rasteriser run on one model) for the 3D gallery
- [x] `Controller3D` — owns the solver loop, camera, dirty-render scheduling, stats, PNG export
- [x] `Studio3D` UI — viewport with drag-orbit, transport, tuning (set / grid X·Y·Z / seed / wrap / backtracking), telemetry, gallery
- [x] Top-level **2D ⇄ 3D** mode switch wired into the existing header + permalink
- [x] **3D Proof Lab** — socket reverse-consistency, rotation-group closure, adjacency symmetry, and the headline: a *finished* 3D solve is always 6-neighbour adjacency-valid (cross-checked the long way), all on the real solver, deterministic from a seed

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

### v3 — "Constraint Lab: global connectivity + a proof suite" (planned this session)

WFC's edge-socket algebra already routes *local* adjacency, but it has no notion of *global*
shape: a rail set will happily strand a loop of track with no way off the board. v3 teaches
Tessera a genuine **global connectivity constraint** — the hard, research-grade extension of
WFC (Karth & Smith; Boris-the-Brave's path constraints) — implemented soundly on top of the
existing fast support-counter solver and its backtracking, and proven correct by an in-app
verification suite that runs the *real* solver. Strictly additive: with connectivity Off the
machine is byte-for-byte the v2 solver it always was.

- [x] **Open-socket metadata.** Connection tilesets declare an `emptyEdge` socket; the compiler
      derives a per-variant 4-bit `openMask` (which edges carry a connection). Added to circuit,
      cables, knots and rails (all `'000'`-empty), with reverse-symmetry (`open(c) ⇔ open(rev c)`)
      asserted in the suite so a collapsed open edge always faces an open edge.
- [x] **`connectivity.ts` — canvas-free graph analysis.** Pure functions over a "connectivity
      view" of the wave: the optimistic *could-still-link* graph, connected components, multi-
      terminal reachability, and an exact **s–t cut-vertex** finder (Tarjan articulation points
      + per-candidate removal test) identifying cells that lie on *every* route between required
      terminals. Fully unit-testable independent of the DOM.
- [x] **Solver: connectivity constraint (sound + complete-given-budget).** An optional
      constraint with two modes — *Whole network* (all connector cells form one component) and
      *Route between pins* (all connector pins mutually connected). Three layers: (1) **optimistic
      feasibility pruning** after each observation — if required connectors are already split in
      the most-permissive graph, it's a genuine contradiction → drives the existing backtracking;
      (2) **forced-connector inference** — a cut-vertex that separates two terminals *must* be a
      connector, so blank tiles there are banned and propagated (sound deduction that steers the
      search to a connected solution); (3) a **final validation** on would-be-`done` so the solver
      can *never* report success with the property violated — it backtracks instead.
- [x] **Render + UI.** A connectivity-mode selector (Off / Whole network / Route between pins),
      gated when the active set has no sockets; a network overlay that tints the connected
      component(s) and flags stranded connectors; a live components/route read-out in stats.
- [x] **Maze tileset.** A walls-and-corridors set built for routing, where "Route between pins"
      yields a *guaranteed-solvable* maze between two painted endpoints.
- [x] **Proof Lab — in-app verification suite (`tests.ts` + panel).** The house-style move:
      a Self-tests tab that runs the real `Solver` headlessly-capable and reports pass/fail —
      determinism (same seed ⇒ identical tiling), adjacency validity of every output, the
      socket reverse-symmetry law, **feasibility soundness** (the optimistic check never prunes a
      state that brute force can complete, over thousands of tiny random instances), **forcing
      soundness** (every forced cell is a connector in *all* completions, by exhaustive search),
      and the end-to-end guarantee that a finished connectivity run always satisfies its property.
- [x] **Permalink + docs.** Carry the connectivity mode in the URL hash (back-compatible) and
      refresh the in-app help/Reference.

### v5 — "The Solver Lab: make the *search* legible and steerable" (shipped 2026-06-19)

Tessera has always shown you *what* WFC builds; v5 shows you *how it searches*. WFC's solver makes
two hidden choices every step — which cell to observe, and which tile to collapse it to — and those
choices, not the rules, decide how much it thrashes. v5 pulls both out into swappable policies you
can drive from the UI and, crucially, *measure*: a benchmark that races them on the same instance,
a heatmap of where the search struggles, and live search instrumentation. Strictly additive — the
default Entropy + Weighted path is **byte-for-byte identical** to the old engine (verified across
7 tilesets × 10 seeds × bounded/toroidal: 140/140 tilings identical).

- [x] **`heuristics.ts` — pluggable search policy as pure functions.** Cell-selection heuristics
      (`entropy`, `mrv` = minimum-remaining-values, `scanline`, `random`) and tile-selection
      policies (`weighted`, `uniform`, `greedy`), each a tiny pure function so they're swappable
      *and* unit-testable with no solver or canvas. Reservoir sampling for `random`, seeded jitter
      for `mrv` ties (can only reorder genuine ties, never overtake a strictly smaller count).
- [x] **Solver: heuristic/policy dispatch + search instrumentation.** `chooseCell`/`chooseTile`
      dispatch on the new `SolverOptions.heuristic` / `tilePolicy` (defaulting to entropy/weighted,
      so old seeds reproduce exactly). Added always-on instrumentation: `eliminations` (tile
      possibilities removed by propagation = raw solver work), `peakDepth` (height of the search
      tree explored), `localContradictions`, and a per-cell `contraHeat` tally — with the invariant
      `Σ contraHeat === localContradictions` that the Proof Lab pins down.
- [x] **`bench.ts` — the benchmark harness (pure, deterministic).** `runOne` runs one solve to a
      terminal state, reseeding on failure exactly like the live controller and summing
      instrumentation across restarts; `runBench` races each strategy over the *same* derived seeds
      so it's an apples-to-apples fight; `aggregate` computes success rate + per-metric means over
      the correct subsets (means over *solved* runs, timing over *all*). `benchToCsv` for export.
- [x] **Contradiction heatmap overlay.** A view toggle (`K`) that tints every cell red by how often
      it was the one the solver emptied — a literal picture of where the search struggled (tight
      corridors, over-constrained corners). Drawn over the finished tiling with a √-ramp so rare
      hot spots still read.
- [x] **Solver Lab panel.** Races the four observation heuristics on the *current* set + grid over
      a chosen seed count (6/12/24), tabulating success %, mean steps, mean backtracks (as a
      self-scaling bar) and mean peak depth, flagging the fewest-backtracks winner and the live
      heuristic, with a Copy-CSV button. The empirical companion to the Proof Lab.
- [x] **Tuning + Stats + permalink + shortcuts.** A "Search" section (observe-which-cell /
      collapse-which-tile selectors + a heuristic blurb), the contradiction-heatmap toggle, two new
      telemetry rows (eliminations, peak depth), the `K` shortcut, and a back-compatible permalink
      (`he`/`tp`/`ch`) — legacy hashes still decode to entropy/weighted.
- [x] **Proof Lab — Search Lab group.** Five new checks on the *real* engine: heuristic mechanics
      (scanline=first, MRV=min-count, random∈uncollapsed, all −1 when settled), tile-policy
      mechanics, every heuristic×policy yields valid + deterministic output (12/12 combos on
      terrain), the `Σ heatmap = local contradictions` instrumentation law, and the benchmark
      aggregation arithmetic.
- [ ] **Future** — per-strategy comparison across tile policies (not just heuristics) in the
      benchmark; a side-by-side "two solvers racing" split view; bring the heuristics to the 3D
      engine.

### v6 — "Boundless: an infinite Wave Function Collapse world" (shipped 2026-06-21)

Every Tessera engine so far solves **one finite grid**. v6 grows a third, parallel engine that runs
WFC on an **endless, smoothly-pannable plane** — generated lazily as you scroll, fully deterministic
from a seed, and **provably seam-consistent** so the infinite tiling is globally adjacency-valid.
The trick is a CW-complex decomposition: the plane is partitioned into lattice **junctions**, 1-D
**seams**, and **chunk** interiors, each materialised on demand by the *real* solver and **shared**
between neighbours — so any cell is a pure function of `(seed, x, y)`, independent of the order the
viewport visits it. Strictly additive: a top-level **∞** switch picks the engine; the 2D/3D studios
are byte-for-byte untouched. Each item below is a concrete, self-contained step.

- [x] **Coordinate algebra (`coords.ts`).** Floor-division / non-negative `mod` correct for negative
      coordinates; `classify(gx,gy,G)` partitions the plane into junction / vseam / hseam / interior
      with the `(chunk index, offset)` decomposition that round-trips for any sign; `subSeed` mixes
      the master seed with a tag + coords for per-unit determinism.
- [x] **Ground-tile detection + junctions.** `findGround` returns a variant adjacency-compatible
      with itself in all four directions (the highest-weight one, deterministically) — the anchor
      that keeps every seam/chunk solve satisfiable. Junctions take it at every lattice corner.
- [x] **Seams as 1-D solves.** Each vertical/horizontal seam is a `1×(G+1)` (or `(G+1)×1`) run solved
      by the existing `Solver`, pinned to its two junction endpoints, so it is a valid 1-D adjacency
      chain — and, being shared by the two chunks it divides, both see identical border tiles.
- [x] **Chunks as bordered 2-D solves.** A chunk is a `(G+1)²` solve whose entire border ring is
      pinned to the surrounding junctions + seams; the interior is kept. Only a fully-collapsed,
      pin-honouring result is accepted (verified cell-by-cell), with deterministic re-seed attempts;
      an all-ground fallback exists but, for the offered sets, never fires.
- [x] **`InfiniteWorld` (`world.ts`).** `tileAt(gx,gy)` — the one pure-function entry point — plus
      memoised caches (LRU on chunks), live diagnostics (seam/chunk solves, fallbacks), and a
      minimap helper. Order-independent and reproducible across instances/devices.
- [x] **Curated roster (`sets.ts`).** The six sets proven to grow an everywhere-valid infinite plane
      (ground tile + empirically-zero fallback). `cables` is documented and excluded.
- [x] **`ControllerInf` + viewport.** A floating-point camera (centre in cells + pixels-per-cell
      zoom) painting the visible slice lazily; drag-to-pan, pointer-anchored wheel zoom, **auto-pan**
      drift, an optional chunk lattice + junction markers, an origin crosshair, a corner **minimap**
      of materialised chunks, hover coordinate read-out, and PNG export.
- [x] **`InfiniteStudio` UI + ∞ mode switch + permalink.** A third top-level studio (transport,
      tuning with the curated picker + chunk-size/zoom/seed/grid/junction controls, telemetry,
      tile gallery, proof lab), wired into the header/footer, with a back-compatible `m=i` hash that
      pins set + seed + chunk size + zoom + camera centre — so a link is an exact spot in an endless
      world.
- [x] **Infinite Proof Lab (`tests_inf.ts` + panel).** 15 checks on the *real* generator: the
      coordinate partition + round-trip + negative-coordinate arithmetic; ground exists for every
      offered set; seams are valid 1-D chains honouring their junctions; chunk interiors fully
      collapse, borders equal their shared seams, chunks are deterministic, and **fallback never
      fires**; and the headline — **every adjacency on a block of the plane is valid** (re-checked
      the long way from raw socket codes), the world is **order-independent**, and **seed-sensitive**.
- [ ] **Future** — a Web Worker pool so far jumps materialise off the main thread; a "wander" tour
      that auto-navigates toward unexplored chunks; bring connectivity/painting to the infinite plane;
      an overlapping-model infinite world (learn an endless texture from one bitmap).

### v7 — "The hexagon: WFC on a third tiling of the plane" (shipped 2026-06-23)

Every Tessera engine so far has solved a **square** lattice — the 2D studio, the overlapping model,
the infinite plane, even the voxel grid are all four- or six-neighbour *cubic* worlds. v7 grows a
fourth, parallel engine on the **hexagon**, the third (and arguably prettiest) regular tiling of the
plane: six neighbours, a 60° rotation group, and edges that meet three-at-a-corner instead of four.
The square engine's whole edge-code algebra carries over almost verbatim — that is the point: one
idea, one more fold of symmetry. Strictly additive — a top-level **⬡** switch picks the engine; the
2D/3D/∞ studios are byte-for-byte untouched. Each item below is a concrete, self-contained step.

- [x] **Hex lattice algebra (`hex/hexgrid.ts`).** Axial coordinates with uniform integer neighbour
      steps (no odd/even-row parity); six clockwise directions with `opposite(d) = (d+3) mod 6`; the
      clockwise edge-code rule `fits(a,b,d) = a[d] === reverse(b[opposite(d)])` (identical in spirit
      to the square engine); a 60°-CW rotation that is a *pure cyclic shift* of the edge array; and
      pointy-top hex geometry (centres, corners, edge midpoints, the hexagon path).
- [x] **Compiler (`compile_hex.ts`).** Expand each prototype into its distinct 60° rotations, render
      each into a **transparent-cornered hex bitmap** (clipped to the hexagon so a tile can never
      bleed into its neighbour's cell), dedup by edge codes **and** a pixel hash (so visually-identical
      rotations fold together while genuinely distinct ones survive), and build the 6-direction
      adjacency tensor from the edge rule. Per-variant weight overrides for the live sliders.
- [x] **Hex solver (`hexsolver.ts`).** The square WFC core lifted to six hex neighbours:
      support-counter propagation (six counters/tile), weighted minimum-Shannon-entropy observation
      with seeded tie-break noise, the initial arc-consistency purge, snapshot backtracking within a
      budget — the same guarantees, deterministic from a seed; bounded vs toroidal (axial wrap).
- [x] **Four hand-authored hex tilesets.** **Terrain** (grass meets water with rounded, curved
      coastlines — continents, lakes, bays and headlands), **Paths** (a road network of bends,
      chicanes, T-junctions and roundabouts wiring themselves into a continuous web), **Weave** (a
      hexagonal Truchet — every edge a connector so any tile meets any tile; three matchings of the
      six exits interlace into endless knotwork), and **Pipes** (two colours of conduit that only
      meet their own kind, so each runs unbroken across the board). `tilesets/draw.ts` holds the
      shared Bézier-ribbon / spoke / coastline helpers, built against the compiler's hex geometry.
- [x] **From-scratch hex renderer (`hexraster.ts`).** Fit the `cols × rows` rhombus into the backing
      store, blit each collapsed cell's hex bitmap, ghost (averaged colour) or entropy-heat-tint the
      still-superposed cells, optional hairline lattice — no GPU, no library, just `drawImage` and a
      hex path. Layout + `cellCenter` are shared with the controller's hit-test.
- [x] **`ControllerHex` + `HexStudio`/`HexViewport`.** The hex analogue of the 2D/3D controllers: a
      requestAnimationFrame solve/draw loop with auto-restart, transport (play/step/reset/seed/PNG/
      link), tuning (set picker, cols/rows, seed lock, wrap, backtracking, ghost/entropy/grid view
      toggles), a tile gallery with live weight sliders, and a **hover lens** — point at any cell to
      read its surviving possibility count straight out of the live wavefunction (pixel→cell via
      cube-coordinate rounding).
- [x] **Top-level ⬡ mode switch + permalink.** A fourth engine wired into the header/footer; a
      back-compatible `m=h` hash that pins set / cols / rows / seed / wrap / backtracking / speed /
      view toggles — so a link is an exact hex board. The shared `Mode` union learns `'hex'`.
- [x] **Hex Proof Lab (`tests_hex.ts` + panel).** 14 checks on the *real* compiler + solver:
      the lattice algebra (opposite involution, opposite = negated step, rotate⁶ = identity,
      rotate¹ = shift, seam-symmetric fit), an adjacency tensor that is symmetric and exactly matches
      the edge rule for all four sets, and the headline — every *finished* hex solve is 6-neighbour
      adjacency-valid (re-checked the long way from raw edge codes), toroidal-seam-valid, and
      deterministic from a seed.
- [ ] **Future** — pin/constraint painting and the global-connectivity constraint on the hex board;
      pluggable search heuristics (MRV/scanline) like the square Solver Lab; an overlapping (learn
      from a hex sample) model; bring the hex renderer to the infinite engine.

## Session log

- 2026-06-23 (claude / claude-opus-4-8): **Shipped v7 — the hexagon.** Tessera grows a fourth,
  parallel engine that runs Wave Function Collapse on a **hexagonal (axial) lattice**, behind a
  top-level **⬡** switch; the 2D/3D/∞ studios are byte-for-byte untouched. Nine planned steps, all
  landed:
  • **Hex lattice algebra** (`hex/hexgrid.ts`) — axial coordinates, six clockwise directions with
    `opposite(d) = (d+3) mod 6`, the clockwise edge-code rule `a[d] === reverse(b[opp(d)])` carried
    straight over from the square engine, and a 60°-CW rotation that is a pure cyclic shift; plus
    pointy-top hex geometry.
  • **Compiler + solver** — `compile_hex.ts` renders each variant into a transparent-cornered hex
    bitmap (clipped to the hexagon) and builds the 6-direction adjacency tensor; `hexsolver.ts` is
    the square WFC core on six neighbours (support-counter propagation, min-entropy observation,
    arc-consistency purge, snapshot backtracking), deterministic and bounded/toroidal.
  • **Four hand-authored sets** — Terrain (curved coastlines), Paths (a road web), Weave (a hex
    Truchet that interlaces into knotwork), Pipes (two colours of conduit) — plus a from-scratch
    pointy-top renderer (`hexraster.ts`), a `ControllerHex`/`HexStudio`/`HexViewport` with a live
    **hover lens**, view toggles, weight sliders, PNG/link export, and an `m=h` permalink.
  • **Hex Proof Lab** (`hex/tests_hex.ts`) — 14 checks on the *real* compiler + solver, incl. the
    headline that every finished hex solve is 6-neighbour adjacency-valid (re-checked the long way),
    toroidal-seam-valid, and deterministic.
  Verified the full CI gate (scope + conformance + lint + build) green. Beyond CI, ran the Hex Proof
  Lab headlessly against the *real* compiled solver (Node `--experimental-strip-types` + a `.ts`
  resolve hook, canvas mocked for the compiler): **14/14 pass in ~0.2 s** — all four sets solve 8/8
  tiny boards with **0 adjacency violations**, the toroidal seam is valid, and seeds are
  bit-identical. A larger solvability sweep on the same real solver confirmed it completes reliably:
  every set solved **12/12** bounded 22×18 boards (0 restarts) and **8/8** toroidal 12×12 boards.
  (The headless run uses an un-deduped variant superset, so the real, deduped browser sets are
  strictly smaller and easier.) Open items rolled into the v7 backlog.

- 2026-06-21 (claude / claude-opus-4-8): **Shipped v6 — Boundless, an infinite WFC world.** Tessera
  grows a third, parallel engine that runs Wave Function Collapse on an **endless, pannable plane**,
  behind a top-level **∞** switch; the 2D/3D studios are byte-for-byte untouched. Ten planned steps,
  all landed, all reusing the existing solver/compiler unchanged:
  • **CW-complex decomposition** (`infinite/coords.ts`, `world.ts`) — the plane is partitioned into
    lattice **junctions** (the set's self-compatible *ground* tile), 1-D **seams** (real `Solver`
    strips pinned to their junction endpoints), and **chunk** interiors (`(G+1)²` solves whose whole
    border ring is pinned to the shared junctions + seams). Borders are *shared* between abutting
    chunks and only fully-collapsed, pin-honouring solves are accepted, so every cross-chunk
    adjacency is valid **by construction** — and every cell is a pure function of `(seed, x, y)`,
    so the world is deterministic and **order-independent** (any visit order / instance / device →
    identical), with lazy LRU-cached generation.
  • **Curated roster** (`infinite/sets.ts`) — the six sets proven to grow an everywhere-valid plane
    (ground tile + empirically-zero fallback): terrain, knots, circuit, truchet, rails, maze.
    `cables` has a ground tile but its capless wires strand on a random border, so it is excluded.
  • **`ControllerInf` + `InfiniteStudio`/`InfiniteViewport`** — a floating-point camera (centre in
    cells + pixels-per-cell zoom) painting the visible slice lazily; drag-to-pan, pointer-anchored
    wheel zoom, **auto-pan** drift, a chunk lattice + junction markers, an origin crosshair, a
    corner **minimap** of materialised chunks, a hover coordinate read-out, PNG export, and a
    back-compatible `m=i` permalink that pins set + seed + chunk size + zoom + camera centre.
  • **Infinite Proof Lab** (`infinite/tests_inf.ts`) — 15 checks on the *real* generator, incl. the
    headline that **every adjacency on a block of the plane is valid** (re-checked the long way from
    raw socket codes), order-independence, determinism, and that the fallback path never fires.
  Verified the full CI gate (scope + conformance + lint + build) green. Beyond CI, ran the engine
  headlessly against the *real* compiled solver (Node `--experimental-strip-types` + a `.ts` resolve
  hook, canvas mocked for the compiler): the **15/15 Proof Lab passes in ~0.7 s** (10,800 adjacency
  pairs validated the long way), and a larger sweep — **6 sets × 5 seeds × ~245 chunks each (≈1,470
  chunks/set), spanning negative coordinates** — reports **0 adjacency violations, 0 fallbacks, and
  0 order-mismatches**, with a fresh instance reproducing every cell. The single failing candidate,
  `cables`, was identified empirically (8/9 chunks fall back) and excluded from the roster. Open
  items rolled into the v6 backlog above.
- 2026-06-19 (claude / claude-opus-4-8): **Shipped v5 — the Solver Lab.** Eight planned steps, all
  landed; the studio now makes WFC's *search* a first-class, steerable, measurable object instead of
  an invisible internal detail.
  • **Pluggable search policy** (`heuristics.ts`) — cell-selection heuristics (Entropy / MRV /
    Scanline / Random) and tile-selection policies (Weighted / Uniform / Greedy) as small pure
    functions, swappable from a new **Search** section in Tuning and carried in the permalink.
  • **Search instrumentation** in the real solver — `eliminations`, `peakDepth`,
    `localContradictions`, and a per-cell `contraHeat` tally, surfaced as two new telemetry rows and
    a **contradiction heatmap** overlay (`K`) that paints where the solver struggled.
  • **Benchmark** (`bench.ts`) + **Solver Lab panel** — races all four heuristics on the current
    instance over shared seeds and tabulates success rate / mean steps / backtracks / peak depth,
    flagging the winner; Copy-CSV included. The empirical side of the Proof Lab.
  • **Proof Lab** grows a fifth group (5 checks): heuristic & tile-policy mechanics, every
    heuristic×policy yields valid + deterministic output, the `Σ heatmap = local contradictions`
    instrumentation law, and the benchmark aggregation arithmetic.
  Verified the full CI gate (scope + conformance + lint + build) green. Beyond CI, three headless
  harnesses against the *real* compiled engine (Node `--experimental-strip-types` + a `.ts`/dir
  resolve hook, canvas mocked for the compiler): (1) **195** solver/heuristic/bench micro-checks
  pass — completion, validity, determinism and the heatmap law across every heuristic×policy on
  synthetic permissive + gradient sets; (2) the **whole in-app Proof Lab runs 17/17** headlessly
  (the 12 pre-existing checks + the 5 new ones); (3) **back-compat is exact** — the new engine on
  the default Entropy+Weighted path reproduces the *old* solver byte-for-byte over 7 tilesets × 10
  seeds × bounded/toroidal (**140/140** tilings identical), and the permalink round-trips all new
  fields while legacy hashes still decode. Open items rolled into the v5 backlog above.
- 2026-06-19 (claude / claude-opus-4-8): **Shipped v4 — the third dimension.** Tessera grows a
  whole second, parallel engine that runs Wave Function Collapse in **true 3D**, sitting behind a
  top-level **2D ⇄ 3D** switch; the 2D studio is byte-for-byte untouched. Seventeen planned steps,
  all landed, all from scratch (no Three.js, no WebGL):
  • **Cube-group socket algebra** (`src/wfc3d/dirs3.ts`, `sockets3.ts`) — a 6-neighbour lattice
    (±X/±Y/±Z) with the well-tested Marian42/Stålberg scheme: **horizontal** faces carry a
    symmetric-or-flipped seam, **vertical** faces a rotation-indexed one, so rotating a tile about
    Y stays sound. `connects()` is provably symmetric (the Proof Lab checks it).
  • **Voxel models** (`voxel.ts`) — an R³ packed-colour block with a fluent builder and a 90°-CW
    `rotateY` that turns geometry *and* sockets together; the compiler (`compile3.ts`) expands each
    prototype into its distinct Y-rotations (deduped) and builds the 6-direction adjacency tensor.
  • **3D solver** (`solver3.ts`) — the 2D core lifted to six neighbours: support-counter
    propagation (six counters/tile), weighted min-entropy observation with seeded noise, the
    initial arc-consistency purge, and snapshot backtracking — same guarantees, one more axis.
  • **Three hand-authored volumetric tilesets** — **Terraces** (a stacked landscape; two vertical
    seam types force rock → one surface → sky), **Castle** (free-standing crenellated stone towers
    with windows + spires), and **Pipes3D** (a 23-variant conduit network whose round
    cross-sections join seamlessly across all six faces).
  • **From-scratch software voxel renderer** (`camera.ts`, `field.ts`, `raster.ts`) — an
    orthographic orbit camera (drag to spin/tilt, wheel to zoom); the merged voxel field is
    surface-extracted (interior voxels culled), back-face culled, depth-sorted by the painter's
    algorithm and filled with Lambert shading against a fixed scene light, plus hair-line voxel
    edges. ~28k voxels collapse to ~6–9k drawn faces; thumbnails reuse the same rasteriser.
  • **`Controller3` + `Studio3D`** — own loop, dirty-rebuild rendering, telemetry (incl. faces
    drawn), PNG export, live weight sliders, a permalinkable `m=3` hash, and an in-app **3D Proof
    Lab** that runs the real compiler + solver: socket symmetry, rotation-group closure, a tensor
    that matches the socket rule exactly, determinism, and the headline — *every finished 3D solve
    is 6-neighbour adjacency-valid*, re-checked the long way.
  Verified the full CI gate (conformance + lint + build) green. Headless harnesses against the
  *real* compiled engine confirmed: all three sets solve 12/12 seeds to completion with **0
  adjacency violations** and symmetric adjacency tensors; the render pipeline projects in-bounds
  with **0 NaNs** and culls 28k voxels down to ~6–9k surface faces. Open: a thin-instance/WebGPU
  path if grids ever need to be huge, and hand-painted 3D constraints (the 2D "paint" tool in 3D).
- 2026-06-18 (claude / claude-opus-4-8): **Shipped v3 — Constraint Lab: global connectivity + a
  Proof Lab.** All seven planned steps landed. Tessera gains the research-grade WFC extension — a
  genuine **global connectivity constraint** — built strictly additively on the v2 solver.
  • **Sockets → `openMask`.** Added an `emptyEdge` field to circuit/cables/knots/rails (+ the new
    Maze set); the compiler derives a per-variant 4-bit open-edge mask. Off by default, no change
    to existing sets.
  • **`connectivity.ts`** — a canvas-free graph engine over a "connectivity view" of the wave:
    connected components, iterative-Tarjan articulation points, multi-terminal reachability, and
    an exact **s–t cut-vertex** finder (the cells on *every* route between two terminals).
  • **Solver integration** — an optional constraint in two modes (*Whole network* / *Route
    between pins*) with three sound layers: optimistic feasibility pruning (a split required-set
    is a real contradiction → existing backtracking), forced-connector inference (ban blank tiles
    at cut cells and propagate), and a final validation so the solver can NEVER report a finished
    grid that violates the property — it backtracks instead. Guarded behind `opts.connectivity`,
    so with it off the engine is byte-for-byte v2.
  • **UI + render** — a connectivity selector (gated to socketed tiled sets), a network overlay
    that tints each component (one teal network = connected, many hues = fragmenting) and rings
    the terminals, plus a live "routed / N components" read-out in Telemetry. Carried in the
    permalink (back-compatible) and the JSON export.
  • **Maze tileset** — wide corridors carved through walls; "Route between pins" grows a
    guaranteed-solvable maze between two painted endpoints.
  • **Proof Lab** — an in-app panel that re-runs a real verification suite (12 checks). The
    connectivity algorithms are cross-checked against independent brute-force references over
    **1,500 random graphs** (components, articulation, both feasibility checks, the forced-connector
    cut set), and the **real solver** proves determinism (same seed ⇒ identical tiling), valid
    adjacency, the whole-network guarantee (16/16 finished runs single-component) and the
    terminal-routing guarantee (16/16 finished runs linked) — all green in ~0.7 s.
  Verified the full CI gate (`verify-project.mjs`: scope + conformance + lint + build) green, and
  ran the suite head-less against the *real* solver/engine (node type-stripping, canvas mocked):
  12/12 checks pass. Open backlog: a WebGL renderer for very large connectivity grids.
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
