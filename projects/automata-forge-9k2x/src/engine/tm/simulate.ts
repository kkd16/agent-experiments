// Running a Turing machine: a two-way-infinite tape, a deterministic forward runner that records the
// whole configuration trace, and a nondeterministic breadth-first configuration search that
// reconstructs a shortest accepting run. Both surface `timeout` when the step budget is exhausted —
// a TM need not halt, and that undecidability is exactly what separates level 0 from the lower
// levels, so we make it visible rather than hiding it behind an infinite loop.

import type { TMTransition, TuringMachine } from './machine'
import { applicable, analyzeDeterminism } from './machine'

/** A snapshot of the machine at one instant, kept compact for the trace. */
export interface TMConfig {
  state: string
  head: number // absolute tape index
  /** Contiguous tape window: `cells[k]` is the symbol at index `min + k`; blank outside the window. */
  min: number
  cells: string[]
  /** The rule whose firing *produced* this config (undefined for the initial config). */
  via?: TMTransition
}

export type TMOutcome =
  | 'accept' // reached the accept state
  | 'reject' // reached an explicit reject state, or got stuck (no rule) in a non-accept state
  | 'timeout' // step budget exhausted — the machine may not halt on this input

export interface TMRunResult {
  outcome: TMOutcome
  /** The configuration trace (the accepting branch, for a nondeterministic machine). */
  trace: TMConfig[]
  steps: number
  deterministic: boolean
  /** Configurations explored by the nondeterministic search (undefined for a deterministic run). */
  explored?: number
  /** True when the trace was truncated to `RunOptions.maxTrace` for display. */
  truncated?: boolean
}

export interface RunOptions {
  /** Hard cap on simulated steps; hitting it yields `timeout`. */
  maxSteps?: number
  /** Cap on stored trace length (display only); a longer run still computes its outcome. */
  maxTrace?: number
  /** Cap on distinct configurations the nondeterministic search may visit. */
  maxConfigs?: number
}

const DEFAULTS = { maxSteps: 12000, maxTrace: 4000, maxConfigs: 200000 }

// ---------------------------------------------------------------------------
// A mutable, two-way-infinite tape backed by a sparse map.
// ---------------------------------------------------------------------------

class Tape {
  private cells = new Map<number, string>()
  min = 0
  max = -1 // empty when max < min
  blank: string
  constructor(blank: string) {
    this.blank = blank
  }

  static of(input: string, blank: string): Tape {
    const t = new Tape(blank)
    for (let i = 0; i < input.length; i++) t.write(i, input[i])
    return t
  }

  read(i: number): string {
    return this.cells.get(i) ?? this.blank
  }

  write(i: number, sym: string): void {
    if (sym === this.blank) this.cells.delete(i)
    else this.cells.set(i, sym)
    if (this.max < this.min) {
      this.min = this.max = i
    } else {
      if (i < this.min) this.min = i
      if (i > this.max) this.max = i
    }
  }

  /** A contiguous window covering both the written region and the head. */
  snapshot(head: number): { min: number; cells: string[] } {
    const lo = this.max < this.min ? head : Math.min(this.min, head)
    const hi = this.max < this.min ? head : Math.max(this.max, head)
    const cells: string[] = []
    for (let i = lo; i <= hi; i++) cells.push(this.read(i))
    return { min: lo, cells }
  }

  /** A canonical key (trimmed of blanks) for the configuration-search visited set. */
  key(state: string, head: number): string {
    let lo = this.min
    let hi = this.max
    while (lo <= hi && this.read(lo) === this.blank) lo++
    while (hi >= lo && this.read(hi) === this.blank) hi--
    let s = ''
    for (let i = lo; i <= hi; i++) s += this.read(i)
    // head position is relative to the trimmed-left edge so that two equal tapes match.
    return `${state}|${head - lo}|${s}`
  }

  clone(): Tape {
    const t = new Tape(this.blank)
    t.cells = new Map(this.cells)
    t.min = this.min
    t.max = this.max
    return t
  }
}

function snapshotConfig(tape: Tape, state: string, head: number, via?: TMTransition): TMConfig {
  const { min, cells } = tape.snapshot(head)
  return { state, head, min, cells, via }
}

/** Apply a transition to a tape in place; returns the new head, or null if a bounded TM would leave its region. */
function applyMove(tm: TuringMachine, tape: Tape, head: number, t: TMTransition, inputLen: number): number | null {
  const write = t.write === '*' ? tape.read(head) : t.write
  let nextHead = head
  if (t.move === 'L') nextHead = head - 1
  else if (t.move === 'R') nextHead = head + 1
  if (tm.bounded) {
    const hi = Math.max(0, inputLen - 1)
    if (nextHead < 0 || nextHead > hi) return null // the LBA cannot step off the input region
  }
  tape.write(head, write)
  return nextHead
}

