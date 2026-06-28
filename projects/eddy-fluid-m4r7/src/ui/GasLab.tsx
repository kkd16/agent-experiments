// GasLab.tsx — the interactive COMPRESSIBLE GAS-DYNAMICS laboratory.
//
// Every other solver in Eddy is incompressible (or low-Mach): a Hodge projection
// pins the velocity divergence-free, so there are no sound waves and no shocks.
// This lab is the opposite physics. It marches the compressible Euler equations
// with a from-scratch finite-volume Godunov scheme (MUSCL-Hancock reconstruction
// + an HLLC Riemann flux, Strang-split in 2-D) that captures genuine
// DISCONTINUITIES — shock waves and contact surfaces — sharply and without
// spurious oscillations. See `sim/compressible.ts`.
//
// The 1-D shock tubes overlay the EXACT Riemann solution (the analytic
// self-similar answer) on the computed profile, so you watch a second-order
// scheme converge onto ground truth. The 2-D scenes are the canonical gallery:
// a Sedov point blast, the four-shock 2-D Riemann problem, a compressible
// Kelvin–Helmholtz roll-up, a Rayleigh–Taylor instability under gravity, the
// Liska–Wendroff implosion, and a Mach-1.5 shock shredding a light gas bubble.

import { useEffect, useRef, useState } from 'react';
import { CompressibleEuler, exactRiemann, soundSpeed } from '../sim/compressible';
import { viridis, inferno, magma, ice, type RGB } from '../render/colormaps';

type Scene =
  | 'sod'
  | 'lax'
  | 'blast'
  | 'riemann2d'
  | 'kh'
  | 'rt'
  | 'implosion'
  | 'bubble';
type View = 'density' | 'pressure' | 'speed' | 'mach' | 'schlieren';

const GAMMA = 1.4;

interface SceneDef {
  label: string;
  is1D: boolean;
  /** 1-D scenes run to this physical time and stop (so the exact overlay lines up). */
  tEnd?: number;
  /** For 1-D scenes, the left/right Riemann data, for the exact overlay. */
  left?: { rho: number; u: number; p: number };
  right?: { rho: number; u: number; p: number };
  defaultView: View;
  sub: number;
  caption: string;
  build: () => CompressibleEuler;
}

// --- normal-shock post-state for the shock-bubble scene --------------------
// Gas at rest (ρ1,0,p1) hit by a left-moving... no: a shock travelling right
// into still gas. Returns the state just behind the shock (lab frame).
function postShock(Ms: number, rho1: number, p1: number, gamma: number) {
  const a1 = soundSpeed(rho1, p1, gamma);
  const rho2 = (rho1 * (gamma + 1) * Ms * Ms) / ((gamma - 1) * Ms * Ms + 2);
  const p2 = (p1 * (2 * gamma * Ms * Ms - (gamma - 1))) / (gamma + 1);
  const u2 = (2 / (gamma + 1)) * (Ms - 1 / Ms) * a1;
  return { rho: rho2, u: u2, p: p2 };
}

