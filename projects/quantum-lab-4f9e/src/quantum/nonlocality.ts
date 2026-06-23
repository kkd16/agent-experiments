import { Complex, C } from './Complex';
import { QuantumState } from './QuantumState';
import { expectation, nelderMead, type PauliTerm } from './variational';

/**
 * Nonlocality, Bell tests & quantum pseudo-telepathy — built from scratch on the exact
 * state-vector engine.
 *
 * Entanglement produces correlations that no local-hidden-variable (LHV) theory can reproduce.
 * This module quantifies that three ways, each proven to machine precision in the self-tests:
 *
 *   1. The CHSH inequality.  Any LHV theory obeys |S| ≤ 2; the Bell state reaches Tsirelson's
 *      bound S = 2√2.  Reframed as the CHSH game, quantum players win at cos²(π/8) ≈ 0.854 where
 *      classical players are capped at 0.75.
 *   2. The GHZ / Mermin game.  Three players sharing |GHZ⟩ win *with certainty*; the best classical
 *      strategy wins only 3/4 — quantum pseudo-telepathy.
 *   3. The Mermin–Peres magic-square game.  A 3×3 grid of two-qubit observables whose row/column
 *      product algebra is classically contradictory (cap 8/9) but quantum-mechanically winnable with
 *      certainty on two shared Bell pairs.
 */

// ───────────────────────────── tiny complex-matrix kit ─────────────────────────────
// A few standalone matrix helpers (the magic-square operator algebra lives on dense 4×4 / 16×16
// matrices, separate from the state-vector path). Kept local so this module touches no other engine.

type Mat = Complex[][];

const I2: Mat = [[C(1), C(0)], [C(0), C(1)]];
const PX: Mat = [[C(0), C(1)], [C(1), C(0)]];
const PY: Mat = [[C(0), C(0, -1)], [C(0, 1), C(0)]];
const PZ: Mat = [[C(1), C(0)], [C(0), C(-1)]];
const PAULI: Record<'I' | 'X' | 'Y' | 'Z', Mat> = { I: I2, X: PX, Y: PY, Z: PZ };

function matMul(A: Mat, B: Mat): Mat {
  const n = A.length, m = B[0].length, k = B.length;
  const R: Mat = Array.from({ length: n }, () => Array.from({ length: m }, () => C(0)));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) for (let l = 0; l < k; l++) R[i][j] = R[i][j].add(A[i][l].mul(B[l][j]));
  return R;
}
function kron(A: Mat, B: Mat): Mat {
  const ra = A.length, ca = A[0].length, rb = B.length, cb = B[0].length;
  const R: Mat = Array.from({ length: ra * rb }, () => Array.from({ length: ca * cb }, () => C(0)));
  for (let i = 0; i < ra; i++) for (let j = 0; j < ca; j++) for (let p = 0; p < rb; p++) for (let q = 0; q < cb; q++) R[i * rb + p][j * cb + q] = A[i][j].mul(B[p][q]);
  return R;
}
function matScale(A: Mat, s: number): Mat { return A.map((row) => row.map((x) => x.scale(s))); }
function matIdent(n: number): Mat { return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => C(i === j ? 1 : 0))); }
function matClose(A: Mat, B: Mat, eps = 1e-9): boolean {
  for (let i = 0; i < A.length; i++) for (let j = 0; j < A[0].length; j++) if (A[i][j].sub(B[i][j]).abs() > eps) return false;
  return true;
}
function commutes(A: Mat, B: Mat, eps = 1e-9): boolean { return matClose(matMul(A, B), matMul(B, A), eps); }
/** Build the full 2ⁿ-dim operator that applies one Pauli letter per qubit (qubit 0 = MSB). */
function pauliString(letters: ('I' | 'X' | 'Y' | 'Z')[]): Mat {
  let M = PAULI[letters[0]];
  for (let q = 1; q < letters.length; q++) M = kron(M, PAULI[letters[q]]);
  return M;
}
function expectationMat(state: Complex[], M: Mat): number {
  let total = C(0);
  for (let i = 0; i < state.length; i++) {
    let row = C(0);
    for (let j = 0; j < state.length; j++) row = row.add(M[i][j].mul(state[j]));
    total = total.add(state[i].conj().mul(row));
  }
  return total.re;
}

