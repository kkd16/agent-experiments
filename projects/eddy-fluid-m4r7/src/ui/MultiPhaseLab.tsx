// MultiPhaseLab.tsx — the interactive MULTI-component (two-fluid) laboratory.
//
// Where the single-component lab carries one fluid that splits into a liquid and
// its own vapour, this lab carries TWO distinct fluids — "red" (fluid-1) and
// "blue" (fluid-2) — that refuse to mix. A single short-range cross-repulsion
// between the two species (the multi-component Shan–Chen force) is enough: above
// a critical coupling a blended mixture spontaneously demixes into pure domains
// with a real surface tension, and from there every classic immiscible-fluid
// phenomenon follows — a heavy fluid fingering down through a light one
// (Rayleigh–Taylor), a thread pinching into a string of drops (Rayleigh–Plateau),
// a suspended drop obeying Laplace's law, and a sessile drop whose contact angle
// is set by how strongly each fluid wets the wall. Nothing tracks the interface;
// it is just where the phase field φ = (ρ₁−ρ₂)/(ρ₁+ρ₂) changes sign.

import { useEffect, useRef, useState } from 'react';
import { ShanChenMulti } from '../sim/multicomponent';
import { inferno, diverging } from '../render/colormaps';

type Preset = 'demix' | 'rayleigh-taylor' | 'drop' | 'thread' | 'wetting';
type Viz = 'phase' | 'pressure' | 'speed';

interface Build {
  sc: ShanChenMulti;
  sub: number;
  isDrop: boolean;
}

function buildPreset(preset: Preset, G: number, wett: number): Build {
  if (preset === 'rayleigh-taylor') {
    // Heavy fluid-1 resting on light fluid-2; gravity pulls the dense layer down
    // and the interface fingers. Momentum-conserving, so the box never drifts.
    const nx = 140;
    const ny = 200;
    const sc = new ShanChenMulti({ nx, ny, G, gravityY: -0.00016, weight1: 1, weight2: 0 });
    sc.addFloor(4, true);
    sc.initTwoLayer(ny * 0.62, 1, 1.5, 2.2, 1, true);
    return { sc, sub: 2, isDrop: false };
  }
  if (preset === 'drop') {
    // A circular drop of fluid-1 suspended in fluid-2 — reads Laplace's law live.
    const N = 170;
    const sc = new ShanChenMulti({ nx: N, ny: N, G });
    sc.initDrop(N / 2, N / 2, 36, 1, 2);
    return { sc, sub: 3, isDrop: true };
  }
  if (preset === 'thread') {
    // A perturbed liquid thread of fluid-1 in fluid-2: surface tension amplifies
    // the varicose ripple until the thread pinches into a row of drops (Plateau).
    const nx = 280;
    const ny = 96;
    const sc = new ShanChenMulti({ nx, ny, G });
    sc.initThread(ny / 2, 11, 1, 1.5, 0.28, 5);
    return { sc, sub: 3, isDrop: false };
  }
  if (preset === 'wetting') {
    // A sessile drop of fluid-1 on a floor, surrounded by fluid-2, mildly pinned by
    // gravity; the wettability (G_ads,1 − G_ads,2) swings the contact angle.
    const nx = 220;
    const ny = 130;
    const sc = new ShanChenMulti({ nx, ny, G, gravityY: -0.00006, weight1: 1, weight2: 1, Gads1: wett / 2, Gads2: -wett / 2 });
    sc.addFloor(6);
    sc.initFields((i, j) => {
      const d = Math.hypot(i - nx / 2, j - 6) - 30;
      const s = 0.5 * (1 - Math.tanh(d / 2)); // 1 inside the drop
      if (j < 6) return { r1: 0, r2: 0 };
      return { r1: 1 * s + 0.02 * (1 - s), r2: 1 * (1 - s) + 0.02 * s };
    });
    return { sc, sub: 3, isDrop: false };
  }
  // demix (spinodal): a blended mixture unmixing into a coarsening red/blue foam.
  const nx = 240;
  const ny = 160;
  const sc = new ShanChenMulti({ nx, ny, G });
  sc.initMixed(1, 0.05, 12345);
  return { sc, sub: 2, isDrop: false };
}

