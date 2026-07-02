// Alternating finite automata (AFA) — the model that closes the studio's
// "many roads to one machine" story with a *fourth* kind of branching.
//
// A DFA has one successor. An NFA has *existential* branching: a word is
// accepted if **some** run accepts (∃). A co-NFA has *universal* branching: if
// **every** run accepts (∀). An **alternating** automaton has both at once: the
// transition out of a state is an arbitrary **positive boolean formula** over
// the states, mixing ∧ (all these must accept the rest) and ∨ (one of these
// must). Acceptance is defined by *evaluating* that formula recursively down
// the word.
//
//   δ(q, a) ∈ B⁺(Q)          a positive boolean formula over the state set
//   accept(q, ε)   = q ∈ F
//   accept(q, a·w) = δ(q, a) with each state r ↦ accept(r, w)
//   w ∈ L(A)       ⟺  init  with each state q ↦ accept(q, w)
//
// Two facts make AFA worth their own tab:
//   • **Complement is free and linear** — dualise every formula (∧↔∨, and the
//     final set) and the *same states* now recognise the complement. (An NFA
//     needs a determinising blow-up to complement.)
//   • **Intersection/union are linear** — ∧/∨ the two initial formulas over the
//     disjoint union of states; no product. (A DFA product multiplies sizes.)
//   • …but an AFA is still only as expressive as a regular language: the
//     classic construction turns n alternating states into ≤ 2ⁿ NFA states
//     (every *macrostate* is a set of states that must **all** accept the rest),
//     which the studio's existing subset construction + minimiser then reduce.
//
// This module is the source of truth: the formula algebra, the brute-force
// alternating semantics (the oracle), the AFA→NFA construction (verified against
// that oracle through the whole DFA pipeline), and the boolean-closure builders.

import { CharSet } from '../charset';
import type { NFA, NFAEdge } from '../nfa';

// ── Positive boolean formulas over the state set ─────────────────────────────

export type BF =
  | { k: 'true' }
  | { k: 'false' }
  | { k: 'var'; q: number }
  | { k: 'and'; a: BF; b: BF }
  | { k: 'or'; a: BF; b: BF };

export const BF_TRUE: BF = { k: 'true' };
export const BF_FALSE: BF = { k: 'false' };
export function bfVar(q: number): BF {
  return { k: 'var', q };
}
/** Smart ∧ that folds the boolean identities so formulas stay small. */
export function bfAnd(a: BF, b: BF): BF {
  if (a.k === 'false' || b.k === 'false') return BF_FALSE;
  if (a.k === 'true') return b;
  if (b.k === 'true') return a;
  return { k: 'and', a, b };
}
/** Smart ∨ that folds the boolean identities. */
export function bfOr(a: BF, b: BF): BF {
  if (a.k === 'true' || b.k === 'true') return BF_TRUE;
  if (a.k === 'false') return b;
  if (b.k === 'false') return a;
  return { k: 'or', a, b };
}

/** Evaluate a formula given a truth value for each state variable. */
export function evalBF(f: BF, val: (q: number) => boolean): boolean {
  switch (f.k) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'var':
      return val(f.q);
    case 'and':
      return evalBF(f.a, val) && evalBF(f.b, val);
    case 'or':
      return evalBF(f.a, val) || evalBF(f.b, val);
  }
}

/**
 * The De Morgan dual: ∧↔∨, true↔false, variables unchanged. Because AFA formulas
 * are *positive* (no negation), dualising every δ and flipping the final set is
 * exactly complementation — `accept` negates leaf-for-leaf and De Morgan carries
 * the negation up through the connectives.
 */
export function dualBF(f: BF): BF {
  switch (f.k) {
    case 'true':
      return BF_FALSE;
    case 'false':
      return BF_TRUE;
    case 'var':
      return f;
    case 'and':
      return { k: 'or', a: dualBF(f.a), b: dualBF(f.b) };
    case 'or':
      return { k: 'and', a: dualBF(f.a), b: dualBF(f.b) };
  }
}

