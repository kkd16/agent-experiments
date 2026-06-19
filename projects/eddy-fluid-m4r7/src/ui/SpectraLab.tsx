// SpectraLab.tsx — a live kinetic-energy-spectrum & energy-flux laboratory.
//
// Runs its own self-contained 2-D turbulence simulation and, every few frames,
// takes a 2-D FFT of the velocity field to draw two diagnostics side by side:
//
//   • the radially-averaged kinetic-energy spectrum E(k) — *where* the energy
//     lives, on a log–log plot with k^−3 / k^−5/3 reference slopes;
//   • the spectral energy flux Π(k) — *which way* the energy flows. In 2-D the
//     flux is **negative** (energy climbing to larger scales: the inverse
//     cascade), the quantitative signature that a velocity snapshot alone can't
//     show.
//
// Two regimes are selectable. **Decaying** turbulence is seeded once and left
// alone — the vortices merge, energy piles up at small k, and the flux is a
// transient. **Forced** turbulence is continuously stirred at a small scale
// against a large-scale drag, so it reaches a statistically steady state with a
// sustained k^−5/3 inertial range and a steady negative flux through it.

import { useEffect, useRef, useState } from 'react';
import { FluidSolver, DEFAULT_PARAMS, type FluidParams } from '../sim/fluid';
import { Renderer } from '../render/renderer';
import { sceneById, type Scene } from '../sim/scenes';
import { energySpectrum, energyTransfer } from '../sim/fft';

const N = 128; // simulation resolution (a power of two, so the FFT is 1:1)
const M = 128; // FFT grid

type Regime = 'decaying' | 'forced';

/** Separable 2-D Hann window — tapers the box edges so the (non-periodic) walls
 *  don't smear energy across the spectrum (spectral leakage). */
function hann(M: number): Float64Array {
  const w = new Float64Array(M);
  for (let i = 0; i < M; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (M - 1));
  return w;
}

