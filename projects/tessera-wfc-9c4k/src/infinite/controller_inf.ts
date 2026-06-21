// The "Boundless" studio's engine host. It owns the compiled tileset and the InfiniteWorld, a
// floating-point viewport (centre in cell units + zoom in pixels-per-cell), and paints the visible
// slice of the endless plane into a canvas — materialising chunks lazily as they scroll into view.
// Panning is a pure camera move (the world never changes); an optional auto-pan drifts the camera so
// the world reveals itself hands-free. Strictly additive: it never touches the 2D/3D controllers.

import { compile } from '../wfc/tiles';
import { tilesetByKey } from '../wfc/tilesets/index';
import type { CompiledTileset } from '../wfc/types';
import { InfiniteWorld } from './world';

export type ControllerInfConfig = {
  tilesetKey: string;
  seed: string;
  chunkSize: number;
  /** Pixels per cell (zoom). */
  cellPx: number;
  /** Viewport centre, in world cell units (fractional). */
  centerX: number;
  centerY: number;
  /** Draw the chunk-boundary (junction) lattice. */
  showGrid: boolean;
  /** Mark the lattice junction cells. */
  showJunctions: boolean;
  /** Drift the camera automatically. */
  autoPan: boolean;
};

export type StatsInf = {
  tilesetName: string;
  nTiles: number;
  chunkSize: number;
  cellPx: number;
  centerX: number;
  centerY: number;
  cellsVisible: number;
  chunks: number;
  seams: number;
  junctions: number;
  chunkSolves: number;
  seamSolves: number;
  fallbacks: number;
  hover: { x: number; y: number } | null;
  running: boolean;
  ground: number;
};

const BACKW = 1000;
const BACKH = 680;
export const MIN_PX = 4;
export const MAX_PX = 80;

export class ControllerInf {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private cfg: ControllerInfConfig;
  private compiledCache = new Map<string, CompiledTileset>();
  compiled: CompiledTileset;
  private world: InfiniteWorld;
  private onStats: (s: StatsInf) => void = () => {};
  private hover: { x: number; y: number } | null = null;
  private raf = 0;
  private running = false;
  private lastTick = 0;
  private panVel = { x: 0.0, y: 0.0 }; // cells / second, for auto-pan

  constructor(cfg: ControllerInfConfig) {
    this.cfg = cfg;
    this.compiled = this.buildSet();
    this.world = this.makeWorld();
    this.resetAutoPanVel();
  }

  private buildSet(): CompiledTileset {
    const key = this.cfg.tilesetKey;
    let c = this.compiledCache.get(key);
    if (!c) {
      c = compile(tilesetByKey(key));
      this.compiledCache.set(key, c);
    }
    return c;
  }

  private makeWorld(): InfiniteWorld {
    return new InfiniteWorld({
      set: this.compiled,
      seed: this.cfg.seed,
      chunkSize: this.cfg.chunkSize,
    });
  }

  /** A gentle, seed-derived drift direction so auto-pan isn't always the same way. */
  private resetAutoPanVel(): void {
    let h = 2166136261;
    for (let i = 0; i < this.cfg.seed.length; i++) h = Math.imul(h ^ this.cfg.seed.charCodeAt(i), 16777619);
    const ang = ((h >>> 0) / 4294967296) * Math.PI * 2;
    const speed = 3.2; // cells per second
    this.panVel = { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed };
  }

  // ---- lifecycle -----------------------------------------------------------

  attach(canvas: HTMLCanvasElement, onStats: (s: StatsInf) => void): void {
    this.canvas = canvas;
    canvas.width = BACKW;
    canvas.height = BACKH;
    this.ctx = canvas.getContext('2d');
    this.onStats = onStats;
    if (this.cfg.autoPan) this.play();
    this.draw();
    this.emit();
  }

  detach(): void {
    this.pause();
    this.canvas = null;
    this.ctx = null;
  }

  get backing(): { w: number; h: number } {
    return { w: BACKW, h: BACKH };
  }

  // ---- camera math ---------------------------------------------------------

  /** Backing-store pixel → world cell coordinate (continuous). */
  pixelToCell(px: number, py: number): { x: number; y: number } {
    const x = (px - BACKW / 2) / this.cfg.cellPx + this.cfg.centerX;
    const y = (py - BACKH / 2) / this.cfg.cellPx + this.cfg.centerY;
    return { x, y };
  }