// A small deterministic RNG (splitmix32) so the Monte-Carlo certificate is reproducible.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = (z ^ (z >>> 16)) >>> 0; z = Math.imul(z, 0x21f0aaad) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0; z = Math.imul(z, 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  };
}

// ───────────────────────────────── Bell states ─────────────────────────────────

export type BellName = 'phi+' | 'phi-' | 'psi+' | 'psi-';

export const BELL_LABELS: Record<BellName, string> = {
  'phi+': '|Φ⁺⟩ = (|00⟩+|11⟩)/√2',
  'phi-': '|Φ⁻⟩ = (|00⟩−|11⟩)/√2',
  'psi+': '|Ψ⁺⟩ = (|01⟩+|10⟩)/√2',
  'psi-': '|Ψ⁻⟩ = (|01⟩−|10⟩)/√2  (the singlet)',
};

/** The four maximally-entangled two-qubit Bell states, prepared with H + CNOT (+ X / Z). */
export function bellState(name: BellName): QuantumState {
  const s = new QuantumState(2);
  if (name === 'psi+' || name === 'psi-') s.applyGate({ name: 'X', qubits: [1] });
  s.applyGate({ name: 'H', qubits: [0] });
  s.applyGate({ name: 'CNOT', qubits: [0, 1] });
  if (name === 'phi-' || name === 'psi-') s.applyGate({ name: 'Z', qubits: [0] });
  return s;
}

// ───────────────────────────────── CHSH ─────────────────────────────────

/** The Bell–CHSH LHV bound. No local-hidden-variable theory can exceed |S| = 2. */
export const CLASSICAL_BOUND = 2;
/** Tsirelson's bound: the maximum |S| achievable by any quantum strategy. */
export const TSIRELSON_BOUND = 2 * Math.SQRT2;

export interface CHSHAngles { a: number; ap: number; b: number; bp: number; }

/** The canonical optimal angles: Alice {Z, X}, Bob {(Z+X)/√2, (Z−X)/√2} → S = 2√2 on |Φ⁺⟩. */
export const OPTIMAL_CHSH: CHSHAngles = { a: 0, ap: Math.PI / 2, b: Math.PI / 4, bp: -Math.PI / 4 };

/**
 * The two-party correlator E(a,b) = ⟨ψ| A(a) ⊗ B(b) |ψ⟩, where A(θ) = cosθ·Z + sinθ·X is a ±1
 * observable in the X–Z plane. Computed on the real engine by expanding the tensor product into the
 * four Pauli terms ZZ, ZX, XZ, XX. On |Φ⁺⟩ this equals cos(a−b).
 */
export function correlator(state: QuantumState, a: number, b: number): number {
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const terms: PauliTerm[] = [
    { coeff: ca * cb, ops: { 0: 'Z', 1: 'Z' } },
    { coeff: ca * sb, ops: { 0: 'Z', 1: 'X' } },
    { coeff: sa * cb, ops: { 0: 'X', 1: 'Z' } },
    { coeff: sa * sb, ops: { 0: 'X', 1: 'X' } },
  ];
  return expectation(state, terms);
}

/** The CHSH combination S = E(a,b) + E(a,b′) + E(a′,b) − E(a′,b′). */
export function chshValue(state: QuantumState, ang: CHSHAngles): number {
  return (
    correlator(state, ang.a, ang.b)
    + correlator(state, ang.a, ang.bp)
    + correlator(state, ang.ap, ang.b)
    - correlator(state, ang.ap, ang.bp)
  );
}

/** CHSH game win probability: a referee sends bits x,y; players win iff a⊕b = x∧y. p = (S+4)/8. */
export function chshWinProb(S: number): number { return (S + 4) / 8; }

/** The classical (0.75) and quantum (cos²π/8) game-win ceilings. */
export const CHSH_GAME_CLASSICAL = 0.75;
export const CHSH_GAME_QUANTUM = Math.cos(Math.PI / 8) ** 2;

