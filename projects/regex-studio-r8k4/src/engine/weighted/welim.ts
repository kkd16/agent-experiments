// State elimination — the WFA, read back as a weighted regular expression.
//
// Kleene's theorem says a (weighted) automaton and a (weighted) regular
// expression denote the same rational power series. The Boolean direction is the
// studio's `DFA→regex` tab; this is its semiring-graded generalisation. We add a
// fresh start S and final F, write each edge as a weighted letter `κ·⟨class⟩`,
// then rip out the original states one at a time — each removal routing every
// in→out pair through the eliminated state's starred self-loop:
//
//     E[i][j]  ⊕=  E[i][q] · E[q][q]* · E[q][j]
//
// What survives on E[S][F] is the language's weighted regex. Collapsing its
// letters to 1̄ (the augmentation homomorphism a ↦ 1̄) evaluates it to the
// all-words closure ⊕_{w} weight(w) — which must equal Lehmann's matrix M* and
// the brute all-words sum. Three independent roads to one number.

import { CharSet } from '../charset';
import type { Semiring } from './semiring';
import type { WFA } from './wfa';

export type WReg<K> =
  | { k: 'zero' } // ∅ — the empty series
  | { k: 'one' } // ε with coefficient 1̄
  | { k: 'scalar'; c: K } // a bare coefficient (a weighted ε)
  | { k: 'sym'; set: CharSet; c: K } // c · ⟨class⟩ — a weighted letter
  | { k: 'plus'; a: WReg<K>; b: WReg<K> }
  | { k: 'times'; a: WReg<K>; b: WReg<K> }
  | { k: 'star'; a: WReg<K> };

const ZERO: WReg<never> = { k: 'zero' };
const ONE: WReg<never> = { k: 'one' };

// --- Smart constructors: keep the printed expression small and legible -------

function wPlus<K>(a: WReg<K>, b: WReg<K>): WReg<K> {
  if (a.k === 'zero') return b;
  if (b.k === 'zero') return a;
  return { k: 'plus', a, b };
}
function wTimes<K>(a: WReg<K>, b: WReg<K>): WReg<K> {
  if (a.k === 'zero' || b.k === 'zero') return ZERO;
  if (a.k === 'one') return b;
  if (b.k === 'one') return a;
  return { k: 'times', a, b };
}
function wStar<K>(a: WReg<K>): WReg<K> {
  if (a.k === 'zero' || a.k === 'one') return ONE; // 0* = ε* = ε
  return { k: 'star', a };
}

// --- State elimination ------------------------------------------------------

export function eliminateToWReg<K>(wfa: WFA<K>, sr: Semiring<K>): WReg<K> {
  const n = wfa.n;
  const S = n; // new start
  const F = n + 1; // new final
  const N = n + 2;
  const E: WReg<K>[][] = Array.from({ length: N }, () => new Array<WReg<K>>(N).fill(ZERO));

  E[S][wfa.initial] = ONE; // λ: the initial weight is 1̄
  for (let s = 0; s < n; s++) {
    if (wfa.accept[s]) E[s][F] = ONE; // γ: a final weight of 1̄
    for (const e of wfa.out[s]) {
      const atom: WReg<K> = sr.eq(e.w, sr.one) ? { k: 'sym', set: e.set, c: sr.one } : { k: 'sym', set: e.set, c: e.w };
      E[s][e.to] = wPlus(E[s][e.to], atom);
    }
  }

  const alive = new Array<boolean>(N).fill(true);
  for (let q = 0; q < n; q++) {
    alive[q] = false;
    const loop = wStar(E[q][q]);
    for (let i = 0; i < N; i++) {
      if (!alive[i] || E[i][q].k === 'zero') continue;
      for (let j = 0; j < N; j++) {
        if (!alive[j] || E[q][j].k === 'zero') continue;
        E[i][j] = wPlus(E[i][j], wTimes(wTimes(E[i][q], loop), E[q][j]));
      }
    }
  }
  return E[S][F];
}

