// The weighted finite automaton (WFA) and the three ways to read it.
//
// A WFA over a semiring K is the Boolean ε-free automaton this studio already
// builds (Glushkov's position automaton), with a **weight κ[q] ∈ K on every
// state q** — equivalently, on every edge *entering* q, since the position
// automaton is *homogeneous* (all in-edges to q share q's letter class). So a
// run that visits positions q₁q₂…qₙ carries the ⊗-product κ[q₁]⊗…⊗κ[qₙ], and
// the **weight of a word** is the ⊕-sum of that over every accepting run.
//
// Three independent computations of the same number guard each other:
//
//   forward   — vector·matrix sweep left→right  (the WFA "forward algorithm")
//   backward  — final·matrix sweep right→left   (transposed; same answer)
//   the brute oracle (woracle.ts) — enumerate every accepting run and ⊕ them
//
// And one *global* quantity — `λ·M*·γ`, the ⊕ over **all** words of their weight
// — computed two more independent ways: Lehmann's closed-form matrix asteration
// here, and state-elimination into a weighted regular expression (welim.ts).
// That global value *is* the shortest distance (tropical), the total path count
// (counting), the language mass (probability) — Mohri's algebraic path problem.

import type { CharSet } from '../charset';
import type { GraphInput } from '../layout';
import type { Semiring } from './semiring';

export interface WEdge<K> {
  to: number;
  set: CharSet;
  w: K; // κ[to] — the weight of entering the target position
}

export interface WFA<K> {
  n: number; // states 0…n-1 (0 is the Glushkov start ι)
  initial: number; // the single initial state (always 0)
  accept: boolean[]; // accepting flags; final weight = 1̄ if accepting else 0̄
  out: WEdge<K>[][]; // adjacency, grouped by source state
  positions: CharSet[]; // [p] = the class at state p (for labels); [0] unused
  weights: K[]; // κ[p] for every state (κ[0] is the start, unused = 1̄)
}

// --- Forward evaluation: λ · μ(a₁) · μ(a₂) · … · μ(aₙ) · γ -------------------

export function wordWeightForward<K>(wfa: WFA<K>, sr: Semiring<K>, codes: number[]): K {
  let v = new Array<K>(wfa.n).fill(sr.zero);
  v[wfa.initial] = sr.one;
  for (const c of codes) {
    const next = new Array<K>(wfa.n).fill(sr.zero);
    for (let s = 0; s < wfa.n; s++) {
      const vs = v[s];
      if (vs === sr.zero) continue; // a genuine optimisation only when zero is the literal value
      for (const e of wfa.out[s]) {
        if (!e.set.contains(c)) continue;
        next[e.to] = sr.plus(next[e.to], sr.times(vs, e.w));
      }
    }
    v = next;
  }
  let acc = sr.zero;
  for (let t = 0; t < wfa.n; t++) if (wfa.accept[t]) acc = sr.plus(acc, v[t]);
  return acc;
}

// --- Backward evaluation: the transpose sweep, right→left --------------------
// A genuinely separate code path (it never builds the forward vector), so a
// transcription bug in one direction can't hide in the other.

export function wordWeightBackward<K>(wfa: WFA<K>, sr: Semiring<K>, codes: number[]): K {
  // Pre-index in-edges: rev[t] = list of (from, set, w) entering t.
  const rev: WEdge<K>[][] = Array.from({ length: wfa.n }, () => []);
  for (let s = 0; s < wfa.n; s++) for (const e of wfa.out[s]) rev[e.to].push({ to: s, set: e.set, w: e.w });

  let u = new Array<K>(wfa.n).fill(sr.zero);
  for (let t = 0; t < wfa.n; t++) if (wfa.accept[t]) u[t] = sr.one;
  for (let i = codes.length - 1; i >= 0; i--) {
    const c = codes[i];
    const prev = new Array<K>(wfa.n).fill(sr.zero);
    for (let t = 0; t < wfa.n; t++) {
      const ut = u[t];
      if (ut === sr.zero) continue;
      for (const e of rev[t]) {
        if (!e.set.contains(c)) continue; // e.to here is the *source* s
        prev[e.to] = sr.plus(prev[e.to], sr.times(e.w, ut));
      }
    }
    u = prev;
  }
  return u[wfa.initial];
}

export function wordWeight<K>(wfa: WFA<K>, sr: Semiring<K>, word: string): K {
  return wordWeightForward(wfa, sr, Array.from(word, (ch) => ch.codePointAt(0)!));
}

// --- The combined transition matrix over a working alphabet ------------------
// M[s][t] = ⊕ over the letters a ∈ Σ that label the edge s→t, of its weight.
// (A class spanning several Σ-letters contributes that many ⊕-copies — exactly
// the "count each distinct one-letter word" the all-words sum demands.)

