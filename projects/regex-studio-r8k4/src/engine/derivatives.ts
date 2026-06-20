// Brzozowski derivatives — the app's *fourth* engine and a second, independent
// road from a regex to a DFA.
//
// The Thompson→subset pipeline first builds an ε-NFA and then determinises it.
// Brzozowski (1964) skips the NFA entirely: the **derivative** of a language L
// with respect to a character c is the set of suffixes w such that c·w ∈ L,
//
//     D_c(L) = { w | c·w ∈ L }.
//
// Crucially the derivative of a *regular expression* is again a regular
// expression, computed by a handful of structural rules. A string is accepted
// iff, after taking the derivative once per character, the residual expression
// is **nullable** (matches the empty string). And if we treat each distinct
// derivative (up to a few algebraic simplifications) as a DFA state, BFS over
// the derivatives yields a DFA *directly from the regex* — no NFA, no subset
// construction. This module implements both: a streaming matcher and the
// derivative-DFA builder, the latter reusing the very same `DFA` structure the
// subset construction produces, so it flows into the graph / language / minimise
// views unchanged. The two DFAs differ before minimisation but minimise to the
// same machine — two proofs of the same theorem.

import type { RegexNode } from './ast';
import { CharSet } from './charset';
import type { Atom, DFA, DFAState, DFATransition } from './dfa';

// --- The derivative regex algebra ------------------------------------------
//
// A small, *canonicalised* expression type distinct from the parser's AST.
// Canonical forms are what make the set of derivatives finite (Brzozowski's
// "similarity"): alternation is treated as an associative-commutative-idempotent
// set of terms, concatenation is right-associated with ε/∅ identities applied,
// and star is idempotent. Without these the derivative chain would never repeat
// and the DFA would be infinite.

export type DReg =
  | { k: 'emp' } // ∅ — matches nothing (the dead state)
  | { k: 'eps' } // ε — matches the empty string
  | { k: 'chr'; set: CharSet } // a single character class
  | { k: 'cat'; a: DReg; b: DReg } // a·b (right-associated)
  | { k: 'alt'; ts: DReg[] } // a|b|… (≥2 sorted, deduped, ∅-free terms)
  | { k: 'star'; a: DReg }; // a*

const EMP: DReg = { k: 'emp' };
const EPS: DReg = { k: 'eps' };

// --- Structural keys (memoised) --------------------------------------------
// A stable canonical string per node, used to dedup alternation terms and to
// intern DFA states. Memoised on the node so deep trees stay cheap.
const keyCache = new WeakMap<object, string>();

export function dkey(d: DReg): string {
  if (d.k === 'emp') return '∅';
  if (d.k === 'eps') return 'ε';
  if (d.k === 'chr') return 'c' + d.set.key();
  const cached = keyCache.get(d);
  if (cached) return cached;
  let s: string;
  if (d.k === 'cat') s = '(' + dkey(d.a) + '·' + dkey(d.b) + ')';
  else if (d.k === 'star') s = dkey(d.a) + '*';
  else s = '(' + d.ts.map(dkey).join('|') + ')';
  keyCache.set(d, s);
  return s;
}

// Node count, memoised — a cheap proxy for "how expensive will deriving this be".
const sizeCache = new WeakMap<object, number>();
export function dsize(d: DReg): number {
  if (d.k === 'emp' || d.k === 'eps' || d.k === 'chr') return 1;
  const cached = sizeCache.get(d);
  if (cached !== undefined) return cached;
  let n: number;
  if (d.k === 'cat') n = 1 + dsize(d.a) + dsize(d.b);
  else if (d.k === 'star') n = 1 + dsize(d.a);
  else n = 1 + d.ts.reduce((s, t) => s + dsize(t), 0);
  sizeCache.set(d, n);
  return n;
}

// --- Smart constructors (apply the similarity simplifications) --------------

export function mkCat(a: DReg, b: DReg): DReg {
  if (a.k === 'emp' || b.k === 'emp') return EMP; // ∅·r = r·∅ = ∅
  if (a.k === 'eps') return b; // ε·r = r
  if (b.k === 'eps') return a; // r·ε = r
  if (a.k === 'cat') return mkCat(a.a, mkCat(a.b, b)); // right-associate
  return { k: 'cat', a, b };
}

