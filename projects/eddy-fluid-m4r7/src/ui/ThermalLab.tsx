// ThermalLab.tsx — the interactive Convection lab (thermal lattice Boltzmann).
//
// The Kinetic lab streams a single nine-velocity distribution f and watches
// incompressible Navier–Stokes emerge. This lab adds the textbook second
// ingredient for *thermal* convection: a SECOND distribution g that carries the
// temperature as an advected–diffused scalar, two-way coupled to the flow by a
// per-node Boussinesq buoyancy force (hot fluid is lighter, so it rises). From
// nothing but stream + collide on two lattices, the two most iconic instabilities
// in fluid dynamics fall out — Rayleigh–Bénard convection rolls and a rising
// thermal plume — plus the canonical differentially-heated-cavity benchmark. The
// lab measures the Nusselt number (the convective heat-transport boost) live, and
// the Verify page proves the model recovers the critical Rayleigh number Ra_c ≈
// 1708 and the de Vahl Davis cavity Nusselt number.

import { useEffect, useRef, useState } from 'react';
import { ThermalLbm, scalingFromRaPr } from '../sim/thermal';
import { inferno, diverging } from '../render/colormaps';

type Scene = 'rayleigh' | 'plume' | 'cavity';
type Viz = 'temperature' | 'speed' | 'vorticity';

interface Build {
  lbm: ThermalLbm;
  sub: number;
  scene: Scene;
  H: number; // characteristic length for the Nusselt number
  axis: 'x' | 'y'; // heat-transport direction
  deltaT: number;
  tLo: number;
  tHi: number;
  speedScale: number;
  vortScale: number;
  inject?: (lbm: ThermalLbm) => void; // continuous heat source (plume)
}

const RA_DEFAULT: Record<Scene, number> = { rayleigh: 40000, plume: 800000, cavity: 100000 };
const PR_DEFAULT = 0.71;

function buildScene(scene: Scene, ra: number, pr: number): Build {
  if (scene === 'rayleigh') {
    const nx = 256;
    const ny = 88;
    const sc = scalingFromRaPr(ra, pr, ny, 1, 0.04);
    const lbm = new ThermalLbm({
      nx,
      ny,
      viscosity: sc.viscosity,
      diffusivity: sc.diffusivity,
      buoyancy: sc.buoyancy,
      tRef: 0,
      collision: 'trt',
      bc: {
        xMinus: { kind: 'periodic' },
        xPlus: { kind: 'periodic' },
        yMinus: { kind: 'temperature', T: 0.5 },
        yPlus: { kind: 'temperature', T: -0.5 },
      },
    });
    // Conduction profile + a multi-wavelength seed to trip several rolls quickly.
    lbm.initEquilibrium((i, j) => ({
      ux: 0,
      uy: 0,
      T: 0.5 - (j + 0.5) / ny + 0.08 * Math.sin((6 * Math.PI * i) / nx) * Math.sin((Math.PI * (j + 0.5)) / ny),
    }));
    return { lbm, sub: 6, scene, H: ny, axis: 'y', deltaT: 1, tLo: -0.5, tHi: 0.5, speedScale: 0.1, vortScale: 0.03 };
  }

  if (scene === 'cavity') {
    const N = 140;
    const sc = scalingFromRaPr(ra, pr, N, 1, 0.05);
    const lbm = new ThermalLbm({
      nx: N,
      ny: N,
      viscosity: sc.viscosity,
      diffusivity: sc.diffusivity,
      buoyancy: sc.buoyancy,
      tRef: 0,
      collision: 'trt',
      bc: {
        xMinus: { kind: 'temperature', T: 0.5 },
        xPlus: { kind: 'temperature', T: -0.5 },
        yMinus: { kind: 'adiabatic' },
        yPlus: { kind: 'adiabatic' },
      },
    });
    lbm.initEquilibrium(() => ({ ux: 0, uy: 0, T: 0 }));
    return { lbm, sub: 6, scene, H: N, axis: 'x', deltaT: 1, tLo: -0.5, tHi: 0.5, speedScale: 0.12, vortScale: 0.05 };
  }

  // Thermal plume: a sealed, adiabatic box with a hot patch continuously injected
  // at the floor centre — a sustained buoyant plume rising into a mushroom cap.
  const nx = 184;
  const ny = 152;
  const sc = scalingFromRaPr(ra, 1, ny, 1, 0.04);
  const lbm = new ThermalLbm({
    nx,
    ny,
    viscosity: sc.viscosity,
    diffusivity: sc.diffusivity,
    buoyancy: sc.buoyancy,
    tRef: 0,
    collision: 'trt',
    // Adiabatic side/floor walls; a cold ceiling (Dirichlet T = 0) acts as a heat
    // sink so a continuously-injected hot floor patch drives a *sustained* plume
    // instead of slowly heating the whole sealed box.
    bc: {
      xMinus: { kind: 'adiabatic' },
      xPlus: { kind: 'adiabatic' },
      yMinus: { kind: 'adiabatic' },
      yPlus: { kind: 'temperature', T: 0 },
    },
  });
  lbm.initEquilibrium(() => ({ ux: 0, uy: 0, T: 0 }));
  return {
    lbm,
    sub: 6,
    scene,
    H: ny,
    axis: 'y',
    deltaT: 0.5,
    tLo: 0,
    tHi: 0.5,
    speedScale: 0.16,
    vortScale: 0.05,
    inject: (s) => s.addHeatBlob(nx / 2, 8, 7, 0.5),
  };
}

