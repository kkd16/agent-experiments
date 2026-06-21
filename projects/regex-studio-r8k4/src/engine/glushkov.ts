// Glushkov's construction — the studio's *fourth* independent road from a
// regular expression to a finite automaton (after Thompson's ε-NFA, Brzozowski's
// derivative DFA and Antimirov's equation automaton).
//
// Where Thompson spends ~two states and a fistful of ε-edges on every operator,
// Glushkov (1961) / McNaughton–Yamada (1960) build an **ε-free** NFA with one
// state per *letter occurrence* in the pattern, plus a single start state — so a
// pattern with m letters yields exactly m+1 states. The trick is to first
// *linearise* the regex, giving every character occurrence a distinct **position**
// 1…m, and then read four classic functions straight off the syntax tree:
//
//   nullable(E)  — can E match the empty string?
//   first(E)     — positions that can begin a match of E
//   last(E)      — positions that can end a match of E
//   follow(E, p) — positions that can immediately follow position p inside E
//
// The automaton is then mechanical: the start state 0 goes to every first
// position; every position p goes to every q ∈ follow(p); a state is accepting
// iff its position is in last(E) (and 0 is accepting iff E is nullable). Because
// *all* edges entering position q carry the same label (the class at q), the
// position automaton is **homogeneous** — a property we verify below.
//
// This is the missing middle of the studio's size story: Thompson (ε-laden) →
// Glushkov (ε-free, exactly m+1) → Antimirov (ε-free, a *quotient* of Glushkov,
// often smaller still). Determinising the position automaton lands on the very
// same canonical minimal DFA the other three roads reach — a fourth proof of one
// theorem. We reuse the studio's `buildDFA` verbatim by lowering the position
// automaton into the existing `NFA` shape, so it flows into the graph / language
// / minimise / fuzz views unchanged.

import type { RegexNode } from './ast';
import { CharSet } from './charset';
import { buildDFA, type DFA } from './dfa';
import type { GraphInput } from './layout';
import { buildNFA, type NFA, type NFAEdge } from './nfa';

// --- Linearised ("position") regex -----------------------------------------
//
// A small regex type in which every character class carries a unique position
// index. We linearise the parser's AST (not the canonical derivative algebra)
// so each *occurrence* of a letter is its own position — that is what makes the
// state count exactly "letters + 1" and keeps the automaton faithful to the
// written pattern. Quantifiers `*` `+` `?` are handled directly (one position
// each); `{m,n}` is expanded to explicit copies, each copy a fresh occurrence,
// matching how the rest of the studio desugars bounded repetition.

export type PReg =
  | { k: 'emp' } // ∅ — matches nothing (an empty character class)
  | { k: 'eps' } // ε — matches the empty string
  | { k: 'pos'; pos: number } // a single linearised letter (its class is positions[pos])
  | { k: 'cat'; a: PReg; b: PReg }
  | { k: 'alt'; ts: PReg[] }
  | { k: 'star'; a: PReg }
  | { k: 'plus'; a: PReg }
  | { k: 'opt'; a: PReg };

export interface Linearised {
  reg: PReg;
  positions: CharSet[]; // positions[p] = the character class at position p (1-indexed; [0] unused)
}

const EPS: PReg = { k: 'eps' };
const EMP: PReg = { k: 'emp' };

