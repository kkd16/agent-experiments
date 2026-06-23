// A direct, defining-by-the-book evaluator for MSO formulas: quantifiers are
// interpreted literally over the positions (first-order) and the position-
// *subsets* (second-order, 2^n of them) of a concrete word. This is the
// independent ground truth — the automaton the Büchi compiler builds is
// differentially checked against it over every short word.

import type { Formula } from './ast';

interface Env {
  fo: Record<string, number>; // variable → position
  so: Record<string, number>; // variable → bitmask over positions
  word: number[]; // letter indices
  letterIdx: Map<string, number>;
}

function evalF(f: Formula, env: Env): boolean {
  switch (f.kind) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'label': {
      const li = env.letterIdx.get(f.letter);
      return li !== undefined && env.word[env.fo[f.x]] === li;
    }
    case 'lt':
      return env.fo[f.x] < env.fo[f.y];
    case 'le':
      return env.fo[f.x] <= env.fo[f.y];
    case 'eq':
      return env.fo[f.x] === env.fo[f.y];
    case 'succ':
      return env.fo[f.y] === env.fo[f.x] + 1;
    case 'mem':
      return ((env.so[f.set] >> env.fo[f.x]) & 1) === 1;
    case 'not':
      return !evalF(f.a, env);
    case 'and':
      return evalF(f.a, env) && evalF(f.b, env);
    case 'or':
      return evalF(f.a, env) || evalF(f.b, env);
    case 'implies':
      return !evalF(f.a, env) || evalF(f.b, env);
    case 'iff':
      return evalF(f.a, env) === evalF(f.b, env);
    case 'existsFO': {
      for (let p = 0; p < env.word.length; p++) {
        const save = env.fo[f.v];
        env.fo[f.v] = p;
        const ok = evalF(f.a, env);
        env.fo[f.v] = save;
        if (ok) return true;
      }
      return false;
    }
    case 'forallFO': {
      for (let p = 0; p < env.word.length; p++) {
        const save = env.fo[f.v];
        env.fo[f.v] = p;
        const ok = evalF(f.a, env);
        env.fo[f.v] = save;
        if (!ok) return false;
      }
      return true;
    }
    case 'existsSO': {
      const limit = 1 << env.word.length;
      for (let m = 0; m < limit; m++) {
        const save = env.so[f.v];
        env.so[f.v] = m;
        const ok = evalF(f.a, env);
        env.so[f.v] = save;
        if (ok) return true;
      }
      return false;
    }
    case 'forallSO': {
      const limit = 1 << env.word.length;
      for (let m = 0; m < limit; m++) {
        const save = env.so[f.v];
        env.so[f.v] = m;
        const ok = evalF(f.a, env);
        env.so[f.v] = save;
        if (!ok) return false;
      }
      return true;
    }
  }
}

// Does `word` (letter indices) satisfy the *sentence* `formula`?
export function satisfies(formula: Formula, word: number[], letterIdx: Map<string, number>): boolean {
  return evalF(formula, { fo: {}, so: {}, word, letterIdx });
}

export interface WordVerdict {
  word: string; // rendered over the alphabet
  indices: number[];
  accept: boolean;
}

// Every word over the alphabet up to length `maxLen`, with the oracle's verdict.
export function languageUpTo(formula: Formula, alphabet: string[], maxLen: number): WordVerdict[] {
  const letterIdx = new Map<string, number>();
  alphabet.forEach((c, i) => letterIdx.set(c, i));
  const out: WordVerdict[] = [];
  for (let len = 0; len <= maxLen; len++) {
    const total = Math.pow(alphabet.length, len);
    for (let n = 0; n < total; n++) {
      const indices: number[] = [];
      let k = n;
      for (let p = 0; p < len; p++) {
        indices.push(k % alphabet.length);
        k = Math.floor(k / alphabet.length);
      }
      indices.reverse();
      out.push({
        word: indices.map((i) => alphabet[i]).join(''),
        indices,
        accept: evalF(formula, { fo: {}, so: {}, word: indices, letterIdx }),
      });
    }
  }
  return out;
}

// Run a word (letter indices) on a lowered studio DFA via its transition table.
// Imported lazily by callers that already hold the DFA; kept here for symmetry
// with the oracle so the panel can compare the two verdicts.
export function letterIndicesOf(alphabet: string[]): Map<string, number> {
  const m = new Map<string, number>();
  alphabet.forEach((c, i) => m.set(c, i));
  return m;
}
