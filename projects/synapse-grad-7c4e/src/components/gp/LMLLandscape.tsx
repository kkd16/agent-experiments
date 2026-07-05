import { useEffect, useRef } from 'react';

interface Props {
  tick: number;
  res: number;
  landscape: (res: number) =>
    | { values: Float64Array; ellAxis: Float64Array; snAxis: Float64Array; min: number; max: number; cur: [number, number]; traj: number[] }
    | null;
}

// The "learning the prior" money shot: the exact log-marginal-likelihood surface over
// (log-lengthscale, log-noise) as a filled heatmap, with the hyperparameter optimizer's
// trajectory drawn on top and the current point marked. σ_f is held at its current value.
export default function LMLLandscape({ tick, res, landscape }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const Wpx = canvas.width;
    const Hpx = canvas.height;
    ctx.clearRect(0, 0, Wpx, Hpx);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, Wpx, Hpx);

    const g = landscape(res);
    if (!g) {
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.font = '13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('add data points to see the likelihood surface', Wpx / 2, Hpx / 2);
      return;
    }
    const { values, ellAxis, snAxis, min, max, cur, traj } = g;
    // clamp the low tail so the interesting ridge isn't washed out
    const floor = max - Math.min(max - min, 30);
    const cellW = Wpx / res;
    const cellH = Hpx / res;
    for (let a = 0; a < res; a++) {
      for (let b = 0; b < res; b++) {
        const v = values[a * res + b];
        const t = Math.max(0, Math.min(1, (v - floor) / (max - floor + 1e-9)));
        ctx.fillStyle = viridis(t);
        // snAxis is the outer (rows, top→bottom = high→low noise); ellAxis inner (cols)
        ctx.fillRect(b * cellW, (res - 1 - a) * cellH, cellW + 1, cellH + 1);
      }
    }

    const e0 = ellAxis[0];
    const e1 = ellAxis[res - 1];
    const s0 = snAxis[0];
    const s1 = snAxis[res - 1];
    const px = (logEll: number) => ((logEll - e0) / (e1 - e0)) * Wpx;
    const py = (logSn: number) => (1 - (logSn - s0) / (s1 - s0)) * Hpx;

    // optimizer trajectory
    if (traj.length >= 4) {
      ctx.beginPath();
      for (let i = 0; i < traj.length; i += 2) {
        const x = px(traj[i]);
        const y = py(traj[i + 1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    // current point
    const cx = px(cur[0]);
    const cy = py(cur[1]);
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fbbf24';
    ctx.fill();
    ctx.strokeStyle = '#0b1220';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [tick, res, landscape]);

  return (
    <div className="gp-landscape">
      <canvas ref={ref} width={300} height={220} className="gp-landscape-canvas" />
      <div className="gp-axis-labels">
        <span className="gp-ax-x muted small">log lengthscale →</span>
        <span className="gp-ax-y muted small">← log noise</span>
      </div>
    </div>
  );
}

// A compact viridis-ish ramp (dark blue → teal → green → yellow).
function viridis(t: number): string {
  const stops: [number, [number, number, number]][] = [
    [0, [68, 1, 84]],
    [0.25, [59, 82, 139]],
    [0.5, [33, 145, 140]],
    [0.75, [94, 201, 98]],
    [1, [253, 231, 37]],
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const f = (t - a[0]) / (b[0] - a[0] + 1e-9);
  const c = (k: number) => Math.round(a[1][k] + (b[1][k] - a[1][k]) * f);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}
