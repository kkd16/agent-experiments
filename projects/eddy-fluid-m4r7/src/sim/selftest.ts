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
import { computeLIC, makeNoise } from '../render/lic';
import { fft1d, fft2d, energySpectrum, meanKineticEnergy } from './fft';

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

function conjugateGradient(): CheckGroup {
  const checks: Check[] = [];
  const N = 56;

  // CG drives the Poisson residual far lower than SOR at an equal iteration budget.
  {
    const budget = 24;
    const cg = new FluidSolver(N);
    seedDivergent(cg);
    cg.projectVelocityCG(budget);
    const resCG = poissonResidual(cg);
    const sor = new FluidSolver(N);
    seedDivergent(sor);
    sor.projectVelocity(budget, 1.8);
    const resSOR = poissonResidual(sor);
    checks.push(
      check(
        'CG beats SOR per iteration',
        `At an equal budget (${budget} iterations) Jacobi-preconditioned Conjugate Gradients leaves a much smaller Poisson residual than red-black SOR — Krylov methods converge the spectrum far faster than a stationary relaxation.`,
        resCG < 0.5 * resSOR,
        `‖residual‖∞ @ ${budget} its: CG ${fmt(resCG)} vs SOR ${fmt(resSOR)} (${fmt(resSOR / resCG)}× lower)`,
      ),
    );
  }

  // The CG residual converges monotonically toward zero with more iterations.
  {
    const its = [10, 30, 90];
    const res = its.map((k) => {
      const sim = new FluidSolver(N);
      seedDivergent(sim);
      sim.projectVelocityCG(k, 1e-12);
      return poissonResidual(sim);
    });
    const monotone = res[0] > res[1] && res[1] > res[2];
    checks.push(
      check(
        'CG converges the pressure equation',
        'More CG iterations strictly lower the residual of the same Poisson system the relaxation solves, down toward machine precision.',
        monotone && res[res.length - 1] < 1e-4,
        `‖residual‖∞ @ ${its.join('/')} its = ${res.map(fmt).join(' → ')}`,
      ),
    );
  }

  // CG and fully-converged SOR reach the same incompressibility — same physics.
  {
    const cg = new FluidSolver(N);
    seedDivergent(cg);
    cg.projectVelocityCG(300, 1e-12);
    const divCG = rmsDivInterior(cg);
    const sor = new FluidSolver(N);
    seedDivergent(sor);
    sor.projectVelocity(3000, 1.7);
    const divSOR = rmsDivInterior(sor);
    checks.push(
      check(
        'CG lands on the same projected field',
        'CG is a faster road to the *same* answer: converged, it reaches the identical residual divergence floor as converged SOR (both hit the collocated-grid odd/even limit, not a different solution).',
        Math.abs(divCG - divSOR) < 1.5e-4,
        `RMS ∇·u (converged): CG ${fmt(divCG)} vs SOR ${fmt(divSOR)}`,
      ),
    );
  }

  // CG honours internal obstacles: with a cylinder in the flow it reaches the
  // same incompressibility as converged SOR (both apply the Neumann no-penetration
  // condition at the solid faces through the identical stencil).
  {
    const before = (() => {
      const s = new FluidSolver(64);
      seedDivergent(s);
      return rmsDivInterior(s);
    })();
    const cg = new FluidSolver(64);
    seedDivergent(cg);
    cg.paintSolid(22, 32, 6, true);
    cg.projectVelocityCG(300, 1e-12);
    const divCG = rmsDivInterior(cg);
    const sor = new FluidSolver(64);
    seedDivergent(sor);
    sor.paintSolid(22, 32, 6, true);
    sor.projectVelocity(3000, 1.7);
    const divSOR = rmsDivInterior(sor);
    checks.push(
      check(
        'CG respects solid obstacles',
        'The matrix-free operator applies the identical Neumann condition at internal solid faces as at the domain walls, so a cylinder in the flow is projected to the same residual divergence as converged SOR.',
        Number.isFinite(divCG) && divCG < 0.6 * before && Math.abs(divCG - divSOR) < 1.5e-4,
        `RMS ∇·u with a cylinder: ${fmt(before)} → CG ${fmt(divCG)} (SOR ${fmt(divSOR)})`,
      ),
    );
  }

  return {
    title: 'Krylov solver (Conjugate Gradients)',
    blurb:
      'The pressure Poisson system is symmetric positive-semidefinite — the textbook case for Conjugate Gradients. CG converges it far faster than SOR and to the same solution.',
    checks,
  };
}

