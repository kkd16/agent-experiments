// Small graph utilities shared by the propagators: Tarjan's strongly-connected
// components (iterative, so deep graphs never blow the JS stack) and a Kuhn
// augmenting-path bipartite matcher. Both are used by Régin's domain-consistent
// all-different filter (see propagators.ts).

/**
 * Tarjan's SCC. `adj[u]` is the list of out-neighbours of node u. Returns
 * `comp` with `comp[u]` = the component id of u (ids are 0-based, dense).
 */
export function stronglyConnectedComponents(adj: readonly number[][]): number[] {
  const n = adj.length
  const index = new Int32Array(n).fill(-1)
  const low = new Int32Array(n)
  const onStack = new Uint8Array(n)
  const comp = new Int32Array(n).fill(-1)
  const stack: number[] = []
  let counter = 0
  let nComp = 0

  // Explicit work stack of frames {u, edge cursor} to avoid recursion.
  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue
    const callU: number[] = [s]
    const callI: number[] = [0]
    index[s] = low[s] = counter++
    stack.push(s)
    onStack[s] = 1
    while (callU.length > 0) {
      const u = callU[callU.length - 1]
      let i = callI[callU.length - 1]
      const nbrs = adj[u]
      let recursed = false
      while (i < nbrs.length) {
        const w = nbrs[i]
        i++
        if (index[w] === -1) {
          callI[callU.length - 1] = i
          index[w] = low[w] = counter++
          stack.push(w)
          onStack[w] = 1
          callU.push(w)
          callI.push(0)
          recursed = true
          break
        } else if (onStack[w]) {
          if (index[w] < low[u]) low[u] = index[w]
        }
      }
      if (recursed) continue
      callI[callU.length - 1] = i
      // Done exploring u's edges.
      if (low[u] === index[u]) {
        // u is a root: pop the component.
        for (;;) {
          const w = stack.pop()!
          onStack[w] = 0
          comp[w] = nComp
          if (w === u) break
        }
        nComp++
      }
      callU.pop()
      callI.pop()
      if (callU.length > 0) {
        const parent = callU[callU.length - 1]
        if (low[u] < low[parent]) low[parent] = low[u]
      }
    }
  }
  return Array.from(comp)
}

/**
 * Maximum bipartite matching by Kuhn's augmenting paths. `adjRight[i]` lists the
 * right-hand nodes reachable from left node i. Returns `matchLeft`
 * (matchLeft[i] = matched right node or -1) and `matchRight` (inverse). The
 * caller can read off the matching size by counting non-(-1) entries.
 */
export function bipartiteMatching(
  nLeft: number,
  nRight: number,
  adjRight: readonly number[][],
): { matchLeft: Int32Array; matchRight: Int32Array; size: number } {
  const matchLeft = new Int32Array(nLeft).fill(-1)
  const matchRight = new Int32Array(nRight).fill(-1)
  let size = 0

  const seen = new Uint8Array(nRight)
  // Recursive Kuhn augmenting path (depth ≤ nLeft, safe for studio-scale scopes).
  const augment = (u: number): boolean => {
    for (const r of adjRight[u]) {
      if (seen[r]) continue
      seen[r] = 1
      if (matchRight[r] === -1 || augment(matchRight[r])) {
        matchRight[r] = u
        matchLeft[u] = r
        return true
      }
    }
    return false
  }

  for (let i = 0; i < nLeft; i++) {
    seen.fill(0)
    if (augment(i)) size++
  }
  return { matchLeft, matchRight, size }
}