class Linealiser {
  positions: CharSet[] = [CharSet.empty()]; // index 0 is the unused start sentinel
  private cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  private fresh(set: CharSet): PReg {
    const pos = this.positions.length;
    this.positions.push(set);
    if (pos > this.cap) throw new GlushkovTooBig(this.cap);
    return { k: 'pos', pos };
  }
  walk(node: RegexNode): PReg {
    switch (node.type) {
      case 'empty':
        return EPS;
      case 'char':
        return node.set.isEmpty() ? EMP : this.fresh(node.set);
      case 'group':
        return this.walk(node.node);
      case 'concat': {
        if (node.parts.length === 0) return EPS;
        return node.parts.map((p) => this.walk(p)).reduce((a, b) => ({ k: 'cat', a, b }));
      }
      case 'alt':
        return { k: 'alt', ts: node.options.map((o) => this.walk(o)) };
      case 'star':
        return { k: 'star', a: this.walk(node.node) };
      case 'plus':
        return { k: 'plus', a: this.walk(node.node) };
      case 'opt':
        return { k: 'opt', a: this.walk(node.node) };
      case 'repeat': {
        // Expand {m,n} to explicit copies — each copy is a distinct occurrence,
        // so it gets fresh positions (faithful to the written pattern).
        const parts: PReg[] = [];
        for (let i = 0; i < node.min; i++) parts.push(this.walk(node.node));
        if (node.max === null) {
          parts.push({ k: 'star', a: this.walk(node.node) }); // {m,} = aᵐ·a*
        } else {
          for (let i = node.min; i < node.max; i++) parts.push({ k: 'opt', a: this.walk(node.node) });
        }
        if (parts.length === 0) return EPS;
        return parts.reduce((a, b) => ({ k: 'cat', a, b }));
      }
      // Non-regular constructs never reach here: callers gate on `features.regular`.
      case 'anchor':
      case 'boundary':
      case 'backref':
      case 'look':
      case 'intersect':
      case 'complement':
        throw new Error(`glushkov: '${node.type}' is not a regular construct`);
    }
  }
}

export class GlushkovTooBig extends Error {
  constructor(cap: number) {
    super(`glushkov: linearised pattern exceeds ${cap} positions`);
    this.name = 'GlushkovTooBig';
  }
}

export function linearise(ast: RegexNode, cap = 4000): Linearised {
  const l = new Linealiser(cap);
  const reg = l.walk(ast);
  return { reg, positions: l.positions };
}

// --- nullable / first / last / follow --------------------------------------

export function pNullable(r: PReg): boolean {
  switch (r.k) {
    case 'emp':
    case 'pos':
      return false;
    case 'eps':
    case 'star':
    case 'opt':
      return true;
    case 'plus':
      return pNullable(r.a);
    case 'cat':
      return pNullable(r.a) && pNullable(r.b);
    case 'alt':
      return r.ts.some(pNullable);
  }
}

function firstSet(r: PReg): number[] {
  switch (r.k) {
    case 'emp':
    case 'eps':
      return [];
    case 'pos':
      return [r.pos];
    case 'star':
    case 'plus':
    case 'opt':
      return firstSet(r.a);
    case 'cat':
      return pNullable(r.a) ? union(firstSet(r.a), firstSet(r.b)) : firstSet(r.a);
    case 'alt':
      return r.ts.reduce<number[]>((acc, t) => union(acc, firstSet(t)), []);
  }
}

function lastSet(r: PReg): number[] {
  switch (r.k) {
    case 'emp':
    case 'eps':
      return [];
    case 'pos':
      return [r.pos];
    case 'star':
    case 'plus':
    case 'opt':
      return lastSet(r.a);
    case 'cat':
      return pNullable(r.b) ? union(lastSet(r.a), lastSet(r.b)) : lastSet(r.b);
    case 'alt':
      return r.ts.reduce<number[]>((acc, t) => union(acc, lastSet(t)), []);
  }
}

// follow(p) for every position, accumulated into one map.
function followMap(r: PReg, follow: Map<number, Set<number>>): void {
  const add = (from: number[], to: number[]) => {
    for (const p of from) {
      let s = follow.get(p);
      if (!s) follow.set(p, (s = new Set()));
      for (const q of to) s.add(q);
    }
  };
  switch (r.k) {
    case 'cat':
      followMap(r.a, follow);
      followMap(r.b, follow);
      add(lastSet(r.a), firstSet(r.b));
      return;
    case 'alt':
      for (const t of r.ts) followMap(t, follow);
      return;
    case 'star':
    case 'plus':
      followMap(r.a, follow);
      add(lastSet(r.a), firstSet(r.a)); // the loop: a last can be followed by a first
      return;
    case 'opt':
      followMap(r.a, follow);
      return;
    default:
      return; // pos / eps / emp contribute no internal follows
  }
}

// --- The position automaton -------------------------------------------------

