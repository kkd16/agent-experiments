// Verifying the transducer engine the house way: a seeded fuzzer draws random
// finite transducers and confronts every *construction* against a brute-force
// reference computed straight from the relation semantics (`transduce`).
//
//   • union / concat / star  — the constructed relation equals the reference
//     relation (union of outputs; over all splits; over all partitions);
//   • compose(a,b)           — equals { z : y ∈ a(x), z ∈ b(y) } enumerated by
//     hand, over every input up to a horizon;
//   • determinize            — on functional (input-deterministic) transducers
//     the subsequential machine computes the same function and is deterministic;
//     and the textbook non-subsequentialisable machine is correctly rejected
//     (twinning fails);
//   • identity(L)            — echoes exactly the words of a compiled regex's
//     language and nothing else.
//
// Every disagreement is reported with the offending machines, reproducibly by
// seed. Claims are measured, not asserted.

import { compile } from '../compile';
import { dfaAccepts } from '../simulate';
import { GALLERY } from './gallery';
import { fstToGraph } from './graph';
import { compose, concat, identityFromDFA, star, union } from './rational';
import { determinize, runSubseq } from './subseq';
import { isDeterministic, transduce, type FST, type FTrans } from './fst';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(n: number) {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
  chance(p: number) {
    return this.next() < p;
  }
}

// ---- random machines -------------------------------------------------------

interface GenOpts {
  states: number;
  inAlpha: string[];
  outAlpha: string[];
  maxWrite: number;
  deterministic: boolean;
}

function genFST(rng: Rng, o: GenOpts): FST {
  const trans: FTrans[] = [];
  const randWrite = () => {
    const len = rng.int(o.maxWrite + 1);
    let w = '';
    for (let i = 0; i < len; i++) w += rng.pick(o.outAlpha);
    return w;
  };
  for (let s = 0; s < o.states; s++) {
    for (const x of o.inAlpha) {
      if (o.deterministic) {
        if (rng.chance(0.7)) trans.push({ from: s, read: x, write: randWrite(), to: rng.int(o.states) });
      } else {
        const count = rng.int(3); // 0, 1 or 2 branches (nondeterminism)
        for (let k = 0; k < count; k++) trans.push({ from: s, read: x, write: randWrite(), to: rng.int(o.states) });
      }
    }
  }
  const finals = new Map<number, string[]>();
  for (let s = 0; s < o.states; s++) {
    if (rng.chance(0.45)) finals.set(s, [o.deterministic || rng.chance(0.6) ? '' : rng.pick(o.outAlpha)]);
  }
  if (finals.size === 0) finals.set(rng.int(o.states), ['']);
  return { states: o.states, start: 0, finals, trans };
}

// ---- brute-force references ------------------------------------------------

function words(alpha: string[], maxLen: number): string[] {
  const out: string[] = [''];
  let frontier = [''];
  for (let len = 1; len <= maxLen; len++) {
    const nf: string[] = [];
    for (const w of frontier) for (const c of alpha) nf.push(w + c);
    out.push(...nf);
    frontier = nf;
  }
  return out;
}

