// A small, forgiving textual syntax for timed automata, so any machine is an
// editable, shareable string. Grammar (one statement per line, `#` comments):
//
//   clocks x, y                     -- declare the clocks
//   init off                        -- the initial location
//   loc off                         -- a location …
//   loc on inv x<=10 accepting      -- … with an invariant and/or accepting flag
//   off -> on if x>=2 do x act press-- an edge: guard / resets / action, any order
//
// Constraints are conjunctions written without spaces, joined by `&`, each atom
// `clock (<=|>=|<|>|=) integer` — e.g. `x<=10&y>2`. Resets are a comma list of
// clock names. Everything is optional except the two endpoints of an edge.

import type { Atom, CmpOp, Constraint, Edge, Location, TimedAutomaton } from './types'

export interface ParseOk {
  ok: true
  ta: TimedAutomaton
}
export interface ParseErr {
  ok: false
  message: string
  line: number
}
export type ParseResult = ParseOk | ParseErr

const ATOM_RE = /^([A-Za-z_][A-Za-z0-9_]*)(<=|>=|<|>|=)(\d+)$/

function parseConstraint(s: string, line: number): Constraint {
  const t = s.trim()
  if (t === '' || t === '⊤' || t.toLowerCase() === 'true') return []
  const atoms: Atom[] = []
  for (const part of t.split(/&|∧/)) {
    const p = part.trim()
    if (p === '') continue
    const mm = ATOM_RE.exec(p)
    if (!mm) throw new LineError(`bad constraint atom "${p}" (want e.g. x<=10)`, line)
    atoms.push({ clock: mm[1], op: mm[2] as CmpOp, bound: parseInt(mm[3], 10) })
  }
  return atoms
}

class LineError extends Error {
  line: number
  constructor(msg: string, line: number) {
    super(msg)
    this.line = line
  }
}

export function parseTimedAutomaton(src: string): ParseResult {
  const lines = src.split('\n')
  let clocks: string[] = []
  const locations: Location[] = []
  const edges: Edge[] = []
  let initial = ''
  const locNames = new Set<string>()

  try {
    lines.forEach((raw, idx) => {
      const line = idx + 1
      const noComment = raw.replace(/#.*$/, '')
      const s = noComment.trim()
      if (s === '') return
      const tok = s.split(/\s+/)

      if (tok[0] === 'clocks') {
        clocks = s
          .slice(s.indexOf('clocks') + 6)
          .split(/[,\s]+/)
          .map((x) => x.trim())
          .filter((x) => x !== '')
        for (const c of clocks)
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c)) throw new LineError(`bad clock name "${c}"`, line)
        return
      }
      if (tok[0] === 'init') {
        if (!tok[1]) throw new LineError('init needs a location name', line)
        initial = tok[1]
        return
      }
      if (tok[0] === 'loc') {
        if (!tok[1]) throw new LineError('loc needs a name', line)
        const name = tok[1]
        let invariant: Constraint = []
        let accepting = false
        for (let i = 2; i < tok.length; i++) {
          if (tok[i] === 'inv') {
            invariant = parseConstraint(tok[i + 1] ?? '', line)
            i++
          } else if (tok[i] === 'accepting' || tok[i] === 'accept') {
            accepting = true
          } else {
            throw new LineError(`unexpected "${tok[i]}" in loc`, line)
          }
        }
        if (locNames.has(name)) throw new LineError(`duplicate location "${name}"`, line)
        locNames.add(name)
        locations.push({ name, invariant, accepting })
        return
      }

      // an edge:  FROM -> TO [if G] [do R] [act A]
      const arrow = tok.indexOf('->')
      if (arrow === 1 && tok.length >= 3) {
        const from = tok[0]
        const to = tok[2]
        let guard: Constraint = []
        let resets: string[] = []
        let action = ''
        for (let i = 3; i < tok.length; i++) {
          if (tok[i] === 'if' || tok[i] === 'when') {
            guard = parseConstraint(tok[i + 1] ?? '', line)
            i++
          } else if (tok[i] === 'do' || tok[i] === 'reset') {
            resets = (tok[i + 1] ?? '')
              .split(',')
              .map((x) => x.trim())
              .filter((x) => x !== '')
            i++
          } else if (tok[i] === 'act' || tok[i] === 'on') {
            action = tok[i + 1] ?? ''
            i++
          } else {
            throw new LineError(`unexpected "${tok[i]}" in edge`, line)
          }
        }
        edges.push({ from, to, guard, resets, action })
        return
      }

      throw new LineError(`cannot parse line`, line)
    })

    if (clocks.length === 0) clocks = []
    if (locations.length === 0) throw new LineError('no locations declared', lines.length)
    if (initial === '') initial = locations[0].name
    if (!locNames.has(initial)) throw new LineError(`initial location "${initial}" is not declared`, 1)

    // referential integrity
    const allClocks = new Set(clocks)
    for (const l of locations)
      for (const a of l.invariant)
        if (!allClocks.has(a.clock)) throw new LineError(`invariant of "${l.name}" uses undeclared clock "${a.clock}"`, 1)
    for (const e of edges) {
      if (!locNames.has(e.from)) throw new LineError(`edge from undeclared location "${e.from}"`, 1)
      if (!locNames.has(e.to)) throw new LineError(`edge to undeclared location "${e.to}"`, 1)
      for (const a of e.guard)
        if (!allClocks.has(a.clock)) throw new LineError(`guard uses undeclared clock "${a.clock}"`, 1)
      for (const c of e.resets) if (!allClocks.has(c)) throw new LineError(`reset of undeclared clock "${c}"`, 1)
    }

    return { ok: true, ta: { clocks, locations, edges, initial } }
  } catch (err) {
    if (err instanceof LineError) return { ok: false, message: err.message, line: err.line }
    return { ok: false, message: (err as Error).message, line: 1 }
  }
}

/** Render a timed automaton back to source text (round-trips through the parser). */
export function showTimedAutomaton(ta: TimedAutomaton): string {
  const out: string[] = []
  if (ta.clocks.length) out.push(`clocks ${ta.clocks.join(', ')}`)
  out.push(`init ${ta.initial}`)
  out.push('')
  for (const l of ta.locations) {
    let s = `loc ${l.name}`
    if (l.invariant.length) s += ` inv ${l.invariant.map((a) => `${a.clock}${a.op}${a.bound}`).join('&')}`
    if (l.accepting) s += ' accepting'
    out.push(s)
  }
  out.push('')
  for (const e of ta.edges) {
    let s = `${e.from} -> ${e.to}`
    if (e.guard.length) s += ` if ${e.guard.map((a) => `${a.clock}${a.op}${a.bound}`).join('&')}`
    if (e.resets.length) s += ` do ${e.resets.join(',')}`
    if (e.action) s += ` act ${e.action}`
    out.push(s)
  }
  return out.join('\n')
}
