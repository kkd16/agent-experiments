// KineticLab.tsx — the interactive Lattice Boltzmann (D2Q9) laboratory.
//
// The studio's main solver marches the Navier–Stokes PDE directly (Stable
// Fluids). This lab takes the kinetic route: it never writes Navier–Stokes
// down. It streams and collides a particle distribution f on a nine-velocity
// lattice, and the same fluid physics *emerges* from the bottom up. The flagship
// scene is flow past a cylinder — the von Kármán vortex street — where you can
// dial the Reynolds number and watch the wake go from a steady standing pair of
// eddies to a periodic, alternating shedding street. The lab measures the
// shedding frequency live from a wake probe and reports the Strouhal number,
// comparing it to Williamson's experimental correlation. Three other scenes
// (the lid-driven cavity, a body-force Poiseuille channel, and a Kelvin–Helmholtz
// shear layer) exercise the moving-wall, body-force and periodic boundaries.

import { useEffect, useRef, useState } from 'react';
import { Lbm, type Collision } from '../sim/lbm';
import { inferno, diverging } from '../render/colormaps';

type Preset = 'cylinder' | 'cavity' | 'channel' | 'shear';
type Viz = 'vorticity' | 'speed';

interface Build {
  lbm: Lbm;
  sub: number; // lattice steps per animation frame
  D: number; // characteristic length (cylinder diameter) for St
  U: number; // reference velocity
  probe: number; // wake-probe node index (cylinder only)
  vortScale: number;
  speedScale: number;
}

const RE_DEFAULT = 130;

function buildPreset(preset: Preset, re: number, collision: Collision, les: boolean): Build {
  if (preset === 'cylinder') {
    const nx = 320;
    const ny = 112;
    const D = 14;
    const U = 0.1;
    const nu = (U * D) / re;
    const lbm = new Lbm({
      nx,
      ny,
      viscosity: nu,
      inletU: U,
      collision,
      magic: 3 / 16,
      smagorinsky: les ? 0.12 : 0,
      bcX: 'channel',
      bcY: 'wall',
    });
    const cx = Math.round(nx * 0.22);
    const cy = ny / 2 + 0.5; // half-cell off the lattice rows → breaks symmetry, seeds shedding
    lbm.addDisc(cx, cy, D / 2);
    // Seed with the inlet flow plus a tiny transverse kick to trip the instability.
    lbm.initField((_i, j) => ({ rho: 1, ux: U, uy: j === Math.round(cy) ? 0.02 : 0 }));
    const probe = lbm.idx(Math.min(nx - 2, cx + Math.round(2.5 * D)), Math.round(cy + 0.18 * D));
    return { lbm, sub: 3, D, U, probe, vortScale: 0.06, speedScale: 1.7 * U };
  }

  if (preset === 'cavity') {
    const n = 140;
    const U = 0.1;
    const re = 1000; // classic Ghia benchmark Reynolds number
    const nu = (U * n) / re;
    const lbm = new Lbm({
      nx: n,
      ny: n,
      viscosity: nu,
      collision,
      magic: 3 / 16,
      smagorinsky: les ? 0.1 : 0,
      bcX: 'wall',
      bcY: 'wall',
      lidU: U,
    });
    lbm.initEquilibrium(1, 0, 0);
    return { lbm, sub: 4, D: n, U, probe: 0, vortScale: 0.05, speedScale: 1.1 * U };
  }

  if (preset === 'channel') {
    const nx = 220;
    const ny = 96;
    const nu = 0.04;
    const g = 4e-6;
    const lbm = new Lbm({
      nx,
      ny,
      viscosity: nu,
      collision,
      magic: 3 / 16,
      bcX: 'periodic',
      bcY: 'wall',
      forceX: g,
    });
    lbm.initEquilibrium(1, 0, 0);
    const U = (g * ny * ny) / (8 * nu);
    return { lbm, sub: 6, D: ny, U, probe: 0, vortScale: 0.02, speedScale: 1.1 * U };
  }

  // Kelvin–Helmholtz shear layer (doubly periodic).
  const nx = 220;
  const ny = 160;
  const nu = 0.0016;
  const U = 0.08;
  const lbm = new Lbm({
    nx,
    ny,
    viscosity: nu,
    collision,
    magic: 3 / 16,
    smagorinsky: les ? 0.14 : 0,
    bcX: 'periodic',
    bcY: 'periodic',
  });
  // Two opposing streams with a thin shear interface + a sinusoidal perturbation.
  const delta = ny * 0.025;
  lbm.initField((i, j) => {
    const y = (j - ny / 2) / delta;
    const ux = U * Math.tanh(y);
    const uy = 0.01 * U * Math.sin((4 * Math.PI * i) / nx) * Math.exp(-(y * y) / 2);
    return { rho: 1, ux, uy };
  });
  return { lbm, sub: 4, D: ny, U, probe: 0, vortScale: 0.04, speedScale: 1.3 * U };
}

