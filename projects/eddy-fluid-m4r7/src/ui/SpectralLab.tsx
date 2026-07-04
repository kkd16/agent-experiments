// SpectralLab.tsx — a live **pseudo-spectral** 2-D turbulence laboratory.
//
// This lab runs the studio's *second* incompressible solver — `SpectralNS`,
// which evolves vorticity directly in Fourier space with exact spectral
// derivatives and an integrating-factor RK4 (see `sim/spectral.ts`). Because it
// has no grid dissipation, the famous dual cascade of two-dimensional turbulence
// emerges cleanly:
//
//   • **Decaying** — seed a random multi-scale field and let it run. Like-signed
//     vortices merge, structure climbs to ever-larger scales, and the enstrophy
//     spectrum steepens toward Kraichnan's k^−3 forward-enstrophy range.
//   • **Forced** — stir continuously at a small scale against a large-scale drag.
//     Energy flows the "wrong" way, up to large scales (the **inverse cascade**),
//     giving a sustained k^−5/3 inertial range and a steady *negative* flux Π(k).
//
// The vorticity field, its kinetic-energy spectrum E(k), and the spectral energy
// flux Π(k) are drawn live. The solver keeps its state in Fourier space, so the
// spectra are essentially free — no windowing needed, since the field is exactly
// periodic (unlike the grid solver's boxed domain in the Spectra lab).

import { useEffect, useRef, useState } from 'react';
import {
  SpectralNS,
  seedRandomField,
  DEFAULT_SPECTRAL,
  type SpectralParams,
} from '../sim/spectral';
import { energySpectrum, energyTransfer } from '../sim/fft';
import { diverging } from '../render/colormaps';

const M = 128; // spectral resolution (a power of two)

type Regime = 'decaying' | 'forced';

const FORCE_K = 20; // forcing ring wavenumber for the forced regime

function paramsFor(regime: Regime, nu: number): SpectralParams {
  if (regime === 'forced') {
    return { ...DEFAULT_SPECTRAL, nu, friction: 0.04, forcing: 4, forceK: FORCE_K };
  }
  return { ...DEFAULT_SPECTRAL, nu, friction: 0, forcing: 0, forceK: 0 };
}