function multigrid(): CheckGroup {
  const checks: Check[] = [];

  // 1. The V-cycle solver drives the Poisson residual toward machine precision.
  {
    const N = 56;
    const vc = [1, 3, 6];
    const res = vc.map((k) => {
      const sim = new FluidSolver(N);
      seedDivergent(sim);
      sim.projectVelocityMG(k);
      return poissonResidual(sim);
    });
    const monotone = res[0] > res[1] && res[1] > res[2];
    checks.push(
      check(
        'Multigrid converges the pressure equation',
        'Each V-cycle smooths on the fine grid, corrects from a 2× coarser one (where the smooth error is oscillatory and cheap to kill), and smooths again. A handful of cycles drives the Poisson residual down toward float precision.',
        monotone && res[res.length - 1] < 1e-5,
        `‖residual‖∞ @ ${vc.join('/')} V-cycles = ${res.map(fmt).join(' → ')}`,
      ),
    );
  }

  // 2. The headline multigrid property: a convergence factor independent of grid
  // size. Stationary relaxation (SOR) and even CG slow down as the grid grows;
  // multigrid's reduction-per-cycle stays put — the work-optimal O(N) Poisson solve.
  {
    const factor = (N: number) => {
      const after = (k: number) => {
        const sim = new FluidSolver(N);
        seedDivergent(sim);
        sim.projectVelocityMG(k);
        return poissonResidual(sim);
      };
      const r1 = after(1);
      const r6 = after(6);
      return Math.pow(r6 / r1, 1 / 5); // geometric mean reduction per cycle
    };
    const fSmall = factor(48);
    const fLarge = factor(96);
    const ratio = Math.max(fSmall, fLarge) / Math.min(fSmall, fLarge);
    checks.push(
      check(
        'Multigrid convergence is grid-independent',
        'The per-V-cycle residual reduction barely changes when the grid is doubled — the defining property of multigrid (and why it is asymptotically optimal). A stationary solver’s rate would worsen markedly with N.',
        fSmall < 0.3 && fLarge < 0.3 && ratio < 1.6,
        `reduction/cycle: 48² ${fmt(fSmall)} vs 96² ${fmt(fLarge)} (ratio ${fmt(ratio)})`,
      ),
    );
  }

  // 3. MGCG: one V-cycle as the CG preconditioner annihilates CG's per-iteration cost.
  {
    const budget = 8;
    const cg = new FluidSolver(56);
    seedDivergent(cg);
    cg.projectVelocityCG(budget);
    const resCG = poissonResidual(cg);
    const mgcg = new FluidSolver(56);
    seedDivergent(mgcg);
    mgcg.projectVelocityMGCG(budget);
    const resMGCG = poissonResidual(mgcg);
    checks.push(
      check(
        'MGCG crushes the residual per iteration',
        `Replacing CG’s diagonal preconditioner with a single multigrid V-cycle (a near-perfect approximate inverse) makes each CG iteration enormously more effective: at an equal ${budget}-iteration budget MGCG’s residual is orders of magnitude below plain CG’s.`,
        resMGCG < 1e-5 && resMGCG < 0.05 * resCG,
        `‖residual‖∞ @ ${budget} its: CG ${fmt(resCG)} vs MGCG ${fmt(resMGCG)} (${fmt(resCG / resMGCG)}× lower)`,
      ),
    );
  }

  // 4. MGCG lands on the same incompressible field as converged CG — same physics.
  {
    const cg = new FluidSolver(56);
    seedDivergent(cg);
    cg.projectVelocityCG(300, 1e-12);
    const divCG = rmsDivInterior(cg);
    const mgcg = new FluidSolver(56);
    seedDivergent(mgcg);
    mgcg.projectVelocityMGCG(60, 1e-10);
    const divMGCG = rmsDivInterior(mgcg);
    checks.push(
      check(
        'MGCG lands on the same projected field',
        'A different, faster road to the *same* answer: converged MGCG reaches the identical residual-divergence floor as converged CG (the same collocated-grid limit, not a different solution).',
        Math.abs(divCG - divMGCG) < 1.5e-4,
        `RMS ∇·u (converged): CG ${fmt(divCG)} vs MGCG ${fmt(divMGCG)}`,
      ),
    );
  }

  // 5. MGCG honours internal obstacles (where a bare V-cycle would struggle, CG
  // makes it robust): a cylinder in the flow projects to the converged-SOR floor.
  {
    const before = (() => {
      const s = new FluidSolver(64);
      seedDivergent(s);
      return rmsDivInterior(s);
    })();
    const mgcg = new FluidSolver(64);
    seedDivergent(mgcg);
    mgcg.paintSolid(22, 32, 6, true);
    mgcg.projectVelocityMGCG(60, 1e-10);
    const divMGCG = rmsDivInterior(mgcg);
    const sor = new FluidSolver(64);
    seedDivergent(sor);
    sor.paintSolid(22, 32, 6, true);
    sor.projectVelocity(3000, 1.7);
    const divSOR = rmsDivInterior(sor);
    checks.push(
      check(
        'MGCG respects solid obstacles',
        'Wrapping the V-cycle in CG keeps it robust where embedded boundaries make a bare multigrid correction overshoot: with a cylinder in the flow MGCG still reaches the same residual divergence as converged SOR.',
        Number.isFinite(divMGCG) && divMGCG < 0.6 * before && Math.abs(divMGCG - divSOR) < 1.5e-4,
        `RMS ∇·u with a cylinder: ${fmt(before)} → MGCG ${fmt(divMGCG)} (SOR ${fmt(divSOR)})`,
      ),
    );
  }

  return {
    title: 'Multigrid (V-cycle & MGCG)',
    blurb:
      'Geometric multigrid solves the pressure Poisson equation in O(N) work with a convergence rate independent of grid size; as a CG preconditioner (MGCG) it is both grid-independent and robust to obstacles.',
    checks,
  };
}

