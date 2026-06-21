// Counting the language — the enumerative combinatorics of a regular set.
//
// A regular language has a *rational* generating function: if sₙ is the number
// of words of length n it contains, then S(x) = Σ sₙ xⁿ = P(x)/Q(x) for
// polynomials P, Q (Chomsky–Schützenberger). Everything follows from the DFA's
// TRANSFER MATRIX M, where M[i][j] counts the alphabet symbols taking state i to
// state j: sₙ = uᵀ Mⁿ v with u the start indicator and v the accept indicator,
// so S(x) = uᵀ(I − xM)⁻¹v.
//
// We compute it exactly. The characteristic polynomial of M (by the integer
// Faddeev–LeVerrier recursion) gives, via Cayley–Hamilton, the linear
// recurrence the counts obey; reversing it is the denominator Q(x) = det(I−xM),
// and the numerator P(x) falls out of the first few counts. The exponential
// growth rate λ = limₙ sₙ^{1/n} is the spectral radius of M (its Perron root),
// and ln λ is the language's topological entropy. We count two ways: STRUCTURAL
// (each atomic class is one letter) and the true UNICODE count (each class
// weighted by how many code points it holds).
//
// Everything is cross-checked against a brute-force enumeration and against the
// generating function's own power-series expansion — the house style.

import type { DFA } from './dfa';

// --- exact BigInt polynomials (coefficients low-degree first) ---------------

function polyTrim(p: bigint[]): bigint[] {
  let n = p.length;
  while (n > 1 && p[n - 1] === 0n) n--;
  return p.slice(0, n);
}

function bigGcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

// Render a BigInt polynomial in x as a human-readable string.
function polyToString(p: bigint[]): string {
  const terms: string[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const c = p[i];
    if (c === 0n) continue;
    const mag = c < 0n ? -c : c;
    const sign = c < 0n ? '−' : '+';
    let body: string;
    if (i === 0) body = mag.toString();
    else {
      const coeff = mag === 1n ? '' : mag.toString();
      const pow = i === 1 ? 'x' : `x^${i}`;
      body = `${coeff}${pow}`;
    }
    terms.push(terms.length === 0 ? (c < 0n ? `−${body}` : body) : ` ${sign} ${body}`);
  }
  return terms.length ? terms.join('') : '0';
}

// --- the transfer matrix ----------------------------------------------------

export interface TransferMatrix {
  n: number;
  M: Int32Array[]; // M[i][j] = number of atoms taking state i → state j
  start: number;
  accept: boolean[];
  weight: number[]; // outgoing structural unused; per-atom sizes handled separately
}

// Structural transfer matrix: every atomic class counts as one letter.
function buildTransfer(dfa: DFA): TransferMatrix {
  const n = dfa.states.length;
  const A = dfa.atoms.length;
  const M = Array.from({ length: n }, () => new Int32Array(n));
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < A; a++) {
      const j = dfa.table[i][a];
      if (j >= 0) M[i][j] += 1;
    }
  }
  return {
    n,
    M,
    start: dfa.start,
    accept: dfa.states.map((s) => s.accept),
    weight: [],
  };
}

// --- exact counts via the transfer matrix -----------------------------------

// sₙ for n = 0..maxLen. `weighted` multiplies each transition by the number of
// code points in its atom (the true Unicode count) instead of treating it as a
// single letter.
export function countWords(dfa: DFA, maxLen: number, weighted: boolean): bigint[] {
  const n = dfa.states.length;
  const A = dfa.atoms.length;
  const sizes = dfa.atoms.map((at) => BigInt(weighted ? at.set.size() : 1));
  let dp = new Array<bigint>(n).fill(0n);
  dp[dfa.start] = 1n;
  const out: bigint[] = [];
  for (let len = 0; len <= maxLen; len++) {
    let total = 0n;
    for (let s = 0; s < n; s++) if (dfa.states[s].accept) total += dp[s];
    out.push(total);
    const next = new Array<bigint>(n).fill(0n);
    for (let s = 0; s < n; s++) {
      const here = dp[s];
      if (here === 0n) continue;
      for (let a = 0; a < A; a++) {
        const t = dfa.table[s][a];
        if (t >= 0) next[t] += here * sizes[a];
      }
    }
    dp = next;
  }
  return out;
}

