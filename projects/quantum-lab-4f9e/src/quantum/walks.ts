import { Complex, C } from './Complex';
import { hermitianEig } from './Hermitian';

/**
 * Quantum walks — the ballistic engine behind a whole family of quantum algorithms, built from
 * scratch on the lab's `Complex` and the `hermitianEig` Jacobi eigensolver.
 *
 * Two inequivalent models share the name:
 *
 *  - The **discrete-time coined walk** augments a position register with an internal coin qubit. A
 *    coin flip `C` then a coin-conditioned shift `S` are iterated; the interference of left/right
 *    histories produces the unmistakable two-horned distribution whose standard deviation grows
 *    *linearly* in time (σ ≈ 0.5412·t for the Hadamard walk) versus √t classically.
 *
 *  - The **continuous-time walk** drops the coin: the graph adjacency matrix *is* the Hamiltonian, so
 *    the walker evolves by |ψ(t)⟩ = e^{−iAt}|ψ(0)⟩, computed exactly here by diagonalising A. Promote
 *    it with a marked-vertex term H = −γA − |w⟩⟨w| and it becomes spatial search (Childs–Goldstone),
 *    the continuous-time cousin of Grover.
 */

// ======================================================================================
// Discrete-time coined quantum walk (on a cycle of N sites, 2-state coin)
// ======================================================================================

export type CoinType = 'hadamard' | 'symmetric' | 'biased';

/**
 * The 2×2 coin unitary. The Hadamard coin H = (1/√2)[[1,1],[1,−1]] is canonical; the symmetric
 * (`Y`) coin (1/√2)[[1,i],[i,1]] produces a left/right-symmetric distribution from a |0⟩ coin start;
 * the biased rotation coin [[√ρ,√(1−ρ)],[√(1−ρ),−√ρ]] tilts the walk by skewing the coin.
 */
export function coinMatrix(type: CoinType, bias = 0.5): Complex[][] {
  const s = Math.SQRT1_2;
  if (type === 'hadamard') return [[C(s), C(s)], [C(s), C(-s)]];
  if (type === 'symmetric') return [[C(s), C(0, s)], [C(0, s), C(s)]];
  const r = Math.min(1, Math.max(0, bias));
  const a = Math.sqrt(r), b = Math.sqrt(1 - r);
  return [[C(a), C(b)], [C(b), C(-a)]];
}

/** The initial coin spinor (a 2-vector). `symmetric` is (|0⟩ + i|1⟩)/√2, the unbiased start. */
export type CoinStart = 'up' | 'down' | 'symmetric';
export function coinStart(kind: CoinStart): [Complex, Complex] {
  if (kind === 'up') return [C(1), C(0)];
  if (kind === 'down') return [C(0), C(1)];
  return [C(Math.SQRT1_2), C(0, Math.SQRT1_2)];
}

/**
 * A discrete-time-walk state on a cycle of N sites: amplitudes are stored interleaved as
 * `amp[2·x + c]` for position x ∈ [0,N) and coin c ∈ {0,1}.
 */
export interface DTWalk {
  N: number;
  amp: Complex[];
}

export function dtwInit(N: number, center: number, start: CoinStart): DTWalk {
  const amp = Array.from({ length: 2 * N }, () => C(0));
  const [u, d] = coinStart(start);
  amp[2 * center] = u;
  amp[2 * center + 1] = d;
  return { N, amp };
}

/** One step U = S·(I⊗C): apply the coin at every site, then shift coin-0 right and coin-1 left. */
export function dtwStep(w: DTWalk, coin: Complex[][]): DTWalk {
  const { N, amp } = w;
  const next = Array.from({ length: 2 * N }, () => C(0));
  for (let x = 0; x < N; x++) {
    const a0 = amp[2 * x], a1 = amp[2 * x + 1];
    // coin mix
    const c0 = coin[0][0].mul(a0).add(coin[0][1].mul(a1));
    const c1 = coin[1][0].mul(a0).add(coin[1][1].mul(a1));
    // shift: coin 0 -> x+1, coin 1 -> x-1 (mod N)
    const xr = (x + 1) % N;
    const xl = (x - 1 + N) % N;
    next[2 * xr] = next[2 * xr].add(c0);
    next[2 * xl + 1] = next[2 * xl + 1].add(c1);
  }
  return { N, amp: next };
}