const SCENES: Record<Scene, SceneDef> = {
  sod: {
    label: 'Sod tube',
    is1D: true,
    tEnd: 0.2,
    left: { rho: 1, u: 0, p: 1 },
    right: { rho: 0.125, u: 0, p: 0.1 },
    defaultView: 'density',
    sub: 2,
    caption:
      'The Sod shock tube — the field’s standard test. Left to right: a rarefaction fan, a contact discontinuity, a shock. The pale line is the EXACT Riemann solution.',
    build: () => {
      const n = 500;
      const sim = new CompressibleEuler({ nx: n, ny: 1, gamma: GAMMA, bcX: 'transmissive', bcY: 'periodic', dx: 1 / n, cfl: 0.4 });
      sim.initField((i) => ((i + 0.5) / n < 0.5 ? { rho: 1, u: 0, v: 0, p: 1 } : { rho: 0.125, u: 0, v: 0, p: 0.1 }));
      return sim;
    },
  },
  lax: {
    label: 'Lax tube',
    is1D: true,
    tEnd: 0.14,
    left: { rho: 0.445, u: 0.698, p: 3.528 },
    right: { rho: 0.5, u: 0, p: 0.571 },
    defaultView: 'density',
    sub: 2,
    caption:
      'The Lax shock tube — a stronger problem whose contact carries a big density jump the HLLC flux keeps crisp. Pale line = exact.',
    build: () => {
      const n = 500;
      const sim = new CompressibleEuler({ nx: n, ny: 1, gamma: GAMMA, bcX: 'transmissive', bcY: 'periodic', dx: 1 / n, cfl: 0.4 });
      sim.initField((i) => ((i + 0.5) / n < 0.5 ? { rho: 0.445, u: 0.698, v: 0, p: 3.528 } : { rho: 0.5, u: 0, v: 0, p: 0.571 }));
      return sim;
    },
  },
  blast: {
    label: 'Sedov blast',
    is1D: false,
    defaultView: 'schlieren',
    sub: 1,
    caption:
      'A Sedov–Taylor point explosion: a tiny region of enormous pressure drives a circular blast wave into still gas, reflecting off the walls.',
    build: () => {
      const N = 180;
      const sim = new CompressibleEuler({ nx: N, ny: N, gamma: GAMMA, bcX: 'reflective', bcY: 'reflective', dx: 1 / N, cfl: 0.3 });
      const r0 = 0.03;
      sim.initField((i, j) => {
        const x = (i + 0.5) / N - 0.5;
        const y = (j + 0.5) / N - 0.5;
        const r = Math.hypot(x, y);
        return r < r0 ? { rho: 1, u: 0, v: 0, p: 120 } : { rho: 1, u: 0, v: 0, p: 1 };
      });
      return sim;
    },
  },
  riemann2d: {
    label: '2-D Riemann',
    is1D: false,
    defaultView: 'density',
    sub: 1,
    caption:
      'The 2-D Riemann problem (configuration 3): four constant states meet at the centre, each interface launching a shock. The classic curling jet forms where they interact.',
    build: () => {
      const N = 220;
      const sim = new CompressibleEuler({ nx: N, ny: N, gamma: GAMMA, bcX: 'transmissive', bcY: 'transmissive', dx: 1 / N, cfl: 0.3 });
      sim.initField((i, j) => {
        const x = (i + 0.5) / N;
        const y = (j + 0.5) / N;
        if (x >= 0.5 && y >= 0.5) return { rho: 1.5, u: 0, v: 0, p: 1.5 };
        if (x < 0.5 && y >= 0.5) return { rho: 0.5323, u: 1.206, v: 0, p: 0.3 };
        if (x < 0.5 && y < 0.5) return { rho: 0.138, u: 1.206, v: 1.206, p: 0.029 };
        return { rho: 0.5323, u: 0, v: 1.206, p: 0.3 };
      });
      return sim;
    },
  },
  kh: {
    label: 'Kelvin–Helmholtz',
    is1D: false,
    defaultView: 'density',
    sub: 1,
    caption:
      'A compressible shear layer: a dense central stream slides past lighter gas. The interface rolls into the billows of the Kelvin–Helmholtz instability.',
    build: () => {
      const NX = 220;
      const NY = 220;
      const sim = new CompressibleEuler({ nx: NX, ny: NY, gamma: GAMMA, bcX: 'periodic', bcY: 'periodic', dx: 1 / NY, cfl: 0.4 });
      sim.initField((i, j) => {
        const y = (j + 0.5) / NY;
        const x = (i + 0.5) / NX;
        const band = Math.abs(y - 0.5) < 0.25;
        const rho = band ? 2 : 1;
        const u = band ? 0.5 : -0.5;
        // Localised seed at the two interfaces.
        const w = 0.05;
        const env = Math.exp(-((y - 0.25) ** 2) / (2 * w * w)) + Math.exp(-((y - 0.75) ** 2) / (2 * w * w));
        const v = 0.1 * Math.sin(4 * Math.PI * x) * env;
        return { rho, u, v, p: 2.5 };
      });
      return sim;
    },
  },
  rt: {
    label: 'Rayleigh–Taylor',
    is1D: false,
    defaultView: 'density',
    sub: 2,
    caption:
      'Rayleigh–Taylor: heavy gas resting on light gas under gravity. The hydrostatic balance is unstable, so a seeded ripple grows into mushrooming spikes and bubbles.',
    build: () => {
      const NX = 100;
      const NY = 300;
      const g = 0.1;
      const P0 = 2.5;
      const sim = new CompressibleEuler({
        nx: NX, ny: NY, gamma: GAMMA, bcX: 'reflective', bcY: 'reflective', dx: 1 / NY, cfl: 0.4, gravityY: g,
      });
      sim.initField((i, j) => {
        const x = (i + 0.5) / NX; // 0..1 across the (narrow) width
        const yy = (j + 0.5) / NY; // 0..1 height
        const heavy = yy > 0.5;
        const rho = heavy ? 2 : 1;
        const p = P0 + g * rho * (0.5 - yy); // hydrostatic, continuous at the interface
        // Single-mode velocity seed concentrated on the interface.
        const v = 0.01 * (1 + Math.cos(2 * Math.PI * (x - 0.5))) * Math.exp(-((yy - 0.5) ** 2) / (2 * 0.02 * 0.02));
        return { rho, u: 0, v, p };
      });
      return sim;
    },
  },
  implosion: {
    label: 'Implosion',
    is1D: false,
    defaultView: 'density',
    sub: 1,
    caption:
      'The Liska–Wendroff implosion: a low-pressure diamond in a sealed box. Converging shocks focus to the centre and a narrow jet shoots back out along the diagonal — a sharp test of symmetry preservation.',
    build: () => {
      const N = 200;
      const sim = new CompressibleEuler({ nx: N, ny: N, gamma: GAMMA, bcX: 'reflective', bcY: 'reflective', dx: 1 / N, cfl: 0.4 });
      sim.initField((i, j) => {
        const x = (i + 0.5) / N;
        const y = (j + 0.5) / N;
        const inDiamond = x + y < 0.5;
        return inDiamond ? { rho: 0.125, u: 0, v: 0, p: 0.14 } : { rho: 1, u: 0, v: 0, p: 1 };
      });
      return sim;
    },
  },
  bubble: {
    label: 'Shock × bubble',
    is1D: false,
    defaultView: 'schlieren',
    sub: 1,
    caption:
      'A Mach-1.5 shock sweeps right into a light gas bubble. The pressure jump refracts through the bubble and the baroclinic torque rolls it into a vortex pair (the Richtmyer–Meshkov mechanism).',
    build: () => {
      const NX = 260;
      const NY = 130;
      const sim = new CompressibleEuler({ nx: NX, ny: NY, gamma: GAMMA, bcX: 'transmissive', bcY: 'reflective', dx: 1 / NY, cfl: 0.4 });
      const post = postShock(1.5, 1, 1, GAMMA);
      const W = NX / NY; // physical width (height = 1)
      sim.initField((i, j) => {
        const x = (i + 0.5) / NY; // physical x in [0, W]
        const y = (j + 0.5) / NY; // physical y in [0, 1]
        if (x < 0.12 * W) return { rho: post.rho, u: post.u, v: 0, p: post.p }; // behind the shock
        const bx = 0.45 * W;
        const by = 0.5;
        const r = Math.hypot(x - bx, y - by);
        if (r < 0.18) return { rho: 0.1, u: 0, v: 0, p: 1 }; // light bubble
        return { rho: 1, u: 0, v: 0, p: 1 }; // ambient
      });
      return sim;
    },
  },
};

