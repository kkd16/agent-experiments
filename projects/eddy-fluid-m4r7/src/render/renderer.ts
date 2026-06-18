// renderer.ts — turns a FluidSolver's fields into pixels.
//
// We render the field at grid resolution into a small ImageData, then let the
// canvas scale it up (bilinear via imageSmoothing) to the display size. This is
// far cheaper than a per-display-pixel sample and looks great because fluid
// fields are smooth. An optional velocity-arrow overlay is drawn on top.

import { FluidSolver } from '../sim/fluid';
import { COLORMAPS, diverging, type ColorMapName } from './colormaps';
import { computeLIC, makeNoise } from './lic';

export type RenderMode = 'dye' | 'speed' | 'pressure' | 'curl' | 'temperature' | 'lic' | 'schlieren';

export interface ParticleField {
  x: Float32Array;
  y: Float32Array;
  count: number;
}

export interface ProbeMark {
  gx: number; // grid cell x (1..N)
  gy: number; // grid cell y (1..N)
}

export interface RenderOptions {
  mode: RenderMode;
  colormap: ColorMapName;
  showArrows: boolean;
  showStreamlines: boolean;
  showParticles: boolean;
  exposure: number; // multiplier for dye/speed brightness
  particles?: ParticleField;
  /** Animation phase in [0,1) for the LIC texture (advances over time). */
  licPhase?: number;
  /** When set, a crosshair is drawn at this grid cell (the hover probe). */
  probe?: ProbeMark | null;
}

export class Renderer {
  private grid: HTMLCanvasElement;
  private gctx: CanvasRenderingContext2D;
  private image: ImageData;
  private N: number;
  // LIC working buffers (a white-noise texture + the convolved intensity field).
  private noise: Float32Array;
  private licBuf: Float32Array;

  constructor(N: number) {
    this.N = N;
    this.grid = document.createElement('canvas');
    this.grid.width = N;
    this.grid.height = N;
    const ctx = this.grid.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.gctx = ctx;
    this.image = this.gctx.createImageData(N, N);
    this.noise = makeNoise(N);
    this.licBuf = new Float32Array(N * N);
  }

  resize(N: number): void {
    this.N = N;
    this.grid.width = N;
    this.grid.height = N;
    this.image = this.gctx.createImageData(N, N);
    this.noise = makeNoise(N);
    this.licBuf = new Float32Array(N * N);
  }

