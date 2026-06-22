// The single-tape Turing-machine data model, a tolerant transition-rule DSL parser, a determinism
// analysis, and a pretty-printer. A TM sits at the *top* of the Chomsky hierarchy: its language is
// recursively enumerable (decidable when the machine always halts). With the `bounded` flag it is a
// linear-bounded automaton, whose languages are exactly the context-sensitive ones (level 1).
//
// The DSL is line-oriented and deliberately forgiving, in the spirit of the grammar parser:
//
//   # comments after '#'
//   start: q0          # optional; defaults to the first rule's state
//   accept: qA         # the (single) accepting halt state — required
//   reject: qR         # optional explicit rejecting halt state
//   blank: _           # optional; defaults to '_'
//   q0 a -> q1 b R     # in q0 reading 'a', write 'b', move Right, go to q1
//   q0 * -> q0 * R     # '*' read = "any symbol with no exact rule here"; '*' write = "unchanged"
//   q1 _ -> qA _ S     #  '_' is the blank; moves are L / R / S(tay)
//
// A `(state, read)` pair appearing twice makes the machine nondeterministic (the simulator then
// searches branches). Exact reads always take precedence over a `*` rule for the same state, so a
// wildcard never *creates* nondeterminism.

/** Tape-head motion. `S` stays in place (handy for halting transitions). */
export type Move = 'L' | 'R' | 'S'

/** One instruction: in `state` reading `read`, write `write`, move `move`, enter `next`. */
export interface TMTransition {
  state: string
  read: string
  next: string
  write: string
  move: Move
}

/** A single-tape Turing machine (or, with `bounded`, a linear-bounded automaton). */
export interface TuringMachine {
  states: string[]
  start: string
  accept: string
  reject?: string
  blank: string
  inputAlphabet: string[] // symbols allowed in the input (never the blank)
  tapeAlphabet: string[] // every symbol that can appear on the tape, blank included
  transitions: TMTransition[]
  /** Linear-bounded: the head may never leave the original input region. */
  bounded?: boolean
  note?: string
}

export interface TMError {
  line: number // 1-based
  col: number // 1-based
  message: string
}

export interface TMParseResult {
  machine?: TuringMachine
  errors: TMError[]
}

export const DEFAULT_BLANK = '_'
export const WILDCARD = '*'

const ARROW = /->|→|⊢/
const MOVES: Record<string, Move> = { L: 'L', R: 'R', S: 'S', N: 'S', '<': 'L', '>': 'R', '-': 'S' }

/**
 * Parse TM source text. Always returns whatever it could recover plus a list of errors; if no usable
 * machine results (no rules, or no accept state), `machine` is undefined.
 */