export function MultiPhaseLab() {
  const flowRef = useRef<HTMLCanvasElement | null>(null);

  const [preset, setPreset] = useState<Preset>('demix');
  const [G, setG] = useState(1.3);
  const [wett, setWett] = useState(0.6);
  const [viz, setViz] = useState<Viz>('phase');
  const [paused, setPaused] = useState(false);

  const [info, setInfo] = useState({ m1: 0, m2: 0, purity: 0, corr: 0, sigma: NaN, spur: 0, steps: 0, fps: 0 });

  const cfg = useRef({ preset, G, wett, viz, paused });
  useEffect(() => {
    cfg.current = { preset, G, wett, viz, paused };
  }, [preset, G, wett, viz, paused]);

  const remakeRef = useRef<() => void>(() => {});
  const rebuildKey = `${preset}|${G}|${wett}`;

  useEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    const fctx = flow.getContext('2d');
    if (!fctx) return;

    let build = buildPreset(cfg.current.preset, cfg.current.G, cfg.current.wett);
    let { sc } = build;

    let off = document.createElement('canvas');
    off.width = sc.nx;
    off.height = sc.ny;
    let octx = off.getContext('2d')!;
    let img = octx.createImageData(sc.nx, sc.ny);
    const fitCanvas = () => {
      flow.height = Math.round((flow.width * sc.ny) / sc.nx);
    };
    fitCanvas();
    let blew = false;

    const remake = () => {
      build = buildPreset(cfg.current.preset, cfg.current.G, cfg.current.wett);
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
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const node = sc.idx(i, j);
          const o = 4 * (i + nx * (ny - 1 - j)); // flip Y so +y is up
          if (sc.solid[node]) {
            data[o] = 30;
            data[o + 1] = 34;
            data[o + 2] = 44;
            data[o + 3] = 255;
            continue;
          }
          let r: number, g: number, b: number;
          if (mode === 'phase') {
            // φ ∈ [−1,1]: red fluid → warm, blue fluid → cool (diverging map).
            const t = 0.5 + 0.5 * Math.max(-1, Math.min(1, sc.phaseAt(node)));
            [r, g, b] = diverging(t);
          } else if (mode === 'pressure') {
            const p = sc.pressureAt(node);
            const t = Math.max(0, Math.min(1, 0.5 + (p - 0.66) / 0.4));
            [r, g, b] = diverging(t);
          } else {
            const sp = Math.hypot(sc.ux[node], sc.uy[node]);
            [r, g, b] = inferno(Math.max(0, Math.min(1, sp / 0.06)));
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
        for (let s = 0; s < build.sub; s++) sc.step();
        if (!Number.isFinite(sc.rho1[sc.idx(sc.nx >> 1, sc.ny >> 1)])) blew = true;
      }
      render();

      if (frame % 6 === 0) {
        const m = sc.masses();
        let sigma = NaN;
        if (build.isDrop && !blew) {
          const N = sc.nx;
          const c = N / 2;
          let pin = 0;
          let nin = 0;
          let pout = 0;
          let nout = 0;
          let area = 0;
          for (let node = 0; node < sc.n; node++) {
            const i = node % N;
            const j = (node / N) | 0;
            if (Math.hypot(i - c, j - c) < 11) {
              pin += sc.pressureAt(node);
              nin++;
            }
            if (sc.phaseAt(node) > 0) area++;
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
          m1: m.m1,
          m2: m.m2,
          purity: sc.meanPurity(),
          corr: sc.speciesCorrelation(),
          sigma,
          spur: sc.maxSpuriousSpeed(),
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

  const showWett = preset === 'wetting';

  return (
    <div className="lab">
      <div className="lab-inner">
        <div className="verify-head">
          <h1>Phase lab — two immiscible fluids (Shan–Chen)</h1>
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
          A fourth kinetic solver — and the first that carries <strong>two distinct fluids</strong>. Each
          species streams and collides on its own D2Q9 lattice; a single short-range{' '}
          <strong>cross-repulsion</strong> pushes them apart. Past a critical coupling a blended mixture{' '}
          <em>demixes</em> into pure red/blue domains with a real <strong>surface tension</strong> — and
          from that one force come <strong>Rayleigh–Taylor</strong> fingers, a thread breaking into drops
          (<strong>Rayleigh–Plateau</strong>), a suspended drop reading <strong>Laplace's law</strong>{' '}
          live, and a sessile drop whose <strong>contact angle</strong> bends with the wall's wettability.
          Nothing tracks the interface — it is just where the phase field φ flips sign.
        </p>

        <div className="kin-controls">
          <div className="segmented" role="group">
            <button type="button" className={preset === 'demix' ? 'active' : ''} onClick={() => setPreset('demix')}>
              Demix
            </button>
            <button type="button" className={preset === 'rayleigh-taylor' ? 'active' : ''} onClick={() => setPreset('rayleigh-taylor')}>
              Rayleigh–Taylor
            </button>
            <button type="button" className={preset === 'drop' ? 'active' : ''} onClick={() => setPreset('drop')}>
              Drop
            </button>
            <button type="button" className={preset === 'thread' ? 'active' : ''} onClick={() => setPreset('thread')}>
              Thread (Plateau)
            </button>
            <button type="button" className={preset === 'wetting' ? 'active' : ''} onClick={() => setPreset('wetting')}>
              Wetting
            </button>
          </div>

          <div className="segmented" role="group">
            <button type="button" className={viz === 'phase' ? 'active' : ''} onClick={() => setViz('phase')}>
              Phase φ
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
            Cross-coupling <strong>G = {G.toFixed(2)}</strong>
          </label>
          <input type="range" min={0.8} max={1.8} step={0.05} value={G} onChange={(e) => setG(Number(e.target.value))} />
          <span className="kin-re-hint">{G < 0.55 ? 'mixed (below G_c)' : 'immiscible — surface tension grows with G'}</span>
        </div>

        {showWett && (
          <div className="kin-re">
            <label>
              Wettability <strong>ΔG_ads = {wett.toFixed(2)}</strong>
            </label>
            <input type="range" min={-0.8} max={0.8} step={0.05} value={wett} onChange={(e) => setWett(Number(e.target.value))} />
            <span className="kin-re-hint">{wett > 0.1 ? 'fluid-1 wets the wall (spreads)' : wett < -0.1 ? 'fluid-1 beads (fluid-2 wets)' : 'neutral'}</span>
          </div>
        )}

        <div className="lab-grid kin-grid" style={{ gridTemplateColumns: '1fr' }}>
          <figure className="lab-fig kin-fig">
            <canvas ref={flowRef} width={760} height={520} className="lab-canvas" />
            <figcaption>
              {viz === 'phase'
                ? 'Phase φ = (ρ₁−ρ₂)/(ρ₁+ρ₂) — warm = fluid-1, cool = fluid-2'
                : viz === 'pressure'
                  ? 'Mixture pressure p = c_s²(ρ₁+ρ₂) + c_s²G ρ₁ρ₂'
                  : 'Speed |u| (incl. spurious interface currents)'}{' '}
              — {preset}
            </figcaption>
          </figure>
        </div>

        <div className="lab-readout">
          <span>
            purity ⟨|φ|⟩ = <strong>{info.purity.toFixed(3)}</strong>
          </span>
          <span>corr(ρ₁,ρ₂) = {isFinite(info.corr) ? info.corr.toFixed(3) : '—'}</span>
          {preset === 'drop' && <span>σ (Δp·R) = {isFinite(info.sigma) ? info.sigma.toFixed(4) : '…'}</span>}
          <span>spurious |u| = {info.spur.toExponential(1)}</span>
          <span>
            mass ₁/₂ = {info.m1.toFixed(0)}/{info.m2.toFixed(0)}
          </span>
          <span>{Math.round(info.steps).toLocaleString()} steps</span>
          <span>{info.fps.toFixed(0)} fps</span>
        </div>

        <p className="verify-blurb">
          Each species σ carries its own distribution and feels the cross-cohesion{' '}
          <strong>F_σ = −G·ρ_σ(x)·Σᵢ wᵢ·ρ_σ′(x+eᵢ)·eᵢ</strong> from the <em>other</em> fluid's neighbours —
          pushed away from it. That one force gives the binary mixture a non-ideal pressure{' '}
          <strong>p = c_s²(ρ₁+ρ₂) + c_s²G·ρ₁ρ₂</strong>; above the critical coupling the well-mixed state is
          unstable and the fluids unmix, with surface tension emerging at the boundary. The two species
          relax to a shared, momentum-conserving <strong>common velocity</strong>, so the interaction injects
          no net momentum — the box can never propel itself. The <strong>Drop</strong> scene confirms{' '}
          <strong>Laplace's law</strong> Δp = σ/R live; the <a href="#/verify">Verify</a> page pins demixing,
          per-species mass conservation, ΣF = 0, and Laplace's law across four radii. The faint{' '}
          <strong>spurious currents</strong> are the pseudopotential model's one honest blemish.
        </p>

        <a className="back" href="#/">
          ← Back to the studio
        </a>
      </div>
    </div>
  );
}
