// Rational operations on transducers — the closure properties that make
// "regular" and "rational" the same word, one dimension up.
//
// The **rational relations** (a.k.a. regular relations) are exactly the
// relations computed by finite transducers, and — Elgot–Mezei — they are closed
// under union, concatenation, Kleene star **and composition**. The first three
// are the transducer twins of Thompson's ε-NFA constructions; composition is
// the deep one (T1 then T2, feeding one machine's output into the other's
// input) and the reason transducers *chain* into pipelines.

import type { DFA } from '../dfa';
import { transduceFrom, type FST, type FTrans, splitWrites, trim } from './fst';

// Offset every state of `fst` by `base` (finals + transitions).
function shift(fst: FST, base: number): { finals: Map<number, string[]>; trans: FTrans[] } {
  const finals = new Map<number, string[]>();
  for (const [q, o] of fst.finals) finals.set(q + base, [...o]);
  const trans = fst.trans.map((t) => ({ from: t.from + base, read: t.read, write: t.write, to: t.to + base }));
  return { finals, trans };
}

/** T_a ∪ T_b: a fresh start ε-branches into both machines. */
export function union(a: FST, b: FST): FST {
  const start = 0;
  const aBase = 1;
  const bBase = 1 + a.states;
  const A = shift(a, aBase);
  const B = shift(b, bBase);
  const trans: FTrans[] = [
    { from: start, read: '', write: '', to: a.start + aBase },
    { from: start, read: '', write: '', to: b.start + bBase },
    ...A.trans,
    ...B.trans,
  ];
  const finals = new Map<number, string[]>([...A.finals, ...B.finals]);
  return trim({ states: 1 + a.states + b.states, start, finals, trans });
}

/** T_a · T_b: each a-final ε-emits its final output, then hands off to b's start. */
export function concat(a: FST, b: FST): FST {
  const aBase = 0;
  const bBase = a.states;
  const B = shift(b, bBase);
  const trans: FTrans[] = [...a.trans, ...B.trans];
  for (const [q, outs] of a.finals) {
    for (const o of outs) {
      trans.push({ from: q + aBase, read: '', write: o, to: b.start + bBase });
    }
  }
  return trim({ states: a.states + b.states, start: a.start + aBase, finals: B.finals, trans });
}

/** T_a*: a fresh accepting start; loop back through a's finals. */
export function star(a: FST): FST {
  const start = 0;
  const aBase = 1;
  const A = shift(a, aBase);
  const trans: FTrans[] = [{ from: start, read: '', write: '', to: a.start + aBase }, ...A.trans];
  // Loop back to the accepting start (which itself re-enters a.start), so the
  // star both accepts and can iterate again — Thompson's star for transducers.
  for (const [q, outs] of a.finals) {
    for (const o of outs) {
      trans.push({ from: q + aBase, read: '', write: o, to: start });
    }
  }
  const finals = new Map<number, string[]>([[start, ['']]]);
  return trim({ states: 1 + a.states, start, finals, trans });
}

// ---------------------------------------------------------------------------
// identity(L): the transducer that echoes exactly the words of a regular
// language and rejects the rest — the bridge from the whole rest of the studio
// (regex → DFA) into the transducer world. Reads each DFA edge's representative
// symbol and writes it unchanged.
// ---------------------------------------------------------------------------

export function identityFromDFA(dfa: DFA): { fst: FST; alphabet: string[] } {
  const alpha = new Set<string>();
  const trans: FTrans[] = [];
  for (const t of dfa.transitions) {
    // A representative character for each atomic class this edge covers.
    for (const atomIdx of edgeAtoms(dfa, t)) {
      const atom = dfa.atoms[atomIdx];
      const ch = String.fromCodePoint(atom.lo);
      alpha.add(ch);
      trans.push({ from: t.from, read: ch, write: ch, to: t.to });
    }
  }
  const finals = new Map<number, string[]>();
  for (const s of dfa.states) if (s.accept) finals.set(s.id, ['']);
  const fst = trim({ states: dfa.states.length, start: dfa.start, finals, trans });
  return { fst, alphabet: [...alpha].sort() };
}

