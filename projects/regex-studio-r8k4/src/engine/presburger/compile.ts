// The Büchi–Bruyère–Villemaire construction: a Presburger formula → a finite
// automaton over {0,1}^(free vars), built by structural recursion. Compared with
// the MSO compiler this is *simpler*, because every bit-string is a valid
// natural-number encoding — there is no "validity" language to intersect with,
// so ¬ is a plain complement. The only extra care is projection: after dropping
// a track and re-determinising we **0-saturate** to restore the padding closure.
//
//   atom            → the digit-automaton for the (in)equality / congruence
//   φ ∧ ψ / φ ∨ ψ   → lift both onto the shared tracks, then product / union
//   ¬φ              → complement (all-or-none is preserved by complement)
//   ∃x. φ           → project the x-track away (NFA), re-determinise, 0-saturate
//   ∀x. φ  ≡  ¬∃x¬φ

import type { Formula } from './ast';
import {
  type BitDFA,
  bitIndex,
  sortTracks,
  unionTracks,
  liftDFA,
  intersectDFA,
  unionDFA,
  complementDFA,
  projectToNFA,
  determinize,
  minimizeBitDFA,
} from '../logic/bitaut';
import { cmpAtom, modAtom, atomConst, zeroSaturate } from './automata';

export interface SizeTrace {
  op: string;
  detail: string;
  states: number;
  raw?: number; // pre-minimisation states (the determinisation blow-up)
}

export interface PresburgerCompileResult {
  automaton: BitDFA; // over the formula's free-variable tracks
  trace: SizeTrace[];
  maxStates: number;
}

function foTrack(name: string) {
  return { name, so: false };
}

export function compilePresburgerFormula(formula: Formula): PresburgerCompileResult {
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
        return atomConst(true);
      case 'false':
        return atomConst(false);
      case 'cmp':
        return cmpAtom(f.op, f.coef, f.c);
      case 'mod':
        return modAtom(f.coef, f.r, f.m);
      case 'not': {
        const a = go(f.a);
        return record('¬', 'complement', minimizeBitDFA(complementDFA(a)));
      }
      case 'and':
      case 'or': {
        const a = go(f.a);
        const b = go(f.b);
        const u = unionTracks(a.tracks, b.tracks);
        const A = liftDFA(a, u);
        const B = liftDFA(b, u);
        const prod = f.kind === 'and' ? intersectDFA(A, B) : unionDFA(A, B);
        const min = minimizeBitDFA(prod);
        return record(f.kind === 'and' ? '∧' : '∨', f.kind === 'and' ? 'product automaton' : 'union automaton', min, prod.n);
      }
      case 'implies':
        return go({ kind: 'or', a: { kind: 'not', a: f.a }, b: f.b });
      case 'iff':
        return go({ kind: 'and', a: { kind: 'implies', a: f.a, b: f.b }, b: { kind: 'implies', a: f.b, b: f.a } });
      case 'exists': {
        const a = go(f.a);
        if (bitIndex(a.tracks, f.v) < 0) return a; // x not free ⇒ ∃x.φ ≡ φ (ℕ is non-empty)
        const nfa = projectToNFA(a, f.v);
        const det = determinize(nfa);
        const sat = zeroSaturate(det);
        const min = minimizeBitDFA(sat);
        return record(`∃${f.v}`, 'project the digit track, re-determinise, 0-saturate', min, det.n);
      }
      case 'forall':
        return go({ kind: 'not', a: { kind: 'exists', v: f.v, a: { kind: 'not', a: f.a } } });
    }
  };

  // A quantifier/atom might leave un-referenced tracks off; canonicalise once.
  const raw = go(formula);
  const automaton = minimizeBitDFA({ ...raw, tracks: sortTracks(raw.tracks) });
  maxStates = Math.max(maxStates, automaton.n);
  return { automaton, trace, maxStates };
}

export { foTrack };
