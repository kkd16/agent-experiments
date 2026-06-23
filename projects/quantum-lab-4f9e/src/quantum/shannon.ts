// The Quantum Shannon Decomposition — synthesising ANY n-qubit gate, the n-qubit
// generalisation of this lab's 1-qubit (Solovay–Kitaev) and 2-qubit (KAK) synthesis.
//
// A real machine has single-qubit rotations and ONE entangler (the CNOT). For one qubit the
// structure theorem is the ZYZ Euler decomposition; for two it is the KAK / Cartan
// decomposition. For n qubits it is the COSINE–SINE DECOMPOSITION (CSD), and recursing on it
// is the Quantum Shannon Decomposition (Shende–Bullock–Markov 2006).
//
// Partition a 2ⁿ×2ⁿ unitary U by its top qubit into four 2ⁿ⁻¹ blocks. The CSD factors it as
//
//     U = ⎡L0   ⎤ ⎡ C  −S ⎤ ⎡R0   ⎤        C = diag(cos θ_k),  S = diag(sin θ_k)
//         ⎣   L1⎦ ⎣ S   C ⎦ ⎣   R1⎦
//
// — two "quantum multiplexors" (block-diagonal unitaries controlled by the top qubit) sandwiching
// a central [[C,−S],[S,C]] which is exactly a UNIFORMLY-CONTROLLED Rʏ on the top qubit (angle 2θ_k
// selected by the lower n−1 qubits). Each multiplexor diag(A,B) then DEMULTIPLEXES:
//
//     diag(A,B) = (I⊗V)·(uniformly-controlled R_z)·(I⊗W),    V,Λ = eig(A·B†),  D = √Λ,  W = D†V†A,
//
// so it becomes two (n−1)-qubit gates V,W applied unconditionally to the lower wires plus a
// uniformly-controlled R_z. Recurse on the four (n−1)-qubit gates V_L,W_L,V_R,W_R; the base case
// n=1 is the ZYZ decomposition. Every uniformly-controlled rotation lowers to 2^{n−1} CNOTs and
// 2^{n−1} rotations via the Gray-code / Walsh–Hadamard angle transform (Möttönen et al.), so the
// whole synthesis costs exactly (3/4)·4ⁿ − 3·2ⁿ⁻¹ CNOTs — and reproduces U to machine precision.
//
// New from-scratch machinery this needs, on top of the lab's existing complex linear algebra:
//   • eig of a UNITARY (normal) matrix — via a simultaneous diagonalisation of its two commuting
//     Hermitian parts (the lab's Hermitian Jacobi solver does the work);
//   • the cosine–sine decomposition itself, built from two block SVDs + an orthonormal completion;
//   • the uniformly-controlled rotation → {CNOT, rotation} flattening at the optimal CNOT count.
//
// The whole thing was validated numerically in a throwaway oracle before being written here; the
// real bug it caught was the CSD's right factor being R†, not R.

import { Complex, C } from './Complex';
import { matMul, dagger } from './Matrix';
import { hermitianEig } from './Hermitian';
import { type Mat, zeros, frob } from './kak';
import { type SU2, type Gate, compileGate } from './solovay';

const eI = (t: number) => Complex.fromPolar(1, t);

// ───────────────────────────── circuit op type ─────────────────────────────

/** An op on an n-qubit register. Rotations are SU(2): Rσ(θ)=exp(−iθσ/2). */
export type QGate =
  | { kind: 'rz'; target: number; angle: number }
  | { kind: 'ry'; target: number; angle: number }
  | { kind: 'cnot'; control: number; target: number };

// ───────────────────────────── small helpers ─────────────────────────────

/** Eigen-decompose an n×n UNITARY (normal) matrix W = V diag(e^{iφ}) V†.
 *  W is normal, so its Hermitian parts H₁=(W+W†)/2 and H₂=(W−W†)/2i commute and share an
 *  eigenbasis; diagonalise H₁, then resolve any degenerate cluster with H₂ — robust through the
 *  repeated eigenvalues of structured gates. Returns eigenvectors as COLUMNS and their phases. */
