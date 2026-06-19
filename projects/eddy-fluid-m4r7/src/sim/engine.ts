// engine.ts — owns the simulation loop, pointer interaction, and scene state.
//
// Velocities live on a normalised scale: a stored velocity of ~1.0 carries
// fluid across roughly one domain width per second (advection backtraces by
// dt·N·u cells). All scene/pointer forces are expressed on that scale.

import { FluidSolver, type FluidParams } from './fluid';
import { Renderer, type RenderMode } from '../render/renderer';
import type { ColorMapName } from '../render/colormaps';
import { ParticleSystem } from './particles';
import { sceneById, type Scene } from './scenes';
import { hexToDye, type Settings, type Tool } from '../state/settings';
import { hueToRGB } from './scenes';

export interface ProbeReading {
  gx: number;
  gy: number;
  u: number;
  v: number;
  speed: number;
  curl: number;
  pressure: number;
  temp: number;
  fuel: number;
  solid: boolean;
}

export interface Stats {
  fps: number;
  stepMs: number;
  resolution: number;
  paused: boolean;
  kineticEnergy: number;
  enstrophy: number;
  maxDivergence: number;
  probe: ProbeReading | null;
}

const FORCE_BASE = 0.16; // tames pointer-derived velocities to the normalised scale

interface Pointer {
  active: boolean;
  gx: number; // grid cell x
  gy: number; // grid cell y
  dx: number; // normalised dye-domain velocity since last frame
  dy: number;
  moved: boolean;
}

function particleCount(N: number): number {
  return Math.min(5000, Math.max(800, Math.round(N * N * 0.12)));
}

export class FluidEngine {
  sim: FluidSolver;
  private renderer: Renderer;
  private particles: ParticleSystem;
  private ctx: CanvasRenderingContext2D;
  private settings: Settings;
  private scene: Scene;
  private sceneTime = 0;
  private raf = 0;
  private last = 0;
  private hueCycle = 0;

  private pointer: Pointer = { active: false, gx: 0, gy: 0, dx: 0, dy: 0, moved: false };
  private paused = false;
  private stepOnce = false;
  private hover: { gx: number; gy: number } | null = null;
  private licPhase = 0;

  // FPS smoothing.
  private frameTimes: number[] = [];
  private lastStepMs = 0;

  onStats?: (s: Stats) => void;

