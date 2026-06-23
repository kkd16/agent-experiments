// The LR parse table (ACTION + GOTO) and the table-driven shift-reduce parser.
//
// From a canonical automaton + a reduce-lookahead policy we fill two tables:
//   ACTION[state, terminal] ∈ { shift J, reduce p, accept }
//   GOTO[state, nonterminal] = J
// Shifts and accept come straight from the items with the dot before a symbol. The four LR variants
// differ only in *on which lookaheads* a completed item `A -> α •` triggers a reduce:
//   • LR(0):  on every terminal (and $)        — strongest, conflicts most easily
//   • SLR(1): on FOLLOW(A)
//   • LR(1)/LALR(1): on the item's own lookahead set
// A cell that would hold two different actions is a conflict (shift/reduce or reduce/reduce); the
// grammar belongs to a class exactly when its table for that class has no conflicts.

import type { Grammar } from '../cfg/grammar'
import { firstFollow } from '../cfg/analyze'
import type { ParseNode } from '../cfg/earley'
import type { AugGrammar } from './augment'
import { buildLr0, buildLr1, buildLalr1 } from './lr-items'
import type { LrAutomaton } from './lr-items'

const END = '$'

export type ParserKind = 'LR0' | 'SLR1' | 'LALR1' | 'LR1'

export type Action =
  | { kind: 'shift'; target: number }
  | { kind: 'reduce'; prod: number }
  | { kind: 'accept' }

export interface Conflict {
  state: number
  term: string
  kinds: string // e.g. "shift/reduce" or "reduce/reduce"
  actions: Action[]
}

export interface LrTable {
  kind: ParserKind
  aug: AugGrammar
  automaton: LrAutomaton
  terminals: string[] // real terminals + `$`
  nonterminals: string[] // original nonterminals (GOTO columns)
  /** ACTION as a list per cell (length > 1 ⇒ conflict). Key = `state   term`. */
  action: Map<string, Action[]>
  /** GOTO over nonterminals. Key = `state   nt`. */
  goto: Map<string, number>
  conflicts: Conflict[]
  ok: boolean // conflict-free
}

const key = (s: number, x: string) => `${s} ${x}`

function automatonFor(kind: ParserKind, aug: AugGrammar): LrAutomaton {
  switch (kind) {
    case 'LR0':
    case 'SLR1':
      return buildLr0(aug)
    case 'LR1':
      return buildLr1(aug)
    case 'LALR1':
      return buildLalr1(aug)
  }
}

/** Build the ACTION/GOTO table for one of the four LR variants. */
export function buildLrTable(g: Grammar, aug: AugGrammar, kind: ParserKind): LrTable {
  const automaton = automatonFor(kind, aug)
  const { follow } = firstFollow(g)
  const terminals = [...g.terminals, END]
  const action = new Map<string, Action[]>()
  const goto = new Map<string, number>()

  const addAction = (s: number, t: string, a: Action) => {
    const k = key(s, t)
    const arr = action.get(k)
    if (!arr) {
      action.set(k, [a])
      return
    }
    // Deduplicate identical actions (same kind + target/prod).
    const same = arr.some(
      (x) =>
        x.kind === a.kind &&
        (x as { target?: number }).target === (a as { target?: number }).target &&
        (x as { prod?: number }).prod === (a as { prod?: number }).prod,
    )
    if (!same) arr.push(a)
  }

  // Lookaheads on which a completed item A -> α • reduces.
  const reduceLookahead = (st: { items: { prod: number; dot: number; la: Set<string> }[] }, prod: number, A: string): string[] => {
    if (kind === 'LR0') return terminals
    if (kind === 'SLR1') return [...(follow.get(A) ?? new Set())]
    // LR(1) / LALR(1): the item's own lookahead set.
    const it = st.items.find((i) => i.prod === prod && i.dot === aug.prods[prod].rhs.length)
    return it ? [...it.la] : []
  }

  for (const st of automaton.states) {
    // shifts + gotos from the automaton's transitions
    for (const [X, to] of automaton.goto.get(st.id) ?? []) {
      if (aug.nt.has(X)) goto.set(key(st.id, X), to)
      else addAction(st.id, X, { kind: 'shift', target: to })
    }
    // reduces / accept from completed items
    for (const it of st.items) {
      const p = aug.prods[it.prod]
      if (it.dot !== p.rhs.length) continue // not complete
      if (it.prod === 0) {
        // S' -> S •  : accept on $
        addAction(st.id, END, { kind: 'accept' })
      } else {
        for (const a of reduceLookahead(st, it.prod, p.lhs)) {
          addAction(st.id, a, { kind: 'reduce', prod: it.prod })
        }
      }
    }
  }

  // Collect conflicts.
  const conflicts: Conflict[] = []
  for (const [k, acts] of action) {
    if (acts.length > 1) {
      const [s, t] = k.split(' ')
      const hasShift = acts.some((a) => a.kind === 'shift')
      const reduces = acts.filter((a) => a.kind === 'reduce').length
      const kinds =
        hasShift && reduces > 0 ? 'shift/reduce' : reduces > 1 ? 'reduce/reduce' : 'conflict'
      conflicts.push({ state: Number(s), term: t, kinds, actions: acts })
    }
  }

  return {
    kind,
    aug,
    automaton,
    terminals,
    nonterminals: [...g.nonterminals],
    action,
    goto,
    conflicts,
    ok: conflicts.length === 0,
  }
}

