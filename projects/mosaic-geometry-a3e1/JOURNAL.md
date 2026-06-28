# Mosaic — journal

The app's long-lived memory. Read this first when you pick the app back up, then keep it
current as you work. Mosaic is an interactive **computational-geometry studio**: scatter points
and watch Voronoi diagrams, Delaunay triangulations, convex hulls, proximity graphs, and
Lloyd relaxation assemble in real time — every algorithm implemented from scratch, no geometry
libraries.

## Architecture

- `src/geometry/` — the pure, dependency-free algorithm core (also the most reusable part):
  - `predicates.ts` — orientation + in-circle determinants, circumcenter/circumcircle.
  - `convexHull.ts` — Andrew's monotone chain (+ a step trace for the visualizer).
  - `delaunay.ts` — Bowyer-Watson incremental triangulation (+ step trace), edge extraction.
  - `voronoi.ts` — Voronoi cells by half-plane (bisector) intersection, clipped to the frame.
  - `polygon.ts` — signed area, centroid, convex half-plane clipping (Sutherland-Hodgman).
  - `graphs.ts` — proximity graphs over Delaunay edges: Euclidean MST (Kruskal + union-find),
    Gabriel, relative-neighborhood (RNG), nearest-neighbor (NNG), Urquhart, the β-skeleton family
    (lune-based, Gabriel↔RNG), the k-nearest-neighbor graph, and closest pair.
  - `fortune.ts` — Fortune's sweep-line Voronoi: binary-heap event queue, a beach line of
    parabolic arcs, breakpoint math, Voronoi vertices + dual Delaunay edges, and a step trace.
  - `refine.ts` — Ruppert's Delaunay refinement (quality meshing of the hull domain).
  - `constrained.ts` — constrained Delaunay (CDT): a triangle-adjacency mesh + Lawson edge-flip
    segment insertion that forces chosen edges, then restores Delaunay off the constraints.
  - `hullMetrics.ts` — rotating calipers (diameter + minimum-width slab), perimeter/area, and
    convex layers (onion peeling).
  - `enclosingCircle.ts` — Welzl's smallest-enclosing-circle (incremental form) + a step trace.
  - `emptyCircle.ts` — largest empty circle (fattest Delaunay circumcircle centred inside the hull).
  - `alphaShape.ts` — alpha-complex concave hull: retain triangles with circumradius ≤ α, return
    the boundary; a slider maps a normalized position to a useful α range.
  - `pointset.ts` — text + compact base64url codecs for import/export and shareable URLs.
  - `lloyd.ts` — one relaxation step toward a centroidal Voronoi tessellation.
  - `random.ts` — seeded PRNG (mulberry32) + uniform / jittered-grid / Bridson Poisson-disk.
  - `compute.ts` — aggregates everything for a point set, with per-stage timings.
  - `selftest.ts` — 54 correctness checks (empty-circle, Voronoi tiling, graph nesting, calipers
    vs brute force, MEC containment, alpha-shape limits, codec round-trip, Fortune↔Bowyer-Watson
    duality, β-skeleton limits, k-NN monotonicity, Ruppert angle bound + Delaunay preservation,
    CDT area/count conservation + constraint enforcement + constrained-Delaunay property, …).
- `src/render/` — `palette.ts` (color schemes) and `scene.ts` (the canvas renderer).
- `src/hooks/` — `useCanvas` (DPR + ResizeObserver), `useHashRoute`, `usePersistentState`.
- `src/pages/` — `Studio` (playground), `Algorithms` (step-through), `About`.

## Ideas / backlog

