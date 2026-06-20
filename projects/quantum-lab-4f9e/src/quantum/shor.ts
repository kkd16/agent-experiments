// Shor's algorithm — integer factoring by quantum order-finding, from scratch.
//
// Factoring N reduces to ORDER-FINDING: pick a coprime base `a` and find the
// multiplicative order r = ord_N(a) (the period of x ↦ a·x mod N). If r is even
// and a^(r/2) ≢ −1 (mod N), then gcd(a^(r/2) ± 1, N) are non-trivial factors of N.
//
// The order is found quantumly by phase-estimating the eigenphase s/r of the
// modular-multiplication unitary U_a|x⟩ = |a·x mod N⟩, then recovering r from the
// measured fraction s/r with a continued-fraction expansion.
//
// This module is fully self-contained (no engine imports): a small flat-amplitude
// quantum micro-engine (Float64Array re/im), two independent order-finding routines
// (full-register and iterative/semiclassical), an exact analytic reference, and the
// classical wrapper that ties it together into a working factorizer.

// ───────────────────────────── classical number theory ─────────────────────────────

export function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

/** Fast modular exponentiation base^exp mod m (exact for m·m < 2^53). */
export function modpow(base: number, exp: number, m: number): number {
  if (m === 1) return 0;
  let result = 1;
  base = ((base % m) + m) % m;
  while (exp > 0) {
    if (exp & 1) result = (result * base) % m;
    exp = Math.floor(exp / 2);
    base = (base * base) % m;
  }
  return result;
}

/** Smallest r > 0 with a^r ≡ 1 (mod N); assumes gcd(a,N) = 1. Brute force (small N). */
export function multiplicativeOrder(a: number, N: number): number {
  if (gcd(a, N) !== 1) return 0;
  let x = a % N, r = 1;
  while (x !== 1) { x = (x * a) % N; r++; if (r > N) return 0; }
  return r;
}

/** Deterministic Miller–Rabin (exact for all N < 3.2·10^18 with this witness set). */
export function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (const p of [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]) {
    if (n % p === 0) return n === p;
  }
  let d = n - 1, s = 0;
  while ((d & 1) === 0) { d = Math.floor(d / 2); s++; }
  for (const a of [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]) {
    let x = modpow(a, d, n);
    if (x === 1 || x === n - 1) continue;
    let composite = true;
    for (let i = 0; i < s - 1; i++) {
      x = (x * x) % n;
      if (x === n - 1) { composite = false; break; }
    }
    if (composite) return false;
  }
  return true;
}

/** If N = b^k for some integer b ≥ 2, k ≥ 2, return { base: b, exp: k }; else null. */
export function perfectPower(N: number): { base: number; exp: number } | null {
  for (let k = 2; (1 << k) <= N; k++) {
    const b = Math.round(Math.pow(N, 1 / k));
    for (const cand of [b - 1, b, b + 1]) {
      if (cand >= 2 && Math.pow(cand, k) === N) return { base: cand, exp: k };
    }
  }
  return null;
}

/** Continued-fraction convergents p_i/q_i of num/den (num,den ≥ 0). */
export function convergents(num: number, den: number): { p: number; q: number }[] {
  const out: { p: number; q: number }[] = [];
  let n = num, d = den;
  // Standard recurrence: h_i = a_i h_{i-1} + h_{i-2}; k_i = a_i k_{i-1} + k_{i-2}.
  let h2 = 0, h1 = 1, k2 = 1, k1 = 0;
  while (d !== 0) {
    const a = Math.floor(n / d);
    const h0 = a * h1 + h2;
    const k0 = a * k1 + k2;
    out.push({ p: h0, q: k0 });
    h2 = h1; h1 = h0; k2 = k1; k1 = k0;
    [n, d] = [d, n - a * d];
    if (out.length > 64) break;
  }
  return out;
}

/**
 * Recover the order r from a measured phase value y/2^t.
 * Walk the continued-fraction convergents of y/2^t; the first denominator q < N
 * with a^q ≡ 1 (mod N) is the order (or a divisor — we also test small multiples).
 */
