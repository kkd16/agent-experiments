// The Büchi–Elgot–Trakhtenbrot construction: an MSO[<] formula → a finite
// automaton over Σ × {0,1}^(free vars), built by structural recursion.
//
//   atom            → a tiny hand-built DFA (each FO atom enforces that the
//                     variables it names are singletons)
//   φ ∧ ψ / φ ∨ ψ   → lift both to a common alphabet, then product / union
//   ¬φ              → complement, intersected back with the *validity* language
//                     (every FO track a singleton) so we complement within the
//                     well-formed encodings only
//   ∃x. φ           → project the x-track away (NFA) and re-determinise; ∀ via
//                     ¬∃¬. Second-order ∃X is the same with no singleton needed.
//
// The invariant maintained at every node: the automaton accepts exactly the
// encodings whose FO tracks are each a singleton and which satisfy the formula.

import type { Formula } from './ast';
import { freeVars } from './ast';
import {
  type BitDFA,
  type Track,
  LogicError,
  buildDFA,
  bitIndex,
  getBit,
  sortTracks,
  unionTracks,
  tracksEqual,
  liftDFA,
  intersectDFA,
  unionDFA,
  complementDFA,
  projectToNFA,
  determinize,
  minimizeBitDFA,
} from './bitaut';

export interface SizeTrace {
  op: string; // human label for the construction step
  detail: string;
  states: number; // resulting (minimised) state count
  raw?: number; // pre-minimisation states (e.g. the determinisation blow-up)
}

export interface CompileResult {
  automaton: BitDFA; // over the formula's free-variable tracks
  trace: SizeTrace[];
  maxStates: number; // the largest intermediate machine (the blow-up high-water mark)
}

// ── validity: every FO track must be a singleton (exactly one 1) ──────────────
function validityDFA(sigma: number, tracks: Track[]): BitDFA {
  const ts = sortTracks(tracks);
  const fo = ts.map((t, i) => (t.so ? -1 : i)).filter((i) => i >= 0);
  const m = fo.length;
  const full = (1 << m) - 1;
  // states 0..2^m-1 = which FO tracks have been seen once; second sighting → -1
  return buildDFA(sigma, ts, 1 << m, 0, (s) => s === full, (state, _l, bits) => {
    let next = state;
    for (let p = 0; p < m; p++) {
      if (getBit(bits, fo[p])) {
        if ((state >> p) & 1) return -1;
        next |= 1 << p;
      }
    }
    return next;
  });
}

// Lift onto a superset alphabet, re-imposing validity so newly-added FO tracks
// are singletons too — keeps the invariant after every cylindrification.
function liftTo(a: BitDFA, target: Track[], sigma: number): BitDFA {
  const tgt = sortTracks(target);
  if (tracksEqual(a.tracks, tgt)) return a;
  return minimizeBitDFA(intersectDFA(liftDFA(a, tgt), validityDFA(sigma, tgt)));
}

// ── atomic automata ───────────────────────────────────────────────────────────
function fo(name: string): Track {
  return { name, so: false };
}

function atomTrue(sigma: number): BitDFA {
  return buildDFA(sigma, [], 1, 0, new Set([0]), () => 0);
}
function atomFalse(sigma: number): BitDFA {
  return buildDFA(sigma, [], 1, 0, new Set<number>(), () => 0);
}

function atomLabel(sigma: number, letterIdx: number, x: string): BitDFA {
  const tracks = [fo(x)];
  const ix = bitIndex(sortTracks(tracks), x);
  return buildDFA(sigma, tracks, 2, 0, new Set([1]), (s, l, bits) => {
    const bx = getBit(bits, ix);
    if (s === 0) return bx ? (l === letterIdx ? 1 : -1) : 0;
    return bx ? -1 : 1; // s === 1
  });
}

function atomLt(sigma: number, x: string, y: string): BitDFA {
  const tracks = sortTracks([fo(x), fo(y)]);
  const ix = bitIndex(tracks, x);
  const iy = bitIndex(tracks, y);
  return buildDFA(sigma, tracks, 3, 0, new Set([2]), (s, _l, bits) => {
    const bx = getBit(bits, ix);
    const by = getBit(bits, iy);
    if (s === 0) return bx && !by ? 1 : !bx && !by ? 0 : -1;
    if (s === 1) return !bx && by ? 2 : !bx && !by ? 1 : -1;
    return !bx && !by ? 2 : -1; // s === 2
  });
}

function atomLe(sigma: number, x: string, y: string): BitDFA {
  const tracks = sortTracks([fo(x), fo(y)]);
  const ix = bitIndex(tracks, x);
  const iy = bitIndex(tracks, y);
  return buildDFA(sigma, tracks, 3, 0, new Set([2]), (s, _l, bits) => {
    const bx = getBit(bits, ix);
    const by = getBit(bits, iy);
    if (s === 0) return bx && by ? 2 : bx && !by ? 1 : !bx && !by ? 0 : -1;
    if (s === 1) return !bx && by ? 2 : !bx && !by ? 1 : -1;
    return !bx && !by ? 2 : -1; // s === 2
  });
}

