// Shared types for the Cartographer engine. Kept framework-free so the whole
// pipeline (mesh → terrain → hydrology → biomes) is pure, deterministic TypeScript.

/** The shape a landmass is pushed toward by the radial island mask. */
export type WorldShape = 'continent' | 'archipelago' | 'pangaea'

/** How the base heightfield is synthesised. */
export type TerrainMode = 'noise' | 'tectonic'

/** Parameters that fully determine a world — same params + seed ⇒ identical map. */
export interface WorldParams {
  seed: string
  width: number
  height: number
  /** Target number of Voronoi regions (before the boundary frame is added). */
  regions: number
  shape: WorldShape
  /** Sea level as a fraction of the elevation range, 0..1. Higher ⇒ more ocean. */
  seaLevel: number
  /** fBm base frequency — smaller ⇒ larger, smoother landforms. */
  noiseScale: number
  /** fBm octave count — more ⇒ more fine detail. */
  octaves: number
  /** Thermal-erosion smoothing passes over the elevation field. */
  erosion: number
  /** Rainfall per land cell that feeds flow accumulation. */
  rainfall: number
  /** River flux threshold (fraction of max flux) above which an edge is drawn. */
  riverThreshold: number
  /** How strongly the island mask pulls elevation down at the map edges, 0..1. */
  islandFalloff: number

  // --- Session-2 additions -------------------------------------------------
  /** Heightfield synthesis: layered noise, or a plate-tectonic simulation. */
  terrainMode: TerrainMode
  /** Number of tectonic plates (tectonic mode only). */
  plates: number
  /** Prevailing-wind bearing in degrees (0 = wind blows toward +x / east). */
  windAngle: number
  /** Strength of the orographic rain-shadow effect, 0 (off) .. 1. */
  orographic: number
  /** Number of cities the civilisation layer tries to place. */
  cities: number
}

/** A tectonic plate: its drift vector, crust type and a colour hint for the viz. */
export interface Plate {
  id: number
  /** Seed-site coordinates the plate grew from. */
  sx: number
  sy: number
  /** Drift velocity (world units / arbitrary time). */
  vx: number
  vy: number
  /** true ⇒ oceanic crust (dense, low); false ⇒ continental (buoyant, high). */
  oceanic: boolean
}

/** A placed settlement in the civilisation layer. */
export interface City {
  /** Region index the city sits on. */
  r: number
  x: number
  y: number
  name: string
  /** Site-quality score that won it a slot, 0..1-ish. */
  score: number
  /** Population tier 0..3, drives marker size + label weight. */
  tier: number
  /** true for the realm capital (largest province). */
  capital: boolean
  /** Province / realm name this city rules. */
  realm: string
}

/** A road: an ordered list of region indices forming a terrain-aware path. */
export interface Road {
  path: number[]
  /** Trunk roads (capital links / long hauls) draw heavier than local ones. */
  trunk: boolean
}

/** The dual mesh: Voronoi regions and their Delaunay triangle duals. */
export interface Mesh {
  /** Region site coordinates, flat [x0,y0,x1,y1,...], length = numRegions*2. */
  px: Float64Array
  py: Float64Array
  numRegions: number
  /** Number of "solid" (non-boundary-frame) regions; frame regions are appended after. */
  numSolid: number
  /** Delaunay triangle circumcenters (Voronoi vertices), one (x,y) per triangle. */
  cx: Float64Array
  cy: Float64Array
  numTriangles: number
  /** For each region, the CCW-ordered triangle indices whose circumcenters form its cell. */
  cellTriangles: number[][]
  /** Delaunay triangle corner → region index (Delaunator's `triangles`). */
  triangles: Uint32Array
  /** Opposite half-edge per half-edge, or -1 on the hull (Delaunator's `halfedges`). */
  halfedges: Int32Array
  /** Adjacency: for each region, indices of neighbouring regions. */
  neighbors: number[][]
  /** True for boundary-frame regions (kept as permanent ocean, never rendered as land). */
  isFrame: Uint8Array
}

/** A single named feature placed on the map. */
export interface Label {
  x: number
  y: number
  text: string
  kind: 'kingdom' | 'range' | 'sea' | 'lake'
  /** Relative importance 0..1, used to scale font size. */
  weight: number
}

/** The fully generated world: mesh plus per-region fields. */
export interface WorldMap {
  params: WorldParams
  mesh: Mesh
  /** Elevation per region, normalised so sea level sits at `params.seaLevel`. */
  elevation: Float64Array
  /** Elevation after depression filling (guarantees drainage to the sea). */
  filled: Float64Array
  /** 1 if the region is ocean (below sea level), else 0. */
  ocean: Uint8Array
  /** 1 if a land region touches an ocean region (coastline). */
  coast: Uint8Array
  /** Downslope neighbour region index per land region, or -1 for ocean/sink. */
  downslope: Int32Array
  /** Accumulated water flux per region (rainfall routed downhill). */
  flux: Float64Array
  /** Moisture 0..1 per region (from coast + river proximity). */
  moisture: Float64Array
  /** Temperature 0..1 per region (latitude + altitude lapse). */
  temperature: Float64Array
  /** Orographic precipitation 0..1 per region (prevailing-wind rain shadow). */
  precip: Float64Array
  /** Biome id per region (see biomes.ts BIOMES ordering). */
  biome: Uint8Array
  /** River edges as region-index pairs [a,b] with flux carried on `a`. */
  rivers: Array<{ a: number; b: number; flux: number }>
  labels: Label[]

  // --- Lakes ---------------------------------------------------------------
  /** Spill surface from the no-epsilon flood; water rests at this level in basins. */
  waterLevel: Float64Array
  /** 1 if a land region is submerged under a lake / inland sea. */
  lake: Uint8Array

  // --- Tectonics (present when params.terrainMode === 'tectonic') ----------
  /** Plate id per region, or -1. */
  plateId: Int32Array
  /** 1 if a region sits on a plate boundary. */
  plateBoundary: Uint8Array
  plates: Plate[]

  // --- Civilisation --------------------------------------------------------
  cities: City[]
  /** Province owner (index into `cities`) per land region, or -1. */
  province: Int32Array
  roads: Road[]

  /** Wall-clock milliseconds spent in each pipeline stage, for the HUD. */
  timings: Record<string, number>
}