export function KineticLab() {
  const flowRef = useRef<HTMLCanvasElement | null>(null);
  const plotRef = useRef<HTMLCanvasElement | null>(null);

  const [preset, setPreset] = useState<Preset>('cylinder');
  const [re, setRe] = useState(RE_DEFAULT);
  const [collision, setCollision] = useState<Collision>('trt');
  const [les, setLes] = useState(true);
  const [viz, setViz] = useState<Viz>('vorticity');
  const [paused, setPaused] = useState(false);

  const [info, setInfo] = useState({ st: NaN, stRef: NaN, cd: 0, cl: 0, steps: 0, fps: 0, regime: '' });

  // Mirror the live controls into a ref the rAF loop reads without re-subscribing.
  const cfg = useRef({ preset, re, collision, les, viz, paused });
  useEffect(() => {
    cfg.current = { preset, re, collision, les, viz, paused };
  }, [preset, re, collision, les, viz, paused]);

  // Handle the running loop exposes so the rebuild effect can swap the solver.
  const remakeRef = useRef<() => void>(() => {});

  // Rebuild only when the *physics* changes (not viz/pause).
  const rebuildKey = `${preset}|${re}|${collision}|${les}`;

  useEffect(() => {
    const flow = flowRef.current;
    const plot = plotRef.current;
    if (!flow || !plot) return;
    const fctx = flow.getContext('2d');
    const pctx = plot.getContext('2d');
    if (!fctx || !pctx) return;

    let build = buildPreset(cfg.current.preset, cfg.current.re, cfg.current.collision, cfg.current.les);
    let { lbm } = build;

    // Offscreen lattice-sized buffer; the visible canvas scales it up.
    let off = document.createElement('canvas');
    off.width = lbm.nx;
    off.height = lbm.ny;
    let octx = off.getContext('2d')!;
    let img = octx.createImageData(lbm.nx, lbm.ny);
    let blew = false; // set when the solver diverges (extreme Re without LES)

    const remake = () => {
      build = buildPreset(cfg.current.preset, cfg.current.re, cfg.current.collision, cfg.current.les);
      lbm = build.lbm;
      off = document.createElement('canvas');
      off.width = lbm.nx;
      off.height = lbm.ny;
      octx = off.getContext('2d')!;
      img = octx.createImageData(lbm.nx, lbm.ny);
      lift.length = 0;
      liftStep.length = 0;
      blew = false;
    };

    // Lift / wake-probe history for the Strouhal measurement (one sample/frame).
    const lift: number[] = [];
    const liftStep: number[] = [];

    const render = () => {
      const { nx, ny } = lbm;
      const data = img.data;
      const mode = cfg.current.viz;
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
          if (mode === 'vorticity') {
            const w = lbm.vorticityAt(i, j);
            const t = Math.max(0, Math.min(1, 0.5 + w / (2 * build.vortScale)));
            [r, g, b] = diverging(t);
          } else {
            const sp = lbm.speedAt(i, j);
            const t = Math.max(0, Math.min(1, sp / build.speedScale));
            [r, g, b] = inferno(t);
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
        for (let s = 0; s < build.sub; s++) lbm.step();
        // Guard against a numerical blow-up at extreme Re without LES.
        if (!Number.isFinite(lbm.ux[lbm.idx(lbm.nx >> 1, lbm.ny >> 1)])) blew = true;
      }
      render();

      // Measurements (cylinder scene only carries a meaningful Strouhal number).
      if (build.D && cfg.current.preset === 'cylinder' && !blew) {
        const F = lbm.solidForce();
        const cd = (2 * F.fx) / (build.U * build.U * build.D);
        const cl = (2 * F.fy) / (build.U * build.U * build.D);
        // Sample the lift force once per frame. Lift oscillates at exactly the
        // shedding frequency f (drag oscillates at 2f), so it is the canonical,
        // artefact-free signal to read the Strouhal number from.
        lift.push(F.fy);
        liftStep.push(lbm.steps);
        if (lift.length > 1600) {
          lift.shift();
          liftStep.shift();
        }
        // Measure only once the startup transient has flushed out of the window.
        const warm = lbm.steps > 9000 && lift.length > 400;
        const st = warm ? estimateStrouhal(lift, liftStep, build.D, build.U) : NaN;
        const stRef = -3.3265 / cfg.current.re + 0.1816 + 1.6e-4 * cfg.current.re;
        if (frame % 6 === 0) {
          drawLift(pctx, plot.width, plot.height, lift, st);
          const regime = cfg.current.re < 47 ? 'steady wake' : 'periodic shedding';
          setInfo({ st, stRef, cd, cl, steps: lbm.steps, fps, regime });
        }
      } else if (frame % 6 === 0) {
        drawLift(pctx, plot.width, plot.height, lift, NaN);
        setInfo({ st: NaN, stRef: NaN, cd: 0, cl: 0, steps: lbm.steps, fps, regime: blew ? 'unstable — enable LES' : '—' });
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

    // Expose remake() for the rebuild effect via a stashed handle.
    remakeRef.current = remake;
    return () => cancelAnimationFrame(raf);
  }, []);

  // Trigger a rebuild inside the running loop when the physics key changes.
  useEffect(() => {
    remakeRef.current();
  }, [rebuildKey]);

  return (
    <div className="lab">
      <div className="lab-inner">
        <div className="verify-head">
          <h1>Kinetic lab — Lattice Boltzmann</h1>
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
          A second, independent fluid solver — built from the <strong>bottom up</strong>. Instead of a
          velocity field marched through Navier–Stokes, this evolves a nine-velocity{' '}
          <strong>particle distribution</strong> on a lattice by just two local rules: <em>stream</em>{' '}
          (hop to the neighbour) and <em>collide</em> (relax toward equilibrium). The same incompressible
          fluid physics <em>emerges</em> — provably, via the Chapman–Enskog expansion checked on the{' '}
          <a href="#/verify">Verify</a> page. Flow past the cylinder sheds a{' '}
          <strong>von Kármán vortex street</strong>; the lab times the shedding and reports its{' '}
          <strong>Strouhal number</strong> live.
        </p>

        <div className="kin-controls">
          <div className="segmented" role="group">
            <button type="button" className={preset === 'cylinder' ? 'active' : ''} onClick={() => setPreset('cylinder')}>
              Vortex street
            </button>
            <button type="button" className={preset === 'cavity' ? 'active' : ''} onClick={() => setPreset('cavity')}>
              Lid cavity
            </button>
            <button type="button" className={preset === 'channel' ? 'active' : ''} onClick={() => setPreset('channel')}>
              Poiseuille
            </button>
            <button type="button" className={preset === 'shear' ? 'active' : ''} onClick={() => setPreset('shear')}>
              Kelvin–Helmholtz
            </button>
          </div>

          <div className="segmented" role="group">
            <button type="button" className={viz === 'vorticity' ? 'active' : ''} onClick={() => setViz('vorticity')}>
              Vorticity
            </button>
            <button type="button" className={viz === 'speed' ? 'active' : ''} onClick={() => setViz('speed')}>
              Speed
            </button>
          </div>

          <div className="segmented" role="group">
            <button type="button" className={collision === 'bgk' ? 'active' : ''} onClick={() => setCollision('bgk')}>
              BGK
            </button>
            <button type="button" className={collision === 'trt' ? 'active' : ''} onClick={() => setCollision('trt')}>
              TRT
            </button>
            <button type="button" className={collision === 'mrt' ? 'active' : ''} onClick={() => setCollision('mrt')}>
              MRT
            </button>
          </div>

          <label className="kin-check">
            <input type="checkbox" checked={les} onChange={(e) => setLes(e.target.checked)} /> LES (sub-grid)
          </label>
        </div>

        {preset === 'cylinder' && (
          <div className="kin-re">
            <label>
              Reynolds number <strong>Re = {re}</strong>
            </label>
            <input type="range" min={20} max={250} step={5} value={re} onChange={(e) => setRe(Number(e.target.value))} />
            <span className="kin-re-hint">{re < 47 ? 'steady symmetric wake' : 'periodic vortex shedding'}</span>
          </div>
        )}

        <div className="lab-grid kin-grid">
          <figure className="lab-fig kin-fig">
            <canvas ref={flowRef} width={720} height={252} className="lab-canvas" />
            <figcaption>
              {viz === 'vorticity' ? 'Vorticity ω (red/blue = counter-rotating)' : 'Speed |u|'} —{' '}
              {preset === 'cylinder' ? 'flow → past a cylinder' : preset}
            </figcaption>
          </figure>
          <figure className="lab-fig">
            <canvas ref={plotRef} width={300} height={252} className="lab-canvas" />
            <figcaption>Lift force on the cylinder C_l(t) — oscillates at the shedding frequency</figcaption>
          </figure>
        </div>

        <div className="lab-readout">
          {preset === 'cylinder' ? (
            <>
              <span>
                St measured = <strong>{isFinite(info.st) ? info.st.toFixed(3) : '…'}</strong>
              </span>
              <span>St (Williamson) = {isFinite(info.stRef) ? info.stRef.toFixed(3) : '—'}</span>
              <span>C_d* ≈ {info.cd.toFixed(2)}</span>
              <span>C_l* ≈ {info.cl.toFixed(2)}</span>
              <span>{info.regime}</span>
            </>
          ) : (
            <span>{info.regime}</span>
          )}
          <span>{Math.round(info.steps).toLocaleString()} steps</span>
          <span>{info.fps.toFixed(0)} fps</span>
        </div>

        <p className="verify-blurb">
          The Strouhal number St = fD/U is read from the wake-probe oscillation by averaging its
          zero-up-crossing interval; it is compared against Williamson’s experimental fit
          St = −3.3265/Re + 0.1816 + 1.6·10⁻⁴·Re. Our value runs a touch high — the 12.5%-wide cylinder
          confines the channel, which lifts the shedding frequency — but it tracks the canonical{' '}
          <strong>St ≈ 0.2 plateau</strong> and its trend with Re. The drag/lift coefficients{' '}
          <strong>C_d*/C_l*</strong> come from a from-scratch <strong>momentum-exchange</strong> sum over
          the bounce-back links (the <em>*</em> flags them as uncalibrated — the staircase cylinder and
          channel confinement inflate the absolute magnitude); their <em>oscillation</em> is the physics
          to watch: lift cycles at the shedding frequency, drag at twice it. Step up the collision
          operator <strong>BGK → TRT → MRT</strong> (each a stricter relaxation: TRT splits the even/odd
          modes; MRT relaxes all nine moments independently in moment space, damping the unphysical ghost
          modes for maximal stability) or toggle the <strong>LES</strong> sub-grid model to push to higher
          Re without the single-relaxation BGK solver going unstable.
        </p>

        <a className="back" href="#/">
          ← Back to the studio
        </a>
      </div>
    </div>
  );
}

/** Robustly estimate the Strouhal number St = fD/U from an oscillating signal.
 *  Detrend, reject if the oscillation is too weak to be shedding, then find
 *  mean-up-crossings with a hysteresis deadband (kills noise jitter) and take the
 *  *median* interval (robust to the odd spurious crossing) as the period. */
function estimateStrouhal(series: number[], steps: number[], D: number, U: number): number {
  const n = series.length;
  let mean = 0;
  for (const v of series) mean += v;
  mean /= n;
  let amp = 0;
  for (const v of series) amp = Math.max(amp, Math.abs(v - mean));
  if (amp < 1e-9) return NaN; // steady wake — nothing shedding
  const thr = 0.2 * amp; // hysteresis band
  const cross: number[] = [];
  let armed = false; // true once the signal has dipped below mean − thr
  for (let i = 0; i < n; i++) {
    const x = series[i] - mean;
    if (x < -thr) armed = true;
    else if (armed && x > thr) {
      cross.push(steps[i]);
      armed = false;
    }
  }
  if (cross.length < 4) return NaN;
  const intervals: number[] = [];
  for (let i = 1; i < cross.length; i++) intervals.push(cross[i] - cross[i - 1]);
  intervals.sort((a, b) => a - b);
  const period = intervals[intervals.length >> 1]; // median
  if (!(period > 0)) return NaN;
  return D / (U * period);
}

/** Draw the lift-force trace (a rolling oscilloscope). */
function drawLift(ctx: CanvasRenderingContext2D, W: number, H: number, series: number[], st: number): void {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0e16';
  ctx.fillRect(0, 0, W, H);

  const padT = 14;
  const padB = 22;
  const mid = (padT + (H - padB)) / 2;

  // Zero baseline.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(W, mid);
  ctx.stroke();

  if (series.length < 2) {
    ctx.fillStyle = 'rgba(220,228,245,0.5)';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText('settling…', 12, mid - 8);
    return;
  }

  let amax = 1e-6;
  for (const v of series) amax = Math.max(amax, Math.abs(v));
  const amp = (H / 2 - padT) / amax;

  ctx.strokeStyle = '#7ef0c8';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  const n = series.length;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W;
    const y = mid - series[i] * amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.fillStyle = 'rgba(220,228,245,0.7)';
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillText(isFinite(st) ? `St ≈ ${st.toFixed(3)}` : 'measuring…', 12, H - 8);
}