/** Maximise S over the four measurement angles with the lab's Nelder–Mead — rediscovers 2√2. */
export function optimizeCHSH(state: QuantumState, seed = 1): { angles: CHSHAngles; S: number } {
  const rng = makeRng(seed);
  const x0 = [rng() * Math.PI, rng() * Math.PI, rng() * Math.PI, rng() * Math.PI];
  const f = (x: number[]) => -chshValue(state, { a: x[0], ap: x[1], b: x[2], bp: x[3] });
  // a couple of restarts to dodge a bad simplex landing
  let best = nelderMead(f, x0, { maxIter: 500, step: 0.7 });
  for (let r = 0; r < 4; r++) {
    const cand = nelderMead(f, [rng() * Math.PI, rng() * Math.PI, rng() * Math.PI, rng() * Math.PI], { maxIter: 500, step: 0.7 });
    if (cand.fx < best.fx) best = cand;
  }
  return { angles: { a: best.x[0], ap: best.x[1], b: best.x[2], bp: best.x[3] }, S: -best.fx };
}

/** Sweep Bob's first angle b across [0, 2π] (others at the optimum) for the S(θ) plot. */
export function chshSweep(state: QuantumState, n = 121): { theta: number; S: number }[] {
  const out: { theta: number; S: number }[] = [];
  for (let i = 0; i < n; i++) {
    const b = (i / (n - 1)) * 2 * Math.PI;
    out.push({ theta: b, S: chshValue(state, { ...OPTIMAL_CHSH, b }) });
  }
  return out;
}

/** Monte-Carlo certificate: the largest |S| found over `trials` random qubit strategies. ≤ 2√2. */
export function tsirelsonCeiling(state: QuantumState, trials = 20000, seed = 7): number {
  const rng = makeRng(seed);
  let worst = 0;
  for (let t = 0; t < trials; t++) {
    const S = Math.abs(chshValue(state, {
      a: rng() * 2 * Math.PI, ap: rng() * 2 * Math.PI, b: rng() * 2 * Math.PI, bp: rng() * 2 * Math.PI,
    }));
    if (S > worst) worst = S;
  }
  return worst;
}

// ───────────────────────────── GHZ / Mermin game ─────────────────────────────

/** |GHZ⟩ = (|000⟩ + |111⟩)/√2. */
export function ghzState(): QuantumState {
  const s = new QuantumState(3);
  s.applyGate({ name: 'H', qubits: [0] });
  s.applyGate({ name: 'CNOT', qubits: [0, 1] });
  s.applyGate({ name: 'CNOT', qubits: [0, 2] });
  return s;
}

/** The four valid referee questions (x⊕y⊕z = 0). */
export const GHZ_QUESTIONS: [number, number, number][] = [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]];

/** The Mermin operator expectations on |GHZ⟩: ⟨XXX⟩ = +1, ⟨XYY⟩ = ⟨YXY⟩ = ⟨YYX⟩ = −1. */
export function merminExpectations(): { label: string; value: number }[] {
  const g = ghzState();
  const mk = (ps: ('X' | 'Y')[]): PauliTerm => ({ coeff: 1, ops: { 0: ps[0], 1: ps[1], 2: ps[2] } });
  return [
    { label: 'XXX', value: expectation(g, [mk(['X', 'X', 'X'])]) },
    { label: 'XYY', value: expectation(g, [mk(['X', 'Y', 'Y'])]) },
    { label: 'YXY', value: expectation(g, [mk(['Y', 'X', 'Y'])]) },
    { label: 'YYX', value: expectation(g, [mk(['Y', 'Y', 'X'])]) },
  ];
}

/** Brute force over all 2⁶ deterministic classical strategies — the best wins exactly 3/4. */
export function ghzClassicalMax(): { max: number; count: number } {
  let max = 0, count = 0;
  for (let s = 0; s < 64; s++) {
    const A = [s & 1, (s >> 1) & 1], B = [(s >> 2) & 1, (s >> 3) & 1], D = [(s >> 4) & 1, (s >> 5) & 1];
    let wins = 0;
    for (const [x, y, z] of GHZ_QUESTIONS) {
      const out = A[x] ^ B[y] ^ D[z];
      if (out === (x | y | z)) wins++;
    }
    const p = wins / GHZ_QUESTIONS.length;
    if (p > max + 1e-12) { max = p; count = 1; } else if (Math.abs(p - max) < 1e-12) count++;
  }
  return { max, count };
}

