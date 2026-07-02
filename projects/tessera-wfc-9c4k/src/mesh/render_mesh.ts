// The mesh viewport renderer. Fit the irregular mesh into the backing store, then paint each cell:
// a collapsed cell draws its tile *live* into its real polygon (roads bent to fit the quad); a still
// superposed cell shows a ghost of its averaged tint or an entropy-heat fill; an optional hairline
// traces the cell outlines. No GPU, no library — just canvas paths.

import type { Mesh, Vec2 } from './mesh';
import type { MeshSolver } from './meshsolver';
import type { CellGeom, CompiledMeshTileset } from './meshtypes';
import { rgb, rgba } from './meshtypes';

export type MeshLayout = { scale: number; ox: number; oy: number };

export type MeshRenderOpts = {
  showGhost: boolean;
  showEntropy: boolean;
  showGrid: boolean;
};

/** A scale + offset that frames the whole mesh inside `W × H` with `pad` px of margin. */
export function layoutMesh(mesh: Mesh, W: number, H: number, pad: number): MeshLayout {
  const bw = Math.max(1e-6, mesh.bounds.maxX - mesh.bounds.minX);
  const bh = Math.max(1e-6, mesh.bounds.maxY - mesh.bounds.minY);
  const scale = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
  const ox = (W - scale * bw) / 2 - scale * mesh.bounds.minX;
  const oy = (H - scale * bh) / 2 - scale * mesh.bounds.minY;
  return { scale, ox, oy };
}

function tx(p: Vec2, lay: MeshLayout): Vec2 {
  return { x: lay.ox + p.x * lay.scale, y: lay.oy + p.y * lay.scale };
}

/** Transform one mesh cell into device-pixel geometry for a painter. */
export function cellGeom(mesh: Mesh, cell: number, lay: MeshLayout): CellGeom {
  const c = mesh.cells[cell];
  const poly = c.poly.map((p) => tx(p, lay));
  const mids = c.mids.map((p) => tx(p, lay));
  const centroid = tx(c.centroid, lay);
  return { poly, mids, centroid, inradius: c.inradius * lay.scale };
}

function heatColor(t: number): string {
  const v = Math.sqrt(Math.max(0, Math.min(1, t)));
  const r = Math.round(40 + v * 200);
  const g = Math.round(70 + (1 - Math.abs(v - 0.5) * 2) * 120);
  const b = Math.round(200 - v * 150);
  return `rgba(${r},${g},${b},0.85)`;
}

function fillPoly(ctx: CanvasRenderingContext2D, poly: Vec2[], color: string): void {
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

export function renderMesh(
  ctx: CanvasRenderingContext2D,
  set: CompiledMeshTileset,
  solver: MeshSolver,
  mesh: Mesh,
  W: number,
  H: number,
  opts: MeshRenderOpts,
): MeshLayout {
  const lay = layoutMesh(mesh, W, H, 20);
  for (let cell = 0; cell < mesh.cells.length; cell++) {
    const g = cellGeom(mesh, cell, lay);
    const t = solver.collapsedTile(cell);
    if (t >= 0) {
      try {
        set.variants[t].render(ctx, g, set.palette);
      } catch {
        fillPoly(ctx, g.poly, rgb(set.variants[t].tint));
      }
    } else if (opts.showEntropy) {
      fillPoly(ctx, g.poly, heatColor(solver.entropy01(cell)));
    } else if (opts.showGhost) {
      const [r, gg, b] = solver.ghostColor(cell);
      fillPoly(ctx, g.poly, rgba([r, gg, b], 0.5));
    }
    if (opts.showGrid) {
      ctx.beginPath();
      ctx.moveTo(g.poly[0].x, g.poly[0].y);
      for (let i = 1; i < g.poly.length; i++) ctx.lineTo(g.poly[i].x, g.poly[i].y);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  return lay;
}

/** Which cell (if any) contains the device-pixel point? A linear point-in-polygon scan. */
export function cellAtPoint(mesh: Mesh, lay: MeshLayout, px: number, py: number): number {
  for (let cell = 0; cell < mesh.cells.length; cell++) {
    const poly = mesh.cells[cell].poly;
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const xi = lay.ox + poly[i].x * lay.scale;
      const yi = lay.oy + poly[i].y * lay.scale;
      const xj = lay.ox + poly[j].x * lay.scale;
      const yj = lay.oy + poly[j].y * lay.scale;
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return cell;
  }
  return -1;
}
