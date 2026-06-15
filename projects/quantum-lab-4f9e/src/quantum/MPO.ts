import { Complex, C } from './Complex';
import { hermitianEig } from './Hermitian';

/**
 * Matrix Product Operator (MPO) — the operator analogue of a Matrix Product State.
 *
 * A many-body Hamiltonian on a 1-D chain is written as a contracted chain of rank-4
 * tensors, one per site:
 *
 *     H = Σ  W⁰[b₀,b₁] W¹[b₁,b₂] ⋯ Wⁿ⁻¹[bₙ₋₁,bₙ] · (operators on each physical leg)
 *
 * where each Wˢ is a (wₗ × wᵣ × 2 × 2) tensor: two "virtual" bond legs of dimension w (the
 * MPO bond dimension) carrying a tiny finite-state machine, and two physical legs (output
 * bra index, input ket index) holding a 2×2 single-site operator. The boundary bonds are
 * dimension 1. This is the exact, *compressed* representation of a local Hamiltonian that
 * DMRG and TEBD consume — for nearest-neighbour models the bond dimension is a small
 * constant (3 for the transverse-field Ising chain, 5 for Heisenberg/XXZ), independent of
 * the chain length, so an n-site Hamiltonian costs O(n) numbers instead of 4ⁿ.
 *
 * Built from scratch with the app's complex arithmetic — the same little-endian site
 * convention as the state-vector and MPS engines (qubit q ↔ bit q, physical index 0 = |0⟩),
 * so a dense expansion of any MPO here lines up byte-for-byte with `QuantumState` for the
 * exact cross-checks the DMRG solver is graded against.
 */

/** One site tensor. Flat re/im, index(bl,br,pout,pin) = ((bl*wr + br)*2 + pout)*2 + pin. */
export interface MPOSite {
  wl: number;
  wr: number;
  re: Float64Array;
  im: Float64Array;
}

export type MPO = MPOSite[];

// --- single-site operator matrices (2×2), as [re,im] pairs indexed [pout*2+pin] ----------
const I2 = { re: [1, 0, 0, 1], im: [0, 0, 0, 0] };
const X2 = { re: [0, 1, 1, 0], im: [0, 0, 0, 0] };
const Y2 = { re: [0, 0, 0, 0], im: [0, -1, 1, 0] }; // [[0,-i],[i,0]]
const Z2 = { re: [1, 0, 0, -1], im: [0, 0, 0, 0] };

type Op2 = { re: number[]; im: number[] };

/** A scaled single-site operator placed at MPO bond entry (bl,br). */
interface Entry { bl: number; br: number; op: Op2; coeff: number; }

function buildSite(wl: number, wr: number, entries: Entry[]): MPOSite {
  const re = new Float64Array(wl * wr * 4);
  const im = new Float64Array(wl * wr * 4);
  for (const { bl, br, op, coeff } of entries) {
    for (let pout = 0; pout < 2; pout++) {
      for (let pin = 0; pin < 2; pin++) {
        const k = pout * 2 + pin;
        const idx = ((bl * wr + br) * 2 + pout) * 2 + pin;
        re[idx] += coeff * op.re[k];
        im[idx] += coeff * op.im[k];
      }
    }
  }
  return { wl, wr, re, im };
}

/**
 * Assemble an OBC MPO from a single bulk operator-valued matrix `W[bl][br] = (op, coeff)`
 * with the standard lower-triangular finite-state-machine convention: the left boundary
 * vector selects the *last* row (the "start" state) and the right boundary the *first*
 * column (the "done" state). The first and last sites collapse those boundary bonds to 1.
 */
function fromBulk(n: number, dw: number, cells: { bl: number; br: number; op: Op2; coeff: number }[]): MPO {
  const startRow = dw - 1, doneCol = 0;
  const bulk = buildSite(dw, dw, cells);
  const sites: MPO = [];
  for (let s = 0; s < n; s++) {
    if (n === 1) {
      // single site: only the on-site terms survive (start row → done col)
      const ents = cells.filter((c) => c.bl === startRow && c.br === doneCol)
        .map((c) => ({ bl: 0, br: 0, op: c.op, coeff: c.coeff }));
      sites.push(buildSite(1, 1, ents));
    } else if (s === 0) {
      const ents = cells.filter((c) => c.bl === startRow).map((c) => ({ bl: 0, br: c.br, op: c.op, coeff: c.coeff }));
      sites.push(buildSite(1, dw, ents));
    } else if (s === n - 1) {
      const ents = cells.filter((c) => c.br === doneCol).map((c) => ({ bl: c.bl, br: 0, op: c.op, coeff: c.coeff }));
      sites.push(buildSite(dw, 1, ents));
    } else {
      sites.push({ wl: bulk.wl, wr: bulk.wr, re: bulk.re.slice(), im: bulk.im.slice() });
    }
  }
  return sites;
}

export type ModelKind = 'tfim' | 'heisenberg';

