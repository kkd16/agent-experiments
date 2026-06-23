// The hex studio's engine host — the hex analogue of ../wfc/controller.ts and ../wfc3d/controller3.ts.
// It owns the compiled tileset (+ live weight overrides), the solver, and a requestAnimationFrame
// loop that advances the solve and repaints the board through the from-scratch hex renderer. View
// toggles (ghost / entropy / grid) redraw without rebuilding. A pixel→cell hit-test powers the
// viewport's hover lens.

import { compileHex, withWeights } from './compile_hex';
import { layoutHex, renderHex, type HexLayout } from './hexraster';
import { HexSolver, type HexSolverStatus } from './hexsolver';
import { hexTilesetByKey } from './tilesets/index';
import { SQRT3 } from './hexgrid';
import type { CompiledHexTileset } from './types_hex';

export type ControllerHexConfig = {
  tilesetKey: string;
  cols: number;
  rows: number;
  seed: string;
  wrap: boolean;
  backtracking: boolean;
  speed: number;
  showGhost: boolean;
  showEntropy: boolean;
  showGrid: boolean;
};

export type StatsHex = {
  status: HexSolverStatus;
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
};

export const BACKW = 980;
export const BACKH = 720;
const MAX_RESTARTS = 200;

export class ControllerHex {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private cfg: ControllerHexConfig;
  private cache = new Map<string, CompiledHexTileset>();
  private base: CompiledHexTileset;
  compiled: CompiledHexTileset;
  private solver: HexSolver;
  private running = false;
  private raf = 0;
  private elapsedMs = 0;
  private lastTick = 0;
  private restarts = 0;
  private layout: HexLayout | null = null;
  private onStats: (s: StatsHex) => void = () => {};
  private weightOverrides = new Map<string, Map<number, number>>();

  constructor(cfg: ControllerHexConfig) {
    this.cfg = cfg;
    this.base = this.buildBase();
    this.compiled = this.applyOverrides();
    this.solver = this.makeSolver();
  }

  private buildBase(): CompiledHexTileset {
    const key = this.cfg.tilesetKey;
    let c = this.cache.get(key);
    if (!c) {
      c = compileHex(hexTilesetByKey(key));
      this.cache.set(key, c);
    }
    return c;
  }

  private applyOverrides(): CompiledHexTileset {
    const ov = this.weightOverrides.get(this.cfg.tilesetKey);
    return ov ? withWeights(this.base, ov) : this.base;
  }

  private makeSolver(seedOverride?: string): HexSolver {
    return new HexSolver(this.compiled, {
      cols: this.cfg.cols,
      rows: this.cfg.rows,
      seed: seedOverride ?? this.cfg.seed,
      wrap: this.cfg.wrap,
      backtracking: this.cfg.backtracking,
      backtrackBudget: 8000,
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  attach(canvas: HTMLCanvasElement, onStats: (s: StatsHex) => void): void {
    this.canvas = canvas;
    canvas.width = BACKW;
    canvas.height = BACKH;
    this.ctx = canvas.getContext('2d');
    this.onStats = onStats;
    this.draw();
    this.emit();
  }

  detach(): void {
    this.pause();
    this.canvas = null;
    this.ctx = null;
  }

  // ---- draw ----------------------------------------------------------------

  private paintBackground(): void {
    const ctx = this.ctx!;
    const g = ctx.createLinearGradient(0, 0, 0, BACKH);
    g.addColorStop(0, '#0c1018');
    g.addColorStop(1, '#070a10');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, BACKW, BACKH);
  }

  private draw(): void {
    if (!this.ctx) return;
    this.paintBackground();
    this.layout = renderHex(this.ctx, this.compiled, this.solver, BACKW, BACKH, {
      showGhost: this.cfg.showGhost,
      showEntropy: this.cfg.showEntropy,
      showGrid: this.cfg.showGrid,
    });
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
    });
  }

  // ---- hover lens ----------------------------------------------------------

  /** Map a point in backing-store pixels to a cell index, or -1 if outside the board. */
  cellAtBackingPx(px: number, py: number): number {
    const lay = this.layout ?? layoutHex(this.cfg.cols, this.cfg.rows, BACKW, BACKH, 18);
    const x = (px - lay.ox) / lay.s;
    const y = (py - lay.oy) / lay.s;
    // pixel → fractional axial (pointy-top)
    const rf = y / 1.5;
    const qf = x / SQRT3 - rf / 2;
    // cube rounding
    const xc = qf;
    const zc = rf;
    const yc = -xc - zc;
    let rx = Math.round(xc);
    let rz = Math.round(zc);
    const ry = Math.round(yc);
    const dx = Math.abs(rx - xc);
    const dy = Math.abs(ry - yc);
    const dz = Math.abs(rz - zc);
    // restore x + y + z = 0 by recomputing whichever component carried the largest rounding error;
    // we only read q (=x) and r (=z), so a y-dominant error needs no adjustment.
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dz >= dy) rz = -rx - ry;
    const q = rx;
    const r = rz;
    if (q < 0 || r < 0 || q >= this.cfg.cols || r >= this.cfg.rows) return -1;
    return q + this.cfg.cols * r;
  }

  lensInfo(cell: number): { count: number; total: number } {
    return { count: this.solver.possibilities(cell), total: this.compiled.variants.length };
  }

  get backingSize(): { w: number; h: number } {
    return { w: BACKW, h: BACKH };
  }

  // ---- config --------------------------------------------------------------

  update(patch: Partial<ControllerHexConfig>, rebuild: boolean): void {
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
    }
    this.draw();
    this.emit();
  }

  reset(): void {
    this.pause();
    this.restarts = 0;
    this.elapsedMs = 0;
    this.solver = this.makeSolver();
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

  private advance(n: number): HexSolverStatus {
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
      a.download = `tessera-hex-${this.cfg.tilesetKey}-${this.cfg.seed}.png`;
      a.click();
    } catch {
      /* sandboxed thumbnails may block toDataURL — ignore */
    }
  }

  // ---- weights -------------------------------------------------------------

  get tileset(): CompiledHexTileset {
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
    this.draw();
    this.emit();
  }

  resetWeights(): void {
    this.weightOverrides.delete(this.cfg.tilesetKey);
    this.compiled = this.applyOverrides();
    this.solver = this.makeSolver();
    this.draw();
    this.emit();
  }
}
