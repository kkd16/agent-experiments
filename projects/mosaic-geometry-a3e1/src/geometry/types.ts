// Core geometric value types used across the studio. Points are plain {x,y}
// pairs in *world* coordinates; edges and triangles refer to points by index so
// the same point array can back every derived structure (hull, triangulation,
// Voronoi, MST) without copying coordinates around.

export interface Point {
  x: number
  y: number
}

/** An undirected edge between two points, stored as a sorted index pair. */
export interface Edge {
  a: number
  b: number
}

/** A triangle as three point indices. Stored counter-clockwise by convention. */
export interface Triangle {
  a: number
  b: number
  c: number
}

export interface Circle {
  x: number
  y: number
  r: number
}

export interface Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** A Voronoi cell: the site it belongs to and the (convex) polygon that bounds it. */
export interface VoronoiCell {
  site: number
  polygon: Point[]
}