export interface ModelParams {
  kind: ModelKind;
  n: number;
  /** TFIM: coupling J in −J Σ ZᵢZᵢ₊₁. Heisenberg: ignored (use jxy/jz). */
  J?: number;
  /** TFIM transverse field h in −h Σ Xᵢ. */
  h?: number;
  /** Heisenberg in-plane coupling Jxy in Σ Jxy(XᵢXᵢ₊₁+YᵢYᵢ₊₁). */
  jxy?: number;
  /** Heisenberg axial coupling Jz in Σ Jz ZᵢZᵢ₊₁ (Jxy=Jz ⇒ isotropic; >0 antiferromagnet). */
  jz?: number;
  /** Optional longitudinal field hz in Σ hz Zᵢ. */
  hz?: number;
}

/**
 * Transverse-field Ising MPO for H = −J Σ ZᵢZᵢ₊₁ − h Σ Xᵢ (− hz Σ Zᵢ), bond dimension 3.
 *
 *     W = | I      0     0 |
 *         | Z      0     0 |
 *         | −hX−hzZ −JZ  I |
 */
export function tfimMPO(n: number, J = 1, h = 1, hz = 0): MPO {
  const cells = [
    { bl: 0, br: 0, op: I2, coeff: 1 },
    { bl: 1, br: 0, op: Z2, coeff: 1 },
    { bl: 2, br: 0, op: X2, coeff: -h },
    { bl: 2, br: 1, op: Z2, coeff: -J },
    { bl: 2, br: 2, op: I2, coeff: 1 },
  ];
  if (hz !== 0) cells.push({ bl: 2, br: 0, op: Z2, coeff: -hz });
  return fromBulk(n, 3, cells);
}

/**
 * Heisenberg / XXZ MPO for H = Σ Jxy(XᵢXᵢ₊₁ + YᵢYᵢ₊₁) + Jz ZᵢZᵢ₊₁ (+ hz Σ Zᵢ), bond
 * dimension 5. With Jxy = Jz > 0 this is the isotropic antiferromagnet.
 *
 *     W = | I    0      0      0     0 |
 *         | X    0      0      0     0 |
 *         | Y    0      0      0     0 |
 *         | Z    0      0      0     0 |
 *         | hzZ  JxyX   JxyY   JzZ   I |
 */
export function heisenbergMPO(n: number, jxy = 1, jz = 1, hz = 0): MPO {
  const cells = [
    { bl: 0, br: 0, op: I2, coeff: 1 },
    { bl: 1, br: 0, op: X2, coeff: 1 },
    { bl: 2, br: 0, op: Y2, coeff: 1 },
    { bl: 3, br: 0, op: Z2, coeff: 1 },
    { bl: 4, br: 1, op: X2, coeff: jxy },
    { bl: 4, br: 2, op: Y2, coeff: jxy },
    { bl: 4, br: 3, op: Z2, coeff: jz },
    { bl: 4, br: 4, op: I2, coeff: 1 },
  ];
  if (hz !== 0) cells.push({ bl: 4, br: 0, op: Z2, coeff: hz });
  return fromBulk(n, 5, cells);
}

export function buildModelMPO(p: ModelParams): MPO {
  if (p.kind === 'tfim') return tfimMPO(p.n, p.J ?? 1, p.h ?? 1, p.hz ?? 0);
  return heisenbergMPO(p.n, p.jxy ?? 1, p.jz ?? 1, p.hz ?? 0);
}

/**
 * Expand the MPO into the dense 2ⁿ × 2ⁿ Hamiltonian matrix (small n only). The matrix
 * element ⟨row|H|col⟩ is the scalar product of the per-site bond matrices
 * Mˢ = Wˢ[:, :, rowbitₛ, colbitₛ] along the chain, with the dimension-1 boundaries closing
 * it. Built in the same little-endian basis (index = Σ bitₛ·2ˢ) as the state-vector engine,
 * so its eigenvalues are the exact reference the DMRG solver is checked against.
 */
export function mpoToDense(mpo: MPO): Complex[][] {
  const n = mpo.length;
  const size = 1 << n;
  const H: Complex[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => C(0)));
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      // product of bond matrices, start as the 1×1 boundary [1].
      let vr = [1], vi = [0]; // running row vector over the left bond
      for (let s = 0; s < n; s++) {
        const W = mpo[s];
        const pout = (row >> s) & 1, pin = (col >> s) & 1;
        const nr = new Array(W.wr).fill(0), ni = new Array(W.wr).fill(0);
        for (let br = 0; br < W.wr; br++) {
          let ar = 0, ai = 0;
          for (let bl = 0; bl < W.wl; bl++) {
            const idx = ((bl * W.wr + br) * 2 + pout) * 2 + pin;
            const wr2 = W.re[idx], wi2 = W.im[idx];
            ar += vr[bl] * wr2 - vi[bl] * wi2;
            ai += vr[bl] * wi2 + vi[bl] * wr2;
          }
          nr[br] = ar; ni[br] = ai;
        }
        vr = nr; vi = ni;
      }
      H[row][col] = new Complex(vr[0], vi[0]);
    }
  }
  return H;
}

/** Exact ground-state energy of an MPO by dense diagonalisation (small n only). */
export function exactGroundEnergyMPO(mpo: MPO): number {
  const vals = hermitianEig(mpoToDense(mpo)).values;
  return vals[vals.length - 1]; // smallest (hermitianEig sorts descending)
}