export function combinedMatrix<K>(wfa: WFA<K>, sr: Semiring<K>, alphabet: number[]): K[][] {
  const M: K[][] = Array.from({ length: wfa.n }, () => new Array<K>(wfa.n).fill(sr.zero));
  for (let s = 0; s < wfa.n; s++) {
    for (const e of wfa.out[s]) {
      for (const a of alphabet) {
        if (e.set.contains(a)) M[s][t_(e)] = sr.plus(M[s][t_(e)], e.w);
      }
    }
  }
  return M;
}
const t_ = <K>(e: WEdge<K>) => e.to;

// --- The closed-form matrix asteration M* (Kleene / Conway / Lehmann) ---------
//
// M* = I ⊕ M ⊕ M² ⊕ … satisfies M* = I ⊕ M·M*. The Gauss-Jordan recurrence
//
//     A⁽ᵏ⁾[i][j] = A⁽ᵏ⁻¹⁾[i][j] ⊕ A⁽ᵏ⁻¹⁾[i][k] ⊗ (A⁽ᵏ⁻¹⁾[k][k])* ⊗ A⁽ᵏ⁻¹⁾[k][j]
//
// works over *any* closed semiring in O(n³) ring operations. Two correctness
// hazards, both handled here: (1) the diagonal star must be applied **exactly
// once** per relaxation — pre-scaling both the k-column and k-row would square it
// (invisible when star is idempotent, wrong for Probability) — so we snapshot the
// pivot column, row and scalar from A⁽ᵏ⁻¹⁾ before relaxing; (2) the recurrence
// yields M⁺, so we fold the reflexive 1̄ onto the diagonal at the end (M* = I ⊕ M⁺).

export function closureMatrixLehmann<K>(M0: K[][], sr: Semiring<K>): K[][] {
  const n = M0.length;
  const A: K[][] = M0.map((row) => row.slice());
  for (let k = 0; k < n; k++) {
    const skk = sr.star(A[k][k]);
    const col = A.map((row) => row[k]); // A⁽ᵏ⁻¹⁾[·][k]
    const row = A[k].slice(); // A⁽ᵏ⁻¹⁾[k][·]
    for (let i = 0; i < n; i++) {
      const cik = sr.times(col[i], skk); // A[i][k] ⊗ skk — the star, applied once
      if (cik === sr.zero) continue;
      const Ai = A[i];
      for (let j = 0; j < n; j++) Ai[j] = sr.plus(Ai[j], sr.times(cik, row[j]));
    }
  }
  for (let i = 0; i < n; i++) A[i][i] = sr.plus(sr.one, A[i][i]); // M* = I ⊕ M⁺
  return A;
}

// --- Iterative closure: ⊕_{k=0..K} Mᵏ — the independent referee --------------
// Exact for finite (nilpotent) languages; for idempotent semirings it reaches a
// fixpoint. Used by the verifier to cross-check Lehmann and to give the panel an
// honest "did the all-words sum converge?" verdict.

export function closureMatrixIterative<K>(
  M: K[][],
  sr: Semiring<K>,
  maxPow: number,
): { sum: K[][]; converged: boolean } {
  const n = M.length;
  const I: K[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? sr.one : sr.zero)),
  );
  let power = I.map((r) => r.slice()); // M⁰ = I
  let sum = I.map((r) => r.slice());
  let prev = matKey(sum, sr);
  let converged = false;
  for (let k = 1; k <= maxPow; k++) {
    power = matMul(power, M, sr);
    const next = matAdd(sum, power, sr);
    sum = next;
    const key = matKey(sum, sr);
    if (key === prev) {
      converged = true;
      break;
    }
    prev = key;
  }
  return { sum, converged };
}

function matMul<K>(A: K[][], B: K[][], sr: Semiring<K>): K[][] {
  const n = A.length;
  const C: K[][] = Array.from({ length: n }, () => new Array<K>(n).fill(sr.zero));
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) {
      const aik = A[i][k];
      if (aik === sr.zero) continue;
      for (let j = 0; j < n; j++) C[i][j] = sr.plus(C[i][j], sr.times(aik, B[k][j]));
    }
  return C;
}
function matAdd<K>(A: K[][], B: K[][], sr: Semiring<K>): K[][] {
  return A.map((row, i) => row.map((x, j) => sr.plus(x, B[i][j])));
}
function matKey<K>(A: K[][], sr: Semiring<K>): string {
  return A.map((row) => row.map((x) => sr.show(x)).join(',')).join(';');
}

// The all-words weight ⊕_{w ∈ Σ*} weight(w) = λ·M*·γ, read off a closure matrix.
export function closureValue<K>(wfa: WFA<K>, sr: Semiring<K>, Mstar: K[][]): K {
  let acc = sr.zero;
  for (let t = 0; t < wfa.n; t++) if (wfa.accept[t]) acc = sr.plus(acc, Mstar[wfa.initial][t]);
  return acc;
}

