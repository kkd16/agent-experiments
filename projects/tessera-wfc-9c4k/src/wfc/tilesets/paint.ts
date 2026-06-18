// Shared canvas helpers for drawing tile prototypes at the base (0°) orientation.

export type Side = 'N' | 'E' | 'S' | 'W';

/** Midpoint of an edge for a `size`×`size` tile. */
export function edgeMid(side: Side, size: number): [number, number] {
  const h = size / 2;
  switch (side) {
    case 'N':
      return [h, 0];
    case 'E':
      return [size, h];
    case 'S':
      return [h, size];
    case 'W':
      return [0, h];
  }
}

/**
 * Draw rounded "spokes" from the tile centre out to each connected edge, plus a centre hub.
 * Used by the wiring-style tilesets (knots, circuit, cables).
 */
export function spokes(
  ctx: CanvasRenderingContext2D,
  size: number,
  sides: Side[],
  opts: { color: string; width: number; hub?: number; glow?: string },
): void {
  const c = size / 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (opts.glow) {
    ctx.strokeStyle = opts.glow;
    ctx.lineWidth = opts.width + 6;
    strokePaths(ctx, c, size, sides);
  }
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = opts.width;
  strokePaths(ctx, c, size, sides);
  if (opts.hub) {
    ctx.fillStyle = opts.color;
    ctx.beginPath();
    ctx.arc(c, c, opts.hub, 0, Math.PI * 2);
    ctx.fill();
  }
}

function strokePaths(ctx: CanvasRenderingContext2D, c: number, size: number, sides: Side[]): void {
  // A straight pass-through (exactly N+S or E+W) is drawn as one clean line.
  const set = new Set(sides);
  if (sides.length === 2 && set.has('N') && set.has('S')) {
    line(ctx, c, 0, c, size);
    return;
  }
  if (sides.length === 2 && set.has('E') && set.has('W')) {
    line(ctx, 0, c, size, c);
    return;
  }
  for (const s of sides) {
    const [x, y] = edgeMid(s, size);
    line(ctx, c, c, x, y);
  }
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** A subtle dot in the tile centre — used to make empty tiles read as deliberate. */
export function centerDot(ctx: CanvasRenderingContext2D, size: number, color: string, r = 2): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
  ctx.fill();
}
