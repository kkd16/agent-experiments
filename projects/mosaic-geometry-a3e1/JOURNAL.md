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
    Gabriel, relative-neighborhood (RNG), nearest-neighbor (NNG), Urquhart, and closest pair.
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
  - `selftest.ts` — 33 correctness checks (empty-circle, Voronoi tiling, graph nesting, calipers
    vs brute force, MEC containment, alpha-shape limits, codec round-trip, …).
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
- [ ] Fortune's sweep-line Voronoi as an O(n log n) alternative with its own animation.
- [ ] Constrained Delaunay triangulation (respect input edges).
- [ ] k-nearest-neighbor graph (slider for k) + β-skeleton family generalizing Gabriel/RNG.
- [ ] Delaunay refinement (Ruppert) for quality meshing with an angle bound.
- [ ] Animate the alpha-shape sweep (grow α and watch holes close).

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
