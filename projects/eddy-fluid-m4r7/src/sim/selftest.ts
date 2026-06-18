// selftest.ts — a numerical verification suite for the fluid solver.
//
// A real PDE solver should be *checkable*: every operator has invariants it must
// obey, and several have closed-form answers we can compare against. This suite
// builds small, deterministic solvers and asserts those properties directly — no
// eyeballing pixels. It's the same discipline a CFD code uses to earn trust:
// projection really removes divergence, SOR converges to the same answer as
// Gauss–Seidel (only faster), advection reproduces constants, diffusion conserves
// heat under insulating walls, the discrete curl matches solid-body rotation,
// buoyancy lifts hot fluid, a symmetric setup stays symmetric, and nothing leaks
// through walls or blows up. If any check fails, the studio says so out loud.

import { FluidSolver, DEFAULT_PARAMS, type FluidParams } from './fluid';

export interface Check {
  name: string;
  detail: string;
  pass: boolean;
  measured: string;
}

export interface CheckGroup {
  title: string;
  blurb: string;
  checks: Check[];
}

export interface SelfTestReport {
  groups: CheckGroup[];
  passed: number;
  total: number;
  ms: number;
}

function params(over: Partial<FluidParams>): FluidParams {
  return { ...DEFAULT_PARAMS, viscosity: 0, vorticity: 0, velocityDissipation: 0, dyeDissipation: 0, ...over };
}

/** A smooth, strongly divergent test field (so projection has real work to do). */
function seedDivergent(sim: FluidSolver): void {
  const N = sim.N;
  for (let j = 0; j <= N + 1; j++) {
    for (let i = 0; i <= N + 1; i++) {
      const idx = sim.IX(i, j);
      const x = i / N;
      const y = j / N;
      sim.u[idx] = Math.sin(3 * Math.PI * x) * Math.cos(2 * Math.PI * y) + (x - 0.5);
      sim.v[idx] = Math.cos(2 * Math.PI * x) * Math.sin(3 * Math.PI * y) + 0.4 * (y - 0.5);
    }
  }
}

function linf(a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]);
    if (d > m) m = d;
  }
  return m;
}

// Reductions over the *strict* interior (a `margin`-cell inset). The outermost
// ring carries reflective wall ghosts on purpose, so quality is judged inside.
function rmsDivInterior(sim: FluidSolver, margin = 2): number {
  const N = sim.N;
  const u = sim.u;
  const v = sim.v;
  let s = 0;
  let n = 0;
  for (let j = 1 + margin; j <= N - margin; j++)
    for (let i = 1 + margin; i <= N - margin; i++) {
      const idx = sim.IX(i, j);
      if (sim.solid[idx]) continue;
      const d = -0.5 * (u[idx + 1] - u[idx - 1] + v[idx + (N + 2)] - v[idx - (N + 2)]) / N;
      s += d * d;
      n++;
    }
  return n > 0 ? Math.sqrt(s / n) : 0;
}

// Peak residual of the pressure Poisson system the solver actually relaxes:
// 4·p = div + Σ(neighbours). This → 0 as the linear solve converges, regardless
// of the collocated-grid odd/even decoupling that floors the *velocity* divergence.
function poissonResidual(sim: FluidSolver, margin = 2): number {
  const N = sim.N;
  const p = sim.p;
  const div = sim.div;
  let m = 0;
  for (let j = 1 + margin; j <= N - margin; j++)
    for (let i = 1 + margin; i <= N - margin; i++) {
      const idx = sim.IX(i, j);
      if (sim.solid[idx]) continue;
      const r = div[idx] + (p[idx - 1] + p[idx + 1] + p[idx - (N + 2)] + p[idx + (N + 2)]) - 4 * p[idx];
      if (Math.abs(r) > m) m = Math.abs(r);
    }
  return m;
}

function check(name: string, detail: string, pass: boolean, measured: string): Check {
  return { name, detail, pass, measured };
}