// --- the characteristic polynomial (Faddeev–LeVerrier, exact) ---------------

// Returns the coefficients a₁..a_N of charpoly(t) = t^N − a₁t^{N−1} − … − a_N,
// i.e. the linear recurrence sₙ = a₁sₙ₋₁ + … + a_N sₙ₋N (Cayley–Hamilton).
function charPolyRecurrence(M: Int32Array[]): bigint[] {
  const N = M.length;
  // Work in BigInt. Mk starts at M; c_k = tr(M_k)/k; M_{k+1} = M (M_k − c_k I).
  let Mk: bigint[][] = M.map((row) => Array.from(row, (x) => BigInt(x)));
  const Mb: bigint[][] = M.map((row) => Array.from(row, (x) => BigInt(x)));
  const a: bigint[] = []; // a[k-1] = c_k
  for (let k = 1; k <= N; k++) {
    let tr = 0n;
    for (let i = 0; i < N; i++) tr += Mk[i][i];
    const ck = tr / BigInt(k); // exact by the Faddeev–LeVerrier identity
    a.push(ck);
    if (k < N) {
      // next = M · (Mk − ck I)
      const shifted = Mk.map((row, i) => row.map((v, j) => (i === j ? v - ck : v)));
      const next: bigint[][] = Array.from({ length: N }, () => new Array<bigint>(N).fill(0n));
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
          let sum = 0n;
          for (let l = 0; l < N; l++) sum += Mb[i][l] * shifted[l][j];
          next[i][j] = sum;
        }
      Mk = next;
    }
  }
  return a; // length N
}

// --- the rational generating function S(x) = P(x)/Q(x) ----------------------

export interface GeneratingFunction {
  numerator: bigint[]; // P(x), low-degree first
  denominator: bigint[]; // Q(x) = 1 − a₁x − … − a_Nx^N, low-degree first
  recurrence: bigint[]; // a₁..a_N (sₙ = Σ aₖ sₙ₋ₖ for n ≥ N)
  numeratorStr: string;
  denominatorStr: string;
}

function generatingFunction(dfa: DFA, counts: bigint[]): GeneratingFunction {
  const tm = buildTransfer(dfa);
  const N = tm.n;
  const a = charPolyRecurrence(tm.M); // length N
  // Q(x) = 1 − Σ aₖ xᵏ
  const Q: bigint[] = new Array<bigint>(N + 1).fill(0n);
  Q[0] = 1n;
  for (let k = 1; k <= N; k++) Q[k] = -a[k - 1];
  // P(x) = (Q(x)·S(x)) truncated to degree < N, using sₖ = counts[k].
  // Pₖ = Σ_{j=0..k} Q[j]·s_{k−j}, for k = 0..N−1.
  const P: bigint[] = new Array<bigint>(N).fill(0n);
  for (let k = 0; k < N; k++) {
    let sum = 0n;
    for (let j = 0; j <= k && j <= N; j++) sum += Q[j] * counts[k - j];
    P[k] = sum;
  }
  // Reduce P/Q by the gcd of all coefficients (a light, safe simplification).
  let g = 0n;
  for (const c of [...P, ...Q]) g = bigGcd(g, c);
  const Pr = g > 1n ? P.map((c) => c / g) : P;
  const Qr = g > 1n ? Q.map((c) => c / g) : Q;
  const Pt = polyTrim(Pr);
  const Qt = polyTrim(Qr);
  return {
    numerator: Pt,
    denominator: Qt,
    recurrence: a,
    numeratorStr: polyToString(Pt),
    denominatorStr: polyToString(Qt),
  };
}

