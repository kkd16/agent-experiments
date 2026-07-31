/**
 * Physics preset scenes. Each preset fully configures a fresh FDTD instance:
 * clears materials & sources, resets the fields, paints optical elements, and
 * places sources/probes. Geometry is expressed in fractions of the grid so a
 * preset works at any resolution.
 */

import type { FDTD, Material } from './FDTD';
import { MATERIAL_BY_KEY } from './materials';

const PEC: Material = { epsR: 1, loss: 0, pec: true };
const GLASS: Material = { epsR: 2.25, loss: 0, pec: false };
const DENSE: Material = { epsR: 4, loss: 0, pec: false };
const GOLD = MATERIAL_BY_KEY['gold'].material;
const SILVER = MATERIAL_BY_KEY['silver'].material;

export interface Preset {
  key: string;
  label: string;
  blurb: string;
  build: (f: FDTD) => void;
}

/** Paint a filled convex lens = intersection of two discs of radius R. */
function paintLens(
  f: FDTD,
  cx: number,
  cy: number,
  halfHeight: number,
  thickness: number,
  mat: Material,
): void {
  // Two circles of radius R offset horizontally by d so their overlap forms a
  // symmetric biconvex lens of the requested half-height and center thickness.
  const R = (halfHeight * halfHeight + (thickness / 2) * (thickness / 2)) / thickness;
  const dxOff = R - thickness / 2;
  for (let y = Math.floor(cy - halfHeight); y <= Math.ceil(cy + halfHeight); y++) {
    for (let x = Math.floor(cx - thickness); x <= Math.ceil(cx + thickness); x++) {
      if (x < 0 || y < 0 || x >= f.nx || y >= f.ny) continue;
      const inLeft = (x - (cx - dxOff)) ** 2 + (y - cy) ** 2 <= R * R;
      const inRight = (x - (cx + dxOff)) ** 2 + (y - cy) ** 2 <= R * R;
      if (inLeft && inRight) {
        const i = f.idx(x, y);
        f.epsR[i] = mat.epsR;
        f.pec[i] = mat.pec ? 1 : 0;
        f.loss[i] = Math.max(f.loss[i], mat.loss);
      }
    }
  }
}

function planeSource(f: FDTD, xFrac: number, wavelength: number, amplitude = 0.42) {
  const T = 24;
  f.addSource({
    x: Math.round(f.nx * xFrac),
    y: Math.round(f.ny / 2),
    kind: 'sine',
    wavelength,
    amplitude,
    halfLen: Math.round(f.ny / 2 - T),
  });
}

function markDirty(f: FDTD) {
  // Touch a no-op paint to flag coefficient rebuild (materials mutated directly).
  f.paintDisc(-100, -100, 0, PEC);
}

