// From the KAK decomposition to an actual circuit — and then to a fault-tolerant one.
//
// kakDecompose gives U = e^{iφ}(A₀⊗A₁)·exp(i(cx XX+cy YY+cz ZZ))·(B₀⊗B₁). The canonical
// interaction is realised by the optimal three-CNOT "Cartan" circuit (Vatan–Williams):
// three CNOTs interleaved with five single-qubit rotations whose angles are read straight
// off (cx,cy,cz). Sandwiched by the two local layers, that synthesises ANY two-qubit gate
// from {Rz, Ry, CNOT} — the realised matrix matches U to ~1e-12.
//
// Then the fault-tolerant step: every single-qubit gate in that circuit is itself compiled
// by Solovay–Kitaev into a word over {H, T, …}, so the whole gate becomes a discrete
// {H, T, CNOT} circuit — and we report its total T-count, the resource a real machine pays
// for in distilled magic states.

import { Complex, C } from './Complex';
import { matMul, tensorProduct } from './Matrix';
import {
  type Mat, eye, scaleMat, frob, kakDecompose, canonicalizeCoords, cnotCount, tensorFactor,
  canonicalGate,
} from './kak';
import {
  type SU2, type Gate, compileGate,
} from './solovay';

// ───────────────────────────── circuit ops ─────────────────────────────

export type Qubit = 0 | 1;
export type CircuitOp =
  | { kind: 'cnot'; control: Qubit; target: Qubit }
  | { kind: 'rot'; qubit: Qubit; axis: 'x' | 'y' | 'z'; angle: number }
  | { kind: 'u'; qubit: Qubit; mat: Mat; label: string };

const eI = (t: number) => Complex.fromPolar(1, t);

function Rz(t: number): Mat { return [[eI(-t / 2), C(0)], [C(0), eI(t / 2)]]; }
function Ry(t: number): Mat { const c = Math.cos(t / 2), s = Math.sin(t / 2); return [[C(c), C(-s)], [C(s), C(c)]]; }
function Rx(t: number): Mat { const c = Math.cos(t / 2), s = Math.sin(t / 2); return [[C(c), C(0, -s)], [C(0, -s), C(c)]]; }
const I2: Mat = [[C(1), C(0)], [C(0), C(1)]];

const on0 = (g: Mat): Mat => tensorProduct(g, I2);   // qubit 0 = high bit
const on1 = (g: Mat): Mat => tensorProduct(I2, g);
const CNOT01: Mat = [[C(1), C(0), C(0), C(0)], [C(0), C(1), C(0), C(0)], [C(0), C(0), C(0), C(1)], [C(0), C(0), C(1), C(0)]];
const CNOT10: Mat = [[C(1), C(0), C(0), C(0)], [C(0), C(0), C(0), C(1)], [C(0), C(0), C(1), C(0)], [C(0), C(1), C(0), C(0)]];

function opMatrix(op: CircuitOp): Mat {
  if (op.kind === 'cnot') return op.control === 0 ? CNOT01 : CNOT10;
  if (op.kind === 'rot') {
    const g = op.axis === 'x' ? Rx(op.angle) : op.axis === 'y' ? Ry(op.angle) : Rz(op.angle);
    return op.qubit === 0 ? on0(g) : on1(g);
  }
  return op.qubit === 0 ? on0(op.mat) : on1(op.mat);
}

/** Build the 4×4 matrix of a circuit (ops listed first-applied-first). */
export function circuitMatrix(ops: CircuitOp[]): Mat {
  let M = eye(4);
  for (const op of ops) M = matMul(opMatrix(op), M);
  return M;
}

/** Distance between two 4×4 unitaries minimised over a global phase. */
export function distModPhase(U: Mat, V: Mat): number {
  let ip = C(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) ip = ip.add(V[i][j].conj().mul(U[i][j]));
  const ph = ip.phase();
  return frob(U, scaleMat(V, eI(ph)));
}

// ───────────────────────────── synthesis ─────────────────────────────

export interface Synthesis {
  ops: CircuitOp[];
  cnots: number;            // CNOTs in the realised circuit
  optimalCnots: number;     // theoretical minimum for this gate's local-equivalence class
  canonCoords: [number, number, number];   // Weyl-chamber coordinates
  rawCoords: [number, number, number];
  globalPhase: number;
  reconError: number;       // ‖realised circuit − U‖ (up to global phase)
  localityError: number;
}

