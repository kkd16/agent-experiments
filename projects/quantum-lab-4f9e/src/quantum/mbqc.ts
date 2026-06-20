// Measurement-Based Quantum Computation — the one-way quantum computer, from scratch.
//
// A radically different model of computation from the circuit model: instead of
// applying unitary gates, you prepare a large, fixed, highly-entangled CLUSTER STATE
// and then compute *purely by measuring its qubits one at a time*, in adaptively
// chosen single-qubit bases. The entanglement is the resource; measurement (which is
// irreversible and random) drives the computation forward, and the randomness is
// tamed by feeding earlier outcomes forward into later measurement angles and a final
// Pauli "byproduct" correction. Remarkably, this measure-only model is *universal*.
//
// This module implements the formalism faithfully and entirely from scratch:
//
//   • a dynamic complex state-vector micro-engine (Float64Array re/im) that prepares
//     |+⟩ qubits, entangles with CZ, and projectively measures in the X–Y plane —
//     freeing each measured qubit, so the live register stays as small as the number
//     of logical wires no matter how deep the computation (the MBQC memory advantage);
//   • the measurement calculus (Danos–Kashefi–Panangaden): patterns over the commands
//     N (prepare), E (entangle), M (measure with X/Z signal dependencies) and the
//     X/Z corrections, run with adaptive angles φ = (−1)^{sX}·α + sZ·π;
//   • a universal {J(α), CZ} compiler that emits a measurement pattern for any
//     single-qubit unitary (via its Euler decomposition) and for CZ/CNOT, propagating
//     the byproduct operators symbolically so the pattern is *deterministic up to a
//     known, correctable Pauli frame*;
//   • graph/cluster states with their stabilizer generators K_v = X_v ∏_{w∼v} Z_w.
//
// Everything is cross-checked, in the project's tradition, against an INDEPENDENT
// dense circuit-model oracle (small Kronecker matrices, sharing no code with the
// cluster engine): the corrected MBQC output equals the gate-model output to machine
// precision, for every measurement outcome (the determinism that makes MBQC work).

// ───────────────────────────── seeded RNG ─────────────────────────────

/** mulberry32 — a small, fast, seedable PRNG so every run reproduces from a seed. */
export function mbqcRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────── dynamic state vector ─────────────────────────────

// A complex amplitude vector over a *dynamic* set of qubits, addressed by integer id.
// Qubits can be appended (in |+⟩) and removed (when measured), so the dimension is
// 2^(live qubits) — which, run interleaved with measurement, never exceeds a couple
// more than the number of logical wires.
export class CState {
  ids: number[]; // qubit ids, position k ⇒ bit k (least-significant first)
  re: Float64Array;
  im: Float64Array;

  constructor(ids: number[], re: Float64Array, im: Float64Array) {
    this.ids = ids;
    this.re = re;
    this.im = im;
  }

  /** A register of |+⟩^{⊗n} over the given ids (the cluster-state seed). */
  static plus(ids: number[]): CState {
    const dim = 1 << ids.length;
    const a = 1 / Math.sqrt(dim);
    const re = new Float64Array(dim).fill(a);
    return new CState(ids.slice(), re, new Float64Array(dim));
  }

  /** A register whose qubit `ids` carry an explicit amplitude table (an input state). */
  static fromAmplitudes(ids: number[], amps: { re: number; im: number }[]): CState {
    const dim = 1 << ids.length;
    const re = new Float64Array(dim);
    const im = new Float64Array(dim);
    for (let i = 0; i < dim; i++) { re[i] = amps[i].re; im[i] = amps[i].im; }
    return new CState(ids.slice(), re, im);
  }

  private pos(id: number): number {
    const p = this.ids.indexOf(id);
    if (p < 0) throw new Error(`qubit ${id} is not live`);
    return p;
  }