export function eigUnitary(W: Mat): { vectors: Mat; phases: number[] } {
  const n = W.length;
  if (n === 1) return { vectors: [[C(1)]], phases: [W[0][0].phase()] };
  const Wd = dagger(W);
  const H1: Mat = zeros(n, n), H2: Mat = zeros(n, n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    H1[i][j] = W[i][j].add(Wd[i][j]).scale(0.5);
    const d = W[i][j].sub(Wd[i][j]);              // (W−W†)/(2i) = −i/2·(W−W†)
    H2[i][j] = new Complex(d.im, -d.re).scale(0.5);
  }
  const { values: v1, vectors: V1 } = hermitianEig(H1); // V1[i][k] = component i of column k
  // T = V1† H2 V1 in the H₁ eigenbasis.
  const T = matMul(matMul(dagger(V1), H2), V1);
  const used: boolean[] = Array(n).fill(false);
  const O: Mat = V1.map((r) => r.slice());
  for (let a = 0; a < n; a++) {
    if (used[a]) continue;
    const cluster = [a]; used[a] = true;
    for (let b = a + 1; b < n; b++) if (!used[b] && Math.abs(v1[a] - v1[b]) < 1e-7) { cluster.push(b); used[b] = true; }
    if (cluster.length > 1) {
      const m = cluster.length;
      const sub: Mat = Array.from({ length: m }, (_, i) => cluster.map((j) => T[cluster[i]][j]));
      const { vectors: W2 } = hermitianEig(sub);
      const nc: Mat = zeros(n, m);
      for (let i = 0; i < n; i++) for (let p = 0; p < m; p++) {
        let s = C(0);
        for (let q = 0; q < m; q++) s = s.add(V1[i][cluster[q]].mul(W2[q][p]));
        nc[i][p] = s;
      }
      for (let p = 0; p < m; p++) for (let i = 0; i < n; i++) O[i][cluster[p]] = nc[i][p];
    }
  }
  // phases λ_k = v_k† W v_k.
  const phases: number[] = [];
  for (let k = 0; k < n; k++) {
    let lam = C(0);
    for (let i = 0; i < n; i++) {
      let s = C(0);
      for (let j = 0; j < n; j++) s = s.add(W[i][j].mul(O[j][k]));
      lam = lam.add(O[i][k].conj().mul(s));
    }
    phases.push(lam.phase());
  }
  return { vectors: O, phases };
}

// ───────────────────────────── block SVD (for the CSD) ─────────────────────────────

/** Full SVD A = U·diag(S)·V† of a square m×m matrix, keeping ALL m columns (zero singular values
 *  included, their U/V vectors completed to an orthonormal basis). Built on the Hermitian
 *  eigensolver via the Gram matrix A†A — the lab already trusts this route in SVD.ts. */
function blockSVD(A: Mat): { U: Mat; S: number[]; V: Mat } {
  const m = A.length;
  const G = matMul(dagger(A), A);                  // A†A = V diag(σ²) V†
  const { values, vectors: V } = hermitianEig(G);  // descending; V columns
  const S = values.map((v) => Math.sqrt(Math.max(v, 0)));
  const U: Mat = zeros(m, m);
  const zeroCols: number[] = [];
  for (let c = 0; c < m; c++) {
    if (S[c] > 1e-9) {
      const inv = 1 / S[c];
      for (let i = 0; i < m; i++) {
        let s = C(0);
        for (let j = 0; j < m; j++) s = s.add(A[i][j].mul(V[j][c]));
        U[i][c] = s.scale(inv);
      }
    } else zeroCols.push(c);
  }
  completeColumns(U, zeroCols);
  return { U, S, V };
}

/** Replace the given columns of an otherwise-orthonormal-columned matrix with an orthonormal
 *  completion. For each column to fill, search the standard basis e₀…e_{m−1} for a vector whose
 *  residual against the columns kept so far is non-trivial (robust when a missing column's "natural"
 *  basis vector is already occupied — the degenerate case of permutations/reflections). */
function completeColumns(M: Mat, cols: number[]): void {
  const m = M.length;
  const occupied: number[] = [];                   // indices of columns already orthonormal
  for (let k = 0; k < m; k++) if (!cols.includes(k)) occupied.push(k);
  for (const c of cols) {
    let chosen: Complex[] | null = null;
    for (let e = 0; e < m; e++) {
      const v: Complex[] = Array.from({ length: m }, (_, i) => C(i === e ? 1 : 0));
      for (let pass = 0; pass < 2; pass++) for (const k of occupied) {
        let dot = C(0);
        for (let i = 0; i < m; i++) dot = dot.add(M[i][k].conj().mul(v[i]));
        for (let i = 0; i < m; i++) v[i] = v[i].sub(dot.mul(M[i][k]));
      }
      const nrm = Math.sqrt(v.reduce((s, z) => s + z.abs2(), 0));
      if (nrm > 1e-7) { chosen = v.map((z) => z.scale(1 / nrm)); break; }
    }
    if (!chosen) chosen = Array.from({ length: m }, (_, i) => C(i === c ? 1 : 0));
    for (let i = 0; i < m; i++) M[i][c] = chosen[i];
    occupied.push(c);
  }
}