function combustion(): CheckGroup {
  const checks: Check[] = [];
  const N = 48;

  const seedFuelHot = (sim: FluidSolver, t: number) => {
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) {
        const idx = sim.IX(i, j);
        sim.fuel[idx] = 0.8;
        sim.t[idx] = t;
      }
  };
  const totalFuel = (sim: FluidSolver) => sum(sim.fuel, N, sim);
  const totalHeat = (sim: FluidSolver) => sum(sim.t, N, sim);

  // Below the ignition temperature, nothing burns: fuel & heat are unchanged.
  {
    const sim = new FluidSolver(N);
    seedFuelHot(sim, 0.2); // cooler than ignition 0.6
    const f0 = totalFuel(sim);
    const h0 = totalHeat(sim);
    for (let s = 0; s < 20; s++)
      sim.step(1 / 60, params({ combustion: 6, ignition: 0.6, heatRelease: 3 }));
    const f1 = totalFuel(sim);
    const h1 = totalHeat(sim);
    checks.push(
      check(
        'No ignition below threshold',
        'Fuel colder than the ignition temperature must not burn — total fuel and total heat both stay put (only quiescent advection of a uniform field).',
        Math.abs(f1 - f0) < 1e-3 * Math.abs(f0) && Math.abs(h1 - h0) < 1e-3 * Math.abs(h0) + 1e-6,
        `∑fuel ${fmt(f0)}→${fmt(f1)}, ∑T ${fmt(h0)}→${fmt(h1)}`,
      ),
    );
  }

  // Above ignition, combustion consumes fuel and releases heat.
  {
    const sim = new FluidSolver(N);
    seedFuelHot(sim, 1.0); // hotter than ignition 0.5
    const f0 = totalFuel(sim);
    const h0 = totalHeat(sim);
    for (let s = 0; s < 20; s++)
      sim.step(1 / 60, params({ combustion: 6, ignition: 0.5, heatRelease: 3, cooling: 0 }));
    const f1 = totalFuel(sim);
    const h1 = totalHeat(sim);
    checks.push(
      check(
        'Burning consumes fuel & releases heat',
        'Above ignition the first-order reaction strictly draws down the fuel and deposits its energy into the temperature field (exothermic).',
        f1 < f0 - 0.1 && h1 > h0 + 0.1,
        `∑fuel ${fmt(f0)}→${fmt(f1)} (down), ∑T ${fmt(h0)}→${fmt(h1)} (up)`,
      ),
    );
  }

  // With the reaction off, fuel is a passive scalar — conserved by advection.
  {
    const sim = new FluidSolver(N);
    const c = (N + 1) / 2;
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = sim.IX(i, j);
        sim.u[idx] = -0.4 * (j - c) / N;
        sim.v[idx] = 0.4 * (i - c) / N;
      }
    sim.splatFuel(Math.floor(N * 0.5), Math.floor(N * 0.5), 1, 8);
    const f0 = totalFuel(sim);
    for (let s = 0; s < 30; s++) sim.step(1 / 60, params({ combustion: 0 }));
    const f1 = totalFuel(sim);
    checks.push(
      check(
        'Fuel is conserved when not burning',
        'With the reaction rate at zero, fuel is just another advected scalar — swirling it around conserves the total (no spurious sources or sinks).',
        Math.abs(f1 - f0) < 5e-3 * Math.abs(f0),
        `∑fuel ${fmt(f0)} → ${fmt(f1)} (Δ ${fmt((100 * (f1 - f0)) / f0)}%)`,
      ),
    );
  }

  return {
    title: 'Reactive flow (combustion)',
    blurb:
      'Fuel is advected like any scalar, ignites above a threshold temperature, burns at a first-order rate, and releases heat — a minimal but honest combustion model.',
    checks,
  };
}

