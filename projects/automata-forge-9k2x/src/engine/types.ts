// Shared types for the whole engine: regex AST, automata, and the finite alphabet.

/**
 * The "other" symbol. A regex over an infinite character universe is turned into an automaton
 * over a *finite* alphabet by collecting every character the pattern names explicitly and
 * adding this single sentinel that stands for "any character not named above". Input characters
 * outside the explicit set all collapse onto OTHER, which keeps every machine total and finite
 * while preserving the language semantics for `.` and negated classes.
 */
export const OTHER = ''

/** A single symbol of the derived alphabet — either a real character or {@link OTHER}. */
export type Sym = string

/** Human-readable rendering of an alphabet symbol. */
export function showSym(s: Sym): string {
  if (s === OTHER) return '∗' // "any other"
  return showChar(s)
}

/** Render a raw character, escaping the ones that are hard to see. */
export function showChar(c: string): string {
  switch (c) {
    case ' ':
      return '␣'
    case '\n':
      return '\\n'
    case '\t':
      return '\\t'
    case '\r':
      return '\\r'
    default:
      return c
  }
}

// ---------------------------------------------------------------------------
// Regex AST
// ---------------------------------------------------------------------------

/** An item inside a character class: a single char or an inclusive range. */
export type ClassItem =
  | { kind: 'char'; char: string }
  | { kind: 'range'; lo: string; hi: string }

/** A predicate over a single input character. */
export type CharPred =
  | { kind: 'lit'; char: string } // exactly this character
  | { kind: 'any' } // `.` — every symbol including OTHER
  | { kind: 'class'; neg: boolean; items: ClassItem[] } // [...] / [^...]

export type Ast =
  | { type: 'epsilon' } // matches the empty string
  | { type: 'char'; pred: CharPred }
  | { type: 'concat'; parts: Ast[] }
  | { type: 'alt'; options: Ast[] }
  | { type: 'star'; node: Ast }
  | { type: 'plus'; node: Ast }
  | { type: 'opt'; node: Ast }

// ---------------------------------------------------------------------------
// NFA (Thompson) — symbols are concrete alphabet symbols, plus ε edges.
// ---------------------------------------------------------------------------

export interface NfaEdge {
  from: number
  to: number
  /** A concrete alphabet symbol, or null for an ε-transition. */
  sym: Sym | null
}

export interface Nfa {
  numStates: number
  start: number
  accept: number // Thompson fragments always have a single accept state
  edges: NfaEdge[]
  alphabet: Sym[]
}

// ---------------------------------------------------------------------------
// DFA — total transition function over the alphabet.
// ---------------------------------------------------------------------------

export interface Dfa {
  numStates: number
  start: number
  accepting: Set<number>
  /** trans[state][symIndex] -> next state. Total. */
  trans: number[][]
  alphabet: Sym[]
  /**
   * For display: which NFA states each DFA state corresponds to (subset construction),
   * or which DFA states each minimized state merges (minimization). Undefined for the trap.
   */
  label?: (number[] | undefined)[]
  trap?: number
}

/** A normalized graph view both NFA and DFA renderers consume. */
export interface GraphModel {
  numStates: number
  start: number
  accepting: Set<number>
  /** One entry per directed (from,to) pair, labels already merged into one string. */
  edges: { from: number; to: number; label: string }[]
  /** Optional sub-label shown under the state id (e.g. the subset it represents). */
  stateSub?: (string | undefined)[]
}
