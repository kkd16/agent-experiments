import { useEffect, useRef } from 'react';

interface Props {
  train: number[];
  val: number[];
  test: number[];
  width: number;
  height: number;
}

// Train / validation / test node-classification accuracy over training. The test curve is the
// honest generalization signal — those nodes are never in the loss, so the network reaches them
// purely by propagating the few labeled nodes across the graph.
export default function MetricsChart({ train, val, test, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, width, height);

    const pad = 4;
    ctx.strokeStyle = 'rgba(148,163,184,0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (i / 4) * (height - 2 * pad);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // accuracy axis is fixed [0,1]
    const draw = (data: number[], color: string, dashed: boolean) => {
      const finite = data.filter((v) => Number.isFinite(v));
      if (finite.length < 2) return;
      ctx.setLineDash(dashed ? [4, 3] : []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) continue;
        const x = pad + (i / (data.length - 1)) * (width - 2 * pad);
        const y = pad + (1 - data[i]) * (height - 2 * pad);
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

    draw(train, '#a78bfa', true);
    draw(val, '#fbbf24', false);
    draw(test, '#38bdf8', false);
  }, [train, val, test, width, height]);

  const last = (arr: number[]) => {
    for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i];
    return NaN;
  };
  const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

  return (
    <div className="chart-wrap">
      <canvas ref={ref} width={width} height={height} className="chart" />
      <div className="chart-legend">
        <span className="legend-item">
          <span className="swatch dashed" style={{ background: '#a78bfa' }} /> train <b>{pct(last(train))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#fbbf24' }} /> val <b>{pct(last(val))}</b>
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> test <b>{pct(last(test))}</b>
        </span>
      </div>
    </div>
  );
}