  /** Append a fresh qubit in |+⟩ = (|0⟩+|1⟩)/√2 (doubles the dimension). */
  addPlus(id: number): void {
    const oldDim = this.re.length;
    const re = new Float64Array(oldDim * 2);
    const im = new Float64Array(oldDim * 2);
    const a = 1 / Math.sqrt(2);
    for (let i = 0; i < oldDim; i++) {
      re[i] = this.re[i] * a; im[i] = this.im[i] * a;
      re[i + oldDim] = this.re[i] * a; im[i + oldDim] = this.im[i] * a;
    }
    this.ids.push(id);
    this.re = re; this.im = im;
  }

  /** Controlled-Z between two live qubits (phase −1 on |…1…1…⟩). */
  cz(idA: number, idB: number): void {
    const ma = 1 << this.pos(idA), mb = 1 << this.pos(idB);
    for (let i = 0; i < this.re.length; i++) {
      if ((i & ma) && (i & mb)) { this.re[i] = -this.re[i]; this.im[i] = -this.im[i]; }
    }
  }

  /** Pauli X on a live qubit (bit flip). */
  x(id: number): void {
    const m = 1 << this.pos(id);
    for (let i = 0; i < this.re.length; i++) {
      if (i & m) continue;
      const j = i | m;
      const tr = this.re[i], ti = this.im[i];
      this.re[i] = this.re[j]; this.im[i] = this.im[j];
      this.re[j] = tr; this.im[j] = ti;
    }
  }

  /** Pauli Z on a live qubit (phase on |1⟩). */
  z(id: number): void {
    const m = 1 << this.pos(id);
    for (let i = 0; i < this.re.length; i++) {
      if (i & m) { this.re[i] = -this.re[i]; this.im[i] = -this.im[i]; }
    }
  }

  /** Probability of outcome 0 (the |+_φ⟩ branch) when measuring qubit `id` in the
   *  X–Y-plane basis {|+_φ⟩, |−_φ⟩}, |±_φ⟩ = (|0⟩ ± e^{iφ}|1⟩)/√2. */
  probZero(id: number, phi: number): number {
    const m = 1 << this.pos(id);
    const cr = Math.cos(phi), ci = -Math.sin(phi); // e^{-iφ}
    let p = 0;
    for (let i = 0; i < this.re.length; i++) {
      if (i & m) continue;
      const j = i | m;
      // ⟨+_φ| amplitude on the rest basis state: (a0 + e^{-iφ} a1)/√2
      const r = this.re[i] + (cr * this.re[j] - ci * this.im[j]);
      const im = this.im[i] + (cr * this.im[j] + ci * this.re[j]);
      p += (r * r + im * im) * 0.5;
    }
    return p;
  }

  /** Measure qubit `id` at plane-angle φ, sample the outcome with `rng`, project,
   *  renormalise, and *remove* the qubit (halving the dimension). Returns the
   *  outcome (0 ⇒ |+_φ⟩, 1 ⇒ |−_φ⟩). */
  measure(id: number, phi: number, rng: () => number): 0 | 1 {
    const p = this.pos(id);
    const m = 1 << p;
    const p0 = this.probZero(id, phi);
    let outcome: 0 | 1 = rng() < p0 ? 0 : 1;
    // Guard against sampling a near-zero-probability branch (deterministic measurement).
    const norm = outcome === 0 ? p0 : 1 - p0;
    if (norm < 1e-12) outcome = outcome === 0 ? 1 : 0;
    const sign = outcome === 0 ? 1 : -1;
    const cr = Math.cos(phi) * sign, ci = -Math.sin(phi) * sign; // ± e^{-iφ}
    const newDim = this.re.length >> 1;
    const re = new Float64Array(newDim);
    const im = new Float64Array(newDim);
    // Map full index → reduced index by dropping bit p.
    const low = m - 1; // bits below p
    for (let i = 0; i < this.re.length; i++) {
      if (i & m) continue;
      const j = i | m;
      const rest = (i & low) | ((i >> 1) & ~low);
      re[rest] = this.re[i] + (cr * this.re[j] - ci * this.im[j]);
      im[rest] = this.im[i] + (cr * this.im[j] + ci * this.re[j]);
    }
    // Normalise: the bra carried a 1/√2 and the branch had probability `norm`.
    const scale = 1 / Math.sqrt(2 * (outcome === 0 ? p0 : 1 - p0));
    for (let i = 0; i < newDim; i++) { re[i] *= scale; im[i] *= scale; }
    this.ids.splice(p, 1);
    this.re = re; this.im = im;
    return outcome;
  }

