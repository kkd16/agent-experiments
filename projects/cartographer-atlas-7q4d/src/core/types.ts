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
  /** Estimated population (people); filled by the economy stage. */
  population?: number
}

/** A road: an ordered list of region indices forming a terrain-aware path. */
export interface Road {
  path: number[]
  /** Trunk roads (capital links / long hauls) draw heavier than local ones. */
  trunk: boolean
  /** Trade volume 0..1 (endpoint economic complementarity × wealth); set by economy.ts. */
  trade?: number
}

/** A named waterway: its main stem traced source→mouth, with a length. */
export interface NamedRiver {
  name: string
  /** Ordered region indices from source to mouth (the main stem). */
  cells: number[]
  /** Stem length in leagues. */
  lengthLeagues: number
  /** The mouth region (where it meets the sea or a lake). */
  mouth: number
}

/** Aggregated economy for one province (indexed by its ruling city). */
export interface ProvinceInfo {
  /** Province / city index (matches cities[] and the province-owner id). */
  id: number
  /** Land-cell count. */
  area: number
  /** Aggregate wealth score (arbitrary units). */
  wealth: number
  /** Estimated population (people). */
  population: number
  /** Top export goods, richest first (resource keys, see economy.ts RESOURCES). */
  exports: string[]
}

/** A dated event in the generated chronicle. */
export type ChronicleKind =
  | 'founding'
  | 'realm'
  | 'war'
  | 'eruption'
  | 'flood'
  | 'plague'
  | 'golden'
  | 'famine'
  | 'road'
  | 'collapse'
  | 'secession'
export interface ChronicleEvent {
  year: number
  title: string
  text: string
  kind: ChronicleKind
  /** Optional map location the event refers to. */
  x?: number
  y?: number
}

// --- The Ages: a turn-based history simulation (Session 4) ----------------

/** A polity in the history simulation — a realm that rises, spreads and may fall. */
export interface SimRealm {
  id: number
  name: string
  /** Colour hue 0..360 for the ages overlay (stable across its whole life). */
  hue: number
  /** Region the realm was founded on (its first seat). */
  origin: number
  foundedYear: number
  /** Year the realm fell, or -1 if it survives to the present age. */
  deathYear: number
  /** Greatest population it ever reached. */
  peakPop: number
  /** Greatest land area (cells) it ever held. */
  peakArea: number
}

/** A city as it stands during one turn of the simulation. */
export interface SimCity {
  /** Region the city sits on. */
  r: number
  name: string
  /** Owning realm id, or -1 if the realm has fallen and it is a free town / ruin. */
  realm: number
  capital: boolean
  /** Size tier 0..3, driven by the local realm's fortunes. */
  tier: number
}

/** Per-realm live statistics at one instant on the timeline. */
export interface RealmSnapshot {
  id: number
  /** Land cells held this turn. */
  area: number
  /** People this turn. */
  population: number
  /** Capital region index (its principal seat), or -1. */
  capital: number
}

/** One turn of the simulation, snapshotted so the timeline can scrub through it. */
export interface HistoryFrame {
  year: number
  /** Realm id owning each region, or -1 for unclaimed land / water. */
  owner: Int32Array
  /** Live stats for the realms alive this turn, largest first. */
  realms: RealmSnapshot[]
  /** Cities standing this turn. */
  cities: SimCity[]
  /** Indices into `WorldHistory.events` for events that fell on this turn. */
  events: number[]
}

/** The fully simulated history of the world: realms, per-turn frames and the chronicle. */
export interface WorldHistory {
  era: string
  startYear: number
  endYear: number
  /** Every realm that ever existed, in the order they were founded. */
  realms: SimRealm[]
  /** One snapshot per turn, oldest first; the last is the present age. */
  frames: HistoryFrame[]
  /** The emergent chronicle drawn from the run, oldest first. */
  events: ChronicleEvent[]
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
  kind: 'kingdom' | 'range' | 'sea' | 'lake' | 'river'
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

  // --- Deep climate (Session 3) -------------------------------------------
  /** Continentality 0..1: how far a land cell sits from open water (drives seasonal swing). */
  continentality: Float64Array
  /** Köppen–Geiger climate id per land region (index into KOPPEN); 255 = water/none. */
  koppen: Uint8Array
  /** Warmest-month mean temperature, °C. */
  tWarm: Float32Array
  /** Coldest-month mean temperature, °C. */
  tCold: Float32Array
  /** Modelled annual precipitation, mm. */
  precipMm: Float32Array
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

  // --- Named rivers, economy & history (Session 3) -------------------------
  /** The great rivers, longest first. */
  namedRivers: NamedRiver[]
  /** For each region, the index of the NamedRiver whose stem passes through it, or -1. */
  riverName: Int32Array
  /** Dominant resource id per land region (index into economy RESOURCES); 255 = none. */
  resource: Uint8Array
  /** Per-province aggregated economy, indexed by province/city id. */
  provinceInfo: ProvinceInfo[]
  /** A generated timeline of the world's history (the emergent chronicle from `history`). */
  chronicle: ChronicleEvent[]
  /** The name of the era the chronicle is set in. */
  era: string

  // --- The Ages: the simulated, scrubbable history (Session 4) --------------
  /** The full turn-by-turn history simulation: realms, frames and events. */
  history: WorldHistory

  /** Wall-clock milliseconds spent in each pipeline stage, for the HUD. */
  timings: Record<string, number>
}
