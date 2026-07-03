// Deciding an AFA **without determinising it** — emptiness and universality by
// an antichain search over macrostates, straight on the alternating machine.
//
// The backlog asked for exactly this: "Emptiness / universality directly on the
// AFA (without determinising) via an antichain search over macrostates … show
// the succinctness of deciding on the AFA itself." Here it is.
//
// A **macrostate** `S ⊆ Q` reads "every state in S must accept the rest of the
// word" (the ∧-reading the AFA→NFA construction already uses). Its language is
// `L(S) = ⋂_{q∈S} L(q)`, so it is **antitone**: `S' ⊆ S ⟹ L(S') ⊇ L(S)`. That
// one fact powers the pruning. We forward-BFS the macrostate graph from the
// minimal models of `init`, looking for an **accepting** macrostate `S ⊆ F`
// (all obligations dischargeable now) — the shortest path to one is a witness
// word. Because a smaller obligation-set accepts a superset of continuations, we
// keep only the ⊆-**minimal** macrostates reached: a macrostate subsumed by a
// retained smaller one can reach nothing new, so it is dropped. The retained set
// is an antichain, usually a sliver of the 2ⁿ subsets a determiniser would build.
//
// **Universality is then free**, because complement is: `L(A) = Σ*` iff
// `L(~A) = ∅`, and `~A` is the dual — same states, ∧↔∨ swapped. So universality
// is emptiness of the dual, and the same engine decides it. A rejected word (the
// dual's emptiness witness) proves non-universality.

import { minimalModels, complementAFA, bfAnd, BF_TRUE, type AFA, type BF } from './afa';

export interface DecisionResult {
  decided: boolean; // false ⇒ the AFA was too large (n > CAP) to sweep macrostates
  empty: boolean; // for emptiness: is L(A) = ∅ ?  (meaningless if !decided)
  witness: string | null; // shortest accepted word when non-empty (∅ if ε)
  explored: number; // macrostates the antichain search expanded
  antichainPeak: number; // peak size of the retained minimal frontier
  naiveExplored: number | null; // macrostates a no-pruning BFS visits (null if it blew the budget)
  budgetHit: boolean;
}

const N_CAP = 16; // minimalModels sweeps 2ⁿ — keep n modest, as analyzeAFA does
const DEFAULT_BUDGET = 40000;

/** ⋀_{q∈mask} δ(q, si) — the obligation a macrostate hands down on symbol si. */
function conjunction(afa: AFA, mask: number, si: number): BF {
  let conj: BF = BF_TRUE;
  for (let q = 0; q < afa.n; q++) if (mask & (1 << q)) conj = bfAnd(conj, afa.delta[q][si]);
  return conj;
}

/** Is L(A) empty? Antichain forward search over ⊆-minimal macrostates. */
export function afaEmptiness(afa: AFA, budget = DEFAULT_BUDGET): DecisionResult {
  if (afa.n > N_CAP)
    return { decided: false, empty: false, witness: null, explored: 0, antichainPeak: 0, naiveExplored: null, budgetHit: false };

  const fullMask = afa.n === 32 ? -1 >>> 0 : (1 << afa.n) - 1;
  const finalMask = afa.final.reduce((m, f, q) => (f ? m | (1 << q) : m), 0);
  const accepting = (mask: number) => (mask & ~finalMask & fullMask) === 0;

  // Retained minimal macrostates (the antichain). subsumed(S): a retained R ⊆ S.
  const retained: number[] = [];
  let antichainPeak = 0;
  const subsumed = (s: number) => retained.some((r) => (r & s) === r);
  const insert = (s: number) => {
    // Drop retained supersets of s (s is now the more dangerous, smaller one).
    for (let i = retained.length - 1; i >= 0; i--) if ((s & retained[i]) === s) retained.splice(i, 1);
    retained.push(s);
    if (retained.length > antichainPeak) antichainPeak = retained.length;
  };

  const queue: { mask: number; word: string }[] = [];
  const enqueued = new Set<number>();
  for (const m of minimalModels(afa.init, afa.n)) {
    if (!enqueued.has(m)) {
      enqueued.add(m);
      queue.push({ mask: m, word: '' });
    }
  }

  let explored = 0;
  let head = 0;
  while (head < queue.length) {
    if (explored > budget)
      return { decided: true, empty: false, witness: null, explored, antichainPeak, naiveExplored: null, budgetHit: true };
    const { mask, word } = queue[head++];
    if (accepting(mask)) {
      const naive = countNaive(afa, budget);
      return { decided: true, empty: false, witness: word, explored, antichainPeak, naiveExplored: naive, budgetHit: false };
    }
    if (subsumed(mask)) continue;
    insert(mask);
    explored++;
    for (let si = 0; si < afa.symbols.length; si++) {
      const succ = minimalModels(conjunction(afa, mask, si), afa.n);
      for (const sm of succ) {
        if (subsumed(sm)) continue;
        const nextWord = word + afa.symbols[si];
        // Cheap replay-dedup: the antichain does the real pruning; enqueued keeps
        // the queue finite without over-suppressing (a subsumed check still runs
        // on pop, so distinct words to the same mask are fine to drop).
        if (enqueued.has(sm)) continue;
        enqueued.add(sm);
        queue.push({ mask: sm, word: nextWord });
      }
    }
  }
  const naive = countNaive(afa, budget);
  return { decided: true, empty: true, witness: null, explored, antichainPeak, naiveExplored: naive, budgetHit: false };
}

/** The same forward search with no antichain pruning — the determiniser's cost. */
function countNaive(afa: AFA, budget: number): number | null {
  const fullMask = afa.n === 32 ? -1 >>> 0 : (1 << afa.n) - 1;
  const finalMask = afa.final.reduce((m, f, q) => (f ? m | (1 << q) : m), 0);
  const accepting = (mask: number) => (mask & ~finalMask & fullMask) === 0;
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const m of minimalModels(afa.init, afa.n))
    if (!seen.has(m)) {
      seen.add(m);
      queue.push(m);
    }
  let n = 0;
  let head = 0;
  while (head < queue.length) {
    if (n > budget) return null;
    const mask = queue[head++];
    n++;
    if (accepting(mask)) continue; // a naive search stops descending here too
    for (let si = 0; si < afa.symbols.length; si++)
      for (const sm of minimalModels(conjunction(afa, mask, si), afa.n))
        if (!seen.has(sm)) {
          seen.add(sm);
          queue.push(sm);
        }
  }
  return n;
}

export interface UniversalityResult extends DecisionResult {
  universal: boolean; // L(A) = Σ*  (over A's own alphabet)
}

/** Is L(A) = Σ* over A's alphabet? Emptiness of the free dual `~A`. */
export function afaUniversality(afa: AFA, budget = DEFAULT_BUDGET): UniversalityResult {
  const dual = afaEmptiness(complementAFA(afa), budget);
  return {
    ...dual,
    universal: dual.decided && dual.empty,
    // The dual's emptiness witness is a word in Σ* \ L(A) — a word A **rejects**.
    witness: dual.witness,
  };
}
