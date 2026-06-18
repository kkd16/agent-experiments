import { compileOverlap } from './overlap';
import { render, type RenderOptions } from './render';
import { sampleByKey, type Sample } from './samples';
import { Solver, type SolverStatus } from './solver';
import { compile } from './tiles';
import { tilesetByKey } from './tilesets';
import type { CompiledTileset } from './types';

/** Which WFC model is running: hand-authored tiles, or patterns learnt from a bitmap. */
export type WfcModel = 'tiled' | 'overlap';

export type ControllerConfig = {
  /** Active model. The two halves below configure one model each. */
  model: WfcModel;
  // --- tiled model ---
  tilesetKey: string;
  // --- overlapping model ---
  sampleKey: string;
  /** Present (and used) only when `sampleKey === 'custom'`. */
  customSample?: Sample;
  patternN: number; // pattern side length (2 or 3)
  symmetry: number; // 1, 2, 4 or 8
  periodicInput: boolean;
  // --- shared ---
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
const MAX_RESTARTS = 240; // bound auto-restarts so an unsatisfiable config can't spin forever

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
    this.compiled = this.buildCompiled();
    this.solver = this.makeSolver();
  }

  /** The example bitmap the overlapping model should learn from, given the current config. */
  private currentSample(): Sample {
    if (this.cfg.sampleKey === 'custom' && this.cfg.customSample) return this.cfg.customSample;
    return sampleByKey(this.cfg.sampleKey);
  }

  /** A cache key capturing every input that affects the compiled tile/pattern set. */
  private compileKey(): string {
    if (this.cfg.model === 'tiled') return `tiled:${this.cfg.tilesetKey}`;
    const s = this.currentSample();
    const sig = this.cfg.sampleKey === 'custom' ? `custom-${s.width}x${s.height}-${hashGrid(s.grid)}` : this.cfg.sampleKey;
    return `overlap:${sig}:n${this.cfg.patternN}:y${this.cfg.symmetry}:p${this.cfg.periodicInput ? 1 : 0}`;
  }

  private buildCompiled(): CompiledTileset {
    const key = this.compileKey();
    let c = this.compiledCache.get(key);
    if (!c) {
      if (this.compiledCache.size > 24) this.compiledCache.clear(); // bound memory across edits
      c =
        this.cfg.model === 'tiled'
          ? compile(tilesetByKey(this.cfg.tilesetKey))
          : compileOverlap(this.currentSample(), {
              n: this.cfg.patternN,
              symmetry: this.cfg.symmetry,
              periodicInput: this.cfg.periodicInput,
            });
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
    const prevKey = this.compileKey();
    this.cfg = { ...this.cfg, ...patch };
    const setChanged = this.compileKey() !== prevKey;
    if (setChanged) this.compiled = this.buildCompiled();
    // A different tile/pattern set means the solver's arrays are the wrong shape — always rebuild.
    if (rebuild || setChanged) {
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
        // Some configs are globally unsatisfiable but locally consistent (e.g. a sample whose
        // period doesn't divide a toroidal grid): every fresh attempt fails after backtracking,
        // so unbounded reseeding would spin forever. Give up after a generous budget — solvable
        // runs essentially never need this many restarts.
        if (this.restarts > MAX_RESTARTS) {
          status = 'failed';
          break;
        }
        this.solver = this.makeSolver(`${this.cfg.seed}#${this.restarts}`);
        // A solver that is *already* failed after a fresh init failed its initial purge — the
        // config is structurally unsatisfiable (e.g. a non-tileable sample on a torus), and no
        // amount of reseeding will help. Surface the failure instead of spinning forever.
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

  // ---- export -------------------------------------------------------------

  exportPng(): void {
    if (!this.canvas) return;
    const url = this.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    const tag = this.cfg.model === 'tiled' ? this.cfg.tilesetKey : `overlap-${this.cfg.sampleKey}`;
    a.download = `tessera-${tag}-${this.cfg.seed}.png`;
    a.click();
  }

  get tileset(): CompiledTileset {
    return this.compiled;
  }
}

/** A cheap, order-sensitive 32-bit hash of a sample grid, used to key the compile cache. */
function hashGrid(grid: Int32Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < grid.length; i++) {
    h ^= grid[i] + 0x9e3779b9 + (i & 0xff);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
