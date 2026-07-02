// Finite-state transducers — the studio's first *relation* machine.
//
// Every automaton in the studio so far *accepts or rejects* a word: it computes
// a language L ⊆ Σ*. A transducer computes a **relation** R ⊆ Σ* × Γ* — it reads
// an input word and *emits* output words. This file is the model + its
// trivially-correct reference semantics; `rational.ts`, `subseq.ts` and
// `verify.ts` build the theory on top.
//
// The model is a nondeterministic transducer with:
//   • single-symbol *reads* (`read`) — one input character, or '' for an
//     ε-move that consumes no input;
//   • arbitrary-string *writes* (`write`) — 0, 1 or many output characters;
//   • per-final-state *final outputs* (`finals`) — a set of strings appended
//     when the run ends there (subsequential transducers carry one such string;
//     plain acceptors carry '').
//
// Keeping reads to one symbol (writes stay strings) is exactly the shape that
// makes composition and determinisation clean, and it costs nothing: a
// multi-symbol read desugars to an ε-chain.

export interface FTrans {
  from: number;
  /** One input character, or '' for an ε-move (consumes no input). */
  read: string;
  /** Emitted output string; may be '', one char, or many. */
  write: string;
  to: number;
}

export interface FST {
  /** States are the integers 0 … states-1. */
  states: number;
  start: number;
  /** Accepting state → its non-empty set of final output strings. */
  finals: Map<number, string[]>;
  trans: FTrans[];
}

// ---------------------------------------------------------------------------
// Small structural helpers.
// ---------------------------------------------------------------------------

export function outgoing(fst: FST): Map<number, FTrans[]> {
  const m = new Map<number, FTrans[]>();
  for (let q = 0; q < fst.states; q++) m.set(q, []);
  for (const t of fst.trans) m.get(t.from)!.push(t);
  return m;
}

export function inputAlphabet(fst: FST): string[] {
  const s = new Set<string>();
  for (const t of fst.trans) if (t.read !== '') s.add(t.read);
  return [...s].sort();
}

export function outputAlphabet(fst: FST): string[] {
  const s = new Set<string>();
  for (const t of fst.trans) for (const c of t.write) s.add(c);
  for (const outs of fst.finals.values()) for (const o of outs) for (const c of o) s.add(c);
  return [...s].sort();
}

export function isAccepting(fst: FST, q: number): boolean {
  return fst.finals.has(q);
}

/** Every transition reads exactly one symbol (no ε-reads) → a *real-time* FST. */
export function isRealTime(fst: FST): boolean {
  return fst.trans.every((t) => t.read !== '');
}

/** Exactly one transition per (state, read symbol), all reads real, ≤1 final
 *  output each — i.e. the transducer is a *sequential / subsequential* machine
 *  (a Mealy machine with final output). Cheap structural test. */