/** ACTION cell (first action wins when a conflict was resolved deterministically). */
export function actionOf(table: LrTable, s: number, t: string): Action | undefined {
  return table.action.get(key(s, t))?.[0]
}
export function actionsOf(table: LrTable, s: number, t: string): Action[] {
  return table.action.get(key(s, t)) ?? []
}
export function gotoOf(table: LrTable, s: number, nt: string): number | undefined {
  return table.goto.get(key(s, nt))
}

// ---------------------------------------------------------------------------
// The driver — a shift-reduce parser.
// ---------------------------------------------------------------------------

export type LrActionKind = 'shift' | 'reduce' | 'accept' | 'error'

export interface LrStep {
  /** State stack, bottom-first. */
  states: number[]
  /** Grammar-symbol stack, bottom-first (parallel to `states` minus the initial state). */
  symbols: string[]
  /** Remaining input including the trailing `$`. */
  rest: string[]
  lookahead: string
  action: LrActionKind
  detail: string
  prod?: number // on a reduce
  ambiguous?: boolean // the cell held a conflict
}

export interface LrRun {
  steps: LrStep[]
  accepted: boolean
  tree: ParseNode | null
  error?: string
}

const STEP_BUDGET = 8000

/** Run the table-driven LR parser on `input` (each character is one terminal). */
export function parseLr(table: LrTable, input: string): LrRun {
  const toks = [...input, END]
  let pos = 0
  const stateStack: number[] = [0]
  const symStack: string[] = []
  const nodeStack: ParseNode[] = []
  const steps: LrStep[] = []
  let accepted = false
  let error: string | undefined

  const snap = (): Pick<LrStep, 'states' | 'symbols' | 'rest' | 'lookahead'> => ({
    states: [...stateStack],
    symbols: [...symStack],
    rest: toks.slice(pos),
    lookahead: toks[pos],
  })

  let guard = 0
  while (true) {
    if (guard++ > STEP_BUDGET) {
      error = 'step budget exceeded'
      steps.push({ ...snap(), action: 'error', detail: error })
      break
    }
    const s = stateStack[stateStack.length - 1]
    const a = toks[pos]
    const acts = actionsOf(table, s, a)
    const act = acts[0]
    const ambiguous = acts.length > 1

    if (!act) {
      error = `no action for state ${s} on “${a === END ? '$' : a}” — syntax error`
      steps.push({ ...snap(), action: 'error', detail: error })
      break
    }

    if (act.kind === 'accept') {
      steps.push({ ...snap(), action: 'accept', detail: 'accept' })
      accepted = true
      break
    }

    if (act.kind === 'shift') {
      steps.push({
        ...snap(),
        action: 'shift',
        detail: `shift “${a}”, go to state ${act.target}`,
        ambiguous,
      })
      symStack.push(a)
      nodeStack.push({ symbol: a, terminal: true })
      stateStack.push(act.target)
      pos++
      continue
    }

    // reduce
    const p = table.aug.prods[act.prod]
    const n = p.rhs.length
    steps.push({
      ...snap(),
      action: 'reduce',
      detail: `reduce by ${p.lhs} → ${n === 0 ? 'ε' : p.rhs.join(' ')}${ambiguous ? ` (${acts.length}-way conflict)` : ''}`,
      prod: act.prod,
      ambiguous,
    })
    const children: ParseNode[] = []
    for (let i = 0; i < n; i++) {
      stateStack.pop()
      symStack.pop()
      children.unshift(nodeStack.pop()!)
    }
    const node: ParseNode = { symbol: p.lhs, children }
    const top = stateStack[stateStack.length - 1]
    const g = gotoOf(table, top, p.lhs)
    if (g === undefined) {
      error = `no GOTO for state ${top} on ${p.lhs}`
      steps.push({ ...snap(), action: 'error', detail: error })
      break
    }
    symStack.push(p.lhs)
    nodeStack.push(node)
    stateStack.push(g)
  }

  return { steps, accepted, tree: accepted ? (nodeStack[0] ?? null) : null, error }
}