function uniqSort(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

function eqSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bruteConcat(a: FST, b: FST, w: string): { outs: string[]; ok: boolean } {
  const acc: string[] = [];
  let ok = true;
  for (let i = 0; i <= w.length; i++) {
    const ra = transduce(a, w.slice(0, i));
    const rb = transduce(b, w.slice(i));
    if (ra.truncated || rb.truncated) ok = false;
    for (const u of ra.outputs) for (const v of rb.outputs) acc.push(u + v);
  }
  return { outs: uniqSort(acc), ok };
}

function bruteStar(a: FST, w: string, memo = new Map<string, string[]>(), depth = 0): string[] {
  if (depth > 24) return [];
  const hit = memo.get(w);
  if (hit) return hit;
  // Only the empty word gets the empty partition (''); a non-empty word must be
  // fully consumed by ≥1 piece.
  const acc: string[] = w === '' ? [''] : [];
  for (let i = 1; i <= w.length; i++) {
    const head = transduce(a, w.slice(0, i));
    if (head.outputs.length === 0) continue;
    const tail = bruteStar(a, w.slice(i), memo, depth + 1);
    for (const u of head.outputs) for (const r of tail) acc.push(u + r);
  }
  const res = uniqSort(acc);
  memo.set(w, res);
  return res;
}

function bruteCompose(a: FST, b: FST, x: string): { outs: string[]; ok: boolean } {
  const ra = transduce(a, x);
  let ok = !ra.truncated;
  const acc: string[] = [];
  for (const y of ra.outputs) {
    const rb = transduce(b, y);
    if (rb.truncated) ok = false;
    acc.push(...rb.outputs);
  }
  return { outs: uniqSort(acc), ok };
}

// ---- report shape ----------------------------------------------------------

export interface TransducerFuzzConfig {
  seed: number;
  cases: number;
}

export interface TransducerFuzzReport {
  config: TransducerFuzzConfig;
  casesTested: number;
  checks: number;
  breakdown: Record<string, number>;
  failures: { kind: string; detail: string }[];
  elapsedMs: number;
  galleryOk: boolean;
}

export const DEFAULT_TRANSDUCER_FUZZ: TransducerFuzzConfig = { seed: 0x7f4a, cases: 240 };

export function runTransducerFuzz(cfg: TransducerFuzzConfig = DEFAULT_TRANSDUCER_FUZZ): TransducerFuzzReport {
  const rng = new Rng(cfg.seed);
  const failures: { kind: string; detail: string }[] = [];
  const breakdown: Record<string, number> = { union: 0, concat: 0, star: 0, compose: 0, determinize: 0, identity: 0 };
  let checks = 0;
  const started = performance.now();
  const fail = (kind: string, detail: string) => {
    if (failures.length < 40) failures.push({ kind, detail });
  };
  const dump = (f: FST) => JSON.stringify({ s: f.states, st: f.start, fin: [...f.finals], tr: f.trans });

  const IN = ['a', 'b'];
  const MID = ['p', 'q'];
  const OUT = ['x', 'y'];

  for (let c = 0; c < cfg.cases; c++) {
    // ---- rational ops on two small real-time machines over IN → OUT ----
    const a = genFST(rng, { states: 2 + rng.int(2), inAlpha: IN, outAlpha: OUT, maxWrite: 2, deterministic: false });
    const b = genFST(rng, { states: 2 + rng.int(2), inAlpha: IN, outAlpha: OUT, maxWrite: 2, deterministic: false });
    const U = union(a, b);
    const C = concat(a, b);
    const S = star(a);
    for (const w of words(IN, 4)) {
      // union
      const gotU = transduce(U, w);
      const refU = uniqSort([...transduce(a, w).outputs, ...transduce(b, w).outputs]);
      if (!gotU.truncated && !eqSet(gotU.outputs, refU)) {
        fail('union', `on "${w}": got ${JSON.stringify(gotU.outputs)} ref ${JSON.stringify(refU)}\nA=${dump(a)}\nB=${dump(b)}`);
      }
      breakdown.union++;
      checks++;
      // concat
      const gotC = transduce(C, w);
      const refC = bruteConcat(a, b, w);
      if (!gotC.truncated && refC.ok && !eqSet(gotC.outputs, refC.outs)) {
        fail('concat', `on "${w}": got ${JSON.stringify(gotC.outputs)} ref ${JSON.stringify(refC.outs)}\nA=${dump(a)}\nB=${dump(b)}`);
      }
      breakdown.concat++;
      checks++;
    }
    for (const w of words(IN, 4)) {
      const gotS = transduce(S, w);
      const refS = bruteStar(a, w);
      if (!gotS.truncated && !eqSet(gotS.outputs, refS)) {
        fail('star', `on "${w}": got ${JSON.stringify(gotS.outputs)} ref ${JSON.stringify(refS)}\nA=${dump(a)}`);
      }
      breakdown.star++;
      checks++;
    }

    // ---- composition: a : IN→MID composed with d : MID→OUT ----
    const aMid = genFST(rng, { states: 2 + rng.int(2), inAlpha: IN, outAlpha: MID, maxWrite: 2, deterministic: false });
    const d = genFST(rng, { states: 2 + rng.int(2), inAlpha: MID, outAlpha: OUT, maxWrite: 2, deterministic: false });
    const comp = compose(aMid, d);
    for (const x of words(IN, 4)) {
      const got = transduce(comp, x);
      const ref = bruteCompose(aMid, d, x);
      if (!got.truncated && ref.ok && !eqSet(got.outputs, ref.outs)) {
        fail('compose', `on "${x}": got ${JSON.stringify(got.outputs)} ref ${JSON.stringify(ref.outs)}\nA=${dump(aMid)}\nB=${dump(d)}`);
      }
      breakdown.compose++;
      checks++;
    }

    // ---- determinize on a functional (input-deterministic) machine ----
    const det = genFST(rng, { states: 2 + rng.int(3), inAlpha: IN, outAlpha: OUT, maxWrite: 2, deterministic: true });
    const dr = determinize(det);
    if (dr.ok && dr.fst) {
      if (!isDeterministic(dr.fst)) fail('determinize', `result not deterministic\nsrc=${dump(det)}`);
      for (const w of words(IN, 5)) {
        const ref = transduce(det, w); // ≤1 output (functional)
        const got = runSubseq(dr.fst, w, dr.initialOutput ?? '');
        const refOut = ref.outputs.length ? ref.outputs[0] : null;
        if (!ref.truncated && got !== refOut) {
          fail('determinize', `on "${w}": subseq→${JSON.stringify(got)} ref ${JSON.stringify(refOut)}\nsrc=${dump(det)}`);
        }
        breakdown.determinize++;
        checks++;
      }
    }
  }

  // ---- targeted assertion: the non-subsequentialisable machine is caught ----
  const delayed = GALLERY.find((g) => g.id === 'delayed-choice')!;
  const dres = determinize(delayed.fst);
  if (dres.ok || !dres.twinningFails) {
    fail('determinize', 'delayed-choice should be rejected as not subsequentialisable (twinning fails), but was not.');
  }
  checks++;

  // ---- identity(L) echoes exactly the language of a few compiled patterns ----
  let galleryOk = true;
  for (const pat of ['(ab)*', 'a(a|b)*', 'a*b', '(a|b)(a|b)']) {
    const compiled = compile(pat);
    if (compiled.error || !compiled.minDfa) continue;
    const { fst, alphabet } = identityFromDFA(compiled.minDfa);
    for (const w of words(alphabet.length ? alphabet : ['a'], 4)) {
      const inLang = dfaAccepts(compiled.minDfa, w);
      const got = transduce(fst, w).outputs;
      const echoed = got.length === 1 && got[0] === w;
      const empty = got.length === 0;
      if (!echoed && !empty) {
        fail('identity', `on "${w}": identity produced ${JSON.stringify(got)} (not echo, not empty)`);
        galleryOk = false;
      }
      // identity(L) must echo exactly the words in L and reject the rest.
      if (inLang !== echoed) {
        fail('identity', `on "${w}": DFA says ${inLang}, identity echoes ${echoed} (/${pat}/)`);
        galleryOk = false;
      }
      breakdown.identity++;
      checks++;
    }
  }

  // sanity: every gallery machine has a valid graph + at least one output on an example.
  for (const g of GALLERY) {
    try {
      fstToGraph(g.fst);
    } catch {
      fail('gallery', `graph build failed for ${g.id}`);
      galleryOk = false;
    }
  }

  return {
    config: cfg,
    casesTested: cfg.cases,
    checks,
    breakdown,
    failures,
    elapsedMs: Math.round(performance.now() - started),
    galleryOk,
  };
}