  private fillImage(sim: FluidSolver, opts: RenderOptions): void {
    const N = this.N;
    const data = this.image.data;
    const cmap = COLORMAPS[opts.colormap];

    if (opts.mode === 'pressure' || opts.mode === 'curl') {
      // Signed fields: find a robust scale, then map with the diverging ramp.
      const field = opts.mode === 'pressure' ? sim.p : sim.curl;
      // curl is recomputed inside the solver; for a paused frame compute fresh.
      if (opts.mode === 'curl') {
        for (let j = 1; j <= N; j++)
          for (let i = 1; i <= N; i++) sim.curl[sim.IX(i, j)] = sim.curlAt(i, j);
      }
      let maxAbs = 1e-6;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const a = Math.abs(field[sim.IX(i, j)]);
          if (a > maxAbs) maxAbs = a;
        }
      const scale = (opts.exposure * 2.2) / maxAbs;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const idx = sim.IX(i + 1, j + 1);
          const o = (j * N + i) * 4;
          if (sim.solid[idx]) {
            data[o] = 38; data[o + 1] = 42; data[o + 2] = 54; data[o + 3] = 255;
            continue;
          }
          const [r, g, b] = diverging(field[idx] * scale);
          data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
        }
      }
      return;
    }

    if (opts.mode === 'temperature') {
      // Scalar T field, normalised to its current [min, max] then mapped through
      // the chosen perceptual ramp (the "heat" map reads as incandescence).
      const t = sim.t;
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = sim.IX(i, j);
          if (sim.solid[idx]) continue;
          const val = t[idx];
          if (val < lo) lo = val;
          if (val > hi) hi = val;
        }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      const span = hi - lo < 1e-6 ? 1e-6 : hi - lo;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const idx = sim.IX(i + 1, j + 1);
          const o = (j * N + i) * 4;
          if (sim.solid[idx]) {
            data[o] = 38; data[o + 1] = 42; data[o + 2] = 54; data[o + 3] = 255;
            continue;
          }
          const s = Math.min(1, Math.max(0, ((t[idx] - lo) / span) * opts.exposure));
          const [r, g, b] = cmap(s);
          data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
        }
      }
      return;
    }

    if (opts.mode === 'lic') {
      // Line Integral Convolution: a noise texture smeared along the streamlines,
      // tinted by local speed through the chosen colour-map. The texture animates
      // downstream as licPhase advances.
      computeLIC(
        { N, u: sim.u, v: sim.v, noise: this.noise, solid: sim.solid },
        this.licBuf,
        { steps: Math.min(22, Math.max(10, Math.round(N / 8))), phase: opts.licPhase ?? 0 },
      );
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const idx = sim.IX(i + 1, j + 1);
          const o = (j * N + i) * 4;
          if (sim.solid[idx]) {
            data[o] = 38; data[o + 1] = 42; data[o + 2] = 54; data[o + 3] = 255;
            continue;
          }
          // Contrast-stretch the convolved texture around its mid-grey.
          let tex = (this.licBuf[j * N + i] - 0.5) * 1.9 + 0.5;
          tex = tex < 0 ? 0 : tex > 1 ? 1 : tex;
          const speed = Math.min(1, sim.speedAt(idx) * 0.04 * opts.exposure);
          const [cr, cg, cb] = cmap(speed);
          // Streaks ride on a floor so still regions don't go fully black.
          const k = 0.22 + 0.78 * tex;
          data[o] = cr * k; data[o + 1] = cg * k; data[o + 2] = cb * k; data[o + 3] = 255;
        }
      }
      return;
    }

    if (opts.mode === 'schlieren') {
      // Synthetic schlieren / shadowgraph: brightness from |∇ρ|, the magnitude of
      // the dye-density gradient — the way a real schlieren rig images shock waves
      // and plumes by refraction through density variations.
      let maxAbs = 1e-6;
      const lum = (k: number) => 0.299 * sim.r[k] + 0.587 * sim.g[k] + 0.114 * sim.b[k];
      for (let j = 1; j <= N; j++)
        for (let i = 1; i <= N; i++) {
          const idx = sim.IX(i, j);
          if (sim.solid[idx]) continue;
          const gx = 0.5 * (lum(idx + 1) - lum(idx - 1));
          const gy = 0.5 * (lum(idx + (N + 2)) - lum(idx - (N + 2)));
          const m = Math.hypot(gx, gy);
          if (m > maxAbs) maxAbs = m;
        }
      const scale = (opts.exposure * 3) / maxAbs;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const idx = sim.IX(i + 1, j + 1);
          const o = (j * N + i) * 4;
          if (sim.solid[idx]) {
            data[o] = 38; data[o + 1] = 42; data[o + 2] = 54; data[o + 3] = 255;
            continue;
          }
          const gx = 0.5 * (lum(idx + 1) - lum(idx - 1));
          const gy = 0.5 * (lum(idx + (N + 2)) - lum(idx - (N + 2)));
          const s = Math.min(1, Math.hypot(gx, gy) * scale);
          const [r, g, b] = cmap(s);
          data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
        }
      }
      return;
    }

    if (opts.mode === 'speed') {
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const idx = sim.IX(i + 1, j + 1);
          const o = (j * N + i) * 4;
          if (sim.solid[idx]) {
            data[o] = 38; data[o + 1] = 42; data[o + 2] = 54; data[o + 3] = 255;
            continue;
          }
          const s = Math.min(1, sim.speedAt(idx) * 0.04 * opts.exposure);
          const [r, g, b] = cmap(s);
          data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
        }
      }
      return;
    }

    // dye mode: RGB channels straight to pixels with tonemapping.
    const exp = opts.exposure;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = sim.IX(i + 1, j + 1);
        const o = (j * N + i) * 4;
        if (sim.solid[idx]) {
          data[o] = 60; data[o + 1] = 66; data[o + 2] = 82; data[o + 3] = 255;
          continue;
        }
        // Reinhard-ish tonemap keeps highlights from clipping harshly.
        const tr = sim.r[idx] * exp;
        const tg = sim.g[idx] * exp;
        const tb = sim.b[idx] * exp;
        data[o] = 255 * (tr / (1 + tr));
        data[o + 1] = 255 * (tg / (1 + tg));
        data[o + 2] = 255 * (tb / (1 + tb));
        data[o + 3] = 255;
      }
    }
  }

  /** Render to the visible canvas. */
  draw(target: CanvasRenderingContext2D, sim: FluidSolver, opts: RenderOptions): void {
    this.fillImage(sim, opts);
    this.gctx.putImageData(this.image, 0, 0);

    const w = target.canvas.width;
    const h = target.canvas.height;
    target.imageSmoothingEnabled = true;
    target.imageSmoothingQuality = 'high';
    target.clearRect(0, 0, w, h);
    target.drawImage(this.grid, 0, 0, w, h);

    if (opts.showStreamlines) this.drawStreamlines(target, sim);
    if (opts.showParticles && opts.particles) this.drawParticles(target, sim, opts.particles);
    if (opts.showArrows) this.drawArrows(target, sim);
    if (opts.probe) this.drawProbe(target, opts.probe);
  }

  /** A crosshair marking the hover-probe sample point. */
  private drawProbe(target: CanvasRenderingContext2D, probe: ProbeMark): void {
    const N = this.N;
    const w = target.canvas.width;
    const cell = w / N;
    const x = (probe.gx - 0.5) * cell;
    const y = (probe.gy - 0.5) * cell;
    const r = Math.max(6, cell * 1.4);
    target.save();
    target.lineWidth = 1.5;
    target.strokeStyle = 'rgba(255,255,255,0.9)';
    target.beginPath();
    target.arc(x, y, r, 0, Math.PI * 2);
    target.moveTo(x - r * 1.6, y);
    target.lineTo(x - r * 0.5, y);
    target.moveTo(x + r * 0.5, y);
    target.lineTo(x + r * 1.6, y);
    target.moveTo(x, y - r * 1.6);
    target.lineTo(x, y - r * 0.5);
    target.moveTo(x, y + r * 0.5);
    target.lineTo(x, y + r * 1.6);
    target.stroke();
    target.restore();
  }

  /**
   * Streamlines: from a coarse lattice of seeds, integrate the (instantaneous)
   * velocity field with RK2 (midpoint) and draw the resulting curves. They trace
   * the flow's tangent everywhere, so vortices and stagnation points pop out.
   */
  private drawStreamlines(target: CanvasRenderingContext2D, sim: FluidSolver): void {
    const N = this.N;
    const w = target.canvas.width;
    const cell = w / N;
    const seedStep = Math.max(6, Math.floor(N / 22));
    const steps = 26;
    const h = 0.6; // grid cells advanced per (normalised) unit velocity, per substep
    const vel = { u: 0, v: 0 };
    const mid = { u: 0, v: 0 };
    target.lineWidth = 1;
    target.strokeStyle = 'rgba(255,255,255,0.30)';
    target.lineCap = 'round';
    target.beginPath();
    for (let sj = seedStep; sj <= N; sj += seedStep) {
      for (let si = seedStep; si <= N; si += seedStep) {
        if (sim.solid[sim.IX(si, sj)]) continue;
        let x = si;
        let y = sj;
        target.moveTo((x - 0.5) * cell, (y - 0.5) * cell);
        for (let k = 0; k < steps; k++) {
          sim.sampleVelocity(x, y, vel);
          const sp = Math.hypot(vel.u, vel.v);
          if (sp < 1e-4) break;
          // RK2 (midpoint): probe the half-step, then advance with its velocity.
          sim.sampleVelocity(x + 0.5 * h * vel.u, y + 0.5 * h * vel.v, mid);
          x += h * mid.u;
          y += h * mid.v;
          if (x < 1 || x > N || y < 1 || y > N || sim.isSolidAt(x, y)) break;
          target.lineTo((x - 0.5) * cell, (y - 0.5) * cell);
        }
      }
    }
    target.stroke();
  }

  /**
   * Passive tracer particles, drawn as short streaks along the local velocity so
   * a still frame reads as motion (the engine owns their positions & lifetimes).
   */
  private drawParticles(target: CanvasRenderingContext2D, sim: FluidSolver, p: ParticleField): void {
    const N = this.N;
    const w = target.canvas.width;
    const cell = w / N;
    const vel = { u: 0, v: 0 };
    target.lineWidth = Math.max(1, cell * 0.6);
    target.lineCap = 'round';
    target.beginPath();
    for (let k = 0; k < p.count; k++) {
      const gx = p.x[k];
      const gy = p.y[k];
      sim.sampleVelocity(gx, gy, vel);
      const tail = Math.min(2.5, Math.hypot(vel.u, vel.v) * 1.2);
      const px = (gx - 0.5) * cell;
      const py = (gy - 0.5) * cell;
      target.moveTo(px, py);
      target.lineTo(px - vel.u * tail * cell, py - vel.v * tail * cell);
    }
    target.strokeStyle = 'rgba(245,250,255,0.55)';
    target.stroke();
  }

  private drawArrows(target: CanvasRenderingContext2D, sim: FluidSolver): void {
    const N = this.N;
    const w = target.canvas.width;
    const h = target.canvas.height;
    const step = Math.max(4, Math.floor(N / 28));
    const cell = w / N;
    target.lineWidth = 1;
    target.strokeStyle = 'rgba(255,255,255,0.35)';
    target.beginPath();
    for (let j = 1; j <= N; j += step) {
      for (let i = 1; i <= N; i += step) {
        const idx = sim.IX(i, j);
        if (sim.solid[idx]) continue;
        const x = (i - 0.5) * cell;
        const y = (j - 0.5) * cell;
        const sc = Math.min(step * cell * 0.9, 14);
        const mag = sim.speedAt(idx) + 1e-6;
        const ux = (sim.u[idx] / mag) * Math.min(1, mag * 0.04) * sc;
        const uy = (sim.v[idx] / mag) * Math.min(1, mag * 0.04) * sc;
        target.moveTo(x, y);
        target.lineTo(x + ux, y + uy);
      }
    }
    target.stroke();
    void h;
  }
}