export function ThermalLab() {
  const flowRef = useRef<HTMLCanvasElement | null>(null);
  const plotRef = useRef<HTMLCanvasElement | null>(null);

  const [scene, setScene] = useState<Scene>('rayleigh');
  const [logRa, setLogRa] = useState(Math.log10(RA_DEFAULT.rayleigh));
  const [pr, setPr] = useState(PR_DEFAULT);
  const [viz, setViz] = useState<Viz>('temperature');
  const [paused, setPaused] = useState(false);
  const [info, setInfo] = useState({ nu: NaN, maxU: 0, steps: 0, fps: 0, regime: '' });

  const ra = Math.round(Math.pow(10, logRa));

  const cfg = useRef({ scene, ra, pr, viz, paused });
  useEffect(() => {
    cfg.current = { scene, ra, pr, viz, paused };
  }, [scene, ra, pr, viz, paused]);

  const remakeRef = useRef<() => void>(() => {});
  const rebuildKey = `${scene}|${ra}|${pr}`;

  useEffect(() => {
    const flow = flowRef.current;
    const plot = plotRef.current;
    if (!flow || !plot) return;
    const fctx = flow.getContext('2d');
    const pctx = plot.getContext('2d');
    if (!fctx || !pctx) return;

    let build = buildScene(cfg.current.scene, cfg.current.ra, cfg.current.pr);
    let { lbm } = build;

    let off = document.createElement('canvas');
    off.width = lbm.nx;
    off.height = lbm.ny;
    let octx = off.getContext('2d')!;
    let img = octx.createImageData(lbm.nx, lbm.ny);
    let blew = false;

    const nuHist: number[] = [];

    const remake = () => {
      build = buildScene(cfg.current.scene, cfg.current.ra, cfg.current.pr);
      lbm = build.lbm;
      off = document.createElement('canvas');
      off.width = lbm.nx;
      off.height = lbm.ny;
      octx = off.getContext('2d')!;
      img = octx.createImageData(lbm.nx, lbm.ny);
      nuHist.length = 0;
      blew = false;
    };

    const render = () => {
      const { nx, ny } = lbm;
      const data = img.data;
      const mode = cfg.current.viz;
      const { tLo, tHi, speedScale, vortScale } = build;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const node = lbm.idx(i, j);
          const o = 4 * (i + nx * (ny - 1 - j)); // flip Y so +y is up
          if (lbm.solid[node]) {
            data[o] = 28;
            data[o + 1] = 32;
            data[o + 2] = 40;
            data[o + 3] = 255;
            continue;
          }
          let r: number, g: number, b: number;
          if (mode === 'temperature') {
            // diverging() takes t ∈ [−1, 1] (cold blue → hot red).
            const t = Math.max(-1, Math.min(1, (2 * (lbm.temp[node] - tLo)) / (tHi - tLo) - 1));
            [r, g, b] = diverging(t);
          } else if (mode === 'speed') {
            const t = Math.max(0, Math.min(1, lbm.speedAt(i, j) / speedScale));
            [r, g, b] = inferno(t);
          } else {
            const w = lbm.vorticityAt(i, j);
            const t = Math.max(-1, Math.min(1, w / vortScale));
            [r, g, b] = diverging(t);
          }
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
          data[o + 3] = 255;
        }
      }
      octx.putImageData(img, 0, 0);
      fctx.imageSmoothingEnabled = true;
      fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(off, 0, 0, flow.width, flow.height);
    };

    let raf = 0;
    let frame = 0;
    let lastFpsT = performance.now();
    let fpsFrames = 0;
    let fps = 0;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!cfg.current.paused && !blew) {
        for (let s = 0; s < build.sub; s++) {
          if (build.inject) build.inject(lbm);
          lbm.step();
        }
        if (!Number.isFinite(lbm.ux[lbm.idx(lbm.nx >> 1, lbm.ny >> 1)])) blew = true;
      }
      render();

      if (frame % 4 === 0 && !blew) {
        const nu = lbm.nusselt(build.axis, build.deltaT, build.H);
        const maxU = lbm.maxSpeed();
        nuHist.push(nu);
        if (nuHist.length > 600) nuHist.shift();
        drawNu(pctx, plot.width, plot.height, nuHist, nu);
        let regime: string;
        if (build.scene === 'plume') regime = 'buoyant plume';
        else if (build.scene === 'cavity') regime = 'boundary-layer convection';
        else regime = nu > 1.04 ? 'convection rolls' : 'sub-critical — pure conduction';
        setInfo({ nu, maxU, steps: lbm.steps, fps, regime });
      } else if (blew && frame % 4 === 0) {
        setInfo({ nu: NaN, maxU: 0, steps: lbm.steps, fps, regime: 'unstable — lower Ra' });
      }

      frame++;
      fpsFrames++;
      const now = performance.now();
      if (now - lastFpsT > 500) {
        fps = (fpsFrames * 1000) / (now - lastFpsT);
        fpsFrames = 0;
        lastFpsT = now;
      }
    };
    loop();

    remakeRef.current = remake;
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    remakeRef.current();
  }, [rebuildKey]);

  // Reset Ra to the scene's sweet spot when the scene changes.
  const onScene = (s: Scene) => {
    setScene(s);
    setLogRa(Math.log10(RA_DEFAULT[s]));
  };

  return (
    <div className="lab">
      <div className="lab-inner">
        <div className="verify-head">
          <h1>Convection lab — thermal lattice Boltzmann</h1>
          <div className="row" style={{ width: 'auto' }}>
            <button type="button" className="primary" onClick={() => setPaused((p) => !p)}>
              {paused ? '▶ Resume' : '❚❚ Pause'}
            </button>
            <button type="button" onClick={() => remakeRef.current()}>
              ↻ Reset
            </button>
          </div>
        </div>

        <p className="lede">
          A <strong>second</strong> nine-velocity distribution rides the same lattice and carries the{' '}
          <strong>temperature</strong> as an advected–diffused scalar, coupled back to the flow by a
          per-node <strong>Boussinesq buoyancy</strong> force — hot fluid is lighter, so it rises. From
          nothing but <em>stream</em> + <em>collide</em> on two lattices, thermal convection{' '}
          <em>emerges</em>: dial the <strong>Rayleigh number</strong> up past its critical value and watch
          the motionless conduction state break into <strong>convection rolls</strong>. The lab reads the{' '}
          <strong>Nusselt number</strong> — the convective heat-transport boost — live; the{' '}
          <a href="#/verify">Verify</a> page recovers Ra_c ≈ 1708 and the de Vahl Davis benchmark.
        </p>

        <div className="kin-controls">
          <div className="segmented" role="group">
            <button type="button" className={scene === 'rayleigh' ? 'active' : ''} onClick={() => onScene('rayleigh')}>
              Rayleigh–Bénard
            </button>
            <button type="button" className={scene === 'plume' ? 'active' : ''} onClick={() => onScene('plume')}>
              Thermal plume
            </button>
            <button type="button" className={scene === 'cavity' ? 'active' : ''} onClick={() => onScene('cavity')}>
              Heated cavity
            </button>
          </div>

          <div className="segmented" role="group">
            <button type="button" className={viz === 'temperature' ? 'active' : ''} onClick={() => setViz('temperature')}>
              Temperature
            </button>
            <button type="button" className={viz === 'speed' ? 'active' : ''} onClick={() => setViz('speed')}>
              Speed
            </button>
            <button type="button" className={viz === 'vorticity' ? 'active' : ''} onClick={() => setViz('vorticity')}>
              Vorticity
            </button>
          </div>
        </div>

        <div className="kin-re">
          <label>
            Rayleigh number <strong>Ra = {ra.toLocaleString()}</strong>
          </label>
          <input type="range" min={3} max={6} step={0.02} value={logRa} onChange={(e) => setLogRa(Number(e.target.value))} />
          <span className="kin-re-hint">
            {scene === 'rayleigh'
              ? ra < 1708
                ? 'below Ra_c ≈ 1708 — conduction'
                : 'above Ra_c — convection'
              : 'buoyancy strength'}
          </span>
        </div>

        {scene !== 'plume' && (
          <div className="kin-re">
            <label>
              Prandtl number <strong>Pr = {pr.toFixed(2)}</strong>
            </label>
            <input type="range" min={0.1} max={7} step={0.1} value={pr} onChange={(e) => setPr(Number(e.target.value))} />
            <span className="kin-re-hint">ν/α — momentum vs. heat diffusivity ({pr < 1 ? 'air-like' : 'water-like'})</span>
          </div>
        )}

        <div className="lab-grid kin-grid">
          <figure className="lab-fig kin-fig">
            <canvas ref={flowRef} width={720} height={260} className="lab-canvas" />
            <figcaption>
              {viz === 'temperature' ? 'Temperature T (blue cold → red hot)' : viz === 'speed' ? 'Speed |u|' : 'Vorticity ω'} —{' '}
              {scene === 'rayleigh' ? 'hot floor, cold ceiling' : scene === 'cavity' ? 'hot left wall, cold right wall' : 'hot source at the floor'}
            </figcaption>
          </figure>
          <figure className="lab-fig">
            <canvas ref={plotRef} width={300} height={260} className="lab-canvas" />
            <figcaption>Nusselt number Nu(t) — convective heat transport (Nu = 1 is pure conduction)</figcaption>
          </figure>
        </div>

        <div className="lab-readout">
          <span>
            Nu = <strong>{isFinite(info.nu) ? info.nu.toFixed(3) : '…'}</strong>
          </span>
          <span>max|u| = {info.maxU.toFixed(4)}</span>
          <span>{info.regime}</span>
          <span>{Math.round(info.steps).toLocaleString()} steps</span>
          <span>{info.fps.toFixed(0)} fps</span>
        </div>

        <p className="verify-blurb">
          The temperature obeys an advection–diffusion equation that emerges from the second
          distribution’s stream + collide, with a thermal diffusivity fixed only by its relaxation time,{' '}
          <strong>α = c_s²(τ_g − ½)</strong> — the exact scalar twin of the viscosity law. The control
          knobs are the dimensionless <strong>Rayleigh number</strong> Ra = gβΔT·H³/(να) (the strength of
          buoyancy relative to the diffusive damping) and the <strong>Prandtl number</strong> Pr = ν/α; the
          lab derives ν, α and the buoyancy coefficient from them at a fixed low-Mach free-fall velocity.
          The <strong>Nusselt number</strong> Nu = 1 + ⟨u·T⟩·H/(αΔT) is the ratio of total to purely
          conductive heat transport: it sits at exactly 1 while the fluid is still and climbs as the rolls
          carry heat. In <strong>Rayleigh–Bénard</strong> the conduction state is linearly stable below
          Ra_c ≈ 1708 and breaks into counter-rotating rolls above it; the <strong>heated cavity</strong> is
          the de Vahl Davis natural-convection benchmark; the <strong>thermal plume</strong> is a continuous
          buoyant updraft mushrooming off a hot floor patch.
        </p>

        <a className="back" href="#/">
          ← Back to the studio
        </a>
      </div>
    </div>
  );
}

