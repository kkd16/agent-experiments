/**
 * Quantitative verification experiments.
 *
 * The point of this module is to prove — with numbers, not pictures — that the
 * FDTD engine actually solves Maxwell's equations. Each experiment runs the real
 * solver headlessly (no GPU, no DOM), measures a physical observable, and
 * compares it to a closed-form result derived independently from electromagnetic
 * theory. A green check means the code agrees with Fresnel / Drude / the FDTD
 * numerical-dispersion relation to the stated tolerance.
 *
 * Everything here is a pure function of its inputs and RNG-free, so the same run
 * gives the same numbers in the browser and in a headless Node harness.
 */

import { FDTD, COURANT } from './FDTD';
import { fresnelReflectance, type DispersionModel } from './dispersion';

export interface Metric {
  label: string;
  value: string;
}

export interface ExperimentResult {
  id: string;
  title: string;
  summary: string;
  /** primary measured number and the theoretical target */
  measured: number;
  theory: number;
  unit: string;
  /** relative or absolute error, whichever the experiment documents */
  error: number;
  tolerance: number;
  pass: boolean;
  metrics: Metric[];
  /** optional (x, measured, theory) triples for a small chart */
  series?: { x: number; measured: number; theory: number }[];
  seriesLabel?: { x: string; y: string };
}

/** A single-bin DFT (real signal) → complex amplitude at angular freq ω. */
class Goertzel {
  private i = 0;
  private q = 0;
  private n = 0;
  private readonly omega: number;
  constructor(omega: number) {
    this.omega = omega;
  }
  push(x: number): void {
    const p = this.omega * this.n;
    this.i += x * Math.cos(p);
    this.q += x * Math.sin(p);
    this.n++;
  }
  amplitude(): number {
    return this.n > 0 ? (2 * Math.hypot(this.i, this.q)) / this.n : 0;
  }
  phase(): number {
    return Math.atan2(this.q, this.i);
  }
}

interface MediumSpec {
  epsR: number;
  disp?: DispersionModel;
  dispId?: number;
}

/**
 * Measure the normal-incidence power reflectance |r|² of a half-space by the
 * reference-subtraction method: run once in vacuum to record the incident field
 * at a probe, run again with the medium in place, and the difference is the
 * reflected field. The amplitude ratio at the source frequency is |r|.
 */
function measureReflectance(medium: MediumSpec, wavelength: number): number {
  const nx = 300;
  const ny = 80;
  const xSrc = 36;
  const xProbe = 120;
  const xIface = 205;
  const cy = ny >> 1;
  const steps = 1900;
  // record over a steady window after the reflection has established
  const winStart = 1050;
  const halfLen = cy; // full-height line source → a clean plane wave (the PML
  // harmlessly absorbs the parts that overlap it)

  const build = (withMedium: boolean) => {
    const f = new FDTD(nx, ny);
    f.setBoundaryMode('cpml');
    if (withMedium) {
      f.paintRect(xIface, 0, nx - 1, ny - 1, {
        epsR: medium.epsR,
        loss: 0,
        pec: false,
        disp: medium.disp,
        dispId: medium.dispId,
      });
    }
    f.addSource({ x: xSrc, y: cy, kind: 'sine', wavelength, amplitude: 1, halfLen });
    return f;
  };

  const omega = (2 * Math.PI * COURANT) / wavelength; // radians per step
  // average a few center rows to suppress transverse ripple
  const rows = [cy - 6, cy, cy + 6];
  const incBins = rows.map(() => new Goertzel(omega));
  const refBins = rows.map(() => new Goertzel(omega));

  const fInc = build(false);
  const fTot = build(true);
  for (let n = 0; n < steps; n++) {
    fInc.step();
    fTot.step();
    if (n >= winStart) {
      for (let r = 0; r < rows.length; r++) {
        const k = xProbe + rows[r] * nx;
        const inc = fInc.ez[k];
        const tot = fTot.ez[k];
        incBins[r].push(inc);
        refBins[r].push(tot - inc);
      }
    }
  }
  let sum = 0;
  for (let r = 0; r < rows.length; r++) {
    const aInc = incBins[r].amplitude();
    const aRef = refBins[r].amplitude();
    const ratio = aInc > 0 ? aRef / aInc : 0;
    sum += ratio * ratio;
  }
  return sum / rows.length; // power reflectance
}