export interface PosEdge {
  from: number; // a position (0 = start)
  to: number; // a position 1…m
  set: CharSet; // the class at `to` (all in-edges to `to` share this label)
}

export interface PositionAutomaton {
  start: number; // always 0
  positions: CharSet[]; // [0] unused sentinel; [1…m] the linearised classes
  first: number[]; // first(E) — successors of the start state
  last: Set<number>; // last(E) — the accepting positions
  follow: Map<number, Set<number>>; // follow(p) for every position
  edges: PosEdge[];
  nullableStart: boolean; // is the empty string accepted? (⇒ state 0 is accepting)
  homogeneous: boolean; // verified: every in-edge to a state carries the same label
  m: number; // number of positions (letter occurrences)
}

export function buildPositionAutomaton(lin: Linearised): PositionAutomaton {
  const { reg, positions } = lin;
  const m = positions.length - 1;
  const first = firstSet(reg).sort((a, b) => a - b);
  const last = new Set(lastSet(reg));
  const follow = new Map<number, Set<number>>();
  followMap(reg, follow);

  const edges: PosEdge[] = [];
  for (const q of first) edges.push({ from: 0, to: q, set: positions[q] });
  for (let p = 1; p <= m; p++) {
    const fs = follow.get(p);
    if (!fs) continue;
    for (const q of [...fs].sort((a, b) => a - b)) edges.push({ from: p, to: q, set: positions[q] });
  }

  // Homogeneity check: every edge into a position carries that position's class.
  let homogeneous = true;
  for (const e of edges) if (!e.set.equals(positions[e.to])) homogeneous = false;

  return {
    start: 0,
    positions,
    first,
    last,
    follow,
    edges,
    nullableStart: pNullable(reg),
    homogeneous,
    m,
  };
}

// --- Lower into the studio's NFA shape → reuse buildDFA (the fourth road) ----
//
// The position automaton is an ordinary ε-free NFA, so we hand it to the *same*
// subset construction the Thompson pipeline uses. A single synthetic accept
// state collects an ε-edge from each accepting position (and from state 0 when
// the pattern is nullable), so a DFA subset accepts exactly when it contains an
// accepting position — identical semantics, zero reimplementation.

export function positionToNFA(pa: PositionAutomaton): NFA {
  const accept = pa.m + 1; // one synthetic sink past positions 0…m
  const edges: NFAEdge[] = pa.edges.map((e) => ({ from: e.from, to: e.to, set: e.set }));
  for (const p of pa.last) edges.push({ from: p, to: accept, set: null });
  if (pa.nullableStart) edges.push({ from: 0, to: accept, set: null });
  return { start: 0, accept, stateCount: pa.m + 2, edges };
}

export function buildGlushkovDFA(pa: PositionAutomaton): DFA {
  return buildDFA(positionToNFA(pa));
}

// --- Streaming membership (a from-scratch matching engine) ------------------
//
// Simulate the position automaton without ever materialising a DFA: carry the
// live set of positions and, per character, replace it by the union of every
// live position's follow-set restricted to positions whose class admits the
// character. Accept iff a live position is in last (or the empty input is
// nullable). This *is* a breadth-first NFA simulation — linear in
// |input| × (live positions), no backtracking.

export function acceptsGlushkovCodes(pa: PositionAutomaton, codes: number[]): boolean {
  if (codes.length === 0) return pa.nullableStart;
  // First character: start at state 0, step to admitting first-positions.
  let active = new Set<number>();
  for (const q of pa.first) if (pa.positions[q].contains(codes[0])) active.add(q);
  for (let i = 1; i < codes.length; i++) {
    if (active.size === 0) return false;
    const c = codes[i];
    const next = new Set<number>();
    for (const p of active) {
      const fs = pa.follow.get(p);
      if (!fs) continue;
      for (const q of fs) if (pa.positions[q].contains(c)) next.add(q);
    }
    active = next;
  }
  for (const p of active) if (pa.last.has(p)) return true;
  return false;
}

export function acceptsGlushkov(pa: PositionAutomaton, text: string): boolean {
  return acceptsGlushkovCodes(
    pa,
    Array.from(text, (ch) => ch.codePointAt(0)!),
  );
}

