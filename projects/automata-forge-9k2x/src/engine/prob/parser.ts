// A small, forgiving textual syntax for Markov models, so every chain in the lab is a shareable link
// (the URL hash carries this source, exactly like the timed-automata mode). It is deliberately close
// to how you'd sketch a chain on a whiteboard:
//
//   dtmc
//   init s0
//   s0 -> 1/2: s1, 1/2: s2        # a DTMC state: one distribution
//   s1 -> 1: s1
//   label goal = s1               # name an atomic proposition over a set of states
//
// MDPs add an action tag between the arrows:
//
//   mdp
//   s0 -go->   9/10: goal, 1/10: bad
//   s0 -stay-> 1/2: s0, 1/2: goal
//
// States are created on first mention; probabilities may be integers, fractions, or decimals (each
// read as an EXACT rational). Parsing collects every error rather than throwing on the first.

import type { Model, DTMC, MDP, Dist, Action, Vec2 } from './types.ts'
import { parseFrac, ftoStr } from './frac.ts'

export interface ParseResult {
  model: Model | null
  errors: string[]
}

interface RawTrans {
  src: string
  action: string | null
  line: number
  entries: { prob: string; dst: string }[]
}

// A transition line: `src -> …` (DTMC / anonymous action) or `src -act-> …` (named MDP action).
const TRANS_RE = /^(\w+)\s*-(?:(\w+)-)?>\s*(.+)$/

/** Parse the textual source into a Model (or collect errors). */
export function parseModel(src: string): ParseResult {
  const errors: string[] = []
  const lines = src.split('\n')
  let kind: 'dtmc' | 'mdp' = 'dtmc'
  let kindSeen = false
  let initName: string | null = null
  const order: string[] = []
  const idx = new Map<string, number>()
  const props = new Map<string, Set<string>>() // prop -> set of state names
  const raws: RawTrans[] = []

  const ensure = (name: string) => {
    if (!idx.has(name)) {
      idx.set(name, order.length)
      order.push(name)
    }
  }

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li]
    const hash = line.indexOf('#')
    if (hash >= 0) line = line.slice(0, hash)
    line = line.trim()
    if (line === '') continue

    const lower = line.toLowerCase()
    if (lower === 'dtmc' || lower === 'mdp') {
      kind = lower as 'dtmc' | 'mdp'
      kindSeen = true
      continue
    }
    if (lower.startsWith('init ')) {
      initName = line.slice(5).trim()
      ensure(initName)
      continue
    }
    if (lower.startsWith('label ')) {
      const rest = line.slice(6).trim()
      const eq = rest.search(/[:=]/)
      if (eq < 0) {
        errors.push(`line ${li + 1}: label needs '=' (label goal = s1 s2)`)
        continue
      }
      const name = rest.slice(0, eq).trim()
      const states = rest
        .slice(eq + 1)
        .split(/[\s,]+/)
        .filter(Boolean)
      if (!name) {
        errors.push(`line ${li + 1}: label with no name`)
        continue
      }
      const set = props.get(name) ?? new Set<string>()
      for (const s of states) {
        ensure(s)
        set.add(s)
      }
      props.set(name, set)
      continue
    }
    if (lower.startsWith('state ')) {
      // state NAME { p q }
      const m = /^state\s+(\w+)\s*\{([^}]*)\}\s*$/i.exec(line)
      if (!m) {
        errors.push(`line ${li + 1}: bad 'state' line (state NAME { prop … })`)
        continue
      }
      ensure(m[1])
      for (const p of m[2].split(/[\s,]+/).filter(Boolean)) {
        const set = props.get(p) ?? new Set<string>()
        set.add(m[1])
        props.set(p, set)
      }
      continue
    }

    const tm = TRANS_RE.exec(line)
    if (!tm) {
      errors.push(`line ${li + 1}: not a transition or directive: "${line}"`)
      continue
    }
    const src = tm[1]
    const action = tm[2] ?? null
    ensure(src)
    const entries: { prob: string; dst: string }[] = []
    for (const part of tm[3].split(',')) {
      const seg = part.trim()
      if (seg === '') continue
      const colon = seg.indexOf(':')
      if (colon < 0) {
        errors.push(`line ${li + 1}: transition "${seg}" needs a ':' (prob: state)`)
        continue
      }
      const prob = seg.slice(0, colon).trim()
      const dst = seg.slice(colon + 1).trim()
      ensure(dst)
      entries.push({ prob, dst })
    }
    raws.push({ src, action, line: li + 1, entries })
  }

  if (order.length === 0) {
    errors.push('no states declared')
    return { model: null, errors }
  }
  if (!kindSeen && raws.some((r) => r.action !== null)) kind = 'mdp'

  const n = order.length
  const init = initName ? (idx.get(initName) ?? 0) : 0
  const label: Set<string>[] = Array.from({ length: n }, () => new Set<string>())
  const propNames = [...props.keys()].sort()
  for (const [p, set] of props) for (const s of set) label[idx.get(s)!].add(p)

  const pos = layoutPositions(order, raws, idx)

  const toDist = (entries: { prob: string; dst: string }[], where: string): Dist => {
    const d: Dist = []
    for (const e of entries) {
      const p = parseFrac(e.prob)
      if (!p) {
        errors.push(`${where}: bad probability "${e.prob}"`)
        continue
      }
      d.push({ to: idx.get(e.dst)!, p })
    }
    return d
  }

  if (kind === 'dtmc') {
    const trans: Dist[] = Array.from({ length: n }, () => [])
    const seen = new Set<number>()
    for (const r of raws) {
      const s = idx.get(r.src)!
      if (seen.has(s)) errors.push(`line ${r.line}: state ${r.src} already has a distribution (a DTMC state has exactly one)`)
      seen.add(s)
      trans[s] = toDist(r.entries, `line ${r.line}`)
    }
    for (let s = 0; s < n; s++) if (trans[s].length === 0) trans[s] = [{ to: s, p: parseFrac('1')! }] // absorbing default
    const model: DTMC = { kind: 'dtmc', n, labels: order, init, props: propNames, label, trans, pos }
    return { model, errors }
  }

  // MDP: group transition lines per state into actions.
  const actions: Action[][] = Array.from({ length: n }, () => [])
  const autoCount = new Array<number>(n).fill(0)
  for (const r of raws) {
    const s = idx.get(r.src)!
    const name = r.action ?? `a${autoCount[s]++}`
    actions[s].push({ name, dist: toDist(r.entries, `line ${r.line}`) })
  }
  for (let s = 0; s < n; s++) if (actions[s].length === 0) actions[s] = [{ name: 'stay', dist: [{ to: s, p: parseFrac('1')! }] }]
  const model: MDP = { kind: 'mdp', n, labels: order, init, props: propNames, label, actions, pos }
  return { model, errors }
}

