import { useMemo } from 'react';

interface Props {
  tick: number;
  res: number;
  kernelShape: (res: number) => { rs: Float64Array; ks: Float64Array; prior: Float64Array[] } | null;
  samplesXs: Float64Array | null;
}

const W = 300;
const H = 150;
const PAD = 6;
const PRIOR_COLORS = ['#a78bfa', '#2dd4bf', '#fbbf24', '#f472b6'];

// Two little windows onto the prior the current kernel + hyperparameters define:
//  (top) the correlation k(r)/σ_f² as a function of input separation r — how fast the function
//        "forgets" (the lengthscale), and any oscillation (periodic);
//  (bottom) four functions drawn straight from that prior, before any data.
export default function KernelShape({ tick, res, kernelShape, samplesXs }: Props) {
  const model = useMemo(() => kernelShape(res), [kernelShape, res, tick]);
  if (!model) return null;
  const { rs, ks, prior } = model;

  const rmax = rs[rs.length - 1] || 1;
  const kx = (r: number) => PAD + (r / rmax) * (W - 2 * PAD);
  const ky = (v: number) => PAD + (1 - v) * (H / 2 - 2 * PAD); // k in [0,1] roughly

  let kd = '';
  for (let i = 0; i < rs.length; i++) kd += `${i === 0 ? 'M' : 'L'}${kx(rs[i]).toFixed(1)},${ky(ks[i]).toFixed(1)} `;

  // prior sample window (bottom half)
  const xs = samplesXs;
  let plo = Infinity;
  let phi = -Infinity;
  for (const c of prior) for (const v of c) {
    if (v < plo) plo = v;
    if (v > phi) phi = v;
  }
  if (!Number.isFinite(plo)) {
    plo = -1;
    phi = 1;
  }
  if (phi - plo < 1e-6) {
    plo -= 1;
    phi += 1;
  }
  const py0 = H / 2 + 4;
  const px = (i: number, len: number) => PAD + (i / (len - 1)) * (W - 2 * PAD);
  const py = (v: number) => py0 + (1 - (v - plo) / (phi - plo)) * (H - py0 - PAD);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="gp-kshape">
      <rect x={0} y={0} width={W} height={H} fill="#0b1220" />
      <line x1={PAD} x2={W - PAD} y1={H / 2 - 2 * PAD} y2={H / 2 - 2 * PAD} stroke="rgba(148,163,184,0.12)" />
      <path d={kd} fill="none" stroke="#38bdf8" strokeWidth={2} />
      <text x={W - PAD} y={12} textAnchor="end" className="gp-axis-txt">
        k(r)/σ_f²
      </text>
      <line x1={PAD} x2={W - PAD} y1={py0} y2={py0} stroke="rgba(148,163,184,0.12)" />
      {xs &&
        prior.map((c, i) => {
          let d = '';
          for (let j = 0; j < c.length; j++) d += `${j === 0 ? 'M' : 'L'}${px(j, c.length).toFixed(1)},${py(c[j]).toFixed(1)} `;
          return <path key={i} d={d} fill="none" stroke={PRIOR_COLORS[i % PRIOR_COLORS.length]} strokeWidth={1} opacity={0.7} />;
        })}
      <text x={W - PAD} y={py0 + 12} textAnchor="end" className="gp-axis-txt">
        prior draws
      </text>
    </svg>
  );
}
