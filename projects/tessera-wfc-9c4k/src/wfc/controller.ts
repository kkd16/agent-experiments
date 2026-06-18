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
  pins: number;
  recording: boolean;
};

/** A live read-out of one cell's state, for the hover inspector ("Lens"). */
export type CellInfo = {
  cell: number;
  col: number;
  row: number;
  count: number; // surviving possibilities
  entropy: number; // normalised 0..1
  collapsed: number; // collapsed tile id, or -1
  pinned: boolean;
  tiles: number[]; // possible tile ids (capped)
};

const TARGET_PX = 760; // rendered backing-store size (CSS scales it to fit)
const MAX_RESTARTS = 240; // bound auto-restarts so an unsatisfiable config can't spin forever

export class Controller {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private cfg: ControllerConfig;
  private compiledCache = new Map<string, CompiledTileset>();
  private base: CompiledTileset; // adjacency-bearing set (cached, shared)
  private compiled: CompiledTileset; // effective set the solver+gallery use (weights applied)
  private solver: Solver;
  private running = false;
  private raf = 0;
  private cellPx = 16;
  private restarts = 0;
  private elapsedMs = 0;
  private lastTick = 0;
  private onStats: (s: Stats) => void = () => {};

  // --- interaction state ---
  private pins = new Map<number, number>(); // cell -> tile, persisted across reseeds
  private hover = -1; // hovered cell, or -1
  private brush: number | null = null; // selected tile id to paint with, or null
  private erase = false; // erase (un-pin) mode
  private weightOverrides = new Map<string, number[]>(); // compileKey -> per-variant weights

  // --- recording state ---
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recording = false;

  constructor(cfg: ControllerConfig) {
    this.cfg = cfg;
    this.base = this.buildBase();
    this.compiled = this.applyOverrides(this.base);
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

  private buildBase(): CompiledTileset {
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

  /**
   * Re-bias a compiled set with any per-variant weight overrides for the current compile key.
   * Adjacency (`allowed`) is untouched and shared — only the weight vectors that drive entropy
   * and tile selection change, so this is cheap and needs no recompile of the rule tensor.
   */
  private applyOverrides(base: CompiledTileset): CompiledTileset {
    const ov = this.weightOverrides.get(this.compileKey());
    if (!ov) return base;
    const weights = base.variants.map((_, i) => (ov[i] != null && ov[i] > 0 ? ov[i] : base.weights[i]));
    const weightLogWeights = weights.map((w) => w * Math.log(w));
    const variants = base.variants.map((v, i) => ({ ...v, weight: weights[i] }));
    return { ...base, variants, weights, weightLogWeights };
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
      pins: [...this.pins.entries()],
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
      hover: this.hover,
      pins: this.pins,
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
      pins: this.pins.size,
      recording: this.recording,
    });
  }

  // ---- config -------------------------------------------------------------

  /** Apply config. `rebuild` recreates the solver (size/seed/tileset/edges changed). */
  update(patch: Partial<ControllerConfig>, rebuild: boolean): void {
    const prevKey = this.compileKey();
    const prevSize = this.cfg.size;
    this.cfg = { ...this.cfg, ...patch };
    const setChanged = this.compileKey() !== prevKey;
    if (setChanged) {
      // Tile ids are defined per set — pins (and any brush/override) no longer apply.
      this.base = this.buildBase();
      this.compiled = this.applyOverrides(this.base);
      this.pins.clear();
      this.brush = null;
      this.hover = -1;
    } else if (this.cfg.size !== prevSize) {
      // Cell indices are defined per grid size — pins addressed by index no longer apply.
      this.pins.clear();
      this.hover = -1;
    }
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
    a.download = `tessera-${this.exportTag()}-${this.cfg.seed}.png`;
    a.click();
  }

  // ---- interaction: lens + constraint painting ----------------------------

  get gridSize(): number {
    return this.cfg.size;
  }

  get activeBrush(): number | null {
    return this.brush;
  }

  get eraseMode(): boolean {
    return this.erase;
  }

  get pinCount(): number {
    return this.pins.size;
  }

  /** Map fractional canvas coords (0..1 across the board) to a cell index, or -1 if outside. */
  cellAtFraction(fx: number, fy: number): number {
    const n = this.cfg.size;
    const col = Math.floor(fx * n);
    const row = Math.floor(fy * n);
    if (col < 0 || row < 0 || col >= n || row >= n) return -1;
    return row * n + col;
  }

  setBrush(tile: number | null): void {
    this.brush = tile;
    if (tile != null) this.erase = false;
    this.emit();
  }

  setErase(on: boolean): void {
    this.erase = on;
    if (on) this.brush = null;
    this.emit();
  }

  setHover(cell: number): void {
    if (cell === this.hover) return;
    this.hover = cell;
    this.draw();
  }

  clearHover(): void {
    if (this.hover === -1) return;
    this.hover = -1;
    this.draw();
  }

  /** A live read-out of a cell's wavefunction state, for the inspector popover. */
  inspect(cell: number): CellInfo | null {
    if (cell < 0 || cell >= this.solver.total) return null;
    const n = this.cfg.size;
    return {
      cell,
      col: cell % n,
      row: Math.floor(cell / n),
      count: this.solver.possibilities(cell),
      entropy: this.solver.normEntropy(cell),
      collapsed: this.solver.collapsedTile(cell),
      pinned: this.pins.has(cell),
      tiles: this.solver.possibleTiles(cell),
    };
  }

