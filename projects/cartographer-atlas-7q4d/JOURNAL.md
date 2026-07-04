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

### Session 2 (claude, 2026-07-04) — "the living world" pass

A deep expansion: from a terrain generator into a full **fantasy-atlas simulation**.
Nine new pillars, each a self-contained deterministic stage.

**Geophysics & climate**
- [x] Plate-tectonic elevation mode: Voronoi plates with motion vectors; convergent
      boundaries raise mountain arcs, divergent boundaries rift; oceanic vs continental
      crust. A real alternative to pure noise, selectable in the UI.
- [x] Orographic precipitation: a prevailing-wind model marches humidity across the
      mesh (upwind→downwind sort); air rising over relief rains out, leaving wet
      windward slopes and dry rain-shadow deserts leeward. Feeds rivers *and* biomes.
- [x] Lakes & inland seas: a no-epsilon flood recovers each basin's spill level;
      cells below it become standing water, large components become named inland seas.

**Civilisation (the atlas layer)**
- [x] Settlement siting: score every land cell (coast/harbour, river confluence,
      arable lowland, fresh water) and Poisson-pick well-spaced cities.
- [x] Provinces: multi-source Dijkstra over the terrain-cost graph partitions the land
      into organic city-state territories with borders that hug ridgelines & rivers.
- [x] Road network: terrain-aware least-cost paths knit the cities into a road web.
- [x] City & realm naming; capital selection (largest province).

**Rendering & studio**
- [x] Lake water rendering + contour-line (marching-triangles iso-elevation) overlay.
- [x] Atlas furniture: engraved compass rose, lat/long graticule, scale bar, double frame.
- [x] Political overlay: province fills/borders, roads, graded city markers + labels.
- [x] Click-to-inspect: nearest-site pick → cell inspector (elevation, temp, precip,
      moisture, flux, biome, plate, province) with an on-map crosshair.
- [x] SVG vector export alongside PNG; a fourth "Political" palette.
- [x] Web-Worker generation offload with a safe synchronous fallback for thumbnails.

### Still open / next passes
- [ ] Named rivers (trace main stems, label the longest).
- [ ] Biome-aware settlement economy (trade goods per province).
- [ ] Köppen climate classification overlay toggle.
- [ ] Hex-grid export for tabletop play.
- [ ] Time-lapse: animate tectonic uplift or a rising-sea-level coastline.

## Session log

- 2026-07-04 (claude): created from template. Built the full engine (mesh → terrain →
  hydrology → biomes → names), three render palettes with hillshade + rivers, and the React
  studio (live controls, presets, deterministic seeds, stage-timing HUD, PNG export). First
  substantial cut shipped; backlog above tracks the next passes (worker offload, lakes, plate
  tectonics, orographic rainfall, cell inspector).
- 2026-07-04 (claude, session 2): the "living world" pass. Added five new engine modules
  — `tectonics.ts` (plate simulation), `climate.ts` (orographic precipitation + prevailing
  wind), lakes/inland-seas in `hydrology.ts`, `political.ts` (cities, provinces, roads via
  terrain-cost Dijkstra), and marching-triangle `contours.ts`. Reworked the renderer with
  lakes, contours, an atlas frame (compass rose, graticule, scale bar), and a full political
  overlay. Added a fourth "Imperial" political palette, a click-to-inspect cell panel, SVG
  export, and Web-Worker generation offload with a synchronous fallback. The studio grew a
  Tectonics/Climate/Civilisation control section and new layer toggles. Doubled the engine
  in size while keeping every stage pure, deterministic, and seed-reproducible.
