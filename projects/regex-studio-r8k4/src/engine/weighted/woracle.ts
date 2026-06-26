// Ground truth by brute force — the referee the matrix algorithms answer to.
//
// `bruteWordWeight` enumerates *every* accepting run of a word and ⊕-sums the
// ⊗-product along each, materialising the definition with no cleverness at all.
// It shares nothing with the forward/backward vector sweeps but the automaton
// itself, so an agreement between them is a real cross-check. `allWordsSum`
// likewise computes the all-words closure ⊕_{w∈Σ*} weight(w) by literally
// summing over every short word — the independent referee for the matrix and
// state-elimination closures.

import type { Semiring } from './semiring';
import { wordWeightForward, type WFA } from './wfa';

export interface BruteResult<K> {
  weight: K;
  runs: number; // accepting runs visited (capped)
  capped: boolean; // did we hit the run cap before exhausting?
}

export function bruteWordWeight<K>(wfa: WFA<K>, sr: Semiring<K>, codes: number[], cap = 200000): BruteResult<K> {
  let total = sr.zero;
  let runs = 0;
  let capped = false;
  const dfs = (state: number, i: number, prod: K): void => {
    if (capped) return;
    if (i === codes.length) {
      if (wfa.accept[state]) {
        total = sr.plus(total, prod);
        if (++runs >= cap) capped = true;
      }
      return;
    }
    const c = codes[i];
    for (const e of wfa.out[state]) {
      if (!e.set.contains(c)) continue;
      dfs(e.to, i + 1, sr.times(prod, e.w));
      if (capped) return;
    }
  };
  dfs(wfa.initial, 0, sr.one);
  return { weight: total, runs, capped };
}

export function bruteWord<K>(wfa: WFA<K>, sr: Semiring<K>, word: string, cap = 200000): BruteResult<K> {
  return bruteWordWeight(wfa, sr, Array.from(word, (ch) => ch.codePointAt(0)!), cap);
}

export interface AllWordsResult<K> {
  sum: K;
  words: number; // words enumerated
  maxLen: number;
  converged: boolean; // did the last length add nothing? (finite / idempotent)
}

// ⊕ over every word in Σ^{≤maxLen} of its weight, by direct forward evaluation.
// Convergence = the longest band contributed nothing new, i.e. either the
// language is finite or the semiring is idempotent and has saturated.
export function allWordsSum<K>(
  wfa: WFA<K>,
  sr: Semiring<K>,
  alphabet: number[],
  maxLen: number,
): AllWordsResult<K> {
  let sum = sr.zero;
  let words = 0;
  // length 0 — the empty word
  sum = sr.plus(sum, wordWeightForward(wfa, sr, []));
  words++;
  // Run every band to maxLen — a single empty band mid-way means nothing (a
  // language can have a minimum word length, e.g. cc·c*), so convergence is read
  // only from whether the *final* band still contributed. When the last band is
  // a no-op, every longer word is either rejected (finite language) or can only
  // repeat a value already ⊕-absorbed (idempotent) — so the sum is the closure.
  let lastBandContributed = true;
  let band: number[][] = [[]]; // words of the current length
  for (let len = 1; len <= maxLen; len++) {
    const next: number[][] = [];
    const before = sr.show(sum);
    for (const w of band) for (const a of alphabet) next.push([...w, a]);
    for (const codes of next) {
      sum = sr.plus(sum, wordWeightForward(wfa, sr, codes));
      words++;
    }
    band = next;
    lastBandContributed = before !== sr.show(sum);
  }
  return { sum, words, maxLen, converged: !lastBandContributed };
}
