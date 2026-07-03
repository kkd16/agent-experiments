// Regex → **linear** alternating automaton (Antimirov, plus the Boolean closure).
//
// The Alternation tab starts from a *hand-written* AFA. This module lets it start
// from a **pattern** instead — the missing on-ramp the journal's backlog called
// for ("Regex → linear AFA directly … so the whole pipeline can start from a
// pattern and show the linear-size AFA beside the exponential NFA/DFA"). It is
// the alternating twin of Thompson/Glushkov/Antimirov, and the *only* road in the
// studio on which the two operations that cost a determinisation elsewhere are
// free and linear:
//
//   • **complement** `~r`  — dualise the sub-AFA (∧↔∨, flip F). No new states, no
//     determinise-then-flip. (A DFA must complete-and-complement.)
//   • **intersection** `r & s` — ∧ the two initial formulas over the disjoint
//     union. No product. (A DFA multiplies sizes.)
//
// The construction, by structural recursion over the extended-regex algebra
// (`EReg`, which already carries `&` and `~`):
//
//   • a **plain** subexpression (no `&`/`~` anywhere) compiles to an AFA whose
//     states are its **Antimirov partial-derivative terms** — ≤ (#letters)+1 of
//     them (Antimirov 1996), so genuinely *linear*. The transition out of a term
//     on a letter is the ∨ of its partial derivatives; a term is final iff it is
//     nullable. This is an ∨-only (existential) AFA — an NFA living inside the
//     alternating world.
//   • `a & b`  →  `intersectAFA` of the two sub-AFAs (the ∧ join).
//   • `~a`     →  `complementAFA` of the sub-AFA (the dual).
//   • `a | b`  →  `unionAFA` (the ∨ join).
//   • a `·`/`*` whose body still hides an `&`/`~` (e.g. `(~a)b`) is the one case
//     alternating composition is not linear; we fall back to lifting that
//     subexpression's Boolean-derivative DFA into a (trivially alternating) AFA —
//     correct, just not succinct — and flag it. The whole *interesting* space
//     (Boolean combinations of ordinary regexes) stays linear.
//
// Correctness is not asserted, it is *checked*: `verify.ts` confronts the built
// AFA with `ereg`'s independent span oracle on every word up to a horizon, and
// with the AFA→NFA→DFA→min pipeline. This module only builds.

import { CharSet, MAX_CODE_POINT } from '../charset';
import {
  type EReg,
  ekey,
  nullableE,
  showE,
  hasNot,
  mkCat,
  EPS,
  buildEregDFA,
  type EregDFA,
} from '../ereg';
import { atomIndexFor } from '../dfa';
import {
  BF_FALSE,
  bfOr,
  bfVar,
  intersectAFA,
  unionAFA,
  complementAFA,
  type AFA,
  type BF,
} from './afa';

// ── Antimirov partial derivatives (plain terms only) ─────────────────────────
//
// pd_a(r) is a *set* of terms whose union of languages is the a-derivative of
// L(r). Unlike Brzozowski's, no term is ever a `|`; the ∨ lives in the set. The
// set of all terms reachable by iterated pd is finite and linear in |r|.

/** Concatenate every term in a set on the right by `k` (dropping ∅). */
function timesRight(set: EReg[], k: EReg): EReg[] {
  const out: EReg[] = [];
  for (const p of set) {
    const c = mkCat(p, k);
    if (c.k !== 'emp') out.push(c);
  }
  return out;
}

/** Antimirov partial derivative of a **plain** extended-regex term by code `c`. */
export function pd(r: EReg, c: number): EReg[] {
  switch (r.k) {
    case 'emp':
    case 'eps':
      return [];
    case 'chr':
      return r.set.contains(c) ? [EPS] : [];
    case 'cat': {
      const left = timesRight(pd(r.a, c), r.b);
      return nullableE(r.a) ? dedup([...left, ...pd(r.b, c)]) : left;
    }
    case 'alt': {
      const out: EReg[] = [];
      for (const t of r.ts) out.push(...pd(t, c));
      return dedup(out);
    }
    case 'star':
      return timesRight(pd(r.a, c), r); // pd(a*) = pd(a)·a*
    case 'and':
    case 'not':
      // Never reached: a term handed to `pd` is plain by construction.
      throw new Error('pd: Boolean operator in a supposedly plain term');
  }
}

