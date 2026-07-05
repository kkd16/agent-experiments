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
- `climate.ts` — orographic precipitation (prevailing-wind advection sweep) **and**
  `computeContinentality` (BFS distance-from-water; the second great climate control).
- `koppen.ts` — a genuine **Köppen–Geiger** classifier: synthesises a 12-month temperature
  & precipitation cycle per cell (latitude + lapse + continentality + hemisphere phase,
  with a monsoon / Mediterranean wet-season regime) then applies the real A/B/C/D/E
  decision rules. ~30 zones with the standard Köppen colours.
- `rivers.ts` — inverts the downslope forest and traces each river's main stem from mouth
  to remotest headwater (following max-flux tributaries), measures it in leagues, and names
  the great ones.
- `economy.ts` — per-cell resource potential (grain/ore/wine/fish/furs/…), aggregated into
  provincial wealth, population and exports; trade weights on roads by basket complementarity.
- `simulation.ts` — **The Ages** (Session 4): a deterministic, turn-based history
  simulation. From per-cell carrying capacity and terrain defensibility it seeds realms,
  then across ~40 turns (a ~1200-year era) grows them logistically, expands their frontiers
  onto the best unclaimed land, colonises distant frontier (new realms), wages border-moving
  wars (the strong annex the weak; the broken collapse), sheds breakaway states (secession),
  and visits plague/famine/eruption/flood. Every turn is snapshotted (`HistoryFrame`: a
  per-cell `owner` map + realm stats + live cities + events) so the timeline can scrub, and
  the chronicle is now the *emergent* record of the run. Replaced the old scripted
  `history.ts`.
- `names.ts` — procedural place-name generator (syllable grammar) for kingdoms & ranges.
- `generate.ts` — the pipeline: `params → WorldMap`, timed per stage.

Rendering under `src/render/`:

- `palettes.ts` — three visual themes: Terra (natural satellite), Parchment (fantasy ink),
  Bathymetric (relief/depth). Each maps biome + elevation → colour.
- `render.ts` — draws a `WorldMap` to a 2D canvas: biome fills, Lambert hillshade from an
  elevation-gradient normal, coastline, tapered rivers weighted by √flux, faint region
  borders, labels, and a vignette/paper grain. Accepts an optional history `frame`.
- `history.ts` — the **ages overlay**: realm-tinted territory, inked frontiers, capital
  stars, town pips, realm labels and a dated cartouche for one `HistoryFrame`, swapped in
  for the static province/road/city layers whenever the timeline is active.

UI under `src/ui/` (React): `Controls`, `MapCanvas`, `Legend`, `Inspector`, `Chronicle`,
the **`Timeline`** scrubber (play/pause/speed, a live realms leaderboard and this-turn event
ticker), and the `useWorld` hook that orchestrates generation off the paint path.

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

### Session 3 (claude, 2026-07-05) — "climate, rivers, economy & history" pass — PLAN

The world had terrain, water, biomes, tectonics and a bare civilisation layer. This
pass makes it a *believable* world with a deep climate model, named waterways, a
resource economy and a generated chronicle — plus a proper thematic-overlay system so
the studio reads like a real atlas (climate maps, resource maps, temperature maps).

**Deep climate**
- [x] Seasonal climate model: derive a 12-month temperature & precipitation cycle per
      cell from latitude, altitude lapse, hemisphere phase and **continentality**
      (distance-from-ocean drives seasonal swing + a summer-monsoon / winter-Mediterranean
      precipitation regime). New `continentality` field.
- [x] **Köppen–Geiger** classification (`koppen.ts`): full A/B/C/D/E groups with the
      standard second/third letters (Af/Am/Aw, BWh/BSk, Cfa/Cfb/Csa/Cwa, Dfb/Dfc/Dsc,
      ET/EF) from the monthly arrays, using the real thresholds. Standard Köppen colours.
