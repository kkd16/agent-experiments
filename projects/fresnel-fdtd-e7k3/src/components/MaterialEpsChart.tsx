import { MATERIAL_BY_KEY } from '../sim/materials';
import { epsilonOfOmega } from '../sim/dispersion';

/**
 * A compact analytic ε(ω) plot for the selected dispersive brush. Shows the real
 * and imaginary permittivity across the lab's usable wavelength band, with the
 * two lines that matter for plasmonics marked: ε = 0 (the plasma point / ENZ)
 * and ε = −1 (where a surface plasmon lives). Pure closed-form — no simulation.
 */
export function MaterialEpsChart({ brushKey }: { brushKey: string }) {
  const brush = MATERIAL_BY_KEY[brushKey];
  const model = brush?.material.disp;
  if (!model) return null;
  const epsInf = brush.material.epsR;

  const W = 264;
  const H = 116;
  const pad = { l: 30, r: 8, t: 8, b: 20 };
  const lMin = 8;
  const lMax = 40;
  const N = 96;

  const pts: { l: number; re: number; im: number }[] = [];
  for (let i = 0; i < N; i++) {
    const l = lMin + ((lMax - lMin) * i) / (N - 1);
    const omega = (2 * Math.PI) / l;
    const [re, im] = epsilonOfOmega(model, epsInf, omega);
    pts.push({ l, re, im });
  }
  // clamp for display so a pole doesn't blow up the axis
  const clamp = (v: number) => Math.max(-6, Math.min(6, v));
  const yMin = -6;
  const yMax = 6;
  const x = (l: number) => pad.l + ((l - lMin) / (lMax - lMin)) * (W - pad.l - pad.r);
  const y = (v: number) =>
    H - pad.b - ((clamp(v) - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  const path = (key: 're' | 'im') =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.l).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');

  return (
    <svg className="eps-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="permittivity curve">
      {/* ε = 0 and ε = −1 guides */}
      <line x1={pad.l} y1={y(0)} x2={W - pad.r} y2={y(0)} className="eps-zero" />
      <line x1={pad.l} y1={y(-1)} x2={W - pad.r} y2={y(-1)} className="eps-spp" />
      <text x={W - pad.r} y={y(0) - 2} className="eps-tick" textAnchor="end">ε=0</text>
      <text x={W - pad.r} y={y(-1) - 2} className="eps-tick" textAnchor="end">ε=−1</text>
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} className="mc-axis" />
      <path d={path('im')} className="eps-im" />
      <path d={path('re')} className="eps-re" />
      <text x={(W + pad.l) / 2} y={H - 4} className="mc-label" textAnchor="middle">
        wavelength (cells)
      </text>
      <g className="eps-legend" transform={`translate(${pad.l + 4}, ${pad.t + 4})`}>
        <line x1="0" y1="0" x2="14" y2="0" className="eps-re" />
        <text x="18" y="3" className="mc-label">Re ε</text>
        <line x1="54" y1="0" x2="68" y2="0" className="eps-im" />
        <text x="72" y="3" className="mc-label">Im ε</text>
      </g>
    </svg>
  );
}