function dedup(terms: EReg[]): EReg[] {
  const seen = new Set<string>();
  const out: EReg[] = [];
  for (const t of terms) {
    const k = ekey(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/** True iff the term is free of `&` and `~` — the linear Antimirov road applies. */
export function isPlain(r: EReg): boolean {
  switch (r.k) {
    case 'and':
    case 'not':
      return false;
    case 'cat':
      return isPlain(r.a) && isPlain(r.b);
    case 'star':
      return isPlain(r.a);
    case 'alt':
      return r.ts.every(isPlain);
    default:
      return true;
  }
}

// ── The minimal faithful alphabet ────────────────────────────────────────────
//
// An AFA runs over a finite set of concrete single characters. We abstract the
// pattern's (possibly enormous) code-point ranges to the coarsest alphabet that
// still tells every branch apart: partition Σ at the pattern's character-class
// boundaries, then merge atoms that no class distinguishes — two atoms collapse
// iff *every* class contains both or neither. The "belongs to no class" atom
// survives only under a complement (which can accept those characters). Each
// surviving class keeps one printable representative.

function collectSets(r: EReg, into: CharSet[]): void {
  switch (r.k) {
    case 'chr':
      into.push(r.set);
      return;
    case 'cat':
      collectSets(r.a, into);
      collectSets(r.b, into);
      return;
    case 'star':
    case 'not':
      collectSets(r.a, into);
      return;
    case 'alt':
    case 'and':
      r.ts.forEach((t) => collectSets(t, into));
      return;
    default:
      return;
  }
}

export interface Alphabet {
  symbols: string[]; // concrete single-character strings, sorted
  full: boolean; // whether an "other" (in-no-class) symbol was included
}

export function inferAlphabet(root: EReg, cap = 12): Alphabet {
  const sets: CharSet[] = [];
  collectSets(root, sets);
  const complete = hasNot(root);

  // Cut points at every class boundary; complete the range under complement.
  const cuts = new Set<number>();
  for (const s of sets)
    for (const rr of s.ranges) {
      cuts.add(rr.lo);
      cuts.add(rr.hi + 1);
    }
  if (complete) {
    cuts.add(0);
    cuts.add(MAX_CODE_POINT + 1);
  }
  const points = [...cuts].filter((p) => p <= MAX_CODE_POINT + 1).sort((a, b) => a - b);

  // Atoms → behavioural signatures. All atoms of one signature are behaviourally
  // identical (every class contains them all or none), so they collapse to a
  // single symbol whose representative is the most legible character across the
  // whole class — 'c' for "anything but a and b", not some control code.
  const bySig = new Map<string, CharSet[]>();
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i];
    const hi = points[i + 1] - 1;
    if (lo > hi) continue;
    const sig = sets.map((s) => (s.contains(lo) ? '1' : '0')).join('');
    if (sig.indexOf('1') < 0 && !complete) continue; // in no class, no complement ⇒ irrelevant
    (bySig.get(sig) ?? bySig.set(sig, []).get(sig)!).push(CharSet.fromRange(lo, hi));
  }

  let full = false;
  const codes: number[] = [];
  for (const [sig, parts] of bySig) {
    if (sig.indexOf('1') < 0) full = true;
    const union = CharSet.union(parts);
    codes.push(union.samplePrintable() ?? parts[0].ranges[0].lo);
  }
  codes.sort((a, b) => a - b);
  const symbols = codes.slice(0, cap).map((c) => String.fromCodePoint(c));
  // Never leave the alphabet empty (∅ / ε carry no letters) — a single symbol
  // keeps every downstream view well-defined without changing the language.
  if (symbols.length === 0) symbols.push('a');
  return { symbols, full };
}

// ── Plain term → Antimirov AFA over a fixed alphabet ─────────────────────────

const STATE_CAP = 400;

function antimirovAFA(root: EReg, symbols: string[]): AFA {
  const codes = symbols.map((s) => s.codePointAt(0) ?? 0);
  const idByKey = new Map<string, number>();
  const terms: EReg[] = [];
  const intern = (t: EReg): number => {
    const k = ekey(t);
    const ex = idByKey.get(k);
    if (ex !== undefined) return ex;
    const id = terms.length;
    idByKey.set(k, id);
    terms.push(t);
    return id;
  };

  const start = intern(root);
  const delta: BF[][] = [];
  const queue = [start];
  while (queue.length) {
    const id = queue.shift()!;
    if (delta[id]) continue;
    const t = terms[id];
    const row: BF[] = symbols.map(() => BF_FALSE);
    for (let si = 0; si < symbols.length; si++) {
      const succ = pd(t, codes[si]);
      let f: BF = BF_FALSE;
      for (const s of succ) {
        const before = terms.length;
        const to = intern(s);
        f = bfOr(f, bfVar(to));
        if (to === before && terms.length <= STATE_CAP) queue.push(to);
      }
      row[si] = f;
    }
    delta[id] = row;
    if (terms.length > STATE_CAP) break;
  }
  // Any un-expanded states (hit the cap) get an all-⊥ row so the record is total.
  for (let id = 0; id < terms.length; id++) if (!delta[id]) delta[id] = symbols.map(() => BF_FALSE);

  const names = terms.map((t) => clip(showE(t)));
  const final = terms.map((t) => nullableE(t));
  return { n: terms.length, names, symbols: symbols.slice(), init: bfVar(start), delta, final };
}

function clip(s: string, max = 22): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// ── A DFA lifted into a (deterministic) AFA — the mixed-subtree fallback ──────

function dfaToAFA(dfa: EregDFA, symbols: string[]): AFA {
  const codes = symbols.map((s) => s.codePointAt(0) ?? 0);
  const n = dfa.states.length;
  const delta: BF[][] = dfa.states.map((_, id) =>
    symbols.map((_s, si) => {
      const ai = atomIndexFor(dfa.atoms, codes[si]);
      const to = ai < 0 ? -1 : dfa.table[id][ai];
      return to < 0 ? BF_FALSE : bfVar(to);
    }),
  );
  const names = dfa.exprs.map((e) => clip(e));
  const final = dfa.states.map((s) => s.accept);
  return { n, names, symbols: symbols.slice(), init: bfVar(dfa.start), delta, final };
}

// ── The recursive compiler ───────────────────────────────────────────────────

export interface BuildResult {
  afa: AFA;
  alphabet: Alphabet;
  /** True if some `·`/`*` over a Boolean body forced the non-linear DFA fallback. */
  usedFallback: boolean;
  /** Antimirov states the plain roads contributed (the linear core count). */
  note: string;
}

function compile(r: EReg, symbols: string[], flags: { fallback: boolean }): AFA {
  if (isPlain(r)) return antimirovAFA(r, symbols);
  switch (r.k) {
    case 'and': {
      let acc = compile(r.ts[0], symbols, flags);
      for (let i = 1; i < r.ts.length; i++) acc = intersectAFA(acc, compile(r.ts[i], symbols, flags));
      return acc;
    }
    case 'alt': {
      let acc = compile(r.ts[0], symbols, flags);
      for (let i = 1; i < r.ts.length; i++) acc = unionAFA(acc, compile(r.ts[i], symbols, flags));
      return acc;
    }
    case 'not':
      return complementAFA(compile(r.a, symbols, flags));
    case 'cat':
    case 'star': {
      // A concatenation/star whose body hides a Boolean operator: alternating
      // composition is not linear here, so lift this subtree's derivative DFA.
      flags.fallback = true;
      return dfaToAFA(buildEregDFA(r), symbols);
    }
    default:
      return antimirovAFA(r, symbols);
  }
}

/** Compile an extended-regex algebra term to an AFA over its minimal alphabet. */
export function eregToAFA(root: EReg, alphabetOverride?: string[]): BuildResult {
  const alphabet = alphabetOverride ? { symbols: alphabetOverride, full: false } : inferAlphabet(root);
  const flags = { fallback: false };
  const afa = compile(root, alphabet.symbols, flags);
  const note = flags.fallback
    ? 'a `·`/`*` over a Boolean body used the non-linear DFA fallback'
    : 'linear: complement is a dual, intersection is a ∧ join — no determinisation';
  return { afa, alphabet, usedFallback: flags.fallback, note };
}