/** Marginal position distribution P(x) = |amp(x,0)|² + |amp(x,1)|². */
export function dtwProb(w: DTWalk): number[] {
  const p = new Array<number>(w.N);
  for (let x = 0; x < w.N; x++) p[x] = w.amp[2 * x].abs2() + w.amp[2 * x + 1].abs2();
  return p;
}

export interface DTWalkRun {
  N: number;
  center: number;
  steps: number;
  /** prob[t][x] — the full space-time probability table, t = 0..steps. */
  spacetime: number[][];
  /** Final-step marginal. */
  finalProb: number[];
  /** Standard deviation of position about the start, treating positions as a line (no wrap). */
  stdev: number;
  mean: number;
}

/**
 * Run a coined walk for `steps` steps from the centre of an N-site cycle. N is taken large enough
 * that the walker never wraps (we require N > 2·steps), so the cycle faithfully models the line.
 */
export function dtwRun(steps: number, coin: Complex[][], start: CoinStart): DTWalkRun {
  const N = 2 * steps + 3;
  const center = steps + 1;
  let w = dtwInit(N, center, start);
  const spacetime: number[][] = [dtwProb(w)];
  for (let t = 0; t < steps; t++) {
    w = dtwStep(w, coin);
    spacetime.push(dtwProb(w));
  }
  const finalProb = spacetime[spacetime.length - 1];
  const { mean, stdev } = positionStats(finalProb, center);
  return { N, center, steps, spacetime, finalProb, mean, stdev };
}

/** Mean and standard deviation of a position distribution measured relative to `origin`. */
export function positionStats(prob: number[], origin: number): { mean: number; stdev: number } {
  let m = 0, m2 = 0, norm = 0;
  for (let x = 0; x < prob.length; x++) {
    const d = x - origin;
    m += d * prob[x];
    m2 += d * d * prob[x];
    norm += prob[x];
  }
  if (norm > 0) { m /= norm; m2 /= norm; }
  return { mean: m, stdev: Math.sqrt(Math.max(0, m2 - m * m)) };
}

/**
 * The exact classical symmetric random walk on the line after `steps` steps, returned on the same
 * index frame as a DTWalkRun (centre at `center`). Position x has probability C(t, k)/2^t where
 * k = (t + (x−center))/2, and 0 if the parity is wrong. σ = √t exactly.
 */
