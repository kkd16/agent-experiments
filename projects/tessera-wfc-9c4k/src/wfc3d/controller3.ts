// The 3D studio's engine host — the 3D analogue of ../wfc/controller.ts. It owns the compiled
// tileset (+ live weight overrides), the solver, the orbit camera and the merged voxel field, and
// drives a requestAnimationFrame loop that advances the solve, rebuilds the field from whatever
// has collapsed, and paints it through the from-scratch rasteriser. Camera orbit/zoom redraw on
// demand (so you can inspect a finished structure), and a tiny offscreen render gives the gallery
// its isometric thumbnails.

import { Camera } from './camera';
import { compile3, withWeights } from './compile3';
import { VoxField } from './field';
import { renderField } from './raster';
import { Solver3, type Solver3Status } from './solver3';
import { tileset3ByKey } from './tilesets3/index';
import type { CompiledTileset3 } from './types3';

export type Controller3Config = {
  tilesetKey: string;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  seed: string;
  wrap: boolean;
  backtracking: boolean;
  speed: number;
  edges: boolean;
};

export type Stats3 = {
  status: Solver3Status;
  collapsed: number;
  total: number;
  percent: number;
  contradictions: number;
  backtracks: number;
  restarts: number;
  steps: number;
  stepsPerSec: number;
  nTiles: number;
  running: boolean;
  faces: number;
};

const BACKW = 920;
const BACKH = 700;
const MAX_RESTARTS = 120;

export class Controller3 {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private cfg: Controller3Config;
  private cache = new Map<string, CompiledTileset3>();
  private base: CompiledTileset3;
  compiled: CompiledTileset3;
  private solver: Solver3;
  private field: VoxField;
  private camera = new Camera();
  private running = false;
  private raf = 0;
  private elapsedMs = 0;
  private lastTick = 0;
  private lastGen = -1;
  private faces = 0;
  private restarts = 0;
  private onStats: (s: Stats3) => void = () => {};
  private weightOverrides = new Map<string, Map<number, number>>();

  constructor(cfg: Controller3Config) {
    this.cfg = cfg;
    this.base = this.buildBase();
    this.compiled = this.applyOverrides();
    this.solver = this.makeSolver();
    this.field = this.makeField();
    this.fitCamera();
  }

  private buildBase(): CompiledTileset3 {
    const key = this.cfg.tilesetKey;
    let c = this.cache.get(key);
    if (!c) {
      c = compile3(tileset3ByKey(key));
      this.cache.set(key, c);
    }
    return c;
  }

  private applyOverrides(): CompiledTileset3 {
    const ov = this.weightOverrides.get(this.cfg.tilesetKey);
    return ov ? withWeights(this.base, ov) : this.base;
  }

  private makeSolver(seedOverride?: string): Solver3 {
    return new Solver3(this.compiled, {
      sizeX: this.cfg.sizeX,
      sizeY: this.cfg.sizeY,
      sizeZ: this.cfg.sizeZ,
      seed: seedOverride ?? this.cfg.seed,
      wrap: this.cfg.wrap,
      backtracking: this.cfg.backtracking,
      backtrackBudget: 6000,
    });
  }

  private makeField(): VoxField {
    return new VoxField(this.cfg.sizeX, this.cfg.sizeY, this.cfg.sizeZ, this.compiled.res);
  }

  // ---- camera --------------------------------------------------------------

  /** Frame the whole lattice: centre the camera and pick a scale that fits the backing store. */
  private fitCamera(): void {
    const span = Math.max(this.field.fx, this.field.fy, this.field.fz);
    this.camera.scale = (Math.min(BACKW, BACKH) / (span * 1.45)) * this.zoom;
    this.camera.cx = BACKW / 2;
    this.camera.cy = BACKH / 2 + this.field.fy * 0.18 * this.camera.scale;
    this.camera.refresh();
  }
  private zoom = 1;

  orbit(dxRad: number, dyRad: number): void {
    this.camera.yaw += dxRad;
    this.camera.pitch = Math.max(-0.2, Math.min(1.45, this.camera.pitch + dyRad));
    this.camera.refresh();
    this.draw();
  }

  zoomBy(factor: number): void {
    this.zoom = Math.max(0.4, Math.min(3, this.zoom * factor));
    this.fitCamera();
    this.draw();
  }

  get cameraAngles(): { yaw: number; pitch: number; zoom: number } {
    return { yaw: this.camera.yaw, pitch: this.camera.pitch, zoom: this.zoom };
  }

  // ---- lifecycle -----------------------------------------------------------

  attach(canvas: HTMLCanvasElement, onStats: (s: Stats3) => void): void {
    this.canvas = canvas;
    canvas.width = BACKW;
    canvas.height = BACKH;
    this.ctx = canvas.getContext('2d');
    this.onStats = onStats;
    this.rebuildField();
    this.draw();
    this.emit();
  }

  detach(): void {
    this.pause();
    this.canvas = null;
    this.ctx = null;
  }

  // ---- field + draw --------------------------------------------------------