// Expand P/Q as a power series to `terms` coefficients (for self-verification).
function seriesOf(gf: GeneratingFunction, terms: number): bigint[] {
  const P = gf.numerator;
  const Q = gf.denominator; // Q[0] is ±1 after reduction
  const q0 = Q[0];
  const s: bigint[] = [];
  for (let n = 0; n < terms; n++) {
    let acc = n < P.length ? P[n] : 0n;
    for (let j = 1; j < Q.length && j <= n; j++) acc -= Q[j] * s[n - j];
    // s[n] = acc / q0 (exact when q0 = ±1)
    s.push(acc / q0);
  }
  return s;
}

// --- growth rate (Perron root) via power iteration --------------------------

// Spectral radius (Perron root) of an irreducible nonnegative block via the
// GEOMETRIC MEAN of the per-step growth factors: λ = exp((Σ ln‖M vₖ‖)/steps).
// A plain max-norm ratio OSCILLATES on periodic (imprimitive) blocks — e.g.
// [[0,2],[1,0]] alternates norms 2,1,2,1 — and would report whichever parity it
// stopped on; the geometric mean of the factors converges to the true root
// (√2 here) regardless of the period, and is exactly 1 for a pure cycle.
function spectralRadius(M: number[][]): number {
  const n = M.length;
  if (n === 0) return 0;
  let v = new Float64Array(n).fill(1);
  const WARMUP = 100;
  const STEPS = 900;
  let logSum = 0;
  let counted = 0;
  for (let iter = 0; iter < WARMUP + STEPS; iter++) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      const row = M[i];
      for (let j = 0; j < n; j++) acc += row[j] * v[j];
      w[i] = acc;
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm = Math.max(norm, Math.abs(w[i]));
    if (norm === 0) return 0;
    for (let i = 0; i < n; i++) w[i] /= norm;
    v = w;
    if (iter >= WARMUP) {
      logSum += Math.log(norm);
      counted++;
    }
  }
  return Math.exp(logSum / counted);
}

// States reachable from the start AND able to reach an accept — the only ones
// that contribute words. Counting/growth is decided on this live subgraph.
function liveStates(dfa: DFA): boolean[] {
  const n = dfa.states.length;
  const A = dfa.atoms.length;
  const reach = new Array<boolean>(n).fill(false);
  const q = [dfa.start];
  reach[dfa.start] = true;
  while (q.length) {
    const s = q.shift()!;
    for (let a = 0; a < A; a++) {
      const t = dfa.table[s][a];
      if (t >= 0 && !reach[t]) {
        reach[t] = true;
        q.push(t);
      }
    }
  }
  const rev: number[][] = Array.from({ length: n }, () => []);
  for (let s = 0; s < n; s++) for (let a = 0; a < A; a++) {
    const t = dfa.table[s][a];
    if (t >= 0) rev[t].push(s);
  }
  const co = new Array<boolean>(n).fill(false);
  const cq: number[] = [];
  for (let s = 0; s < n; s++) if (dfa.states[s].accept) { co[s] = true; cq.push(s); }
  while (cq.length) {
    const s = cq.shift()!;
    for (const p of rev[s]) if (!co[p]) { co[p] = true; cq.push(p); }
  }
  return reach.map((r, i) => r && co[i]);
}

// Tarjan's strongly-connected components on the live subgraph.
function sccs(dfa: DFA, live: boolean[]): number[][] {
  const n = dfa.states.length;
  const A = dfa.atoms.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  let idx = 0;
  const out: number[][] = [];
  // Iterative Tarjan to avoid deep recursion.
  for (let start = 0; start < n; start++) {
    if (!live[start] || index[start] !== -1) continue;
    const work: { v: number; a: number }[] = [{ v: start, a: 0 }];
    index[start] = low[start] = idx++;
    stack.push(start);
    onStack[start] = true;
    while (work.length) {
      const top = work[work.length - 1];
      const v = top.v;
      let pushed = false;
      while (top.a < A) {
        const t = dfa.table[v][top.a++];
        if (t < 0 || !live[t]) continue;
        if (index[t] === -1) {
          index[t] = low[t] = idx++;
          stack.push(t);
          onStack[t] = true;
          work.push({ v: t, a: 0 });
          pushed = true;
          break;
        } else if (onStack[t]) {
          low[v] = Math.min(low[v], index[t]);
        }
      }
      if (pushed) continue;
      if (low[v] === index[v]) {
        const comp: number[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = false;
          comp.push(w);
          if (w === v) break;
        }
        out.push(comp);
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        low[parent] = Math.min(low[parent], low[v]);
      }
    }
  }
  return out;
}

