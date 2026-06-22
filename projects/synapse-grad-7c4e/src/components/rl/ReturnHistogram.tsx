import { useEffect, useRef } from 'react';

interface Props {
  returns: number[]; // the most recent batch's per-episode returns
  width: number;
  height: number;
}

// The spread of episode returns within the *latest* collected batch — a histogram, not just the
// mean. Policy-gradient learning curves are notoriously noisy because the batch mean hides a wide
// distribution; this shows it directly. As a policy converges the distribution tightens and slides
// toward the high-return end; on a hard exploration task it stays bimodal (some episodes solve, most
// don't) long before the mean moves.
const BINS = 24;

export default function ReturnHistogram({ returns, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, width, height);

    const data = returns.filter((v) => Number.isFinite(v));
    if (data.length === 0) return;

    let lo = Math.min(...data);
    let hi = Math.max(...data);
    if (hi - lo < 1e-9) {
      lo -= 0.5;
      hi += 0.5;
    }
    const span = hi - lo;
    const counts = new Array(BINS).fill(0);
    for (const v of data) {
      let b = Math.floor(((v - lo) / span) * BINS);
      if (b >= BINS) b = BINS - 1;
      if (b < 0) b = 0;
      counts[b]++;
    }
    const maxC = Math.max(...counts, 1);

    const pad = 4;
    const bw = (width - 2 * pad) / BINS;
    let meanV = 0;
    for (const v of data) meanV += v;
    meanV /= data.length;

    for (let b = 0; b < BINS; b++) {
      const h = (counts[b] / maxC) * (height - 2 * pad - 12);
      const x = pad + b * bw;
      const y = height - pad - h;
      ctx.fillStyle = 'rgba(56,189,248,0.55)';
      ctx.fillRect(x + 0.5, y, Math.max(1, bw - 1), h);
    }

    // Mean marker.
    const mx = pad + ((meanV - lo) / span) * (width - 2 * pad);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mx, pad);
    ctx.lineTo(mx, height - pad);
    ctx.stroke();

    ctx.fillStyle = 'rgba(226,232,240,0.75)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(lo.toFixed(0), pad, 10);
    ctx.textAlign = 'right';
    ctx.fillText(hi.toFixed(0), width - pad, 10);
  }, [returns, width, height]);

  return <canvas ref={canvasRef} width={width} height={height} className="chart" />;
}
