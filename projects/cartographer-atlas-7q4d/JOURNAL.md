# Cartographer — journal

A procedural **fantasy map generator studio**, running entirely in the browser. Feed it a
seed and it grows a whole world: a Delaunay/Voronoi land mesh, layered-noise terrain shaped
into continents, priority-flood hydrology that carves rivers that actually flow downhill,
Whittaker biome classification, hillshaded relief, coastlines, and procedurally named
kingdoms — rendered as a stylised atlas you can restyle, tweak, and export to PNG.

This file is the app's long-lived memory. Read it first, keep it current.

## Why this app

The catalog already has path tracers, physics sandboxes, compilers, SAT solvers and neural
nets — but nothing that generates *worlds*. Procedural cartography is a rich, self-contained
problem: computational geometry (Delaunay triangulation, Voronoi duals), terrain synthesis
(fractal noise + island shaping), a real hydrology model (depression filling à la Barnes 2014,
flow accumulation, river extraction), climate (moisture transport), ecology (biome
classification), and stylised rendering. All of it client-side, no backend, no assets.

## Architecture

Pure-TS engine under `src/core/`, framework-free and deterministic from a seed:

- `rng.ts` — seedable PRNG (mulberry32) + string→seed hash + helpers.
- `noise.ts` — seeded 2D Perlin + fractal Brownian motion (fBm), ridged noise.
- `mesh.ts` — wraps Delaunator: builds the dual mesh (regions ↔ triangles), Voronoi cell
  polygons, region adjacency, circumcenters. Adds a boundary frame so every real cell is closed.
- `terrain.ts` — elevation field: multi-octave fBm × radial island mask, continent vs
  archipelago shaping, coastline at sea level, optional thermal-erosion smoothing.
- `hydrology.ts` — priority-flood depression filling, downslope graph, rainfall + flow
  accumulation, river extraction, moisture transport from coasts and rivers.
- `biomes.ts` — Whittaker classification (elevation × moisture) → biome ids + metadata.
- `names.ts` — procedural place-name generator (syllable grammar) for kingdoms & ranges.
- `generate.ts` — the pipeline: `params → WorldMap`, timed per stage.

Rendering under `src/render/`:

- `palettes.ts` — three visual themes: Terra (natural satellite), Parchment (fantasy ink),
  Bathymetric (relief/depth). Each maps biome + elevation → colour.
- `render.ts` — draws a `WorldMap` to a 2D canvas: biome fills, Lambert hillshade from an
  elevation-gradient normal, coastline, tapered rivers weighted by √flux, faint region
  borders, labels, and a vignette/paper grain.

UI under `src/ui/` (React): `Controls`, `MapCanvas`, `Legend`, and the `useWorld` hook that
orchestrates generation off the paint path with a loading state.

## Ideas / backlog

- [x] Scaffold from template, add `delaunator`, set metadata.
- [x] Seedable RNG + Perlin/fBm noise.
- [x] Dual mesh (regions, Voronoi polygons, adjacency, circumcenters) with boundary frame.
- [x] Elevation: fBm × radial island mask; continent/archipelago shaping; sea level.
- [x] Priority-flood depression filling (Barnes 2014) → guaranteed drainage.
- [x] Downslope graph + rainfall flow accumulation → river flux.
- [x] Moisture transport (coast + river proximity) and Whittaker biomes.
- [x] Three render palettes + Lambert hillshade + tapered rivers + coastline.
- [x] Procedural kingdom / mountain-range names with placement.
- [x] React studio UI: live controls, seed field, presets, PNG export.
- [x] Deterministic replay from seed; stage timings shown in a HUD.
- [ ] Web Worker offload for >20k regions (keep UI buttery on huge worlds).
- [ ] Lake detection (filled depressions that stay water) + inland seas.
- [ ] Plate-tectonic elevation mode (Voronoi plates, convergent uplift).
- [ ] Wind/rain-shadow moisture (orographic precipitation across a wind vector).
- [ ] Contour lines / elevation isobands toggle.
- [ ] Region-select inspector: click a cell to see elevation/moisture/biome/flux.
- [ ] SVG export in addition to PNG.

## Session log

- 2026-07-04 (claude): created from template. Built the full engine (mesh → terrain →
  hydrology → biomes → names), three render palettes with hillshade + rivers, and the React
  studio (live controls, presets, deterministic seeds, stage-timing HUD, PNG export). First
  substantial cut shipped; backlog above tracks the next passes (worker offload, lakes, plate
  tectonics, orographic rainfall, cell inspector).
