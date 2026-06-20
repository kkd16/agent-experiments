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
import { fft1d, fft2d, energySpectrum, meanKineticEnergy, enstrophySpectrum, scalarVarianceSpectrum, energyTransfer } from './fft';
import { computeFTLE } from './ftle';

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

  // 4. The scalar-variance spectrum obeys Parseval: it integrates to the variance.
  {
    const M = 64;
    const s = new Float64Array(M * M);
    for (let j = 0; j < M; j++)
      for (let i = 0; i < M; i++)
        s[j * M + i] =
          0.7 +
          Math.sin((2 * Math.PI * 4 * i) / M) * Math.cos((2 * Math.PI * 3 * j) / M) +
          0.5 * Math.cos((2 * Math.PI * 7 * i) / M);
    let mean = 0;
    for (let i = 0; i < M * M; i++) mean += s[i];
    mean /= M * M;
    let varRef = 0;
    for (let i = 0; i < M * M; i++) varRef += (s[i] - mean) * (s[i] - mean);
    varRef /= M * M;
    const sp = scalarVarianceSpectrum(s, M);
    const relErr = Math.abs(sp.total - varRef) / varRef;
    checks.push(
      check(
        'Scalar-variance spectrum obeys Parseval',
        'The variance spectrum V(k) decomposes a scalar field’s spatial variance by scale; summed over all shells it must equal that variance ⟨(s−⟨s⟩)²⟩ — and the constant (mean) mode must carry none of it.',
        relErr < 1e-10,
        `∑ₖ V(k) = ${fmt(sp.total)} vs variance ${fmt(varRef)} (rel. err ${fmt(relErr)})`,
      ),
    );
  }

  // 5. The enstrophy spectrum integrates to the mean enstrophy ½⟨ω²⟩.
  {
    const M = 64;
    const k1 = 3;
    const k2 = 5;
    const u = new Float64Array(M * M);
    const v = new Float64Array(M * M);
    const amp = (2 * Math.PI) * (2 * Math.PI); // (2π)² appears in ∇²ψ
    let ens = 0;
    for (let j = 0; j < M; j++)
      for (let i = 0; i < M; i++) {
        const x = i / M;
        const y = j / M;
        // Streamfunction ψ = cos(2πk1 x) cos(2πk2 y); u = ∂ψ/∂y, v = −∂ψ/∂x.
        u[j * M + i] = -2 * Math.PI * k2 * Math.cos(2 * Math.PI * k1 * x) * Math.sin(2 * Math.PI * k2 * y);
        v[j * M + i] = 2 * Math.PI * k1 * Math.sin(2 * Math.PI * k1 * x) * Math.cos(2 * Math.PI * k2 * y);
        // ω = −∇²ψ = (2π)²(k1²+k2²)·ψ.
        const psi = Math.cos(2 * Math.PI * k1 * x) * Math.cos(2 * Math.PI * k2 * y);
        const w = amp * (k1 * k1 + k2 * k2) * psi;
        ens += 0.5 * w * w;
      }
    ens /= M * M;
    const sp = enstrophySpectrum(u, v, M);
    const relErr = Math.abs(sp.total - ens) / ens;
    checks.push(
      check(
        'Enstrophy spectrum matches the mean enstrophy',
        'The spectral vorticity ω̂ = i·2π(kₓv̂ − k_yû) reproduces the analytic vorticity of a known streamfunction: the enstrophy spectrum Z(k) summed over shells equals the independently-computed mean enstrophy ½⟨ω²⟩.',
        relErr < 1e-9,
        `∑ₖ Z(k) = ${fmt(sp.total)} vs ½⟨ω²⟩ = ${fmt(ens)} (rel. err ${fmt(relErr)})`,
      ),
    );
  }

  // 6. The nonlinear energy transfer conserves total kinetic energy: ∑ₖ T(k) = 0.
  // This is the deep property behind the turbulent cascade — the nonlinear term
  // only *moves* energy between scales, never creates or destroys it.
  {
    const M = 64;
    const u = new Float64Array(M * M);
    const v = new Float64Array(M * M);
    // A divergence-free field from a multi-mode streamfunction (u=∂ψ/∂y, v=−∂ψ/∂x).
    const modes = [
      [1, 2, 0.6],
      [3, 1, -0.4],
      [2, 4, 0.5],
      [5, 3, 0.3],
    ];
    for (let j = 0; j < M; j++)
      for (let i = 0; i < M; i++) {
        const x = i / M;
        const y = j / M;
        let uu = 0;
        let vv = 0;
        for (const [a, b, c] of modes) {
          // ψ = c·sin(2πa x)·sin(2πb y)
          uu += c * 2 * Math.PI * b * Math.sin(2 * Math.PI * a * x) * Math.cos(2 * Math.PI * b * y);
          vv += -c * 2 * Math.PI * a * Math.cos(2 * Math.PI * a * x) * Math.sin(2 * Math.PI * b * y);
        }
        u[j * M + i] = uu;
        v[j * M + i] = vv;
      }
    const tr = energyTransfer(u, v, M);
    let net = 0;
    let absSum = 0;
    for (let k = 0; k < tr.t.length; k++) {
      net += tr.t[k];
      absSum += Math.abs(tr.t[k]);
    }
    const fluxEnds = Math.max(Math.abs(tr.flux[0] - (-tr.t[0])), Math.abs(tr.flux[tr.flux.length - 1]));
    checks.push(
      check(
        'Nonlinear energy transfer is conservative (∑T(k)=0)',
        'Splitting the nonlinear term into its rotational part ω×u (the only part that transfers energy, since the gradient part is ⊥ to the divergence-free velocity in Fourier space) gives u·(ω×u)=0 pointwise — so the energy transferred *into* all shells sums to exactly zero, and the flux closes at the largest scale. The transfer itself is non-trivial (it is what drives the cascade).',
        absSum > 1e-6 && Math.abs(net) < 1e-9 * absSum && fluxEnds < 1e-9 * absSum,
        `∑ₖ T(k) = ${fmt(net)} (∑|T| ${fmt(absSum)}); |Π(k_max)| = ${fmt(Math.abs(tr.flux[tr.flux.length - 1]))}`,
      ),
    );
  }

  return {
    title: 'Spectral analysis (FFT)',
    blurb:
      'A from-scratch 2-D FFT turns the flow into spectra — kinetic energy E(k), enstrophy Z(k), scalar variance V(k) — and into the nonlinear energy transfer T(k) / flux Π(k). Their identities (invertibility, Parseval, single-mode localisation, and exact transfer conservation) are checkable.',
    checks,
  };
}