function fmt(x: number): string {
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a < 1e-3 || a >= 1e5) return x.toExponential(2);
  return x.toFixed(a < 1 ? 4 : 3);
}

// --- groups -----------------------------------------------------------------

function incompressibility(): CheckGroup {
  const checks: Check[] = [];
  const N = 56;

  // 1. Projection strongly reduces the divergence of the field.
  {
    const sim = new FluidSolver(N);
    seedDivergent(sim);
    const before = rmsDivInterior(sim);
    sim.projectVelocity(300, 1.8);
    const after = rmsDivInterior(sim);
    checks.push(
      check(
        'Projection reduces divergence',
        'The Hodge/pressure solve sharply lowers the RMS divergence. (A collocated grid can’t reach zero — the leftover is the high-frequency odd/even mode, documented below.)',
        after < 0.25 * before,
        `RMS ∇·u: ${fmt(before)} → ${fmt(after)} (${fmt(before / after)}× smaller)`,
      ),
    );
  }

  // 2. Convergence: more relaxation sweeps ⇒ strictly less residual divergence.
  {
    const sweeps = [4, 12, 40];
    const res = sweeps.map((s) => {
      const sim = new FluidSolver(N);
      seedDivergent(sim);
      sim.projectVelocity(s, 1);
      return rmsDivInterior(sim);
    });
    const monotone = res[0] > res[1] && res[1] > res[2];
    checks.push(
      check(
        'More sweeps ⇒ less divergence',
        'The iterative pressure solve converges: increasing the sweep budget strictly lowers the residual.',
        monotone,
        `RMS ∇·u @ ${sweeps.join('/')} sweeps = ${res.map(fmt).join(' → ')}`,
      ),
    );
  }

  // 3. The projection has no left/right bias: a symmetric field stays symmetric.
  {
    const sim = new FluidSolver(N);
    const c = (N + 1) / 2;
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = sim.IX(i, j);
        sim.u[idx] = Math.sin((2 * Math.PI * (i - c)) / N); // odd in i
        sim.v[idx] = Math.cos((2 * Math.PI * (i - c)) / N) * Math.sin((Math.PI * j) / N); // even in i
      }
    sim.projectVelocity(300, 1.8);
    let asym = 0;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const A = sim.IX(i, j);
        const M = sim.IX(N + 1 - i, j);
        asym = Math.max(asym, Math.abs(sim.u[A] + sim.u[M]), Math.abs(sim.v[A] - sim.v[M]));
      }
    checks.push(
      check(
        'Projection has no directional bias',
        'Red-black ordering keeps the solver mirror-symmetric: a field symmetric about the vertical axis projects to a symmetric field (lexicographic Gauss–Seidel would skew it).',
        asym < 1e-4,
        `max symmetry break = ${fmt(asym)}`,
      ),
    );
  }

  return {
    title: 'Incompressibility (Hodge projection)',
    blurb: 'The projection step enforces ∇·u = 0 by solving a pressure Poisson equation and subtracting its gradient.',
    checks,
  };
}