// --- The augmentation a ↦ 1̄: evaluate the weighted regex to its closure ------
// A class ⟨c⟩ stands for the ⊕ of the |c ∩ Σ| distinct one-letter words it
// matches, so under a ↦ 1̄ it becomes `fromCount(|c ∩ Σ|)`; the coefficient rides
// along. The result is ⊕_{w∈Σ*} weight(w) — independent of Lehmann's matrix road.

export function evalClosure<K>(reg: WReg<K>, sr: Semiring<K>, alphabet: number[]): K {
  switch (reg.k) {
    case 'zero':
      return sr.zero;
    case 'one':
      return sr.one;
    case 'scalar':
      return reg.c;
    case 'sym': {
      let count = 0;
      for (const a of alphabet) if (reg.set.contains(a)) count++;
      return sr.times(reg.c, sr.fromCount(count));
    }
    case 'plus':
      return sr.plus(evalClosure(reg.a, sr, alphabet), evalClosure(reg.b, sr, alphabet));
    case 'times':
      return sr.times(evalClosure(reg.a, sr, alphabet), evalClosure(reg.b, sr, alphabet));
    case 'star':
      return sr.star(evalClosure(reg.a, sr, alphabet));
  }
}

// --- Pretty printer (precedence-aware) --------------------------------------

const PREC = { star: 3, times: 2, plus: 1, atom: 4 } as const;

function prec<K>(r: WReg<K>): number {
  switch (r.k) {
    case 'plus':
      return PREC.plus;
    case 'times':
      return PREC.times;
    case 'star':
      return PREC.star;
    default:
      return PREC.atom;
  }
}

// Does this expression carry any explicit (non-1̄) coefficient? Drives the
// concatenation spacing so a coefficient can't visually fuse with a neighbour.
function hasScalar<K>(r: WReg<K>, sr: Semiring<K>): boolean {
  switch (r.k) {
    case 'scalar':
      return true;
    case 'sym':
      return !sr.eq(r.c, sr.one);
    case 'plus':
    case 'times':
      return hasScalar(r.a, sr) || hasScalar(r.b, sr);
    case 'star':
      return hasScalar(r.a, sr);
    default:
      return false;
  }
}

export function showWReg<K>(reg: WReg<K>, sr: Semiring<K>): string {
  const wrap = (r: WReg<K>, min: number): string => (prec(r) < min ? `(${go(r)})` : go(r));
  const go = (r: WReg<K>): string => {
    switch (r.k) {
      case 'zero':
        return '∅';
      case 'one':
        return 'ε';
      case 'scalar':
        return sr.show(r.c);
      case 'sym':
        return sr.eq(r.c, sr.one) ? r.set.label() : `${sr.show(r.c)}·${r.set.label()}`;
      case 'plus':
        return `${wrap(r.a, PREC.plus)} + ${wrap(r.b, PREC.plus)}`;
      case 'times': {
        // A thin space keeps a scalar coefficient from fusing with the next
        // factor (`0.9·a 0.9·a*` reads; `0.9·a0.9·a*` does not). Pure juxtaposed
        // letters stay tight enough to still read as concatenation.
        const needGap = hasScalar(r.a, sr) || hasScalar(r.b, sr);
        const sep = needGap ? ' ' : '';
        return `${wrap(r.a, PREC.times)}${sep}${wrap(r.b, PREC.times)}`;
      }
      case 'star':
        return `${wrap(r.a, PREC.star + 1)}*`;
    }
  };
  return go(reg);
}

// Count the nodes — a small "how big is the synthesised regex" stat for the panel.
export function wregSize<K>(reg: WReg<K>): number {
  switch (reg.k) {
    case 'plus':
    case 'times':
      return 1 + wregSize(reg.a) + wregSize(reg.b);
    case 'star':
      return 1 + wregSize(reg.a);
    default:
      return 1;
  }
}
