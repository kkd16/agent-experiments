import type { Triangle } from './types'

// ── The Art Gallery theorem, made constructive ──────────────────────────────
//
// Chvátal's theorem: ⌊n/3⌋ guards always suffice (and are sometimes necessary)
// to see every point of a simple polygon with n vertices. Fisk's proof is an
// algorithm: triangulate the polygon, 3-colour the triangulation (always
// possible — the dual is a tree, so a DFS that gives each new triangle's apex the
// one colour its base doesn't use never conflicts), and station guards on the
// smallest colour class. Every triangle has one vertex of each colour, so it
// contains a guard, and a guard at a triangle's corner sees that whole triangle —
// therefore the chosen class covers the union of all triangles, i.e. the polygon.
// The smallest of three classes has ≤ ⌊n/3⌋ vertices, proving the bound.

export interface ThreeColoring {
  /** Colour ∈ {0,1,2} per vertex (−1 if the vertex is unused by any triangle). */
  colors: number[]
  /** The three colour classes as vertex-index lists. */
  classes: [number[], number[], number[]]
  /** The smallest class — a guard set of ≤ ⌊n/3⌋ vertices. */
  guards: number[]
  /** True if every triangle uses all three colours (a valid 3-colouring). */
  valid: boolean
}

const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`)

/** Triangle adjacency: which triangles share each undirected edge. */
export function triangleAdjacency(triangles: Triangle[]): Map<string, number[]> {
  const map = new Map<string, number[]>()
  triangles.forEach((t, i) => {
    for (const [a, b] of [
      [t.a, t.b],
      [t.b, t.c],
      [t.c, t.a],
    ] as const) {
      const k = edgeKey(a, b)
      const list = map.get(k)
      if (list) list.push(i)
      else map.set(k, [i])
    }
  })
  return map
}

/**
 * 3-colour a triangulated simple polygon by walking the dual tree. Returns the
 * colouring, the classes and the smallest class as the guard set.
 */
export function threeColorTriangulation(triangles: Triangle[], vertexCount: number): ThreeColoring {
  const colors = new Array<number>(vertexCount).fill(-1)
  const adj = triangleAdjacency(triangles)
  const visited = new Array<boolean>(triangles.length).fill(false)

  const triVerts = (t: Triangle) => [t.a, t.b, t.c]
  const neighbours = (i: number): number[] => {
    const t = triangles[i]
    const res: number[] = []
    for (const [a, b] of [
      [t.a, t.b],
      [t.b, t.c],
      [t.c, t.a],
    ] as const) {
      for (const j of adj.get(edgeKey(a, b)) ?? []) if (j !== i) res.push(j)
    }
    return res
  }

  // The triangulation of a hole-free polygon is connected; colour each component.
  for (let start = 0; start < triangles.length; start++) {
    if (visited[start]) continue
    // Seed this component with a fresh 0/1/2 triple.
    const s = triangles[start]
    colors[s.a] = 0
    colors[s.b] = 1
    colors[s.c] = 2
    visited[start] = true
    const stack = [start]
    while (stack.length) {
      const cur = stack.pop()!
      for (const nb of neighbours(cur)) {
        if (visited[nb]) continue
        visited[nb] = true
        const verts = triVerts(triangles[nb])
        const known = verts.filter((v) => colors[v] !== -1)
        const used = new Set(known.map((v) => colors[v]))
        for (const v of verts) {
          if (colors[v] === -1) {
            // The one colour its two already-coloured neighbours don't use.
            colors[v] = [0, 1, 2].find((c) => !used.has(c)) ?? 0
            used.add(colors[v])
          }
        }
        stack.push(nb)
      }
    }
  }

  const classes: [number[], number[], number[]] = [[], [], []]
  for (let v = 0; v < vertexCount; v++) if (colors[v] >= 0) classes[colors[v]].push(v)

  let valid = triangles.length > 0
  for (const t of triangles) {
    const set = new Set([colors[t.a], colors[t.b], colors[t.c]])
    if (set.size !== 3) valid = false
  }

  const guards = classes.reduce((a, b) => (b.length < a.length ? b : a))
  return { colors, classes, guards, valid }
}
