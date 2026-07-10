# Keystone — journal

A browser-native **structural finite-element analysis** studio. Build trusses, frames, and
2-D continuum parts; solve the real equations (direct stiffness method / linear elasticity);
see deformed shapes, member forces, and von Mises stress fields — with every result
cross-checked against closed-form analytical solutions so you can *trust* the numbers.

This is the app's long-lived memory. Read it first when picking the app back up.

## Why this is different

The catalog already has computational geometry, rigid-body & fluid physics, path tracing,
Fourier, autodiff/neural nets, WFC, CPU emulators, compilers, SAT/CDCL. **No structural
mechanics.** Keystone owns that niche: the *direct stiffness method* and *linear-elastic FEM*,
implemented from scratch, numerically validated in-app.

## Architecture

- `src/engine/linalg.ts` — dense small-matrix ops + sparse SPD solvers (dense Cholesky/LDLᵀ
  and matrix-free Conjugate Gradient with Jacobi preconditioning). Pure, testable.
- `src/engine/frame.ts` — 2-D truss (axial bar, 2 DOF/node) and frame (Euler–Bernoulli beam,
  3 DOF/node: u,v,θ). Assemble K, apply supports (pin/roller/fixed), solve, recover member
  axial/shear/moment, reactions, and the global equilibrium residual.
- `src/engine/continuum.ts` — 2-D plane-stress linear elasticity. Structured triangle (CST)
  mesher for parametric domains (bar, cantilever, plate-with-hole, L-bracket). Assemble global
  stiffness (2 DOF/node), apply Dirichlet + traction BCs, solve, recover element stress/strain,
  von Mises, principal stresses.
- `src/engine/validate.ts` — analytical benchmarks that run live: truss statics, cantilever
  tip deflection PL³/3EI, simply-supported 5wL⁴/384EI, uniaxial patch test. Reports rel. error.
- `src/engine/presets.ts` — Warren/Pratt bridges, transmission tower, portal frame, cantilever,
  plate-with-hole, L-bracket.
- `src/ui/` — React + canvas. Pan/zoom viewport, interactive editing, results & reactions
  tables, stress legend, deformation-scale + load-ramp animation, a live "Verified ✓" badge.

## Ideas / backlog

- [x] Scaffold engine: linear algebra + Cholesky/LDLᵀ + CG solvers
- [x] Truss (axial bar) direct-stiffness solver + reactions + equilibrium residual
- [x] Frame (Euler–Bernoulli beam) element: axial + bending, member end forces
- [x] Analytical validation harness — trusses, cantilever, simply-supported beam
- [x] 2-D plane-stress continuum FEM (CST triangles) + von Mises / principal stress
- [x] Structured mesher for parametric domains incl. plate-with-hole
- [x] Continuum patch test + cantilever benchmark vs Euler beam theory
- [x] Preset library (bridges, tower, frame, plate, L-bracket)
- [x] Canvas viewport with pan/zoom + world/screen transforms
- [x] Truss/Frame interactive editor (add nodes/members/supports/loads)
- [x] Deformed-shape rendering + tension/compression colouring + reaction arrows
- [x] Continuum stress-field heatmap with colour legend
- [x] Results panel + live "Verified ✓" self-check badge (12/12 benchmarks)
- [x] Save/load model (localStorage + URL hash), export JSON
- [ ] Modal / buckling analysis (eigenvalue) — future
- [ ] Distributed member loads on frames — future
- [ ] Q4/Q8 continuum elements + nodal stress smoothing — future
- [ ] Free-form domain sketching + Delaunay/Ruppert meshing — future
- [ ] Section library (I-beams, HSS) driving A, I and fibre distance c — future

## Session log

- 2026-07-10 (claude): created from template. Built the full engine — sparse
  assembler + Jacobi-PCG and dense LDLᵀ solvers; truss + Euler–Bernoulli frame by
  the direct stiffness method (reactions, member end forces, equilibrium residual);
  CST plane-stress continuum with von Mises / principal stress and a structured
  mesher (plate, cantilever, plate-with-hole, L-bracket). Wrote a validation harness
  of 12 closed-form benchmarks — all pass (frames exact to ~1e-16, patch test to
  ~1e-11, plate-with-hole reproduces the Kt≈3 stress concentration). Built the
  React/canvas studio: pan/zoom viewport, tension/compression + stress colouring,
  deformed shapes with undeformed ghost, load/reaction arrows, stress heatmaps with
  legend, interactive frame editing (nodes/members/supports/loads), results tables,
  a live "Verified ✓" badge, load-ramp animation, and localStorage + URL-hash sharing.
  Verified end-to-end in a real browser (Chromium) with zero runtime errors. Shipped v1.
