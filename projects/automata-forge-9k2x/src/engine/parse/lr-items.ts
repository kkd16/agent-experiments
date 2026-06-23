// The canonical LR automata — the characteristic finite-state machine of "viable prefixes" that
// every bottom-up parser walks. Three flavours, built from the same closure/goto skeleton:
//
//   • LR(0): items are `A -> α • β` (a production with a dot). No lookahead.
//   • LR(1): items carry one terminal of lookahead, `[A -> α • β, a]`, computed via FIRST(βa).
//   • LALR(1): build the LR(1) automaton, then fuse states whose LR(0) **core** is identical,
//     unioning their lookaheads. Same number of states as LR(0); almost the power of LR(1).
//
// A "state" is a set of items (closed under closure). The canonical collection is the reachable set
// of states under `goto`, discovered by a worklist BFS from the closure of the augmented start item.

import { firstOfSeq } from '../cfg/analyze'
import { firstFollow } from '../cfg/analyze'
import type { AugGrammar } from './augment'

const END = '$'

/** An LR(0) item: a position (`dot`) inside production `prod` of the augmented grammar. */
export interface Item {
  prod: number
  dot: number
}

/** An item with its lookahead set (LR(1)). The `core` is `prod:dot`. */
export interface LItem {
  prod: number
  dot: number
  la: Set<string>
}

export interface LrState {
  id: number
  /** Items in a stable order; lookaheads present for LR(1)/LALR states (empty for LR(0)). */
  items: LItem[]
  /** The symbol read to *enter* this state (undefined for the start state) — for diagrams. */
  entry?: string
}

export interface LrAutomaton {
  aug: AugGrammar
  states: LrState[]
  /** `goto[stateId]` maps a grammar symbol to the successor state id. */
  goto: Map<number, Map<string, number>>
  kind: 'LR0' | 'LR1' | 'LALR1'
}

// ---------------------------------------------------------------------------
// LR(0)
// ---------------------------------------------------------------------------

/** ε-style closure of an LR(0) item set: pull in `B -> • γ` for every `A -> α • B β`. */
function closure0(aug: AugGrammar, seed: Item[]): Item[] {
  const have = new Set<string>()
  const out: Item[] = []
  const push = (it: Item) => {
    const k = `${it.prod}:${it.dot}`
    if (!have.has(k)) {
      have.add(k)
      out.push(it)
    }
  }
  seed.forEach(push)
  for (let i = 0; i < out.length; i++) {
    const it = out[i]
    const body = aug.prods[it.prod].rhs
    const B = body[it.dot]
    if (B !== undefined && aug.nt.has(B)) {
      aug.prods.forEach((p, pi) => {
        if (p.lhs === B) push({ prod: pi, dot: 0 })
      })
    }
  }
  return out
}

/** Symbols appearing immediately after the dot in any item (the legal `goto` moves). */
function movesOf(aug: AugGrammar, items: Item[]): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const it of items) {
    const sym = aug.prods[it.prod].rhs[it.dot]
    if (sym !== undefined && !seen.has(sym)) {
      seen.add(sym)
      order.push(sym)
    }
  }
  return order
}

/** Advance the dot over `X` in every item that can, then close. */
function goto0(aug: AugGrammar, items: Item[], X: string): Item[] {
  const moved: Item[] = []
  for (const it of items) {
    if (aug.prods[it.prod].rhs[it.dot] === X) moved.push({ prod: it.prod, dot: it.dot + 1 })
  }
  return moved.length ? closure0(aug, moved) : []
}

const core0Key = (items: Item[]): string =>
  items
    .map((it) => `${it.prod}:${it.dot}`)
    .sort()
    .join('|')

/** Build the canonical LR(0) automaton. */
export function buildLr0(aug: AugGrammar): LrAutomaton {
  const startItems = closure0(aug, [{ prod: 0, dot: 0 }])
  const states: Item[][] = [startItems]
  const keyToId = new Map<string, number>([[core0Key(startItems), 0]])
  const entry: (string | undefined)[] = [undefined]
  const goto = new Map<number, Map<string, number>>()

  for (let i = 0; i < states.length; i++) {
    const here = states[i]
    const gmap = new Map<string, number>()
    for (const X of movesOf(aug, here)) {
      const next = goto0(aug, here, X)
      if (next.length === 0) continue
      const k = core0Key(next)
      let id = keyToId.get(k)
      if (id === undefined) {
        id = states.length
        states.push(next)
        keyToId.set(k, id)
        entry.push(X)
      }
      gmap.set(X, id)
    }
    goto.set(i, gmap)
  }

  const lrStates: LrState[] = states.map((items, id) => ({
    id,
    entry: entry[id],
    items: items.map((it) => ({ prod: it.prod, dot: it.dot, la: new Set<string>() })),
  }))
  return { aug, states: lrStates, goto, kind: 'LR0' }
}

// ---------------------------------------------------------------------------
// LR(1)
// ---------------------------------------------------------------------------

