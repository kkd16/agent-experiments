// Antimirov partial derivatives — the studio's *fifth* engine and a *third*,
// independent road from a regular expression to a finite automaton.
//
// Brzozowski's derivative (see `derivatives.ts`) maps a regex and a character
// to a single *residual regex*; iterating it determinises directly to a DFA.
// Antimirov (1996) changed one thing: the **partial** derivative ∂_a(r) is a
// *set* of regexes whose union is Brzozowski's derivative,
//
//     D_a(r) ≡ ⋃ { p | p ∈ ∂_a(r) }.
//
// Keeping the alternatives *apart* instead of folding them into one term turns
// the construction non-deterministic — and that is the whole point. Each
// distinct partial-derivative term becomes one NFA state, and Antimirov proved
// the set of all such terms is not just finite but **small**: at most one state
// per character occurrence in the pattern, plus the start. The result — the
// *equation automaton* (a.k.a. the Antimirov NFA) — is ε-free and typically far
// smaller than Thompson's ε-NFA, which spends ~2 states and a fistful of ε-edges
// on every operator. Two roads to an NFA, mirroring derivatives' two roads to a
// DFA; and determinising *this* NFA lands on the very same minimal machine, a
// third proof of the same theorem.
//
// We reuse the canonical `DReg` algebra from `derivatives.ts` wholesale — its
// similarity simplifications (ACI alternation, ε/∅ identities, idempotent star)
// are exactly what keep the partial-derivative *set* finite.

import type { RegexNode } from './ast';
import { CharSet } from './charset';
import { buildDFA, type DFA } from './dfa';
import type { GraphInput } from './layout';
import { buildNFA, type NFA, type NFAEdge } from './nfa';
import { type DReg, dkey, dsize, fromAst, mkCat, nullable, show } from './derivatives';

const EPS: DReg = { k: 'eps' };

// --- The linear form -------------------------------------------------------
//
// A *monomial* is a head character class paired with its continuation term:
// (S, t) means "reading any code point in S can advance the match, leaving t to
// finish". The **linear form** lf(r) of a regex is its set of monomials —
// equivalently the partial derivatives of r batched by their head class. It is
// the heart of the construction: ∂_a(r) is just the continuations of those
// monomials whose head class contains a, and the equation automaton is the
// graph whose edges are the monomials of every reachable term.
//
//   lf(∅)   = lf(ε)   = {}
//   lf(c)   = {(c, ε)}
//   lf(r|s) = lf(r) ∪ lf(s)
//   lf(r·s) = lf(r)·s ∪ (nullable(r) ? lf(s) : {})        (X·s = {(S, t·s)})
//   lf(r*)  = lf(r)·r*

export interface Monomial {
  set: CharSet; // the head character class
  term: DReg; // the continuation (one NFA successor)
}

// Merge monomials that share a continuation into a single head class, and drop
// any with an empty head. This keeps the automaton tidy: at most one edge per
// (state, successor) pair, its label the union of every class reaching it.
function mergeMonomials(ms: Monomial[]): Monomial[] {
  const byTerm = new Map<string, { sets: CharSet[]; term: DReg }>();
  for (const m of ms) {
    if (m.set.isEmpty()) continue;
    const k = dkey(m.term);
    const e = byTerm.get(k) ?? { sets: [], term: m.term };
    e.sets.push(m.set);
    byTerm.set(k, e);
  }
  return [...byTerm.values()].map((e) => ({ set: CharSet.union(e.sets), term: e.term }));
}

export function linearForm(d: DReg): Monomial[] {
  switch (d.k) {
    case 'emp':
    case 'eps':
      return [];
    case 'chr':
      return [{ set: d.set, term: EPS }];
    case 'alt':
      return mergeMonomials(d.ts.flatMap(linearForm));
    case 'cat': {
      // lf(a·b) = lf(a)·b, plus lf(b) when a can match the empty string.
      const head = linearForm(d.a).map((m) => ({ set: m.set, term: mkCat(m.term, d.b) }));
      return mergeMonomials(nullable(d.a) ? [...head, ...linearForm(d.b)] : head);
    }
    case 'star':
      // lf(a*) = lf(a)·a*  (the star is re-appended to every continuation).
      return mergeMonomials(linearForm(d.a).map((m) => ({ set: m.set, term: mkCat(m.term, d) })));
  }
}

