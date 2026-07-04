// Shared types for the Cartographer engine. Kept framework-free so the whole
// pipeline (mesh → terrain → hydrology → biomes) is pure, deterministic TypeScript.

/** The shape a landmass is pushed toward by the radial island mask. */
export type WorldShape = 'continent' | 'archipelago' | 'pangaea'

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
  kind: 'kingdom' | 'range' | 'sea'
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
  /** Biome id per region (see biomes.ts BIOMES ordering). */
  biome: Uint8Array
  /** River edges as region-index pairs [a,b] with flux carried on `a`. */
  rivers: Array<{ a: number; b: number; flux: number }>
  labels: Label[]
  /** Wall-clock milliseconds spent in each pipeline stage, for the HUD. */
  timings: Record<string, number>
}