/** A quick deterministic layout: BFS ranks from init spread left→right, siblings stacked vertically. */
function layoutPositions(order: string[], raws: RawTrans[], idx: Map<string, number>): Vec2[] {
  const n = order.length
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const r of raws) {
    const s = idx.get(r.src)!
    for (const e of r.entries) {
      const t = idx.get(e.dst)
      if (t !== undefined && t !== s) adj[s].push(t)
    }
  }
  const rank = new Array<number>(n).fill(-1)
  const q = [0]
  rank[0] = 0
  while (q.length) {
    const v = q.shift() as number
    for (const w of adj[v]) if (rank[w] === -1) {
      rank[w] = rank[v] + 1
      q.push(w)
    }
  }
  let maxRank = 0
  for (let s = 0; s < n; s++) {
    if (rank[s] === -1) rank[s] = 0
    if (rank[s] > maxRank) maxRank = rank[s]
  }
  const byRank: number[][] = Array.from({ length: maxRank + 1 }, () => [])
  for (let s = 0; s < n; s++) byRank[rank[s]].push(s)
  const pos: Vec2[] = new Array(n)
  const cols = maxRank + 1
  for (let r = 0; r <= maxRank; r++) {
    const col = byRank[r]
    const x = cols === 1 ? 50 : 10 + (80 * r) / maxRank
    for (let i = 0; i < col.length; i++) {
      const y = col.length === 1 ? 50 : 12 + (76 * i) / (col.length - 1)
      pos[col[i]] = { x, y }
    }
  }
  return pos
}

/** Serialize a model back to the textual source (used for round-trip tests and normalisation). */
export function serializeModel(m: Model): string {
  const out: string[] = [m.kind]
  out.push(`init ${m.labels[m.init]}`)
  if (m.kind === 'dtmc') {
    for (let s = 0; s < m.n; s++) {
      const d = m.trans[s].map((e) => `${ftoStr(e.p)}: ${m.labels[e.to]}`).join(', ')
      out.push(`${m.labels[s]} -> ${d}`)
    }
  } else {
    for (let s = 0; s < m.n; s++) {
      for (const a of m.actions[s]) {
        const d = a.dist.map((e) => `${ftoStr(e.p)}: ${m.labels[e.to]}`).join(', ')
        out.push(`${m.labels[s]} -${a.name}-> ${d}`)
      }
    }
  }
  for (const p of m.props) {
    const states = m.labels.filter((_, s) => m.label[s].has(p))
    if (states.length) out.push(`label ${p} = ${states.join(' ')}`)
  }
  return out.join('\n')
}
