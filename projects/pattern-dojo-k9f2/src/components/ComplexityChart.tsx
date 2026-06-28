import { useMemo, useState } from "react";
import type { Fit } from "../dojo/complexity";
import { modelOf } from "../dojo/complexity";
import type { ProfilePoint } from "../dojo/profiler";

/**
 * A from-scratch SVG plot of the profiler's measurements: the timed (n, ms)
 * points plus the best-fit growth curve. A log–log view (the default) turns
 * every power law into a straight line whose slope is the exponent, so O(n) and
 * O(n²) are visibly different gradients; a linear view shows the raw blow-up.
 * No charting library — just coordinate math and SVG.
 */

const W = 640;
const H = 380;
const PAD = { left: 60, right: 18, top: 18, bottom: 46 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

interface Props {
  points: ProfilePoint[];
  fit: Fit | null;
  sizeLabel: string;
  color?: string;
}

type Scale = "loglog" | "linear";

function niceLinearTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.5; v += step) ticks.push(v);
  return ticks;
}

function log10Ticks(min: number, max: number): number[] {
  const ticks: number[] = [];
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  for (let e = lo; e <= hi; e++) ticks.push(Math.pow(10, e));
  return ticks;
}

function fmtN(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(n % 1e9 ? 1 : 0) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n % 1e3 ? 1 : 0) + "k";
  return String(Math.round(n));
}

function fmtMs(t: number): string {
  if (t >= 1) return t.toFixed(t >= 10 ? 0 : 1) + "ms";
  if (t >= 0.001) return (t * 1000).toFixed(t * 1000 >= 10 ? 0 : 1) + "µs";
  return (t * 1e6).toFixed(0) + "ns";
}

export default function ComplexityChart({ points, fit, sizeLabel, color = "var(--accent)" }: Props) {
  const [scale, setScale] = useState<Scale>("loglog");

  const view = useMemo(() => {
    const pts = points.filter((p) => p.n > 0 && p.perCall > 0);
    if (pts.length < 2) return null;
    const log = scale === "loglog";

    const nMin = Math.min(...pts.map((p) => p.n));
    const nMax = Math.max(...pts.map((p) => p.n));
    const tMin = Math.min(...pts.map((p) => p.perCall));
    const tMax = Math.max(...pts.map((p) => p.perCall));

    // sample the fit curve across the x-domain
    const model = fit ? modelOf(fit.id) : null;
    const curve: { n: number; t: number }[] = [];
    if (fit && model) {
      const steps = 80;
      for (let i = 0; i <= steps; i++) {
        const frac = i / steps;
        const n = log
          ? nMin * Math.pow(nMax / nMin, frac)
          : nMin + (nMax - nMin) * frac;
        const t = fit.a * model.f(n) + fit.b;
        if (Number.isFinite(t) && (!log || t > 0)) curve.push({ n, t });
      }
    }

    const allT = [tMin, tMax, ...curve.map((c) => c.t)].filter((v) => v > 0 || !log);
    const yLo = log ? Math.min(...allT) : 0;
    const yHi = Math.max(...allT);

    const xToPx = (n: number) => {
      const f = log
        ? (Math.log10(n) - Math.log10(nMin)) / (Math.log10(nMax) - Math.log10(nMin) || 1)
        : (n - nMin) / (nMax - nMin || 1);
      return PAD.left + f * PLOT_W;
    };
    const yToPx = (t: number) => {
      const f = log
        ? (Math.log10(Math.max(t, yLo)) - Math.log10(yLo)) / (Math.log10(yHi) - Math.log10(yLo) || 1)
        : (t - yLo) / (yHi - yLo || 1);
      return PAD.top + (1 - f) * PLOT_H;
    };

    const xTicks = log ? log10Ticks(nMin, nMax) : niceLinearTicks(nMin, nMax);
    const yTicks = log ? log10Ticks(yLo, yHi) : niceLinearTicks(yLo, yHi);

    const curvePath = curve
      .map((c, i) => `${i === 0 ? "M" : "L"}${xToPx(c.n).toFixed(1)},${yToPx(c.t).toFixed(1)}`)
      .join(" ");

    return { pts, xToPx, yToPx, xTicks, yTicks, curvePath, nMin, nMax, yLo, yHi };
  }, [points, fit, scale]);

  if (!view) {
    return <p className="muted small">Not enough points to chart yet.</p>;
  }

  return (
    <div className="cx-chart">
      <div className="cx-chart-head">
        <div className="cx-legend">
          <span className="cx-legend-item">
            <span className="cx-dot" style={{ background: color }} /> measured
          </span>
          {fit && (
            <span className="cx-legend-item">
              <span className="cx-line" style={{ background: color }} /> {modelOf(fit.id).label} fit
            </span>
          )}
        </div>
        <div className="cx-scale-toggle" role="group" aria-label="Chart scale">
          <button className={scale === "loglog" ? "on" : ""} onClick={() => setScale("loglog")}>
            log–log
          </button>
          <button className={scale === "linear" ? "on" : ""} onClick={() => setScale("linear")}>
            linear
          </button>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="cx-svg" role="img"
        aria-label={`Per-call time versus ${sizeLabel}, ${scale === "loglog" ? "log-log" : "linear"} scale`}>
        {/* gridlines + axis ticks */}
        {view.yTicks.map((t, i) => {
          const y = view.yToPx(t);
          if (y < PAD.top - 1 || y > H - PAD.bottom + 1) return null;
          return (
            <g key={`y${i}`}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} className="cx-grid" />
              <text x={PAD.left - 8} y={y + 3.5} className="cx-axis-label" textAnchor="end">{fmtMs(t)}</text>
            </g>
          );
        })}
        {view.xTicks.map((n, i) => {
          const x = view.xToPx(n);
          if (x < PAD.left - 1 || x > W - PAD.right + 1) return null;
          return (
            <g key={`x${i}`}>
              <line x1={x} y1={PAD.top} x2={x} y2={H - PAD.bottom} className="cx-grid" />
              <text x={x} y={H - PAD.bottom + 18} className="cx-axis-label" textAnchor="middle">{fmtN(n)}</text>
            </g>
          );
        })}

        {/* axis frame */}
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} className="cx-axis" />
        <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} className="cx-axis" />

        {/* fit curve */}
        {view.curvePath && <path d={view.curvePath} className="cx-fit" style={{ stroke: color }} />}

        {/* measured points */}
        {view.pts.map((p, i) => (
          <circle key={i} cx={view.xToPx(p.n)} cy={view.yToPx(p.perCall)} r={4}
            className="cx-point" style={{ fill: color }}>
            <title>{`n = ${p.n.toLocaleString()} → ${fmtMs(p.perCall)} (batch ×${p.k})`}</title>
          </circle>
        ))}

        {/* axis titles */}
        <text x={PAD.left + PLOT_W / 2} y={H - 6} className="cx-axis-title" textAnchor="middle">{sizeLabel}</text>
        <text transform={`translate(14 ${PAD.top + PLOT_H / 2}) rotate(-90)`} className="cx-axis-title" textAnchor="middle">
          time per call
        </text>
      </svg>
    </div>
  );
}