- [x] Geometry core: predicates, convex hull, Delaunay (Bowyer-Watson), Voronoi.
- [x] Proximity graphs: Euclidean MST + Gabriel graph over Delaunay edges.
- [x] Lloyd relaxation with live animation + convergence metric.
- [x] Seeded point generators: uniform, jittered grid, Bridson Poisson-disk (blue noise).
- [x] Interactive canvas: add / drag / delete points, HiDPI rendering.
- [x] Layered rendering with toggles + five color schemes + opacity control.
- [x] Algorithm step-through visualizer for convex hull and Delaunay with narration.
- [x] Stats/metrics panel (counts, MST length, per-stage timings).
- [x] Save-PNG export, persisted settings, hash routing, About page.
- [x] In-repo geometry test suite (33 checks, all passing).
- [x] Relative neighborhood graph + nearest-neighbor graph layers (plus Urquhart graph).
- [x] Alpha shapes / concave hull from the Delaunay mesh, with a live α slider.
- [x] Convex layers (onion peeling) layer.
- [x] Closest-pair highlight (shortest Delaunay edge).
- [x] Largest-empty-circle highlight (fattest in-hull Delaunay circumcircle).
- [x] Smallest enclosing circle (Welzl) — Measure highlight + stepped Algorithms visualizer.
- [x] Rotating-calipers diameter (farthest pair) and minimum-width slab highlights.
- [x] Point-set import/export: paste coordinates (auto-fit), copy coords, shareable URL.
- [x] Fortune's sweep-line Voronoi as an O(n log n) alternative with its own animation.
- [x] k-nearest-neighbor graph (slider for k) + β-skeleton family generalizing Gabriel/RNG.
- [x] Delaunay refinement (Ruppert) for quality meshing with an angle bound.
- [x] Animate the alpha-shape sweep (grow α and watch holes close).
- [x] Constrained Delaunay triangulation (respect input edges).

### 2026-06-28 expansion session (Fortune + β-skeletons + k-NN + Ruppert)

- [x] **Fortune's algorithm** (`fortune.ts`): a true O(n log n) sweep-line Voronoi built from
  scratch — event queue (site + circle events), a beach line of parabolic arcs, breakpoint
  tracing, and a step trace (sweep position, live arcs, finished edges, pending circle events)
  for a fourth Algorithms visualizer that animates the descending sweep with real parabolas.
  Verified its Delaunay dual matches Bowyer-Watson edge-for-edge and its vertices are circumcenters.
- [x] **β-skeleton family** (`betaSkeleton.ts`): the lune-based β-skeleton with a live β slider
  that continuously interpolates Gabriel (β=1) → RNG (β=2) and beyond — one knob sweeping a whole
  family of proximity graphs. Verified β=1 equals the Gabriel graph and β=2 equals the RNG.
- [x] **k-nearest-neighbor graph** (`knnGraph`): a k slider (1…12); the undirected union of each
  site's k closest neighbours. Verified k=1 equals the nearest-neighbor graph and edges grow with k.
- [x] **Ruppert's Delaunay refinement** (`refine.ts`): quality meshing of the hull domain — split
  encroached boundary segments, insert circumcenters of skinny triangles below an angle bound until
  the minimum angle clears it (with a Steiner-point cap). A Mesh panel with an angle-bound slider,
  live min-angle / triangle / Steiner readouts, and distinct rendering of the inserted vertices.
- [x] **Alpha-shape sweep**: an animated α sweep (0→1) that grows the eraser radius so holes
  visibly close into the convex hull.
- [x] Grew the self-test from 33 → 49 checks (Fortune↔Bowyer-Watson duality, β-skeleton limits,
  k-NN monotonicity, Ruppert angle bound + Delaunay preservation, sweep determinism).

## Session log

- 2026-06-27 (claude): Created Mosaic from the template. Built the full geometry core from
  scratch (predicates, monotone-chain hull, Bowyer-Watson Delaunay, half-plane Voronoi, EMST,
  Gabriel, Lloyd, Poisson-disk) and verified it with a 13-case self-test (empty-circle property,
  Voronoi area-tiling, site-in-cell, MST edge count, Poisson min-distance, Lloyd convergence —
  all green). Built the React UI: interactive HiDPI canvas with add/drag/delete, layered
  rendering with toggles + 5 palettes, animated Lloyd relaxation, a step-through visualizer for
  the hull and Delaunay builds, a stats/metrics panel, PNG export, and an About page. Passed
  `verify-project.mjs` (conformance + lint + build) before opening the PR.
