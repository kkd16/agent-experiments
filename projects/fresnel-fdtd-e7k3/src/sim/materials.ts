import type { Material } from './FDTD';

/** A brush option shown in the material palette. `n` is the optical index. */
export interface BrushMaterial {
  key: string;
  label: string;
  swatch: string;
  material: Material;
  /** refractive index for display (sqrt(epsR)); PEC/absorber may omit */
  n?: number;
}

// n = sqrt(epsR); epsR = n^2
export const BRUSH_MATERIALS: BrushMaterial[] = [
  {
    key: 'vacuum',
    label: 'Vacuum',
    swatch: '#0e1420',
    material: { epsR: 1, loss: 0, pec: false },
    n: 1,
  },
  {
    key: 'water',
    label: 'Water · n1.33',
    swatch: '#1b4a6b',
    material: { epsR: 1.77, loss: 0, pec: false },
    n: 1.33,
  },
  {
    key: 'glass',
    label: 'Glass · n1.5',
    swatch: '#2f6fa8',
    material: { epsR: 2.25, loss: 0, pec: false },
    n: 1.5,
  },
  {
    key: 'flint',
    label: 'Flint · n1.8',
    swatch: '#4a86c4',
    material: { epsR: 3.24, loss: 0, pec: false },
    n: 1.8,
  },
  {
    key: 'diamond',
    label: 'Diamond · n2.4',
    swatch: '#7db4e6',
    material: { epsR: 5.76, loss: 0, pec: false },
    n: 2.4,
  },
  {
    key: 'metal',
    label: 'Metal (PEC)',
    swatch: '#9fa3ab',
    material: { epsR: 1, loss: 0, pec: true },
  },
  {
    key: 'gold',
    label: 'Gold · Drude',
    swatch: '#d7a94b',
    // Real dispersive metal: ε(ω)=1−ωp²/(ω²+iγω). Plasma λ≈13 cells; below it the
    // metal reflects, near ε≈−1 it carries surface plasmons.
    material: { epsR: 1, loss: 0, pec: false, disp: { kind: 'drude', wp: (2 * Math.PI) / 13, gamma: ((2 * Math.PI) / 13) * 0.03 }, dispId: 1 },
  },
  {
    key: 'silver',
    label: 'Silver · Drude',
    swatch: '#cdd6e0',
    // Lower loss, higher plasma frequency than gold — sharper plasmonics.
    material: { epsR: 1, loss: 0, pec: false, disp: { kind: 'drude', wp: (2 * Math.PI) / 11, gamma: ((2 * Math.PI) / 11) * 0.014 }, dispId: 2 },
  },
  {
    key: 'resonant',
    label: 'Resonator · Lorentz',
    swatch: '#b06ec8',
    // A Lorentz oscillator: strong anomalous dispersion & absorption near its
    // resonance at λ≈16 cells (ε(ω)=ε∞+Δε·ω0²/(ω0²−ω²+iγω)).
    material: { epsR: 1.4, loss: 0, pec: false, disp: { kind: 'lorentz', w0: (2 * Math.PI) / 16, gamma: ((2 * Math.PI) / 16) * 0.06, wp: 0, deltaEps: 3 }, dispId: 3 },
  },
  {
    key: 'absorber',
    label: 'Absorber',
    swatch: '#7a5a3a',
    material: { epsR: 1, loss: 0.28, pec: false },
  },
];

export const MATERIAL_BY_KEY: Record<string, BrushMaterial> = Object.fromEntries(
  BRUSH_MATERIALS.map((m) => [m.key, m]),
);

/** True for the frequency-dispersive (Drude/Lorentz) brushes. */
export function isDispersiveBrush(key: string): boolean {
  return !!MATERIAL_BY_KEY[key]?.material.disp;
}