function spectral(): CheckGroup {
  const checks: Check[] = [];

  // 1. The FFT inverts itself to machine precision (it had better).
  {
    const M = 64;
    const re = new Float64Array(M * M);
    const im = new Float64Array(M * M);
    for (let i = 0; i < M * M; i++) re[i] = Math.sin(0.1 * i) + 0.27 * (i % 13);
    const r0 = Float64Array.from(re);
    fft2d(re, im, M, false);
    fft2d(re, im, M, true);
    let err = 0;
    for (let i = 0; i < M * M; i++) err = Math.max(err, Math.abs(re[i] - r0[i]), Math.abs(im[i]));
    // also a 1-D round trip
    const a = new Float64Array(32);
    const b = new Float64Array(32);
    for (let i = 0; i < 32; i++) a[i] = Math.cos(i) - 0.4;
    const a0 = Float64Array.from(a);
    fft1d(a, b, false);
    fft1d(a, b, true);
    let err1 = 0;
    for (let i = 0; i < 32; i++) err1 = Math.max(err1, Math.abs(a[i] - a0[i]));
    checks.push(
      check(
        'FFT round-trips to machine precision',
        'The inverse FFT of a forward FFT must return the original signal exactly (a from-scratch radix-2 Cooley–Tukey transform). Tested in 1-D and 2-D.',
        err < 1e-9 && err1 < 1e-9,
        `max |ifft(fft(x)) − x| = ${fmt(err)} (2-D), ${fmt(err1)} (1-D)`,
      ),
    );
  }

  // 2. Parseval's theorem: the energy spectrum integrates to the physical energy.
  {
    const M = 64;
    const u = new Float64Array(M * M);
    const v = new Float64Array(M * M);
    for (let j = 0; j < M; j++)
      for (let i = 0; i < M; i++) {
        u[j * M + i] = Math.sin((2 * Math.PI * 3 * i) / M) * Math.cos((2 * Math.PI * 2 * j) / M) + 0.1;
        v[j * M + i] = Math.cos((2 * Math.PI * 5 * i) / M) * Math.sin((2 * Math.PI * j) / M);
      }
    const sp = energySpectrum(u, v, M);
    const ke = meanKineticEnergy(u, v, M);
    const relErr = Math.abs(sp.total - ke) / ke;
    checks.push(
      check(
        'Energy spectrum obeys Parseval',
        'No energy is created or lost moving to Fourier space: the kinetic energy summed over the spectrum ∑ₖ E(k) equals the mean physical energy ½⟨u²+v²⟩ — the guarantee that E(k) is a true decomposition of the flow’s energy by scale.',
        relErr < 1e-10,
        `∑ₖ E(k) = ${fmt(sp.total)} vs ½⟨u²+v²⟩ = ${fmt(ke)} (rel. err ${fmt(relErr)})`,
      ),
    );
  }

  // 3. A pure sinusoid lands its energy in exactly one wavenumber shell.
  {
    const M = 64;
    const kx = 6;
    const u = new Float64Array(M * M);
    const v = new Float64Array(M * M);
    for (let j = 0; j < M; j++)
      for (let i = 0; i < M; i++) u[j * M + i] = Math.cos((2 * Math.PI * kx * i) / M);
    const sp = energySpectrum(u, v, M);
    let peak = 0;
    let peakK = -1;
    for (let k = 0; k < sp.e.length; k++)
      if (sp.e[k] > peak) {
        peak = sp.e[k];
        peakK = k;
      }
    let leak = 0;
    for (let k = 0; k < sp.e.length; k++) if (k !== peakK) leak += sp.e[k];
    checks.push(
      check(
        'A single mode resolves to one shell',
        'A pure spatial sinusoid of wavenumber k carries all its energy at |k| — the spectrum must spike in that one shell with no leakage into the others (no windowing artefacts on a periodic signal).',
        peakK === kx && leak < 1e-12 * peak,
        `peak at shell k=${peakK} (expected ${kx}); leakage / peak = ${fmt(peak === 0 ? 0 : leak / peak)}`,
      ),
    );
  }

  return {
    title: 'Spectral analysis (FFT)',
    blurb:
      'A from-scratch 2-D FFT turns the velocity field into a kinetic-energy spectrum E(k) — energy by spatial scale. Its identities (invertibility, Parseval, single-mode localisation) are exact and checkable.',
    checks,
  };
}

