// scenes.ts — curated starting configurations.
//
// A scene optionally rewrites the solver params, paints obstacles, seeds dye,
// and may install a per-step "emitter" that keeps injecting flow (e.g. a
// continuous inflow on the left edge for the von Kármán vortex-street demo).

import { FluidSolver, type FluidParams } from './fluid';

export interface SceneStepContext {
  time: number; // seconds since the scene started
  dt: number;
}

export interface Scene {
  id: string;
  name: string;
  blurb: string;
  /** Suggested parameter overrides applied when the scene is loaded. */
  params?: Partial<FluidParams>;
  /** Suggested renderer exposure. */
  exposure?: number;
  /** Build the initial obstacles / dye. */
  setup: (sim: FluidSolver) => void;
  /** Optional continuous emitter, called every step. */
  emit?: (sim: FluidSolver, ctx: SceneStepContext) => void;
}

const TAU = Math.PI * 2;

export const SCENES: Scene[] = [
  {
    id: 'blank',
    name: 'Blank canvas',
    blurb: 'An empty tank — drag to paint dye and stir the fluid yourself.',
    params: { vorticity: 6, dyeDissipation: 0.1, velocityDissipation: 0.02 },
    exposure: 1,
    setup: () => {},
  },
  {
    id: 'vortex-street',
    name: 'Von Kármán vortex street',
    blurb:
      'Steady inflow past a cylinder. Above a critical speed the wake goes unstable and sheds a periodic train of alternating vortices — the same effect that makes power lines hum.',
    params: { vorticity: 8, viscosity: 0.00002, dyeDissipation: 0.02, velocityDissipation: 0.0, iterations: 28 },
    exposure: 1.4,
    setup: (sim) => {
      const N = sim.N;
      const cx = Math.floor(N * 0.28);
      const cy = Math.floor(N * 0.5);
      const rad = Math.max(3, Math.floor(N * 0.06));
      sim.paintSolid(cx, cy, rad, true);
    },
    emit: (sim, { time }) => {
      const N = sim.N;
      const speed = 1.0;
      // Inflow column on the left; small vertical wobble kicks the instability.
      const wobble = Math.sin(time * 3) * 0.06;
      for (let j = 2; j <= N - 1; j++) {
        const idx = sim.IX(2, j);
        if (sim.solid[idx]) continue;
        sim.u[idx] = speed;
        sim.v[idx] = wobble;
      }
      // Inject thin dye streaks so the wake is visible.
      for (let j = 6; j <= N - 6; j += Math.max(4, Math.floor(N / 16))) {
        const hue = j / N;
        sim.splat(3, j, speed, 0, hueToRGB(hue, 2.2), 1.4, 1.2);
      }
    },
  },
  {
    id: 'plume',
    name: 'Rising plume',
    blurb: 'A hot buoyant source at the bottom. Vorticity confinement curls it into billowing smoke.',
    params: { vorticity: 12, gravity: -22, dyeDissipation: 0.06, velocityDissipation: 0.01, viscosity: 0 },
    exposure: 1.2,
    setup: () => {},
    emit: (sim, { time }) => {
      const N = sim.N;
      const cx = Math.floor(N * 0.5 + Math.sin(time * 0.8) * N * 0.04);
      const cy = N - Math.max(3, Math.floor(N * 0.06));
      const hue = (0.05 + 0.1 * Math.sin(time * 0.5) + 1) % 1;
      sim.splat(cx, cy, 0, -1.0, hueToRGB(hue, 2.6), Math.max(2, N * 0.03), 2.2);
    },
  },
  {
    id: 'jets',
    name: 'Colliding jets',
    blurb: 'Two opposing inflows meet in the middle and tear into turbulence.',
    params: { vorticity: 10, dyeDissipation: 0.05, velocityDissipation: 0.01, viscosity: 0 },
    exposure: 1.3,
    setup: () => {},
    emit: (sim) => {
      const N = sim.N;
      const y = Math.floor(N * 0.5);
      sim.splat(4, y, 1.2, 0, [2.4, 0.4, 0.1], Math.max(2, N * 0.03), 1.6);
      sim.splat(N - 4, y, -1.2, 0, [0.1, 0.6, 2.6], Math.max(2, N * 0.03), 1.6);
    },
  },
  {
    id: 'orbit',
    name: 'Stirred ink',
    blurb: 'An invisible paddle traces a circle, dragging four ink blobs into a spiral.',
    params: { vorticity: 6, dyeDissipation: 0.03, velocityDissipation: 0.008, viscosity: 0 },
    exposure: 1.2,
    setup: (sim) => {
      const N = sim.N;
      const blobs: Array<[number, number, [number, number, number]]> = [
        [0.5, 0.25, [2.6, 0.3, 0.3]],
        [0.75, 0.5, [0.3, 2.4, 0.5]],
        [0.5, 0.75, [0.4, 0.5, 2.6]],
        [0.25, 0.5, [2.4, 2.2, 0.3]],
      ];
      for (const [fx, fy, c] of blobs) {
        sim.splat(Math.floor(N * fx), Math.floor(N * fy), 0, 0, c, Math.max(3, N * 0.06), 3.2);
      }
    },
    emit: (sim, { time }) => {
      const N = sim.N;
      const r = N * 0.3;
      const a = (time * 1.2) % TAU;
      const px = N * 0.5 + Math.cos(a) * r;
      const py = N * 0.5 + Math.sin(a) * r;
      const tx = -Math.sin(a);
      const ty = Math.cos(a);
      sim.splat(Math.floor(px), Math.floor(py), tx * 1.1, ty * 1.1, [0, 0, 0], Math.max(2, N * 0.03), 0);
    },
  },
  {
    id: 'obstacle-course',
    name: 'Obstacle course',
    blurb: 'Inflow weaves through a lattice of pillars — drag to add more dye.',
    params: { vorticity: 9, dyeDissipation: 0.025, velocityDissipation: 0.0, viscosity: 0.00002, iterations: 28 },
    exposure: 1.4,
    setup: (sim) => {
      const N = sim.N;
      const rad = Math.max(2, Math.floor(N * 0.035));
      for (let gx = 0; gx < 3; gx++) {
        for (let gy = 0; gy < 3; gy++) {
          const px = Math.floor(N * (0.35 + gx * 0.2));
          const py = Math.floor(N * (0.25 + gy * 0.25) + (gx % 2) * N * 0.05);
          sim.paintSolid(px, py, rad, true);
        }
      }
    },
    emit: (sim, { time }) => {
      const N = sim.N;
      const speed = 0.9;
      for (let j = 2; j <= N - 1; j++) {
        const idx = sim.IX(2, j);
        if (sim.solid[idx]) continue;
        sim.u[idx] = speed;
      }
      for (let j = 6; j <= N - 6; j += Math.max(4, Math.floor(N / 14))) {
        sim.splat(3, j, speed, 0, hueToRGB((j / N + time * 0.05) % 1, 2.0), 1.3, 1.0);
      }
    },
  },
];

/** Map a hue (0..1) to an RGB triple scaled by `intensity` (for dye injection). */
export function hueToRGB(h: number, intensity: number): [number, number, number] {
  const r = Math.max(0, Math.abs((((h * 6) % 6) - 3)) - 1);
  const g = Math.max(0, 2 - Math.abs(((h * 6) % 6) - 2));
  const b = Math.max(0, 2 - Math.abs(((h * 6) % 6) - 4));
  return [Math.min(1, r) * intensity, Math.min(1, g) * intensity, Math.min(1, b) * intensity];
}

export function sceneById(id: string): Scene {
  return SCENES.find((s) => s.id === id) ?? SCENES[0];
}