/** Collect the state indices a formula mentions. */
export function bfVars(f: BF, into: Set<number> = new Set()): Set<number> {
  switch (f.k) {
    case 'var':
      into.add(f.q);
      break;
    case 'and':
    case 'or':
      bfVars(f.a, into);
      bfVars(f.b, into);
      break;
  }
  return into;
}

/** Shift every variable index by `d` (used when disjoint-unioning two AFAs). */
export function bfShift(f: BF, d: number): BF {
  switch (f.k) {
    case 'var':
      return { k: 'var', q: f.q + d };
    case 'and':
      return { k: 'and', a: bfShift(f.a, d), b: bfShift(f.b, d) };
    case 'or':
      return { k: 'or', a: bfShift(f.a, d), b: bfShift(f.b, d) };
    default:
      return f;
  }
}

/** Pretty-print a formula using state display names, with minimal parentheses. */
export function bfToString(f: BF, names: readonly string[]): string {
  const go = (g: BF, parentPrec: number): string => {
    switch (g.k) {
      case 'true':
        return '⊤';
      case 'false':
        return '⊥';
      case 'var':
        return names[g.q] ?? `q${g.q}`;
      case 'or': {
        const s = `${go(g.a, 1)} ∨ ${go(g.b, 1)}`;
        return parentPrec > 1 ? `(${s})` : s;
      }
      case 'and': {
        const s = `${go(g.a, 2)} ∧ ${go(g.b, 2)}`;
        return parentPrec > 2 ? `(${s})` : s;
      }
    }
  };
  return go(f, 0);
}

// ── The automaton ────────────────────────────────────────────────────────────

export interface AFA {
  n: number; // states are 0..n-1
  names: string[]; // display name per state
  symbols: string[]; // the alphabet — each entry is a single-character string
  init: BF; // the initial positive boolean formula over the states
  delta: BF[][]; // delta[q][symbolIndex] : B⁺(Q); default ⊥ (a dead obligation)
  final: boolean[]; // final[q] — the value of state q on the empty word
}

export function symbolIndex(afa: AFA, ch: string): number {
  return afa.symbols.indexOf(ch);
}

/** Map a raw string to the AFA's symbol-index sequence, or null if a char is off-alphabet. */
export function wordToIndices(afa: AFA, word: string): number[] | null {
  const out: number[] = [];
  for (const ch of word) {
    const i = afa.symbols.indexOf(ch);
    if (i < 0) return null;
    out.push(i);
  }
  return out;
}

// ── Brute-force alternating semantics — the oracle ───────────────────────────

/**
 * Decide membership directly from the definition. `acc[pos][q]` is
 * `accept(q, word[pos…])`, filled right-to-left from the final set; the answer
 * is `init` evaluated over `acc[0]`. O(n · |word|) with the suffix memo, and so
 * obviously correct that it is the reference every other road is checked against.
 */
export function afaAccepts(afa: AFA, indices: number[]): boolean {
  const L = indices.length;
  let next = afa.final.slice();
  for (let pos = L - 1; pos >= 0; pos--) {
    const si = indices[pos];
    const cur = new Array<boolean>(afa.n);
    for (let q = 0; q < afa.n; q++) cur[q] = evalBF(afa.delta[q][si], (r) => next[r]);
    next = cur;
  }
  return evalBF(afa.init, (q) => next[q]);
}

/** Convenience: accept a raw string (false if it uses an off-alphabet symbol). */
export function afaAcceptsWord(afa: AFA, word: string): boolean {
  const idx = wordToIndices(afa, word);
  return idx ? afaAccepts(afa, idx) : false;
}

/**
 * The alternating run tree for one word — a witness object for the UI. Each node
 * is `accept(q, suffix)` with its subtree the formula δ(q,a) evaluated over the
 * next positions. Kept shallow (bounded by |word|) so it renders.
 */
