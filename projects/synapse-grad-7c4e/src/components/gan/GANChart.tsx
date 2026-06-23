import { useEffect, useRef } from 'react';

interface Props {
  dLoss: number[];
  gLoss: number[];
  wDist: number[];
  objective: string;
  width: number;
  height: number;
}

// The adversarial training curves. For the BCE games the two losses chase each other and
// neither "going down" means much — a healthy game hovers, it doesn't converge to zero — so
// both are auto-scaled and drawn together to show the tug-of-war. For WGAN the critic loss is
// (minus) a real distance, so the **Wasserstein estimate** is overlaid in green and genuinely
// trends toward 0 as the samples improve: the one GAN curve you can actually read.
export default function GANChart({ dLoss, gLoss, wDist, objective, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const isWgan = objective === 'wgan';

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = width;
    const H = height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const pad = 4;
    ctx.strokeStyle = 'rgba(148,163,184,0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (i / 4) * (H - 2 * pad);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    const finite = (arr: number[]) => arr.filter((v) => Number.isFinite(v));
    const series: number[][] = isWgan ? [dLoss, gLoss, wDist] : [dLoss, gLoss];
    const all = series.flatMap(finite);
    if (all.length < 2) return;
    let lo = Math.min(...all, 0);
    let hi = Math.max(...all, 0);
    if (hi - lo < 1e-6) hi = lo + 1;
    const padR = (hi - lo) * 0.08;
    lo -= padR;
    hi += padR;

    // A zero reference line — useful for WGAN where the Wasserstein estimate targets 0.
    if (lo < 0 && hi > 0) {
      const yz = pad + (1 - (0 - lo) / (hi - lo)) * (H - 2 * pad);
      ctx.strokeStyle = 'rgba(148,163,184,0.22)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, yz);
      ctx.lineTo(W, yz);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const draw = (data: number[], color: string, lw: number) => {
      if (finite(data).length < 2) return;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) continue;
        const x = pad + (i / (data.length - 1)) * (W - 2 * pad);
        const y = pad + (1 - (data[i] - lo) / (hi - lo)) * (H - 2 * pad);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.stroke();
    };

    draw(dLoss, '#38bdf8', 2);
    draw(gLoss, '#fbbf24', 2);
    if (isWgan) draw(wDist, '#34d399', 2);
  }, [dLoss, gLoss, wDist, isWgan, width, height]);

  const last = (arr: number[]) => (arr.length ? arr[arr.length - 1] : NaN);
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={ref} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> {isWgan ? 'critic loss' : 'D loss'} <b>{f(last(dLoss))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#fbbf24' }} /> G loss <b>{f(last(gLoss))}</b>
        </span>
        {isWgan && (
          <span className="legend-item">
            <span className="swatch" style={{ background: '#34d399' }} /> W&#770; dist <b>{f(last(wDist))}</b>
          </span>
        )}
      </div>
    </div>
  );
}