  /**
   * Apply the active tool to a cell: in erase mode remove any pin there; otherwise pin the
   * brush tile. Either way the pin set changed, so the solver is rebuilt from scratch (a pin
   * can be propagated forward but not un-propagated, so a full deterministic rebuild keeps
   * the two operations symmetric and correct). Returns false if the action was a no-op.
   */
  paint(cell: number): boolean {
    if (cell < 0 || cell >= this.cfg.size * this.cfg.size) return false;
    let changed = false;
    if (this.erase) {
      changed = this.pins.delete(cell);
    } else if (this.brush != null && this.brush < this.compiled.variants.length) {
      if (this.pins.get(cell) !== this.brush) {
        this.pins.set(cell, this.brush);
        changed = true;
      }
    }
    if (!changed) return false;
    this.pause();
    this.restarts = 0;
    this.elapsedMs = 0;
    this.solver = this.makeSolver();
    this.draw();
    this.emit();
    return true;
  }

  clearPins(): void {
    if (this.pins.size === 0) return;
    this.pins.clear();
    this.pause();
    this.restarts = 0;
    this.elapsedMs = 0;
    this.solver = this.makeSolver();
    this.draw();
    this.emit();
  }

  // ---- interaction: tile weights ------------------------------------------

  /** The default (compiled) weight of a variant, before any override. */
  defaultWeight(id: number): number {
    return this.base.weights[id] ?? 1;
  }

  /** The currently effective weight of a variant (override if set, else default). */
  effectiveWeight(id: number): number {
    return this.compiled.weights[id] ?? 1;
  }

  hasWeightOverrides(): boolean {
    return this.weightOverrides.has(this.compileKey());
  }

  setWeight(id: number, weight: number): void {
    if (id < 0 || id >= this.base.variants.length) return;
    const key = this.compileKey();
    let ov = this.weightOverrides.get(key);
    if (!ov) {
      ov = this.base.weights.slice();
      this.weightOverrides.set(key, ov);
    }
    ov[id] = Math.max(0.01, weight);
    this.compiled = this.applyOverrides(this.base);
    this.pause();
    this.elapsedMs = 0;
    this.restarts = 0;
    this.solver = this.makeSolver();
    this.draw();
    this.emit();
  }

  resetWeights(): void {
    if (!this.weightOverrides.delete(this.compileKey())) return;
    this.compiled = this.base;
    this.pause();
    this.elapsedMs = 0;
    this.restarts = 0;
    this.solver = this.makeSolver();
    this.draw();
    this.emit();
  }

  // ---- recording: capture the collapse as WebM ----------------------------

  canRecord(): boolean {
    return (
      typeof MediaRecorder !== 'undefined' &&
      !!this.canvas &&
      typeof this.canvas.captureStream === 'function'
    );
  }

  get isRecording(): boolean {
    return this.recording;
  }

  startRecording(): boolean {
    if (!this.canvas || this.recording || !this.canRecord()) return false;
    try {
      const stream = this.canvas.captureStream(30);
      const mime = pickRecordingMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      this.chunks = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };
      rec.onstop = () => this.saveRecording(rec.mimeType || 'video/webm');
      rec.start();
      this.recorder = rec;
      this.recording = true;
      this.emit();
      return true;
    } catch {
      this.recorder = null;
      this.recording = false;
      return false;
    }
  }

  stopRecording(): void {
    if (this.recorder && this.recording) {
      try {
        this.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    this.recording = false;
    this.emit();
  }

  toggleRecording(): void {
    if (this.recording) this.stopRecording();
    else this.startRecording();
  }

  private saveRecording(mime: string): void {
    try {
      const blob = new Blob(this.chunks, { type: mime });
      this.chunks = [];
      this.recorder = null;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tessera-${this.exportTag()}-${this.cfg.seed}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      /* ignore */
    }
  }

  // ---- export -------------------------------------------------------------

  private exportTag(): string {
    return this.cfg.model === 'tiled' ? this.cfg.tilesetKey : `overlap-${this.cfg.sampleKey}`;
  }

  /**
   * Download the run as JSON: the config, the compiled tiles (id/proto/rotation/weight/edges),
   * the adjacency rule tensor, the hand-placed pins, and the current per-cell tiling. This is
   * the learnt constraint set made portable — inspectable, diffable, and replayable.
   */
  exportJson(): void {
    const n = this.cfg.size;
    const tiling: number[] = new Array(n * n);
    for (let c = 0; c < n * n; c++) tiling[c] = this.solver.collapsedTile(c);
    const set = this.compiled;
    const payload = {
      generator: 'tessera',
      version: 2,
      model: this.cfg.model,
      config: {
        model: this.cfg.model,
        tilesetKey: this.cfg.tilesetKey,
        sampleKey: this.cfg.sampleKey,
        patternN: this.cfg.patternN,
        symmetry: this.cfg.symmetry,
        periodicInput: this.cfg.periodicInput,
        size: this.cfg.size,
        seed: this.cfg.seed,
        wrap: this.cfg.wrap,
        backtracking: this.cfg.backtracking,
      },
      grid: { width: n, height: n },
      tiles: set.variants.map((v) => ({
        id: v.id,
        proto: v.proto,
        rotation: v.rotation,
        weight: Number(set.weights[v.id].toFixed(4)),
        edges: v.edges,
      })),
      adjacency: {
        N: set.allowed[0],
        E: set.allowed[1],
        S: set.allowed[2],
        W: set.allowed[3],
      },
      pins: [...this.pins.entries()].map(([cell, tile]) => ({ cell, tile })),
      tiling,
    };
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tessera-${this.exportTag()}-${this.cfg.seed}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      /* ignore */
    }
  }

  get tileset(): CompiledTileset {
    return this.compiled;
  }
}

/** Pick the best-supported WebM codec for `MediaRecorder`, or '' to use the default. */
function pickRecordingMime(): string {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
  return '';
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
