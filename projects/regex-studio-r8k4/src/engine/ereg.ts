// Boolean Brzozowski derivatives — the studio's *fifth road* to an automaton and
// the first that leaves the core algebra behind for the **full Boolean closure**
// of the regular languages: intersection `&`, complement `~`, and difference `−`.
//
// Classically these are the hard ones. Intersection needs the product
// automaton; complement needs a *complete* DFA you then flip; neither has an
// ε-NFA fragment, so Thompson / Glushkov / Antimirov simply cannot express them.
// Brzozowski derivatives, by contrast, extend to them for free:
//
//     ∂c(A & B) = ∂cA & ∂cB            nullable(A & B) = nullable A ∧ nullable B
//     ∂c(~A)    = ~(∂cA)               nullable(~A)    = ¬ nullable A
//
// So the derivative method is the *one* road of the studio's four that builds an
// intersection or a complement directly — deriving once per character and asking
// whether the residual is nullable still decides membership, and treating each
// distinct residual as a state still BFS-walks out a DFA, now over the whole
// Boolean algebra. This module is the self-contained extended algebra `EReg`
// (the core `DReg` plus `and` / `not`), its derivative DFA in the studio's own
// `DFA` shape, and an independent *semantic* oracle to test it against.

import type { RegexNode } from './ast';
import { CharSet, MAX_CODE_POINT } from './charset';
import { atomIndexFor } from './dfa';
import type { Atom, DFA, DFAState, DFATransition } from './dfa';

// --- The extended derivative algebra ----------------------------------------

export type EReg =
  | { k: 'emp' } // ∅ — matches nothing (the true dead state)
  | { k: 'eps' } // ε — matches the empty string
  | { k: 'chr'; set: CharSet } // a single character class
  | { k: 'cat'; a: EReg; b: EReg } // a·b (right-associated)
  | { k: 'alt'; ts: EReg[] } // a|b|… (≥2 sorted, deduped, ∅-free terms)
  | { k: 'star'; a: EReg } // a*
  | { k: 'and'; ts: EReg[] } // a&b&… (≥2 sorted, deduped, ∅-annihilated, Σ*-reduced)
  | { k: 'not'; a: EReg }; // ~a — complement over Σ*

export const EMP: EReg = { k: 'emp' };
export const EPS: EReg = { k: 'eps' };
// Σ* (the universal language) is canonically ~∅: nullable(~∅)=¬false=true and
// ∂c(~∅)=~∅, so it loops accepting on every character — exactly Σ*.
export const TOP: EReg = { k: 'not', a: EMP };
const TOP_KEY = '~∅';

// --- Structural keys & sizes (memoised) -------------------------------------

const keyCache = new WeakMap<object, string>();
export function ekey(d: EReg): string {
  if (d.k === 'emp') return '∅';
  if (d.k === 'eps') return 'ε';
  if (d.k === 'chr') return 'c' + d.set.key();
  const cached = keyCache.get(d);
  if (cached) return cached;
  let s: string;
  if (d.k === 'cat') s = '(' + ekey(d.a) + '·' + ekey(d.b) + ')';
  else if (d.k === 'star') s = ekey(d.a) + '*';
  else if (d.k === 'not') s = '~' + ekey(d.a);
  else if (d.k === 'and') s = '(' + d.ts.map(ekey).join('&') + ')';
  else s = '(' + d.ts.map(ekey).join('|') + ')';
  keyCache.set(d, s);
  return s;
}

const sizeCache = new WeakMap<object, number>();
export function esize(d: EReg): number {
  if (d.k === 'emp' || d.k === 'eps' || d.k === 'chr') return 1;
  const cached = sizeCache.get(d);
  if (cached !== undefined) return cached;
  let n: number;
  if (d.k === 'cat') n = 1 + esize(d.a) + esize(d.b);
  else if (d.k === 'star' || d.k === 'not') n = 1 + esize(d.a);
  else n = 1 + d.ts.reduce((s, t) => s + esize(t), 0);
  sizeCache.set(d, n);
  return n;
}

// --- Smart constructors (the similarity simplifications) --------------------

export function mkCat(a: EReg, b: EReg): EReg {
  if (a.k === 'emp' || b.k === 'emp') return EMP;
  if (a.k === 'eps') return b;
  if (b.k === 'eps') return a;
  if (a.k === 'cat') return mkCat(a.a, mkCat(a.b, b));
  return { k: 'cat', a, b };
}

export function mkAlt(...parts: EReg[]): EReg {
  const byKey = new Map<string, EReg>();
  let sawTop = false;
  const push = (d: EReg) => {
    if (d.k === 'emp') return; // r|∅ = r
    if (ekey(d) === TOP_KEY) sawTop = true; // r|Σ* = Σ*
    if (d.k === 'alt') {
      d.ts.forEach(push);
      return;
    }
    byKey.set(ekey(d), d);
  };
  for (const p of parts) push(p);
  if (sawTop) return TOP;
  const ts = [...byKey.values()].sort((x, y) => (ekey(x) < ekey(y) ? -1 : 1));
  if (ts.length === 0) return EMP;
  if (ts.length === 1) return ts[0];
  return { k: 'alt', ts };
}

