// The CONCRETE operational semantics — a step-by-step interpreter over real
// clock valuations. A run alternates DELAY moves (all clocks advance by δ ≥ 0,
// legal only while the location invariant holds — invariants are convex, so
// checking the endpoint suffices) and ACTION moves (take an enabled edge: its
// guard must hold now, clocks in its reset set drop to 0, and the target
// invariant must hold on arrival). This is the ground truth the region and zone
// abstractions are validated against.

import type { TimedAutomaton, Valuation } from './types'
import { locByName, satConstraint } from './types'

export type Move = { kind: 'delay'; delta: number } | { kind: 'action'; edge: number }

export interface Config {
  loc: string
  val: Valuation
}

export interface StepResult {
  ok: boolean
  config: Config
  reason?: string
}

/** Apply one move to a configuration, reporting why it is illegal if so. */
export function step(ta: TimedAutomaton, cfg: Config, move: Move): StepResult {
  if (move.kind === 'delay') {
    if (move.delta < 0) return { ok: false, config: cfg, reason: 'negative delay' }
    const val = cfg.val.map((x) => x + move.delta)
    const inv = locByName(ta, cfg.loc).invariant
    if (!satConstraint(ta, val, inv)) return { ok: false, config: cfg, reason: `delay violates invariant of ${cfg.loc}` }
    return { ok: true, config: { loc: cfg.loc, val } }
  }
  const e = ta.edges[move.edge]
  if (!e || e.from !== cfg.loc) return { ok: false, config: cfg, reason: 'edge not enabled here' }
  if (!satConstraint(ta, cfg.val, e.guard)) return { ok: false, config: cfg, reason: 'guard not satisfied' }
  const val = cfg.val.slice()
  for (const c of e.resets) {
    const i = ta.clocks.indexOf(c)
    if (i >= 0) val[i] = 0
  }
  const inv = locByName(ta, e.to).invariant
  if (!satConstraint(ta, val, inv)) return { ok: false, config: { loc: e.to, val }, reason: `arrival violates invariant of ${e.to}` }
  return { ok: true, config: { loc: e.to, val } }
}

/** The initial configuration: the initial location with every clock at 0. */
export function initialConfig(ta: TimedAutomaton): Config {
  return { loc: ta.initial, val: ta.clocks.map(() => 0) }
}

/** Run a sequence of moves, returning the trace of configurations up to the first illegal move. */
export function runMoves(ta: TimedAutomaton, moves: Move[]): { trace: Config[]; ok: boolean; reason?: string; failedAt?: number } {
  let cfg = initialConfig(ta)
  const trace: Config[] = [cfg]
  for (let k = 0; k < moves.length; k++) {
    const r = step(ta, cfg, moves[k])
    if (!r.ok) return { trace, ok: false, reason: r.reason, failedAt: k }
    cfg = r.config
    trace.push(cfg)
  }
  return { trace, ok: true }
}

/** The edges enabled from a configuration right now (guard satisfied, arrival invariant respected). */
export function enabledEdges(ta: TimedAutomaton, cfg: Config): number[] {
  const out: number[] = []
  ta.edges.forEach((e, i) => {
    if (e.from !== cfg.loc) return
    if (!satConstraint(ta, cfg.val, e.guard)) return
    const val = cfg.val.slice()
    for (const c of e.resets) {
      const j = ta.clocks.indexOf(c)
      if (j >= 0) val[j] = 0
    }
    if (!satConstraint(ta, val, locByName(ta, e.to).invariant)) return
    out.push(i)
  })
  return out
}

/** The largest delay that keeps the invariant satisfied (∞ when unbounded), for the Run tab's slider. */
export function maxDelay(ta: TimedAutomaton, cfg: Config): number {
  const inv = locByName(ta, cfg.loc).invariant
  let bound = Infinity
  for (const a of inv) {
    const i = ta.clocks.indexOf(a.clock)
    if (i < 0) continue
    if (a.op === '<=' || a.op === '<' || a.op === '=') {
      const slack = a.bound - cfg.val[i]
      if (slack < bound) bound = slack
    }
  }
  return Math.max(0, bound)
}
