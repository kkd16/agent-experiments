import { useEffect, useRef } from 'react';

interface Props {
  lossHistory: number[];
  probeHistory: number[];
  knnHistory: number[];
  pixelProbeAcc: number;
  width: number;
  height: number;
}

function finite(arr: number[]): number[] {
  return arr.filter((v) => Number.isFinite(v));
}

// Two stacked panels: the NT-Xent training loss (top), and the downstream evaluation accuracies
// (bottom) — the linear probe and the kNN vote on the frozen representation, against the dashed
// raw-pixel baseline. The gap between the rising curves and that flat baseline is exactly how much
// structure the unsupervised objective recovered.
export default function MetricsChart({ lossHistory, probeHistory, knnHistory, pixelProbeAcc, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = width;
    const H = height;
    const gap = 10;
    const topH = Math.round((H - gap) * 0.42);
    const botH = H - gap - topH;
    ctx.clearRect(0, 0, W, H);

    const panel = (y0: number, h: number) => {
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(0, y0, W, h);
      ctx.strokeStyle = 'rgba(148,163,184,0.10)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = y0 + (i / 4) * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
    };

    const line = (data: number[], y0: number, h: number, max: number, color: string, dashed: boolean) => {
      if (finite(data).length < 2) return;
      const pad = 4;
      ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) continue;
        const x = pad + (i / (data.length - 1)) * (W - 2 * pad);
        const y = y0 + pad + (1 - Math.min(1, data[i] / max)) * (h - 2 * pad);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    };

    const hline = (yv: number, y0: number, h: number, color: string) => {
      const pad = 4;
      const y = y0 + pad + (1 - Math.min(1, yv)) * (h - 2 * pad);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // top: loss
    panel(0, topH);
    const lossMax = Math.max(...finite(lossHistory), 1e-6);
    line(lossHistory, 0, topH, lossMax, '#a78bfa', false);

    // bottom: accuracies (fixed 0..1 axis)
    panel(topH + gap, botH);
    if (Number.isFinite(pixelProbeAcc)) hline(pixelProbeAcc, topH + gap, botH, 'rgba(148,163,184,0.6)');
    line(probeHistory.map((v) => v), topH + gap, botH, 1, '#34d399', false);
    line(knnHistory.map((v) => v), topH + gap, botH, 1, '#fbbf24', false);
  }, [lossHistory, probeHistory, knnHistory, pixelProbeAcc, width, height]);

  const last = (arr: number[]) => {
    const f = finite(arr);
    return f.length ? f[f.length - 1] : NaN;
  };
  const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—');
  const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={ref} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#a78bfa' }} /> NT-Xent <b>{f3(last(lossHistory))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#34d399' }} /> probe <b>{pct(last(probeHistory))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#fbbf24' }} /> kNN <b>{pct(last(knnHistory))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: 'rgba(148,163,184,0.8)' }} /> pixels <b>{pct(pixelProbeAcc)}</b>
        </span>
      </div>
    </div>
  );
}
