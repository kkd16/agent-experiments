// The brute-force oracle: the *direct* semantics of LTL on an ultimately
// periodic word u·vᵒ. Positions of such a word form a finite lasso of classes —
// the stem 0..|u|−1 then the loop |u|..|u|+|v|−1 cycling back to |u| — so every
// temporal operator is a least/greatest fixpoint over those finitely many
// classes, evaluated to convergence. This is the independent ground truth the
// GPVW-built Büchi automaton is differentially checked against; it never touches
// the tableau or NNF, so a bug in one cannot hide a bug in the other.

import type { LTL } from './ltl';

export interface LassoWord {
  u: string[];
  v: string[]; // non-empty
}

// classes 0..m-1; succ wraps the loop back to loopStart.
function classes(w: LassoWord): { m: number; letterAt: (c: number) => string; succ: (c: number) => number } {
  const u = w.u;
  const v = w.v;
  const m = u.length + v.length;
  const loopStart = u.length;
  return {
    m,
    letterAt: (c) => (c < u.length ? u[c] : v[c - u.length]),
    succ: (c) => (c < m - 1 ? c + 1 : loopStart),
  };
}

function fixpoint(m: number, init: boolean, update: (cur: boolean[]) => boolean[]): boolean[] {
  let cur = new Array<boolean>(m).fill(init);
  for (let iter = 0; iter <= m; iter++) {
    const nxt = update(cur);
    let changed = false;
    for (let i = 0; i < m; i++) if (nxt[i] !== cur[i]) { changed = true; break; }
    cur = nxt;
    if (!changed) break;
  }
  return cur;
}

// The truth of `phi` at every class of the lasso word.
function evalAll(phi: LTL, w: LassoWord): boolean[] {
  const { m, letterAt, succ } = classes(w);
  const go = (f: LTL): boolean[] => {
    switch (f.k) {
      case 'true': return new Array(m).fill(true);
      case 'false': return new Array(m).fill(false);
      case 'prop': return Array.from({ length: m }, (_, c) => letterAt(c) === f.letter);
      case 'not': { const a = go(f.a); return a.map((x) => !x); }
      case 'and': { const a = go(f.a), b = go(f.b); return a.map((x, i) => x && b[i]); }
      case 'or': { const a = go(f.a), b = go(f.b); return a.map((x, i) => x || b[i]); }
      case 'implies': { const a = go(f.a), b = go(f.b); return a.map((x, i) => !x || b[i]); }
      case 'iff': { const a = go(f.a), b = go(f.b); return a.map((x, i) => x === b[i]); }
      case 'next': { const a = go(f.a); return Array.from({ length: m }, (_, c) => a[succ(c)]); }
      case 'eventually': { // F φ — lfp of X = φ ∨ X∘succ
        const a = go(f.a);
        return fixpoint(m, false, (cur) => Array.from({ length: m }, (_, c) => a[c] || cur[succ(c)]));
      }
      case 'globally': { // G φ — gfp of X = φ ∧ X∘succ
        const a = go(f.a);
        return fixpoint(m, true, (cur) => Array.from({ length: m }, (_, c) => a[c] && cur[succ(c)]));
      }
      case 'until': { // φ U ψ — lfp of X = ψ ∨ (φ ∧ X∘succ)
        const a = go(f.a), b = go(f.b);
        return fixpoint(m, false, (cur) => Array.from({ length: m }, (_, c) => b[c] || (a[c] && cur[succ(c)])));
      }
      case 'release': { // φ R ψ — gfp of X = ψ ∧ (φ ∨ X∘succ)
        const a = go(f.a), b = go(f.b);
        return fixpoint(m, true, (cur) => Array.from({ length: m }, (_, c) => b[c] && (a[c] || cur[succ(c)])));
      }
      case 'weakuntil': { // φ W ψ — gfp of X = ψ ∨ (φ ∧ X∘succ)
        const a = go(f.a), b = go(f.b);
        return fixpoint(m, true, (cur) => Array.from({ length: m }, (_, c) => b[c] || (a[c] && cur[succ(c)])));
      }
      case 'strongrelease': { // φ M ψ — lfp of X = ψ ∧ (φ ∨ X∘succ)
        const a = go(f.a), b = go(f.b);
        return fixpoint(m, false, (cur) => Array.from({ length: m }, (_, c) => b[c] && (a[c] || cur[succ(c)])));
      }
    }
  };
  return go(phi);
}

// Does the ω-word u·vᵒ satisfy φ (at position 0)?
export function satisfiesLasso(phi: LTL, w: LassoWord): boolean {
  return evalAll(phi, w)[0];
}

// ── lasso sampling ───────────────────────────────────────────────────────────
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomLasso(rnd: () => number, alphabet: string[], maxStem: number, maxLoop: number): LassoWord {
  const ul = Math.floor(rnd() * (maxStem + 1));
  const vl = 1 + Math.floor(rnd() * maxLoop);
  const u = Array.from({ length: ul }, () => alphabet[Math.floor(rnd() * alphabet.length)]);
  const v = Array.from({ length: vl }, () => alphabet[Math.floor(rnd() * alphabet.length)]);
  return { u, v };
}

// A small deterministic spread of lassos for the truth table.
export function sampleLassos(alphabet: string[], limit = 28): LassoWord[] {
  const out: LassoWord[] = [];
  const stems: string[][] = [[]];
  const loops: string[][] = [];
  // all loops of length 1..2, all stems of length 0..1 (kept small but telling)
  for (const a of alphabet) {
    loops.push([a]);
    stems.push([a]);
  }
  for (const a of alphabet) for (const b of alphabet) loops.push([a, b]);
  for (const u of stems) {
    for (const v of loops) {
      out.push({ u, v });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function lassoToString(w: LassoWord): string {
  const u = w.u.join('');
  const v = w.v.join('');
  return `${u === '' ? 'ε' : u}·(${v})ᵒ`;
}
