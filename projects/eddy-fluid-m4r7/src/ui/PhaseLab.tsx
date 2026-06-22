// PhaseLab.tsx — the interactive multiphase (Shan–Chen) laboratory.
//
// The studio's other two solvers each carry ONE fluid. This lab carries the
// boundary BETWEEN two phases of one fluid — a liquid and its vapour — and the
// force that lives on that boundary: surface tension. It all comes from a single
// short-range attraction between lattice sites (the Shan–Chen pseudopotential).
// Nudge the cohesion strength G past the critical value −4 and a uniform fluid
// spontaneously unmixes into droplets; drop two near each other and they coalesce;
// turn on gravity and they rain onto a floor whose wettability sets the contact
// angle. Nothing tracks the interface — it is an emergent property of ρ.

import { useEffect, useRef, useState } from 'react';
import { ShanChen, pressureOf } from '../sim/multiphase';
import { inferno, ice, diverging } from '../render/colormaps';

type Preset = 'spinodal' | 'droplet' | 'coalesce' | 'rain' | 'wetting';
type Viz = 'density' | 'pressure' | 'speed';

interface Build {
  sc: ShanChen;
  sub: number;
  isDroplet: boolean;
  rain: boolean;
}

// A representative liquid density for a given G (for stamping fresh drops and
// for the fixed colour range), from the measured coexistence curve.
function liquidFor(G: number): number {
  // ρ_l grows roughly linearly past G_c = −4; fit to the measured points.
  return Math.max(1.2, 1.0 + 0.18 * (-G - 4) * 5);
}

function buildPreset(preset: Preset, G: number, Gads: number): Build {
  if (preset === 'droplet') {
    const N = 180;
    const sc = new ShanChen({ nx: N, ny: N, G, viscosity: 1 / 6 });
    sc.initDroplet(N / 2, N / 2, 34, liquidFor(G), 0.14, 2);
    return { sc, sub: 3, isDroplet: true, rain: false };
  }
  if (preset === 'coalesce') {
    const nx = 220;
    const ny = 130;
    const sc = new ShanChen({ nx, ny, G, viscosity: 1 / 6 });
    const rhoL = liquidFor(G);
    sc.initField((i, j) => {
      const d1 = Math.hypot(i - nx * 0.4, j - ny / 2) - 24;
      const d2 = Math.hypot(i - nx * 0.6, j - ny / 2) - 24;
      const s = Math.max(0.5 * (1 - Math.tanh(d1 / 2)), 0.5 * (1 - Math.tanh(d2 / 2)));
      return 0.14 + (rhoL - 0.14) * s;
    });
    return { sc, sub: 3, isDroplet: false, rain: false };
  }
  if (preset === 'rain') {
    const nx = 200;
    const ny = 150;
    const sc = new ShanChen({ nx, ny, G, Gads, gravityY: -0.00004, viscosity: 1 / 6 });
    sc.addFloor(6);
    sc.initField(() => 0.14); // start as vapour; drops are dripped in by the loop
    return { sc, sub: 2, isDroplet: false, rain: true };
  }
  if (preset === 'wetting') {
    const nx = 220;
    const ny = 130;
    const sc = new ShanChen({ nx, ny, G, Gads, gravityY: -0.00003, viscosity: 1 / 6 });
    sc.addFloor(6);
    const rhoL = liquidFor(G);
    // A sessile half-droplet resting on the floor; mild gravity pins it so the
    // adhesion (Gads) sets the contact angle without flattening it.
    sc.initField((i, j) => {
      const d = Math.hypot(i - nx / 2, j - 6) - 28;
      const s = 0.5 * (1 - Math.tanh(d / 2));
      return j < 6 ? 0 : 0.14 + (rhoL - 0.14) * s;
    });
    return { sc, sub: 3, isDroplet: false, rain: false };
  }
  // spinodal decomposition: a noisy fluid unmixing into a coarsening foam.
  const nx = 220;
  const ny = 150;
  const sc = new ShanChen({ nx, ny, G, viscosity: 1 / 6 });
  sc.initNoise(0.85, 0.12, 12345);
  return { sc, sub: 2, isDroplet: false, rain: false };
}