export function SpectraLab() {
  const flowRef = useRef<HTMLCanvasElement | null>(null);
  const plotRef = useRef<HTMLCanvasElement | null>(null);
  const fluxRef = useRef<HTMLCanvasElement | null>(null);
  const pausedRef = useRef(false);
  const regimeRef = useRef<Regime>('decaying');
  const reseedRef = useRef<() => void>(() => {});
  const [paused, setPaused] = useState(false);
  const [regime, setRegime] = useState<Regime>('decaying');
  const [info, setInfo] = useState<{ ke: number; ens: number; t: number; flux: number }>({
    ke: 0,
    ens: 0,
    t: 0,
    flux: 0,
  });

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    const flow = flowRef.current;
    const plot = plotRef.current;
    const flux = fluxRef.current;
    if (!flow || !plot || !flux) return;
    const fctx = flow.getContext('2d');
    const pctx = plot.getContext('2d');
    const xctx = flux.getContext('2d');
    if (!fctx || !pctx || !xctx) return;

    const sim = new FluidSolver(N);
    const renderer = new Renderer(N);
    let scene: Scene = sceneById('decaying-turbulence');
    let params: FluidParams = { ...DEFAULT_PARAMS, ...scene.params };
    let t = 0;

    const sceneFor = (r: Regime) => sceneById(r === 'forced' ? 'forced-turbulence' : 'decaying-turbulence');

    const reseed = () => {
      scene = sceneFor(regimeRef.current);
      params = { ...DEFAULT_PARAMS, ...scene.params };
      sim.reset();
      scene.setup(sim);
      t = 0;
    };
    reseed();
    reseedRef.current = reseed;

    const winv = hann(M);
    const u64 = new Float64Array(M * M);
    const v64 = new Float64Array(M * M);

    const fillField = () => {
      // De-mean the interior velocity, then apply the Hann window before the FFT.
      let mu = 0;
      let mv = 0;
      for (let j = 0; j < M; j++)
        for (let i = 0; i < M; i++) {
          const idx = sim.IX(i + 1, j + 1);
          mu += sim.u[idx];
          mv += sim.v[idx];
        }
      mu /= M * M;
      mv /= M * M;
      for (let j = 0; j < M; j++)
        for (let i = 0; i < M; i++) {
          const idx = sim.IX(i + 1, j + 1);
          const w = winv[i] * winv[j];
          u64[j * M + i] = (sim.u[idx] - mu) * w;
          v64[j * M + i] = (sim.v[idx] - mv) * w;
        }
    };

    let raf = 0;
    let frame = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!pausedRef.current) {
        scene.emit?.(sim, { time: t, dt: 1 / 60 });
        sim.step(1 / 60, params);
        t += 1 / 60;
      }
      renderer.draw(fctx, sim, {
        mode: 'curl',
        colormap: 'inferno',
        showArrows: false,
        showStreamlines: false,
        showParticles: false,
        exposure: 1.3,
      });
      frame++;
      if (frame % 3 === 0) {
        fillField();
        const sp = energySpectrum(u64, v64, M);
        drawSpectrum(pctx, plot.width, plot.height, sp.e);
        const tr = energyTransfer(u64, v64, M);
        drawFlux(xctx, flux.width, flux.height, tr.flux);
        // Report the flux at the centre of the inertial range as a scalar summary.
        const mid = Math.max(1, Math.round((tr.flux.length - 1) / 4));
        const d = sim.diagnostics();
        setInfo({ ke: d.kineticEnergy, ens: d.enstrophy, t, flux: tr.flux[mid] });
      }
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);

  const switchRegime = (r: Regime) => {
    regimeRef.current = r;
    setRegime(r);
    reseedRef.current();
  };

  return (
    <div className="lab">
      <div className="lab-inner">
        <div className="verify-head">
          <h1>Spectra lab — the energy cascade</h1>
          <div className="row" style={{ width: 'auto' }}>
            <button type="button" className="primary" onClick={() => setPaused((p) => !p)}>
              {paused ? '▶ Resume' : '❚❚ Pause'}
            </button>
            <button type="button" onClick={() => reseedRef.current()}>
              ↻ Reseed
            </button>
          </div>
        </div>

        <div className="segmented" role="group" style={{ maxWidth: 360, marginBottom: '0.75rem' }}>
          <button type="button" className={regime === 'decaying' ? 'active' : ''} onClick={() => switchRegime('decaying')}>
            Decaying
          </button>
          <button type="button" className={regime === 'forced' ? 'active' : ''} onClick={() => switchRegime('forced')}>
            Forced
          </button>
        </div>

        <p className="lede">
          A 2-D turbulence field, evolved live with the multigrid-preconditioned solver. Every few frames
          its velocity is run through a from-scratch 2-D FFT to plot the kinetic-energy spectrum
          <strong> E(k)</strong> (energy by scale) and the spectral energy flux <strong>Π(k)</strong>
          (which way it flows). In 2-D the flux is <em>negative</em> — energy climbs to larger scales (the{' '}
          <strong>inverse cascade</strong>), while enstrophy drains to small scales as E(k) steepens toward
          the Kraichnan <strong>k<sup>−3</sup></strong> range. <strong>Forced</strong> stirring sustains a
          steady <strong>k<sup>−5/3</sup></strong> inertial range; <strong>decaying</strong> turbulence
          shows the transient.
        </p>

        <div className="lab-grid">
          <figure className="lab-fig">
            <canvas ref={flowRef} width={420} height={420} className="lab-canvas" />
            <figcaption>Vorticity ω (red/blue = counter-rotating)</figcaption>
          </figure>
          <figure className="lab-fig">
            <canvas ref={plotRef} width={420} height={420} className="lab-canvas" />
            <figcaption>Kinetic-energy spectrum E(k), log–log</figcaption>
          </figure>
          <figure className="lab-fig">
            <canvas ref={fluxRef} width={420} height={420} className="lab-canvas" />
            <figcaption>Energy flux Π(k) — negative ⇒ inverse cascade</figcaption>
          </figure>
        </div>

        <div className="lab-readout">
          <span>t = {info.t.toFixed(1)} s</span>
          <span>mean KE = {info.ke.toExponential(2)}</span>
          <span>enstrophy = {info.ens.toExponential(2)}</span>
          <span>Π(inertial) = {info.flux.toExponential(2)}</span>
        </div>

        <p className="verify-blurb">
          The transform, Parseval’s theorem, single-mode localisation, and the <em>exact conservation</em>{' '}
          of the nonlinear energy transfer (∑<sub>k</sub> T(k) = 0, so the flux closes) are all checked on
          the <a href="#/verify">Verify</a> page. Reference slopes k<sup>−3</sup> (solid) and k<sup>−5/3</sup>{' '}
          (dashed) are drawn for comparison. A Hann window tapers the box edges so the walls don’t leak
          energy across scales.
        </p>

        <a className="back" href="#/">
          ← Back to the studio
        </a>
      </div>
    </div>
  );
}