export function mkStar(a: EReg): EReg {
  if (a.k === 'emp' || a.k === 'eps') return EPS;
  if (a.k === 'star') return a;
  if (ekey(a) === TOP_KEY) return TOP; // (Σ*)* = Σ*
  return { k: 'star', a };
}

export function mkAnd(...parts: EReg[]): EReg {
  const byKey = new Map<string, EReg>();
  let annihilate = false;
  const push = (d: EReg) => {
    if (d.k === 'emp') {
      annihilate = true; // ∅ ∩ r = ∅
      return;
    }
    if (ekey(d) === TOP_KEY) return; // Σ* ∩ r = r — drop the identity
    if (d.k === 'and') {
      d.ts.forEach(push); // flatten (associativity)
      return;
    }
    byKey.set(ekey(d), d); // dedup (idempotence)
  };
  for (const p of parts) push(p);
  if (annihilate) return EMP;
  const ts = [...byKey.values()].sort((x, y) => (ekey(x) < ekey(y) ? -1 : 1)); // commutativity
  if (ts.length === 0) return TOP; // ∩ of nothing = the universal language
  if (ts.length === 1) return ts[0];
  return { k: 'and', ts };
}

export function mkNot(a: EReg): EReg {
  if (a.k === 'not') return a.a; // ~~r = r (involution)
  return { k: 'not', a };
}

// --- AST → extended algebra -------------------------------------------------

export function fromAstE(node: RegexNode): EReg {
  switch (node.type) {
    case 'empty':
      return EPS;
    case 'char':
      return node.set.isEmpty() ? EMP : { k: 'chr', set: node.set };
    case 'group':
      return fromAstE(node.node);
    case 'concat':
      return node.parts.reduceRight<EReg>((acc, p) => mkCat(fromAstE(p), acc), EPS);
    case 'alt':
      return mkAlt(...node.options.map(fromAstE));
    case 'star':
      return mkStar(fromAstE(node.node));
    case 'plus': {
      const a = fromAstE(node.node);
      return mkCat(a, mkStar(a));
    }
    case 'opt':
      return mkAlt(EPS, fromAstE(node.node));
    case 'repeat': {
      const a = fromAstE(node.node);
      let out: EReg = EPS;
      for (let i = 0; i < node.min; i++) out = mkCat(out, a);
      if (node.max === null) out = mkCat(out, mkStar(a));
      else for (let i = node.min; i < node.max; i++) out = mkCat(out, mkAlt(EPS, a));
      return out;
    }
    case 'intersect':
      return mkAnd(...node.parts.map(fromAstE));
    case 'complement':
      return mkNot(fromAstE(node.node));
    case 'anchor':
    case 'boundary':
    case 'backref':
    case 'look':
      throw new Error(`ereg: '${node.type}' is not a regular construct`);
  }
}

// --- The two core operations ------------------------------------------------

export function nullableE(d: EReg): boolean {
  switch (d.k) {
    case 'emp':
    case 'chr':
      return false;
    case 'eps':
    case 'star':
      return true;
    case 'cat':
      return nullableE(d.a) && nullableE(d.b);
    case 'alt':
      return d.ts.some(nullableE);
    case 'and':
      return d.ts.every(nullableE);
    case 'not':
      return !nullableE(d.a);
  }
}

export function derivativeE(d: EReg, c: number): EReg {
  switch (d.k) {
    case 'emp':
    case 'eps':
      return EMP;
    case 'chr':
      return d.set.contains(c) ? EPS : EMP;
    case 'cat': {
      const left = mkCat(derivativeE(d.a, c), d.b);
      return nullableE(d.a) ? mkAlt(left, derivativeE(d.b, c)) : left;
    }
    case 'alt':
      return mkAlt(...d.ts.map((t) => derivativeE(t, c)));
    case 'star':
      return mkCat(derivativeE(d.a, c), d);
    case 'and':
      return mkAnd(...d.ts.map((t) => derivativeE(t, c)));
    case 'not':
      return mkNot(derivativeE(d.a, c));
  }
}

// --- Streaming full-string match --------------------------------------------

export function acceptsCodesE(d: EReg, codes: number[]): boolean {
  let cur = d;
  for (const c of codes) {
    cur = derivativeE(cur, c);
    if (cur.k === 'emp') return false; // genuinely dead — stop early
  }
  return nullableE(cur);
}

export function acceptsE(d: EReg, text: string): boolean {
  return acceptsCodesE(d, Array.from(text, (ch) => ch.codePointAt(0)!));
}