function visualization(): CheckGroup {
  const checks: Check[] = [];
  const N = 48;
  const S = N + 2;
  const noise = makeNoise(N, 1234567);
  const u = new Float32Array(S * S);
  const v = new Float32Array(S * S);
  const out = new Float32Array(N * N);

  // With no flow, each LIC pixel convolves a single point ⇒ output = the noise.
  {
    u.fill(0);
    v.fill(0);
    computeLIC({ N, u, v, noise }, out, { steps: 16, phase: 0.3 });
    let maxErr = 0;
    for (let k = 0; k < out.length; k++) maxErr = Math.max(maxErr, Math.abs(out[k] - noise[k]));
    checks.push(
      check(
        'LIC is the identity under no flow',
        'With zero velocity every streamline is a fixed point, so the convolution reduces to sampling the noise where it already is — the texture must come back unchanged.',
        maxErr < 1e-4,
        `max|LIC − noise| = ${fmt(maxErr)}`,
      ),
    );
  }

  // LIC is a convex blend of the noise ⇒ it obeys a maximum principle.
  {
    const c = (N + 1) / 2;
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = i + S * j;
        u[idx] = -(j - c);
        v[idx] = i - c;
      }
    computeLIC({ N, u, v, noise }, out, { steps: 18 });
    let nlo = Infinity;
    let nhi = -Infinity;
    for (const x of noise) {
      if (x < nlo) nlo = x;
      if (x > nhi) nhi = x;
    }
    let olo = Infinity;
    let ohi = -Infinity;
    for (const x of out) {
      if (x < olo) olo = x;
      if (x > ohi) ohi = x;
    }
    checks.push(
      check(
        'LIC obeys a maximum principle',
        'The convolution weights are non-negative, so each output is a convex average of noise samples — it can never leave the noise’s own [min, max] range.',
        olo >= nlo - 1e-6 && ohi <= nhi + 1e-6,
        `noise [${fmt(nlo)}, ${fmt(nhi)}] → LIC [${fmt(olo)}, ${fmt(ohi)}]`,
      ),
    );
  }

  // Under a uniform shear the texture is smoother *along* the flow than across it.
  {
    u.fill(0);
    v.fill(0);
    for (let j = 0; j <= N + 1; j++) for (let i = 0; i <= N + 1; i++) u[i + S * j] = 1;
    computeLIC({ N, u, v, noise }, out, { steps: 20 });
    let along = 0;
    let across = 0;
    let na = 0;
    let nc = 0;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N - 1; i++) {
        along += Math.abs(out[j * N + i + 1] - out[j * N + i]);
        na++;
      }
    for (let j = 0; j < N - 1; j++)
      for (let i = 0; i < N; i++) {
        across += Math.abs(out[(j + 1) * N + i] - out[j * N + i]);
        nc++;
      }
    along /= na;
    across /= nc;
    checks.push(
      check(
        'LIC streaks along the flow',
        'Convolving along the streamlines smears the noise in the flow direction — so neighbouring samples vary far less along the flow than across it (the streaks you see).',
        along < 0.5 * across,
        `mean |Δ| along ${fmt(along)} vs across ${fmt(across)} (${fmt(across / along)}× smoother along)`,
      ),
    );
  }

  return {
    title: 'Flow visualisation (LIC)',
    blurb:
      'Line Integral Convolution smears a noise texture along the streamlines. It’s a pure function, so its invariants — identity, boundedness, streamwise anisotropy — are checkable too.',
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

  // A *closed-form* diffusion check. The implicit (backward-Euler) diffusion solve
  // has each grid Fourier mode as an exact eigenvector: a single cosine mode of
  // index m decays per step by exactly 1/(1 + 4a·sin²(πm/2N)), with a = κ·dt·N².
  // Seed that mode, diffuse for many steps, and compare the measured amplitude
  // decay against the analytic prediction — the discrete dispersion relation, live.
  {
    const N = 48;
    const m = 4;
    const kappa = 0.0015;
    const dt = 1 / 60;
    const K = 100;
    const sim = new FluidSolver(N);
    const j0 = Math.floor(N / 2);
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) sim.t[sim.IX(i, j)] = Math.cos((Math.PI * m * (i - 0.5)) / N);
    const ampOf = () => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 1; i <= N; i++) {
        const v = sim.t[sim.IX(i, j0)];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return hi - lo;
    };
    const a0 = ampOf();
    for (let s = 0; s < K; s++)
      sim.step(dt, params({ thermalDiffusion: kappa, iterations: 200 }));
    const measured = ampOf() / a0;
    const a = kappa * dt * N * N;
    const factor = 1 / (1 + 4 * a * Math.sin((Math.PI * m) / (2 * N)) ** 2);
    const predicted = Math.pow(factor, K);
    const relErr = Math.abs(measured - predicted) / predicted;
    checks.push(
      check(
        'Diffusion decays a Fourier mode at the analytic rate',
        'The backward-Euler diffusion solve has the grid cosine modes as exact eigenvectors. A mode’s amplitude must decay by exactly 1/(1+4a·sin²(πm/2N)) per step (a = κ·dt·N²) — the discrete dispersion relation. Measured vs closed-form, over 100 steps.',
        relErr < 1e-4,
        `amplitude ×${fmt(measured)} measured vs ×${fmt(predicted)} predicted (rel. err ${fmt(relErr)})`,
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

  // Q-criterion separates rotation from shear: a solid-body rotation is a pure
  // vortex (Q = Ω² > 0), while a uniform shear is pure strain (Q = 0).
  {
    const N = 48;
    const omega = 0.01;
    const c = (N + 1) / 2;
    const rot = new FluidSolver(N);
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = rot.IX(i, j);
        rot.u[idx] = -omega * (j - c);
        rot.v[idx] = omega * (i - c);
      }
    let qRotMin = Infinity;
    let qRotErr = 0;
    for (let j = 3; j <= N - 2; j++)
      for (let i = 3; i <= N - 2; i++) {
        const q = rot.qCriterion(i, j);
        qRotMin = Math.min(qRotMin, q);
        qRotErr = Math.max(qRotErr, Math.abs(q - omega * omega));
      }
    const shear = new FluidSolver(N);
    const gamma = 0.02;
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) shear.u[shear.IX(i, j)] = gamma * (j - c);
    let qShear = 0;
    for (let j = 3; j <= N - 2; j++)
      for (let i = 3; i <= N - 2; i++) qShear = Math.max(qShear, Math.abs(shear.qCriterion(i, j)));
    checks.push(
      check(
        'Q-criterion isolates vortices from shear',
        'The Hunt Q-criterion measures rotation minus strain. A solid-body rotation is all rotation (Q = Ω², positive everywhere); a uniform shear is all strain (Q = 0) even though it has vorticity — which is exactly why Q finds vortex cores where raw vorticity can’t.',
        qRotMin > 0 && qRotErr < 1e-8 && qShear < 1e-9,
        `rotation Q→${fmt(omega * omega)} (err ${fmt(qRotErr)}), shear |Q| ${fmt(qShear)}`,
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
    conjugateGradient(),
    multigrid(),
    transport(),
    operators(),
    thermalAndSymmetry(),
    combustion(),
    spectral(),
    visualization(),
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
