// The data model for TIMED AUTOMATA (Alur–Dill, 1994) — a finite automaton
// equipped with real-valued CLOCKS. Every clock advances at rate 1 as time
// elapses; a transition may test a clock against an integer constant (a GUARD)
// and reset some clocks to 0; a location may carry an INVARIANT that bounds how
// long control may dwell there. The reachable state space is *infinite* (a clock
// ranges over ℝ≥0), yet — this is Alur–Dill's theorem — it collapses to a finite
// quotient: the REGION automaton. This module keeps the model diagonal-free
// (constraints compare one clock to a constant, `x ~ c`), which is exactly the
// fragment for which the classic region construction is defined.

/** A comparison operator in a clock constraint. */
export type CmpOp = '<' | '<=' | '=' | '>=' | '>'

/** An atomic clock constraint `x ~ c` with an integer constant `c ≥ 0`. */
export interface Atom {
  clock: string
  op: CmpOp
  bound: number
}

/**
 * A clock constraint is a CONJUNCTION of atoms (a convex zone). The empty
 * conjunction is `true`. We deliberately exclude diagonal constraints
 * (`x − y ~ c`) so the region equivalence is the standard one.
 */
export type Constraint = Atom[]

/** A discrete edge: `from --( guard, action, {resets} )--> to`. */
export interface Edge {
  from: string
  to: string
  guard: Constraint
  /** the observable letter/action (may be empty for an internal step) */
  action: string
  /** clocks reset to 0 when the edge is taken */
  resets: string[]
}

/** A control location (a discrete state) with a dwell INVARIANT. */
export interface Location {
  name: string
  /** must hold for the whole time control rests here (typically upper bounds) */
  invariant: Constraint
  /** accepting for the timed-language reading (optional, unused by reachability) */
  accepting?: boolean
}

/** A timed automaton: clocks, locations, edges, and a designated initial location. */
export interface TimedAutomaton {
  clocks: string[]
  locations: Location[]
  edges: Edge[]
  initial: string
}

/** A concrete clock valuation: one non-negative real per clock (indexed like `clocks`). */
export type Valuation = number[]

/** Look up a location by name (throws on an unknown name — the parser guarantees these exist). */
export function locByName(ta: TimedAutomaton, name: string): Location {
  const l = ta.locations.find((x) => x.name === name)
  if (!l) throw new Error(`unknown location: ${name}`)
  return l
}

/** The index of a clock in the canonical clock ordering. */
export function clockIndex(ta: TimedAutomaton, name: string): number {
  const i = ta.clocks.indexOf(name)
  if (i < 0) throw new Error(`unknown clock: ${name}`)
  return i
}

/**
 * The maximal constant each clock is compared against anywhere in the automaton
 * (guards and invariants). A clock never compared gets 0. These bounds `M(x)`
 * drive both the region construction (how far the integer part matters) and the
 * zone extrapolation (which keeps forward reachability finite).
 */
export function maxConstants(ta: TimedAutomaton): number[] {
  const m = ta.clocks.map(() => 0)
  const scan = (c: Constraint) => {
    for (const a of c) {
      const i = ta.clocks.indexOf(a.clock)
      if (i >= 0 && a.bound > m[i]) m[i] = a.bound
    }
  }
  for (const l of ta.locations) scan(l.invariant)
  for (const e of ta.edges) scan(e.guard)
  return m
}

/** Render a constraint as readable text, e.g. `x<=5 ∧ y>2`. `⊤` for the empty (always-true) conjunction. */
export function showConstraint(c: Constraint): string {
  if (c.length === 0) return '⊤'
  return c.map((a) => `${a.clock}${a.op}${a.bound}`).join(' ∧ ')
}

/** Does a concrete valuation satisfy an atom? */
export function satAtom(v: Valuation, idx: number, a: Atom): boolean {
  const x = v[idx]
  switch (a.op) {
    case '<':
      return x < a.bound
    case '<=':
      return x <= a.bound
    case '=':
      return x === a.bound
    case '>=':
      return x >= a.bound
    case '>':
      return x > a.bound
  }
}

/** Does a concrete valuation satisfy a whole constraint (conjunction)? */
export function satConstraint(ta: TimedAutomaton, v: Valuation, c: Constraint): boolean {
  for (const a of c) {
    const i = clockIndex(ta, a.clock)
    if (!satAtom(v, i, a)) return false
  }
  return true
}