// Structural growth classification (exact). A regular language has EXPONENTIAL
// growth iff some live strongly-connected component is not a simple cycle —
// i.e. a state in it has ≥ 2 transitions that stay inside the component (two
// distinct cycles through one state). Otherwise growth is POLYNOMIAL (every
// loop is a single cycle) or there are no loops at all (finite).
function classifyGrowth(
  dfa: DFA,
  live: boolean[],
): { growth: GrowthClass; lambda: number; entropy: number } {
  const comps = sccs(dfa, live);
  const compOf = new Array<number>(dfa.states.length).fill(-1);
  comps.forEach((c, ci) => c.forEach((s) => (compOf[s] = ci)));
  const A = dfa.atoms.length;

  // EXACT classification (integer): a strongly-connected component forces
  // exponential growth iff some state in it has ≥ 2 transitions that stay inside
  // the component (two distinct cycles through one state). An irreducible
  // nonnegative matrix with a non-uniform row sum has Perron root strictly > 1.
  let exponential = false;
  let hasCycle = false;
  // The growth rate is the largest Perron root over the components — computed
  // per (irreducible) block, where power iteration converges reliably (it can
  // miss the global root on the full *reducible* matrix).
  let lambda = 0;
  for (const comp of comps) {
    const inComp = new Set(comp);
    let compHasCycle = false;
    for (const s of comp) {
      let within = 0;
      for (let a = 0; a < A; a++) {
        const t = dfa.table[s][a];
        if (t >= 0 && inComp.has(t)) within++;
      }
      if (within >= 1) {
        hasCycle = true;
        compHasCycle = true;
      }
      if (within >= 2) exponential = true;
    }
    if (!compHasCycle) continue;
    // Perron root of this irreducible block.
    const pos = new Map<number, number>();
    comp.forEach((s, k) => pos.set(s, k));
    const block = comp.map((s) => {
      const row = new Array<number>(comp.length).fill(0);
      for (let a = 0; a < A; a++) {
        const t = dfa.table[s][a];
        if (t >= 0 && pos.has(t)) row[pos.get(t)!] += 1;
      }
      return row;
    });
    lambda = Math.max(lambda, spectralRadius(block));
  }

  if (!hasCycle) return { growth: 'finite', lambda: 0, entropy: 0 };
  if (!exponential) return { growth: 'polynomial', lambda: 1, entropy: 0 };
  return { growth: 'exponential', lambda, entropy: lambda > 1 ? Math.log(lambda) : 0 };
}

export type GrowthClass = 'empty' | 'finite' | 'polynomial' | 'exponential';

export interface CensusInfo {
  states: number; // transfer-matrix dimension
  countsStructural: bigint[];
  countsWeighted: bigint[];
  weightedDiffers: boolean; // some atom holds > 1 code point
  gf: GeneratingFunction;
  lambda: number; // exponential growth rate (spectral radius)
  entropy: number; // ln λ (topological entropy), 0 if λ ≤ 1
  growth: GrowthClass;
  finite: boolean;
  totalIfFinite: bigint | null;
  ratioTail: number | null; // sₙ₊₁/sₙ for the largest computed n (empirical λ)
  // verification
  gfMatchesCounts: boolean; // P/Q series ≡ transfer-matrix counts
  bruteMatches: boolean; // transfer-matrix counts ≡ brute-force enumeration
  verifyTerms: number;
}