/** Fresnel reflection at a glass interface (non-dispersive), normal incidence. */
export function expFresnel(): ExperimentResult {
  const n = 1.5; // glass
  const wavelength = 24; // long enough that the step-index reflection error is tiny
  const measured = measureReflectance({ epsR: n * n }, wavelength);
  const r = (1 - n) / (1 + n);
  const theory = r * r;
  const error = Math.abs(measured - theory) / theory;
  const tolerance = 0.06;
  return {
    id: 'fresnel',
    title: 'Fresnel reflection at a dielectric interface',
    summary:
      'A plane wave hits a vacuum→glass (n = 1.5) interface at normal incidence. ' +
      'The measured power reflectance must match the Fresnel value R = ((1−n)/(1+n))².',
    measured,
    theory,
    unit: '',
    error,
    tolerance,
    pass: error <= tolerance,
    metrics: [
      { label: 'index n', value: n.toFixed(3) },
      { label: 'measured R', value: (measured * 100).toFixed(2) + '%' },
      { label: 'Fresnel R', value: (theory * 100).toFixed(2) + '%' },
      { label: 'rel. error', value: (error * 100).toFixed(2) + '%' },
    ],
  };
}

/**
 * Recover the Drude permittivity by measuring |r|²(ω) across a band and comparing
 * to the analytic Fresnel reflectance of ε(ω) = ε∞ − ωp²/(ω²+iγω).
 */
export function expDrude(): ExperimentResult {
  const wp = (2 * Math.PI) / 18; // plasma wavelength ≈ 18 cells
  const gamma = wp * 0.05; // light damping
  const epsInf = 1;
  const model: DispersionModel = { kind: 'drude', wp, gamma };
  const wavelengths = [12, 16, 20, 26, 34];
  const series: { x: number; measured: number; theory: number }[] = [];
  let sumSqErr = 0;
  let worst = 0;
  for (const wl of wavelengths) {
    const measured = measureReflectance({ epsR: epsInf, disp: model, dispId: 200 }, wl);
    const omega = (2 * Math.PI) / wl; // rad per time unit
    const theory = fresnelReflectance(model, epsInf, omega);
    series.push({ x: wl, measured, theory });
    const e = Math.abs(measured - theory);
    sumSqErr += e * e;
    worst = Math.max(worst, e);
  }
  const rms = Math.sqrt(sumSqErr / wavelengths.length);
  const tolerance = 0.05;
  const plasmaWl = (2 * Math.PI) / wp;
  // headline: the most metallic sample (longest wavelength, ω well below ωp)
  const mid = series.reduce((a, b) => (b.measured > a.measured ? b : a));
  return {
    id: 'drude',
    title: 'Drude metal — permittivity recovery',
    summary:
      'A Drude half-space (plasma λ ≈ 18 cells) is probed at six wavelengths. The ' +
      'measured reflectance spectrum must track the analytic Fresnel |r|² of ε(ω) — ' +
      'the metal turns reflective below the plasma wavelength exactly as theory predicts.',
    measured: mid.measured,
    theory: mid.theory,
    unit: '',
    error: rms,
    tolerance,
    pass: rms <= tolerance,
    metrics: [
      { label: 'plasma λ', value: plasmaWl.toFixed(1) + ' cells' },
      { label: 'RMS error', value: rms.toFixed(4) },
      { label: 'worst |Δ|', value: worst.toFixed(4) },
      { label: `R at λ=${mid.x}`, value: (mid.measured * 100).toFixed(1) + '%' },
    ],
    series,
    seriesLabel: { x: 'wavelength (cells)', y: 'reflectance |r|²' },
  };
}

/**
 * Boundary quality: compare the residual reflection from the CPML and the sponge
 * against a "ground-truth" run in a domain large enough that no reflection can
 * reach the probe within the window. Reflection is reported in dB.
 */