const SCENE_ORDER: Scene[] = ['sod', 'lax', 'blast', 'riemann2d', 'kh', 'rt', 'implosion', 'bubble'];

// --- scalar field accessor for a 2-D view -----------------------------------
function scalarAt(sim: CompressibleEuler, i: number, j: number, view: View): number {
  const k = sim.idx(i, j);
  const rho = sim.rho[k];
  if (view === 'density') return rho;
  const p = sim.pressureAt(k);
  if (view === 'pressure') return p;
  const u = sim.mx[k] / rho;
  const v = sim.my[k] / rho;
  const sp = Math.hypot(u, v);
  if (view === 'speed') return sp;
  if (view === 'mach') return sp / soundSpeed(rho, Math.max(p, 1e-9), sim.gamma);
  return rho; // schlieren handled separately
}

const VIEW_MAP: Record<Exclude<View, 'schlieren'>, (t: number) => RGB> = {
  density: viridis,
  pressure: inferno,
  speed: magma,
  mach: ice,
};

export function GasLab() {
  const flowRef = useRef<HTMLCanvasElement | null>(null);

  const [scene, setScene] = useState<Scene>('sod');
  const [view, setView] = useState<View>('density');
  const [paused, setPaused] = useState(false);
  const [info, setInfo] = useState({ t: 0, steps: 0, fps: 0, maxMach: 0, l1: NaN, extra: '' });

  const cfg = useRef({ scene, view, paused });
  useEffect(() => {
    cfg.current = { scene, view, paused };
  }, [scene, view, paused]);

  // Switch scene and reset to that scene's default view in one go.
  const pickScene = (s: Scene) => {
    setScene(s);
    setView(SCENES[s].defaultView);
  };

  const remakeRef = useRef<() => void>(() => {});

  useEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    const fctx = flow.getContext('2d');
    if (!fctx) return;

    let def = SCENES[cfg.current.scene];
    let sim = def.build();
    let off = document.createElement('canvas');
    let octx: CanvasRenderingContext2D;
    let img: ImageData;
    const setupOff = () => {
      off = document.createElement('canvas');
      off.width = sim.nx;
      off.height = sim.ny;
      octx = off.getContext('2d')!;
      img = octx.createImageData(sim.nx, sim.ny);
    };
    setupOff();

    const remake = () => {
      def = SCENES[cfg.current.scene];
      sim = def.build();
      setupOff();
    };
    remakeRef.current = remake;

    const render2D = () => {
      const { nx, ny } = sim;
      const data = img.data;
      const v = cfg.current.view;

      if (v === 'schlieren') {
        // Schlieren: a synthetic photographic shadowgraph. Brightness falls off
        // with |∇ρ| (steep density gradients = shock fronts go dark), the way a
        // real schlieren knife-edge reveals refraction.
        let gmax = 1e-9;
        const grad = new Float64Array(nx * ny);
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const k = sim.idx(i, j);
            const NXp = sim.NX;
            const gx = (sim.rho[k + 1] - sim.rho[k - 1]) * 0.5;
            const gy = (sim.rho[k + NXp] - sim.rho[k - NXp]) * 0.5;
            const g = Math.hypot(gx, gy);
            grad[i + nx * j] = g;
            if (g > gmax) gmax = g;
          }
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const g = grad[i + nx * j];
            const s = Math.exp(-12 * (g / gmax));
            const c = Math.round(255 * s);
            const o = 4 * (i + nx * (ny - 1 - j));
            data[o] = c;
            data[o + 1] = c;
            data[o + 2] = c;
            data[o + 3] = 255;
          }
      } else {
        // Auto-ranged sequential colour map over the interior.
        let lo = Infinity;
        let hi = -Infinity;
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const s = scalarAt(sim, i, j, v);
            if (s < lo) lo = s;
            if (s > hi) hi = s;
          }
        const span = hi - lo || 1;
        const map = VIEW_MAP[v as Exclude<View, 'schlieren'>];
        for (let j = 0; j < ny; j++)
          for (let i = 0; i < nx; i++) {
            const s = scalarAt(sim, i, j, v);
            const [r, gg, b] = map((s - lo) / span);
            const o = 4 * (i + nx * (ny - 1 - j));
            data[o] = r;
            data[o + 1] = gg;
            data[o + 2] = b;
            data[o + 3] = 255;
          }
      }
      octx.putImageData(img, 0, 0);

      // Letterbox the grid into the canvas, preserving aspect ratio.
      const cw = flow.width;
      const ch = flow.height;
      fctx.fillStyle = '#070a12';
      fctx.fillRect(0, 0, cw, ch);
      const ar = nx / ny;
      let dw = cw;
      let dh = cw / ar;
      if (dh > ch) {
        dh = ch;
        dw = ch * ar;
      }
      const dx = (cw - dw) / 2;
      const dy = (ch - dh) / 2;
      fctx.imageSmoothingEnabled = true;
      fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(off, dx, dy, dw, dh);
    };

    const render1D = () => {
      const n = sim.nx;
      const num = { rho: new Float64Array(n), u: new Float64Array(n), p: new Float64Array(n) };
      for (let i = 0; i < n; i++) {
        const k = sim.idx(i, 0);
        num.rho[i] = sim.rho[k];
        num.u[i] = sim.mx[k] / sim.rho[k];
        num.p[i] = sim.pressureAt(k);
      }
      // Exact reference at the current time.
      const star = exactRiemann(def.left!, def.right!, GAMMA);
      const t = Math.max(sim.time, 1e-9);
      const ex = { rho: new Float64Array(n), u: new Float64Array(n), p: new Float64Array(n) };
      for (let i = 0; i < n; i++) {
        const xc = (i + 0.5) / n;
        const s = star.sample((xc - 0.5) / t);
        ex.rho[i] = s.rho;
        ex.u[i] = s.u;
        ex.p[i] = s.p;
      }
      drawProfiles(fctx, flow.width, flow.height, num, ex);
      // L1 density error vs exact.
      let l1 = 0;
      for (let i = 0; i < n; i++) l1 += Math.abs(num.rho[i] - ex.rho[i]);
      return l1 / n;
    };

    let raf = 0;
    let frame = 0;
    let lastFpsT = performance.now();
    let fpsFrames = 0;
    let fps = 0;
    let blew = false;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const d = SCENES[cfg.current.scene];
      if (!cfg.current.paused && !blew) {
        for (let s = 0; s < d.sub; s++) {
          if (d.is1D && d.tEnd !== undefined && sim.time >= d.tEnd) break;
          const cap = d.is1D && d.tEnd !== undefined ? d.tEnd - sim.time : Infinity;
          sim.stepCFL(cap);
          if (!sim.isPhysical() || !Number.isFinite(sim.rho[sim.idx(sim.nx >> 1, sim.ny >> 1)])) {
            blew = true;
            break;
          }
        }
      }

      let l1 = NaN;
      if (d.is1D) l1 = render1D();
      else render2D();

      if (frame % 6 === 0) {
        // Peak Mach over the interior (a quick scan).
        let mm = 0;
        for (let j = 0; j < sim.ny; j += 2)
          for (let i = 0; i < sim.nx; i += 2) {
            const k = sim.idx(i, j);
            const rho = sim.rho[k];
            const sp = Math.hypot(sim.mx[k] / rho, sim.my[k] / rho);
            const m = sp / soundSpeed(rho, Math.max(sim.pressureAt(k), 1e-9), GAMMA);
            if (m > mm) mm = m;
          }
        const extra = blew ? 'unstable' : d.is1D && d.tEnd !== undefined && sim.time >= d.tEnd ? 'converged — paused at t_end' : '';
        setInfo({ t: sim.time, steps: sim.steps, fps, maxMach: mm, l1, extra });
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
    return () => cancelAnimationFrame(raf);
  }, []);

  // Rebuild when the scene changes.
  useEffect(() => {
    remakeRef.current();
  }, [scene]);

  const def = SCENES[scene];

  return (
    <div className="lab">
      <div className="lab-inner">
        <div className="verify-head">
          <h1>Gas dynamics — compressible Euler</h1>
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
          Every other solver in Eddy holds the fluid <strong>incompressible</strong> — no sound, no
          shocks. This one does the opposite physics: a from-scratch finite-volume{' '}
          <strong>Godunov</strong> scheme for the <strong>compressible Euler equations</strong>{' '}
          (MUSCL-Hancock reconstruction + an <strong>HLLC</strong> Riemann flux, Strang-split in 2-D)
          that captures real <strong>shock waves</strong> and contact discontinuities. The 1-D tubes
          overlay the <strong>exact Riemann solution</strong>; the{' '}
          <a href="#/verify">Verify</a> page proves the scheme converges to it.
        </p>

        <div className="kin-controls">
          <div className="segmented" role="group">
            {SCENE_ORDER.map((s) => (
              <button key={s} type="button" className={scene === s ? 'active' : ''} onClick={() => pickScene(s)}>
                {SCENES[s].label}
              </button>
            ))}
          </div>

          {!def.is1D && (
            <div className="segmented" role="group">
              {(['density', 'pressure', 'speed', 'mach', 'schlieren'] as View[]).map((vv) => (
                <button key={vv} type="button" className={view === vv ? 'active' : ''} onClick={() => setView(vv)}>
                  {vv === 'mach' ? 'Mach' : vv[0].toUpperCase() + vv.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="lab-grid">
          <figure className="lab-fig" style={{ width: '100%' }}>
            <canvas ref={flowRef} width={760} height={def.is1D ? 380 : 420} className="lab-canvas" />
            <figcaption>{def.caption}</figcaption>
          </figure>
        </div>

        <div className="lab-readout">
          <span>
            t = <strong>{info.t.toFixed(4)}</strong>
          </span>
          <span>{Math.round(info.steps).toLocaleString()} steps</span>
          {def.is1D ? (
            <span>
              L1 density error vs exact = <strong>{isFinite(info.l1) ? info.l1.toExponential(2) : '—'}</strong>
            </span>
          ) : (
            <span>peak Mach = {info.maxMach.toFixed(2)}</span>
          )}
          {info.extra && <span>{info.extra}</span>}
          <span>{info.fps.toFixed(0)} fps</span>
        </div>

        <p className="verify-blurb">
          The conserved variables (ρ, ρu, ρv, E) are stored on a collocated grid and updated by
          solving a little <strong>Riemann problem at every cell face</strong>. Second-order accuracy
          comes from a <strong>minmod-limited MUSCL-Hancock</strong> reconstruction (a half-step
          predictor evolves each face state by its own flux before the Riemann solve); the{' '}
          <strong>HLLC</strong> flux resolves the three-wave fan — left wave, contact, right wave — so
          shear and contact surfaces stay sharp where a plain HLL/Rusanov flux would smear them. The
          step size is capped by the CFL signal speed |u|+a. For the shock tubes the pale curve is the{' '}
          <strong>exact</strong> self-similar Riemann solution (an iterative solve of the pressure
          function, then a similarity sampler); the live <strong>L1 error</strong> is how far the
          finite-volume answer sits from it, and it shrinks as you refine. Try the{' '}
          <strong>Schlieren</strong> view on the blast and bubble scenes — it shadowgraphs |∇ρ|, so the
          shock fronts read exactly as they would in a wind-tunnel photograph.
        </p>

        <a className="back" href="#/">
          ← Back to the studio
        </a>
      </div>
    </div>
  );
}

// --- 1-D triple plot: ρ, u, p with the exact overlay ------------------------
function drawProfiles(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  num: { rho: Float64Array; u: Float64Array; p: Float64Array },
  ex: { rho: Float64Array; u: Float64Array; p: Float64Array },
): void {
  ctx.fillStyle = '#070a12';
  ctx.fillRect(0, 0, W, H);

  const panels: { key: 'rho' | 'u' | 'p'; label: string; color: string }[] = [
    { key: 'rho', label: 'density  ρ', color: '#6fd3ff' },
    { key: 'u', label: 'velocity  u', color: '#7ef0c8' },
    { key: 'p', label: 'pressure  p', color: '#ffb27e' },
  ];
  const padL = 8;
  const padR = 8;
  const gap = 10;
  const ph = (H - gap * (panels.length + 1)) / panels.length;
  const n = num.rho.length;

  panels.forEach((panel, idx) => {
    const y0 = gap + idx * (ph + gap);
    const yb = y0 + ph;
    const numA = num[panel.key];
    const exA = ex[panel.key];
    // Range from both series.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      lo = Math.min(lo, numA[i], exA[i]);
      hi = Math.max(hi, numA[i], exA[i]);
    }
    const pad = (hi - lo) * 0.08 || 0.1;
    lo -= pad;
    hi += pad;
    const span = hi - lo || 1;

    // Panel frame.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, y0, W - padL - padR, ph);

    const X = (i: number) => padL + (i / (n - 1)) * (W - padL - padR);
    const Y = (val: number) => yb - ((val - lo) / span) * ph;

    // Exact (pale, thick underlay).
    ctx.strokeStyle = 'rgba(220,228,245,0.45)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = X(i);
      const y = Y(exA[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Numerical (sharp colour line).
    ctx.strokeStyle = panel.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = X(i);
      const y = Y(numA[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = 'rgba(220,228,245,0.8)';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(panel.label, padL + 8, y0 + 16);
  });
}