export function mkAlt(...parts: DReg[]): DReg {
  const byKey = new Map<string, DReg>();
  const push = (d: DReg) => {
    if (d.k === 'emp') return; // r|∅ = r
    if (d.k === 'alt') {
      d.ts.forEach(push); // flatten (associativity)
      return;
    }
    byKey.set(dkey(d), d); // dedup (idempotence)
  };
  for (const p of parts) push(p);
  const ts = [...byKey.values()].sort((x, y) => (dkey(x) < dkey(y) ? -1 : 1)); // commutativity
  if (ts.length === 0) return EMP;
  if (ts.length === 1) return ts[0];
  return { k: 'alt', ts };
}

export function mkStar(a: DReg): DReg {
  if (a.k === 'emp' || a.k === 'eps') return EPS; // ∅* = ε* = ε
  if (a.k === 'star') return a; // (r*)* = r*
  return { k: 'star', a };
}

// --- AST → derivative algebra (the regular subset only) --------------------

export function fromAst(node: RegexNode): DReg {
  switch (node.type) {
    case 'empty':
      return EPS;
    case 'char':
      return node.set.isEmpty() ? EMP : { k: 'chr', set: node.set };
    case 'group':
      return fromAst(node.node);
    case 'concat':
      return node.parts.reduceRight<DReg>((acc, p) => mkCat(fromAst(p), acc), EPS);
    case 'alt':
      return mkAlt(...node.options.map(fromAst));
    case 'star':
      return mkStar(fromAst(node.node));
    case 'plus': {
      const a = fromAst(node.node);
      return mkCat(a, mkStar(a)); // r+ = r·r*
    }
    case 'opt':
      return mkAlt(EPS, fromAst(node.node)); // r? = ε|r
    case 'repeat': {
      const a = fromAst(node.node);
      let out: DReg = EPS;
      for (let i = 0; i < node.min; i++) out = mkCat(out, a);
      if (node.max === null) {
        out = mkCat(out, mkStar(a)); // {m,} = aᵐ·a*
      } else {
        // {m,n} = aᵐ·(ε|a)^(n−m) — build the optional tail.
        for (let i = node.min; i < node.max; i++) out = mkCat(out, mkAlt(EPS, a));
      }
      return out;
    }
    // Non-regular constructs never reach here: callers gate on `features.regular`.
    case 'anchor':
    case 'boundary':
    case 'backref':
    case 'look':
      throw new Error(`derivatives: '${node.type}' is not a regular construct`);
  }
}

// --- The two core operations -----------------------------------------------

export function nullable(d: DReg): boolean {
  switch (d.k) {
    case 'emp':
    case 'chr':
      return false;
    case 'eps':
    case 'star':
      return true;
    case 'cat':
      return nullable(d.a) && nullable(d.b);
    case 'alt':
      return d.ts.some(nullable);
  }
}

// The Brzozowski derivative with respect to a single code point.
export function derivative(d: DReg, c: number): DReg {
  switch (d.k) {
    case 'emp':
    case 'eps':
      return EMP;
    case 'chr':
      return d.set.contains(c) ? EPS : EMP;
    case 'cat': {
      const left = mkCat(derivative(d.a, c), d.b);
      return nullable(d.a) ? mkAlt(left, derivative(d.b, c)) : left;
    }
    case 'alt':
      return mkAlt(...d.ts.map((t) => derivative(t, c)));
    case 'star':
      return mkCat(derivative(d.a, c), d); // D(r*) = D(r)·r*
  }
}

// --- Streaming full-string match -------------------------------------------

export function acceptsCodes(d: DReg, codes: number[]): boolean {
  let cur = d;
  for (const c of codes) {
    cur = derivative(cur, c);
    if (cur.k === 'emp') return false; // stuck in the dead state — stop early
  }
  return nullable(cur);
}

export function accepts(d: DReg, text: string): boolean {
  return acceptsCodes(d, Array.from(text, (ch) => ch.codePointAt(0)!));
}

// --- A visible derivative chain (drives the panel) -------------------------

export interface DerivStep {
  char: string | null; // the character whose derivative produced this expr (null = start)
  expr: string; // the residual expression, pretty-printed
  nullable: boolean; // does the residual match ε? (accept iff true at the end)
  dead: boolean; // is the residual ∅? (irrecoverable reject)
}

