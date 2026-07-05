/**
 * The molecule library: small closed-shell systems the s-only STO-3G engine handles exactly.
 * Each entry is *parametrised by geometry* (a bond length or ring size) so the lab can trace a
 * full potential-energy surface — the dissociation curve — not just one point.
 */

import { type Atom } from './integrals';

/** Bohr radius in Å, for display. */
export const BOHR_TO_ANGSTROM = 0.52917721067;

export interface Molecule {
  id: string;
  name: string;
  formula: string;
  /** One-line physical significance. */
  blurb: string;
  nElectrons: number;
  /** Number of qubits (= 2 × number of atoms, since one 1s orbital per atom). */
  nQubits: number;
  /** Geometry from a single scalar parameter (bond length / ring "radius", in bohr). */
  geometry: (param: number) => Atom[];
  /** Default parameter (near equilibrium), in bohr. */
  defaultParam: number;
  /** Sweep range for the dissociation curve, in bohr. */
  range: [number, number];
  /** Label for the parameter axis. */
  paramLabel: string;
  /** Whether to run FCI/VQE (kept to ≤6 qubits so diagonalisation stays interactive). */
  correlated: boolean;
  /** A verified reference fact shown in the UI. */
  reference: string;
}

const H2: Molecule = {
  id: 'h2',
  name: 'Dihydrogen',
  formula: 'H₂',
  blurb: 'The hydrogen molecule — the "hydrogen atom" of quantum chemistry and the canonical VQE demo.',
  nElectrons: 2,
  nQubits: 4,
  geometry: (r) => [{ el: 'H', pos: [0, 0, 0] }, { el: 'H', pos: [0, 0, r] }],
  defaultParam: 1.398,
  range: [0.6, 6.0],
  paramLabel: 'bond length',
  correlated: true,
  reference: 'STO-3G: RHF −1.1167 Eₕ, FCI −1.1373 Eₕ at R≈1.40 a₀; equilibrium ≈0.74 Å.',
};

const HeHp: Molecule = {
  id: 'hehp',
  name: 'Helium hydride cation',
  formula: 'HeH⁺',
  blurb: 'The first molecule to form in the universe — a heteronuclear two-electron ion.',
  nElectrons: 2,
  nQubits: 4,
  geometry: (r) => [{ el: 'He', pos: [0, 0, 0] }, { el: 'H', pos: [0, 0, r] }],
  defaultParam: 1.75,
  range: [1.0, 6.0],
  paramLabel: 'He–H distance',
  correlated: true,
  reference: 'A polar two-electron ion; STO-3G equilibrium near R≈1.75 a₀.',
};

const H3p: Molecule = {
  id: 'h3p',
  name: 'Trihydrogen cation',
  formula: 'H₃⁺',
  blurb: 'The most abundant ion in the interstellar medium — an equilateral triangle of protons sharing two electrons.',
  nElectrons: 2,
  nQubits: 6,
  geometry: (r) => {
    const h = r / Math.sqrt(3);
    return [
      { el: 'H', pos: [0, h, 0] },
      { el: 'H', pos: [-r / 2, -h / 2, 0] },
      { el: 'H', pos: [r / 2, -h / 2, 0] },
    ];
  },
  defaultParam: 1.65,
  range: [1.0, 4.5],
  paramLabel: 'triangle side',
  correlated: true,
  reference: 'D₃ₕ symmetry gives a degenerate e′ orbital pair; equilibrium side ≈1.65 a₀.',
};

const He: Molecule = {
  id: 'he',
  name: 'Helium atom',
  formula: 'He',
  blurb: 'A single closed-shell atom — a one-orbital sanity check where HF and FCI coincide.',
  nElectrons: 2,
  nQubits: 2,
  geometry: () => [{ el: 'He', pos: [0, 0, 0] }],
  defaultParam: 0,
  range: [0, 0],
  paramLabel: '(atom)',
  correlated: true,
  reference: 'STO-3G RHF −2.8077 Eₕ; a minimal basis has no correlation, so FCI = HF.',
};

const H4: Molecule = {
  id: 'h4',
  name: 'Hydrogen chain (H₄)',
  formula: 'H₄',
  blurb: 'A linear four-atom chain — a strongly-correlated toy lattice used to benchmark quantum algorithms.',
  nElectrons: 4,
  nQubits: 8,
  geometry: (r) => [0, 1, 2, 3].map((i) => ({ el: 'H' as const, pos: [0, 0, i * r] as [number, number, number] })),
  defaultParam: 1.8,
  range: [1.0, 4.0],
  paramLabel: 'H–H spacing',
  correlated: false, // 8 qubits — HF curve only (FCI/VQE too large to sweep interactively)
  reference: 'Equally-spaced chain; a standard strong-correlation benchmark. HF shown here.',
};

export const MOLECULES: Molecule[] = [H2, HeHp, H3p, He, H4];

export function getMolecule(id: string): Molecule {
  return MOLECULES.find((m) => m.id === id) ?? H2;
}