  /** Amplitudes reordered so the qubits appear in the order given by `order`
   *  (a subset/permutation of the live ids); the rest, if any, stay as higher bits. */
  amplitudes(order: number[]): { re: number; im: number }[] {
    const n = this.ids.length;
    const dim = 1 << n;
    // position in the *target* ordering for each live id
    const targetPos = new Map<number, number>();
    order.forEach((id, k) => targetPos.set(id, k));
    let next = order.length;
    const perm: number[] = this.ids.map((id) => targetPos.has(id) ? targetPos.get(id)! : next++);
    const out: { re: number; im: number }[] = Array.from({ length: dim }, () => ({ re: 0, im: 0 }));
    for (let i = 0; i < dim; i++) {
      let j = 0;
      for (let b = 0; b < n; b++) if (i & (1 << b)) j |= 1 << perm[b];
      out[j] = { re: this.re[i], im: this.im[i] };
    }
    return out;
  }
}

// ───────────────────────────── measurement-calculus patterns ─────────────────────────────

export type Role = 'input' | 'ancilla' | 'output';

export interface QubitNode {
  id: number;
  wire: number;   // logical wire this physical qubit belongs to (for layout)
  col: number;    // column in the cluster (for layout)
  role: Role;
}

// One physical command of a pattern, run left-to-right. Entanglement (E) is always
// emitted before the measurement of either endpoint, so the standard cluster-state
// "prepare graph, then measure" semantics holds while we interleave for efficiency.
export type Command =
  | { t: 'N'; q: number }
  | { t: 'E'; a: number; b: number }
  | { t: 'M'; q: number; base: number; sDeps: number[]; tDeps: number[] };

// A final Pauli correction on an output wire, conditioned on a set of outcomes (XOR).
export interface Correction { q: number; xDeps: number[]; zDeps: number[] }

// A logical gate, recorded in parallel so an *independent* dense oracle can replay it.
export type LogicalGate =
  | { kind: 'J'; wire: number; alpha: number }
  | { kind: 'CZ'; a: number; b: number };

export interface Pattern {
  commands: Command[];
  corrections: Correction[];
  nodes: QubitNode[];
  edges: [number, number][];
  inputs: number[];   // physical id of each wire's input qubit
  outputs: number[];  // physical id of each wire's output qubit, by wire
  logical: LogicalGate[];
  nWires: number;
}

// Builds a measurement pattern wire-by-wire from the universal primitives J(α) and
// CZ, propagating byproduct operators symbolically. Each wire tracks the physical
// qubit currently carrying it and the *signal sets* (lists of measured-qubit ids whose
// outcomes XOR to the pending X- and Z-byproduct exponents on that wire).
export class PatternBuilder {
  private commands: Command[] = [];
  private nodes: QubitNode[] = [];
  private edges: [number, number][] = [];
  private logical: LogicalGate[] = [];
  private nextId = 0;
  private cur: number[];      // current physical qubit per wire
  private xSig: number[][];   // X-byproduct signal set per wire
  private zSig: number[][];   // Z-byproduct signal set per wire
  private col: number[];      // layout column per wire
  private inputs: number[];

