// A Kripke structure — the model an LTL property is checked against. It is a finite directed graph of
// "states of the world", each labelled with the atomic propositions that hold there, plus a set of
// initial states. Its *behaviours* are the infinite paths from an initial state, and each path spells
// out an ω-word (the sequence of label-sets) that an LTL formula either accepts or rejects.
//
// The DSL is line-oriented and forgiving, in the spirit of the Turing-machine table parser:
//
//   # comments after '#' or '//'
//   init: s0                 # the initial state(s); defaults to the first declared state
//   s0 { }      -> s0 s1     # state s0, no propositions true, edges to s0 and s1
//   s1 { req }  -> s2        # in s1, 'req' holds
//   s2 { ack }  -> s0        # braces may use spaces or commas: { p, q } or { p q }
//
// A successor named on the right-hand side is auto-declared (with an empty label) if it never gets a
// line of its own. A state with no outgoing edge is a *deadlock*: no infinite path runs through it, so
// it cannot carry a behaviour — the parser flags these.

import type { GraphModel } from '../types'

export interface Kripke {
  states: { name: string; props: Set<string> }[]
  initial: number[]
  edges: number[][] // adjacency by state index
  atoms: string[] // every proposition mentioned, sorted
  deadlocks: number[] // states with no successors
}

export interface KError {
  line: number // 1-based
  message: string
}

export interface KParseResult {
  model?: Kripke
  errors: KError[]
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Strip a `#…` or `//…` comment and surrounding whitespace from a line. */
function stripComment(line: string): string {
  let s = line
  const h = s.indexOf('#')
  if (h >= 0) s = s.slice(0, h)
  const c = s.indexOf('//')
  if (c >= 0) s = s.slice(0, c)
  return s.trim()
}

/** Parse the contents of a `{ … }` label into a list of proposition names. */
function parseLabel(inside: string): string[] {
  return inside
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function parseKripke(src: string): KParseResult {
  const errors: KError[] = []
  const order: string[] = []
  const index = new Map<string, number>()
  const props = new Map<number, Set<string>>()
  const succ = new Map<number, Set<number>>()
  const initNames: string[] = []
  let sawInit = false

  const ensure = (name: string): number => {
    let id = index.get(name)
    if (id === undefined) {
      id = order.length
      index.set(name, id)
      order.push(name)
      props.set(id, new Set())
      succ.set(id, new Set())
    }
    return id
  }

  const lines = src.split('\n')
  lines.forEach((raw, li) => {
    const line = stripComment(raw)
    if (!line) return
    const lineNo = li + 1

    // init: directive
    const initMatch = /^init\s*:\s*(.*)$/i.exec(line)
    if (initMatch) {
      const names = initMatch[1].split(/[\s,]+/).filter((t) => t.length > 0)
      if (names.length === 0) errors.push({ line: lineNo, message: 'init: needs at least one state' })
      sawInit = true
      initNames.push(...names)
      return
    }

    // state line: NAME [ { props } ] [ -> succ... ]
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\{[^}]*\})?\s*(->|→)?\s*(.*)$/.exec(line)
    if (!m) {
      errors.push({ line: lineNo, message: `could not read “${line}”` })
      return
    }
    const name = m[1]
    const labelPart = m[2]
    const hasArrow = !!m[3]
    const targetsPart = m[4].trim()

    const id = ensure(name)
    if (labelPart) {
      const list = parseLabel(labelPart.slice(1, -1))
      props.set(id, new Set(list))
    }
    if (hasArrow) {
      const targets = targetsPart.split(/[\s,]+/).filter((t) => t.length > 0)
      if (targets.length === 0) {
        errors.push({ line: lineNo, message: `“${name} ->” has no successor states` })
      }
      for (const t of targets) {
        if (!IDENT.test(t)) {
          errors.push({ line: lineNo, message: `“${t}” is not a valid state name` })
          continue
        }
        succ.get(id)!.add(ensure(t))
      }
    } else if (targetsPart.length > 0) {
      errors.push({ line: lineNo, message: `unexpected “${targetsPart}” (did you mean “->”?)` })
    }
  })

  if (order.length === 0) {
    errors.push({ line: 0, message: 'no states defined' })
    return { errors }
  }

  // Resolve initial states.
  let initial: number[]
  if (sawInit && initNames.length) {
    initial = []
    for (const n of initNames) {
      const id = index.get(n)
      if (id === undefined) errors.push({ line: 0, message: `init: unknown state “${n}”` })
      else if (!initial.includes(id)) initial.push(id)
    }
    if (initial.length === 0) initial = [0]
  } else {
    initial = [0]
  }

  const allProps = new Set<string>()
  for (const set of props.values()) for (const p of set) allProps.add(p)

  const states = order.map((name, i) => ({ name, props: props.get(i)! }))
  const edges = order.map((_, i) => [...succ.get(i)!].sort((a, b) => a - b))
  const deadlocks = order.map((_, i) => i).filter((i) => edges[i].length === 0)

  return {
    model: {
      states,
      initial,
      edges,
      atoms: [...allProps].sort(),
      deadlocks,
    },
    errors,
  }
}

/** Pretty-print a state's label set: ∅ when empty, else the propositions joined by commas. */
export function showProps(p: Set<string>): string {
  if (p.size === 0) return '∅'
  return [...p].sort().join(', ')
}

/** Project a Kripke structure onto the shared graph model (name + label shown under each node). */
export function kripkeToGraph(m: Kripke): GraphModel {
  const edges: { from: number; to: number; label: string }[] = []
  m.edges.forEach((succ, i) => {
    for (const t of succ) edges.push({ from: i, to: t, label: '' })
  })
  return {
    numStates: m.states.length,
    start: m.initial[0] ?? 0,
    initial: m.initial.slice(),
    accepting: new Set(), // a Kripke structure has no acceptance condition
    edges,
    stateSub: m.states.map((s) => `${s.name} ⊨ ${showProps(s.props)}`),
  }
}
