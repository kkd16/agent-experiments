// Weighted Glushkov: lower the studio's position automaton to a WFA over K.
//
// The position automaton already gives one state per letter occurrence, ε-free,
// homogeneous (every in-edge to q carries q's class). All we add is a weight
// κ[q] ∈ K per position — the coefficient on that occurrence in the weighted
// regular expression — and read off the WFA mechanically. Because positions are
// numbered in *source order* by the studio's lineariser, κ[q] is exactly "the
// weight you wrote on the q-th letter of the pattern", which keeps this WFA in
// lock-step with the weighted regex the state-eliminator prints back (welim.ts).

import type { RegexNode } from '../ast';
import { CharSet } from '../charset';
import { buildGlushkov, type PositionAutomaton } from '../glushkov';
import type { Semiring } from './semiring';
import type { WEdge, WFA } from './wfa';

// A weight source: given a position and its class, produce its κ ∈ K.
export type WeightOf<K> = (pos: number, set: CharSet) => K;

export function buildWFAFromPA<K>(pa: PositionAutomaton, sr: Semiring<K>, weightOf: WeightOf<K>): WFA<K> {
  const n = pa.m + 1;
  const weights: K[] = new Array<K>(n).fill(sr.one);
  for (let p = 1; p <= pa.m; p++) weights[p] = weightOf(p, pa.positions[p]);

  const out: WEdge<K>[][] = Array.from({ length: n }, () => []);
  for (const e of pa.edges) out[e.from].push({ to: e.to, set: e.set, w: weights[e.to] });

  const accept = new Array<boolean>(n).fill(false);
  for (const p of pa.last) accept[p] = true;
  if (pa.nullableStart) accept[0] = true;

  return { n, initial: 0, accept, out, positions: pa.positions.slice(), weights };
}

export function buildWFA<K>(ast: RegexNode, sr: Semiring<K>, weightOf: WeightOf<K>, cap = 2000): WFA<K> {
  return buildWFAFromPA(buildGlushkov(ast, cap), sr, weightOf);
}

// --- Weight presets ---------------------------------------------------------

// Every occurrence weighs 1̄ — the WFA then counts/recognises structurally:
// Boolean ⇒ recognition, Counting ⇒ the ambiguity degree.
export function uniformWeights<K>(sr: Semiring<K>): WeightOf<K> {
  return () => sr.one;
}

// κ[q] drawn from a per-letter table keyed by the *representative* code of the
// class at q (the panel's intuitive "this letter costs 3" knob). Missing letters
// fall back to a default.
export function letterTableWeights<K>(
  table: Map<number, K>,
  fallback: K,
): WeightOf<K> {
  return (_pos, set) => {
    const code = set.samplePrintable();
    if (code === null) return fallback;
    const w = table.get(code);
    return w === undefined ? fallback : w;
  };
}

// Deterministic per-position weights drawn from a small menu — for reproducible
// demos and for the fuzzer to exercise genuinely position-dependent runs.
export function seededWeights<K>(seed: number, menu: K[]): WeightOf<K> {
  return (pos) => {
    // A cheap integer hash of (seed, pos) → a menu index. Reproducible by seed.
    let h = (seed ^ (pos * 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return menu[h % menu.length];
  };
}

// Build a code-keyed letter table from a human record like { a: 2, b: 3 }.
export function tableFromRecord<K>(rec: Record<string, K>): Map<number, K> {
  const m = new Map<number, K>();
  for (const [ch, w] of Object.entries(rec)) {
    const code = ch.codePointAt(0);
    if (code !== undefined) m.set(code, w);
  }
  return m;
}