// ───────────────────────────── the cosine–sine decomposition ─────────────────────────────

export interface CSD {
  L0: Mat; L1: Mat;        // left multiplexor blocks
  R0: Mat; R1: Mat;        // right multiplexor blocks (the factor is diag(R0†,R1†))
  theta: number[];         // CS angles; C=cos θ, S=sin θ
  error: number;           // ‖U − diag(L0,L1)·CS·diag(R0†,R1†)‖_F
}

/** Cosine–sine decomposition of a 2m×2m unitary partitioned by its top qubit. */
export function cosineSineDecomposition(U: Mat): CSD {
  const two = U.length, m = two / 2;
  const U00 = block(U, 0, m, 0, m), U01 = block(U, 0, m, m, two);
  const U10 = block(U, m, two, 0, m), U11 = block(U, m, two, m, two);

  const { U: L0, S: cosv, V: R0 } = blockSVD(U00);  // U00 = L0·diag(cos)·R0†
  const Cc = cosv.map((x) => Math.min(1, x));
  const theta = Cc.map((x) => Math.acos(Math.max(-1, Math.min(1, x))));
  const Sn = theta.map((t) => Math.sin(t));

  // Ŝ = U10·R0 has orthogonal columns of norm sin θ_k → L1 columns; complete the cos≈1 ones.
  const Shat = matMul(U10, R0);
  const L1: Mat = zeros(m, m);
  const small: number[] = [];
  for (let j = 0; j < m; j++) {
    if (Sn[j] > 1e-9) for (let i = 0; i < m; i++) L1[i][j] = Shat[i][j].scale(1 / Sn[j]);
    else small.push(j);
  }
  completeColumns(L1, small);

  // R1: read it off the bottom-right block of CS†·diag(L0†,L1†)·U, which equals diag(R0†,R1†)
  // exactly (the product is unitary, its top-left block is R0† and its bottom-left vanishes, so the
  // off-diagonal blocks are forced to zero). This is R1† = C·(L1†U11) − S·(L0†U01) — DIVISION-FREE,
  // so it stays exact through the degenerate cos=0 / sin=0 rows of permutations and reflections.
  const L1dU11 = matMul(dagger(L1), U11);
  const L0dU01 = matMul(dagger(L0), U01);
  const R1d: Mat = zeros(m, m);                     // this is R1†
  for (let r = 0; r < m; r++) for (let col = 0; col < m; col++) {
    R1d[r][col] = L1dU11[r][col].scale(Cc[r]).sub(L0dU01[r][col].scale(Sn[r]));
  }
  const R1 = dagger(R1d);

  // reconstruction error
  const recon = csdRecon(L0, L1, theta, R0, R1);
  return { L0, L1, R0, R1, theta, error: frob(recon, U) };
}

function csdRecon(L0: Mat, L1: Mat, theta: number[], R0: Mat, R1: Mat): Mat {
  const m = L0.length, two = 2 * m;
  const Ld = zeros(two, two), Rd = zeros(two, two), CS = zeros(two, two);
  const R0d = dagger(R0), R1d = dagger(R1);
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
    Ld[i][j] = L0[i][j]; Ld[m + i][m + j] = L1[i][j];
    Rd[i][j] = R0d[i][j]; Rd[m + i][m + j] = R1d[i][j];
  }
  for (let j = 0; j < m; j++) {
    const c = Math.cos(theta[j]), s = Math.sin(theta[j]);
    CS[j][j] = C(c); CS[m + j][m + j] = C(c); CS[j][m + j] = C(-s); CS[m + j][j] = C(s);
  }
  return matMul(matMul(Ld, CS), Rd);
}

function block(U: Mat, r0: number, r1: number, c0: number, c1: number): Mat {
  const R: Mat = [];
  for (let i = r0; i < r1; i++) R.push(U[i].slice(c0, c1));
  return R;
}

// ───────────────────────────── demultiplexor ─────────────────────────────

