import { surrogateForward, surrogateDeriv, type SurrogateKind } from '../../engine/snn';

interface Props {
  surrogate: SurrogateKind;
  slope: number;
  width?: number;
  height?: number;
}

// The idea behind the whole lab, on one plot. The spike S = 1[U ≥ θ] is a Heaviside step (grey):
// its true derivative is 0 everywhere and a spike (∞) at the threshold — useless for learning. The
// surrogate gradient (amber) replaces that with a smooth bump f′(U−θ) on the backward pass, while
// the forward keeps the hard step. The soft relaxation f (cyan) is the function whose derivative
// the bump actually is — `softSpike`'s forward, and what the self-test gradchecks.
export default function SurrogatePlot({ surrogate, slope, width = 300, height = 170 }: Props) {
  const pad = 24;
  const W = width;
  const H = height;
  const u0 = -2;
  const u1 = 2;
  const N = 120;
  const xAt = (u: number) => pad + ((u - u0) / (u1 - u0)) * (W - 2 * pad);

  // Left axis for f∈[0,1]; the derivative is scaled to share the frame (peak → top).
  const yStep = (v: number) => pad + (1 - v) * (H - 2 * pad);
  let maxD = 1e-6;
  const soft: [number, number][] = [];
  const der: number[] = [];
  const us: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = u0 + (i / N) * (u1 - u0);
    us.push(u);
    soft.push([u, surrogateForward(u, surrogate, slope)]);
    const d = surrogateDeriv(u, surrogate, slope);
    der.push(d);
    maxD = Math.max(maxD, d);
  }
  const yDer = (d: number) => pad + (1 - (d / maxD) * 0.92) * (H - 2 * pad);

  const stepPath = `M ${xAt(u0)} ${yStep(0)} L ${xAt(0)} ${yStep(0)} L ${xAt(0)} ${yStep(1)} L ${xAt(u1)} ${yStep(1)}`;
  const softPath = 'M ' + soft.map(([u, v]) => `${xAt(u).toFixed(1)} ${yStep(v).toFixed(1)}`).join(' L ');
  const derPath = 'M ' + us.map((u, i) => `${xAt(u).toFixed(1)} ${yDer(der[i]).toFixed(1)}`).join(' L ');
  const derArea = derPath + ` L ${xAt(u1)} ${yStep(0)} L ${xAt(u0)} ${yStep(0)} Z`;

  return (
    <div>
      <svg width={W} height={H} className="surrogate-svg" role="img" aria-label="surrogate gradient plot">
        {/* zero (threshold) vertical */}
        <line x1={xAt(0)} y1={pad - 4} x2={xAt(0)} y2={H - pad + 4} stroke="rgba(74,222,128,0.5)" strokeDasharray="4 3" />
        <text x={xAt(0) + 3} y={pad + 2} fill="rgba(74,222,128,0.8)" fontSize="9" fontFamily="ui-monospace, monospace">
          U = θ
        </text>
        {/* baseline */}
        <line x1={pad} y1={yStep(0)} x2={W - pad} y2={yStep(0)} stroke="rgba(148,163,184,0.18)" />
        {/* surrogate derivative filled bump */}
        <path d={derArea} fill="rgba(251,191,36,0.14)" stroke="none" />
        <path d={derPath} fill="none" stroke="#fbbf24" strokeWidth={2} />
        {/* Heaviside step (the real spike) */}
        <path d={stepPath} fill="none" stroke="rgba(148,163,184,0.7)" strokeWidth={2} />
        {/* soft relaxation */}
        <path d={softPath} fill="none" stroke="#38bdf8" strokeWidth={1.6} strokeDasharray="3 2" />
        {/* x labels */}
        <text x={pad} y={H - 6} fill="rgba(148,163,184,0.6)" fontSize="9" fontFamily="ui-monospace, monospace">
          U−θ = −2
        </text>
        <text x={W - pad} y={H - 6} fill="rgba(148,163,184,0.6)" fontSize="9" textAnchor="end" fontFamily="ui-monospace, monospace">
          +2
        </text>
      </svg>
      <div className="chart-legend" style={{ marginTop: 2 }}>
        <span className="legend-item">
          <span className="swatch" style={{ background: 'rgba(148,163,184,0.7)' }} /> spike 1[U≥θ]
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#fbbf24' }} /> surrogate f′
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: '#38bdf8' }} /> soft f
        </span>
      </div>
    </div>
  );
}