  /** Visible inclusive global-cell bounds, with a one-cell margin. */
  private visibleBounds(): { x0: number; y0: number; x1: number; y1: number } {
    const halfW = BACKW / 2 / this.cfg.cellPx;
    const halfH = BACKH / 2 / this.cfg.cellPx;
    return {
      x0: Math.floor(this.cfg.centerX - halfW) - 1,
      y0: Math.floor(this.cfg.centerY - halfH) - 1,
      x1: Math.ceil(this.cfg.centerX + halfW) + 1,
      y1: Math.ceil(this.cfg.centerY + halfH) + 1,
    };
  }

  // ---- interaction ---------------------------------------------------------

  /** Pan by a backing-store pixel delta (drag). */
  panByPixels(dxPix: number, dyPix: number): void {
    this.cfg.centerX -= dxPix / this.cfg.cellPx;
    this.cfg.centerY -= dyPix / this.cfg.cellPx;
    this.draw();
    this.emit();
  }

  /** Zoom around a backing-store anchor point, keeping the world cell under it fixed. */
  zoomAt(px: number, py: number, factor: number): void {
    const before = this.pixelToCell(px, py);
    const next = Math.max(MIN_PX, Math.min(MAX_PX, this.cfg.cellPx * factor));
    this.cfg.cellPx = next;
    const after = this.pixelToCell(px, py);
    this.cfg.centerX += before.x - after.x;
    this.cfg.centerY += before.y - after.y;
    this.draw();
    this.emit();
  }

  setHover(px: number | null, py?: number): void {
    if (px == null || py == null) this.hover = null;
    else {
      const c = this.pixelToCell(px, py);
      this.hover = { x: Math.floor(c.x), y: Math.floor(c.y) };
    }
    this.draw();
    this.emit();
  }

  jumpTo(x: number, y: number): void {
    this.cfg.centerX = x;
    this.cfg.centerY = y;
    this.draw();
    this.emit();
  }

  recenter(): void {
    this.jumpTo(0, 0);
  }

  // ---- config --------------------------------------------------------------

  get config(): ControllerInfConfig {
    return { ...this.cfg };
  }

  update(patch: Partial<ControllerInfConfig>, rebuild: boolean): void {
    const prevKey = this.cfg.tilesetKey;
    const prevSeed = this.cfg.seed;
    const prevChunk = this.cfg.chunkSize;
    this.cfg = { ...this.cfg, ...patch };
    if (this.cfg.tilesetKey !== prevKey) this.compiled = this.buildSet();
    const worldChanged =
      rebuild ||
      this.cfg.tilesetKey !== prevKey ||
      this.cfg.seed !== prevSeed ||
      this.cfg.chunkSize !== prevChunk;
    if (worldChanged) {
      this.world = this.makeWorld();
      this.resetAutoPanVel();
    }
    if (patch.autoPan !== undefined) {
      if (patch.autoPan) this.play();
      else this.pause();
    }
    this.draw();
    this.emit();
  }

  reseed(seed: string): void {
    this.update({ seed }, true);
  }

  // ---- auto-pan loop --------------------------------------------------------