export interface Demux { V: Mat; W: Mat; rzAngles: number[]; }

/** diag(A,B) = (I⊗V)·(uniformly-controlled R_z, angle −φ_k)·(I⊗W), with V,e^{iφ}=eig(A·B†),
 *  W = D†V†A, D=diag(e^{iφ_k/2}). Reproduces diag(A,B) exactly (no dropped phase). */
export function demultiplex(A: Mat, B: Mat): Demux {
  const { vectors: V, phases } = eigUnitary(matMul(A, dagger(B)));  // A·B† = V diag(e^{iφ}) V†
  const VdA = matMul(dagger(V), A);
  const W: Mat = VdA.map((row, k) => row.map((z) => z.mul(eI(-phases[k] / 2))));  // D†V†A
  return { V, W, rzAngles: phases.map((p) => -p) };
}

// ───────────────────────── uniformly-controlled rotation ─────────────────────────

const grayCode = (k: number) => k ^ (k >> 1);
const popcount = (x: number) => { let n = 0; while (x) { n += x & 1; x >>= 1; } return n; };
const ctz = (k: number) => { let n = 0; while ((k & 1) === 0) { n++; k >>= 1; } return n; };

/** A uniformly-controlled rotation (R_y or R_z) on `target`, the angle chosen by the `controls`
 *  bit-pattern (controls[0] = most significant). Lowered to the optimal 2^m CNOTs + 2^m rotations
 *  via the Gray-code / Walsh–Hadamard angle transform. Ops are first-applied-first. */
export function uniformlyControlledRotation(
  angles: number[], axis: 'ry' | 'rz', target: number, controls: number[],
): QGate[] {
  const m = controls.length, N = 1 << m;
  if (m === 0) return [{ kind: axis, target, angle: angles[0] }];
  const theta = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    let s = 0; const gi = grayCode(i);
    for (let j = 0; j < N; j++) s += ((popcount(gi & j) & 1) ? -1 : 1) * angles[j];
    theta[i] = s / N;
  }
  const ops: QGate[] = [];
  for (let i = 0; i < N; i++) {
    ops.push({ kind: axis, target, angle: theta[i] });
    const p = (i === N - 1) ? (m - 1) : ctz(i + 1);
    ops.push({ kind: 'cnot', control: controls[m - 1 - p], target });
  }
  return ops;
}

// ───────────────────────────── the recursion ─────────────────────────────

/** ZYZ base case: a 2×2 unitary as SU(2) rotations Rz(δ)→Ry(γ)→Rz(β) (global phase dropped). */
function zyzOps(U: Mat, q: number): QGate[] {
  const d = U[0][0].mul(U[1][1]).sub(U[0][1].mul(U[1][0]));
  const alpha = d.phase() / 2;
  const u = U.map((r) => r.map((z) => z.mul(eI(-alpha))));      // → SU(2)
  const gamma = 2 * Math.atan2(u[1][0].abs(), u[0][0].abs());
  const bpd = u[1][1].phase(), bmd = u[1][0].phase();
  const beta = bpd + bmd, delta = bpd - bmd;
  return [
    { kind: 'rz', target: q, angle: delta },
    { kind: 'ry', target: q, angle: gamma },
    { kind: 'rz', target: q, angle: beta },
  ];
}

/** Recursive Quantum Shannon Decomposition. `qubits[0]` is the most-significant wire. */
function qsdRec(U: Mat, qubits: number[]): QGate[] {
  if (qubits.length === 1) return zyzOps(U, qubits[0]);
  const { L0, L1, theta, R0, R1 } = cosineSineDecomposition(U);
  const top = qubits[0], lower = qubits.slice(1);
  const dR = demultiplex(dagger(R0), dagger(R1));   // right factor is diag(R0†,R1†)
  const dL = demultiplex(L0, L1);
  return [
    ...qsdRec(dR.W, lower),
    ...uniformlyControlledRotation(dR.rzAngles, 'rz', top, lower),
    ...qsdRec(dR.V, lower),
    ...uniformlyControlledRotation(theta.map((t) => 2 * t), 'ry', top, lower),
    ...qsdRec(dL.W, lower),
    ...uniformlyControlledRotation(dL.rzAngles, 'rz', top, lower),
    ...qsdRec(dL.V, lower),
  ];
}