/** Synthesise an arbitrary two-qubit gate into a {Rz, Ry, CNOT} circuit. */
export function synthesize(U: Mat): Synthesis {
  const kak = kakDecompose(U);
  const U0 = scaleMat(U, eI(-kak.globalPhase));
  const canon = canonicalizeCoords(kak.coords, U0);
  const opt = cnotCount(canon);
  const [cx, cy, cz] = kak.coords;
  const [A0, A1] = kak.left, [B0, B1] = kak.right;

  let ops: CircuitOp[];
  if (opt === 0) {
    // Local gate: just two single-qubit gates, no entangler.
    const { k0, k1 } = tensorFactor(U0);
    ops = [
      { kind: 'u', qubit: 1, mat: k1, label: 'C₁' },
      { kind: 'u', qubit: 0, mat: k0, label: 'C₀' },
    ];
  } else {
    // Optimal 3-CNOT Cartan circuit for the canonical interaction, sandwiched by the locals.
    ops = [
      { kind: 'u', qubit: 1, mat: B1, label: 'B₁' },
      { kind: 'u', qubit: 0, mat: B0, label: 'B₀' },
      { kind: 'rot', qubit: 1, axis: 'z', angle: Math.PI / 2 },
      { kind: 'cnot', control: 1, target: 0 },
      { kind: 'rot', qubit: 0, axis: 'z', angle: Math.PI / 2 - 2 * cz },
      { kind: 'rot', qubit: 1, axis: 'y', angle: Math.PI / 2 - 2 * cx },
      { kind: 'cnot', control: 0, target: 1 },
      { kind: 'rot', qubit: 1, axis: 'y', angle: 2 * cy - Math.PI / 2 },
      { kind: 'cnot', control: 1, target: 0 },
      { kind: 'rot', qubit: 0, axis: 'z', angle: -Math.PI / 2 },
      { kind: 'u', qubit: 1, mat: A1, label: 'A₁' },
      { kind: 'u', qubit: 0, mat: A0, label: 'A₀' },
    ];
  }

  const cnots = ops.filter((o) => o.kind === 'cnot').length;
  const reconError = distModPhase(U, circuitMatrix(ops));
  return {
    ops, cnots, optimalCnots: opt, canonCoords: canon, rawCoords: kak.coords,
    globalPhase: kak.globalPhase, reconError, localityError: kak.localityError,
  };
}

// ───────────────────────── fault-tolerant {H,T,CNOT} compilation ─────────────────────────

/** Strip a 2×2 U(2) of its global phase into Solovay–Kitaev's SU(2) (a,b) form. */
export function matToSU2(U: Mat): SU2 {
  const d = U[0][0].mul(U[1][1]).sub(U[0][1].mul(U[1][0]));
  const su = scaleMat(U, C(1).div(Complex.fromPolar(Math.sqrt(d.abs()), d.phase() / 2)));
  return { a: su[0][0], b: su[0][1] };
}

export interface FTGate { qubit: Qubit; word: Gate[]; tCount: number; }
export interface FTCircuit {
  ops: CircuitOp[];               // structural ops (the single-qubit ones now stand for SK words)
  words: (FTGate | { cnot: true; control: Qubit; target: Qubit })[];
  cnots: number;
  tCount: number;                 // total T / T† gates — the magic-state budget
  gateCount: number;              // total discrete 1-qubit gates
  error: number;                  // ‖discrete circuit − U‖ (up to global phase)
  depth: number;                  // SK recursion depth used
}

/** Compile a synthesised circuit fully into {H, T, T†, S, S†, X, Y, Z, CNOT}. */
export function faultTolerant(U: Mat, depth = 3): FTCircuit {
  const syn = synthesize(U);
  const words: FTCircuit['words'] = [];
  let tCount = 0, gateCount = 0, cnots = 0;
  // Rebuild the circuit matrix using the SK-approximated single-qubit gates.
  let M = eye(4);
  for (const op of syn.ops) {
    if (op.kind === 'cnot') {
      cnots++;
      words.push({ cnot: true, control: op.control, target: op.target });
      M = matMul(op.control === 0 ? CNOT01 : CNOT10, M);
      continue;
    }
    const mat = op.kind === 'rot'
      ? (op.axis === 'x' ? Rx(op.angle) : op.axis === 'y' ? Ry(op.angle) : Rz(op.angle))
      : op.mat;
    const res = compileGate(matToSU2(mat), depth);
    tCount += res.tCount;
    gateCount += res.reduced.length;
    words.push({ qubit: op.qubit, word: res.reduced, tCount: res.tCount });
    // SU(2) actually realised by the compiled word (matches the target up to a global phase).
    const su = res.approx;
    const approx: Mat = [[su.a, su.b], [su.b.conj().neg(), su.a.conj()]];
    M = matMul(op.qubit === 0 ? on0(approx) : on1(approx), M);
  }
  return { ops: syn.ops, words, cnots, tCount, gateCount, error: distModPhase(U, M), depth };
}

// ───────────────────────────── named two-qubit targets ─────────────────────────────

export interface NamedGate {
  id: string;
  label: string;
  desc: string;
  optimalCnots: number;
  make: () => Mat;
}