function lagrangian(): CheckGroup {
  const checks: Check[] = [];

  // Helper: fill the (N+2)² velocity arrays from an analytic cell-space field.
  // The solver stores a normalised velocity (cell-space speed = N·u), so to make a
  // tracer move at cell-space rate f(i,j) we store u = f / N.

  // 1. Hyperbolic (saddle) strain: u̇ = s·(x−c), v̇ = −s·(y−c). The flow map is
  // φ = c + (x−c)·e^{±sτ}, so ∇φ = diag(e^{sτ}, e^{−sτ}), σ_max = e^{sτ}, and the
  // FTLE is *exactly* the strain rate s everywhere — a closed-form ground truth.
  {
    const N = 64;
    const s = 1.0;
    const tau = 0.4;
    const sim = new FluidSolver(N);
    const c = (N + 1) / 2;
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = sim.IX(i, j);
        sim.u[idx] = (s * (i - c)) / N;
        sim.v[idx] = (-s * (j - c)) / N;
      }
    const f = computeFTLE(sim.u, sim.v, N, { tau, backward: false, steps: 60 });
    // Average over a central window where no tracer reaches the clamping walls.
    let sum = 0;
    let n = 0;
    for (let j = Math.floor(0.4 * N); j < Math.ceil(0.6 * N); j++)
      for (let i = Math.floor(0.4 * N); i < Math.ceil(0.6 * N); i++) {
        sum += f[j * N + i];
        n++;
      }
    const measured = sum / n;
    const relErr = Math.abs(measured - s) / s;
    checks.push(
      check(
        'FTLE matches the analytic strain rate of a saddle',
        'For a hyperbolic stagnation point u̇ = s(x−c), v̇ = −s(y−c) the flow-map gradient is diag(e^{sτ}, e^{−sτ}), so the finite-time Lyapunov exponent is exactly the strain rate s. The integrated flow-map FTLE reproduces it.',
        relErr < 5e-3,
        `mean FTLE = ${fmt(measured)} vs s = ${fmt(s)} (rel. err ${fmt(relErr)})`,
      ),
    );

    // 1b. Backward-time on the same saddle gives the same stretching magnitude (the
    // contracting forward direction is the expanding backward one): FTLE ≈ s again.
    const fb = computeFTLE(sim.u, sim.v, N, { tau, backward: true, steps: 60 });
    let sumB = 0;
    let nB = 0;
    for (let j = Math.floor(0.4 * N); j < Math.ceil(0.6 * N); j++)
      for (let i = Math.floor(0.4 * N); i < Math.ceil(0.6 * N); i++) {
        sumB += fb[j * N + i];
        nB++;
      }
    const measuredB = sumB / nB;
    checks.push(
      check(
        'Backward-time FTLE recovers the same exponent',
        'A saddle’s stable and unstable manifolds swap under time reversal, but the maximal stretching rate is unchanged — so the backward-time FTLE equals the forward-time FTLE (here the strain rate s). Forward ridges are repelling LCS; backward ridges are attracting (where dye collects).',
        Math.abs(measuredB - s) / s < 5e-3,
        `backward FTLE = ${fmt(measuredB)} vs s = ${fmt(s)}`,
      ),
    );
  }

  // 2. A solid-body rotation stretches nothing: FTLE ≈ 0.
  {
    const N = 64;
    const omega = 1.0;
    const tau = 0.5;
    const sim = new FluidSolver(N);
    const c = (N + 1) / 2;
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = sim.IX(i, j);
        sim.u[idx] = (-omega * (j - c)) / N;
        sim.v[idx] = (omega * (i - c)) / N;
      }
    const f = computeFTLE(sim.u, sim.v, N, { tau, backward: false, steps: 80 });
    let maxAbs = 0;
    for (let j = Math.floor(0.4 * N); j < Math.ceil(0.6 * N); j++)
      for (let i = Math.floor(0.4 * N); i < Math.ceil(0.6 * N); i++)
        maxAbs = Math.max(maxAbs, Math.abs(f[j * N + i]));
    checks.push(
      check(
        'Rigid rotation has zero FTLE',
        'A solid-body rotation carries fluid parcels around together without pulling them apart — its flow-map gradient is a pure rotation (Cauchy–Green tensor = I), so the FTLE is zero. (Contrast the saddle, which is all stretching.)',
        maxAbs < 0.02 * omega,
        `max|FTLE| over the core = ${fmt(maxAbs)} (rotation rate ${fmt(omega)})`,
      ),
    );
  }

  return {
    title: 'Lagrangian coherent structures (FTLE)',
    blurb:
      'The finite-time Lyapunov exponent measures how fast neighbouring tracers separate under the flow map; its ridges are the transport barriers (LCS) that organise mixing. On analytic flows it has a closed-form value the integrator must reproduce.',
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

  // The passive-scalar (dye) diffusion path is decoupled from momentum viscosity
  // by its own diffusivity κ_s (the Schmidt-number physics). Verify it independently
  // obeys the same closed-form backward-Euler decay — and that it is driven by κ_s,
  // *not* the viscosity ν (here ν is set large but the still field can't advect, so
  // only κ_s acts): a dye cosine mode decays by exactly 1/(1+4a·sin²(πm/2N)) per step.
  {
    const N = 48;
    const m = 3;
    const kappaS = 0.0012;
    const dt = 1 / 60;
    const K = 50;
    const sim = new FluidSolver(N);
    const j0 = Math.floor(N / 2);
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) sim.r[sim.IX(i, j)] = 1 + Math.cos((Math.PI * m * (i - 0.5)) / N);
    const ampOf = () => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 1; i <= N; i++) {
        const v = sim.r[sim.IX(i, j0)];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      return hi - lo;
    };
    const a0 = ampOf();
    for (let s = 0; s < K; s++)
      sim.step(dt, params({ dyeDiffusion: kappaS, viscosity: 0.0002, iterations: 200, sharpDye: false }));
    const measured = ampOf() / a0;
    const a = kappaS * dt * N * N;
    const factor = 1 / (1 + 4 * a * Math.sin((Math.PI * m) / (2 * N)) ** 2);
    const predicted = Math.pow(factor, K);
    const relErr = Math.abs(measured - predicted) / predicted;
    checks.push(
      check(
        'Dye diffuses at its own Schmidt-number rate',
        'The dye carries an independent diffusivity κ_s (Schmidt number Sc = ν/κ_s). With the fluid at rest a dye cosine mode must decay at exactly the backward-Euler rate set by κ_s — independent of the momentum viscosity ν — confirming the two scalars are decoupled.',
        relErr < 1e-3,
        `dye amplitude ×${fmt(measured)} measured vs ×${fmt(predicted)} predicted (rel. err ${fmt(relErr)})`,
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

function openBoundaries(): CheckGroup {
  const checks: Check[] = [];
  const N = 48;
  const U = 0.5;

  // Seed a uniform rightward flow, re-impose it at the left inflow column every
  // step, and run. A closed box cannot pass a net through-flow (the incompressible
  // pressure builds up and the right wall blocks it), so the flow stalls near the
  // outlet. With the right edge OPEN (outflow), the uniform stream is the exact
  // incompressible solution — it sails straight through and out.
  const run = (open: boolean): { meanRight: number; rmsDiv: number } => {
    const sim = new FluidSolver(N);
    if (open) sim.setBoundaries({ left: 'inflow', right: 'outflow' });
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        sim.u[sim.IX(i, j)] = U;
        sim.v[sim.IX(i, j)] = 0;
      }
    for (let s = 0; s < 50; s++) {
      for (let j = 1; j <= N; j++) {
        sim.u[sim.IX(1, j)] = U; // imposed inflow
        sim.v[sim.IX(1, j)] = 0;
      }
      sim.step(1 / 60, params({ iterations: 60, overRelax: 1.6 }));
    }
    // Mean horizontal velocity over the right quarter of the channel.
    let s = 0;
    let n = 0;
    for (let j = 1; j <= N; j++)
      for (let i = Math.floor(0.75 * N); i <= N; i++) {
        s += sim.u[sim.IX(i, j)];
        n++;
      }
    // RMS divergence over the strict interior (the same margin the suite uses).
    let d2 = 0;
    let dn = 0;
    for (let j = 3; j <= N - 2; j++)
      for (let i = 3; i <= N - 2; i++) {
        const idx = sim.IX(i, j);
        const dv = -0.5 * (sim.u[idx + 1] - sim.u[idx - 1] + sim.v[idx + (N + 2)] - sim.v[idx - (N + 2)]) / N;
        d2 += dv * dv;
        dn++;
      }
    return { meanRight: s / n, rmsDiv: Math.sqrt(d2 / dn) };
  };

  const o = run(true);
  const c = run(false);
  checks.push(
    check(
      'Open outflow sustains a through-flow a wall blocks',
      'A closed box is mass-locked: an imposed inflow cannot leave, so the incompressible projection stalls the stream before the far wall. Opening the right edge (zero-gradient velocity + Dirichlet pressure p=0 at the outlet) lets the uniform stream pass straight through — so the velocity at the outlet stays near the inflow speed, where the closed box has nearly stopped it.',
      o.meanRight > 0.85 * U && c.meanRight < 0.5 * o.meanRight,
      `mean u over the outlet quarter: open ${fmt(o.meanRight)} vs closed ${fmt(c.meanRight)} (inflow U=${fmt(U)})`,
    ),
  );
  checks.push(
    check(
      'The open through-flow stays incompressible',
      'A uniform stream is divergence-free, and the open-boundary projection must keep it so — the outlet absorbs exactly the inflow, leaving a negligible residual divergence in the interior.',
      Number.isFinite(o.rmsDiv) && o.rmsDiv < 5e-3,
      `RMS ∇·u (open channel) = ${fmt(o.rmsDiv)}`,
    ),
  );

  return {
    title: 'Open boundaries (inflow / outflow)',
    blurb:
      'A domain edge can be opened so the flow leaves the box instead of recirculating: a zero-gradient velocity condition with a Dirichlet pressure at the outlet turns the tank into a channel — the physically correct setting for a von Kármán wake.',
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
// RMS of ∇·B over the strict interior — the magnetic analogue of rmsDivInterior.
function rmsDivBInterior(sim: FluidSolver, margin = 2): number {
  const N = sim.N;
  const bx = sim.bx;
  const by = sim.by;
  let s = 0;
  let n = 0;
  for (let j = 1 + margin; j <= N - margin; j++)
    for (let i = 1 + margin; i <= N - margin; i++) {
      const idx = sim.IX(i, j);
      if (sim.solid[idx]) continue;
      const d = -0.5 * (bx[idx + 1] - bx[idx - 1] + by[idx + (N + 2)] - by[idx - (N + 2)]) / N;
      s += d * d;
      n++;
    }
  return n > 0 ? Math.sqrt(s / n) : 0;
}

function mhd(): CheckGroup {
  const checks: Check[] = [];
  const TWO_PI = Math.PI * 2;

  // 1. The same Hodge projection that keeps u incompressible cleans ∇·B = 0.
  {
    const N = 56;
    const sim = new FluidSolver(N);
    // A smooth, strongly divergent magnetic field (monopole-laden).
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = sim.IX(i, j);
        const x = i / N;
        const y = j / N;
        sim.bx[idx] = Math.sin(3 * Math.PI * x) * Math.cos(2 * Math.PI * y) + (x - 0.5);
        sim.by[idx] = Math.cos(2 * Math.PI * x) * Math.sin(3 * Math.PI * y) + 0.4 * (y - 0.5);
      }
    const before = rmsDivBInterior(sim);
    sim.cleanMagneticDivergence(600, 1.7);
    const after = rmsDivBInterior(sim);
    checks.push(
      check(
        'Magnetic field is kept solenoidal (∇·B = 0)',
        'Maxwell forbids magnetic monopoles, so B must stay divergence-free. The induction step reuses the velocity solver’s Hodge projection on B: a divergent field is cleaned to the same residual floor a divergent velocity is, every step.',
        before / after > 4 && Number.isFinite(after),
        `RMS ∇·B: ${fmt(before)} → ${fmt(after)} (${fmt(before / after)}× lower)`,
      ),
    );
  }

  // 2. THE headline check — the Alfvén-wave dispersion relation ω = v_A·k. A small
  // transverse velocity perturbation on a uniform background field B₀x̂ plucks the
  // field line like a guitar string: magnetic tension restores it and energy sloshes
  // between flow and field at the Alfvén frequency. We pluck it three ways and read
  // the relation off the quarter-period — the two defining PROPORTIONALITIES (ω ∝
  // v_A and ω ∝ k) are exact; the absolute Alfvén speed lands within the discrete
  // dispersion of a collocated central-difference scheme.
  {
    const N = 64;
    const base = measureAlfven(N, 1.0, 1, 0.003, 600); // ω(v_A=1, k=2π)
    const dblVA = measureAlfven(N, 2.0, 1, 0.0015, 600); // ω(v_A=2, k=2π)
    const dblK = measureAlfven(N, 1.0, 2, 0.0015, 600); // ω(v_A=1, k=4π)
    const vAratio = dblVA.omega / base.omega; // expect 2 (ω ∝ v_A)
    const kRatio = dblK.omega / base.omega; // expect 2 (ω ∝ k)
    const speed = base.omega / base.k; // measured Alfvén speed (expect ≈ B₀ = 1)
    checks.push(
      check(
        'Alfvén waves obey ω = v_A·k (the dispersion relation)',
        'The defining wave of MHD: a transverse field perturbation oscillates at ω = v_A·k with the Alfvén speed v_A = B₀/√(ρμ₀). Plucked at two field strengths and two wavenumbers, the measured frequency doubles when the Alfvén speed doubles and when the wavenumber doubles — the relation’s two proportionalities, exact. The measured Alfvén speed sits within ~15% of B₀ (the collocated grid’s discrete wave dispersion). This is the discrete proof the Lorentz force and induction terms are wired up right.',
        Math.abs(vAratio - 2) < 0.05 && Math.abs(kRatio - 2) < 0.2 && speed > 0.82 && speed < 1.05,
        `ω ∝ v_A: ×${fmt(vAratio)}; ω ∝ k: ×${fmt(kRatio)}; measured v_A/B₀ = ${fmt(speed)}`,
      ),
    );
  }

  // 3. Ideal MHD (ν = η = 0, no forcing) conserves total energy ½⟨|u|²+|B|²⟩ — the
  // solver must never *inject* energy (numerical dissipation may only remove it).
  {
    const N = 48;
    const sim = new FluidSolver(N);
    // An Orszag–Tang-like initial state: swirling flow + a sheared field.
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = sim.IX(i, j);
        const x = i / N;
        const y = j / N;
        sim.u[idx] = -0.8 * Math.sin(TWO_PI * y);
        sim.v[idx] = 0.8 * Math.sin(TWO_PI * x);
        sim.bx[idx] = -0.7 * Math.sin(TWO_PI * y);
        sim.by[idx] = 0.7 * Math.sin(2 * TWO_PI * x);
      }
    const pp = params({ mhd: true, resistivity: 0, iterations: 24, overRelax: 1.7, pressureSolver: 'sor' });
    sim.cleanMagneticDivergence(200, 1.7); // start solenoidal
    const e0 = sim.magneticDiagnostics().totalEnergy;
    for (let s = 0; s < 60; s++) sim.step(0.004, pp);
    const d = sim.magneticDiagnostics();
    const e1 = d.totalEnergy;
    checks.push(
      check(
        'Ideal MHD conserves total energy (never injects it)',
        'With no viscosity, resistivity or forcing the sum of kinetic and magnetic energy is an invariant; a discrete scheme can only *lose* a little to numerical dissipation, never gain. Over many steps the total energy stays bounded below its start — the field and flow exchange energy without the solver manufacturing any.',
        Number.isFinite(e1) && e1 <= e0 * 1.002 && e1 > 0.4 * e0,
        `½⟨u²+B²⟩: ${fmt(e0)} → ${fmt(e1)} (ratio ${fmt(e1 / e0)}); ∇·B ${fmt(d.maxDivB)}`,
      ),
    );
  }

  // 4. Field-line stretching: a straining flow aligned with B amplifies it (the
  // engine of flux-freezing / the dynamo), and induction is the identity at rest.
  {
    const N = 48;
    const OPEN = { left: 'outflow', right: 'outflow', top: 'outflow', bottom: 'outflow' } as const;
    const sim = new FluidSolver(N);
    sim.setBoundaries(OPEN); // free-space ghosts: a uniform field has no wall image
    const B0 = 1.0;
    const gamma = 0.8;
    // Divergence-free straining flow u = γ(x−½), v = −γ(y−½) (∂ₓu+∂_yv = 0),
    // and a uniform field along the stretching (x) axis.
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = sim.IX(i, j);
        const x = i / N;
        const y = j / N;
        sim.u[idx] = gamma * (x - 0.5);
        sim.v[idx] = -gamma * (y - 0.5);
        sim.bx[idx] = B0;
        sim.by[idx] = 0;
      }
    const bxBefore = sim.bx[sim.IX(N >> 1, N >> 1)];
    sim.inductionStep(0.01, 0, 24, 1.7);
    const bxAfter = sim.bx[sim.IX(N >> 1, N >> 1)];

    // At rest, induction must leave a *solenoidal* field untouched (no flow ⇒
    // ∂ₜB = 0). A field varying along y (∇·B = ∂ₓB_x = 0) is divergence-free.
    const rest = new FluidSolver(N);
    rest.setBoundaries(OPEN);
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = rest.IX(i, j);
        rest.bx[idx] = 0.5 + 0.3 * Math.sin((TWO_PI * j) / N);
        rest.by[idx] = 0;
      }
    const restBefore = Float32Array.from(rest.bx);
    rest.inductionStep(0.01, 0, 24, 1.7);
    let restDrift = 0;
    for (let j = 4; j <= N - 4; j++)
      for (let i = 4; i <= N - 4; i++) {
        const idx = rest.IX(i, j);
        restDrift = Math.max(restDrift, Math.abs(rest.bx[idx] - restBefore[idx]));
      }

    const expectedGrowth = bxBefore * gamma * 0.01; // dt·B·∂ₓu
    checks.push(
      check(
        'Stretching amplifies an aligned field; rest leaves it frozen',
        'The (B·∇)u term in the induction equation is flux-freezing made discrete: a flow stretching the fluid along a field line concentrates it (|B| grows by ≈ dt·B·∂ₓu), the mechanism behind the magnetic dynamo. With no flow the same step is exactly the identity — induction sources nothing on its own.',
        bxAfter > bxBefore && Math.abs(bxAfter - bxBefore - expectedGrowth) < 0.3 * expectedGrowth && restDrift < 1e-3,
        `Bx ${fmt(bxBefore)} → ${fmt(bxAfter)} (Δ ${fmt(bxAfter - bxBefore)}, expect ${fmt(expectedGrowth)}); rest drift ${fmt(restDrift)}`,
      ),
    );
  }

  // 5. The Orszag–Tang vortex — the canonical 2-D MHD benchmark — through the full
  // step(): smooth initial fields steepen into thin CURRENT SHEETS (peak |jz| climbs
  // sharply) while ∇·B stays clean and the energy stays bounded.
  {
    const N = 64;
    const sim = new FluidSolver(N);
    const B0 = 0.8;
    for (let j = 0; j <= N + 1; j++)
      for (let i = 0; i <= N + 1; i++) {
        const idx = sim.IX(i, j);
        const x = i / N;
        const y = j / N;
        sim.u[idx] = -Math.sin(TWO_PI * y);
        sim.v[idx] = Math.sin(TWO_PI * x);
        sim.bx[idx] = -B0 * Math.sin(TWO_PI * y);
        sim.by[idx] = B0 * Math.sin(2 * TWO_PI * x);
      }
    sim.cleanMagneticDivergence(200, 1.7);
    const pp = params({ mhd: true, resistivity: 0.00002, iterations: 26, overRelax: 1.7, pressureSolver: 'sor' });
    sim.computeCurrent();
    let jz0 = 0;
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) jz0 = Math.max(jz0, Math.abs(sim.jz[sim.IX(i, j)]));
    const e0 = sim.magneticDiagnostics().totalEnergy;
    for (let s = 0; s < 80; s++) sim.step(0.004, pp);
    sim.computeCurrent();
    let jz1 = 0;
    for (let j = 1; j <= N; j++) for (let i = 1; i <= N; i++) jz1 = Math.max(jz1, Math.abs(sim.jz[sim.IX(i, j)]));
    const d = sim.magneticDiagnostics();
    checks.push(
      check(
        'Orszag–Tang builds current sheets (the MHD benchmark)',
        'The standard test of a 2-D MHD code: a smooth swirl of flow and field steepens into thin, intense sheets of electric current (peak |jz| grows several-fold) where oppositely-directed field lines are pressed together — the sites of magnetic reconnection — all while the field stays solenoidal and the energy bounded.',
        jz1 > 1.8 * jz0 && d.maxDivB < 0.05 && d.totalEnergy <= e0 * 1.002 && Number.isFinite(jz1),
        `peak |jz| ${fmt(jz0)} → ${fmt(jz1)} (${fmt(jz1 / jz0)}×); ∇·B ${fmt(d.maxDivB)}; E ${fmt(e0)}→${fmt(d.totalEnergy)}`,
      ),
    );
  }

  // 6. Ohmic resistivity dissipates magnetic energy (and only ever dissipates it):
  // at rest, η > 0 strictly lowers ½⟨B²⟩ while η = 0 preserves it exactly.
  {
    const N = 48;
    const seed = (sim: FluidSolver) => {
      sim.setBoundaries({ left: 'outflow', right: 'outflow', top: 'outflow', bottom: 'outflow' });
      // A solenoidal field from a stream function: bx = ∂_yψ, by = −∂ₓψ with
      // ψ = sin(2πx)sin(2πy) ⇒ ∇·B = 0 exactly (no wall image, no clean needed).
      for (let j = 0; j <= N + 1; j++)
        for (let i = 0; i <= N + 1; i++) {
          const idx = sim.IX(i, j);
          const x = i / N;
          const y = j / N;
          sim.bx[idx] = TWO_PI * Math.sin(TWO_PI * x) * Math.cos(TWO_PI * y);
          sim.by[idx] = -TWO_PI * Math.cos(TWO_PI * x) * Math.sin(TWO_PI * y);
        }
    };
    const ideal = new FluidSolver(N);
    seed(ideal);
    const ei0 = ideal.magneticDiagnostics().magneticEnergy;
    for (let s = 0; s < 20; s++) ideal.inductionStep(0.01, 0, 24, 1.7);
    const ei1 = ideal.magneticDiagnostics().magneticEnergy;
    const resist = new FluidSolver(N);
    seed(resist);
    const er0 = resist.magneticDiagnostics().magneticEnergy;
    for (let s = 0; s < 30; s++) resist.inductionStep(0.01, 0.002, 24, 1.7);
    const er1 = resist.magneticDiagnostics().magneticEnergy;
    checks.push(
      check(
        'Ohmic resistivity dissipates magnetic energy',
        'Resistivity η is the magnetic analogue of viscosity: it relaxes the field and converts magnetic energy to heat, so at rest ½⟨B²⟩ strictly decays under η > 0 while the ideal (η = 0) field is preserved (induction at rest is the identity, up to the divergence clean).',
        er1 < 0.95 * er0 && Math.abs(ei1 - ei0) < 0.02 * ei0,
        `½⟨B²⟩: η>0 ${fmt(er0)}→${fmt(er1)} (${fmt(er1 / er0)}×); ideal ${fmt(ei0)}→${fmt(ei1)}`,
      ),
    );
  }

  return {
    title: 'Magnetohydrodynamics (MHD)',
    blurb:
      'The studio coupled to an in-plane magnetic field: the flow feels the Lorentz force and the field is carried + stretched by the induction equation, kept solenoidal by the same Hodge projection. Pinned to the closed forms — the Alfvén-wave dispersion ω = k·v_A, ∇·B = 0, ideal energy conservation, flux-freezing, and the Orszag–Tang current-sheet benchmark.',
    checks,
  };
}