function atomEq(sigma: number, x: string, y: string): BitDFA {
  const tracks = sortTracks([fo(x), fo(y)]);
  const ix = bitIndex(tracks, x);
  const iy = bitIndex(tracks, y);
  return buildDFA(sigma, tracks, 2, 0, new Set([1]), (s, _l, bits) => {
    const bx = getBit(bits, ix);
    const by = getBit(bits, iy);
    if (s === 0) return bx && by ? 1 : !bx && !by ? 0 : -1;
    return !bx && !by ? 1 : -1; // s === 1
  });
}

function atomSucc(sigma: number, x: string, y: string): BitDFA {
  const tracks = sortTracks([fo(x), fo(y)]);
  const ix = bitIndex(tracks, x);
  const iy = bitIndex(tracks, y);
  return buildDFA(sigma, tracks, 3, 0, new Set([2]), (s, _l, bits) => {
    const bx = getBit(bits, ix);
    const by = getBit(bits, iy);
    if (s === 0) return bx && !by ? 1 : !bx && !by ? 0 : -1;
    if (s === 1) return !bx && by ? 2 : -1; // y must be the very next position
    return !bx && !by ? 2 : -1; // s === 2
  });
}

function atomMem(sigma: number, x: string, X: string): BitDFA {
  const tracks = sortTracks([fo(x), { name: X, so: true }]);
  const ix = bitIndex(tracks, x);
  const iX = bitIndex(tracks, X);
  return buildDFA(sigma, tracks, 2, 0, new Set([1]), (s, _l, bits) => {
    const bx = getBit(bits, ix);
    const bX = getBit(bits, iX);
    if (s === 0) return bx ? (bX ? 1 : -1) : 0;
    return bx ? -1 : 1; // s === 1
  });
}

// ── the recursion ─────────────────────────────────────────────────────────────
export function compileFormula(formula: Formula, alphabet: string[]): CompileResult {
  const sigma = alphabet.length;
  if (sigma === 0) throw new LogicError('the alphabet is empty');
  const letterIdx = new Map<string, number>();
  alphabet.forEach((c, i) => letterIdx.set(c, i));
  const trace: SizeTrace[] = [];
  let maxStates = 0;
  const record = (op: string, detail: string, a: BitDFA, raw?: number) => {
    maxStates = Math.max(maxStates, a.n, raw ?? 0);
    trace.push({ op, detail, states: a.n, raw });
    return a;
  };

  const go = (f: Formula): BitDFA => {
    switch (f.kind) {
      case 'true':
        return atomTrue(sigma);
      case 'false':
        return atomFalse(sigma);
      case 'label': {
        const li = letterIdx.get(f.letter);
        if (li === undefined) throw new LogicError(`letter '${f.letter}' is not in the alphabet {${alphabet.join(',')}}`);
        return atomLabel(sigma, li, f.x);
      }
      case 'lt':
        return atomLt(sigma, f.x, f.y);
      case 'le':
        return atomLe(sigma, f.x, f.y);
      case 'eq':
        return atomEq(sigma, f.x, f.y);
      case 'succ':
        return atomSucc(sigma, f.x, f.y);
      case 'mem':
        return atomMem(sigma, f.x, f.set);
      case 'not': {
        const a = go(f.a);
        const comp = minimizeBitDFA(intersectDFA(complementDFA(a), validityDFA(sigma, a.tracks)));
        return record('¬', 'complement within the valid encodings', comp);
      }
      case 'and':
      case 'or': {
        const a = go(f.a);
        const b = go(f.b);
        const u = unionTracks(a.tracks, b.tracks);
        const A = liftTo(a, u, sigma);
        const B = liftTo(b, u, sigma);
        const prod = f.kind === 'and' ? intersectDFA(A, B) : unionDFA(A, B);
        const min = minimizeBitDFA(prod);
        return record(f.kind === 'and' ? '∧' : '∨', f.kind === 'and' ? 'product automaton' : 'union automaton', min, prod.n);
      }
      case 'implies':
        return go({ kind: 'or', a: { kind: 'not', a: f.a }, b: f.b });
      case 'iff':
        return go({ kind: 'and', a: { kind: 'implies', a: f.a, b: f.b }, b: { kind: 'implies', a: f.b, b: f.a } });
      case 'existsFO': {
        let a = go(f.a);
        if (bitIndex(a.tracks, f.v) < 0) a = liftTo(a, sortTracks([...a.tracks, fo(f.v)]), sigma);
        const nfa = projectToNFA(a, f.v);
        const det = determinize(nfa);
        const min = minimizeBitDFA(det);
        return record(`∃${f.v}`, 'project the position track, then re-determinise', min, det.n);
      }
      case 'existsSO': {
        const a = go(f.a);
        if (bitIndex(a.tracks, f.v) < 0) return a; // X not free ⇒ ∃X.φ ≡ φ
        const nfa = projectToNFA(a, f.v);
        const det = determinize(nfa);
        const min = minimizeBitDFA(det);
        return record(`∃${f.v}`, 'project the set track, then re-determinise', min, det.n);
      }
      case 'forallFO':
        return go({ kind: 'not', a: { kind: 'existsFO', v: f.v, a: { kind: 'not', a: f.a } } });
      case 'forallSO':
        return go({ kind: 'not', a: { kind: 'existsSO', v: f.v, a: { kind: 'not', a: f.a } } });
    }
  };

  const automaton = minimizeBitDFA(go(formula));
  maxStates = Math.max(maxStates, automaton.n);
  return { automaton, trace, maxStates };
}

export { freeVars };