// Brute-force structural count: enumerate every atom-word up to length L. Stops
// early if the frontier blows up; returns however many lengths it managed (the
// caller compares only the prefix it actually computed).
function bruteCount(dfa: DFA, maxLen: number, frontierCap: number): bigint[] {
  const A = dfa.atoms.length;
  const out: bigint[] = [];
  let frontier: number[] = [dfa.start];
  for (let len = 0; len <= maxLen; len++) {
    let acc = 0n;
    for (const s of frontier) if (s >= 0 && dfa.states[s].accept) acc += 1n;
    out.push(acc);
    if (A === 0) {
      for (let k = len + 1; k <= maxLen; k++) out.push(0n);
      break;
    }
    const next: number[] = [];
    for (const s of frontier) {
      if (s < 0) continue;
      for (let a = 0; a < A; a++) {
        const t = dfa.table[s][a];
        if (t >= 0) next.push(t);
      }
    }
    frontier = next;
    if (frontier.length > frontierCap) break; // would-be too big — stop here
  }
  return out;
}

export function analyzeCensus(dfa: DFA, opts: { maxLen?: number } = {}): CensusInfo {
  const maxLen = opts.maxLen ?? 12;
  const N = dfa.states.length;
  const countsStructural = countWords(dfa, maxLen, false);
  const countsWeighted = countWords(dfa, maxLen, true);
  const weightedDiffers = dfa.atoms.some((at) => at.set.size() > 1);

  const live = liveStates(dfa);
  const cls = classifyGrowth(dfa, live);
  const lambda = cls.lambda;

  // Generating function (needs counts up to degree N for the numerator).
  const longStructural = countWords(dfa, Math.max(maxLen, 2 * N + 4), false);
  const gf = generatingFunction(dfa, longStructural);

  // Self-check 1: the GF's series reproduces the transfer-matrix counts.
  const verifyTerms = Math.min(longStructural.length, 2 * N + 4);
  const series = seriesOf(gf, verifyTerms);
  let gfMatchesCounts = true;
  for (let i = 0; i < verifyTerms; i++) if (series[i] !== longStructural[i]) gfMatchesCounts = false;

  // Self-check 2: brute force agrees over whatever prefix it could enumerate
  // (it stops early if the frontier blows up — we compare only what it computed).
  const brute = bruteCount(dfa, Math.min(maxLen, 9), 200_000);
  let bruteMatches = true;
  const bruteCmp = Math.min(brute.length, countsStructural.length);
  for (let i = 0; i < bruteCmp; i++) if (brute[i] !== countsStructural[i]) bruteMatches = false;

  // Finiteness + total.
  // Finite iff all counts past length N are zero (no cycle on a live path).
  const tail = countWords(dfa, N + 1, false);
  const finite = tail.slice(N).every((c) => c === 0n);
  let totalIfFinite: bigint | null = null;
  if (finite) {
    const full = countWords(dfa, Math.max(1, N), true);
    totalIfFinite = full.reduce((s, c) => s + c, 0n);
  }

  // Classification (structural — exact). An empty language is the degenerate
  // "finite with no members" case.
  const anyMember = countsStructural.some((c) => c > 0n) || (totalIfFinite !== null && totalIfFinite > 0n);
  let growth: GrowthClass = cls.growth;
  if (!anyMember) growth = 'empty';

  // Empirical λ from the count ratio (only meaningful when exponential).
  let ratioTail: number | null = null;
  for (let i = countsStructural.length - 1; i > 0; i--) {
    if (countsStructural[i - 1] > 0n && countsStructural[i] > 0n) {
      ratioTail = Number(countsStructural[i]) / Number(countsStructural[i - 1]);
      break;
    }
  }

  const entropy = lambda > 1 ? Math.log(lambda) : 0;

  return {
    states: N,
    countsStructural,
    countsWeighted,
    weightedDiffers,
    gf,
    lambda,
    entropy,
    growth,
    finite,
    totalIfFinite,
    ratioTail,
    gfMatchesCounts,
    bruteMatches,
    verifyTerms,
  };
}