const m4 = (rows: [number, number][][]): Mat => rows.map((r) => r.map(([re, im]) => C(re, im)));

const CNOT = m4([[[1, 0], [0, 0], [0, 0], [0, 0]], [[0, 0], [1, 0], [0, 0], [0, 0]], [[0, 0], [0, 0], [0, 0], [1, 0]], [[0, 0], [0, 0], [1, 0], [0, 0]]]);
const CZ = m4([[[1, 0], [0, 0], [0, 0], [0, 0]], [[0, 0], [1, 0], [0, 0], [0, 0]], [[0, 0], [0, 0], [1, 0], [0, 0]], [[0, 0], [0, 0], [0, 0], [-1, 0]]]);
const SWAP = m4([[[1, 0], [0, 0], [0, 0], [0, 0]], [[0, 0], [0, 0], [1, 0], [0, 0]], [[0, 0], [1, 0], [0, 0], [0, 0]], [[0, 0], [0, 0], [0, 0], [1, 0]]]);
const ISWAP = m4([[[1, 0], [0, 0], [0, 0], [0, 0]], [[0, 0], [0, 0], [0, 1], [0, 0]], [[0, 0], [0, 1], [0, 0], [0, 0]], [[0, 0], [0, 0], [0, 0], [1, 0]]]);

/** √iSWAP — a hardware-native entangler (superconducting qubits). */
function sqrtISwap(): Mat {
  const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
  return m4([
    [[1, 0], [0, 0], [0, 0], [0, 0]],
    [[0, 0], [c, 0], [0, s], [0, 0]],
    [[0, 0], [0, s], [c, 0], [0, 0]],
    [[0, 0], [0, 0], [0, 0], [1, 0]],
  ]);
}
/** √SWAP — the canonical 2-CNOT example. */
function sqrtSwap(): Mat {
  return m4([
    [[1, 0], [0, 0], [0, 0], [0, 0]],
    [[0, 0], [0.5, 0.5], [0.5, -0.5], [0, 0]],
    [[0, 0], [0.5, -0.5], [0.5, 0.5], [0, 0]],
    [[0, 0], [0, 0], [0, 0], [1, 0]],
  ]);
}
/** The Berkeley B gate exp(i(π/4 XX + π/8 YY)) — twice it realises any gate in two uses. */
function bGate(): Mat { return canonicalGate(Math.PI / 4, Math.PI / 8, 0); }

/** A reproducible Haar-ish random SU(4) from a seed (for the "random gate" target). */
export function seededSU4(seed: number): Mat {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const randSU2 = (): Mat => {
    const a = rnd() * 2 * Math.PI, b = Math.acos(2 * rnd() - 1), g = rnd() * 2 * Math.PI;
    return matMul(matMul(Rz(a), Ry(b)), Rz(g));
  };
  const cx = rnd() * (Math.PI / 4), cy = rnd() * cx, cz = (rnd() - 0.5) * 2 * cy;
  const A = canonicalGate(cx, cy, cz);
  return matMul(matMul(tensorProduct(randSU2(), randSU2()), A), tensorProduct(randSU2(), randSU2()));
}

export const NAMED_GATES: NamedGate[] = [
  { id: 'cnot', label: 'CNOT', desc: 'The textbook entangler — 1 CNOT.', optimalCnots: 1, make: () => CNOT },
  { id: 'cz', label: 'CZ', desc: 'Controlled-Z — locally equivalent to CNOT (1 CNOT).', optimalCnots: 1, make: () => CZ },
  { id: 'iswap', label: 'iSWAP', desc: 'Swaps with a phase — needs 2 CNOTs.', optimalCnots: 2, make: () => ISWAP },
  { id: 'sqrtiswap', label: '√iSWAP', desc: 'Hardware-native superconducting entangler — 2 CNOTs.', optimalCnots: 2, make: () => sqrtISwap() },
  { id: 'sqrtswap', label: '√SWAP', desc: 'Square root of SWAP — interior of the chamber, 3 CNOTs.', optimalCnots: 3, make: () => sqrtSwap() },
  { id: 'b', label: 'B gate', desc: 'exp(i(π/4 XX + π/8 YY)) — the Berkeley B gate, 2 CNOTs.', optimalCnots: 2, make: () => bGate() },
  { id: 'swap', label: 'SWAP', desc: 'The full swap — the worst case, 3 CNOTs.', optimalCnots: 3, make: () => SWAP },
  { id: 'random', label: 'Random SU(4)', desc: 'A pseudo-random two-qubit gate — generic, 3 CNOTs.', optimalCnots: 3, make: () => seededSU4(0x2026_06_22 & 0xffffffff) },
];

export { CNOT, CZ, SWAP, ISWAP };
