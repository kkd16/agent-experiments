// The models this pillar reasons about: discrete-time Markov chains (DTMCs) and Markov decision
// processes (MDPs). A DTMC is a finite automaton where the *non-determinism is replaced by chance* —
// each state carries one probability distribution over successors. An MDP restores choice on top of
// chance: each state offers a menu of *actions*, and each action is a distribution. Probabilistic
// model checking asks quantitative questions about these ("what is the probability the protocol
// eventually delivers?", "can a scheduler keep the failure probability below 1%?").

import type { Frac } from './frac.ts'
import { F0, F1, fadd, feq, fisZero } from './frac.ts'

/** A probability distribution over states: a list of (successor, probability) with probabilities > 0. */
export type Dist = { to: number; p: Frac }[]

export interface Vec2 {
  x: number
  y: number
}

/** A named action of an MDP state: one label and the distribution it induces. */
export interface Action {
  name: string
  dist: Dist
}

export interface DTMC {
  kind: 'dtmc'
  n: number
  /** Human-readable state names, index-aligned. */
  labels: string[]
  /** The initial state. */
  init: number
  /** Atomic-proposition names, in declaration order (for a stable UI ordering). */
  props: string[]
  /** The set of atomic propositions true in each state. */
  label: Set<string>[]
  /** One outgoing distribution per state; `trans[s]` sums to exactly 1. */
  trans: Dist[]
  /** Layout positions in a 0..100 box (used by the renderer; not part of the semantics). */
  pos: Vec2[]
}

export interface MDP {
  kind: 'mdp'
  n: number
  labels: string[]
  init: number
  props: string[]
  label: Set<string>[]
  /** One menu of actions per state; every state has ≥ 1 action, each action's dist sums to 1. */
  actions: Action[][]
  pos: Vec2[]
}

export type Model = DTMC | MDP

// ---------------------------------------------------------------------------
// Validation — a model is only well-formed if every distribution is a real one.
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  where: string
  message: string
}

function checkDist(d: Dist, n: number, where: string, issues: ValidationIssue[]): void {
  if (d.length === 0) {
    issues.push({ where, message: 'no outgoing transitions (a chain must be stochastic — add a self-loop for an absorbing state)' })
    return
  }
  let sum = F0
  const seen = new Set<number>()
  for (const e of d) {
    if (e.to < 0 || e.to >= n) {
      issues.push({ where, message: `transition to out-of-range state ${e.to}` })
      continue
    }
    if (fisZero(e.p) || e.p.n < 0n) {
      issues.push({ where, message: `probability ${e.p.n}/${e.p.d} must be strictly positive` })
    }
    if (seen.has(e.to)) {
      issues.push({ where, message: `duplicate transition to ${e.to} (merge them)` })
    }
    seen.add(e.to)
    sum = fadd(sum, e.p)
  }
  if (!feq(sum, F1)) {
    issues.push({ where, message: `probabilities sum to ${sum.n}/${sum.d}, not 1` })
  }
}

/** Collect every way a model fails to be a well-formed Markov model (empty ⇒ valid). */
export function validate(m: Model): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (m.n <= 0) issues.push({ where: 'model', message: 'no states' })
  if (m.init < 0 || m.init >= m.n) issues.push({ where: 'model', message: `init state ${m.init} out of range` })
  if (m.kind === 'dtmc') {
    for (let s = 0; s < m.n; s++) checkDist(m.trans[s] ?? [], m.n, m.labels[s] ?? `s${s}`, issues)
  } else {
    for (let s = 0; s < m.n; s++) {
      const menu = m.actions[s] ?? []
      if (menu.length === 0) {
        issues.push({ where: m.labels[s] ?? `s${s}`, message: 'a state with no actions (deadlock) — MDPs must be action-total' })
      }
      for (const a of menu) checkDist(a.dist, m.n, `${m.labels[s] ?? `s${s}`} · ${a.name}`, issues)
    }
  }
  return issues
}

/** The set of state indices where an atomic proposition holds. */
export function propStates(m: Model, prop: string): boolean[] {
  const out = new Array<boolean>(m.n).fill(false)
  for (let s = 0; s < m.n; s++) out[s] = m.label[s]?.has(prop) ?? false
  return out
}

/** Deep clone (positions and label sets included) so editing never mutates a gallery example. */
export function cloneModel(m: Model): Model {
  const common = {
    n: m.n,
    labels: [...m.labels],
    init: m.init,
    props: [...m.props],
    label: m.label.map((s) => new Set(s)),
    pos: m.pos.map((p) => ({ ...p })),
  }
  if (m.kind === 'dtmc') {
    return { ...common, kind: 'dtmc', trans: m.trans.map((d) => d.map((e) => ({ ...e }))) }
  }
  return { ...common, kind: 'mdp', actions: m.actions.map((menu) => menu.map((a) => ({ name: a.name, dist: a.dist.map((e) => ({ ...e })) }))) }
}
