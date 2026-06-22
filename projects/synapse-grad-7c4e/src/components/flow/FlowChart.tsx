import { useEffect, useRef } from 'react';

interface Props {
  nll: number[];
  valNll: number[];
  width: number;
  height: number;
}

// Training curve for the flow: the exact mean negative log-likelihood (nats) on the train set,
// with the held-out validation NLL dashed alongside so over-fitting is visible. Lower is a
// tighter fit to the true density. Auto-scaled to the recent window.
export default function FlowChart({ nll, valNll, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

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
    const all = [...finite(nll), ...finite(valNll)];
    if (all.length < 2) return;
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (hi - lo < 1e-6) hi = lo + 1;
    const padR = (hi - lo) * 0.08;
    lo -= padR;
    hi += padR;

    const draw = (data: number[], color: string, dashed: boolean) => {
      if (finite(data).length < 2) return;
      ctx.setLineDash(dashed ? [4, 3] : []);
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
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    };

    draw(valNll, '#fda4af', true);
    draw(nll, '#38bdf8', false);
  }, [nll, valNll, width, height]);

  const last = (arr: number[]) => (arr.length ? arr[arr.length - 1] : NaN);
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={ref} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> train NLL <b>{f(last(nll))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch dashed" style={{ background: '#fda4af' }} /> val NLL <b>{f(last(valNll))}</b>
        </span>
      </div>
    </div>
  );
}