// ---------------------------------------------------------------------------
// Deterministic forward run.
// ---------------------------------------------------------------------------

function runDeterministic(tm: TuringMachine, input: string, opts: Required<RunOptions>): TMRunResult {
  const tape = Tape.of(input, tm.blank)
  let state = tm.start
  let head = 0
  const trace: TMConfig[] = [snapshotConfig(tape, state, head)]
  let truncated = false

  for (let steps = 0; steps < opts.maxSteps; steps++) {
    if (state === tm.accept) return { outcome: 'accept', trace, steps, deterministic: true, truncated }
    if (state === tm.reject) return { outcome: 'reject', trace, steps, deterministic: true, truncated }
    const sym = tape.read(head)
    const rules = applicable(tm, state, sym)
    if (rules.length === 0) {
      // Stuck with no rule: a halting reject.
      return { outcome: 'reject', trace, steps, deterministic: true, truncated }
    }
    const t = rules[0]
    const nh = applyMove(tm, tape, head, t, input.length)
    if (nh === null) return { outcome: 'reject', trace, steps, deterministic: true, truncated } // bounded edge
    head = nh
    state = t.next
    if (trace.length < opts.maxTrace) trace.push(snapshotConfig(tape, state, head, t))
    else truncated = true
  }
  return { outcome: 'timeout', trace, steps: opts.maxSteps, deterministic: true, truncated }
}

// ---------------------------------------------------------------------------
// Nondeterministic breadth-first configuration search.
// ---------------------------------------------------------------------------

interface SearchNode {
  tape: Tape
  state: string
  head: number
  parent: number // index into the node array, or -1 for the root
  via?: TMTransition
  depth: number
}

function runNondeterministic(tm: TuringMachine, input: string, opts: Required<RunOptions>): TMRunResult {
  const root: SearchNode = { tape: Tape.of(input, tm.blank), state: tm.start, head: 0, parent: -1, depth: 0 }
  const nodes: SearchNode[] = [root]
  const queue: number[] = [0]
  const seen = new Set<string>([root.tape.key(root.state, root.head)])
  let explored = 0

  while (queue.length > 0) {
    const idx = queue.shift()!
    const node = nodes[idx]
    explored++
    if (node.state === tm.accept) {
      return finishAccepting(nodes, idx, opts, explored)
    }
    if (node.depth >= opts.maxSteps || explored >= opts.maxConfigs) {
      // Out of budget on this branch; keep exploring others until the queue drains.
      continue
    }
    if (node.state === tm.reject) continue
    const sym = node.tape.read(node.head)
    const rules = applicable(tm, node.state, sym)
    for (const t of rules) {
      const tape = node.tape.clone()
      const nh = applyMove(tm, tape, node.head, t, input.length)
      if (nh === null) continue
      const key = tape.key(t.next, nh)
      if (seen.has(key)) continue
      seen.add(key)
      const child: SearchNode = { tape, state: t.next, head: nh, parent: idx, via: t, depth: node.depth + 1 }
      nodes.push(child)
      queue.push(nodes.length - 1)
    }
  }
  // No accepting configuration was reachable. If we ran out of budget we cannot be sure; otherwise
  // the language genuinely rejects.
  const exhausted = explored >= opts.maxConfigs
  const root0 = nodes[0]
  const trace = [snapshotConfig(root0.tape, root0.state, root0.head)] // at least the initial config
  return { outcome: exhausted ? 'timeout' : 'reject', trace, steps: 0, deterministic: false, explored }
}

function finishAccepting(nodes: SearchNode[], acceptIdx: number, opts: Required<RunOptions>, explored: number): TMRunResult {
  // Walk parent pointers back to the root to recover the accepting path.
  const path: number[] = []
  for (let i = acceptIdx; i !== -1; i = nodes[i].parent) path.push(i)
  path.reverse()
  const trace: TMConfig[] = []
  let truncated = false
  for (const i of path) {
    if (trace.length >= opts.maxTrace) {
      truncated = true
      break
    }
    const n = nodes[i]
    trace.push(snapshotConfig(n.tape, n.state, n.head, n.via))
  }
  return { outcome: 'accept', trace, steps: path.length - 1, deterministic: false, explored, truncated }
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/** Run `tm` on `input`, choosing the deterministic fast path or the nondeterministic search. */
export function runTM(tm: TuringMachine, input: string, options: RunOptions = {}): TMRunResult {
  const opts: Required<RunOptions> = { ...DEFAULTS, ...options }
  const det = analyzeDeterminism(tm).deterministic
  return det ? runDeterministic(tm, input, opts) : runNondeterministic(tm, input, opts)
}

/** Just the yes/no verdict (accept), used by the membership rail and the differential tests. */
export function tmAccepts(tm: TuringMachine, input: string, options: RunOptions = {}): boolean {
  return runTM(tm, input, options).outcome === 'accept'
}