// --- Reachable / co-reachable trim ------------------------------------------
// Drops states that host no realisable run — keeps the rendered graph and the
// state-elimination output honest without changing any weight.

export function trimReachable<K>(wfa: WFA<K>): WFA<K> {
  const fwd = new Array<boolean>(wfa.n).fill(false);
  const st = [wfa.initial];
  fwd[wfa.initial] = true;
  while (st.length) {
    const s = st.pop()!;
    for (const e of wfa.out[s])
      if (!fwd[e.to]) {
        fwd[e.to] = true;
        st.push(e.to);
      }
  }
  const rev: number[][] = Array.from({ length: wfa.n }, () => []);
  for (let s = 0; s < wfa.n; s++) for (const e of wfa.out[s]) rev[e.to].push(s);
  const back = new Array<boolean>(wfa.n).fill(false);
  const st2: number[] = [];
  for (let s = 0; s < wfa.n; s++)
    if (wfa.accept[s]) {
      back[s] = true;
      st2.push(s);
    }
  while (st2.length) {
    const s = st2.pop()!;
    for (const p of rev[s])
      if (!back[p]) {
        back[p] = true;
        st2.push(p);
      }
  }
  const keep = (s: number) => fwd[s] && back[s];
  if (!keep(wfa.initial)) {
    // The whole automaton accepts nothing reachable; keep just the start.
    return {
      n: 1,
      initial: 0,
      accept: [wfa.accept[wfa.initial]],
      out: [[]],
      positions: [wfa.positions[wfa.initial]],
      weights: [wfa.weights[wfa.initial]],
    };
  }
  const id = new Array<number>(wfa.n).fill(-1);
  let m = 0;
  for (let s = 0; s < wfa.n; s++) if (keep(s)) id[s] = m++;
  const out: WEdge<K>[][] = Array.from({ length: m }, () => []);
  for (let s = 0; s < wfa.n; s++) {
    if (id[s] < 0) continue;
    for (const e of wfa.out[s]) if (id[e.to] >= 0) out[id[s]].push({ to: id[e.to], set: e.set, w: e.w });
  }
  const accept = new Array<boolean>(m).fill(false);
  const positions: CharSet[] = new Array(m);
  const weights: K[] = new Array(m);
  for (let s = 0; s < wfa.n; s++)
    if (id[s] >= 0) {
      accept[id[s]] = wfa.accept[s];
      positions[id[s]] = wfa.positions[s];
      weights[id[s]] = wfa.weights[s];
    }
  return { n: m, initial: id[wfa.initial], accept, out, positions, weights };
}

// --- Finiteness / longest accepted word -------------------------------------
// On the trimmed (useful-state) automaton: returns the length of the longest
// accepted word, or null when an accepting cycle makes the language infinite.
// Lets a caller know when a brute Σ^{≤L} sweep is *complete* (and so exact in
// every semiring) rather than a truncation.

export function maxAcceptedLength<K>(wfa: WFA<K>): number | null {
  const t = trimReachable(wfa);
  const color = new Int8Array(t.n); // 0 white, 1 grey (on stack), 2 black
  const memo = new Array<number>(t.n).fill(Number.NEGATIVE_INFINITY);
  let cyclic = false;
  const dfs = (s: number): number => {
    color[s] = 1;
    let best = t.accept[s] ? 0 : Number.NEGATIVE_INFINITY;
    for (const e of t.out[s]) {
      if (color[e.to] === 1) {
        cyclic = true;
        return Number.NEGATIVE_INFINITY;
      }
      const sub = color[e.to] === 2 ? memo[e.to] : dfs(e.to);
      if (cyclic) return Number.NEGATIVE_INFINITY;
      if (sub > Number.NEGATIVE_INFINITY) best = Math.max(best, 1 + sub);
    }
    color[s] = 2;
    memo[s] = best;
    return best;
  };
  const res = dfs(t.initial);
  if (cyclic) return null;
  return res === Number.NEGATIVE_INFINITY ? 0 : res;
}

// --- Graph adapter: edges labelled `class / weight`, accepting states ringed --

export function wfaToGraph<K>(wfa: WFA<K>, sr: Semiring<K>): GraphInput {
  const nodes = wfa.positions.map((_, id) => ({ id, label: id === wfa.initial ? 'ι' : String(id) }));
  const accepts = new Set<number>();
  for (let s = 0; s < wfa.n; s++) if (wfa.accept[s]) accepts.add(s);
  const edges = [];
  for (let s = 0; s < wfa.n; s++) {
    for (const e of wfa.out[s]) {
      const wl = sr.show(e.w);
      edges.push({
        from: s,
        to: e.to,
        label: wl === sr.show(sr.one) ? e.set.label() : `${e.set.label()} / ${wl}`,
        epsilon: false,
      });
    }
  }
  return { nodes, edges, start: wfa.initial, accepts };
}