  constructor(nWires: number) {
    this.cur = [];
    this.xSig = [];
    this.zSig = [];
    this.col = [];
    for (let w = 0; w < nWires; w++) {
      const id = this.nextId++;
      this.cur.push(id);
      this.xSig.push([]);
      this.zSig.push([]);
      this.col.push(0);
      this.nodes.push({ id, wire: w, col: 0, role: 'input' });
    }
    this.inputs = this.cur.slice();
  }

  /** J(α) on a wire: append an output qubit in |+⟩, entangle, measure the old qubit at
   *  base angle −α with the wire's standing byproduct folded into the measurement's
   *  signal dependencies, and move the wire onto the new qubit with the freshly-derived
   *  byproduct (X = the new outcome, Z = the old X-byproduct). */
  applyJ(wire: number, alpha: number): void {
    const i = this.cur[wire];
    const out = this.nextId++;
    this.col[wire] += 1;
    this.nodes.push({ id: out, wire, col: this.col[wire], role: 'output' });
    this.commands.push({ t: 'N', q: out });
    this.commands.push({ t: 'E', a: i, b: out });
    this.edges.push([i, out]);
    // The standing byproduct X_i^{xSig} Z_i^{zSig}, pushed through E and into M_i:
    //   X on the measured qubit ⇒ flip the sign of the angle  (an sDep),
    //   Z on the measured qubit ⇒ shift the angle by π        (a tDep).
    this.commands.push({ t: 'M', q: i, base: -alpha, sDeps: this.xSig[wire].slice(), tDeps: this.zSig[wire].slice() });
    // The just-measured qubit becomes an interior ancilla.
    const node = this.nodes.find((n) => n.id === i)!;
    if (node.role !== 'input') node.role = 'ancilla';
    else node.role = 'ancilla'; // inputs that get measured are interior too
    // New byproduct on the output: X^{s_i} from the gadget, Z^{old xSig} from E·X_i·E.
    const newZ = this.xSig[wire].slice();
    this.cur[wire] = out;
    this.xSig[wire] = [i];
    this.zSig[wire] = newZ;
    this.logical.push({ kind: 'J', wire, alpha });
  }

  /** Logical CZ between two wires — natively an E on their current qubits. The
   *  standing byproducts update as E·X_a·E = X_a Z_b (and symmetrically). */
  applyCZ(wireA: number, wireB: number): void {
    const a = this.cur[wireA], b = this.cur[wireB];
    this.commands.push({ t: 'E', a, b });
    this.edges.push([a, b]);
    this.col[wireA] = this.col[wireB] = Math.max(this.col[wireA], this.col[wireB]);
    this.zSig[wireA] = xor(this.zSig[wireA], this.xSig[wireB]);
    this.zSig[wireB] = xor(this.zSig[wireB], this.xSig[wireA]);
    this.logical.push({ kind: 'CZ', a: wireA, b: wireB });
  }

  // ── named-gate dictionary, all in terms of J(α) (= H·P(α)) and CZ ──
  // J(0) = H exactly; P(α) = J(0)J(α) exactly ⇒ Z,S,T; Rz(α)=P(α) up to global phase;
  // Rx(α)=J(α)J(0) up to global phase; any U = J(0)J(γ)J(β)J(α) for its Euler angles.
  h(w: number) { this.applyJ(w, 0); }
  phase(w: number, theta: number) { this.applyJ(w, theta); this.applyJ(w, 0); }
  z(w: number) { this.phase(w, Math.PI); }
  s(w: number) { this.phase(w, Math.PI / 2); }
  t(w: number) { this.phase(w, Math.PI / 4); }
  rz(w: number, theta: number) { this.phase(w, theta); }
  rx(w: number, theta: number) { this.applyJ(w, 0); this.applyJ(w, theta); }
  /** Arbitrary single-qubit unitary from its ZXZ Euler angles: U ∝ Rz(γ)Rx(β)Rz(α). */
  u(w: number, alpha: number, beta: number, gamma: number) {
    this.applyJ(w, alpha); this.applyJ(w, beta); this.applyJ(w, gamma); this.applyJ(w, 0);
  }
  /** CNOT = (I⊗H)·CZ·(I⊗H) on (control, target). */
  cnot(control: number, target: number) {
    this.h(target); this.applyCZ(control, target); this.h(target);
  }

