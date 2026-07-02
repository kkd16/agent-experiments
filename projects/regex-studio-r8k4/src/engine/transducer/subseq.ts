// Determinising a transducer — the deep result of the theory.
//
// A nondeterministic transducer can compute the same *function* many ways; a
// **subsequential** transducer computes it deterministically (one transition
// per input symbol, output emitted greedily as it reads, a final output string
// flushed at the end). Not every functional transducer has a subsequential
// equivalent — only those with the **twinning property** (Choffrut). The
// construction below is the transducer analogue of subset construction: a
// deterministic state is a *set of (nfa-state, pending-output)* pairs, and at
// each step we emit the **longest common prefix** of all pending outputs and
// carry the remainder forward. If the pending outputs diverge without bound
// (twinning fails), the residuals grow forever — we detect that and report the
// language is not subsequentialisable, rather than looping.

import { inputAlphabet, isRealTime, outgoing, type FST } from './fst';

export interface DeterminizeResult {
  ok: boolean;
  /** The subsequential transducer (deterministic), when ok. */
  fst?: FST;
  /** Output emitted before reading anything (the pushed-back common prefix). */
  initialOutput?: string;
  states?: number;
  reason?: string;
  /** True when construction stopped because residuals blew up (twinning fails). */
  twinningFails?: boolean;
}

const RESIDUAL_CAP = 60;
const STATE_CAP = 600;

function lcp(strings: string[]): string {
  if (strings.length === 0) return '';
  let p = strings[0];
  for (let i = 1; i < strings.length && p !== ''; i++) {
    const s = strings[i];
    let j = 0;
    const lim = Math.min(p.length, s.length);
    while (j < lim && p[j] === s[j]) j++;
    p = p.slice(0, j);
  }
  return p;
}

type Pair = { q: number; res: string };

// Canonical key for a subset state (sorted unique pairs).
function keyOf(pairs: Pair[]): string {
  return pairs
    .map((p) => `${p.q}${p.res}`)
    .sort()
    .join('');
}

function dedup(pairs: Pair[]): Pair[] {
  const seen = new Set<string>();
  const out: Pair[] = [];
  for (const p of pairs) {
    const k = `${p.q}${p.res}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out.sort((a, b) => (a.q - b.q) || (a.res < b.res ? -1 : a.res > b.res ? 1 : 0));
}

function finalString(fst: FST, q: number): string | null {
  const o = fst.finals.get(q);
  if (!o || o.length === 0) return null;
  return [...o].sort()[0];
}

export function determinize(source: FST): DeterminizeResult {
  if (!isRealTime(source)) {
    return { ok: false, reason: 'Determinisation needs a real-time transducer (no ε-reads). Split ε-moves first.' };
  }
  const adj = outgoing(source);
  const sigma = inputAlphabet(source);

  // Start subset. An initial common output can be pushed out immediately.
  const startPairs = dedup([{ q: source.start, res: '' }]);
  const initialOutput = ''; // start residual is '' → nothing to push yet

  const idOf = new Map<string, number>();
  const subsets: Pair[][] = [];
  const intern = (pairs: Pair[]): number => {
    const k = keyOf(pairs);
    let id = idOf.get(k);
    if (id === undefined) {
      id = subsets.length;
      idOf.set(k, id);
      subsets.push(pairs);
    }
    return id;
  };

  const startId = intern(startPairs);
  const trans: FST['trans'] = [];
  const finals = new Map<number, string[]>();
  const work = [startId];
  const done = new Set<number>();

  while (work.length) {
    const sid = work.pop()!;
    if (done.has(sid)) continue;
    done.add(sid);
    if (subsets.length > STATE_CAP) {
      return {
        ok: false,
        twinningFails: true,
        reason: `The residual outputs never converge — after ${STATE_CAP} deterministic states the pending output keeps growing. This transducer is functional but **not subsequentialisable**: it violates the twinning property (unbounded output delay).`,
      };
    }
    const pairs = subsets[sid];

    // Final output for this subset (if any pair sits on an accepting state).
    const finOuts: string[] = [];
    for (const p of pairs) {
      const f = finalString(source, p.q);
      if (f !== null) finOuts.push(p.res + f);
    }
    if (finOuts.length > 0) {
      // For a functional transducer these agree; take the canonical one.
      finals.set(sid, [[...finOuts].sort()[0]]);
    }

    for (const x of sigma) {
      const succ: Pair[] = [];
      for (const p of pairs) {
        for (const t of adj.get(p.q)!) {
          if (t.read === x) succ.push({ q: t.to, res: p.res + t.write });
        }
      }
      if (succ.length === 0) continue; // x not defined here → partial (domain-restricted)
      const merged = dedup(succ);
      const common = lcp(merged.map((p) => p.res));
      const stripped = merged.map((p) => ({ q: p.q, res: p.res.slice(common.length) }));
      // Twinning guard: any residual longer than the cap → give up.
      if (stripped.some((p) => p.res.length > RESIDUAL_CAP)) {
        return {
          ok: false,
          twinningFails: true,
          reason: `The pending output grew past ${RESIDUAL_CAP} symbols without the branches agreeing — this transducer is functional but **not subsequentialisable** (the twinning property fails: it would need unbounded look-ahead to decide what to emit).`,
        };
      }
      const to = intern(dedup(stripped));
      trans.push({ from: sid, read: x, write: common, to });
      if (!done.has(to)) work.push(to);
    }
  }

  return {
    ok: true,
    fst: { states: subsets.length, start: startId, finals, trans },
    initialOutput,
    states: subsets.length,
  };
}

// ---------------------------------------------------------------------------
// Running a subsequential (deterministic) transducer: walk one path, emit as we
// go, flush the final output. Returns null when the input leaves the domain.
// ---------------------------------------------------------------------------

export function runSubseq(fst: FST, input: string, initialOutput = ''): string | null {
  const adj = outgoing(fst);
  let state = fst.start;
  let out = initialOutput;
  for (const ch of input) {
    const t = adj.get(state)!.find((e) => e.read === ch);
    if (!t) return null;
    out += t.write;
    state = t.to;
  }
  const f = fst.finals.get(state);
  if (!f || f.length === 0) return null;
  return out + [...f].sort()[0];
}
