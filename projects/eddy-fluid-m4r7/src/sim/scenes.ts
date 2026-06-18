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
  {
    id: 'rayleigh-benard',
    name: 'Rayleigh–Bénard convection',
    blurb:
      'A fluid heated from below and cooled from above. Past a critical temperature gap the still layer breaks into a regular train of counter-rotating convection rolls — the pattern in a heated pan and in the Sun’s surface. Switch the render mode to Temperature to see the cells.',
    params: {
      buoyancy: 75,
      thermalDiffusion: 0.00004,
      viscosity: 0.00004,
      vorticity: 1.5,
      velocityDissipation: 0,
      dyeDissipation: 0.02,
      gravity: 0,
      cooling: 0,
      ambient: 0,
      iterations: 30,
      overRelax: 1.6,
    },
    exposure: 1.1,
    setup: (sim) => {
      const N = sim.N;
      // A faint velocity perturbation breaks the unstable equilibrium so the
      // rolls can grow; the wavenumber sets the initial cell count.
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          sim.v[sim.IX(i, j)] = 0.02 * Math.sin((6 * Math.PI * i) / N);
        }
    },
    emit: (sim, { time }) => {
      const N = sim.N;
      const hot = 1.2;
      const cold = -1.2;
      for (let i = 1; i <= N; i++) {
        for (let j = 1; j <= 2; j++) {
          const idx = sim.IX(i, j);
          if (!sim.solid[idx]) sim.t[idx] = cold; // cold lid (top)
        }
        for (let j = N - 1; j <= N; j++) {
          const idx = sim.IX(i, j);
          if (!sim.solid[idx]) sim.t[idx] = hot + 0.12 * Math.sin(i * 0.7 + time * 0.6); // hot plate (bottom)
        }
      }
      // Seed faint dye at the hot plate so the rolls also show in Dye mode.
      for (let i = 4; i <= N - 4; i += Math.max(3, Math.floor(N / 18))) {
        sim.splat(i, N - 2, 0, 0, hueToRGB(0.04, 1.4), 1.1, 0.4);
      }
    },
  },
  {
    id: 'thermal-plume',
    name: 'Buoyant thermal plume',
    blurb:
      'A genuine hot source: a temperature field driven by Boussinesq buoyancy (not dye-mass), rising, cooling, and curling into a mushroom cap. Try the Temperature render mode.',
    params: {
      buoyancy: 95,
      thermalDiffusion: 0.00002,
      cooling: 0.25,
      vorticity: 12,
      viscosity: 0,
      velocityDissipation: 0.005,
      dyeDissipation: 0.04,
      gravity: 0,
      ambient: 0,
      iterations: 26,
      overRelax: 1.4,
    },
    exposure: 1.2,
    setup: () => {},
    emit: (sim, { time }) => {
      const N = sim.N;
      const cx = Math.floor(N * 0.5 + Math.sin(time * 0.7) * N * 0.03);
      const cy = N - Math.max(3, Math.floor(N * 0.05));
      const rad = Math.max(2, N * 0.03);
      sim.splatHeat(cx, cy, 4, rad);
      sim.splat(cx, cy, 0, 0, hueToRGB((0.03 + 0.05 * Math.sin(time * 0.4) + 1) % 1, 2.2), rad, 1.4);
    },
  },
  {
    id: 'kelvin-helmholtz',
    name: 'Kelvin–Helmholtz shear',
    blurb:
      'Two streams sliding past each other in opposite directions. The shear layer between them is unstable and rolls up into a row of cat’s-eye billows — the physics of wind-driven waves and the bands of Jupiter.',
    params: {
      vorticity: 5,
      viscosity: 0.000012,
      velocityDissipation: 0,
      dyeDissipation: 0.008,
      gravity: 0,
      buoyancy: 0,
      iterations: 28,
      overRelax: 1.5,
    },
    exposure: 1.3,
    setup: (sim) => {
      const N = sim.N;
      const mid = N / 2;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = sim.IX(i, j);
          const top = j < mid;
          sim.u[idx] = top ? 0.8 : -0.8;
          const dyc = (j - mid) / (0.06 * N);
          sim.v[idx] = 0.12 * Math.sin((12 * Math.PI * i) / N) * Math.exp(-dyc * dyc);
          if (top) {
            sim.r[idx] = 1.6;
            sim.g[idx] = 0.5;
            sim.b[idx] = 0.2;
          } else {
            sim.r[idx] = 0.2;
            sim.g[idx] = 0.6;
            sim.b[idx] = 1.8;
          }
        }
    },
    emit: (sim) => {
      const N = sim.N;
      const mid = N / 2;
      // Sustain the two opposing streams at their entry edges and keep feeding dye.
      for (let j = 1; j <= N; j++) {
        const top = j < mid;
        const idx = sim.IX(top ? 2 : N - 1, j);
        if (!sim.solid[idx]) sim.u[idx] = top ? 0.8 : -0.8;
      }
      for (let j = 2; j < mid; j += Math.max(2, Math.floor(N / 24)))
        sim.splat(3, j, 0.8, 0, [1.6, 0.5, 0.2], 1.1, 0.7);
      for (let j = Math.ceil(mid); j <= N - 1; j += Math.max(2, Math.floor(N / 24)))
        sim.splat(N - 3, j, -0.8, 0, [0.2, 0.6, 1.8], 1.1, 0.7);
    },
  },
  {
    id: 'lid-cavity',
    name: 'Lid-driven cavity',
    blurb:
      'The textbook CFD benchmark: a closed box whose top lid slides steadily sideways, dragging the fluid into one big recirculating vortex with smaller counter-rotating eddies in the bottom corners. Turn on Streamlines or Particles to see the circulation.',
    params: {
      viscosity: 0.00012,
      vorticity: 0,
      velocityDissipation: 0,
      dyeDissipation: 0.004,
      gravity: 0,
      buoyancy: 0,
      iterations: 40,
      overRelax: 1.6,
    },
    exposure: 1.4,
    setup: (sim) => {
      const N = sim.N;
      // Alternating faint dye bands so the recirculation is visible in Dye mode.
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const band = Math.floor((j / N) * 6) % 2;
          const idx = sim.IX(i, j);
          if (band === 0) {
            sim.r[idx] = 0.8;
            sim.g[idx] = 0.4;
          } else {
            sim.b[idx] = 0.9;
            sim.g[idx] = 0.4;
          }
        }
    },
    emit: (sim) => {
      const N = sim.N;
      const U = 0.9;
      for (let i = 1; i <= N; i++) {
        const idx = sim.IX(i, 1); // top interior row = the sliding lid
        if (!sim.solid[idx]) {
          sim.u[idx] = U;
          sim.v[idx] = 0;
        }
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