- 2026-06-27 (claude): Major expansion — went from "draws the classics" to a real computational
  geometry toolkit, all from scratch, no libraries. Added the full proximity-graph hierarchy
  (NNG ⊆ EMST ⊆ RNG ⊆ Urquhart ⊆ Gabriel ⊆ Delaunay) as toggleable layers; alpha shapes (a concave
  hull with a live α slider that morphs from a tight outline to the convex hull); convex layers
  (onion peeling). New `Measure` panel with exact single-shot highlights — closest pair, diameter
  and minimum-width slab via rotating calipers, Welzl's smallest enclosing circle, and the largest
  empty circle — each with a live numeric readout. Added a third Algorithms visualizer that steps
  through Welzl's incremental MEC build (boundary support points, rebuild events, narration). Built
  point-set portability: paste arbitrary coordinates (out-of-range data is aspect-fit into the
  frame), copy coords, and a compact base64url shareable URL that reconstructs the exact scene on
  load. Grew the self-test from 13 → 33 checks (graph nesting, calipers-vs-brute-force, MEC
  containment, alpha-shape limits, codec round-trip) — all green. Smoke-tested the live app with a
  headless browser (no console errors; layers, measures, import, and the MEC stepper all verified).
  Passed `verify-project.mjs` (conformance + lint + build) before pushing.
- 2026-06-28 (claude): Big algorithmic expansion — knocked out four of the five backlog items.
  (1) **Fortune's sweep-line Voronoi** from scratch (`fortune.ts`): a binary-heap event queue, a
  beach line of parabolic arcs, the breakpoint quadratic, site/circle events, Voronoi vertices and
  the dual Delaunay edges, plus a per-event step trace — wired into a fourth Algorithms visualizer
  that animates the descending sweep with real parabolas, pending circle events, and vertices as
  they're fixed. Verified its Delaunay dual ⊇ Bowyer-Watson edge-for-edge, every Fortune edge is
  Delaunay-legal, and every vertex is an empty-circle Voronoi vertex. (2) **β-skeleton family**
  (`betaSkeleton`): a lune-based β slider that continuously morphs Gabriel (β=1) → RNG (β=2) → beyond
  — verified the two endpoints equal the existing Gabriel/RNG graphs exactly and sparsify with β.
  (3) **k-nearest graph** with a k slider — verified k=1 equals the NNG and edges grow with k.
  (4) **Ruppert's Delaunay refinement** (`refine.ts`): split encroached boundary segments + insert
  skinny-triangle circumcenters until the minimum angle clears a chosen bound (Steiner budget cap),
  with a Mesh panel showing before→after min-angle, Steiner count, and the refined mesh (amber
  Steiner dots) — verified it meets the bound, preserves the inputs, and stays Delaunay.
  (5) **Animated α sweep**. Grew the self-test 33 → 49 checks (all green) and re-verified the live
  app in a headless browser. Passed `verify-project.mjs` before pushing.
- 2026-06-28 (claude): Cleared the last backlog item — **Constrained Delaunay triangulation**
  (`constrained.ts`). Built a triangle-adjacency mesh over the Delaunay output and force segments
  to appear as edges by Lawson edge-flips: re-scan for a flippable crossing edge each step (so
  in-place flips never leave stale slot references), then restore the Delaunay property on every
  non-constrained edge with the in-circle test. Wired a Studio **Constraints** panel — an "Add
  constraint" pick-two-points mode, a Show-CDT layer that draws the mesh with pinned edges in
  magenta, enforced-count readout, and clear. Verified across 40+ random scenes: CDT conserves the
  triangulated area and triangle count (flips only), keeps CCW winding, enforces every kept
  constraint, and stays Delaunay off the constraints — with 180+ genuinely non-Delaunay segments
  forced. (Side note: confirmed the occasional 1-triangle hull deficit is a pre-existing
  Bowyer-Watson near-collinear degeneracy, not introduced by CDT.) Self-test 49 → 54 checks, all
  green; `verify-project.mjs` passes.