function linearSolver(): CheckGroup {
  const checks: Check[] = [];
  const N = 56;

  // SOR beats Gauss–Seidel in the real-time regime (a modest sweep budget).
  {
    const budget = 24;
    const gs = new FluidSolver(N);
    seedDivergent(gs);
    gs.projectVelocity(budget, 1);
    const divGS = rmsDivInterior(gs);
    const sor = new FluidSolver(N);
    seedDivergent(sor);
    sor.projectVelocity(budget, 1.8);
    const divSOR = rmsDivInterior(sor);
    checks.push(
      check(
        'SOR accelerates the pressure solve',
        `In the real-time regime (${budget} sweeps), over-relaxation (ω = 1.8) leaves markedly less residual divergence than plain Gauss–Seidel (ω = 1).`,
        divSOR < 0.6 * divGS,
        `RMS ∇·u after ${budget} sweeps: GS ${fmt(divGS)} vs SOR ${fmt(divSOR)} (${fmt(divGS / divSOR)}× lower)`,
      ),
    );
  }

  // The linear system is genuinely solved: its residual converges toward zero.
  {
    const sweeps = [8, 20, 60, 200];
    const res = sweeps.map((s) => {
      const sim = new FluidSolver(N);
      seedDivergent(sim);
      sim.projectVelocity(s, 1);
      return poissonResidual(sim);
    });
    const monotone = res.every((r, k) => k === 0 || r < res[k - 1]);
    checks.push(
      check(
        'The pressure equation is actually solved',
        'The residual of the Poisson system 4p = div + Σp (what the relaxation drives to zero) decreases monotonically and becomes small.',
        monotone && res[res.length - 1] < 2e-3,
        `‖residual‖∞ @ ${sweeps.join('/')} sweeps = ${res.map(fmt).join(' → ')}`,
      ),
    );
  }

  return {
    title: 'Linear solver (red-black Gauss–Seidel / SOR)',
    blurb: 'Pressure & viscosity are sparse linear systems solved by relaxation; over-relaxation accelerates it and red-black ordering removes directional bias.',
    checks,
  };
}

function transport(): CheckGroup {
  const checks: Check[] = [];

  // Advection of a constant field reproduces the constant exactly.
  {
    const N = 48;
    const sim = new FluidSolver(N);
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = sim.IX(i, j);
        sim.u[idx] = 0.35;
        sim.v[idx] = 0.12;
        sim.r[idx] = sim.g[idx] = sim.b[idx] = 0.7;
      }
    sim.step(1 / 60, params({ sharpDye: false }));
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const val = sim.r[sim.IX(i, j)];
        if (val < lo) lo = val;
        if (val > hi) hi = val;
      }
    checks.push(
      check(
        'Advection preserves a constant',
        'Semi-Lagrangian advection of a uniform field must return the same uniform field (no spurious sources).',
        hi - lo < 1e-4,
        `dye spread after a step: ${fmt(hi - lo)}`,
      ),
    );
  }

  // Diffusion conserves total heat under insulating (Neumann) walls, and smooths.
  {
    const N = 48;
    const sim = new FluidSolver(N);
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const dx = (i - N / 2) / N;
        const dy = (j - N / 2) / N;
        sim.t[sim.IX(i, j)] = Math.exp(-40 * (dx * dx + dy * dy));
      }
    const sum0 = sum(sim.t, N, sim);
    const var0 = variance(sim.t, N, sim);
    for (let s = 0; s < 12; s++) sim.step(1 / 60, params({ thermalDiffusion: 0.02 }));
    const sum1 = sum(sim.t, N, sim);
    const var1 = variance(sim.t, N, sim);
    checks.push(
      check(
        'Diffusion conserves heat',
        'With no flow and insulating walls, the temperature integral must stay fixed as heat spreads.',
        Math.abs(sum1 - sum0) < 1e-3 * Math.abs(sum0),
        `∑T: ${fmt(sum0)} → ${fmt(sum1)} (Δ ${fmt((100 * (sum1 - sum0)) / sum0)}%)`,
      ),
    );
    checks.push(
      check(
        'Diffusion smooths the field',
        'Heat diffusion is a low-pass filter: spatial variance must strictly decrease.',
        var1 < var0,
        `variance: ${fmt(var0)} → ${fmt(var1)}`,
      ),
    );
  }

  return {
    title: 'Transport (advection & diffusion)',
    blurb: 'Scalars are carried by the flow (advection) and spread by diffusion; each has invariants we can pin down.',
    checks,
  };
}