export function derivativeChain(d: DReg, text: string): { steps: DerivStep[]; accepted: boolean } {
  const chars = Array.from(text);
  const steps: DerivStep[] = [{ char: null, expr: show(d), nullable: nullable(d), dead: d.k === 'emp' }];
  let cur = d;
  for (const ch of chars) {
    cur = derivative(cur, ch.codePointAt(0)!);
    steps.push({ char: ch, expr: show(cur), nullable: nullable(cur), dead: cur.k === 'emp' });
    if (cur.k === 'emp') break; // nothing left to derive
  }
  // Accepted iff every character was consumed (no early dead-state stop) and the
  // final residual is nullable. Each consumed char adds exactly one step.
  const last = steps[steps.length - 1];
  return { steps, accepted: steps.length - 1 === chars.length && last.nullable };
}

// --- Pretty-printer (precedence-aware) -------------------------------------
// 0 = alt, 1 = cat, 2 = postfix/atom. Parenthesise children below their slot.
export function show(d: DReg, prec = 0): string {
  switch (d.k) {
    case 'emp':
      return '∅';
    case 'eps':
      return 'ε';
    case 'chr':
      return d.set.label();
    case 'star': {
      const s = show(d.a, 2) + '*';
      return prec > 2 ? `(${s})` : s;
    }
    case 'cat': {
      const s = show(d.a, 1) + show(d.b, 1);
      return prec > 1 ? `(${s})` : s;
    }
    case 'alt': {
      const s = d.ts.map((t) => show(t, 1)).join('|');
      return prec > 0 ? `(${s})` : s;
    }
  }
}

// --- Derivative-DFA construction -------------------------------------------
// BFS over derivative states. The alphabet is partitioned into atomic classes
// exactly as the subset construction does (so the two DFAs are comparable), and
// each state derives once per class over a representative code point.

export function derivAtoms(d: DReg): Atom[] {
  const cuts = new Set<number>();
  const sets: CharSet[] = [];
  const walk = (n: DReg): void => {
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
      case 'alt':
        n.ts.forEach(walk);
        return;
      case 'star':
        walk(n.a);
        return;
      default:
        return;
    }
  };
  walk(d);
  if (sets.length === 0) return [];
  const covered = CharSet.union(sets);
  const points = [...cuts].sort((a, b) => a - b);
  const atoms: Atom[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1] - 1;
    if (lo > hi) continue;
    if (covered.contains(lo)) atoms.push({ set: CharSet.fromRange(lo, hi), lo, hi });
  }
  return atoms;
}

export interface DerivDFA extends DFA {
  exprs: string[]; // the residual expression each state represents (debug/inspect)
  truncated: boolean; // hit the safety cap (should never happen for sane patterns)
}

const STATE_CAP = 4000;

export function buildDerivDFA(root: DReg, cap = STATE_CAP, maxNodes = 6000): DerivDFA {
  const atoms = derivAtoms(root);
  const states: DFAState[] = [];
  const exprs: string[] = [];
  const regs: DReg[] = [];
  const table: number[][] = [];
  const idByKey = new Map<string, number>();
  let truncated = false;

  const intern = (d: DReg): number => {
    const key = dkey(d);
    const found = idByKey.get(key);
    if (found !== undefined) return found;
    const id = states.length;
    idByKey.set(key, id);
    states.push({ id, nfaStates: [], accept: nullable(d) });
    exprs.push(show(d));
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
      const nd = derivative(d, atoms[a].lo);
      if (nd.k === 'emp') continue; // the dead sink is implicit (table stays -1)
      // A residual ballooning past the node budget means a pathological pattern;
      // bail rather than grind (the streaming engine still handles such inputs).
      if (dsize(nd) > maxNodes) {
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

  // Collapse atomic transitions into merged, labelled edges (as buildDFA does).
  const edgeAccum = new Map<string, { from: number; to: number; sets: CharSet[] }>();
  for (let from = 0; from < states.length; from++) {
    for (let a = 0; a < atoms.length; a++) {
      const to = table[from][a];
      if (to < 0) continue;
      const ekey = `${from}->${to}`;
      const acc = edgeAccum.get(ekey) ?? { from, to, sets: [] };
      acc.sets.push(atoms[a].set);
      edgeAccum.set(ekey, acc);
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
  };
}