export interface Shannon {
  gates: QGate[];
  cnots: number;
  singleQubit: number;
  theoreticalCnots: number;    // (3/4)·4ⁿ − 3·2ⁿ⁻¹
  globalPhase: number;         // realised circuit = e^{i·globalPhase}·U
  reconError: number;          // ‖circuit − U‖ (up to global phase)
}

/** Synthesise an arbitrary n-qubit unitary into a {Rz, Ry, CNOT} circuit. */
export function shannonDecompose(U: Mat, numQubits: number): Shannon {
  const gates = qsdRec(U, Array.from({ length: numQubits }, (_, i) => i));
  return summarise(U, numQubits, gates);
}

function summarise(U: Mat, n: number, gates: QGate[]): Shannon {
  const R = circuitToMatrix(gates, n);
  return {
    gates,
    cnots: gates.filter((g) => g.kind === 'cnot').length,
    singleQubit: gates.filter((g) => g.kind !== 'cnot').length,
    theoreticalCnots: Math.round(0.75 * 4 ** n - 3 * 2 ** (n - 1)),
    globalPhase: globalPhaseOf(U, R),
    reconError: distModPhase(U, R),
  };
}

// ───────────────────────────── circuit → matrix ─────────────────────────────

/** Build the 2ⁿ×2ⁿ matrix of a circuit by evolving each basis state. Qubit 0 = most significant. */
export function circuitToMatrix(gates: QGate[], n: number): Mat {
  const N = 1 << n;
  const M = zeros(N, N);
  const cur = new Float64Array(N), curI = new Float64Array(N);
  const nxt = new Float64Array(N), nxtI = new Float64Array(N);
  for (let col = 0; col < N; col++) {
    cur.fill(0); curI.fill(0); cur[col] = 1;
    for (const g of gates) {
      if (g.kind === 'cnot') {
        const cb = n - 1 - g.control, tb = n - 1 - g.target;
        for (let i = 0; i < N; i++) {
          if (((i >> cb) & 1) && !((i >> tb) & 1)) {
            const j = i | (1 << tb);
            const tr = cur[i], ti = curI[i]; cur[i] = cur[j]; curI[i] = curI[j]; cur[j] = tr; curI[j] = ti;
          }
        }
      } else {
        // 2×2 gate entries (real/imag)
        let m00r, m00i, m01r, m01i, m10r, m10i, m11r, m11i;
        if (g.kind === 'ry') {
          const c = Math.cos(g.angle / 2), s = Math.sin(g.angle / 2);
          m00r = c; m00i = 0; m01r = -s; m01i = 0; m10r = s; m10i = 0; m11r = c; m11i = 0;
        } else {
          const c = Math.cos(g.angle / 2), s = Math.sin(g.angle / 2);
          m00r = c; m00i = -s; m01r = 0; m01i = 0; m10r = 0; m10i = 0; m11r = c; m11i = s;
        }
        const tb = n - 1 - g.target;
        nxt.set(cur); nxtI.set(curI);
        for (let i = 0; i < N; i++) {
          if ((i >> tb) & 1) continue;
          const i0 = i, i1 = i | (1 << tb);
          const a0r = cur[i0], a0i = curI[i0], a1r = cur[i1], a1i = curI[i1];
          nxt[i0] = m00r * a0r - m00i * a0i + m01r * a1r - m01i * a1i;
          nxtI[i0] = m00r * a0i + m00i * a0r + m01r * a1i + m01i * a1r;
          nxt[i1] = m10r * a0r - m10i * a0i + m11r * a1r - m11i * a1i;
          nxtI[i1] = m10r * a0i + m10i * a0r + m11r * a1i + m11i * a1r;
        }
        cur.set(nxt); curI.set(nxtI);
      }
    }
    for (let i = 0; i < N; i++) M[i][col] = new Complex(cur[i], curI[i]);
  }
  return M;
}

// ───────────────────────────── distances ─────────────────────────────

/** ‖U − e^{iφ}V‖_F minimised over the global phase φ. The optimum is e^{iφ}=⟨V,U⟩/|⟨V,U⟩|,
 *  i.e. φ = −arg⟨U,V⟩. */
export function distModPhase(U: Mat, V: Mat): number {
  const ph = eI(-globalPhaseOf(U, V));
  let s = 0;
  for (let i = 0; i < U.length; i++) for (let j = 0; j < U.length; j++) s += U[i][j].sub(V[i][j].mul(ph)).abs2();
  return Math.sqrt(s);
}

