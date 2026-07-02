// The mesh studio's engine host — the irregular-grid analogue of ../hex/controller_hex.ts. It owns
// the generated mesh (cached by its geometry parameters), the compiled tileset (+ live weight
// overrides), the solver, and a requestAnimationFrame loop that advances the solve and repaints the
// board through the from-scratch mesh renderer. View toggles redraw without rebuilding; a
// point-in-polygon hit-test powers the viewport's hover lens.

import { buildMesh, type Mesh } from './mesh';
import { compileMesh, withWeightsMesh } from './compile_mesh';
import { meshTilesetByKey } from './tilesets/index';
import { MeshSolver, type MeshSolverStatus } from './meshsolver';
import { cellAtPoint, layoutMesh, renderMesh, type MeshLayout } from './render_mesh';
import type { CompiledMeshTileset } from './meshtypes';

export type ControllerMeshConfig = {
  tilesetKey: string;
  cols: number;
  rows: number;
  seed: string;
  jitter: number; // 0..100 (percent of cell spacing)
  relax: number; // relaxation iterations
  merge: boolean; // merge triangle pairs into quads (irregularity)
  backtracking: boolean;
  speed: number;
  showGhost: boolean;
  showEntropy: boolean;
  showGrid: boolean;
};

export type StatsMesh = {
  status: MeshSolverStatus;
  collapsed: number;
  total: number;
  percent: number;
  contradictions: number;
  backtracks: number;
  restarts: number;
  steps: number;
  stepsPerSec: number;
  nTiles: number;
  cells: number;
  running: boolean;
};

export const MBACKW = 980;
export const MBACKH = 720;
const MAX_RESTARTS = 200;

export class ControllerMesh {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private cfg: ControllerMeshConfig;
  private meshCache = new Map<string, Mesh>();
  private setCache = new Map<string, CompiledMeshTileset>();
  private mesh: Mesh;
  private base: CompiledMeshTileset;
  compiled: CompiledMeshTileset;
  private solver: MeshSolver;
  private running = false;
  private raf = 0;
  private elapsedMs = 0;
  private lastTick = 0;
  private restarts = 0;
  private layout: MeshLayout | null = null;
  private onStats: (s: StatsMesh) => void = () => {};
  private weightOverrides = new Map<string, Map<number, number>>();

  constructor(cfg: ControllerMeshConfig) {
    this.cfg = cfg;
    this.mesh = this.buildMeshFor();
    this.base = this.buildBase();
    this.compiled = this.applyOverrides();
    this.solver = this.makeSolver();
  }

  private meshKey(): string {
    const c = this.cfg;
    return `${c.cols}x${c.rows}|${c.seed}|j${c.jitter}|r${c.relax}|m${c.merge ? 1 : 0}`;
  }

  private buildMeshFor(): Mesh {
    const key = this.meshKey();
    let m = this.meshCache.get(key);
    if (!m) {
      m = buildMesh({
        cols: this.cfg.cols,
        rows: this.cfg.rows,
        seed: this.cfg.seed,
        jitter: this.cfg.jitter / 100,
        relax: this.cfg.relax,
        merge: this.cfg.merge,
      });
      if (this.meshCache.size > 12) this.meshCache.clear();
      this.meshCache.set(key, m);
    }
    return m;
  }

  private buildBase(): CompiledMeshTileset {
    const key = this.cfg.tilesetKey;
    let c = this.setCache.get(key);
    if (!c) {
      c = compileMesh(meshTilesetByKey(key));
      this.setCache.set(key, c);
    }
    return c;
  }

  private applyOverrides(): CompiledMeshTileset {
    const ov = this.weightOverrides.get(this.cfg.tilesetKey);
    return ov ? withWeightsMesh(this.base, ov) : this.base;
  }

  private makeSolver(seedOverride?: string): MeshSolver {
    return new MeshSolver(this.mesh, this.compiled, {
      seed: seedOverride ?? this.cfg.seed,
      backtracking: this.cfg.backtracking,
      backtrackBudget: 12000,
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  attach(canvas: HTMLCanvasElement, onStats: (s: StatsMesh) => void): void {
    this.canvas = canvas;
    canvas.width = MBACKW;
    canvas.height = MBACKH;
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
    const g = ctx.createLinearGradient(0, 0, 0, MBACKH);
    g.addColorStop(0, '#0c1018');
    g.addColorStop(1, '#070a10');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, MBACKW, MBACKH);
  }

  private draw(): void {
    if (!this.ctx) return;
    this.paintBackground();
    this.layout = renderMesh(this.ctx, this.compiled, this.solver, this.mesh, MBACKW, MBACKH, {
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
      cells: this.mesh.cells.length,
      running: this.running,
    });
  }

  // ---- hover lens ----------------------------------------------------------

  cellAtBackingPx(px: number, py: number): number {
    const lay = this.layout ?? layoutMesh(this.mesh, MBACKW, MBACKH, 20);
    return cellAtPoint(this.mesh, lay, px, py);
  }

  lensInfo(cell: number): { count: number; total: number } {
    return { count: this.solver.possibilities(cell), total: this.compiled.variants.length };
  }

  get backingSize(): { w: number; h: number } {
    return { w: MBACKW, h: MBACKH };
  }

  // ---- config --------------------------------------------------------------

  update(patch: Partial<ControllerMeshConfig>, rebuild: boolean): void {
    const prevMeshKey = this.meshKey();
    const prevSetKey = this.cfg.tilesetKey;
    this.cfg = { ...this.cfg, ...patch };
    const meshChanged = this.meshKey() !== prevMeshKey;
    const setChanged = this.cfg.tilesetKey !== prevSetKey;
    if (meshChanged) this.mesh = this.buildMeshFor();
    if (setChanged) {
      this.base = this.buildBase();
      this.compiled = this.applyOverrides();
    }
    if (rebuild || setChanged || meshChanged) {
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

  private advance(n: number): MeshSolverStatus {
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
      a.download = `tessera-mesh-${this.cfg.tilesetKey}-${this.cfg.seed}.png`;
      a.click();
    } catch {
      /* sandboxed thumbnails may block toDataURL — ignore */
    }
  }

  // ---- weights -------------------------------------------------------------

  get tileset(): CompiledMeshTileset {
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