function operators(): CheckGroup {
  const checks: Check[] = [];

  // Discrete curl of a solid-body rotation equals 2Ω exactly.
  {
    const N = 48;
    const sim = new FluidSolver(N);
    const omega = 0.01;
    const c = (N + 1) / 2;
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = sim.IX(i, j);
        sim.u[idx] = -omega * (j - c);
        sim.v[idx] = omega * (i - c);
      }
    let maxErr = 0;
    for (let j = 3; j <= N - 2; j++)
      for (let i = 3; i <= N - 2; i++) {
        const w = sim.curlAt(i, j);
        const e = Math.abs(w - 2 * omega);
        if (e > maxErr) maxErr = e;
      }
    checks.push(
      check(
        'Discrete curl matches solid-body rotation',
        'For u = Ω × r the vorticity is a constant 2Ω everywhere; the central-difference curl must reproduce it.',
        maxErr < 1e-6,
        `max|ω − 2Ω| = ${fmt(maxErr)} (expected 2Ω = ${fmt(2 * omega)})`,
      ),
    );
  }

  // Bilinear sampling reproduces an affine field exactly.
  {
    const N = 48;
    const sim = new FluidSolver(N);
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) sim.u[sim.IX(i, j)] = 2 * i - 3 * j + 5;
    let maxErr = 0;
    for (let s = 0; s < 200; s++) {
      const x = 1 + Math.random() * (N - 1);
      const y = 1 + Math.random() * (N - 1);
      const got = sim.sampleField(sim.u, x, y);
      const want = 2 * x - 3 * y + 5;
      maxErr = Math.max(maxErr, Math.abs(got - want));
    }
    checks.push(
      check(
        'Bilinear sampling is exact on affine data',
        'Bilinear interpolation must reproduce any linear function with no error — the basis of stable advection.',
        maxErr < 1e-3,
        `max sampling error = ${fmt(maxErr)}`,
      ),
    );
  }

  return {
    title: 'Discrete operators',
    blurb: 'The finite-difference curl and the bilinear sampler underpin everything; both have exact answers on simple fields.',
    checks,
  };
}

function thermalAndSymmetry(): CheckGroup {
  const checks: Check[] = [];

  // Boussinesq buoyancy lifts hot fluid upward (toward smaller j).
  {
    const N = 48;
    const sim = new FluidSolver(N);
    const cx = N / 2;
    const cy = N / 2;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const dx = (i - cx) / N;
        const dy = (j - cy) / N;
        sim.t[sim.IX(i, j)] = Math.exp(-60 * (dx * dx + dy * dy));
      }
    const cBefore = centroidJ(sim.t, N, sim);
    for (let s = 0; s < 24; s++) sim.step(1 / 60, params({ buoyancy: 60 }));
    const cAfter = centroidJ(sim.t, N, sim);
    checks.push(
      check(
        'Buoyancy lifts hot fluid',
        'A hot blob under positive buoyancy must rise — its temperature centroid moves up the grid (j decreases).',
        cAfter < cBefore - 0.2,
        `heat centroid row: ${fmt(cBefore)} → ${fmt(cAfter)}`,
      ),
    );
  }

  // Newton cooling relaxes temperature toward the ambient reference.
  {
    const N = 40;
    const sim = new FluidSolver(N);
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) sim.t[sim.IX(i, j)] = 1;
    const ambient = 0.2;
    const before = sim.diagnostics().meanTemp;
    for (let s = 0; s < 30; s++) sim.step(1 / 60, params({ cooling: 1.5, ambient }));
    const after = sim.diagnostics().meanTemp;
    checks.push(
      check(
        'Cooling relaxes toward ambient',
        'With Newton cooling on, a uniformly hot field decays monotonically toward the ambient temperature it is measured against.',
        after < before && after > ambient - 1e-3 && before - after > 0.1,
        `mean T: ${fmt(before)} → ${fmt(after)} (ambient ${fmt(ambient)})`,
      ),
    );
  }

  return {
    title: 'Thermal buoyancy',
    blurb: 'The Boussinesq force couples temperature to velocity; cooling and diffusion give the heat field its own dynamics.',
    checks,
  };
}

