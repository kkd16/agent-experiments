// A Kripke structure: the finite-state model whose behaviours we check against
// an LTL specification. States carry a labelling L : S → 2^AP (the atoms true
// there); a run is an infinite path from an initial state, and its trace is the
// word L(s0) L(s1) L(s2) … over 2^AP.
//
// A tiny textual DSL drives the editor:
//
//   state s0 [req] init      # atoms in brackets are TRUE here; `init` marks a start state
//   state s1 [req, ack]
//   state s2 []
//   s0 -> s1
//   s1 -> s2, s0             # comma-separated targets are allowed
//   s2 -> s0
//
// `#` starts a line comment. Every state used must be declared. For LTL (a logic
// of infinite words) every state should have a successor; `deadlocks()` reports
// any that don't so the UI can warn.

export interface KState {
  id: number
  name: string
  /** Atoms TRUE in this state. */
  labels: string[]
}

export interface Kripke {
  states: KState[]
  /** Ids of initial states. */
  init: number[]
  /** Successor adjacency: edges[i] = ids reachable from state i. */
  edges: number[][]
  /** All atomic propositions mentioned anywhere (sorted, deduped). */
  aps: string[]
}

export class KripkeParseError extends Error {
  line: number
  constructor(message: string, line: number) {
    super(message)
    this.name = 'KripkeParseError'
    this.line = line
  }
}

/** Parse the Kripke DSL. Throws {@link KripkeParseError} on malformed input. */
export function parseKripke(src: string): Kripke {
  const lines = src.split('\n')
  const nameToId = new Map<string, number>()
  const states: KState[] = []
  const initNames = new Set<string>()
  const rawEdges: Array<[string, string]> = []

  const ensure = (name: string): number => {
    let id = nameToId.get(name)
    if (id === undefined) {
      id = states.length
      nameToId.set(name, id)
      states.push({ id, name, labels: [] })
    }
    return id
  }

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1
    const noComment = rawLine.replace(/#.*$/, '')
    const line = noComment.trim()
    if (line === '') return

    if (line.startsWith('state ') || line === 'state') {
      const rest = line.slice(5).trim()
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\[[^\]]*\])?\s*(init)?\s*$/.exec(rest)
      if (!m) throw new KripkeParseError(`Malformed state declaration: ${JSON.stringify(rawLine.trim())}`, lineNo)
      const name = m[1]
      const id = ensure(name)
      if (m[2]) {
        const inside = m[2].slice(1, -1)
        const labels = inside
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter((s) => s !== '')
        for (const l of labels) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(l)) throw new KripkeParseError(`Invalid proposition ${JSON.stringify(l)}`, lineNo)
        }
        states[id].labels = [...new Set(labels)].sort()
      }
      if (m[3] === 'init') initNames.add(name)
      return
    }

    if (line.includes('->')) {
      const [lhs, rhs] = line.split('->')
      const from = lhs.trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(from)) throw new KripkeParseError(`Invalid source state ${JSON.stringify(from)}`, lineNo)
      const targets = rhs
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      if (targets.length === 0) throw new KripkeParseError('Transition has no target', lineNo)
      for (const t of targets) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new KripkeParseError(`Invalid target state ${JSON.stringify(t)}`, lineNo)
        rawEdges.push([from, t])
      }
      return
    }

    throw new KripkeParseError(`Unrecognized line: ${JSON.stringify(rawLine.trim())}`, lineNo)
  })

  if (states.length === 0) throw new KripkeParseError('No states declared', 1)

  const edges: number[][] = states.map(() => [])
  for (const [from, to] of rawEdges) {
    const fi = ensure(from)
    const ti = ensure(to)
    // ensure() may have grown `states`; keep edges array in sync
    while (edges.length < states.length) edges.push([])
    if (!edges[fi].includes(ti)) edges[fi].push(ti)
  }
  for (let i = 0; i < edges.length; i++) edges[i].sort((a, b) => a - b)

  const init = [...initNames].map((n) => nameToId.get(n) as number)
  if (init.length === 0) throw new KripkeParseError('No initial state (mark one with `init`)', 1)

  const aps = [...new Set(states.flatMap((s) => s.labels))].sort()

  return { states, init: init.sort((a, b) => a - b), edges, aps }
}

/** State ids that have no outgoing transition (problematic for infinite runs). */
export function deadlocks(k: Kripke): number[] {
  const out: number[] = []
  for (const s of k.states) if (k.edges[s.id].length === 0) out.push(s.id)
  return out
}

/** Serialize a Kripke structure back to the DSL (used by generators/tests). */
export function printKripke(k: Kripke): string {
  const initSet = new Set(k.init)
  const lines: string[] = []
  for (const s of k.states) {
    const label = `[${s.labels.join(', ')}]`
    lines.push(`state ${s.name} ${label}${initSet.has(s.id) ? ' init' : ''}`)
  }
  for (const s of k.states) {
    const outs = k.edges[s.id]
    if (outs.length > 0) lines.push(`${s.name} -> ${outs.map((t) => k.states[t].name).join(', ')}`)
  }
  return lines.join('\n')
}