// The partial derivative ∂_c(r): the continuations whose head class admits c.
// A *set* of terms (deduplicated by canonical key) — the union of which is
// exactly Brzozowski's derivative D_c(r).
export function partialDerivative(d: DReg, c: number): DReg[] {
  const out = new Map<string, DReg>();
  for (const m of linearForm(d)) if (m.set.contains(c)) out.set(dkey(m.term), m.term);
  return [...out.values()];
}

// --- Streaming membership (the fifth matching engine) ----------------------
//
// Simulate the equation automaton without ever materialising it: carry the live
// set of terms, and at each character replace it by the union of every term's
// partial derivative. Accept iff some surviving term is nullable. This *is* a
// breadth-first NFA simulation — linear in |input| × (live terms), no
// backtracking — and it answers the same yes/no question as every other engine.

export function acceptsPartialCodes(root: DReg, codes: number[]): boolean {
  let active = new Map<string, DReg>([[dkey(root), root]]);
  for (const c of codes) {
    const next = new Map<string, DReg>();
    for (const t of active.values()) {
      for (const m of linearForm(t)) if (m.set.contains(c)) next.set(dkey(m.term), m.term);
    }
    active = next;
    if (active.size === 0) return false; // every thread died — reject early
  }
  for (const t of active.values()) if (nullable(t)) return true;
  return false;
}

export function acceptsPartial(root: DReg, text: string): boolean {
  return acceptsPartialCodes(
    root,
    Array.from(text, (ch) => ch.codePointAt(0)!),
  );
}

// --- The equation automaton (Antimirov NFA) --------------------------------

export interface PNFAState {
  id: number;
  term: DReg;
  expr: string; // pretty-printed continuation this state stands for
  accept: boolean; // nullable terms are accepting
  start: boolean;
}

export interface PNFAEdge {
  from: number;
  to: number;
  set: CharSet;
}

export interface PNFA {
  start: number;
  states: PNFAState[];
  edges: PNFAEdge[];
  truncated: boolean; // hit the safety cap (should never happen for sane patterns)
  letterBound: number; // Antimirov's bound: #character-classes + 1
}

// Count character-class occurrences — the term in Antimirov's |states| ≤ ‖r‖+1
// bound (the "linear size" guarantee the equation automaton is famous for).
function countLetters(d: DReg): number {
  switch (d.k) {
    case 'chr':
      return 1;
    case 'cat':
      return countLetters(d.a) + countLetters(d.b);
    case 'star':
      return countLetters(d.a);
    case 'alt':
      return d.ts.reduce((n, t) => n + countLetters(t), 0);
    default:
      return 0;
  }
}

const STATE_CAP = 4000;

export function buildAntimirovNFA(root: DReg, cap = STATE_CAP, maxNodes = 6000): PNFA {
  const states: PNFAState[] = [];
  const regs: DReg[] = [];
  const idByKey = new Map<string, number>();
  const edges: PNFAEdge[] = [];
  let truncated = false;

  const intern = (d: DReg): number => {
    const key = dkey(d);
    const found = idByKey.get(key);
    if (found !== undefined) return found;
    const id = states.length;
    idByKey.set(key, id);
    states.push({ id, term: d, expr: show(d), accept: nullable(d), start: id === 0 });
    regs.push(d);
    return id;
  };

  const startId = intern(root);
  const queue = [startId];
  while (queue.length) {
    if (states.length > cap) {
      truncated = true;
      break;
    }
    const id = queue.shift()!;
    const d = regs[id];
    for (const m of linearForm(d)) {
      if (dsize(m.term) > maxNodes) {
        truncated = true;
        queue.length = 0;
        break;
      }
      const before = states.length;
      const to = intern(m.term);
      edges.push({ from: id, to, set: m.set });
      if (to === before) queue.push(to);
    }
  }

  return { start: startId, states, edges, truncated, letterBound: countLetters(root) + 1 };
}