  constructor(canvas: HTMLCanvasElement, settings: Settings) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.settings = settings;
    this.sim = new FluidSolver(settings.resolution);
    this.renderer = new Renderer(settings.resolution);
    this.particles = new ParticleSystem(particleCount(settings.resolution), settings.resolution);
    this.particles.seed(this.sim);
    this.scene = sceneById(settings.sceneId);
  }

  start(): void {
    this.last = performance.now();
    this.loop(this.last);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  setSettings(s: Settings): void {
    if (s.resolution !== this.sim.N) {
      this.resize(s.resolution);
    }
    this.settings = s;
  }

  private resize(n: number): void {
    const old = this.sim;
    this.sim = new FluidSolver(n);
    this.renderer.resize(n);
    this.particles = new ParticleSystem(particleCount(n), n);
    // Re-seed the active scene at the new resolution rather than interpolating.
    void old;
    this.loadScene(this.scene.id, false);
  }

  loadScene(id: string, applyParams = true): Partial<Settings> | undefined {
    this.scene = sceneById(id);
    this.sim.reset();
    this.sceneTime = 0;
    this.scene.setup(this.sim);
    this.particles.seed(this.sim);
    if (applyParams) {
      const patch: Partial<Settings> = { sceneId: id };
      if (this.scene.params) patch.params = { ...this.settings.params, ...this.scene.params };
      if (this.scene.exposure != null) patch.exposure = this.scene.exposure;
      return patch;
    }
    return undefined;
  }

  setPaused(p: boolean): void {
    this.paused = p;
  }

  requestStep(): void {
    this.stepOnce = true;
  }

  reset(): void {
    this.loadScene(this.scene.id, false);
  }

  clearDye(): void {
    this.sim.clearDye();
  }

  clearWalls(): void {
    this.sim.clearSolids();
  }

  // --- Pointer ------------------------------------------------------------

  pointerDown(nx: number, ny: number): void {
    const g = this.toGrid(nx, ny);
    this.pointer = { active: true, gx: g.gx, gy: g.gy, dx: 0, dy: 0, moved: false };
  }

  pointerMove(nx: number, ny: number, vdx: number, vdy: number): void {
    if (!this.pointer.active) return;
    const g = this.toGrid(nx, ny);
    this.pointer.gx = g.gx;
    this.pointer.gy = g.gy;
    this.pointer.dx += vdx;
    this.pointer.dy += vdy;
    this.pointer.moved = true;
  }

  pointerUp(): void {
    this.pointer.active = false;
  }

  /** Track the cursor for the hover probe (independent of dragging). */
  setHover(nx: number, ny: number): void {
    this.hover = this.toGrid(nx, ny);
  }

  clearHover(): void {
    this.hover = null;
  }

  private toGrid(nx: number, ny: number): { gx: number; gy: number } {
    const N = this.sim.N;
    return {
      gx: Math.max(1, Math.min(N, Math.round(nx * N))),
      gy: Math.max(1, Math.min(N, Math.round(ny * N))),
    };
  }

  private applyPointer(dt: number): void {
    const p = this.pointer;
    if (!p.active) return;
    const s = this.settings;
    const tool: Tool = s.tool;
    if (tool === 'wall' || tool === 'erase') {
      this.sim.paintSolid(p.gx, p.gy, s.brushRadius, tool === 'wall');
      p.dx = p.dy = 0;
      return;
    }
    if (tool === 'heat') {
      // Inject heat (and a gentle upward nudge so it reads immediately).
      this.sim.splatHeat(p.gx, p.gy, 6, s.brushRadius);
      const fy = (p.dy / Math.max(dt, 1e-3)) * FORCE_BASE * s.forceScale;
      const fx = (p.dx / Math.max(dt, 1e-3)) * FORCE_BASE * s.forceScale;
      this.sim.splat(p.gx, p.gy, fx, fy, [0, 0, 0], s.brushRadius, 0);
      p.dx = p.dy = 0;
      return;
    }
    if (tool === 'fuel') {
      // Lay down fuel plus a small pilot heat so it lights wherever the reaction
      // rate is on (the Fire scene, or any nonzero Combustion → Reaction rate).
      this.sim.splatFuel(p.gx, p.gy, 3, s.brushRadius);
      this.sim.splatHeat(p.gx, p.gy, 1.5, s.brushRadius);
      p.dx = p.dy = 0;
      return;
    }
    // dye tool
    const fx = (p.dx / Math.max(dt, 1e-3)) * FORCE_BASE * s.forceScale;
    const fy = (p.dy / Math.max(dt, 1e-3)) * FORCE_BASE * s.forceScale;
    const color =
      s.brushColor === 'rainbow' ? hueToRGB(this.hueCycle % 1, 2.4) : hexToDye(s.brushColor, 2.0);
    this.sim.splat(p.gx, p.gy, fx, fy, color, s.brushRadius, 1.6);
    this.hueCycle += 0.02;
    p.dx = p.dy = 0;
  }

  // --- Loop ---------------------------------------------------------------

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.05) dt = 0.05; // clamp after a stall
    if (dt <= 0) dt = 1 / 60;

    const running = !this.paused || this.stepOnce;
    if (running) {
      const t0 = performance.now();
      const simDt = this.paused ? 1 / 60 : dt;
      this.scene.emit?.(this.sim, { time: this.sceneTime, dt: simDt });
      this.applyPointer(simDt);
      this.sim.step(simDt, this.settings.params satisfies FluidParams);
      if (this.settings.showParticles) this.particles.update(this.sim, simDt);
      this.sceneTime += simDt;
      this.lastStepMs = performance.now() - t0;
      this.stepOnce = false;
      // Advance the LIC texture so it appears to stream with the flow.
      this.licPhase = (this.licPhase + simDt * 0.6) % 1;
    } else {
      this.applyPointer(dt); // allow painting walls/dye while paused
    }

    const probeMark =
      this.settings.showProbe && this.hover ? { gx: this.hover.gx, gy: this.hover.gy } : null;

    this.renderer.draw(this.ctx, this.sim, {
      mode: this.settings.mode as RenderMode,
      colormap: this.settings.colormap as ColorMapName,
      showArrows: this.settings.showArrows,
      showStreamlines: this.settings.showStreamlines,
      showParticles: this.settings.showParticles,
      exposure: this.settings.exposure,
      particles: this.settings.showParticles
        ? { x: this.particles.x, y: this.particles.y, count: this.particles.capacity }
        : undefined,
      licPhase: this.licPhase,
      ftleTime: this.settings.ftleTime,
      ftleBackward: this.settings.ftleBackward,
      probe: probeMark,
    });

    this.reportStats(now);
  };

  /** Read every field at the hover cell — powers the live probe readout. */
  private readProbe(): ProbeReading | null {
    if (!this.hover) return null;
    const { gx, gy } = this.hover;
    const sim = this.sim;
    const idx = sim.IX(gx, gy);
    return {
      gx,
      gy,
      u: sim.u[idx],
      v: sim.v[idx],
      speed: Math.hypot(sim.u[idx], sim.v[idx]),
      curl: sim.curlAt(gx, gy),
      pressure: sim.p[idx],
      temp: sim.t[idx],
      fuel: sim.fuel[idx],
      solid: sim.solid[idx] !== 0,
    };
  }

  private reportStats(now: number): void {
    this.frameTimes.push(now);
    while (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.frameTimes.length >= 2 && this.onStats) {
      const span = (this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0]) / 1000;
      const fps = span > 0 ? (this.frameTimes.length - 1) / span : 0;
      const d = this.sim.diagnostics();
      this.onStats({
        fps,
        stepMs: this.lastStepMs,
        resolution: this.sim.N,
        paused: this.paused,
        kineticEnergy: d.kineticEnergy,
        enstrophy: d.enstrophy,
        maxDivergence: d.maxDivergence,
        probe: this.readProbe(),
      });
    }
  }
}