export function classicalLineWalk(steps: number, N: number, center: number): number[] {
  const prob = new Array<number>(N).fill(0);
  // log-binomial for numerical safety at large t.
  const logFact: number[] = [0];
  for (let i = 1; i <= steps; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  const logChoose = (n: number, k: number) =>
    k < 0 || k > n ? -Infinity : logFact[n] - logFact[k] - logFact[n - k];
  const ln2 = Math.log(2);
  for (let x = 0; x < N; x++) {
    const d = x - center;
    if (((d % 2) + 2) % 2 !== steps % 2) continue;
    const k = (steps + d) / 2;
    const lp = logChoose(steps, k) - steps * ln2;
    if (lp > -Infinity) prob[x] = Math.exp(lp);
  }
  return prob;
}

// ======================================================================================
// Graphs (for continuous-time walks)
// ======================================================================================

export type GraphFamily = 'path' | 'wpath' | 'cycle' | 'complete' | 'star' | 'hypercube' | 'grid';

export interface WalkGraph {
  family: GraphFamily;
  n: number;
  param: number;
  adjacency: number[][];
  edges: [number, number][];
  /** 2-D layout in [0,1]², for drawing. */
  layout: { x: number; y: number }[];
  /** Antipode of each vertex when the graph has a natural one (hypercube/path/cycle), else null. */
  antipode: ((v: number) => number) | null;
  label: string;
}

function emptyAdj(n: number): number[][] {
  return Array.from({ length: n }, () => new Array<number>(n).fill(0));
}

function edgesToAdj(n: number, edges: [number, number][]): number[][] {
  const a = emptyAdj(n);
  for (const [i, j] of edges) { a[i][j] = 1; a[j][i] = 1; }
  return a;
}

/** Build a named graph. `param` = #vertices for path/cycle/complete/star, dimension for hypercube,
 *  side length for the L×L grid. */
export function buildGraph(family: GraphFamily, param: number): WalkGraph {
  let n: number, layout: { x: number; y: number }[] = [];
  const edges: [number, number][] = [];
  let customAdj: number[][] | null = null;
  let antipode: ((v: number) => number) | null = null;
  let label = '';

  const ring = (count: number, r = 0.42, cx = 0.5, cy = 0.5) =>
    Array.from({ length: count }, (_, i) => {
      const th = -Math.PI / 2 + (2 * Math.PI * i) / count;
      return { x: cx + r * Math.cos(th), y: cy + r * Math.sin(th) };
    });

  switch (family) {
    case 'path': {
      n = Math.max(2, param);
      for (let i = 0; i + 1 < n; i++) edges.push([i, i + 1]);
      layout = Array.from({ length: n }, (_, i) => ({ x: n === 1 ? 0.5 : 0.06 + (0.88 * i) / (n - 1), y: 0.5 }));
      antipode = (v) => n - 1 - v;
      label = `Path P${n}`;
      break;
    }
    case 'wpath': {
      // Christandl et al. weighted path with PRE-ENGINEERED couplings c_k = ½√((k+1)(n−1−k)):
      // the Hamiltonian is exactly the J_x operator of a spin S=(n−1)/2, so e^{−iπH} is a π-rotation
      // that maps end |0⟩ → end |n−1⟩ with |amplitude| = 1 — PERFECT STATE TRANSFER on a chain of
      // ANY length (the quantum-wire result), at the fixed time t = π.
      n = Math.max(2, param);
      customAdj = emptyAdj(n);
      for (let k = 0; k + 1 < n; k++) {
        const c = 0.5 * Math.sqrt((k + 1) * (n - 1 - k));
        customAdj[k][k + 1] = c; customAdj[k + 1][k] = c;
        edges.push([k, k + 1]);
      }
      layout = Array.from({ length: n }, (_, i) => ({ x: n === 1 ? 0.5 : 0.06 + (0.88 * i) / (n - 1), y: 0.5 }));
      antipode = (v) => n - 1 - v;
      label = `Weighted path W${n}`;
      break;
    }
    case 'cycle': {
      n = Math.max(3, param);
      for (let i = 0; i < n; i++) edges.push([i, (i + 1) % n]);
      layout = ring(n);
      antipode = (v) => (v + Math.floor(n / 2)) % n;
      label = `Cycle C${n}`;
      break;
    }
    case 'complete': {
      n = Math.max(2, param);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) edges.push([i, j]);
      layout = ring(n);
      label = `Complete K${n}`;
      break;
    }
    case 'star': {
      n = Math.max(2, param);
      for (let i = 1; i < n; i++) edges.push([0, i]);
      layout = [{ x: 0.5, y: 0.5 }, ...ring(n - 1)];
      label = `Star S${n}`;
      break;
    }
    case 'hypercube': {
      const d = Math.max(1, param);
      n = 1 << d;
      for (let v = 0; v < n; v++) {
        for (let b = 0; b < d; b++) {
          const u = v ^ (1 << b);
          if (u > v) edges.push([v, u]);
        }
      }
      // 2-D projection: each set bit pushes along a direction spread around the circle.
      const dirs = Array.from({ length: d }, (_, b) => {
        const th = (2 * Math.PI * b) / d;
        return { x: Math.cos(th), y: Math.sin(th) };
      });
      const raw = Array.from({ length: n }, (_, v) => {
        let x = 0, y = 0;
        for (let b = 0; b < d; b++) if (v & (1 << b)) { x += dirs[b].x; y += dirs[b].y; }
        return { x, y };
      });
      // normalise into [0.08,0.92]²
      const xs = raw.map((p) => p.x), ys = raw.map((p) => p.y);
      const nx = (lo: number, hi: number, v: number) => (hi === lo ? 0.5 : 0.08 + (0.84 * (v - lo)) / (hi - lo));
      layout = raw.map((p) => ({ x: nx(Math.min(...xs), Math.max(...xs), p.x), y: nx(Math.min(...ys), Math.max(...ys), p.y) }));
      antipode = (v) => v ^ (n - 1);
      label = `Hypercube Q${d}`;
      break;
    }
    case 'grid': {
      const L = Math.max(2, param);
      n = L * L;
      const idx = (r: number, c: number) => r * L + c;
      for (let r = 0; r < L; r++) for (let c = 0; c < L; c++) {
        if (c + 1 < L) edges.push([idx(r, c), idx(r, c + 1)]);
        if (r + 1 < L) edges.push([idx(r, c), idx(r + 1, c)]);
      }
      layout = Array.from({ length: n }, (_, v) => {
        const r = Math.floor(v / L), c = v % L;
        return { x: L === 1 ? 0.5 : 0.08 + (0.84 * c) / (L - 1), y: L === 1 ? 0.5 : 0.08 + (0.84 * r) / (L - 1) };
      });
      antipode = (v) => n - 1 - v;
      label = `Grid ${L}×${L}`;
      break;
    }
  }
  return { family, n, param, adjacency: customAdj ?? edgesToAdj(n, edges), edges, layout, antipode, label };
}