// --- Pretty-printer ---------------------------------------------------------
// Levels: 0 alt(|) · 1 and(&) · 2 cat · 3 postfix(*)/prefix(~) · 4 atom.
export function showE(d: EReg, prec = 0): string {
  switch (d.k) {
    case 'emp':
      return '∅';
    case 'eps':
      return 'ε';
    case 'chr':
      return d.set.label();
    case 'star': {
      const s = showE(d.a, 3) + '*';
      return prec > 3 ? `(${s})` : s;
    }
    case 'not': {
      if (ekey(d) === TOP_KEY) return 'Σ*';
      const s = '~' + showE(d.a, 3);
      return prec > 3 ? `(${s})` : s;
    }
    case 'cat': {
      const s = showE(d.a, 2) + showE(d.b, 2);
      return prec > 2 ? `(${s})` : s;
    }
    case 'and': {
      const s = d.ts.map((t) => showE(t, 2)).join(' & ');
      return prec > 1 ? `(${s})` : s;
    }
    case 'alt': {
      const s = d.ts.map((t) => showE(t, 1)).join('|');
      return prec > 0 ? `(${s})` : s;
    }
  }
}

export function hasNot(d: EReg): boolean {
  switch (d.k) {
    case 'not':
      return true;
    case 'cat':
      return hasNot(d.a) || hasNot(d.b);
    case 'star':
      return hasNot(d.a);
    case 'alt':
    case 'and':
      return d.ts.some(hasNot);
    default:
      return false;
  }
}

// --- Alphabet partition -----------------------------------------------------
// Like the subset construction's, but **complete** when a complement is present:
// ∂c(~A) stays alive on characters A never mentions, so "every other character"
// must route to a real state, not the implicit dead sink. We therefore partition
// the *whole* of Σ (covered and uncovered ranges) into atoms. With no complement
// we keep only the covered ranges — identical to the plain derivative DFA, so a
// regular pattern still minimises to the very same canonical machine.

export function eregAtoms(d: EReg): Atom[] {
  const complete = hasNot(d);
  const cuts = new Set<number>();
  const sets: CharSet[] = [];
  const walk = (n: EReg): void => {
    switch (n.k) {
      case 'chr':
        sets.push(n.set);
        for (const r of n.set.ranges) {
          cuts.add(r.lo);
          cuts.add(r.hi + 1);
        }
        return;
      case 'cat':
        walk(n.a);
        walk(n.b);
        return;
      case 'star':
      case 'not':
        walk(n.a);
        return;
      case 'alt':
      case 'and':
        n.ts.forEach(walk);
        return;
      default:
        return;
    }
  };
  walk(d);
  if (complete) {
    cuts.add(0);
    cuts.add(MAX_CODE_POINT + 1);
  }
  if (sets.length === 0 && !complete) return [];
  const covered = CharSet.union(sets);
  const points = [...cuts].sort((a, b) => a - b);
  const atoms: Atom[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1] - 1;
    if (lo > hi) continue;
    if (complete || covered.contains(lo)) atoms.push({ set: CharSet.fromRange(lo, hi), lo, hi });
  }
  return atoms;
}

// --- The derivative DFA -----------------------------------------------------

export interface EregDFA extends DFA {
  exprs: string[];
  truncated: boolean;
  complete: boolean; // whether the alphabet was completed (a complement is present)
}

const STATE_CAP = 4000;

export function buildEregDFA(root: EReg, cap = STATE_CAP, maxNodes = 8000): EregDFA {
  const atoms = eregAtoms(root);
  const complete = hasNot(root);
  const states: DFAState[] = [];
  const exprs: string[] = [];
  const regs: EReg[] = [];
  const table: number[][] = [];
  const idByKey = new Map<string, number>();
  let truncated = false;

  const intern = (d: EReg): number => {
    const key = ekey(d);
    const found = idByKey.get(key);
    if (found !== undefined) return found;
    const id = states.length;
    idByKey.set(key, id);
    states.push({ id, nfaStates: [], accept: nullableE(d) });
    exprs.push(showE(d));
    regs.push(d);
    table.push(new Array(atoms.length).fill(-1));
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
    for (let a = 0; a < atoms.length; a++) {
      const nd = derivativeE(d, atoms[a].lo);
      if (nd.k === 'emp') continue; // the dead sink stays implicit (table -1)
      if (esize(nd) > maxNodes) {
        truncated = true;
        queue.length = 0;
        break;
      }
      const before = states.length;
      const to = intern(nd);
      table[id][a] = to;
      if (to === before) queue.push(to);
    }
  }

  const edgeAccum = new Map<string, { from: number; to: number; sets: CharSet[] }>();
  for (let from = 0; from < states.length; from++) {
    for (let a = 0; a < atoms.length; a++) {
      const to = table[from][a];
      if (to < 0) continue;
      const ekeyEdge = `${from}->${to}`;
      const acc = edgeAccum.get(ekeyEdge) ?? { from, to, sets: [] };
      acc.sets.push(atoms[a].set);
      edgeAccum.set(ekeyEdge, acc);
    }
  }
  const transitions: DFATransition[] = [...edgeAccum.values()].map((e) => ({
    from: e.from,
    to: e.to,
    set: CharSet.union(e.sets),
  }));

  return {
    start: startId,
    states,
    transitions,
    atoms,
    table: table.map((row) => Int32Array.from(row)),
    exprs,
    truncated,
    complete,
  };
}