// Which atom indices a DFA transition covers (its label is the union of atoms).
function edgeAtoms(dfa: DFA, t: DFA['transitions'][number]): number[] {
  const out: number[] = [];
  dfa.atoms.forEach((atom, i) => {
    if (t.set.contains(atom.lo)) out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------------------
// compose(a, b) = a ; b: the relation {(x, z) : ∃ y, (x,y) ∈ a and (y,z) ∈ b}.
//
// We split `a`'s writes to single symbols, then form the product of states
// (p in a, q in b) and interleave three kinds of move:
//   • a emits one symbol c that b immediately reads  →  read a's input, write
//     b's output;
//   • a emits nothing (ε-write)                       →  a advances alone;
//   • b reads nothing (ε-read)                        →  b advances alone,
//     emitting its output.
// This over-generates *runs* but computes the exact output *relation* — the
// point of composition — so no ε-filter is needed. At a product-final (p,q)
// where p is an a-final, a's final output is threaded through b from q.
// ---------------------------------------------------------------------------

export function compose(a0: FST, b: FST): FST {
  const a = splitWrites(a0);
  const aOut = new Map<number, FTrans[]>();
  for (let q = 0; q < a.states; q++) aOut.set(q, []);
  for (const t of a.trans) aOut.get(t.from)!.push(t);
  const bOut = new Map<number, FTrans[]>();
  for (let q = 0; q < b.states; q++) bOut.set(q, []);
  for (const t of b.trans) bOut.get(t.from)!.push(t);
  // Index b's real (non-ε) reads by symbol for the matching move.
  const bByRead = new Map<number, Map<string, FTrans[]>>();
  for (let q = 0; q < b.states; q++) bByRead.set(q, new Map());
  for (const t of b.trans) {
    if (t.read !== '') {
      const m = bByRead.get(t.from)!;
      if (!m.has(t.read)) m.set(t.read, []);
      m.get(t.read)!.push(t);
    }
  }

  const key = (p: number, q: number) => p * b.states + q;
  const idOf = new Map<number, number>();
  const stateList: { p: number; q: number }[] = [];
  const intern = (p: number, q: number): number => {
    const k = key(p, q);
    let id = idOf.get(k);
    if (id === undefined) {
      id = stateList.length;
      idOf.set(k, id);
      stateList.push({ p, q });
    }
    return id;
  };

  const trans: FTrans[] = [];
  const startId = intern(a.start, b.start);
  const work = [startId];
  const done = new Set<number>();
  while (work.length) {
    const sid = work.pop()!;
    if (done.has(sid)) continue;
    done.add(sid);
    const { p, q } = stateList[sid];
    const push = (read: string, write: string, np: number, nq: number) => {
      const to = intern(np, nq);
      trans.push({ from: sid, read, write, to });
      if (!done.has(to)) work.push(to);
    };
    // a moves.
    for (const ta of aOut.get(p)!) {
      if (ta.write === '') {
        push(ta.read, '', ta.to, q); // a emits nothing → b stays
      } else {
        const c = ta.write; // a single symbol (writes were split)
        for (const tb of bByRead.get(q)!.get(c) ?? []) {
          push(ta.read, tb.write, ta.to, tb.to); // b consumes c
        }
      }
    }
    // b moves on its own via ε-reads.
    for (const tb of bOut.get(q)!) {
      if (tb.read === '') push('', tb.write, p, tb.to);
    }
  }

  // Finals: (p,q) final iff p is an a-final and threading a's final output O
  // through b from q reaches a b-final. The composed final outputs are those z.
  const finals = new Map<number, string[]>();
  for (let sid = 0; sid < stateList.length; sid++) {
    const { p, q } = stateList[sid];
    const aFin = a.finals.get(p);
    if (!aFin) continue;
    const outs = new Set<string>();
    for (const O of aFin) {
      const res = transduceFrom(b, O, q);
      for (const z of res.outputs) outs.add(z);
    }
    if (outs.size > 0) finals.set(sid, [...outs].sort());
  }

  return trim({ states: stateList.length, start: startId, finals, trans });
}
