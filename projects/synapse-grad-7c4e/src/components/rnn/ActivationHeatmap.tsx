import { useEffect, useRef } from 'react';
import { POSITIVE_COLOR, diverging, mix, rgbCss } from '../../lib/colors';

export interface HeatmapMarker {
  pos: number; // timestep index
  label: string;
  color?: string;
}

interface Props {
  // series[t] is the length-H activation vector at timestep t.
  series: Float64Array[];
  signed: boolean; // true: diverging palette over [-1,1]; false: sequential over [0,1]
  height: number; // pixel height of the heatmap band
  colLabels?: string[]; // one short label per timestep (e.g. the input token)
  markers?: HeatmapMarker[];
}

// A compact [units × time] activation heatmap. Each column is one timestep, each row one hidden
// unit; colour encodes the activation. Used for the hidden state, the cell state and every gate.
export default function ActivationHeatmap({ series, signed, height, colLabels, markers }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const T = series.length;
  const H = T > 0 ? series[0].length : 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || T === 0 || H === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const Hpx = canvas.height;
    ctx.clearRect(0, 0, W, Hpx);
    const cw = W / T;
    const ch = Hpx / H;
    const bg: [number, number, number] = [15, 23, 42];
    for (let t = 0; t < T; t++) {
      const col = series[t];
      for (let u = 0; u < H; u++) {
        const v = col[u];
        const c = signed ? diverging(v) : mix(bg, POSITIVE_COLOR, Math.max(0, Math.min(1, v)));
        ctx.fillStyle = rgbCss(c);
        ctx.fillRect(Math.floor(t * cw), Math.floor(u * ch), Math.ceil(cw) + 1, Math.ceil(ch) + 1);
      }
    }
    // marker lines
    if (markers) {
      for (const m of markers) {
        const x = (m.pos + 0.5) * cw;
        ctx.strokeStyle = m.color ?? 'rgba(248,250,252,0.9)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, Hpx);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }, [series, signed, T, H, markers]);

  if (T === 0 || H === 0) return null;

  return (
    <div className="rnn-heat">
      <canvas ref={canvasRef} width={Math.max(220, T * 14)} height={height} className="rnn-heat-canvas" />
      {colLabels && (
        <div className="rnn-heat-axis" style={{ gridTemplateColumns: `repeat(${T}, 1fr)` }}>
          {colLabels.map((l, i) => (
            <span key={i} className="rnn-heat-tick">
              {l}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