export function SpectralLab() {
  const flowRef = useRef<HTMLCanvasElement | null>(null);
  const specRef = useRef<HTMLCanvasElement | null>(null);
  const fluxRef = useRef<HTMLCanvasElement | null>(null);
  const pausedRef = useRef(false);
  const regimeRef = useRef<Regime>('decaying');
  const nuRef = useRef(2e-4);
  const reseedRef = useRef<() => void>(() => {});
  const seedNoRef = useRef(1);
  const [paused, setPaused] = useState(false);
  const [regime, setRegime] = useState<Regime>('decaying');
  const [nu, setNu] = useState(2e-4);
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
    nuRef.current = nu;
  }, [nu]);

  useEffect(() => {
    const flow = flowRef.current;
    const spec = specRef.current;
    const flux = fluxRef.current;
    if (!flow || !spec || !flux) return;
    const fctx = flow.getContext('2d');
    const pctx = spec.getContext('2d');
    const xctx = flux.getContext('2d');
    if (!fctx || !pctx || !xctx) return;

    const sim = new SpectralNS(M);

    // Offscreen M×M image the vorticity is painted into, then blitted scaled.
    const off = document.createElement('canvas');
    off.width = M;
    off.height = M;
    const octx = off.getContext('2d');
    const img = octx ? octx.createImageData(M, M) : null;

    const u = new Float64Array(M * M);
    const v = new Float64Array(M * M);
    const w = new Float64Array(M * M);
    let colorScale = 1;

    const reseed = () => {
      const s = seedNoRef.current * 2654435761;
      // A smaller-scale seed for forced runs (the cascade fills in the rest).
      const peakK = regimeRef.current === 'forced' ? 10 : 6;
      seedRandomField(sim, peakK, regimeRef.current === 'forced' ? 0.4 : 1.4, s | 0);
      colorScale = 1;
    };
    reseed();
    reseedRef.current = () => {
      seedNoRef.current++;
      reseed();
    };

    const paintVorticity = () => {
      if (!img || !octx) return;
      sim.vorticity(w);
      // Robust colour scale: track a slowly-adapting peak so merging vortices
      // don't wash out. |ω| percentile ≈ a few × rms.
      let rms = 0;
      for (let i = 0; i < M * M; i++) rms += w[i] * w[i];
      rms = Math.sqrt(rms / (M * M)) || 1;
      const target = 1 / (3.2 * rms);
      colorScale += (target - colorScale) * 0.08;
      const d = img.data;
      for (let i = 0; i < M * M; i++) {
        const [r, g, b] = diverging(w[i] * colorScale);
        const o = i * 4;
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      fctx.imageSmoothingEnabled = true;
      fctx.clearRect(0, 0, flow.width, flow.height);
      fctx.drawImage(off, 0, 0, flow.width, flow.height);
    };

    let raf = 0;
    let frame = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const p = paramsFor(regimeRef.current, nuRef.current);
      if (!pausedRef.current) {
        // A couple of substeps per frame keeps the animation lively but stable.
        sim.step(1 / 120, p);
        sim.step(1 / 120, p);
      }
      paintVorticity();
      frame++;
      if (frame % 3 === 0) {
        sim.velocity(u, v);
        const sp = energySpectrum(u, v, M);
        drawSpectrum(pctx, spec.width, spec.height, sp.e);
        const tr = energyTransfer(u, v, M);
        drawFlux(xctx, flux.width, flux.height, tr.flux);
        const mid = Math.max(1, Math.round(FORCE_K / 2));
        setInfo({ ke: sim.energy(), ens: sim.enstrophy(), t: sim.t, flux: tr.flux[mid] });
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
          <h1>Spectral lab — 2-D turbulence in Fourier space</h1>
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
          A <strong>pseudo-spectral</strong> incompressible solver: vorticity is evolved directly in{' '}
          <strong>Fourier space</strong>, every derivative is an exact multiply by i·k, and the viscous
          term is integrated in closed form (an integrating-factor RK4). With no grid dissipation the
          two-dimensional <strong>dual cascade</strong> emerges cleanly — energy climbs to large scales
          (the <strong>inverse cascade</strong>, <strong>k<sup>−5/3</sup></strong>) while enstrophy drains
          to small ones (<strong>k<sup>−3</sup></strong>). <strong>Forced</strong> stirring sustains a
          steady inertial range and a negative flux; <strong>decaying</strong> shows the vortices merge.
        </p>

        <div className="lab-grid">
          <figure className="lab-fig">
            <canvas ref={flowRef} width={420} height={420} className="lab-canvas" />
            <figcaption>Vorticity ω (red/blue = counter-rotating)</figcaption>
          </figure>
          <figure className="lab-fig">
            <canvas ref={specRef} width={420} height={420} className="lab-canvas" />
            <figcaption>Kinetic-energy spectrum E(k), log–log</figcaption>
          </figure>
          <figure className="lab-fig">
            <canvas ref={fluxRef} width={420} height={420} className="lab-canvas" />
            <figcaption>Energy flux Π(k) — negative ⇒ inverse cascade</figcaption>
          </figure>
        </div>

        <div className="row" style={{ maxWidth: 420, margin: '0.5rem 0 0' }}>
          <label className="slider-label" style={{ width: '100%' }}>
            viscosity ν = {nu.toExponential(1)}
            <input
              type="range"
              min={-4.5}
              max={-2.5}
              step={0.1}
              value={Math.log10(nu)}
              onChange={(e) => setNu(Math.pow(10, Number(e.target.value)))}
            />
          </label>
        </div>

        <div className="lab-readout">
          <span>t = {info.t.toFixed(1)} s</span>
          <span>mean KE = {info.ke.toExponential(2)}</span>
          <span>enstrophy = {info.ens.toExponential(2)}</span>
          <span>Π(inertial) = {info.flux.toExponential(2)}</span>
        </div>

        <p className="verify-blurb">
          This solver's closed-form invariants — analytic Taylor–Green decay, exact inviscid conservation
          of <em>both</em> energy and enstrophy, a machine-zero velocity divergence, and the{' '}
          <em>negative-flux inverse cascade</em> — are all asserted on the{' '}
          <a href="#/verify">Verify</a> page. Reference slopes k<sup>−3</sup> (solid) and k<sup>−5/3</sup>{' '}
          (dashed) are drawn for comparison.
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
  emin = Math.max(emin, emax * 1e-7);

  const x0 = Math.log10(1);
  const x1 = Math.log10(kmax);
  const y0 = Math.log10(emin);
  const y1 = Math.log10(emax);
  const px = (k: number) => padL + ((Math.log10(k) - x0) / (x1 - x0)) * (W - padL - padR);
  const py = (val: number) => padT + (1 - (Math.log10(val) - y0) / (y1 - y0)) * (H - padT - padB);

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

  const ka = ks[0];
  const ea = es[0];
  const slope = (exp: number, dash: boolean) => {
    ctx.strokeStyle = dash ? 'rgba(120,200,255,0.55)' : 'rgba(255,170,90,0.6)';
    ctx.setLineDash(dash ? [5, 4] : []);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px(ka), py(ea));
    ctx.lineTo(px(kmax), py(ea * Math.pow(kmax / ka, exp)));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  slope(-3, false);
  slope(-5 / 3, true);

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
  const py = (val: number) => padT + (1 - (val / amax + 1) / 2) * (H - padT - padB);

  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, py(0));
  ctx.lineTo(W - padR, py(0));
  ctx.stroke();

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