export interface RunNode {
  q: number;
  pos: number; // index into the word (pos === L ⇒ empty suffix)
  accept: boolean;
  formula: BF; // the formula evaluated at this node (final-constant at pos === L)
  children: RunNode[]; // one per state variable the formula mentions
}

export function afaRun(afa: AFA, indices: number[]): { accept: boolean; roots: RunNode[] } {
  const L = indices.length;
  // Precompute acc[pos][q] as in afaAccepts.
  const acc: boolean[][] = new Array(L + 1);
  acc[L] = afa.final.slice();
  for (let pos = L - 1; pos >= 0; pos--) {
    const si = indices[pos];
    acc[pos] = afa.final.map((_, q) => evalBF(afa.delta[q][si], (r) => acc[pos + 1][r]));
  }
  const build = (q: number, pos: number): RunNode => {
    if (pos === L) {
      return { q, pos, accept: afa.final[q], formula: afa.final[q] ? BF_TRUE : BF_FALSE, children: [] };
    }
    const si = indices[pos];
    const formula = afa.delta[q][si];
    const vars = [...bfVars(formula)].sort((a, b) => a - b);
    const children = vars.map((r) => build(r, pos + 1));
    return { q, pos, accept: acc[pos][q], formula, children };
  };
  const initVars = [...bfVars(afa.init)].sort((a, b) => a - b);
  const roots = initVars.map((q) => build(q, 0));
  return { accept: evalBF(afa.init, (q) => acc[0][q]), roots };
}

// ── AFA → NFA (the macrostate / subset-of-obligations construction) ──────────

/**
 * Enumerate the subset-minimal models of a formula over `n` variables: the
 * ⊆-minimal sets S of states whose all-true / rest-false assignment satisfies
 * `f`. Positive formulas are monotone, so any model contains a minimal one —
 * minimal models are all the successors the NFA needs. n is small (bounded by
 * the AFA size), so a 2ⁿ sweep is fine.
 */
export function minimalModels(f: BF, n: number): number[] {
  const models: number[] = [];
  for (let mask = 0; mask < 1 << n; mask++) {
    if (evalBF(f, (q) => (mask & (1 << q)) !== 0)) models.push(mask);
  }
  // keep only ⊆-minimal masks
  return models.filter((m) => !models.some((o) => o !== m && (o & m) === o));
}

export interface AfaToNfa {
  nfa: NFA;
  macrostates: number[]; // bitmask of AFA states for each macrostate node (NFA state id → mask)
  truncated: boolean; // construction hit the safety cap
}

const MACRO_CAP = 20000;

/**
 * Build an NFA recognising L(A). A **macrostate** S ⊆ Q means "every state in S
 * must accept the rest of the word" (the ∧-reading). From S on symbol a the
 * successors are the minimal models of `⋀_{q∈S} δ(q,a)`; S accepts the empty
 * word iff S ⊆ F. Initial macrostates are the minimal models of `init`. We wrap
 * them with a fresh single start (ε to each initial macrostate) and a fresh
 * single accept (ε from each accepting macrostate) to fit the Thompson-shaped
 * NFA the rest of the studio consumes.
 */