/** The global phase φ with V ≈ e^{iφ}U, i.e. arg⟨U,V⟩. */
export function globalPhaseOf(U: Mat, V: Mat): number {
  let ip = C(0);
  for (let i = 0; i < U.length; i++) for (let j = 0; j < U.length; j++) ip = ip.add(U[i][j].conj().mul(V[i][j]));
  return ip.phase();
}

// ───────────────────────────── peephole optimiser ─────────────────────────────

/** A correctness-preserving peephole pass: cancel adjacent identical CNOTs (CNOT²=I), fuse
 *  adjacent same-axis rotations on the same wire, and drop ≈0 rotations. Structured gates (QFT,
 *  permutations) collapse dramatically; generic gates are barely touched. */
export function optimizeCircuit(gates: QGate[]): QGate[] {
  let cur = gates.slice();
  for (let pass = 0; pass < 6; pass++) {
    const out: QGate[] = [];
    for (const g of cur) {
      const prev = out[out.length - 1];
      if (g.kind === 'cnot') {
        if (prev && prev.kind === 'cnot' && prev.control === g.control && prev.target === g.target) { out.pop(); continue; }
        out.push(g);
      } else {
        if (prev && prev.kind === g.kind && prev.target === g.target) {
          const merged = prev.angle + g.angle;
          out.pop();
          if (!nearZeroAngle(merged)) out.push({ kind: g.kind, target: g.target, angle: merged });
          continue;
        }
        if (nearZeroAngle(g.angle)) continue;
        out.push(g);
      }
    }
    if (out.length === cur.length) { cur = out; break; }
    cur = out;
  }
  return cur;
}

function nearZeroAngle(a: number): boolean {
  const r = ((a % (4 * Math.PI)) + 4 * Math.PI) % (4 * Math.PI);   // Rz/Ry have period 4π
  return r < 1e-9 || Math.abs(r - 4 * Math.PI) < 1e-9;
}

// ───────────────────── fault-tolerant {H, T, CNOT} compilation ─────────────────────

export interface FTShannon {
  cnots: number;
  tCount: number;            // total T / T† gates — the magic-state budget
  gateCount: number;         // discrete 1-qubit gates
  words: { target: number; word: Gate[]; tCount: number }[];
  error: number;             // ‖discrete circuit − U‖ (up to global phase)
  depth: number;
}

/** Compile every single-qubit rotation of the QSD circuit into a discrete {H,T,…} word via
 *  Solovay–Kitaev — so an arbitrary n-qubit unitary becomes a real {H,T,CNOT} circuit with a
 *  total T-count, the n-qubit closing of the lab's 1- and 2-qubit fault-tolerant story. */
export function faultTolerantShannon(U: Mat, numQubits: number, depth = 2): FTShannon {
  const gates = optimizeCircuit(shannonDecompose(U, numQubits).gates);
  const compiled: QGate[] = [];
  const words: FTShannon['words'] = [];
  let tCount = 0, gateCount = 0, cnots = 0;
  for (const g of gates) {
    if (g.kind === 'cnot') { cnots++; compiled.push(g); continue; }
    const su: SU2 = g.kind === 'rz' ? rotSU2('z', g.angle) : rotSU2('y', g.angle);
    const res = compileGate(su, depth);
    tCount += res.tCount; gateCount += res.reduced.length;
    words.push({ target: g.target, word: res.reduced, tCount: res.tCount });
    // realised SU(2) of the compiled word, re-expressed as Rz/Ry ops is awkward; instead splat
    // the realised single-qubit unitary back as a generic rotation pair for the error check.
    compiled.push(...su2ToOps(res.approx, g.target));
  }
  const R = circuitToMatrix(compiled, numQubits);
  return { cnots, tCount, gateCount, words, error: distModPhase(U, R), depth };
}

/** SU(2) of Rσ(θ)=exp(−iθσ/2) in the lab's (a,b) form. */
function rotSU2(axis: 'y' | 'z', theta: number): SU2 {
  const c = Math.cos(theta / 2), s = Math.sin(theta / 2);
  if (axis === 'z') return { a: new Complex(c, -s), b: C(0) };
  return { a: C(c), b: C(-s) };
}

/** Express an SU(2) (a,b) as ZYZ rotation ops on one wire (for re-simulating the SK approximant). */
function su2ToOps(su: SU2, q: number): QGate[] {
  const U: Mat = [[su.a, su.b], [su.b.conj().neg(), su.a.conj()]];
  return zyzOps(U, q);
}
