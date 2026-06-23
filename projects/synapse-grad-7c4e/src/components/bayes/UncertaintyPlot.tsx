import { useEffect, useRef } from 'react';
import { VIEW_HALF, DATA_HALF, GAP_HALF } from '../../engine/bayes';
import type { BayesBands } from '../../hooks/useBayesTrainer';

interface Props {
  predict: () => BayesBands | null;
  sampleFunctions: (count: number) => Float64Array[];
  trueCurve: () => { xs: Float64Array; ys: Float64Array };
  dataPoints: () => { x: Float64Array; y: Float64Array } | null;
  tick: number;
  width: number;
  height: number;
  showData: boolean;
  showTrue: boolean;
  showSamples: boolean;
  showSplit: boolean;
  funcSamples: number;
}

// The hero view: the predictive distribution over the whole input axis. A shaded ±2σ / ±1σ
// band (optionally split into its aleatoric core and epistemic skirt), the predictive mean,
// the dashed ground truth, a "spaghetti" of sampled plausible functions, and the training
// points — with the gap and extrapolation regions (where there is no data) tinted so the
// uncertainty growing there reads at a glance.
export default function UncertaintyPlot({
  predict,
  sampleFunctions,
  trueCurve,
  dataPoints,
  tick,
  width,
  height,
  showData,
  showTrue,
  showSamples,
  showSplit,
  funcSamples,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = width;
    const H = height;
    const padL = 38;
    const padR = 12;
    const padT = 12;
    const padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const bands = predict();
    const truth = trueCurve();
    const data = showData ? dataPoints() : null;

    // ---- vertical range -----------------------------------------------------------
    let yMin = Infinity;
    let yMax = -Infinity;
    const grow = (v: number) => {
      if (Number.isFinite(v)) {
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    };
    for (let i = 0; i < truth.ys.length; i++) grow(truth.ys[i]);
    if (data) for (let i = 0; i < data.y.length; i++) grow(data.y[i]);
    if (bands) {
      for (let g = 0; g < bands.xs.length; g++) {
        grow(bands.mean[g] + 2 * bands.totalStd[g]);
        grow(bands.mean[g] - 2 * bands.totalStd[g]);
      }
    }
    if (!Number.isFinite(yMin)) {
      yMin = -2;
      yMax = 2;
    }
    // clamp the window so an early variance blow-up doesn't flatten everything
    yMin = Math.max(yMin, -6);
    yMax = Math.min(yMax, 6);
    const span = Math.max(0.6, yMax - yMin);
    yMin -= span * 0.08;
    yMax += span * 0.08;

    const X = (x: number) => padL + ((x + VIEW_HALF) / (2 * VIEW_HALF)) * plotW;
    const Y = (y: number) => padT + (1 - (y - yMin) / (yMax - yMin)) * plotH;

    // ---- no-data region tint ------------------------------------------------------
    ctx.fillStyle = 'rgba(148,163,184,0.06)';
    // central gap
    ctx.fillRect(X(-GAP_HALF), padT, X(GAP_HALF) - X(-GAP_HALF), plotH);
    // left / right extrapolation
    ctx.fillRect(padL, padT, X(-DATA_HALF) - padL, plotH);
    ctx.fillRect(X(DATA_HALF), padT, padL + plotW - X(DATA_HALF), plotH);

    // ---- grid + axes --------------------------------------------------------------
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(148,163,184,0.7)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const yv = yMin + (i / yTicks) * (yMax - yMin);
      const py = Y(yv);
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(padL + plotW, py);
      ctx.stroke();
      ctx.fillText(yv.toFixed(1), padL - 5, py);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let xv = -3; xv <= 3; xv++) {
      const px = X(xv);
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.strokeStyle = 'rgba(148,163,184,0.07)';
      ctx.stroke();
      ctx.fillText(String(xv), px, padT + plotH + 5);
    }

    const clipPlot = () => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT, plotW, plotH);
      ctx.clip();
    };

    // ---- uncertainty bands --------------------------------------------------------
    const fillBand = (std: Float64Array, k: number, color: string) => {
      if (!bands) return;
      ctx.beginPath();
      for (let g = 0; g < bands.xs.length; g++) {
        const px = X(bands.xs[g]);
        const py = Y(bands.mean[g] + k * std[g]);
        if (g === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      for (let g = bands.xs.length - 1; g >= 0; g--) {
        const px = X(bands.xs[g]);
        const py = Y(bands.mean[g] - k * std[g]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };

    if (bands) {
      clipPlot();
      if (showSplit) {
        // epistemic skirt = total band; aleatoric core drawn on top in a warm hue
        fillBand(bands.totalStd, 2, 'rgba(96,165,250,0.16)');
        fillBand(bands.totalStd, 1, 'rgba(96,165,250,0.22)');
        fillBand(bands.aleStd, 2, 'rgba(251,191,36,0.16)');
        fillBand(bands.aleStd, 1, 'rgba(251,191,36,0.24)');
      } else {
        fillBand(bands.totalStd, 2, 'rgba(56,189,248,0.14)');
        fillBand(bands.totalStd, 1, 'rgba(56,189,248,0.26)');
      }
      ctx.restore();
    }

    // ---- sampled functions (spaghetti) -------------------------------------------
    if (showSamples) {
      const curves = sampleFunctions(funcSamples);
      clipPlot();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(125,211,252,0.28)';
      for (const ys of curves) {
        ctx.beginPath();
        for (let g = 0; g < ys.length; g++) {
          const px = X(truth.xs[g]);
          const py = Y(ys[g]);
          if (g === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---- true function ------------------------------------------------------------
    if (showTrue) {
      clipPlot();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(226,232,240,0.65)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let g = 0; g < truth.xs.length; g++) {
        const px = X(truth.xs[g]);
        const py = Y(truth.ys[g]);
        if (g === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ---- predictive mean ----------------------------------------------------------
    if (bands) {
      clipPlot();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (let g = 0; g < bands.xs.length; g++) {
        const px = X(bands.xs[g]);
        const py = Y(bands.mean[g]);
        if (g === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    // ---- data points --------------------------------------------------------------
    if (data) {
      clipPlot();
      ctx.fillStyle = 'rgba(248,250,252,0.85)';
      for (let i = 0; i < data.x.length; i++) {
        const px = X(data.x[i]);
        const py = Y(data.y[i]);
        ctx.beginPath();
        ctx.arc(px, py, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }, [predict, sampleFunctions, trueCurve, dataPoints, tick, width, height, showData, showTrue, showSamples, showSplit, funcSamples]);

  return <canvas ref={ref} className="uq-canvas" />;
}
