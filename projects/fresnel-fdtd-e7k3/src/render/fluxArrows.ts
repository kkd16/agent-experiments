/**
 * Draws the time-averaged Poynting energy-flux field ⟨S⟩ as a sparse field of
 * arrows over the WebGL magnitude map. Energy flows along S, so the arrows show
 * *where the light is actually going* — into a lens focus, around a scatterer,
 * or circulating in a cavity. Rendered on a 2D overlay canvas so the GPU field
 * pass stays untouched.
 */

interface Flux {
  sx: Float32Array;
  sy: Float32Array;
  mag: Float32Array;
}

export function drawFluxArrows(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  nx: number,
  ny: number,
  flux: Flux,
): void {
  ctx.clearRect(0, 0, w, h);
  const { sx, sy, mag } = flux;

  // Peak magnitude for normalization (ignore the outermost cells / PML region).
  let peak = 1e-30;
  const pad = 6;
  for (let j = pad; j < ny - pad; j++) {
    const row = j * nx;
    for (let i = pad; i < nx - pad; i++) peak = Math.max(peak, mag[row + i]);
  }
  const invPeak = 1 / peak;

  // Arrow lattice: aim for ~26 arrows across, isotropic spacing.
  const cols = 26;
  const stepX = nx / cols;
  const stepY = stepX; // same cell spacing → isotropic in grid space
  const cellW = (w / nx) * stepX;
  const maxLen = Math.min(cellW, (h / ny) * stepY) * 0.95;

  ctx.lineWidth = Math.max(1, w / 900);
  ctx.lineCap = 'round';

  for (let gy = stepY * 0.5; gy < ny; gy += stepY) {
    for (let gx = stepX * 0.5; gx < nx; gx += stepX) {
      const i = Math.min(nx - 1, Math.round(gx));
      const j = Math.min(ny - 1, Math.round(gy));
      const k = i + j * nx;
      const m = mag[k];
      if (m <= 0) continue;
      const t = Math.sqrt(m * invPeak); // sqrt for visual dynamic range
      if (t < 0.06) continue;
      const dirx = sx[k] / m;
      const diry = sy[k] / m;
      const px = (gx / nx) * w;
      const py = (gy / ny) * h;
      const len = t * maxLen;
      const ex = px + dirx * len;
      const ey = py + diry * len;

      // warm→bright ramp with alpha by strength
      const alpha = 0.25 + 0.6 * t;
      ctx.strokeStyle = `rgba(255, ${Math.round(210 - 90 * t)}, ${Math.round(120 - 90 * t)}, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(ex, ey);
      // arrowhead
      const head = len * 0.34 + 1;
      const ang = Math.atan2(diry, dirx);
      const a1 = ang + 2.6;
      const a2 = ang - 2.6;
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + Math.cos(a1) * head, ey + Math.sin(a1) * head);
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex + Math.cos(a2) * head, ey + Math.sin(a2) * head);
      ctx.stroke();
    }
  }
}