/** Draw the Nusselt-number trace (a rolling plot), with a Nu = 1 conduction baseline. */
function drawNu(ctx: CanvasRenderingContext2D, W: number, H: number, series: number[], nu: number): void {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0e16';
  ctx.fillRect(0, 0, W, H);

  const padT = 16;
  const padB = 24;
  const plotH = H - padT - padB;

  if (series.length < 2) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(0, H - padB);
    ctx.lineTo(W, H - padB);
    ctx.stroke();
    ctx.fillStyle = 'rgba(220,228,245,0.5)';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText('settling…', 12, padT + 14);
    return;
  }

  let lo = 1;
  let hi = 1;
  for (const v of series) {
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const pad = Math.max(0.1, (hi - lo) * 0.15);
  lo -= pad;
  hi += pad;
  const yOf = (v: number) => padT + plotH * (1 - (v - lo) / (hi - lo));

  // Nu = 1 conduction baseline.
  if (lo <= 1 && hi >= 1) {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, yOf(1));
    ctx.lineTo(W, yOf(1));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(220,228,245,0.55)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('Nu = 1 (conduction)', 8, yOf(1) - 4);
  }

  ctx.strokeStyle = '#ffb347';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  const n = series.length;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W;
    const y = yOf(series[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = 'rgba(220,228,245,0.85)';
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillText(isFinite(nu) ? `Nu ≈ ${nu.toFixed(3)}` : '—', 12, H - 8);
}