// --- A visible position chain (drives the panel) ---------------------------
// Mirrors the Brzozowski / Antimirov chains: the live position set per character
// — literally the position automaton's active states as it walks the input.

export interface PositionStep {
  char: string | null; // the character consumed to reach this set (null = start)
  active: number[]; // the live positions (the NFA's active states)
  accept: boolean; // is a live position accepting? (accept iff true at the end)
  dead: boolean; // did every thread die?
}

export function positionChain(pa: PositionAutomaton, text: string): { steps: PositionStep[]; accepted: boolean } {
  const chars = Array.from(text);
  const isAccepting = (s: Set<number>): boolean => [...s].some((p) => pa.last.has(p));

  // The start "set" is conceptual state {0}; 0 accepts iff the pattern is nullable.
  const steps: PositionStep[] = [
    { char: null, active: [0], accept: pa.nullableStart, dead: false },
  ];
  let active = new Set<number>([0]);
  let died = false;
  let firstStep = true;
  for (const ch of chars) {
    const c = ch.codePointAt(0)!;
    const next = new Set<number>();
    if (firstStep) {
      for (const q of pa.first) if (pa.positions[q].contains(c)) next.add(q);
      firstStep = false;
    } else {
      for (const p of active) {
        const fs = pa.follow.get(p);
        if (!fs) continue;
        for (const q of fs) if (pa.positions[q].contains(c)) next.add(q);
      }
    }
    active = next;
    const dead = active.size === 0;
    steps.push({ char: ch, active: [...active].sort((a, b) => a - b), accept: isAccepting(active), dead });
    if (dead) {
      died = true;
      break;
    }
  }

  const last = steps[steps.length - 1];
  const accepted = !died && steps.length - 1 === chars.length && last.accept;
  return { steps, accepted };
}

// --- Graph adapter ----------------------------------------------------------
// The position automaton has many accepting states (everything in `last`, plus
// the start when nullable), so we render the accept set directly.

export function positionToGraph(pa: PositionAutomaton): GraphInput {
  const nodes = pa.positions.map((_, id) => ({ id, label: id === 0 ? 'ι' : String(id) }));
  const accepts = new Set<number>(pa.last);
  if (pa.nullableStart) accepts.add(0);
  return {
    nodes,
    edges: pa.edges.map((e) => ({ from: e.from, to: e.to, label: e.set.label(), epsilon: false })),
    start: 0,
    accepts,
  };
}

// Thompson's ε-NFA size, for the side-by-side "ε-free, exactly m+1" comparison.
export function thompsonSize(ast: RegexNode): { states: number; edges: number; epsilon: number } {
  const nfa: NFA = buildNFA(ast);
  const epsilon = nfa.edges.filter((e) => e.set === null).length;
  return { states: nfa.stateCount, edges: nfa.edges.length, epsilon };
}

// --- The first/last/follow tables (drives the panel) ------------------------

export interface FollowRow {
  pos: number;
  label: string; // the class at this position
  follow: number[]; // follow(pos)
  isFirst: boolean; // pos ∈ first(E)
  isLast: boolean; // pos ∈ last(E)
}

export function followTable(pa: PositionAutomaton): FollowRow[] {
  const firstSetS = new Set(pa.first);
  const rows: FollowRow[] = [];
  for (let p = 1; p <= pa.m; p++) {
    rows.push({
      pos: p,
      label: pa.positions[p].label(),
      follow: [...(pa.follow.get(p) ?? new Set<number>())].sort((a, b) => a - b),
      isFirst: firstSetS.has(p),
      isLast: pa.last.has(p),
    });
  }
  return rows;
}

// Convenience: build everything the panel/fuzzer needs from an AST in one call.
export function buildGlushkov(ast: RegexNode, cap = 4000): PositionAutomaton {
  return buildPositionAutomaton(linearise(ast, cap));
}

// --- tiny sorted-unique integer set helpers ---------------------------------

function union(a: number[], b: number[]): number[] {
  if (b.length === 0) return a;
  const s = new Set(a);
  for (const x of b) s.add(x);
  return [...s];
}