  build(): Pattern {
    const nWires = this.cur.length;
    const corrections: Correction[] = this.cur.map((q, w) => ({
      q, xDeps: this.xSig[w].slice(), zDeps: this.zSig[w].slice(),
    }));
    // Mark current carriers (and any never-measured inputs) as outputs.
    for (const n of this.nodes) if (this.cur.includes(n.id)) n.role = 'output';
    return {
      commands: this.commands, corrections, nodes: this.nodes, edges: this.edges,
      inputs: this.inputs, outputs: this.cur.slice(), logical: this.logical, nWires,
    };
  }
}

function xor(a: number[], b: number[]): number[] {
  const set = new Set(a);
  for (const x of b) { if (set.has(x)) set.delete(x); else set.add(x); }
  return [...set];
}

// ───────────────────────────── running a pattern ─────────────────────────────

export interface RunResult {
  outcomes: Map<number, 0 | 1>;
  angles: Map<number, number>; // adapted plane-angle actually measured, per qubit
  state: CState;               // the corrected logical state over the output wires
  outputs: number[];           // physical id per wire
}

/** Run a pattern on the given per-wire input amplitudes (length 2^nWires, wire 0 the
 *  least-significant bit) with seeded randomness, applying the adaptive measurements
 *  and the final byproduct corrections so the output is the deterministic logical state. */
export function runPattern(
  pat: Pattern,
  inputAmps: { re: number; im: number }[],
  rng: () => number,
): RunResult {
  // Load the input wires carrying the input state; ancillas are added on demand by N.
  const inputIds = pat.inputs;
  const st = CState.fromAmplitudes(inputIds, reorderInput(inputAmps, pat.nWires));
  const outcomes = new Map<number, 0 | 1>();
  const angles = new Map<number, number>();
  const signal = (deps: number[]) => deps.reduce((acc, q) => acc ^ (outcomes.get(q) ?? 0), 0);

  for (const cmd of pat.commands) {
    if (cmd.t === 'N') st.addPlus(cmd.q);
    else if (cmd.t === 'E') st.cz(cmd.a, cmd.b);
    else {
      const sX = signal(cmd.sDeps), sZ = signal(cmd.tDeps);
      const phi = (sX ? -cmd.base : cmd.base) + (sZ ? Math.PI : 0);
      angles.set(cmd.q, phi);
      outcomes.set(cmd.q, st.measure(cmd.q, phi, rng));
    }
  }
  for (const c of pat.corrections) {
    if (signal(c.xDeps)) st.x(c.q);
    if (signal(c.zDeps)) st.z(c.q);
  }
  return { outcomes, angles, state: st, outputs: pat.outputs };
}

// Input amps are indexed with wire w as bit w. The CState we seed lists ids in
// pat.inputs order (wire 0 first), which is the same bit convention — so identity here,
// but we keep the hook explicit for clarity.
function reorderInput(amps: { re: number; im: number }[], nWires: number): { re: number; im: number }[] {
  const dim = 1 << nWires;
  return Array.from({ length: dim }, (_, i) => amps[i] ?? { re: 0, im: 0 });
}

// ───────────────────────────── independent dense oracle ─────────────────────────────
//
// A tiny circuit-model simulator over the logical wires, used ONLY to grade the MBQC
// engine. It shares no code with the cluster runner: it builds each logical gate as a
// dense 2×2 (J) or diagonal 4×4 (CZ) and applies it to a 2^nWires amplitude vector.

type C2 = [number, number]; // [re, im]
const cmul = (a: C2, b: C2): C2 => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cadd = (a: C2, b: C2): C2 => [a[0] + b[0], a[1] + b[1]];