function boundaryReflectionDb(mode: 'cpml' | 'sponge'): { db: number; refPeak: number; err: number } {
  const nx = 140;
  const ny = 140;
  const steps = 150;
  const cx = nx >> 1;
  const cy = ny >> 1;
  // probe near the boundary where reflections show up strongly
  const px = 18;
  const py = cy;

  const small = new FDTD(nx, ny);
  small.setBoundaryMode(mode);
  small.addSource({ x: cx, y: cy, kind: 'ricker', wavelength: 10, amplitude: 1 });

  // reference: big domain, boundary far enough that nothing returns in `steps`
  const big = new FDTD(nx + 2 * steps, ny + 2 * steps);
  big.setBoundaryMode('cpml');
  const bcx = (nx + 2 * steps) >> 1;
  const bcy = (ny + 2 * steps) >> 1;
  big.addSource({ x: bcx, y: bcy, kind: 'ricker', wavelength: 10, amplitude: 1 });

  const kSmall = px + py * nx;
  const kBig = px + steps + (py + steps) * (nx + 2 * steps);
  let maxErr = 0;
  let refPeak = 0;
  for (let n = 0; n < steps; n++) {
    small.step();
    big.step();
    const diff = Math.abs(small.ez[kSmall] - big.ez[kBig]);
    maxErr = Math.max(maxErr, diff);
    refPeak = Math.max(refPeak, Math.abs(big.ez[kBig]));
  }
  const db = 20 * Math.log10(maxErr / (refPeak || 1e-30));
  return { db, refPeak, err: maxErr };
}

export function expBoundary(): ExperimentResult {
  const cpml = boundaryReflectionDb('cpml');
  const sponge = boundaryReflectionDb('sponge');
  const improvement = sponge.db - cpml.db; // positive dB better (more negative cpml)
  const tolerance = 20; // expect CPML at least 20 dB quieter than the sponge
  return {
    id: 'boundary',
    title: 'Absorbing boundary — CPML vs sponge',
    summary:
      'A broadband pulse is launched toward the edge and the residual reflection is ' +
      'measured against a ground-truth run in a domain too large to reflect. The CPML ' +
      'must be dramatically quieter than the graded-loss sponge.',
    measured: cpml.db,
    theory: sponge.db,
    unit: 'dB',
    error: improvement,
    tolerance,
    pass: improvement >= tolerance,
    metrics: [
      { label: 'CPML (12 cells)', value: cpml.db.toFixed(1) + ' dB' },
      { label: 'sponge (22 cells)', value: sponge.db.toFixed(1) + ' dB' },
      { label: 'CPML advantage', value: improvement.toFixed(1) + ' dB' },
      { label: 'as amplitude', value: '×' + Math.pow(10, improvement / 20).toFixed(0) + ' quieter' },
    ],
  };
}

/**
 * Numerical dispersion: measure the phase velocity of a monochromatic axial wave
 * with two probes and compare it to the analytic 2D-FDTD dispersion relation
 * sin(ωΔt/2)/(Sc) = sin(kΔx/2). The solver should match the *numerical* value it
 * is bound to reproduce (not the ideal c) — a fingerprint of a correct scheme.
 */
export function expDispersion(): ExperimentResult {
  const nx = 340;
  const ny = 40;
  const wavelength = 12;
  const steps = 1700;
  const winStart = 950;
  const cy = ny >> 1;
  // probes < one wavelength apart so the phase difference is unambiguous
  const x1 = 180;
  const x2 = 184;

  const f = new FDTD(nx, ny);
  f.setBoundaryMode('cpml');
  f.addSource({ x: 30, y: cy, kind: 'sine', wavelength, amplitude: 1, halfLen: cy });

  const omega = (2 * Math.PI * COURANT) / wavelength; // rad per step
  const g1 = new Goertzel(omega);
  const g2 = new Goertzel(omega);
  const k1 = x1 + cy * nx;
  const k2 = x2 + cy * nx;
  for (let n = 0; n < steps; n++) {
    f.step();
    if (n >= winStart) {
      g1.push(f.ez[k1]);
      g2.push(f.ez[k2]);
    }
  }
  // Phase difference wrapped to (−π, π]; probes are < λ/2 apart so |Δφ| < π and
  // the wavenumber is unambiguous.
  const raw = g1.phase() - g2.phase();
  const dphi = Math.abs(Math.atan2(Math.sin(raw), Math.cos(raw)));
  const dx = x2 - x1;
  const kMeasured = dphi / dx;
  const omegaPhys = (2 * Math.PI) / wavelength; // rad per time unit
  const vMeasured = omegaPhys / kMeasured;

  // analytic numerical dispersion (axial): sin(ωΔt/2)/Sc = sin(kΔx/2)
  const s = Math.sin((omegaPhys * COURANT) / 2) / COURANT;
  const kAnalytic = 2 * Math.asin(Math.min(1, Math.max(-1, s)));
  const vAnalytic = omegaPhys / kAnalytic;

  const error = Math.abs(vMeasured - vAnalytic) / vAnalytic;
  const tolerance = 0.01;
  return {
    id: 'dispersion',
    title: 'Numerical dispersion of the Yee grid',
    summary:
      'The phase velocity of a λ = 12-cell wave is measured across two probes. It must ' +
      'match the analytic FDTD dispersion relation — the grid slows short waves by a ' +
      'precise, predictable amount, and the solver reproduces it.',
    measured: vMeasured,
    theory: vAnalytic,
    unit: 'c',
    error,
    tolerance,
    pass: error <= tolerance,
    metrics: [
      { label: 'measured vₚ', value: vMeasured.toFixed(4) + ' c' },
      { label: 'analytic vₚ', value: vAnalytic.toFixed(4) + ' c' },
      { label: 'ideal c', value: '1.0000 c' },
      { label: 'grid slowdown', value: ((1 - vAnalytic) * 100).toFixed(2) + '%' },
    ],
  };
}