// --- The visible Boolean-derivative chain (drives the panel) ----------------

export interface DerivStepE {
  char: string | null;
  expr: string;
  nullable: boolean;
  dead: boolean;
}

// The DFA-state path the test text walks: `states[i]` is the state after reading
// `i` characters (`states[0]` is the start). Stops at the implicit dead sink
// (a trailing `-1`), so the residual chain and the lit graph state stay aligned.
export function eregDFAPath(dfa: EregDFA, text: string): number[] {
  const codes = Array.from(text, (ch) => ch.codePointAt(0)!);
  const states: number[] = [dfa.start];
  let s = dfa.start;
  for (const c of codes) {
    const idx = atomIndexFor(dfa.atoms, c);
    s = idx < 0 ? -1 : dfa.table[s][idx];
    states.push(s);
    if (s < 0) break;
  }
  return states;
}

export function derivativeChainE(d: EReg, text: string): { steps: DerivStepE[]; accepted: boolean } {
  const chars = Array.from(text);
  const steps: DerivStepE[] = [{ char: null, expr: showE(d), nullable: nullableE(d), dead: d.k === 'emp' }];
  let cur = d;
  for (const ch of chars) {
    cur = derivativeE(cur, ch.codePointAt(0)!);
    steps.push({ char: ch, expr: showE(cur), nullable: nullableE(cur), dead: cur.k === 'emp' });
    if (cur.k === 'emp') break;
  }
  const last = steps[steps.length - 1];
  return { steps, accepted: steps.length - 1 === chars.length && last.nullable };
}

// --- An independent semantic oracle -----------------------------------------
//
// Membership decided *without* derivatives, straight from the algebraic
// definition of each operator on spans. `ends(E, codes, i)` is the set of end
// positions `j` such that `E` matches the substring `codes[i..j)`. The Boolean
// cases fall out of the definitions:
//
//     ends(A & B, i) = ends(A, i) ∩ ends(B, i)
//     ends(~A, i)    = { j ∈ [i, n] : j ∉ ends(A, i) }
//
// because "~A matches the span [i,j)" is exactly "A does not". This is a second,
// structurally-different engine — the differential fuzzer cross-checks the DFA
// and the streaming derivative against it.

export function ends(e: EReg, codes: number[], i: number): Set<number> {
  const n = codes.length;
  switch (e.k) {
    case 'emp':
      return new Set();
    case 'eps':
      return new Set([i]);
    case 'chr':
      return i < n && e.set.contains(codes[i]) ? new Set([i + 1]) : new Set();
    case 'cat': {
      const out = new Set<number>();
      for (const j of ends(e.a, codes, i)) for (const k of ends(e.b, codes, j)) out.add(k);
      return out;
    }
    case 'alt': {
      const out = new Set<number>();
      for (const t of e.ts) for (const j of ends(t, codes, i)) out.add(j);
      return out;
    }
    case 'star': {
      const out = new Set<number>([i]);
      const stack = [i];
      while (stack.length) {
        const j = stack.pop()!;
        for (const k of ends(e.a, codes, j)) {
          if (out.has(k)) continue;
          out.add(k);
          if (k > j) stack.push(k); // k===j is an empty iteration — already covered
        }
      }
      return out;
    }
    case 'and': {
      let acc: Set<number> | null = null;
      for (const t of e.ts) {
        const s = ends(t, codes, i);
        if (acc === null) {
          acc = s;
        } else {
          const filtered = new Set<number>();
          for (const x of acc) if (s.has(x)) filtered.add(x);
          acc = filtered;
        }
        if (acc.size === 0) break;
      }
      // ∩ of nothing = Σ*, which matches every span from i.
      if (acc === null) {
        const all = new Set<number>();
        for (let j = i; j <= n; j++) all.add(j);
        return all;
      }
      return acc;
    }
    case 'not': {
      const inner = ends(e.a, codes, i);
      const out = new Set<number>();
      for (let j = i; j <= n; j++) if (!inner.has(j)) out.add(j);
      return out;
    }
  }
}

export function acceptsOracle(e: EReg, codes: number[]): boolean {
  return ends(e, codes, 0).has(codes.length);
}