export function PhaseLab() {
  const flowRef = useRef<HTMLCanvasElement | null>(null);

  const [preset, setPreset] = useState<Preset>('spinodal');
  const [G, setG] = useState(-5);
  const [Gads, setGads] = useState(0.8);
  const [viz, setViz] = useState<Viz>('density');
  const [paused, setPaused] = useState(false);

  const [info, setInfo] = useState({ rhoL: 0, rhoG: 0, ratio: 0, sigma: NaN, spur: 0, mass: 0, steps: 0, fps: 0 });

  const cfg = useRef({ preset, G, Gads, viz, paused });
  useEffect(() => {
    cfg.current = { preset, G, Gads, viz, paused };
  }, [preset, G, Gads, viz, paused]);

  const remakeRef = useRef<() => void>(() => {});
  const rebuildKey = `${preset}|${G}|${Gads}`;

  useEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    const fctx = flow.getContext('2d');
    if (!fctx) return;

    let build = buildPreset(cfg.current.preset, cfg.current.G, cfg.current.Gads);
    let { sc } = build;

    let off = document.createElement('canvas');
    off.width = sc.nx;
    off.height = sc.ny;
    let octx = off.getContext('2d')!;
    let img = octx.createImageData(sc.nx, sc.ny);
    // Keep the displayed canvas at the lattice aspect ratio.
    const fitCanvas = () => {
      flow.height = Math.round((flow.width * sc.ny) / sc.nx);
    };
    fitCanvas();
    let blew = false;

    const remake = () => {
      build = buildPreset(cfg.current.preset, cfg.current.G, cfg.current.Gads);
      sc = build.sc;
      off = document.createElement('canvas');
      off.width = sc.nx;
      off.height = sc.ny;
      octx = off.getContext('2d')!;
      img = octx.createImageData(sc.nx, sc.ny);
      fitCanvas();
      blew = false;
    };

    const render = () => {
      const { nx, ny } = sc;
      const data = img.data;
      const mode = cfg.current.viz;
      const rhoLref = liquidFor(cfg.current.G);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const node = sc.idx(i, j);
          const o = 4 * (i + nx * (ny - 1 - j)); // flip Y so +y is up (floor at bottom)
          if (sc.solid[node]) {
            data[o] = 30;
            data[o + 1] = 34;
            data[o + 2] = 44;
            data[o + 3] = 255;
            continue;
          }
          let r: number, g: number, b: number;
          if (mode === 'density') {
            const t = Math.max(0, Math.min(1, (sc.rho[node] - 0.05) / (rhoLref - 0.05)));
            [r, g, b] = ice(t);
          } else if (mode === 'pressure') {
            const p = pressureOf(sc.rho[node], cfg.current.G);
            const t = Math.max(0, Math.min(1, 0.5 + p / 0.12));
            [r, g, b] = diverging(t);
          } else {
            const sp = Math.hypot(sc.ux[node], sc.uy[node]);
            [r, g, b] = inferno(Math.max(0, Math.min(1, sp / 0.08)));
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
    let nextDrop = 60;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!cfg.current.paused && !blew) {
        for (let s = 0; s < build.sub; s++) sc.step();
        if (!Number.isFinite(sc.rho[sc.idx(sc.nx >> 1, sc.ny >> 1)])) blew = true;
        // Rain: periodically drip a fresh droplet from the top.
        if (build.rain) {
          nextDrop -= build.sub;
          if (nextDrop <= 0) {
            const cx = 12 + Math.floor(Math.random() * (sc.nx - 24));
            sc.stampDroplet(cx, sc.ny - 10, 5 + Math.random() * 4, liquidFor(cfg.current.G), -0.02);
            nextDrop = 50 + Math.floor(Math.random() * 90);
          }
        }
      }
      render();

      if (frame % 6 === 0) {
        const b = sc.bulkDensities();
        let sigma = NaN;
        if (build.isDroplet && !blew) {
          // Live Laplace surface tension: Δp·R.
          const N = sc.nx;
          const c = N / 2;
          let pin = 0;
          let nin = 0;
          let pout = 0;
          let nout = 0;
          const mid = 0.5 * (b.rhoL + b.rhoG);
          let area = 0;
          for (let node = 0; node < sc.n; node++) {
            const i = node % N;
            const j = (node / N) | 0;
            const d = Math.hypot(i - c, j - c);
            if (d < 10) {
              pin += sc.pressureAt(node);
              nin++;
            }
            if (sc.rho[node] > mid) area++;
          }
          for (let j = 2; j <= 8; j++)
            for (let i = 2; i <= 8; i++) {
              pout += sc.pressureAt(sc.idx(i, j));
              nout++;
            }
          const R = Math.sqrt(area / Math.PI);
          sigma = (pin / nin - pout / nout) * R;
        }
        setInfo({
          rhoL: b.rhoL,
          rhoG: b.rhoG,
          ratio: b.ratio,
          sigma,
          spur: sc.maxSpuriousSpeed(),
          mass: sc.totalMass(),
          steps: sc.steps,
          fps,
        });
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

  const showAdhesion = preset === 'wetting' || preset === 'rain';

  return (
    <div className="lab">
      <div className="lab-inner">
        <div className="verify-head">
          <h1>Phase lab — multiphase (Shan–Chen)</h1>
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
          A third kinetic solver — and the first that carries <strong>two phases</strong>. One short-range
          attraction between lattice sites (the <strong>Shan–Chen pseudopotential</strong>) gives the fluid
          a non-ideal equation of state, and below the critical strength <strong>G = −4</strong> a uniform
          fluid spontaneously <em>unmixes</em> into liquid and vapour with a real{' '}
          <strong>surface tension</strong>. No interface tracking — the boundary is just where the density
          jumps. Watch a foam <em>coarsen</em>, two drops <em>coalesce</em>, or rain <em>bead up</em> on a
          wettable floor; the droplet scene reads <strong>Laplace's law Δp = σ/R</strong> live.
        </p>

        <div className="kin-controls">
          <div className="segmented" role="group">
            <button type="button" className={preset === 'spinodal' ? 'active' : ''} onClick={() => setPreset('spinodal')}>
              Spinodal
            </button>
            <button type="button" className={preset === 'droplet' ? 'active' : ''} onClick={() => setPreset('droplet')}>
              Droplet
            </button>
            <button type="button" className={preset === 'coalesce' ? 'active' : ''} onClick={() => setPreset('coalesce')}>
              Coalescence
            </button>
            <button type="button" className={preset === 'rain' ? 'active' : ''} onClick={() => setPreset('rain')}>
              Rain
            </button>
            <button type="button" className={preset === 'wetting' ? 'active' : ''} onClick={() => setPreset('wetting')}>
              Wetting
            </button>
          </div>

          <div className="segmented" role="group">
            <button type="button" className={viz === 'density' ? 'active' : ''} onClick={() => setViz('density')}>
              Density
            </button>
            <button type="button" className={viz === 'pressure' ? 'active' : ''} onClick={() => setViz('pressure')}>
              Pressure
            </button>
            <button type="button" className={viz === 'speed' ? 'active' : ''} onClick={() => setViz('speed')}>
              Speed
            </button>
          </div>
        </div>

        <div className="kin-re">
          <label>
            Cohesion <strong>G = {G.toFixed(2)}</strong>
          </label>
          <input type="range" min={-5.6} max={-4.2} step={0.05} value={G} onChange={(e) => setG(Number(e.target.value))} />
          <span className="kin-re-hint">
            {G > -4 ? 'mixed (above G_c)' : `density ratio ≈ ${isFinite(info.ratio) ? info.ratio.toFixed(0) : '…'}×`}
          </span>
        </div>

        {showAdhesion && (
          <div className="kin-re">
            <label>
              Wettability <strong>G_ads = {Gads.toFixed(2)}</strong>
            </label>
            <input type="range" min={-1.2} max={1.6} step={0.1} value={Gads} onChange={(e) => setGads(Number(e.target.value))} />
            <span className="kin-re-hint">{Gads > 0.2 ? 'hydrophilic (wets)' : Gads < -0.2 ? 'hydrophobic (beads)' : 'neutral'}</span>
          </div>
        )}

        <div className="lab-grid kin-grid" style={{ gridTemplateColumns: '1fr' }}>
          <figure className="lab-fig kin-fig">
            <canvas ref={flowRef} width={760} height={520} className="lab-canvas" />
            <figcaption>
              {viz === 'density' ? 'Density ρ (bright = liquid, dark = vapour)' : viz === 'pressure' ? 'Mechanical pressure p(ρ)' : 'Speed |u| (incl. spurious interface currents)'}{' '}
              — {preset}
            </figcaption>
          </figure>
        </div>

        <div className="lab-readout">
          <span>
            ρ_liquid = <strong>{info.rhoL.toFixed(3)}</strong>
          </span>
          <span>ρ_vapour = {info.rhoG.toFixed(3)}</span>
          <span>ratio = {isFinite(info.ratio) ? `${info.ratio.toFixed(1)}×` : '—'}</span>
          {preset === 'droplet' && <span>σ (Δp·R) = {isFinite(info.sigma) ? info.sigma.toFixed(4) : '…'}</span>}
          <span>spurious |u| = {info.spur.toExponential(1)}</span>
          <span>mass = {info.mass.toFixed(0)}</span>
          <span>{Math.round(info.steps).toLocaleString()} steps</span>
          <span>{info.fps.toFixed(0)} fps</span>
        </div>

        <p className="verify-blurb">
          Each site carries a pseudopotential <strong>ψ(ρ) = 1 − e^(−ρ)</strong>, and feels the cohesion{' '}
          <strong>F = −G·ψ(x)·Σᵢ wᵢ·ψ(x+eᵢ)·eᵢ</strong> from its eight neighbours — pulled toward denser
          ones. That force alone gives the non-ideal equation of state{' '}
          <strong>p = c_s²ρ + ½c_s²G·ψ²</strong>, whose pressure <em>falls</em> with density over a band
          when G &lt; −4, so the fluid is unstable there and separates. Surface tension is then emergent:
          the <strong>Droplet</strong> scene confirms <strong>Laplace's law</strong> — the pressure jump
          across the interface, times the radius, is a constant σ (read live above and pinned on the{' '}
          <a href="#/verify">Verify</a> page across four radii). The faint <strong>spurious currents</strong>{' '}
          are the model's one honest blemish — parasitic velocities a curved discrete interface can't quite
          cancel — kept small by the smooth ψ and the TRT-friendly relaxation. Drag the{' '}
          <strong>wettability</strong> on the Rain / Wetting scenes to swing a droplet's contact angle from
          beading (hydrophobic) to spreading (hydrophilic).
        </p>

        <a className="back" href="#/">
          ← Back to the studio
        </a>
      </div>
    </div>
  );
}
