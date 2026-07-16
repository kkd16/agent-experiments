// The protocol-independent **conflict-serializability oracle** — the ground
// truth every concurrency-control protocol is checked against.
//
// Given the global access log a run produced (every read/write that actually
// took effect, in execution order) and the set of transactions that *committed*,
// it builds the **conflict graph** (a.k.a. precedence / serialization graph):
//
//   • a node per committed transaction;
//   • an edge Ti → Tj whenever Ti accessed an item *before* Tj accessed the same
//     item and at least one of the two accesses is a write (r-w, w-r, w-w).
//
// A committed history is **conflict-serializable** iff this graph is acyclic
// (Papadimitriou 1979); a topological order of an acyclic graph is a serial
// schedule the history is conflict-equivalent to. This is exactly the property
// Strict 2PL, OCC and Basic T/O promise, so the oracle is what turns "the
// protocol looks right" into "the protocol is provably right on this schedule".

import type { Access } from './types'

export interface OracleResult {
  serializable: boolean
  /** a witnessing cycle of transaction labels (T1 → T2 → … → T1) when not */
  cycle: string[] | null
  /** an equivalent serial order (topological sort) when serializable */
  order: string[] | null
}

/**
 * Analyse a committed history for conflict-serializability.
 *
 * @param log       every access that took effect, in execution order
 * @param committed labels of the transactions that committed (only these count)
 */
export function analyzeHistory(log: Access[], committed: Set<string>): OracleResult {
  // Committed transactions, discovered in first-seen order for a stable result.
  const nodes: string[] = []
  const seen = new Set<string>()
  for (const a of log) {
    if (committed.has(a.txn) && !seen.has(a.txn)) {
      seen.add(a.txn)
      nodes.push(a.txn)
    }
  }

  const adj = new Map<string, Set<string>>()
  for (const n of nodes) adj.set(n, new Set())
  const addEdge = (from: string, to: string) => {
    if (from === to) return
    adj.get(from)!.add(to)
  }

  // Group the committed accesses by item, preserving execution order, then add a
  // conflict edge for every ordered pair on that item where at least one writes.
  const byItem = new Map<string, Access[]>()
  for (const a of log) {
    if (!committed.has(a.txn)) continue
    const list = byItem.get(a.item) ?? []
    list.push(a)
    byItem.set(a.item, list)
  }
  for (const accesses of byItem.values()) {
    // accesses are already in execution (seq) order within an item.
    for (let i = 0; i < accesses.length; i++) {
      for (let j = i + 1; j < accesses.length; j++) {
        const a = accesses[i]
        const b = accesses[j]
        if (a.txn === b.txn) continue
        if (a.kind === 'r' && b.kind === 'r') continue
        addEdge(a.txn, b.txn)
      }
    }
  }

  const cycle = findCycle(nodes, adj)
  if (cycle) return { serializable: false, cycle, order: null }
  return { serializable: true, cycle: null, order: topoOrder(nodes, adj) }
}

/** DFS three-colouring; returns the first back-edge cycle as a label path. */
function findCycle(nodes: string[], adj: Map<string, Set<string>>): string[] | null {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const n of nodes) color.set(n, WHITE)
  const stack: string[] = []
  let cycle: string[] | null = null

  const dfs = (u: string): boolean => {
    color.set(u, GRAY)
    stack.push(u)
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        const idx = stack.indexOf(v)
        cycle = stack.slice(idx)
        return true
      }
      if (color.get(v) === WHITE && dfs(v)) return true
    }
    stack.pop()
    color.set(u, BLACK)
    return false
  }

  for (const n of nodes) {
    if (color.get(n) === WHITE && dfs(n)) break
  }
  return cycle
}

/** Kahn's algorithm; ties broken by first-seen order for determinism. */
function topoOrder(nodes: string[], adj: Map<string, Set<string>>): string[] {
  const indeg = new Map<string, number>()
  for (const n of nodes) indeg.set(n, 0)
  for (const n of nodes) for (const v of adj.get(n) ?? []) indeg.set(v, (indeg.get(v) ?? 0) + 1)
  const order: string[] = []
  const ready = nodes.filter((n) => (indeg.get(n) ?? 0) === 0)
  while (ready.length) {
    const n = ready.shift()!
    order.push(n)
    for (const v of adj.get(n) ?? []) {
      const d = (indeg.get(v) ?? 0) - 1
      indeg.set(v, d)
      if (d === 0) ready.push(v)
    }
  }
  return order
}

/**
 * Replay a set of transactions **serially** in a given order over an initial
 * key/value state, returning the resulting rows. Used by the self-tests to prove
 * a serializable protocol's final state matches the serial order the oracle
 * derived — the strongest possible correctness check.
 */
export function replaySerial(
  order: string[],
  initial: { key: string; value: import('../concurrency/mvcc').Val }[],
  writesByTxn: Map<string, { key: string; value: import('../concurrency/mvcc').Val; deleted: boolean }[]>,
): { key: string; value: import('../concurrency/mvcc').Val }[] {
  const state = new Map<string, import('../concurrency/mvcc').Val>()
  for (const r of initial) state.set(r.key, r.value)
  for (const t of order) {
    for (const w of writesByTxn.get(t) ?? []) {
      if (w.deleted) state.delete(w.key)
      else state.set(w.key, w.value)
    }
  }
  return [...state.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