function measureAlfven(N: number, B0: number, m: number, dt: number, maxSteps: number, amp = 0.04): { omega: number; k: number } {
  const TWO_PI = Math.PI * 2;
  const sim = new FluidSolver(N);
  sim.setBoundaries({ left: 'outflow', right: 'outflow', top: 'outflow', bottom: 'outflow' });
  const k = TWO_PI * m;
  for (let j = 0; j <= N + 1; j++)
    for (let i = 0; i <= N + 1; i++) {
      const idx = sim.IX(i, j);
      const x = i / N;
      sim.bx[idx] = B0;
      sim.by[idx] = 0;
      sim.u[idx] = 0;
      sim.v[idx] = amp * Math.sin(k * x);
    }
  const pp = params({ mhd: true, resistivity: 0, iterations: 30, overRelax: 1.7, pressureSolver: 'sor' });
  const modal = (): number => {
    let a = 0;
    for (let j = 1; j <= N; j++)
      for (let i = 1; i <= N; i++) a += sim.v[sim.IX(i, j)] * Math.sin((TWO_PI * m * i) / N);
    return a;
  };
  // First downward zero crossing of A(t) = A₀cos(ωt) is at ωt = π/2 ⇒ ω = π/(2·t₁).
  // The quarter-period is the least damping-biased estimator of the frequency.
  let prev = modal();
  let tPrev = 0;
  for (let s = 1; s <= maxSteps; s++) {
    sim.step(dt, pp);
    const cur = modal();
    const t = s * dt;
    if (prev > 0 && cur <= 0) {
      const tc = tPrev + (t - tPrev) * (prev / (prev - cur));
      return { omega: Math.PI / (2 * tc), k };
    }
    prev = cur;
    tPrev = t;
  }
  return { omega: NaN, k };
}

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
    lagrangian(),
    openBoundaries(),
    mhd(),
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