/** J(α) = (1/√2)[[1, e^{iα}], [1, −e^{iα}]] — the oracle's view of the primitive. */
export function jMatrix(alpha: number): [C2, C2, C2, C2] {
  const r = 1 / Math.sqrt(2);
  const e: C2 = [Math.cos(alpha) * r, Math.sin(alpha) * r];
  return [[r, 0], e, [r, 0], [-e[0], -e[1]]]; // row-major: [00,01,10,11]
}

/** Apply the logical-gate list to an input amplitude vector, densely and independently. */
export function oracleApply(
  logical: LogicalGate[],
  nWires: number,
  inputAmps: { re: number; im: number }[],
): { re: number; im: number }[] {
  const dim = 1 << nWires;
  let amp: C2[] = inputAmps.map((a) => [a.re, a.im] as C2);
  for (const g of logical) {
    if (g.kind === 'J') {
      const m = jMatrix(g.alpha);
      const bit = 1 << g.wire;
      const out: C2[] = amp.map((a) => [a[0], a[1]] as C2);
      for (let i = 0; i < dim; i++) {
        if (i & bit) continue;
        const j = i | bit;
        const a0 = amp[i], a1 = amp[j];
        out[i] = cadd(cmul(m[0], a0), cmul(m[1], a1));
        out[j] = cadd(cmul(m[2], a0), cmul(m[3], a1));
      }
      amp = out;
    } else {
      const ba = 1 << g.a, bb = 1 << g.b;
      for (let i = 0; i < dim; i++) if ((i & ba) && (i & bb)) { amp[i] = [-amp[i][0], -amp[i][1]]; }
    }
  }
  return amp.map((a) => ({ re: a[0], im: a[1] }));
}

// ───────────────────────────── comparison helpers ─────────────────────────────

/** |⟨a|b⟩| for two (sub-)normalised amplitude tables — 1 ⇔ equal up to global phase. */
export function fidelity(a: { re: number; im: number }[], b: { re: number; im: number }[]): number {
  let re = 0, im = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    re += a[i].re * b[i].re + a[i].im * b[i].im;
    im += a[i].re * b[i].im - a[i].im * b[i].re;
    na += a[i].re * a[i].re + a[i].im * a[i].im;
    nb += b[i].re * b[i].re + b[i].im * b[i].im;
  }
  const denom = Math.sqrt(na * nb);
  return denom < 1e-15 ? 0 : Math.sqrt(re * re + im * im) / denom;
}

/** A reproducible Haar-ish random single-qubit input state (just for grading). */
export function randomInput(nWires: number, rng: () => number): { re: number; im: number }[] {
  const dim = 1 << nWires;
  const amp = Array.from({ length: dim }, () => ({ re: rng() * 2 - 1, im: rng() * 2 - 1 }));
  let n = 0;
  for (const a of amp) n += a.re * a.re + a.im * a.im;
  const s = 1 / Math.sqrt(n);
  return amp.map((a) => ({ re: a.re * s, im: a.im * s }));
}

// ───────────────────────────── graph / cluster states ─────────────────────────────

export interface Graph { n: number; edges: [number, number][] }

/** The cluster state |G⟩ of a graph: |+⟩ on every node, then CZ on every edge. */
export function clusterState(g: Graph): CState {
  const st = CState.plus(Array.from({ length: g.n }, (_, i) => i));
  for (const [a, b] of g.edges) st.cz(a, b);
  return st;
}

/** The stabilizer generator K_v = X_v ∏_{w∼v} Z_w as a (sign, paulis[]) over n qubits. */
export function stabilizerGenerator(g: Graph, v: number): { sign: 1 | -1; paulis: ('I' | 'X' | 'Y' | 'Z')[] } {
  const paulis: ('I' | 'X' | 'Y' | 'Z')[] = Array.from({ length: g.n }, () => 'I');
  paulis[v] = 'X';
  for (const [a, b] of g.edges) {
    if (a === v) paulis[b] = 'Z';
    else if (b === v) paulis[a] = 'Z';
  }
  return { sign: 1, paulis };
}

