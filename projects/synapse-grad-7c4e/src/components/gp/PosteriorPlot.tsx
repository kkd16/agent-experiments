import { useMemo, useRef } from 'react';
import type { Posterior } from '../../engine/gp';

interface Props {
  domain: [number, number];
  tick: number;
  showSamples: boolean;
  showPredictive: boolean;
  sampleCount: number;
  sampleSeed: number;
  res: number;
  posterior: (res: number) => Posterior | null;
  samples: (res: number, count: number, seed: number) => { Xs: Float64Array; curves: Float64Array[] } | null;
  dataPoints: () => { X: number[]; y: number[] };
  onAdd: (x: number, y: number) => void;
  onRemove: (x: number) => void;
}

const W = 720;
const H = 420;
const PAD_L = 40;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 28;

const SAMPLE_COLORS = ['#a78bfa', '#2dd4bf', '#fbbf24', '#f472b6', '#38bdf8', '#a3e653'];

// The headline: a 1-D GP regression view. The posterior mean, its 95% credible band (±2σ of the
// latent function), a fainter predictive band (+ observation noise), a handful of posterior
// sample functions, and the observations. Click the plot to add a point and watch the posterior
// snap to it; right-click a point to remove it.
export default function PosteriorPlot({
  domain,
  tick,
  showSamples,
  showPredictive,
  sampleCount,
  sampleSeed,
  res,
  posterior,
  samples,
  dataPoints,
  onAdd,
  onRemove,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  const model = useMemo(() => {
    const post = posterior(res);
    const samp = showSamples ? samples(res, sampleCount, sampleSeed) : null;
    const pts = dataPoints();
    // y-range from band + points + samples
    let lo = Infinity;
    let hi = -Infinity;
    const bump = (v: number) => {
      if (!Number.isFinite(v)) return;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    };
    if (post) {
      for (let i = 0; i < post.mean.length; i++) {
        const s = showPredictive ? post.sdPredictive[i] : post.sdLatent[i];
        bump(post.mean[i] + 2 * s);
        bump(post.mean[i] - 2 * s);
      }
    }
    for (const y of pts.y) bump(y);
    if (samp) for (const c of samp.curves) for (const v of c) bump(v);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = -2;
      hi = 2;
    }
    if (hi - lo < 1e-6) {
      lo -= 1;
      hi += 1;
    }
    const padY = (hi - lo) * 0.08;
    lo -= padY;
    hi += padY;
    return { post, samp, pts, lo, hi };
  }, [posterior, samples, dataPoints, res, showSamples, showPredictive, sampleCount, sampleSeed, tick]);

  const { post, samp, pts, lo, hi } = model;
  const [x0, x1] = domain;
  const sx = (x: number) => PAD_L + ((x - x0) / (x1 - x0)) * (W - PAD_L - PAD_R);
  const sy = (y: number) => PAD_T + (1 - (y - lo) / (hi - lo)) * (H - PAD_T - PAD_B);

  const bandPath = (predictive: boolean): string => {
    if (!post) return '';
    const n = post.mean.length;
    let d = '';
    for (let i = 0; i < n; i++) {
      const s = predictive ? post.sdPredictive[i] : post.sdLatent[i];
      d += `${i === 0 ? 'M' : 'L'}${sx(post.Xs[i]).toFixed(1)},${sy(post.mean[i] + 2 * s).toFixed(1)} `;
    }
    for (let i = n - 1; i >= 0; i--) {
      const s = predictive ? post.sdPredictive[i] : post.sdLatent[i];
      d += `L${sx(post.Xs[i]).toFixed(1)},${sy(post.mean[i] - 2 * s).toFixed(1)} `;
    }
    return d + 'Z';
  };

  const linePath = (xs: Float64Array, ys: Float64Array): string => {
    let d = '';
    for (let i = 0; i < xs.length; i++) d += `${i === 0 ? 'M' : 'L'}${sx(xs[i]).toFixed(1)},${sy(ys[i]).toFixed(1)} `;
    return d;
  };

  const toData = (evt: React.MouseEvent): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    const py = ((evt.clientY - rect.top) / rect.height) * H;
    if (px < PAD_L || px > W - PAD_R || py < PAD_T || py > H - PAD_B) return null;
    const x = x0 + ((px - PAD_L) / (W - PAD_L - PAD_R)) * (x1 - x0);
    const y = lo + (1 - (py - PAD_T) / (H - PAD_T - PAD_B)) * (hi - lo);
    return { x, y };
  };

  // y grid ticks
  const yticks = niceTicks(lo, hi, 5);
  const xticks = niceTicks(x0, x1, 7);

  return (
    <div className="gp-plot-wrap">
      <svg
        ref={svgRef}
        className="gp-plot"
        viewBox={`0 0 ${W} ${H}`}
        onClick={(e) => {
          const d = toData(e);
          if (d) onAdd(d.x, d.y);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const d = toData(e);
          if (d) onRemove(d.x);
        }}
      >
        <rect x={0} y={0} width={W} height={H} fill="#0b1220" />
        {/* grid */}
        {yticks.map((t) => (
          <g key={`y${t}`}>
            <line x1={PAD_L} x2={W - PAD_R} y1={sy(t)} y2={sy(t)} stroke="rgba(148,163,184,0.10)" />
            <text x={PAD_L - 6} y={sy(t) + 3} textAnchor="end" className="gp-axis-txt">
              {fmt(t)}
            </text>
          </g>
        ))}
        {xticks.map((t) => (
          <g key={`x${t}`}>
            <line x1={sx(t)} x2={sx(t)} y1={PAD_T} y2={H - PAD_B} stroke="rgba(148,163,184,0.06)" />
            <text x={sx(t)} y={H - PAD_B + 16} textAnchor="middle" className="gp-axis-txt">
              {fmt(t)}
            </text>
          </g>
        ))}
        {/* zero line */}
        {lo < 0 && hi > 0 && <line x1={PAD_L} x2={W - PAD_R} y1={sy(0)} y2={sy(0)} stroke="rgba(148,163,184,0.18)" />}

        {/* predictive band (fainter, includes observation noise) */}
        {post && showPredictive && <path d={bandPath(true)} fill="rgba(56,189,248,0.08)" stroke="none" />}
        {/* 95% latent credible band */}
        {post && <path d={bandPath(false)} fill="rgba(56,189,248,0.20)" stroke="none" />}

        {/* posterior sample functions */}
        {samp &&
          samp.curves.map((c, i) => (
            <path
              key={i}
              d={linePath(samp.Xs, c)}
              fill="none"
              stroke={SAMPLE_COLORS[i % SAMPLE_COLORS.length]}
              strokeWidth={1}
              opacity={0.55}
            />
          ))}

        {/* posterior mean */}
        {post && <path d={linePath(post.Xs, post.mean)} fill="none" stroke="#e2e8f0" strokeWidth={2.2} />}

        {/* observations */}
        {pts.X.map((x, i) => (
          <circle key={i} cx={sx(x)} cy={sy(pts.y[i])} r={4} fill="#fbbf24" stroke="#0b1220" strokeWidth={1.5} />
        ))}
      </svg>
      <div className="gp-plot-hint muted small">
        click to add a point · right-click a point to remove · band is the 95% credible interval of f
      </div>
    </div>
  );
}

function fmt(v: number): string {
  if (Math.abs(v) < 1e-9) return '0';
  if (Math.abs(v) >= 100) return v.toFixed(0);
  return v.toFixed(Math.abs(v) < 1 ? 2 : 1);
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}