/** Draw E(k) on a log–log canvas with k^−3 and k^−5/3 reference slopes. */
function drawSpectrum(ctx: CanvasRenderingContext2D, W: number, H: number, e: Float64Array): void {
  const padL = 52;
  const padR = 16;
  const padT = 16;
  const padB = 36;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0e16';
  ctx.fillRect(0, 0, W, H);

  const kmax = e.length - 1;
  // Collect plottable points (k ≥ 1, E > 0).
  const ks: number[] = [];
  const es: number[] = [];
  let emax = -Infinity;
  let emin = Infinity;
  for (let k = 1; k <= kmax; k++) {
    if (e[k] <= 0) continue;
    ks.push(k);
    es.push(e[k]);
    if (e[k] > emax) emax = e[k];
    if (e[k] < emin) emin = e[k];
  }
  if (ks.length < 2 || !isFinite(emax) || !isFinite(emin)) return;
  // Clamp the dynamic range so a few tiny shells don't crush the plot.
  emin = Math.max(emin, emax * 1e-7);

  const x0 = Math.log10(1);
  const x1 = Math.log10(kmax);
  const y0 = Math.log10(emin);
  const y1 = Math.log10(emax);
  const px = (k: number) => padL + ((Math.log10(k) - x0) / (x1 - x0)) * (W - padL - padR);
  const py = (v: number) => padT + (1 - (Math.log10(v) - y0) / (y1 - y0)) * (H - padT - padB);

  // Grid + axis ticks (decades).
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.fillStyle = 'rgba(220,228,245,0.6)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let d = Math.ceil(y0); d <= Math.floor(y1); d++) {
    const y = py(Math.pow(10, d));
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(`1e${d}`, 6, y + 4);
  }
  for (const k of [1, 2, 4, 8, 16, 32, 64]) {
    if (k > kmax) break;
    const x = px(k);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, H - padB);
    ctx.stroke();
    ctx.fillText(`${k}`, x - 6, H - padB + 16);
  }
  ctx.fillText('k →', W - padR - 24, H - 6);

  // Reference slopes anchored at the curve's first point.
  const ka = ks[0];
  const ea = es[0];
  const slope = (exp: number, dash: boolean) => {
    ctx.strokeStyle = dash ? 'rgba(120,200,255,0.55)' : 'rgba(255,170,90,0.6)';
    ctx.setLineDash(dash ? [5, 4] : []);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px(ka), py(ea));
    const kEnd = kmax;
    ctx.lineTo(px(kEnd), py(ea * Math.pow(kEnd / ka, exp)));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  slope(-3, false);
  slope(-5 / 3, true);

  // The spectrum curve.
  ctx.strokeStyle = '#7ef0c8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let n = 0; n < ks.length; n++) {
    const x = px(ks[n]);
    const y = py(es[n]);
    if (n === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Draw the energy flux Π(k) on a log-x / linear-y plot, signed about zero. */
function drawFlux(ctx: CanvasRenderingContext2D, W: number, H: number, flux: Float64Array): void {
  const padL = 52;
  const padR = 16;
  const padT = 16;
  const padB = 36;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0e16';
  ctx.fillRect(0, 0, W, H);

  const kmax = flux.length - 1;
  let amax = 1e-30;
  for (let k = 1; k <= kmax; k++) amax = Math.max(amax, Math.abs(flux[k]));

  const x0 = Math.log10(1);
  const x1 = Math.log10(kmax);
  const px = (k: number) => padL + ((Math.log10(k) - x0) / (x1 - x0)) * (W - padL - padR);
  const py = (v: number) => padT + (1 - (v / amax + 1) / 2) * (H - padT - padB);

  // Zero baseline.
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, py(0));
  ctx.lineTo(W - padR, py(0));
  ctx.stroke();

  // x ticks.
  ctx.fillStyle = 'rgba(220,228,245,0.6)';
  ctx.font = '11px ui-monospace, monospace';
  for (const k of [1, 2, 4, 8, 16, 32, 64]) {
    if (k > kmax) break;
    const x = px(k);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, H - padB);
    ctx.stroke();
    ctx.fillText(`${k}`, x - 6, H - padB + 16);
  }
  ctx.fillStyle = 'rgba(220,228,245,0.6)';
  ctx.fillText('+Π', 8, py(amax) + 10);
  ctx.fillText('−Π', 8, py(-amax) - 2);
  ctx.fillText('k →', W - padR - 24, py(0) - 6);

  // Shaded flux curve: negative (inverse cascade) tinted, positive warm.
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#9bd0ff';
  ctx.beginPath();
  let started = false;
  for (let k = 1; k <= kmax; k++) {
    const x = px(k);
    const y = py(flux[k]);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