  play(): void {
    if (this.running) return;
    this.running = true;
    this.cfg.autoPan = true;
    this.lastTick = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause(): void {
    this.running = false;
    this.cfg.autoPan = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.emit();
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.play();
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    this.cfg.centerX += this.panVel.x * dt;
    this.cfg.centerY += this.panVel.y * dt;
    this.draw();
    this.emit();
    this.raf = requestAnimationFrame(this.tick);
  };

  // ---- draw ----------------------------------------------------------------

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { cellPx, centerX, centerY } = this.cfg;
    const G = this.cfg.chunkSize;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = this.compiled.background;
    ctx.fillRect(0, 0, BACKW, BACKH);

    const b = this.visibleBounds();
    const sx = (gx: number) => (gx - centerX) * cellPx + BACKW / 2;
    const sy = (gy: number) => (gy - centerY) * cellPx + BACKH / 2;

    // tiles
    const size = Math.ceil(cellPx) + 1; // overdraw 1px to avoid seams from rounding
    for (let gy = b.y0; gy <= b.y1; gy++) {
      const dy = Math.round(sy(gy));
      for (let gx = b.x0; gx <= b.x1; gx++) {
        const t = this.world.tileAt(gx, gy);
        const v = this.compiled.variants[t];
        if (v) ctx.drawImage(v.bitmap, Math.round(sx(gx)), dy, size, size);
      }
    }

    // chunk-boundary lattice (junction lines sit at gx,gy ≡ 0 mod G)
    if (this.cfg.showGrid && cellPx >= 5) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.beginPath();
      const gx0 = Math.ceil(b.x0 / G) * G;
      for (let gx = gx0; gx <= b.x1; gx += G) {
        const x = Math.round(sx(gx)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, BACKH);
      }
      const gy0 = Math.ceil(b.y0 / G) * G;
      for (let gy = gy0; gy <= b.y1; gy += G) {
        const y = Math.round(sy(gy)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(BACKW, y);
      }
      ctx.stroke();
    }

    // junction markers
    if (this.cfg.showJunctions && cellPx >= 6) {
      ctx.fillStyle = 'rgba(251,191,36,0.85)';
      const gx0 = Math.ceil(b.x0 / G) * G;
      const gy0 = Math.ceil(b.y0 / G) * G;
      const r = Math.max(1.5, cellPx * 0.12);
      for (let gy = gy0; gy <= b.y1; gy += G) {
        for (let gx = gx0; gx <= b.x1; gx += G) {
          ctx.beginPath();
          ctx.arc(sx(gx) + cellPx / 2, sy(gy) + cellPx / 2, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // hover outline + crosshair
    if (this.hover && cellPx >= 5) {
      const x = sx(this.hover.x);
      const y = sy(this.hover.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, cellPx - 2, cellPx - 2);
    }

    // origin marker (0,0) so you can find your way home
    {
      const ox = sx(0) + cellPx / 2;
      const oy = sy(0) + cellPx / 2;
      if (ox > -20 && ox < BACKW + 20 && oy > -20 && oy < BACKH + 20) {
        ctx.strokeStyle = 'rgba(56,189,248,0.95)';
        ctx.lineWidth = 2;
        const s = Math.max(6, cellPx * 0.5);
        ctx.beginPath();
        ctx.moveTo(ox - s, oy);
        ctx.lineTo(ox + s, oy);
        ctx.moveTo(ox, oy - s);
        ctx.lineTo(ox, oy + s);
        ctx.stroke();
      }
    }

    this.drawMinimap(ctx);
  }

  /** A tiny overview in the corner: materialised chunks + the viewport rectangle. */
  private drawMinimap(ctx: CanvasRenderingContext2D): void {
    const G = this.cfg.chunkSize;
    const mmW = 150;
    const mmH = 110;
    const pad = 12;
    const x0 = BACKW - mmW - pad;
    const y0 = BACKH - mmH - pad;
    ctx.fillStyle = 'rgba(7,10,18,0.78)';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.fillRect(x0, y0, mmW, mmH);
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, mmW, mmH);
    // map a chunk-coordinate window centred on the camera's chunk
    const ccx = Math.floor(this.cfg.centerX / G);
    const ccy = Math.floor(this.cfg.centerY / G);
    const span = 9; // chunks across the minimap (odd, so a centre cell exists)
    const half = Math.floor(span / 2);
    const cw = mmW / span;
    const ch = mmH / span;
    ctx.fillStyle = 'rgba(56,189,248,0.55)';
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const cx = ccx + dx;
        const cy = ccy + dy;
        if (this.world.isChunkCached(cx, cy)) {
          const mx = x0 + (dx + half) * cw;
          const my = y0 + (dy + half) * ch;
          ctx.fillRect(mx + 0.5, my + 0.5, cw - 1, ch - 1);
        }
      }
    }
    // viewport marker (the centre chunk)
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    const vx = x0 + half * cw;
    const vy = y0 + half * ch;
    ctx.strokeRect(vx + 0.5, vy + 0.5, cw - 1, ch - 1);
  }

  private emit(): void {
    const b = this.visibleBounds();
    const cellsVisible = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
    const m = this.world.materialized;
    this.onStats({
      tilesetName: this.compiled.name,
      nTiles: this.compiled.variants.length,
      chunkSize: this.cfg.chunkSize,
      cellPx: Math.round(this.cfg.cellPx),
      centerX: this.cfg.centerX,
      centerY: this.cfg.centerY,
      cellsVisible,
      chunks: m.chunks,
      seams: m.vseams + m.hseams,
      junctions: m.junctions,
      chunkSolves: this.world.chunkSolves,
      seamSolves: this.world.seamSolves,
      fallbacks: this.world.fallbacks,
      hover: this.hover,
      running: this.running,
      ground: this.world.ground,
    });
  }

  // ---- export --------------------------------------------------------------

  exportPng(): void {
    if (!this.canvas) return;
    try {
      const url = this.canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `tessera-boundless-${this.cfg.tilesetKey}-${this.cfg.seed}.png`;
      a.click();
    } catch {
      /* sandboxed previews may block toDataURL — ignore */
    }
  }

  // ---- read-out for the gallery / hover ------------------------------------

  get tileset(): CompiledTileset {
    return this.compiled;
  }

  tileAt(gx: number, gy: number): number {
    return this.world.tileAt(gx, gy);
  }
}