export interface GHZRow {
  question: [number, number, number];
  operator: string;
  expectation: number;
  outcomeParity: number; // 0 (eigenvalue +1) or 1 (eigenvalue −1)
  required: number;       // x ∨ y ∨ z
  win: boolean;
}

/** The quantum strategy table: measure X for input 0, Y for input 1; report win per question. */
export function ghzGameTable(): GHZRow[] {
  const g = ghzState();
  return GHZ_QUESTIONS.map(([x, y, z]) => {
    const letters: ('X' | 'Y')[] = [x ? 'Y' : 'X', y ? 'Y' : 'X', z ? 'Y' : 'X'];
    const ev = expectation(g, [{ coeff: 1, ops: { 0: letters[0], 1: letters[1], 2: letters[2] } }]);
    const outcomeParity = ev > 0 ? 0 : 1; // eigenvalue +1 → even parity, −1 → odd
    const required = x | y | z;
    return { question: [x, y, z], operator: letters.join(''), expectation: ev, outcomeParity, required, win: outcomeParity === required };
  });
}

/** Quantum win probability for the GHZ game — perfect (1) because |GHZ⟩ is an eigenstate of each operator. */
export function ghzQuantumWin(): number {
  const rows = ghzGameTable();
  return rows.filter((r) => r.win).length / rows.length;
}

// ───────────────────────────── Mermin–Peres magic square ─────────────────────────────

/**
 * The 3×3 grid of two-qubit Pauli observables (letters [first qubit, second qubit]).
 *      X⊗I   I⊗X   X⊗X
 *      I⊗Z   Z⊗I   Z⊗Z
 *      X⊗Z   Z⊗X   Y⊗Y
 * Every row multiplies to +I; every column to +I except the last, which is −I.
 */
export const MAGIC_LETTERS: ['I' | 'X' | 'Y' | 'Z', 'I' | 'X' | 'Y' | 'Z'][][] = [
  [['X', 'I'], ['I', 'X'], ['X', 'X']],
  [['I', 'Z'], ['Z', 'I'], ['Z', 'Z']],
  [['X', 'Z'], ['Z', 'X'], ['Y', 'Y']],
];

/** A human label like "X⊗Z" (with I rendered as the identity). */
export function magicCellLabel(r: number, c: number): string {
  const [p, q] = MAGIC_LETTERS[r][c];
  return `${p}⊗${q}`;
}

function magicCell(r: number, c: number): Mat { return pauliString(MAGIC_LETTERS[r][c]); }

export interface MagicAlgebra {
  involutory: boolean;          // every cell O² = I (so eigenvalues ±1)
  hermitian: boolean;           // every cell is Hermitian (a genuine observable)
  rowProducts: ('+I' | '-I')[]; // ['+I','+I','+I']
  colProducts: ('+I' | '-I')[]; // ['+I','+I','-I']
  rowsCommute: boolean;         // the three cells of each row mutually commute
  colsCommute: boolean;
  parityContradiction: boolean; // ∏rows = +1 but ∏cols = −1 — no classical assignment exists
}