// --- Determinisation: the third road to the canonical DFA ------------------
//
// The equation automaton is an ordinary ε-free NFA, so we can hand it to the
// *same* subset construction the Thompson pipeline uses. We reuse `buildDFA`
// verbatim by lowering the PNFA into the studio's `NFA` shape: a single fresh
// accepting state with an ε-edge in from every nullable term-state. A DFA subset
// then accepts exactly when it contains a nullable term — identical semantics,
// zero reimplementation.

export function pnfaToNFA(p: PNFA): NFA {
  const accept = p.states.length; // one synthetic sink past the real states
  const edges: NFAEdge[] = p.edges.map((e) => ({ from: e.from, to: e.to, set: e.set }));
  for (const s of p.states) if (s.accept) edges.push({ from: s.id, to: accept, set: null });
  return { start: p.start, accept, stateCount: p.states.length + 1, edges };
}

export function buildAntimirovDFA(p: PNFA): DFA {
  return buildDFA(pnfaToNFA(p));
}

// --- Graph adapter ---------------------------------------------------------
// Unlike Thompson's single-accept NFA, the equation automaton has *many*
// accepting states (every nullable term), so we render the accept set directly.

export function pnfaToGraph(p: PNFA): GraphInput {
  return {
    nodes: p.states.map((s) => ({ id: s.id, label: String(s.id) })),
    edges: p.edges.map((e) => ({ from: e.from, to: e.to, label: e.set.label(), epsilon: false })),
    start: p.start,
    accepts: new Set(p.states.filter((s) => s.accept).map((s) => s.id)),
  };
}

// Thompson's ε-NFA size, for the side-by-side "linear size" comparison.
export function thompsonSize(ast: RegexNode): { states: number; edges: number; epsilon: number } {
  const nfa: NFA = buildNFA(ast);
  const epsilon = nfa.edges.filter((e) => e.set === null).length;
  return { states: nfa.stateCount, edges: nfa.edges.length, epsilon };
}

// --- A visible partial-derivative chain (drives the panel) -----------------
//
// The Brzozowski chain shows one residual per step; the Antimirov chain shows
// the *set* of live terms — exactly the NFA's active states as it walks the
// input. The string is accepted iff some live term is nullable when the input
// runs out.

export interface PartialStep {
  char: string | null; // the character consumed to reach this set (null = start)
  terms: string[]; // the live partial-derivative terms (the active NFA states)
  accept: boolean; // is any live term nullable? (accept iff true at the end)
  dead: boolean; // did every thread die? (irrecoverable reject)
}

export function partialChain(root: DReg, text: string): { steps: PartialStep[]; accepted: boolean } {
  const chars = Array.from(text);
  const snapshot = (m: Map<string, DReg>): string[] => [...m.values()].map(show).sort();
  const anyNullable = (m: Map<string, DReg>): boolean => [...m.values()].some(nullable);

  let active = new Map<string, DReg>([[dkey(root), root]]);
  const steps: PartialStep[] = [{ char: null, terms: snapshot(active), accept: anyNullable(active), dead: false }];

  let died = false;
  for (const ch of chars) {
    const c = ch.codePointAt(0)!;
    const next = new Map<string, DReg>();
    for (const t of active.values()) {
      for (const m of linearForm(t)) if (m.set.contains(c)) next.set(dkey(m.term), m.term);
    }
    active = next;
    const dead = active.size === 0;
    steps.push({ char: ch, terms: snapshot(active), accept: anyNullable(active), dead });
    if (dead) {
      died = true;
      break;
    }
  }

  const last = steps[steps.length - 1];
  const accepted = !died && steps.length - 1 === chars.length && last.accept;
  return { steps, accepted };
}

// Convenience: build everything the panel needs from an AST in one call.
export function buildAntimirov(ast: RegexNode): { root: DReg; pnfa: PNFA } {
  const root = fromAst(ast);
  return { root, pnfa: buildAntimirovNFA(root) };
}