export function parseTM(src: string): TMParseResult {
  const errors: TMError[] = []
  const transitions: TMTransition[] = []
  const stateOrder: string[] = []
  const stateSeen = new Set<string>()
  const tapeSeen = new Set<string>()
  const tapeOrder: string[] = []
  const inputSeen = new Set<string>()
  const inputOrder: string[] = []

  let start: string | undefined
  let accept: string | undefined
  let reject: string | undefined
  let blank = DEFAULT_BLANK
  let bounded = false

  const registerState = (s: string) => {
    if (!stateSeen.has(s)) {
      stateSeen.add(s)
      stateOrder.push(s)
    }
  }
  const registerTape = (s: string) => {
    if (s === WILDCARD) return
    if (!tapeSeen.has(s)) {
      tapeSeen.add(s)
      tapeOrder.push(s)
    }
  }
  const registerInput = (s: string) => {
    if (s === WILDCARD || s === blank) return
    if (!inputSeen.has(s)) {
      inputSeen.add(s)
      inputOrder.push(s)
    }
  }

  const lines = src.split('\n')
  lines.forEach((raw, i) => {
    const lineNo = i + 1
    // `#` is a legal tape symbol (e.g. the w#w separator), so it only starts a comment at the very
    // beginning of a line; inline comments use `//`.
    const trimmed = raw.trimStart()
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) return
    const slash = raw.indexOf('//')
    const line = (slash >= 0 ? raw.slice(0, slash) : raw).trim()
    if (line === '') return

    // Directives: `key: value`.
    const colon = line.indexOf(':')
    const arrowM = ARROW.exec(line)
    if (colon >= 0 && (!arrowM || colon < arrowM.index)) {
      const key = line.slice(0, colon).trim().toLowerCase()
      const val = line.slice(colon + 1).trim()
      switch (key) {
        case 'start':
          start = val
          registerState(val)
          break
        case 'accept':
          accept = val
          registerState(val)
          break
        case 'reject':
          reject = val
          registerState(val)
          break
        case 'blank':
          if (val.length === 1) blank = val
          else errors.push({ line: lineNo, col: colon + 2, message: 'blank must be a single character' })
          break
        case 'bounded':
          bounded = val === '' || /^(true|yes|1|on)$/i.test(val)
          break
        default:
          errors.push({ line: lineNo, col: 1, message: `unknown directive "${key}:" (expected start/accept/reject/blank/bounded)` })
      }
      return
    }

    // Transition rule: `<state> <read> -> <next> <write> <move>`.
    if (!arrowM) {
      errors.push({ line: lineNo, col: 1, message: 'missing "->" — write e.g. "q0 a -> q1 b R"' })
      return
    }
    const lhs = line.slice(0, arrowM.index).trim().split(/\s+/).filter(Boolean)
    const rhs = line.slice(arrowM.index + arrowM[0].length).trim().split(/\s+/).filter(Boolean)
    if (lhs.length !== 2) {
      errors.push({ line: lineNo, col: 1, message: `left of "->" must be "<state> <read>", got "${lhs.join(' ')}"` })
      return
    }
    if (rhs.length < 2 || rhs.length > 3) {
      errors.push({ line: lineNo, col: arrowM.index + 1, message: 'right of "->" must be "<next> <write> [move]"' })
      return
    }
    const [state, read] = lhs
    const next = rhs[0]
    const write = rhs[1]
    const moveTok = rhs[2] ?? 'S'
    const move = MOVES[moveTok.toUpperCase()] ?? MOVES[moveTok]
    if (move === undefined) {
      errors.push({ line: lineNo, col: 1, message: `move must be L, R or S, got "${moveTok}"` })
      return
    }
    if (read.length !== 1 && read !== WILDCARD) {
      errors.push({ line: lineNo, col: 1, message: `read symbol must be a single character or "*", got "${read}"` })
      return
    }
    if (write.length !== 1 && write !== WILDCARD) {
      errors.push({ line: lineNo, col: 1, message: `write symbol must be a single character or "*", got "${write}"` })
      return
    }
    registerState(state)
    registerState(next)
    registerTape(read)
    registerTape(write)
    registerInput(read)
    transitions.push({ state, read, next, write, move })
  })

  if (transitions.length === 0) {
    if (errors.length === 0) errors.push({ line: 1, col: 1, message: 'no transitions — add a rule like "q0 a -> q1 b R"' })
    return { errors }
  }
  if (accept === undefined) {
    // Be forgiving: accept a conventional name if present, else flag it.
    const guess = stateOrder.find((s) => /^(accept|acc|qa|qaccept|halt|h)$/i.test(s))
    if (guess) accept = guess
    else {
      errors.push({ line: 1, col: 1, message: 'no accept state — add "accept: qA"' })
      return { errors }
    }
  }
  if (start === undefined) start = transitions[0].state

  registerState(start)
  registerState(accept)
  if (reject) registerState(reject)
  // The blank is always a tape symbol even if no rule mentions it.
  registerTape(blank)

  const machine: TuringMachine = {
    states: stateOrder,
    start,
    accept,
    reject,
    blank,
    inputAlphabet: inputOrder,
    tapeAlphabet: tapeOrder,
    transitions,
    bounded: bounded || undefined,
  }
  return { machine, errors }
}

// ---------------------------------------------------------------------------
// Lookup with exact-over-wildcard precedence.
// ---------------------------------------------------------------------------

/**
 * Every transition that fires for `(state, sym)`. Exact-read rules win: a `*` rule applies only when
 * no exact rule exists for that symbol in that state. Returns multiple rules only for a genuinely
 * nondeterministic machine.
 */
export function applicable(tm: TuringMachine, state: string, sym: string): TMTransition[] {
  const exact = tm.transitions.filter((t) => t.state === state && t.read === sym)
  if (exact.length > 0) return exact
  return tm.transitions.filter((t) => t.state === state && t.read === WILDCARD)
}

export interface DeterminismResult {
  deterministic: boolean
  /** The `(state, read)` keys that have more than one rule. */
  conflicts: { state: string; read: string; count: number }[]
}

/** A TM is deterministic iff no `(state, read)` key carries more than one rule. */
export function analyzeDeterminism(tm: TuringMachine): DeterminismResult {
  const counts = new Map<string, number>()
  for (const t of tm.transitions) {
    const k = `${t.state} ${t.read}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const conflicts: DeterminismResult['conflicts'] = []
  for (const [k, count] of counts) {
    if (count > 1) {
      const [state, read] = k.split(' ')
      conflicts.push({ state, read, count })
    }
  }
  return { deterministic: conflicts.length === 0, conflicts }
}

/** Is `state` a halting state (accept, reject, or no outgoing rules)? */
export function isHalting(tm: TuringMachine, state: string): boolean {
  if (state === tm.accept || state === tm.reject) return true
  return !tm.transitions.some((t) => t.state === state)
}

/** Render the blank as a visible glyph; everything else passes through. */
export function showTapeSym(tm: TuringMachine, sym: string): string {
  if (sym === tm.blank) return '␢'
  if (sym === WILDCARD) return '∗'
  if (sym === ' ') return '␣'
  return sym
}

/** Pretty-print a machine back into the editor's DSL. */
export function prettyTM(tm: TuringMachine): string {
  const out: string[] = []
  if (tm.start) out.push(`start: ${tm.start}`)
  out.push(`accept: ${tm.accept}`)
  if (tm.reject) out.push(`reject: ${tm.reject}`)
  if (tm.blank !== DEFAULT_BLANK) out.push(`blank: ${tm.blank}`)
  if (tm.bounded) out.push('bounded: true')
  out.push('')
  for (const t of tm.transitions) {
    out.push(`${t.state} ${t.read} -> ${t.next} ${t.write} ${t.move}`)
  }
  return out.join('\n')
}