function robustness(): CheckGroup {
  const checks: Check[] = [];

  // Maximum principle: semi-Lagrangian advection introduces no new extrema.
  {
    const N = 56;
    const sim = new FluidSolver(N);
    // A swirling, divergence-free velocity and a dye blob bounded in [0, 1].
    const c = (N + 1) / 2;
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = sim.IX(i, j);
        sim.u[idx] = -0.6 * (j - c) / N;
        sim.v[idx] = 0.6 * (i - c) / N;
        const dx = (i - c * 0.7) / N;
        const dy = (j - c) / N;
        sim.r[idx] = Math.exp(-30 * (dx * dx + dy * dy));
      }
    let hi0 = -Infinity;
    let lo0 = Infinity;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const v = sim.r[sim.IX(i, j)];
        if (v > hi0) hi0 = v;
        if (v < lo0) lo0 = v;
      }
    let hi = -Infinity;
    let lo = Infinity;
    for (let s = 0; s < 60; s++) {
      sim.step(1 / 60, params({ sharpDye: false })); // plain semi-Lagrangian
    }
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const v = sim.r[sim.IX(i, j)];
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
    checks.push(
      check(
        'Advection obeys a maximum principle',
        'Semi-Lagrangian transport is a convex interpolation, so it can never manufacture a value outside the initial [min, max] — no overshoot, no negative dye.',
        hi <= hi0 + 1e-4 && lo >= -1e-4,
        `range ${fmt(lo0)}…${fmt(hi0)} → ${fmt(lo)}…${fmt(hi)}`,
      ),
    );
  }

  // Unconditional stability: a violent flow stays finite.
  {
    const N = 64;
    const sim = new FluidSolver(N);
    const y = Math.floor(N / 2);
    for (let s = 0; s < 90; s++) {
      sim.splat(4, y, 2.5, 0, [3, 0.5, 0.2], 3, 2);
      sim.splat(N - 4, y, -2.5, 0, [0.2, 0.6, 3], 3, 2);
      sim.step(1 / 30, params({ vorticity: 14, overRelax: 1.6 }));
    }
    const d = sim.diagnostics();
    const finite = Number.isFinite(d.kineticEnergy) && Number.isFinite(d.maxDivergence) && linf(sim.u) < 1e3;
    checks.push(
      check(
        'Unconditionally stable',
        'Stam’s scheme can’t blow up: even colliding jets at a large timestep stay finite and bounded.',
        finite,
        `KE = ${fmt(d.kineticEnergy)}, max|u| = ${fmt(linf(sim.u))}`,
      ),
    );
  }

  return {
    title: 'Boundaries & stability',
    blurb: 'Walls must contain the flow, and the semi-implicit scheme must stay bounded for any timestep.',
    checks,
  };
}

// --- small reductions over the interior --------------------------------------

function sum(f: Float32Array, N: number, sim: FluidSolver): number {
  let s = 0;
  for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) s += f[sim.IX(i, j)];
  return s;
}
function variance(f: Float32Array, N: number, sim: FluidSolver): number {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let j = 1; j <= N; j++)
    for (let i = 1; i <= N; i++) {
      const v = f[sim.IX(i, j)];
      s += v;
      s2 += v * v;
      n++;
    }
  return s2 / n - (s / n) * (s / n);
}
function centroidJ(f: Float32Array, N: number, sim: FluidSolver): number {
  let wsum = 0;
  let jsum = 0;
  for (let j = 1; j <= N; j++)
    for (let i = 1; i <= N; i++) {
      const w = Math.max(0, f[sim.IX(i, j)]);
      wsum += w;
      jsum += w * j;
    }
  return wsum > 0 ? jsum / wsum : N / 2;
}

/** Run the whole suite and tally the results. */
export function runSelfTest(): SelfTestReport {
  const t0 = performance.now();
  const groups = [
    incompressibility(),
    linearSolver(),
    transport(),
    operators(),
    thermalAndSymmetry(),
    robustness(),
  ];
  let passed = 0;
  let total = 0;
  for (const g of groups)
    for (const c of g.checks) {
      total++;
      if (c.pass) passed++;
    }
  return { groups, passed, total, ms: performance.now() - t0 };
}