/** Expectation ⟨ψ|P|ψ⟩ of a tensor-product Pauli string on a CState (real for Hermitian P). */
export function pauliExpectation(st: CState, paulis: ('I' | 'X' | 'Y' | 'Z')[]): number {
  // Apply P to a copy and take the inner product with the original.
  const re = st.re.slice(), im = st.im.slice();
  const work = new CState(st.ids.slice(), re, im);
  for (let q = 0; q < paulis.length; q++) {
    const p = paulis[q];
    if (p === 'I') continue;
    if (p === 'X') work.x(q);
    else if (p === 'Z') work.z(q);
    else { // Y = i·X·Z
      work.z(q); work.x(q);
      for (let i = 0; i < work.re.length; i++) { const r = work.re[i]; work.re[i] = -work.im[i]; work.im[i] = r; }
    }
  }
  let dot = 0;
  for (let i = 0; i < st.re.length; i++) dot += st.re[i] * work.re[i] + st.im[i] * work.im[i];
  return dot;
}

// ───────────────────────────── example patterns (for the lab) ─────────────────────────────

export type ExampleId = 'h' | 's' | 't' | 'rz' | 'rx' | 'u' | 'cnot' | 'circuit';

export interface ExampleSpec { id: ExampleId; label: string; desc: string; nWires: number }

export const EXAMPLES: ExampleSpec[] = [
  { id: 'h', label: 'Hadamard  H = J(0)', desc: 'One measurement teleports the input through a Hadamard — the elementary gadget.', nWires: 1 },
  { id: 's', label: 'Phase  S = J(0)J(π/2)', desc: 'Two measurements realise the S gate as P(π/2).', nWires: 1 },
  { id: 't', label: 'T  = J(0)J(π/4)', desc: 'The non-Clifford T gate — MBQC needs no special hardware for it, just a π/4 measurement angle.', nWires: 1 },
  { id: 'rz', label: 'Rotation  R_z(θ)', desc: 'A continuous Z-rotation: the measurement angle *is* the rotation angle.', nWires: 1 },
  { id: 'rx', label: 'Rotation  R_x(θ)', desc: 'A continuous X-rotation from two adaptive measurements (feed-forward on the first outcome).', nWires: 1 },
  { id: 'u', label: 'Arbitrary U (Euler)', desc: 'Any single-qubit unitary from a 4-qubit chain via its ZXZ Euler angles — fully feed-forward.', nWires: 1 },
  { id: 'cnot', label: 'CNOT = H·CZ·H', desc: 'A two-wire entangling gate: CZ is native to the cluster, sandwiched by Hadamards on the target.', nWires: 2 },
  { id: 'circuit', label: 'Bell circuit  H ; CNOT', desc: 'A small circuit — H then CNOT — compiled to one cluster and measured to make a Bell pair.', nWires: 2 },
];

/** Build the example pattern; `theta` parameterises the rotation examples. */
export function buildExample(id: ExampleId, theta = Math.PI / 3): Pattern {
  if (id === 'cnot') { const b = new PatternBuilder(2); b.cnot(0, 1); return b.build(); }
  if (id === 'circuit') { const b = new PatternBuilder(2); b.h(0); b.cnot(0, 1); return b.build(); }
  const b = new PatternBuilder(1);
  if (id === 'h') b.h(0);
  else if (id === 's') b.s(0);
  else if (id === 't') b.t(0);
  else if (id === 'rz') b.rz(0, theta);
  else if (id === 'rx') b.rx(0, theta);
  else b.u(0, theta, theta * 0.7 + 0.4, theta * 0.3 + 1.1);
  return b.build();
}