/** Closure of an LR(1) item set, merging lookaheads per `prod:dot` core. */
function closure1(aug: AugGrammar, first: Map<string, Set<string>>, seed: LItem[]): LItem[] {
  const byCore = new Map<string, LItem>()
  const order: string[] = []
  const merge = (prod: number, dot: number, la: Iterable<string>): boolean => {
    const k = `${prod}:${dot}`
    let it = byCore.get(k)
    if (!it) {
      it = { prod, dot, la: new Set() }
      byCore.set(k, it)
      order.push(k)
    }
    let changed = false
    for (const a of la) if (!it.la.has(a)) { it.la.add(a); changed = true }
    return changed
  }
  for (const s of seed) merge(s.prod, s.dot, s.la)

  let changed = true
  while (changed) {
    changed = false
    for (const k of order) {
      const it = byCore.get(k)!
      const body = aug.prods[it.prod].rhs
      const B = body[it.dot]
      if (B === undefined || !aug.nt.has(B)) continue
      const beta = body.slice(it.dot + 1)
      // lookahead of the generated B-items = FIRST(β a) for each a in current lookahead.
      for (const a of it.la) {
        const look = firstOfSeq([...beta, a], first, aug.nt)
        const las: string[] = []
        for (const x of look) las.push(x === '' ? a : x) // ε in FIRST(β) ⇒ a passes through
        aug.prods.forEach((p, pi) => {
          if (p.lhs === B) {
            if (merge(pi, 0, las)) changed = true
          }
        })
      }
    }
  }
  return order.map((k) => byCore.get(k)!)
}

function goto1(aug: AugGrammar, first: Map<string, Set<string>>, items: LItem[], X: string): LItem[] {
  const moved: LItem[] = []
  for (const it of items) {
    if (aug.prods[it.prod].rhs[it.dot] === X) moved.push({ prod: it.prod, dot: it.dot + 1, la: new Set(it.la) })
  }
  return moved.length ? closure1(aug, first, moved) : []
}

/** Canonical key including lookaheads (distinguishes LR(1) states with the same core). */
function full1Key(items: LItem[]): string {
  return items
    .map((it) => `${it.prod}:${it.dot}:${[...it.la].sort().join(',')}`)
    .sort()
    .join('|')
}

/** Build the canonical LR(1) automaton. */
export function buildLr1(aug: AugGrammar): LrAutomaton {
  const { first } = firstFollow(aug.g)
  const start = closure1(aug, first, [{ prod: 0, dot: 0, la: new Set([END]) }])
  const states: LItem[][] = [start]
  const keyToId = new Map<string, number>([[full1Key(start), 0]])
  const entry: (string | undefined)[] = [undefined]
  const goto = new Map<number, Map<string, number>>()

  for (let i = 0; i < states.length; i++) {
    const here = states[i]
    const gmap = new Map<string, number>()
    for (const X of movesOf(aug, here)) {
      const next = goto1(aug, first, here, X)
      if (next.length === 0) continue
      const k = full1Key(next)
      let id = keyToId.get(k)
      if (id === undefined) {
        id = states.length
        states.push(next)
        keyToId.set(k, id)
        entry.push(X)
      }
      gmap.set(X, id)
    }
    goto.set(i, gmap)
  }

  const lrStates: LrState[] = states.map((items, id) => ({ id, entry: entry[id], items }))
  return { aug, states: lrStates, goto, kind: 'LR1' }
}

// ---------------------------------------------------------------------------
// LALR(1) — merge LR(1) states sharing an LR(0) core.
// ---------------------------------------------------------------------------

const coreOfState = (st: LrState): string =>
  st.items
    .map((it) => `${it.prod}:${it.dot}`)
    .sort()
    .join('|')

/** Build the LALR(1) automaton by fusing LR(1) states with identical cores. */
export function buildLalr1(aug: AugGrammar): LrAutomaton {
  const lr1 = buildLr1(aug)

  // Group LR(1) states by core; each group becomes one merged state.
  const coreToMerged = new Map<string, number>()
  const oldToMerged = new Map<number, number>()
  const mergedCores: string[] = []
  for (const st of lr1.states) {
    const c = coreOfState(st)
    let m = coreToMerged.get(c)
    if (m === undefined) {
      m = mergedCores.length
      coreToMerged.set(c, m)
      mergedCores.push(c)
    }
    oldToMerged.set(st.id, m)
  }

  // Union the lookaheads of all LR(1) states folded into each merged state.
  const merged: LrState[] = mergedCores.map((_, id) => ({ id, items: [] as LItem[], entry: undefined as string | undefined }))
  for (const st of lr1.states) {
    const m = oldToMerged.get(st.id)!
    const tgt = merged[m]
    if (tgt.entry === undefined) tgt.entry = st.entry
    if (tgt.items.length === 0) {
      tgt.items = st.items.map((it) => ({ prod: it.prod, dot: it.dot, la: new Set(it.la) }))
    } else {
      // Same core ⇒ same item ordering by core; union lookaheads pairwise by core key.
      const byCore = new Map(tgt.items.map((it) => [`${it.prod}:${it.dot}`, it]))
      for (const it of st.items) {
        const dst = byCore.get(`${it.prod}:${it.dot}`)
        if (dst) for (const a of it.la) dst.la.add(a)
      }
    }
  }

  // Remap transitions (consistent because same-core states goto same-core states).
  const goto = new Map<number, Map<string, number>>()
  for (const st of lr1.states) {
    const m = oldToMerged.get(st.id)!
    if (!goto.has(m)) goto.set(m, new Map())
    const gmap = goto.get(m)!
    for (const [X, to] of lr1.goto.get(st.id) ?? []) {
      gmap.set(X, oldToMerged.get(to)!)
    }
  }

  return { aug, states: merged, goto, kind: 'LALR1' }
}

/** Render an item `A -> α • β  ,  {la}` for the UI (lookahead omitted for LR(0)). */
export function showItem(aug: AugGrammar, it: LItem, withLa: boolean): string {
  const p = aug.prods[it.prod]
  const body = [...p.rhs]
  body.splice(it.dot, 0, '•')
  const core = `${p.lhs} → ${body.join(' ').trim() || '•'}`
  if (!withLa || it.la.size === 0) return core
  return `${core} , ${[...it.la].map((x) => (x === END ? '$' : x)).join('/')}`
}