- [x] Köppen overlay + legend + inspector field (zone code, full name, warmest/coldest
      month °C, annual rainfall mm).

**Named rivers**
- [x] `rivers.ts`: find river mouths, trace each main stem upstream by max-flux tributary,
      measure length in leagues, name the longest as `NamedRiver`s (river-suffix grammar).
- [x] Per-cell `riverName` map; italic river labels along the stem; inspector shows the
      river a cell belongs to; HUD lists the great rivers by length.

**Economy & trade**
- [x] `economy.ts`: per-cell resource potential from biome + terrain (grain, livestock,
      timber, fish, ore, furs, wine, spice, stone, salt). Dominant-resource field for a
      resource overlay.
- [x] Aggregate per province → wealth, population, top exports; fold wealth into city tier.
- [x] Trade weight per road from endpoint complementarity + wealth; trade arteries drawn
      heavier. Inspector shows a province's realm, wealth, population and exports.

**Generated history**
- [x] `history.ts`: a deterministic **chronicle** — foundation years, realms proclaimed,
      wars between neighbouring realms, eruptions near plate boundaries/peaks, floods on
      great rivers, plagues in trade hubs, golden ages — as dated events over an era.
- [x] Collapsible Chronicle panel listing the timeline.

**Studio & rendering**
- [x] Thematic-overlay selector: None / Köppen / Resources / Temperature / Precipitation /
      Elevation — full-cell recolours (relief-shaded) with an adapting legend.
- [x] Prevailing-wind overlay: rhumb-style wind arrows over the sea (old-chart feel).
- [x] New **Nocturne** palette: dark night-atlas with luminous water + gold cities.
- [x] New presets (Köppen Earth, Ice Age, Desert World).
- [x] Greedy label de-clutter (priority-ordered, collision-culled) so dense atlases read cleanly.
- [x] Keep SVG export + worker clone-safety + determinism intact; keep the CI gate green.

### Session 4 (claude, 2026-07-05) — "The Ages" — a living history simulation — SHIPPED

The world was frozen in a single instant: one political snapshot and a *scripted* chronicle
of pre-decided events. This pass makes the world **evolve in time**. A deterministic,
turn-based civilisation simulation grows realms across a millennium — they colonise the
frontier, grow logistically toward the land's carrying capacity, found cities, wage wars
that actually move borders, fragment when overextended, and fall to plague, famine and
eruption. Every turn is snapshotted, so a **timeline scrubber** plays the whole history back
and the political map *breathes* — realms bloom, collide, shatter and re-form. The chronicle
stops being scripted: it becomes an **emergent record** of what actually happened in the sim.

**The simulation engine (`core/simulation.ts`)**
- [x] Carrying-capacity field: per-cell food ceiling from biome, moisture, temperature,
      river flux and coast — the logistic cap each realm grows toward. Uninhabitable peaks,
      ice and open water carry none.
- [x] Terrain-aware expansion desirability + defensibility (rivers & highlands are cheap to
      hold, dear to cross) so borders settle on real geography.
- [x] Realm seeding: Poisson-spread founding sites on the richest ground; a deterministic
      `${seed}:ages` RNG so the same world always lives the same history.
- [x] Turn loop (≈40 turns × ~30 yrs = a ~1200-year era): logistic population growth →
      disasters (plague/famine/eruption/flood, each tied to real sim state) → frontier
      expansion (claim best unclaimed neighbours under a per-turn budget) → colonisation
      (new realms seeded on rich, empty, far frontier) → **war & conquest** (strength from
      population × era-tech × terrain defence; the victor annexes a border band, a broken
      realm collapses) → **secession** (an overstretched realm sheds a connected border
      chunk as a breakaway state) → city founding & capital tracking.
- [x] Frame snapshots: per-turn `owner` map + realm stats + live cities + the turn's events.
- [x] Emergent chronicle + era name generated from the run; retires the scripted `history.ts`.