export function isDeterministic(fst: FST): boolean {
  const seen = new Set<string>();
  for (const t of fst.trans) {
    if (t.read === '') return false;
    const key = `${t.from}:${t.read}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  for (const outs of fst.finals.values()) if (outs.length !== 1) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The reference semantics: `transduce`.
//
// Enumerate every run that consumes the whole input and ends in a final state,
// collecting the emitted output (+ that state's final output). This is the
// ground truth every construction in the studio is measured against.
//
// Termination in the presence of ε-*read* moves: within one no-input segment
// (between two real reads) a state is visited at most once per branch, which
// forbids ε-cycles (a genuinely output-pumping ε-cycle would make the relation
// infinite — we flag that as `truncated` rather than loop forever). Real reads
// reset the segment, so ε-*diamonds* that reconverge across branches are still
// fully explored.
// ---------------------------------------------------------------------------

export interface TransduceOptions {
  maxOutputs?: number;
  maxOutLen?: number;
}

export interface TransduceResult {
  /** Sorted, de-duplicated set of possible outputs. */
  outputs: string[];
  /** True if a cap (ε-cycle, output length, output count) cut enumeration short. */
  truncated: boolean;
}

export function transduceFrom(
  fst: FST,
  input: string,
  startState: number,
  opts: TransduceOptions = {},
): TransduceResult {
  const maxOutputs = opts.maxOutputs ?? 20000;
  const maxOutLen = opts.maxOutLen ?? input.length * 12 + 128;
  const adj = outgoing(fst);
  const outSet = new Set<string>();
  let truncated = false;

  const visit = (q: number, pos: number, out: string, epsSeen: Set<number>): void => {
    if (truncated) return;
    if (out.length > maxOutLen) {
      truncated = true;
      return;
    }
    if (pos === input.length) {
      const fo = fst.finals.get(q);
      if (fo) {
        for (const suf of fo) {
          const full = out + suf;
          if (full.length <= maxOutLen) {
            outSet.add(full);
            if (outSet.size > maxOutputs) {
              truncated = true;
              return;
            }
          }
        }
      }
    }
    for (const t of adj.get(q)!) {
      if (t.read === '') {
        if (epsSeen.has(t.to)) {
          // An ε-cycle: skip it. If it writes, the true relation is infinite.
          if (t.write !== '') truncated = true;
          continue;
        }
        const next = new Set(epsSeen);
        next.add(t.to);
        visit(t.to, pos, out + t.write, next);
      } else if (pos < input.length && input[pos] === t.read) {
        visit(t.to, pos + 1, out + t.write, new Set([t.to]));
      }
      if (truncated) return;
    }
  };

  visit(startState, 0, '', new Set([startState]));
  return { outputs: [...outSet].sort(), truncated };
}

export function transduce(fst: FST, input: string, opts: TransduceOptions = {}): TransduceResult {
  return transduceFrom(fst, input, fst.start, opts);
}

/** Convenience: is `input` in the domain (does at least one output exist)? */
export function inDomain(fst: FST, input: string): boolean {
  return transduce(fst, input).outputs.length > 0;
}

// ---------------------------------------------------------------------------
// A single accepting run, for the animated tape. Returns the emitted-output
// step trace of the lexicographically-first accepting run (or null if none).
// ---------------------------------------------------------------------------

export interface RunStep {
  /** State the machine is in *before* this step. */
  state: number;
  /** Input symbol consumed ('' for an ε-move). */
  read: string;
  /** Output emitted this step. */
  write: string;
  /** State after the step. */
  to: number;
}

export interface Run {
  steps: RunStep[];
  /** Final state reached. */
  end: number;
  /** Final output appended at the end (from `finals`). */
  finalOut: string;
  /** Whole emitted output = Σ writes + finalOut. */
  output: string;
}

export function traceRun(fst: FST, input: string, maxSteps = 4000): Run | null {
  const adj = outgoing(fst);
  let best: Run | null = null;

  const walk = (q: number, pos: number, steps: RunStep[], epsSeen: Set<number>, budget: { n: number }): void => {
    if (best || budget.n <= 0) return;
    budget.n--;
    if (pos === input.length) {
      const fo = fst.finals.get(q);
      if (fo && fo.length > 0) {
        const finalOut = [...fo].sort()[0];
        const output = steps.map((s) => s.write).join('') + finalOut;
        best = { steps: [...steps], end: q, finalOut, output };
        return;
      }
    }
    // Prefer real reads first for a compact tape, then ε-moves.
    const outs = adj.get(q)!;
    for (const t of outs) {
      if (best) return;
      if (t.read !== '' && pos < input.length && input[pos] === t.read) {
        steps.push({ state: q, read: t.read, write: t.write, to: t.to });
        walk(t.to, pos + 1, steps, new Set([t.to]), budget);
        steps.pop();
      }
    }
    for (const t of outs) {
      if (best) return;
      if (t.read === '' && !epsSeen.has(t.to)) {
        const next = new Set(epsSeen);
        next.add(t.to);
        steps.push({ state: q, read: '', write: t.write, to: t.to });
        walk(t.to, pos, steps, next, budget);
        steps.pop();
      }
    }
  };

  walk(fst.start, 0, [], new Set([fst.start]), { n: maxSteps });
  return best;
}

// ---------------------------------------------------------------------------
// Trim: keep only states both reachable from the start and co-reachable to a
// final state. A trim machine has the same relation and no dead weight.
// ---------------------------------------------------------------------------

export function trim(fst: FST): FST {
  const fwd = outgoing(fst);
  const reachable = new Set<number>();
  const stack = [fst.start];
  while (stack.length) {
    const q = stack.pop()!;
    if (reachable.has(q)) continue;
    reachable.add(q);
    for (const t of fwd.get(q)!) if (!reachable.has(t.to)) stack.push(t.to);
  }
  // Backward reachability from finals.
  const back = new Map<number, number[]>();
  for (let q = 0; q < fst.states; q++) back.set(q, []);
  for (const t of fst.trans) back.get(t.to)!.push(t.from);
  const coreach = new Set<number>();
  const s2 = [...fst.finals.keys()];
  while (s2.length) {
    const q = s2.pop()!;
    if (coreach.has(q)) continue;
    coreach.add(q);
    for (const p of back.get(q)!) if (!coreach.has(p)) s2.push(p);
  }
  const keep = new Set<number>();
  for (const q of reachable) if (coreach.has(q)) keep.add(q);
  if (!keep.has(fst.start)) keep.add(fst.start); // keep a valid (possibly empty) start

  // Renumber.
  const order = [...keep].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  order.forEach((q, i) => remap.set(q, i));
  const finals = new Map<number, string[]>();
  for (const [q, outs] of fst.finals) if (keep.has(q)) finals.set(remap.get(q)!, outs);
  const tr = fst.trans
    .filter((t) => keep.has(t.from) && keep.has(t.to))
    .map((t) => ({ from: remap.get(t.from)!, read: t.read, write: t.write, to: remap.get(t.to)! }));
  return { states: order.length, start: remap.get(fst.start)!, finals, trans: tr };
}

// ---------------------------------------------------------------------------
// splitWrites: rewrite every transition so its `write` has length ≤ 1, by
// threading multi-char writes through fresh ε-states. Composition needs this so
// the upstream machine feeds the downstream one *one symbol at a time*.
// Final-state outputs are left as-is (they are threaded separately).
// ---------------------------------------------------------------------------

export function splitWrites(fst: FST): FST {
  const trans: FTrans[] = [];
  let next = fst.states;
  for (const t of fst.trans) {
    if (t.write.length <= 1) {
      trans.push(t);
      continue;
    }
    // p --(read : w0)--> n1 --(ε : w1)--> … --(ε : w_{k-1})--> to
    let cur = t.from;
    for (let i = 0; i < t.write.length; i++) {
      const last = i === t.write.length - 1;
      const dest = last ? t.to : next++;
      trans.push({ from: cur, read: i === 0 ? t.read : '', write: t.write[i], to: dest });
      cur = dest;
    }
  }
  return { states: next, start: fst.start, finals: new Map(fst.finals), trans };
}

/** Deep structural clone. */
export function cloneFST(fst: FST): FST {
  return {
    states: fst.states,
    start: fst.start,
    finals: new Map([...fst.finals].map(([q, o]) => [q, [...o]])),
    trans: fst.trans.map((t) => ({ ...t })),
  };
}