export function afaToNFA(afa: AFA): AfaToNfa {
  const { n, symbols } = afa;
  const finalMask = afa.final.reduce((m, f, q) => (f ? m | (1 << q) : m), 0);
  const symbolSets = symbols.map((s) => CharSet.fromChar(s.codePointAt(0) ?? 0));

  // Per (state, symbol) minimal models, cached; the conjunction over a macrostate
  // is the union of successor choices across its members (an ∧ of formulas whose
  // minimal models are the products of the members' minimal models).
  const idOf = new Map<number, number>(); // macrostate mask → NFA node id
  const macrostates: number[] = [];
  const START = 0;
  let nextId = 1; // 0 reserved for the fresh start
  const intern = (mask: number): number => {
    const ex = idOf.get(mask);
    if (ex !== undefined) return ex;
    const id = nextId++;
    idOf.set(mask, id);
    macrostates[id] = mask;
    return id;
  };

  const edges: NFAEdge[] = [];
  const initMasks = minimalModels(afa.init, n);
  const queue: number[] = [];
  let truncated = false;

  for (const m of initMasks) {
    const id = intern(m);
    edges.push({ from: START, to: id, set: null }); // ε
    queue.push(m);
  }

  const seen = new Set<number>(initMasks);
  let head = 0;
  while (head < queue.length) {
    const mask = queue[head++];
    const fromId = idOf.get(mask)!;
    for (let si = 0; si < symbols.length; si++) {
      // conjunction ⋀_{q∈mask} δ(q,si)
      let conj: BF = BF_TRUE;
      for (let q = 0; q < n; q++) if (mask & (1 << q)) conj = bfAnd(conj, afa.delta[q][si]);
      const succ = minimalModels(conj, n);
      for (const sm of succ) {
        const toId = intern(sm);
        edges.push({ from: fromId, to: toId, set: symbolSets[si] });
        if (!seen.has(sm)) {
          seen.add(sm);
          queue.push(sm);
          if (nextId > MACRO_CAP) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  // Fresh accept state: ε from every macrostate whose obligations ⊆ F.
  const ACCEPT = nextId++;
  for (const [mask, id] of idOf) {
    if ((mask & ~finalMask & ((1 << n) - 1)) === 0) edges.push({ from: id, to: ACCEPT, set: null });
  }

  const nfa: NFA = { start: START, accept: ACCEPT, stateCount: nextId, edges };
  return { nfa, macrostates, truncated };
}

// ── Boolean closure — the whole point of alternation ─────────────────────────

/**
 * Complement in linear time and *without adding a state*: dualise every δ and
 * the initial formula, and flip the final set. (For the empty word,
 * `accept(q,ε) = q∈F` must become `q∉F`, hence the flip.)
 */
export function complementAFA(afa: AFA): AFA {
  return {
    n: afa.n,
    names: afa.names.slice(),
    symbols: afa.symbols.slice(),
    init: dualBF(afa.init),
    delta: afa.delta.map((row) => row.map(dualBF)),
    final: afa.final.map((f) => !f),
  };
}

/** Merge two AFAs over the disjoint union of their states, combining Σ. */
function combineAFA(a: AFA, b: AFA, connective: 'and' | 'or', tag: string): AFA {
  // Merged alphabet: a's symbols first, then any of b's that are new.
  const symbols = [...a.symbols];
  for (const s of b.symbols) if (!symbols.includes(s)) symbols.push(s);
  const aCol = a.symbols.map((s) => symbols.indexOf(s));
  const bCol = b.symbols.map((s) => symbols.indexOf(s));
  const n = a.n + b.n;
  const names = [...a.names.map((nm) => `A:${nm}`), ...b.names.map((nm) => `B:${nm}`)];
  const delta: BF[][] = Array.from({ length: n }, () => symbols.map(() => BF_FALSE));
  for (let q = 0; q < a.n; q++) for (let si = 0; si < a.symbols.length; si++) delta[q][aCol[si]] = a.delta[q][si];
  for (let q = 0; q < b.n; q++) for (let si = 0; si < b.symbols.length; si++) delta[q + a.n][bCol[si]] = bfShift(b.delta[q][si], a.n);
  const final = [...a.final, ...b.final];
  const init: BF = connective === 'and' ? bfAnd(a.init, bfShift(b.init, a.n)) : bfOr(a.init, bfShift(b.init, a.n));
  void tag;
  return { n, names, symbols, init, delta, final };
}

/** Intersection: ∧ the two initial formulas over the disjoint union — no product. */
export function intersectAFA(a: AFA, b: AFA): AFA {
  return combineAFA(a, b, 'and', '∩');
}

/** Union: ∨ the two initial formulas over the disjoint union. */
export function unionAFA(a: AFA, b: AFA): AFA {
  return combineAFA(a, b, 'or', '∪');
}