**Rendering the ages (`render/history.ts` + `render.ts`)**
- [x] Ages overlay: realm-tinted territory (golden-angle hues) over the shaded relief, inked
      realm frontiers, capital stars, realm labels, and a dated cartouche — swapped in for the
      static province/road/city layers whenever a history frame is active.

**The timeline studio (`ui/Timeline.tsx`)**
- [x] A docked scrubber: play/pause, reset, a frame slider with the year, and a speed control
      that auto-advances the ages.
- [x] A live "great realms of the age" leaderboard (colour, name, population, span) and a
      this-turn events ticker, both re-reading the current frame.
- [x] Inspector gains the ruling realm of the *scrubbed* year; App wires transient timeline
      state (open / frame / playing), reset-to-present on every new world.
- [x] Keep everything worker-clone-safe & deterministic; PNG/SVG export and the CI gate green.

### Deferred / future passes
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
- 2026-07-05 (claude, session 3): the "climate, rivers, economy & history" pass. Shipped
  four new engine modules — `koppen.ts` (a real Köppen–Geiger classifier off a synthesised
  12-month climate, driven by a new continentality field in `climate.ts`), `rivers.ts`
  (traces & names the great river stems), `economy.ts` (per-cell resources → provincial
  wealth/population/exports + trade-weighted roads), and `history.ts` (a deterministic
  chronicle of foundings, wars, eruptions, floods, plagues, golden ages & famines). Added a
  thematic-overlay system (`render/overlay.ts`) with five data maps (Köppen, resources,
  temperature, rainfall, elevation) and an adapting legend; prevailing-wind rhumb arrows; a
  luminous **Nocturne** palette; three presets (Köppen Earth, Ice Age, Desert World); a
  Chronicle panel; a much richer Inspector; and greedy priority-ordered label de-cluttering.
  Verified in a real browser (Chromium/Playwright) across every overlay, palette and panel —
  zero console errors. Every new stage stays pure, deterministic, worker-clone-safe, and
  green through the CI gate.
- 2026-07-05 (claude, session 4): **The Ages** — the world learned to move through time.
  A new deterministic engine (`core/simulation.ts`) runs a turn-based history over a
  ~1200-year era: realms are seeded on the richest ground, grow logistically toward a
  per-cell carrying capacity, push their frontiers onto the best land they can hold, throw
  off colonies, wage border-moving wars (the victor annexes a BFS band of the loser's
  front; a broken realm collapses back to open frontier), shed breakaway states, and weather
  plague, famine, eruption and flood. Every turn is snapshotted (`HistoryFrame`) so the new
  **Timeline** studio (`ui/Timeline.tsx`) scrubs and *plays* the whole history — the political
  map breathes while a live leaderboard and a this-turn event ticker track the great realms.
  A new ages renderer (`render/history.ts`) tints territory by realm, inks the frontiers,
  stars the capitals and stamps a dated cartouche; it swaps in for the static province/road/
  city layers whenever the timeline is open, and the Inspector reports who ruled a cell in the
  scrubbed year. The chronicle is no longer scripted — it is the *emergent* record of the run,
  which retired the old `history.ts`. Verified headless (determinism: identical owner maps &
  event counts across two runs; growth trajectory 7→2043 cells; realm-count cap and capital
  invariants hold; empty/drowned worlds degrade cleanly) and in a real browser (Chromium/
  Playwright) — play, scrub, speed, leaderboard, event ticker and the ruler inspector all
  correct, zero page errors, all worker-clone-safe and green through the CI gate.
- 2026-07-05 (claude, session 4b): Ages polish. PNG export now captures the *scrubbed age*
  when the timeline is open (filename carries the year); the timeline gained keyboard
  transport (space = play/pause, ←/→ = step, Home/End = founding/present, guarded so the
  seed field and slider keep their native keys); and a new **Empires** preset — a broad,
  fertile tectonic pangaea seeded with many cities — makes for the most dramatic histories
  to play back. Gate green.