/** Verify the entire magic-square operator algebra on dense 4×4 matrices, to machine precision. */
export function magicSquareAlgebra(): MagicAlgebra {
  const id4 = matIdent(4), neg4 = matScale(id4, -1);
  let involutory = true, hermitian = true, rowsCommute = true, colsCommute = true;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const O = magicCell(r, c);
    if (!matClose(matMul(O, O), id4)) involutory = false;
    // Hermitian: O = O†
    const dag = O.map((_, i) => O.map((row) => row[i].conj()));
    if (!matClose(O, dag)) hermitian = false;
  }
  const prod = (a: Mat, b: Mat, c: Mat) => matMul(matMul(a, b), c);
  const classify = (M: Mat): '+I' | '-I' => (matClose(M, id4) ? '+I' : matClose(M, neg4) ? '-I' : '?') as '+I' | '-I';
  const rowProducts = [0, 1, 2].map((r) => classify(prod(magicCell(r, 0), magicCell(r, 1), magicCell(r, 2))));
  const colProducts = [0, 1, 2].map((c) => classify(prod(magicCell(0, c), magicCell(1, c), magicCell(2, c))));
  for (let r = 0; r < 3; r++) if (!(commutes(magicCell(r, 0), magicCell(r, 1)) && commutes(magicCell(r, 1), magicCell(r, 2)) && commutes(magicCell(r, 0), magicCell(r, 2)))) rowsCommute = false;
  for (let c = 0; c < 3; c++) if (!(commutes(magicCell(0, c), magicCell(1, c)) && commutes(magicCell(1, c), magicCell(2, c)) && commutes(magicCell(0, c), magicCell(2, c)))) colsCommute = false;
  // Parity: product of every cell computed row-wise vs column-wise must disagree in sign.
  const rowSign = rowProducts.reduce((s, p) => s * (p === '+I' ? 1 : -1), 1);
  const colSign = colProducts.reduce((s, p) => s * (p === '+I' ? 1 : -1), 1);
  return { involutory, hermitian, rowProducts, colProducts, rowsCommute, colsCommute, parityContradiction: rowSign !== colSign };
}

/**
 * Brute force the best deterministic classical play: Alice fills each row with a ±1 triple of
 * product +1; Bob fills columns 0,1 with product +1 and column 2 with product −1; maximise the
 * agreement on the shared cell over all such consistent tables. The maximum is 8/9.
 */
export function magicClassicalMax(): number {
  const triples = (sign: number): number[][] => {
    const res: number[][] = [];
    for (const a of [1, -1]) for (const b of [1, -1]) for (const c of [1, -1]) if (a * b * c === sign) res.push([a, b, c]);
    return res;
  };
  const plus = triples(1), minus = triples(-1);
  let best = 0;
  for (const r0 of plus) for (const r1 of plus) for (const r2 of plus) {
    const rows = [r0, r1, r2];
    for (const c0 of plus) for (const c1 of plus) for (const c2 of minus) {
      const cols = [c0, c1, c2];
      let agree = 0;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (rows[r][c] === cols[c][r]) agree++;
      if (agree > best) best = agree;
    }
  }
  return best / 9;
}

/** The shared 4-qubit state |Ω⟩ = |Φ⁺⟩_{0,2} ⊗ |Φ⁺⟩_{1,3} (Alice: qubits 0,1; Bob: 2,3). */
function magicSharedState(): Complex[] {
  const psi = Array.from({ length: 16 }, () => C(0));
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) {
    const idx = x * 8 + y * 4 + x * 2 + y; // q0=x,q1=y,q2=x,q3=y (q0 MSB)
    psi[idx] = C(0.5);
  }
  return psi;
}

export interface MagicQuantum { allAgree: boolean; worstDeviation: number; win: number; }

/**
 * The quantum strategy on two shared Bell pairs. Alice measures her row's operators on qubits 0,1;
 * Bob measures the matching transposed operators on qubits 2,3. Because (M⊗I)|Ω⟩ = (I⊗Mᵀ)|Ω⟩, the
 * shared cell is perfectly correlated: ⟨Ω| A_cell ⊗ B̃_cell |Ω⟩ = +1 for all 9 cells, so the players
 * always agree on the shared entry and win every one of the 81 (row,column) questions with certainty.
 */
export function magicQuantumWin(): MagicQuantum {
  const omega = magicSharedState();
  let worst = 0;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const [p0, p1] = MAGIC_LETTERS[r][c];
    const A = pauliString([p0, p1, 'I', 'I']);
    // Bob's matching operator on qubits 2,3 = transpose of the cell (Yᵀ = −Y).
    const yCount = (p0 === 'Y' ? 1 : 0) + (p1 === 'Y' ? 1 : 0);
    let B = pauliString(['I', 'I', p0, p1]);
    if (yCount % 2 === 1) B = matScale(B, -1);
    const corr = expectationMat(omega, matMul(A, B));
    worst = Math.max(worst, Math.abs(corr - 1));
  }
  return { allAgree: worst < 1e-9, worstDeviation: worst, win: worst < 1e-9 ? 1 : NaN };
}

export const MAGIC_CLASSICAL = 8 / 9;