/**
 * Energy conservation in a lossless PEC cavity. With no sources and metal walls
 * the leapfrog scheme neither creates nor destroys energy — the total EM energy
 * stays flat (bounded ripple), certifying the update is non-dissipative.
 */
export function expEnergy(): ExperimentResult {
  const nx = 96;
  const ny = 96;
  const f = new FDTD(nx, ny);
  // No absorbing boundary at all: zero the sponge *before* selecting sponge mode
  // (setBoundaryMode re-applies the current sponge profile), giving the plain,
  // lossless leapfrog update. The PEC walls then close the cavity perfectly.
  f.setSponge(1, 0);
  f.setBoundaryMode('sponge');
  // Solid PEC border → a closed metal cavity.
  const wall = { epsR: 1, loss: 0, pec: true };
  f.paintRect(0, 0, nx - 1, 1, wall);
  f.paintRect(0, ny - 2, nx - 1, ny - 1, wall);
  f.paintRect(0, 0, 1, ny - 1, wall);
  f.paintRect(nx - 2, 0, nx - 1, ny - 1, wall);
  // Excite a few modes with a short pulse, then let it ring freely.
  f.addSource({ x: nx >> 1, y: (ny >> 1) + 7, kind: 'ricker', wavelength: 12, amplitude: 1 });
  for (let n = 0; n < 220; n++) f.step();
  f.clearSources(); // switch the source off; energy is now fixed
  // Sum the invariant over the whole PEC-enclosed domain (cropping would drop
  // boundary flux and reintroduce ripple).
  f.setTrackEnergy(true, 1);

  let emin = Infinity;
  let emax = -Infinity;
  let esum = 0;
  const count = 3000;
  const series: { x: number; measured: number; theory: number }[] = [];
  for (let n = 0; n < count; n++) {
    f.step();
    const u = f.lastConservedEnergy;
    emin = Math.min(emin, u);
    emax = Math.max(emax, u);
    esum += u;
    if (n % 60 === 0) series.push({ x: n, measured: u, theory: 0 });
  }
  const mean = esum / count;
  const deviation = (emax - emin) / mean; // peak-to-peak relative ripple
  for (const s of series) s.theory = mean;
  const tolerance = 0.02;
  return {
    id: 'energy',
    title: 'Energy conservation in a lossless cavity',
    summary:
      'Metal walls, no sources: the total electromagnetic energy ½∫(ε0εrE²+μ0H²) must ' +
      'stay constant. A flat trace over thousands of steps proves the leapfrog scheme ' +
      'adds no numerical gain or loss.',
    measured: deviation,
    theory: 0,
    unit: '',
    error: deviation,
    tolerance,
    pass: deviation <= tolerance,
    metrics: [
      { label: 'mean energy', value: mean.toExponential(2) },
      { label: 'p-p ripple', value: (deviation * 100).toFixed(2) + '%' },
      { label: 'steps', value: count.toLocaleString() },
    ],
    series,
    seriesLabel: { x: 'step', y: 'total energy U' },
  };
}

export const EXPERIMENTS: { id: string; title: string; run: () => ExperimentResult }[] = [
  { id: 'fresnel', title: 'Fresnel reflection', run: expFresnel },
  { id: 'drude', title: 'Drude permittivity', run: expDrude },
  { id: 'boundary', title: 'CPML vs sponge', run: expBoundary },
  { id: 'dispersion', title: 'Numerical dispersion', run: expDispersion },
  { id: 'energy', title: 'Energy conservation', run: expEnergy },
];
