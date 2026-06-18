import { render, type RenderOptions } from './render';
import { Solver, type SolverStatus } from './solver';
import { compile } from './tiles';
import { tilesetByKey } from './tilesets';
import type { CompiledTileset } from './types';

export type ControllerConfig = {
  tilesetKey: string;
  size: number;
  seed: string;
  wrap: boolean;
  backtracking: boolean;
  speed: number; // logical steps per animation frame
  showGhost: boolean;
  showEntropy: boolean;
  showGrid: boolean;
};

export type Stats = {
  status: SolverStatus;
  collapsed: number;
  total: number;
  percent: number;
  contradictions: number;
  backtracks: number;
  restarts: number;
  steps: number;
  stepsPerSec: number;
  elapsedMs: number;
  nTiles: number;
  running: boolean;
};

const TARGET_PX = 760; // rendered backing-store size (CSS scales it to fit)

export class Controller {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private cfg: ControllerConfig;
  private compiledCache = new Map<string, CompiledTileset>();
  private compiled: CompiledTileset;
  private solver: Solver;
  private running = false;
  private raf = 0;
  private cellPx = 16;
  private restarts = 0;
  private elapsedMs = 0;
  private lastTick = 0;
  private onStats: (s: Stats) => void = () => {};

  constructor(cfg: ControllerConfig) {
    this.cfg = cfg;
    this.compiled = this.getCompiled(cfg.tilesetKey);
    this.solver = this.makeSolver();
  }

  private getCompiled(key: string): CompiledTileset {
    let c = this.compiledCache.get(key);
    if (!c) {
      c = compile(tilesetByKey(key));
      this.compiledCache.set(key, c);
    }
    return c;
  }

  private makeSolver(seedOverride?: string): Solver {
    const { size, seed, wrap, backtracking } = this.cfg;
    return new Solver(this.compiled, {
      width: size,
      height: size,
      seed: seedOverride ?? seed,
      wrap,
      backtracking,
      backtrackBudget: 4000,
    });
  }

  attach(canvas: HTMLCanvasElement, onStats: (s: Stats) => void): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onStats = onStats;
    this.resizeCanvas();
    this.draw();
    this.emit();
  }

  detach(): void {
    this.pause();
    this.canvas = null;
    this.ctx = null;
  }

  private resizeCanvas(): void {
    if (!this.canvas) return;
    this.cellPx = Math.max(4, Math.floor(TARGET_PX / this.cfg.size));
    this.canvas.width = this.cfg.size * this.cellPx;
    this.canvas.height = this.cfg.size * this.cellPx;
  }

  private renderOpts(): RenderOptions {
    return {
      cellPx: this.cellPx,
      showGhost: this.cfg.showGhost,
      showEntropy: this.cfg.showEntropy,
      showGrid: this.cfg.showGrid,
    };
  }

  private draw(): void {
    if (!this.ctx) return;
    render(this.ctx, this.solver, this.compiled, this.renderOpts());
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
      elapsedMs: this.elapsedMs,
      nTiles: this.compiled.variants.length,
      running: this.running,
    });
  }

  // ---- config -------------------------------------------------------------

  /** Apply config. `rebuild` recreates the solver (size/seed/tileset/edges changed). */
  update(patch: Partial<ControllerConfig>, rebuild: boolean): void {
    const tilesetChanged = patch.tilesetKey !== undefined && patch.tilesetKey !== this.cfg.tilesetKey;
    this.cfg = { ...this.cfg, ...patch };
    if (tilesetChanged) this.compiled = this.getCompiled(this.cfg.tilesetKey);
    if (rebuild) {
      this.pause();
      this.restarts = 0;
      this.elapsedMs = 0;
      this.resizeCanvas();
      this.solver = this.makeSolver();
    }
    this.draw();
    this.emit();
  }

  reset(): void {
    this.pause();
    this.restarts = 0;
    this.elapsedMs = 0;
    this.resizeCanvas();
    this.solver = this.makeSolver();
    this.draw();
    this.emit();
  }

  // ---- transport ----------------------------------------------------------

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

  /** Run `n` logical steps, handling auto-restart when a run fails. */
  private advance(n: number): SolverStatus {
    let status = this.solver.status;
    for (let i = 0; i < n; i++) {
      status = this.solver.step();
      if (status === 'failed') {
        this.restarts++;
        this.solver = this.makeSolver(`${this.cfg.seed}#${this.restarts}`);
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
    if (status === 'done') {
      this.running = false;
      this.emit();
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  // ---- export -------------------------------------------------------------

  exportPng(): void {
    if (!this.canvas) return;
    const url = this.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `tessera-${this.cfg.tilesetKey}-${this.cfg.seed}.png`;
    a.click();
  }

  get tileset(): CompiledTileset {
    return this.compiled;
  }
}
