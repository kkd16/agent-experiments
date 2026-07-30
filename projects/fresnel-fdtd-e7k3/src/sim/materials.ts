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
    key: 'absorber',
    label: 'Absorber',
    swatch: '#7a5a3a',
    material: { epsR: 1, loss: 0.28, pec: false },
  },
];

export const MATERIAL_BY_KEY: Record<string, BrushMaterial> = Object.fromEntries(
  BRUSH_MATERIALS.map((m) => [m.key, m]),
);