/** Degree-diagonal minus adjacency: the combinatorial graph Laplacian L = D − A. */
export function laplacian(adj: number[][]): number[][] {
  const n = adj.length;
  const L = emptyAdj(n);
  for (let i = 0; i < n; i++) {
    let deg = 0;
    for (let j = 0; j < n; j++) { deg += adj[i][j]; L[i][j] = -adj[i][j]; }
    L[i][i] = deg;
  }
  return L;
}

// ======================================================================================
// Continuous-time quantum walk: |ψ(t)⟩ = e^{−iHt}|ψ(0)⟩ via eigendecomposition
// ======================================================================================

export interface CTWalkEngine {
  n: number;
  /** Real eigenvalues of the (real symmetric) Hamiltonian. */
  values: number[];
  /** Eigenvectors as real numbers; `vec[i][k]` = component i of eigenvector k. */
  vec: number[][];
  /** Amplitudes after evolving e^{−iHt} from basis vertex `from`. */
  amplitude(from: number, t: number): Complex[];
  /** Probability per vertex after evolving from basis vertex `from`. */
  prob(from: number, t: number): number[];
  /** |⟨to|e^{−iHt}|from⟩|² — the transport probability. */
  transport(from: number, to: number, t: number): number;
}

/** Diagonalise a real symmetric matrix `H` and return an exact continuous-time evolution engine. */
export function ctqwEngine(H: number[][]): CTWalkEngine {
  const n = H.length;
  const eig = hermitianEig(H.map((row) => row.map((x) => C(x))));
  const values = eig.values;
  // eig.vectors[i][k] = component i of eigenvector k (Complex, but real here up to tiny imag).
  const vec = eig.vectors.map((row) => row.map((z) => z.re));

  const amplitude = (from: number, t: number): Complex[] => {
    // ψ_i(t) = Σ_k vec[i][k] · e^{−iλ_k t} · vec[from][k]   (real eigenvectors)
    const out = Array.from({ length: n }, () => C(0));
    for (let k = 0; k < n; k++) {
      const w = vec[from][k];
      if (w === 0) continue;
      const ph = Complex.fromPolar(w, -values[k] * t); // w·e^{−iλt}
      for (let i = 0; i < n; i++) {
        const c = vec[i][k];
        if (c !== 0) out[i] = out[i].add(ph.scale(c));
      }
    }
    return out;
  };
  const prob = (from: number, t: number) => amplitude(from, t).map((z) => z.abs2());
  const transport = (from: number, to: number, t: number) => {
    let re = 0, im = 0;
    for (let k = 0; k < n; k++) {
      const a = vec[to][k] * vec[from][k];
      if (a === 0) continue;
      re += a * Math.cos(values[k] * t);
      im += -a * Math.sin(values[k] * t);
    }
    return re * re + im * im;
  };
  return { n, values, vec, amplitude, prob, transport };
}

/**
 * The time-averaged (limiting) distribution of a CTQW from `from`:
 *   P∞(i) = lim_{T→∞} (1/T) ∫₀ᵀ |ψ_i(t)|² dt = Σ_{distinct λ} |Σ_{k:λ_k=λ} vec[i][k] vec[from][k]|².
 * Cross terms between distinct eigenvalues time-average to zero.
 */
export function ctqwLimiting(eng: CTWalkEngine, from: number, tol = 1e-9): number[] {
  const { n, values, vec } = eng;
  // group eigenvalue indices by value
  const groups: number[][] = [];
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  let cur: number[] = [];
  for (let idx = 0; idx < order.length; idx++) {
    const k = order[idx];
    if (cur.length === 0 || Math.abs(values[k] - values[cur[cur.length - 1]]) <= tol) cur.push(k);
    else { groups.push(cur); cur = [k]; }
  }
  if (cur.length) groups.push(cur);

  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (const g of groups) {
      let s = 0;
      for (const k of g) s += vec[i][k] * vec[from][k];
      out[i] += s * s;
    }
  }
  return out;
}