export function recoverOrder(y: number, t: number, a: number, N: number): number | null {
  if (y === 0) return null;
  const denom = 1 << t;
  for (const { q } of convergents(y, denom)) {
    if (q <= 0 || q >= N) continue;
    for (let mult = 1; mult * q < N; mult++) {
      const r = mult * q;
      if (modpow(a, r, N) === 1) return r;
    }
  }
  return null;
}

// ───────────────────────── flat-amplitude quantum micro-engine ─────────────────────────
//
// State of Q qubits is two Float64Arrays (real, imag) of length 2^Q. Qubit index q has
// place value 2^q in the basis-state integer (little-endian). Work register occupies the
// low n qubits (value x = idx & (2^n − 1)); counting/control qubits sit above them.

class Amps {
  re: Float64Array;
  im: Float64Array;
  Q: number;
  constructor(Q: number) {
    this.Q = Q;
    this.re = new Float64Array(1 << Q);
    this.im = new Float64Array(1 << Q);
  }
  /** Apply a Hadamard to qubit q. */
  h(q: number): void {
    const { re, im } = this;
    const bit = 1 << q;
    const s = Math.SQRT1_2;
    for (let i = 0; i < re.length; i++) {
      if (i & bit) continue;
      const j = i | bit;
      const ar = re[i], ai = im[i], br = re[j], bi = im[j];
      re[i] = (ar + br) * s; im[i] = (ai + bi) * s;
      re[j] = (ar - br) * s; im[j] = (ai - bi) * s;
    }
  }
  /** Multiply the |1⟩ component of qubit q by e^{iθ}. */
  phase(q: number, theta: number): void {
    const { re, im } = this;
    const bit = 1 << q;
    const c = Math.cos(theta), s = Math.sin(theta);
    for (let i = 0; i < re.length; i++) {
      if ((i & bit) === 0) continue;
      const ar = re[i], ai = im[i];
      re[i] = ar * c - ai * s;
      im[i] = ar * s + ai * c;
    }
  }
  /** Controlled phase: multiply states with both qc and qt set by e^{iθ} (symmetric). */
  cphase(qc: number, qt: number, theta: number): void {
    const { re, im } = this;
    const mask = (1 << qc) | (1 << qt);
    const c = Math.cos(theta), s = Math.sin(theta);
    for (let i = 0; i < re.length; i++) {
      if ((i & mask) !== mask) continue;
      const ar = re[i], ai = im[i];
      re[i] = ar * c - ai * s;
      im[i] = ar * s + ai * c;
    }
  }
  /** Swap two qubits. */
  swap(qa: number, qb: number): void {
    if (qa === qb) return;
    const { re, im } = this;
    const ba = 1 << qa, bb = 1 << qb;
    for (let i = 0; i < re.length; i++) {
      const a = (i & ba) !== 0, b = (i & bb) !== 0;
      if (a && !b) {
        const j = (i & ~ba) | bb;
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
  }
  /**
   * Controlled modular multiplication of the low-n-qubit work register by c (mod N),
   * controlled on qubit `control`: when control=1, |x⟩ ↦ |c·x mod N⟩ for x < N (identity
   * for x ≥ N). An exact in-place permutation (×c is a bijection on Z_N when gcd(c,N)=1),
   * so it is unitary; we materialise it into fresh buffers to avoid clobbering.
   */
  cModMul(n: number, control: number, c: number, N: number): void {
    const { re, im } = this;
    const size = re.length;
    const mask = (1 << n) - 1;
    const cbit = 1 << control;
    const nr = new Float64Array(size);
    const ni = new Float64Array(size);
    for (let idx = 0; idx < size; idx++) {
      const r = re[idx], m = im[idx];
      if (r === 0 && m === 0) continue;
      if ((idx & cbit) === 0) { nr[idx] += r; ni[idx] += m; continue; }
      const x = idx & mask;
      const y = x < N ? (c * x) % N : x;
      const nidx = (idx & ~mask) | y;
      nr[nidx] += r; ni[nidx] += m;
    }
    this.re = nr; this.im = ni;
  }
  /** Inverse QFT on the given qubit list (qs[i] = place value 2^i, LSB-first). */
  iqft(qs: number[]): void {
    const t = qs.length;
    for (let i = 0; i < Math.floor(t / 2); i++) this.swap(qs[i], qs[t - 1 - i]);
    for (let i = 0; i < t; i++) {
      for (let j = 0; j < i; j++) {
        const k = i - j + 1;
        this.cphase(qs[i], qs[j], -Math.PI / (1 << (k - 1)));
      }
      this.h(qs[i]);
    }
  }
}

export interface OrderFindResult {
  a: number;
  N: number;
  n: number;          // work qubits (2^n ≥ N)
  t: number;          // counting/precision bits
  qubits: number;     // total qubits used
  y: number;          // measured phase numerator (y/2^t ≈ s/r)
  phase: number;      // y / 2^t
  order: number | null; // r recovered by continued fractions
  method: 'full-register' | 'iterative';
}

function workBits(N: number): number {
  return Math.max(1, Math.ceil(Math.log2(N)));
}

/**
 * Full-register order-finding: the textbook circuit. Builds the genuine (n+t)-qubit
 * state vector and returns the EXACT output distribution over the counting register
 * (computed without knowledge of r), plus a sampler.
 */
export function orderFindFull(
  a: number,
  N: number,
  tBits?: number,
): { n: number; t: number; qubits: number; dist: Float64Array; sample: (rng: () => number) => number } {
  const n = workBits(N);
  const t = tBits ?? 2 * n;
  const Q = n + t;
  const st = new Amps(Q);
  st.re[1] = 1; // work register prepared in |1⟩ (basis state value 1)

  const counting = Array.from({ length: t }, (_, k) => n + k); // counting[k] = place 2^k
  for (const q of counting) st.h(q);

  // Controlled-U_a^{2^k}: multiply work by a^{2^k} mod N when counting qubit k is set.
  let c = a % N;
  for (let k = 0; k < t; k++) {
    st.cModMul(n, counting[k], c, N);
    c = (c * c) % N;
  }
  st.iqft(counting);

  // Marginal distribution over the counting register (high bits): P(y) = Σ_work |amp|².
  const dist = new Float64Array(1 << t);
  const { re, im } = st;
  const workSize = 1 << n;
  for (let y = 0; y < (1 << t); y++) {
    const base = y << n;
    let p = 0;
    for (let w = 0; w < workSize; w++) {
      const i = base | w;
      p += re[i] * re[i] + im[i] * im[i];
    }
    dist[y] = p;
  }
  const sample = (rng: () => number): number => {
    const r = rng();
    let acc = 0;
    for (let y = 0; y < dist.length; y++) { acc += dist[y]; if (r < acc) return y; }
    return dist.length - 1;
  };
  return { n, t, qubits: Q, dist, sample };
}

/**
 * Iterative / semiclassical order-finding (Kitaev): a single recycled control qubit,
 * measured bit-by-bit with classical phase feedback. Runs in n+1 qubits regardless of
 * the precision t, so it scales to far larger N than the full register.
 */
export function orderFindIterative(a: number, N: number, rng: () => number, tBits?: number): OrderFindResult {
  const n = workBits(N);
  const t = tBits ?? 2 * n;
  const control = n;
  const st = new Amps(n + 1);
  st.re[1] = 1; // work = |1⟩, control = |0⟩

  // Powers a^{2^p} mod N.
  const aPow: number[] = [];
  let c = a % N;
  for (let p = 0; p < t; p++) { aPow.push(c); c = (c * c) % N; }

  let phiAcc = 0; // 0.x_{t-p+1}…x_t — the already-measured (less significant) bits
  let y = 0;
  for (let p = 0; p < t; p++) {
    st.h(control);
    st.cModMul(n, control, aPow[p], N);
    if (phiAcc !== 0) st.phase(control, -Math.PI * phiAcc); // feedback removes the tail phase
    st.h(control);

    // Measure the control qubit (Born rule), collapse, then reset it to |0⟩ for reuse.
    const { re, im } = st;
    const cbit = 1 << control;
    let p1 = 0;
    for (let i = 0; i < re.length; i++) if (i & cbit) p1 += re[i] * re[i] + im[i] * im[i];
    const bit = rng() < p1 ? 1 : 0;
    const norm = Math.sqrt(bit ? p1 : 1 - p1) || 1;
    for (let i = 0; i < re.length; i++) {
      const set = (i & cbit) !== 0 ? 1 : 0;
      if (set !== bit) { re[i] = 0; im[i] = 0; }
      else { re[i] /= norm; im[i] /= norm; }
    }
    if (bit === 1) { // reset control to |0⟩ (move amplitude from control=1 to control=0)
      const nr = new Float64Array(re.length), ni = new Float64Array(im.length);
      for (let i = 0; i < re.length; i++) {
        if (i & cbit) { nr[i & ~cbit] = re[i]; ni[i & ~cbit] = im[i]; }
      }
      st.re = nr; st.im = ni;
    }
    y += bit << p;            // bit measured at step p has place value 2^p
    phiAcc = bit / 2 + phiAcc / 2;
  }

  return {
    a, N, n, t, qubits: n + 1, y, phase: y / (1 << t),
    order: recoverOrder(y, t, a, N), method: 'iterative',
  };
}

/**
 * Exact analytic order-finding distribution (the reference the simulators are graded
 * against): P(y) = (1/r) Σ_{s=0}^{r-1} |Σ_k e^{2πik(s/r − y/2^t)} / 2^t|². Uses the
 * classically-computed order r purely to render the ideal probability comb.
 */
export function idealOrderDistribution(a: number, N: number, tBits?: number): { r: number; t: number; dist: Float64Array } {
  const n = workBits(N);
  const t = tBits ?? 2 * n;
  const r = multiplicativeOrder(a, N);
  const M = 1 << t;
  const dist = new Float64Array(M);
  if (r === 0) return { r, t, dist };
  for (let y = 0; y < M; y++) {
    let p = 0;
    for (let s = 0; s < r; s++) {
      const delta = s / r - y / M; // fractional mismatch
      let amp2: number;
      if (Math.abs(delta - Math.round(delta)) < 1e-15) {
        amp2 = 1;
      } else {
        const sn = Math.sin(Math.PI * M * delta);
        const sd = Math.sin(Math.PI * delta);
        amp2 = (sn * sn) / (sd * sd) / (M * M);
      }
      p += amp2 / r;
    }
    dist[y] = p;
  }
  return { r, t, dist };
}

// ───────────────────────────── the classical Shor wrapper ─────────────────────────────

export interface ShorStep {
  kind: 'info' | 'attempt' | 'success' | 'fail' | 'classical';
  text: string;
}

export interface ShorResult {
  N: number;
  factors: number[] | null; // [p, q] with p·q = N, or null on failure
  steps: ShorStep[];
  attempts: number;
  // Diagnostics from the winning order-finding (if quantum):
  a?: number;
  order?: number;
  measuredY?: number;
  t?: number;
  method?: 'full-register' | 'iterative';
}

export interface ShorOptions {
  rng?: () => number;
  maxAttempts?: number;
  /** 'full' uses the genuine (n+t)-qubit state vector; 'iterative' the n+1-qubit version.
   *  'auto' picks full for n ≤ 5 (N ≤ 31), iterative otherwise. */
  mode?: 'auto' | 'full' | 'iterative';
  /** Force a particular base a (otherwise chosen at random). */
  fixedA?: number;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run Shor's algorithm to factor N. Returns a non-trivial factor pair or null. */
export function shorFactor(N: number, opts: ShorOptions = {}): ShorResult {
  const rng = opts.rng ?? mulberry32((Math.random() * 2 ** 31) | 0);
  const maxAttempts = opts.maxAttempts ?? 30;
  const steps: ShorStep[] = [];
  const log = (kind: ShorStep['kind'], text: string) => steps.push({ kind, text });

  if (N < 2) return { N, factors: null, steps, attempts: 0 };
  log('info', `Factoring N = ${N}.`);

  // Classical preprocessing (Shor's algorithm assumes these are filtered out first).
  if (N % 2 === 0) {
    log('classical', `N is even → factor 2 found classically.`);
    return { N, factors: [2, N / 2], steps, attempts: 0 };
  }
  if (isPrime(N)) {
    log('classical', `N is prime — it has no non-trivial factors.`);
    return { N, factors: null, steps, attempts: 0 };
  }
  const pp = perfectPower(N);
  if (pp) {
    log('classical', `N = ${pp.base}^${pp.exp} is a perfect power → factor ${pp.base} found classically.`);
    return { N, factors: [pp.base, N / pp.base], steps, attempts: 0 };
  }

  const n = workBits(N);
  const mode = opts.mode ?? (n <= 5 ? 'full' : 'iterative');
  log('info', `Quantum order-finding mode: ${mode === 'full' ? 'full-register' : 'iterative (1 ancilla)'}.`);

  // Cache the full-register distribution per base (it is base-dependent but seed-independent).
  const fullCache = new Map<number, ReturnType<typeof orderFindFull>>();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const a = opts.fixedA ?? (2 + Math.floor(rng() * (N - 3))); // a ∈ [2, N-2]
    log('attempt', `Attempt ${attempt}: pick a = ${a}.`);

    const g = gcd(a, N);
    if (g > 1) {
      log('success', `Lucky! gcd(${a}, ${N}) = ${g} is already a factor (no quantum step needed).`);
      return { N, factors: [g, N / g], steps, attempts: attempt, a };
    }

    // Quantum order-finding.
    let y: number, t: number, method: 'full-register' | 'iterative', order: number | null;
    if (mode === 'full') {
      let res = fullCache.get(a);
      if (!res) { res = orderFindFull(a, N); fullCache.set(a, res); }
      t = res.t; method = 'full-register';
      y = res.sample(rng);
      order = recoverOrder(y, t, a, N);
    } else {
      const res = orderFindIterative(a, N, rng);
      y = res.y; t = res.t; method = 'iterative'; order = res.order;
    }
    log('info', `Order-finding measured y = ${y} (phase ${y}/${1 << t} = ${(y / (1 << t)).toFixed(4)}).`);

    if (order === null) { log('fail', `Continued fractions gave no valid period — retry.`); continue; }
    log('info', `Continued fractions → candidate order r = ${order} (check: ${a}^${order} mod ${N} = ${modpow(a, order, N)}).`);

    if (order % 2 !== 0) { log('fail', `r = ${order} is odd — Shor needs an even order. Retry.`); continue; }
    const root = modpow(a, order / 2, N);
    if (root === N - 1) { log('fail', `a^(r/2) ≡ −1 (mod N) — a trivial square root. Retry.`); continue; }

    const f1 = gcd(root - 1, N);
    const f2 = gcd(root + 1, N);
    log('info', `a^(r/2) = ${root}; gcd(${root}−1, ${N}) = ${f1}, gcd(${root}+1, ${N}) = ${f2}.`);
    for (const f of [f1, f2]) {
      if (f > 1 && f < N) {
        log('success', `Non-trivial factor ${f} → ${N} = ${f} × ${N / f}.`);
        return { N, factors: [f, N / f], steps, attempts: attempt, a, order, measuredY: y, t, method };
      }
    }
    log('fail', `Both gcds were trivial — retry with a new a.`);
  }
  log('fail', `No factor found in ${maxAttempts} attempts.`);
  return { N, factors: null, steps, attempts: maxAttempts };
}

export { mulberry32 as shorRng };