  private rebuildField(): void {
    this.field.clear();
    const { sizeX: sx, sizeY: sy, sizeZ: sz } = this.cfg;
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) {
          const cell = x + sx * (y + sy * z);
          const t = this.solver.collapsedTile(cell);
          if (t >= 0) this.field.place(this.compiled.variants[t].model, x, y, z);
        }
    this.lastGen = this.solver.generation;
  }

  private paintBackground(): void {
    const ctx = this.ctx!;
    const g = ctx.createLinearGradient(0, 0, 0, BACKH);
    g.addColorStop(0, '#0c1322');
    g.addColorStop(1, '#070a12');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, BACKW, BACKH);
  }

  private draw(): void {
    if (!this.ctx) return;
    if (this.solver.generation !== this.lastGen) this.rebuildField();
    this.paintBackground();
    const stats = renderField(this.ctx, this.field, this.camera, BACKW, BACKH, this.cfg.edges);
    this.faces = stats.faces;
  }

  private emit(): void {
    const s = this.solver;
    const elapsedSec = this.elapsedMs / 1000;
    this.onStats({
      status: s.status,
      collapsed: s.collapsedCount,
      total: s.total,
      percent: s.total ? s.collapsedCount / s.total : 0,
      contradictions: s.contradictions,
      backtracks: s.backtracks,
      restarts: this.restarts,
      steps: s.steps,
      stepsPerSec: elapsedSec > 0.05 ? s.steps / elapsedSec : 0,
      nTiles: this.compiled.variants.length,
      running: this.running,
      faces: this.faces,
    });
  }

  // ---- config --------------------------------------------------------------

  update(patch: Partial<Controller3Config>, rebuild: boolean): void {
    const prevKey = this.cfg.tilesetKey;
    this.cfg = { ...this.cfg, ...patch };
    const setChanged = this.cfg.tilesetKey !== prevKey;
    if (setChanged) {
      this.base = this.buildBase();
      this.compiled = this.applyOverrides();
    }
    if (rebuild || setChanged) {
      this.pause();
      this.restarts = 0;
      this.elapsedMs = 0;
      this.solver = this.makeSolver();
      this.field = this.makeField();
      this.fitCamera();
      this.rebuildField();
    }
    this.draw();
    this.emit();
  }

  reset(): void {
    this.pause();
    this.restarts = 0;
    this.elapsedMs = 0;
    this.solver = this.makeSolver();
    this.field = this.makeField();
    this.rebuildField();
    this.draw();
    this.emit();
  }

  // ---- transport -----------------------------------------------------------

  play(): void {
    if (this.running) return;
    if (this.solver.status !== 'running') this.reset();
    this.running = true;
    this.lastTick = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.emit();
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.play();
  }

  stepOnce(): void {
    if (this.solver.status !== 'running') this.reset();
    this.advance(1);
    this.draw();
    this.emit();
  }

  canRecord(): boolean {
    return false; // 3D recording is out of scope; PNG export covers capture
  }

  private advance(n: number): Solver3Status {
    let status = this.solver.status;
    for (let i = 0; i < n; i++) {
      status = this.solver.step();
      if (status === 'failed') {
        this.restarts++;
        if (this.restarts > MAX_RESTARTS) {
          status = 'failed';
          break;
        }
        this.solver = this.makeSolver(`${this.cfg.seed}#${this.restarts}`);
        if (this.solver.status === 'failed') {
          status = 'failed';
          break;
        }
        status = 'running';
      } else if (status === 'done') {
        break;
      }
    }
    return status;
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.elapsedMs += now - this.lastTick;
    this.lastTick = now;
    const status = this.advance(this.cfg.speed);
    this.draw();
    this.emit();
    if (status === 'done' || status === 'failed') {
      this.running = false;
      this.emit();
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  // ---- export --------------------------------------------------------------

  exportPng(): void {
    if (!this.canvas) return;
    try {
      const url = this.canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `tessera3d-${this.cfg.tilesetKey}-${this.cfg.seed}.png`;
      a.click();
    } catch {
      /* sandboxed thumbnails may block toDataURL — ignore */
    }
  }

  // ---- weights -------------------------------------------------------------

  get tileset(): CompiledTileset3 {
    return this.compiled;
  }

  defaultWeight(id: number): number {
    return this.base.weights[id] ?? 1;
  }

  hasWeightOverrides(): boolean {
    const ov = this.weightOverrides.get(this.cfg.tilesetKey);
    return !!ov && ov.size > 0;
  }

  setWeight(id: number, w: number): void {
    let ov = this.weightOverrides.get(this.cfg.tilesetKey);
    if (!ov) {
      ov = new Map();
      this.weightOverrides.set(this.cfg.tilesetKey, ov);
    }
    ov.set(id, Math.max(0.01, w));
    this.compiled = this.applyOverrides();
    this.solver = this.makeSolver();
    this.field = this.makeField();
    this.rebuildField();
    this.draw();
    this.emit();
  }

  resetWeights(): void {
    this.weightOverrides.delete(this.cfg.tilesetKey);
    this.compiled = this.applyOverrides();
    this.solver = this.makeSolver();
    this.field = this.makeField();
    this.rebuildField();
    this.draw();
    this.emit();
  }
}
