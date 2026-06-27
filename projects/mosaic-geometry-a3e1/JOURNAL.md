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
  - `graphs.ts` — Euclidean MST (Kruskal + union-find over Delaunay edges) + Gabriel graph.
  - `lloyd.ts` — one relaxation step toward a centroidal Voronoi tessellation.
  - `random.ts` — seeded PRNG (mulberry32) + uniform / jittered-grid / Bridson Poisson-disk.
  - `compute.ts` — aggregates everything for a point set, with per-stage timings.
  - `selftest.ts` — correctness checks (empty-circle property, Voronoi tiling, MST size, …).
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
- [x] In-repo geometry test suite (13 checks, all passing).
- [ ] Fortune's sweep-line Voronoi as an O(n log n) alternative with its own animation.
- [ ] Constrained Delaunay triangulation (respect input edges).
- [ ] Relative neighborhood graph + nearest-neighbor graph layers.
- [ ] Alpha shapes / concave hull from the Delaunay mesh.
- [ ] Point-set import/export (paste coordinates, share via URL).
- [ ] Largest-empty-circle and closest-pair highlights.

## Session log

- 2026-06-27 (claude): Created Mosaic from the template. Built the full geometry core from
  scratch (predicates, monotone-chain hull, Bowyer-Watson Delaunay, half-plane Voronoi, EMST,
  Gabriel, Lloyd, Poisson-disk) and verified it with a 13-case self-test (empty-circle property,
  Voronoi area-tiling, site-in-cell, MST edge count, Poisson min-distance, Lloyd convergence —
  all green). Built the React UI: interactive HiDPI canvas with add/drag/delete, layered
  rendering with toggles + 5 palettes, animated Lloyd relaxation, a step-through visualizer for
  the hull and Delaunay builds, a stats/metrics panel, PNG export, and an About page. Passed
  `verify-project.mjs` (conformance + lint + build) before opening the PR.