export const PRESETS: Preset[] = [
  {
    key: 'empty',
    label: 'Free space',
    blurb: 'A single point source radiating circular waves into open space.',
    build: (f) => {
      f.addSource({
        x: Math.round(f.nx * 0.5),
        y: Math.round(f.ny * 0.5),
        kind: 'sine',
        wavelength: 16,
        amplitude: 1.0,
      });
    },
  },
  {
    key: 'doubleslit',
    label: 'Double slit',
    blurb: "Young's experiment: a plane wave through two slits builds an interference fan.",
    build: (f) => {
      const bx = Math.round(f.nx * 0.42);
      const gap = Math.round(f.ny * 0.10);
      const slit = Math.max(3, Math.round(f.ny * 0.03));
      const cy = Math.round(f.ny / 2);
      // full-height PEC barrier
      f.paintRect(bx - 2, 24, bx + 2, f.ny - 24, PEC);
      // carve two slits back to vacuum
      f.paintRect(bx - 2, cy - gap - slit, bx + 2, cy - gap + slit, { epsR: 1, loss: 0, pec: false });
      f.paintRect(bx - 2, cy + gap - slit, bx + 2, cy + gap + slit, { epsR: 1, loss: 0, pec: false });
      planeSource(f, 0.14, 12, 0.5);
      f.addProbe(Math.round(f.nx * 0.85), cy);
    },
  },
  {
    key: 'lens',
    label: 'Convex lens',
    blurb: 'A biconvex glass lens gathers a plane wave toward a focal point.',
    build: (f) => {
      paintLens(f, Math.round(f.nx * 0.5), Math.round(f.ny / 2), Math.round(f.ny * 0.34), Math.round(f.nx * 0.09), GLASS);
      markDirty(f);
      planeSource(f, 0.12, 12, 0.45);
      f.addProbe(Math.round(f.nx * 0.8), Math.round(f.ny / 2));
    },
  },
  {
    key: 'prism',
    label: 'Prism',
    blurb: 'A dense glass wedge refracts a beam, bending it toward the base.',
    build: (f) => {
      // Right triangle prism
      const x0 = Math.round(f.nx * 0.42);
      const x1 = Math.round(f.nx * 0.62);
      const yTop = Math.round(f.ny * 0.22);
      const yBot = Math.round(f.ny * 0.78);
      for (let y = yTop; y <= yBot; y++) {
        const frac = (y - yTop) / (yBot - yTop);
        const xr = Math.round(x0 + (x1 - x0) * frac);
        f.paintRect(x0, y, xr, y, DENSE);
      }
      markDirty(f);
      // narrow horizontal beam from the left
      f.addSource({
        x: Math.round(f.nx * 0.12),
        y: Math.round(f.ny * 0.4),
        kind: 'sine',
        wavelength: 12,
        amplitude: 0.9,
        halfLen: Math.round(f.ny * 0.06),
      });
    },
  },
  {
    key: 'waveguide',
    label: 'Waveguide',
    blurb: 'A high-index slab traps light by total internal reflection and guides it.',
    build: (f) => {
      const cy = Math.round(f.ny / 2);
      const half = Math.max(4, Math.round(f.ny * 0.05));
      f.paintRect(Math.round(f.nx * 0.1), cy - half, Math.round(f.nx * 0.9), cy + half, DENSE);
      markDirty(f);
      f.addSource({
        x: Math.round(f.nx * 0.16),
        y: cy,
        kind: 'sine',
        wavelength: 11,
        amplitude: 0.9,
        halfLen: half - 1,
      });
      f.addProbe(Math.round(f.nx * 0.85), cy);
    },
  },
  {
    key: 'cavity',
    label: 'Fabry–Pérot',
    blurb: 'Two partial metal mirrors trap a standing wave in a resonant cavity.',
    build: (f) => {
      const x0 = Math.round(f.nx * 0.35);
      const x1 = Math.round(f.nx * 0.65);
      const top = Math.round(f.ny * 0.3);
      const bot = Math.round(f.ny * 0.7);
      // mirrors with small coupling gaps
      f.paintRect(x0, top, x0 + 1, bot, PEC);
      f.paintRect(x1, top, x1 + 1, bot, PEC);
      const cy = Math.round(f.ny / 2);
      f.paintRect(x0, cy - 3, x0 + 1, cy + 3, { epsR: 1, loss: 0, pec: false });
      f.paintRect(x1, cy - 3, x1 + 1, cy + 3, { epsR: 1, loss: 0, pec: false });
      markDirty(f);
      f.addSource({
        x: Math.round((x0 + x1) / 2),
        y: cy,
        kind: 'sine',
        wavelength: 15,
        amplitude: 0.5,
      });
      f.addProbe(Math.round((x0 + x1) / 2), cy);
    },
  },
  {
    key: 'crystal',
    label: 'Photonic crystal',
    blurb: 'A square lattice of dielectric rods scatters and partially reflects the wave.',
    build: (f) => {
      const spacing = Math.round(f.ny * 0.08);
      const r = Math.max(2, Math.round(spacing * 0.28));
      const x0 = Math.round(f.nx * 0.45);
      const x1 = Math.round(f.nx * 0.75);
      const y0 = Math.round(f.ny * 0.2);
      const y1 = Math.round(f.ny * 0.8);
      for (let x = x0; x <= x1; x += spacing) {
        for (let y = y0; y <= y1; y += spacing) {
          f.paintDisc(x, y, r, DENSE);
        }
      }
      planeSource(f, 0.14, 13, 0.5);
    },
  },
  {
    key: 'zoneplate',
    label: 'Fresnel zone plate',
    blurb: 'Concentric metal rings block alternate Fresnel zones, focusing by diffraction.',
    build: (f) => {
      const plateX = Math.round(f.nx * 0.4);
      const cy = Math.round(f.ny / 2);
      const focal = f.nx * 0.35;
      const lambda = 10;
      // Ring boundaries: r_n = sqrt(n*lambda*focal + (n*lambda/2)^2)
      const maxR = f.ny * 0.42;
      for (let y = -Math.round(maxR); y <= Math.round(maxR); y++) {
        const r = Math.abs(y);
        // zone index n where r falls; block even zones
        const n = Math.floor((Math.sqrt(r * r + focal * focal) - focal) / (lambda / 2));
        if (n % 2 === 1) {
          f.paintRect(plateX - 1, cy + y, plateX + 1, cy + y, PEC);
        }
      }
      markDirty(f);
      planeSource(f, 0.14, lambda, 0.5);
      f.addProbe(plateX + Math.round(focal), cy);
    },
  },
  {
    key: 'plasmon',
    label: 'Surface plasmon',
    blurb:
      'A dipole beside a silver surface launches a surface plasmon polariton — light ' +
      'bound to the metal–vacuum interface, riding along it. View as Intensity or Flux.',
    build: (f) => {
      const cy = Math.round(f.ny * 0.52);
      // silver half-space (lower half)
      f.paintRect(0, cy, f.nx - 1, f.ny - 1, SILVER);
      markDirty(f);
      // a compact dipole sitting right at the interface, near the left
      f.addSource({
        x: Math.round(f.nx * 0.22),
        y: cy - 1,
        kind: 'sine',
        wavelength: 15, // near ε ≈ −1, where the SPP lives
        amplitude: 0.9,
        halfLen: 1,
      });
      f.addProbe(Math.round(f.nx * 0.75), cy - 2);
    },
  },
  {
    key: 'drudemirror',
    label: 'Drude mirror',
    blurb:
      'A gold slab: a plane wave below the plasma frequency is reflected like a real ' +
      'metal mirror (its permittivity is negative), unlike a lossless dielectric.',
    build: (f) => {
      const x0 = Math.round(f.nx * 0.5);
      f.paintRect(x0, 20, x0 + Math.round(f.nx * 0.12), f.ny - 20, GOLD);
      markDirty(f);
      planeSource(f, 0.14, 20, 0.5); // λ=20 > plasma λ → reflective
      f.addProbe(Math.round(f.nx * 0.32), Math.round(f.ny / 2));
    },
  },
  {
    key: 'nanoparticle',
    label: 'Plasmonic particle',
    blurb:
      'A plane wave drives a silver nano-disc into a localized surface-plasmon ' +
      'resonance, concentrating the field into bright near-field lobes. Try Intensity.',
    build: (f) => {
      const cx = Math.round(f.nx * 0.55);
      const cy = Math.round(f.ny / 2);
      f.paintDisc(cx, cy, Math.max(4, Math.round(f.ny * 0.045)), SILVER);
      markDirty(f);
      planeSource(f, 0.16, 16, 0.5);
    },
  },
  {
    key: 'enz',
    label: 'ε-near-zero',
    blurb:
      'Driven right at its plasma frequency a Drude slab has ε ≈ 0: the wavelength ' +
      'inside stretches enormously and the phase goes flat — an epsilon-near-zero tunnel.',
    build: (f) => {
      const x0 = Math.round(f.nx * 0.42);
      f.paintRect(x0, 20, x0 + Math.round(f.nx * 0.16), f.ny - 20, GOLD);
      markDirty(f);
      planeSource(f, 0.14, 13, 0.5); // λ ≈ plasma λ → ε ≈ 0
      f.addProbe(Math.round(f.nx * 0.72), Math.round(f.ny / 2));
    },
  },
];

export const PRESET_BY_KEY: Record<string, Preset> = Object.fromEntries(
  PRESETS.map((p) => [p.key, p]),
);
