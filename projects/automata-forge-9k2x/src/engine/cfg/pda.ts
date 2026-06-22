// Pushdown automata: the machine model for context-free languages. We build the standard
// **single-state PDA that accepts by empty stack** from a grammar, and run it nondeterministically.
//
// CFG → PDA (the "top-down" construction): one state q, the start symbol on the stack, and
//   • for each production A → X₁…Xₖ:  (q, ε, A) → (q, push X₁…Xₖ)   [X₁ ends up on top]
//   • for each terminal a:            (q, a, a) → (q, pop)
// A leftmost derivation of the input is exactly an accepting run: the stack always holds the
// not-yet-matched tail of the current sentential form.

import type { Grammar } from './grammar'

export interface PdaTransition {
  from: string
  /** Input symbol consumed, or null for an ε-move. */
  read: string | null
  /** Stack symbol that must be on top. */
  pop: string
  to: string
  /** Symbols pushed; `push[0]` becomes the new top. Empty = pop only. */
  push: string[]
}

export interface Pda {
  states: string[]
  inputAlphabet: string[]
  stackAlphabet: string[]
  start: string
  startStack: string
  transitions: PdaTransition[]
  acceptByEmptyStack: boolean
  accepting: string[]
}

/** Build the single-state, accept-by-empty-stack PDA for a grammar. */
export function cfgToPda(g: Grammar): Pda {
  const q = 'q'
  const transitions: PdaTransition[] = []
  for (const p of g.productions) {
    transitions.push({ from: q, read: null, pop: p.lhs, to: q, push: [...p.rhs] })
  }
  for (const a of g.terminals) {
    transitions.push({ from: q, read: a, pop: a, to: q, push: [] })
  }
  return {
    states: [q],
    inputAlphabet: [...g.terminals],
    stackAlphabet: [...g.nonterminals, ...g.terminals],
    start: q,
    startStack: g.start,
    transitions,
    acceptByEmptyStack: true,
    accepting: [],
  }
}

export interface PdaStep {
  /** Stack before the move (top at the end of the array). */
  stack: string[]
  /** Remaining input before the move. */
  remaining: string
  /** The transition applied to reach the next configuration (null on the final config). */
  via: PdaTransition | null
}

export interface PdaRun {
  accepted: boolean
  /** A shortest accepting run if one exists, else the search frontier is exhausted. */
  steps: PdaStep[]
  /** True if the search hit its budget without deciding (treat `accepted` as best-effort). */
  budgetExceeded: boolean
}

interface Config {
  pos: number
  stack: string[]
}

const MAX_NODES = 50_000

/**
 * Nondeterministically search for a shortest accepting run on `input` (BFS over configurations).
 * Acceptance = all input consumed and the stack empty. Returns the reconstructed step trace.
 */
export function runPda(pda: Pda, input: string): PdaRun {
  const n = input.length
  const start: Config = { pos: 0, stack: [pda.startStack] }
  const keyOf = (c: Config) => `${c.pos}|${c.stack.join('')}`

  const parent = new Map<string, { prev: string; via: PdaTransition }>()
  const queue: Config[] = [start]
  const seen = new Set<string>([keyOf(start)])
  let nodes = 0
  let acceptKey: string | null = null
  let budgetExceeded = false

  while (queue.length > 0) {
    const cur = queue.shift()!
    if (cur.pos === n && cur.stack.length === 0) {
      acceptKey = keyOf(cur)
      break
    }
    if (++nodes > MAX_NODES) {
      budgetExceeded = true
      break
    }
    const top = cur.stack[cur.stack.length - 1]
    if (top === undefined) continue
    for (const t of pda.transitions) {
      if (t.pop !== top) continue
      if (t.read !== null && (cur.pos >= n || input[cur.pos] !== t.read)) continue
      const stack = cur.stack.slice(0, -1)
      for (let i = t.push.length - 1; i >= 0; i--) stack.push(t.push[i])
      const next: Config = { pos: cur.pos + (t.read !== null ? 1 : 0), stack }
      // Bound the stack so push-only loops (e.g. A → A A) can't run away.
      if (stack.length > n + pda.stackAlphabet.length + 2) continue
      const k = keyOf(next)
      if (seen.has(k)) continue
      seen.add(k)
      parent.set(k, { prev: keyOf(cur), via: t })
      queue.push(next)
    }
  }

  if (acceptKey === null) return { accepted: false, steps: [], budgetExceeded }

  // Reconstruct the path from start to the accepting config.
  const chain: { key: string; via: PdaTransition | null }[] = []
  let k: string | null = acceptKey
  while (k) {
    const p = parent.get(k)
    chain.push({ key: k, via: p ? p.via : null })
    k = p ? p.prev : null
  }
  chain.reverse()

  // Re-simulate along the chosen transitions to capture each configuration cleanly.
  const steps: PdaStep[] = []
  let cfg: Config = { pos: 0, stack: [pda.startStack] }
  for (let i = 1; i < chain.length; i++) {
    const via = parent.get(chain[i].key)!.via
    steps.push({ stack: [...cfg.stack], remaining: input.slice(cfg.pos), via })
    const stack = cfg.stack.slice(0, -1)
    for (let j = via.push.length - 1; j >= 0; j--) stack.push(via.push[j])
    cfg = { pos: cfg.pos + (via.read !== null ? 1 : 0), stack }
  }
  steps.push({ stack: [...cfg.stack], remaining: input.slice(cfg.pos), via: null })

  return { accepted: true, steps, budgetExceeded }
}