// ======================================================================================
// Classical continuous-time random walk: the graph heat kernel e^{−Lt}
// ======================================================================================

/**
 * Classical continuous-time random walk distribution: p(t) = e^{−Lt}·e_from, with L the symmetric
 * Laplacian. Because columns of L sum to zero, e^{−Lt} is column-stochastic, so p(t) stays a
 * probability distribution. Evaluated exactly via the eigendecomposition of L.
 */
export function classicalCTRW(L: number[][], from: number, t: number): number[] {
  const n = L.length;
  const eig = hermitianEig(L.map((row) => row.map((x) => C(x))));
  const val = eig.values;
  const vec = eig.vectors.map((row) => row.map((z) => z.re));
  const out = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    const e = Math.exp(-val[k] * t) * vec[from][k];
    if (e === 0) continue;
    for (let i = 0; i < n; i++) out[i] += vec[i][k] * e;
  }
  // clamp tiny negatives from round-off
  return out.map((p) => Math.max(0, p));
}

// ======================================================================================
// Quantum spatial search (Childs–Goldstone): H = −γ·A − |w⟩⟨w|
// ======================================================================================

/** Build the search Hamiltonian H = −γ·A − |w⟩⟨w| as a real symmetric matrix. */
export function searchHamiltonian(adj: number[][], w: number, gamma: number): number[][] {
  const n = adj.length;
  const H = Array.from({ length: n }, (_, i) => adj[i].map((a) => -gamma * a));
  H[w][w] -= 1;
  return H;
}

export interface SearchResult {
  /** success[t] = |⟨w|ψ(t)⟩|² from the uniform start. */
  success: number[];
  times: number[];
  /** time and value of the first success maximum. */
  optTime: number;
  optSuccess: number;
}

/**
 * Continuous-time spatial search from the uniform superposition, sampling success at the given times.
 * On the complete graph K_N, optimal γ = 1/N gives success → 1 at t = (π/2)√N — the O(√N) speedup.
 */
export function spatialSearch(adj: number[][], w: number, gamma: number, times: number[]): SearchResult {
  const n = adj.length;
  const eng = ctqwEngine(searchHamiltonian(adj, w, gamma));
  const inv = 1 / Math.sqrt(n);
  const success: number[] = [];
  let optTime = 0, optSuccess = -1;
  for (const t of times) {
    // ψ(t) = Σ_k e^{−iλt} vec[:,k] (vecᵀ s), with s uniform ⇒ coeff_k = inv·Σ_i vec[i][k].
    let re = 0, im = 0;
    for (let k = 0; k < n; k++) {
      let colSum = 0;
      for (let i = 0; i < n; i++) colSum += eng.vec[i][k];
      const coeff = inv * colSum; // ⟨v_k|s⟩
      const amp = eng.vec[w][k] * coeff; // contribution to ⟨w|v_k⟩⟨v_k|s⟩
      re += amp * Math.cos(eng.values[k] * t);
      im += -amp * Math.sin(eng.values[k] * t);
    }
    const p = re * re + im * im;
    success.push(p);
    if (p > optSuccess) { optSuccess = p; optTime = t; }
  }
  return { success, times, optTime, optSuccess };
}

/** Scan γ over [lo,hi] (multiplicative grid) and report the γ maximising peak success over `times`. */
export function scanGamma(adj: number[][], w: number, times: number[], lo: number, hi: number, steps = 40):
  { gammas: number[]; peaks: number[]; bestGamma: number; bestPeak: number } {
  const gammas: number[] = [], peaks: number[] = [];
  let bestGamma = lo, bestPeak = -1;
  for (let i = 0; i <= steps; i++) {
    const g = lo * Math.pow(hi / lo, i / steps);
    const r = spatialSearch(adj, w, g, times);
    gammas.push(g); peaks.push(r.optSuccess);
    if (r.optSuccess > bestPeak) { bestPeak = r.optSuccess; bestGamma = g; }
  }
  return { gammas, peaks, bestGamma, bestPeak };
}
