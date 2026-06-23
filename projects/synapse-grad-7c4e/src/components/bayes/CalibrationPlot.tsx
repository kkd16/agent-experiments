import { useEffect, useRef } from 'react';
import type { CalibrationResult } from '../../hooks/useBayesTrainer';

interface Props {
  calibration: () => CalibrationResult | null;
  tick: number;
  width: number;
  height: number;
}

// Reliability diagram. For each nominal central-credible level p (x-axis), we plot the empirical
// fraction of held-out targets that actually fall inside the model's ±z(p)·σ interval (y-axis).
// A perfectly-calibrated model sits on the diagonal; below it is over-confident (intervals too
// tight), above it is under-confident. The shaded area between the curve and the diagonal is the
// expected calibration error.
export default function CalibrationPlot({ calibration, tick, width, height }: Props) {
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
    const pad = 30;
    const plotW = W - pad - 10;
    const plotH = H - pad - 10;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const X = (p: number) => pad + p * plotW;
    const Y = (p: number) => 10 + (1 - p) * plotH;

    // grid
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.fillStyle = 'rgba(148,163,184,0.6)';
    ctx.lineWidth = 1;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const v = i / 5;
      ctx.beginPath();
      ctx.moveTo(pad, Y(v));
      ctx.lineTo(pad + plotW, Y(v));
      ctx.stroke();
      ctx.fillText(v.toFixed(1), pad - 4, Y(v));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 5; i++) {
      const v = i / 5;
      ctx.fillText(v.toFixed(1), X(v), 10 + plotH + 4);
    }

    // perfect-calibration diagonal
    ctx.strokeStyle = 'rgba(226,232,240,0.5)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    ctx.lineTo(X(1), Y(1));
    ctx.stroke();
    ctx.setLineDash([]);

    const cal = calibration();
    if (cal && cal.levels.length > 1) {
      // shaded gap to the diagonal
      ctx.beginPath();
      ctx.moveTo(X(cal.levels[0]), Y(cal.observed[0]));
      for (let i = 1; i < cal.levels.length; i++) ctx.lineTo(X(cal.levels[i]), Y(cal.observed[i]));
      for (let i = cal.levels.length - 1; i >= 0; i--) ctx.lineTo(X(cal.levels[i]), Y(cal.levels[i]));
      ctx.closePath();
      ctx.fillStyle = 'rgba(56,189,248,0.12)';
      ctx.fill();

      // observed curve
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < cal.levels.length; i++) {
        const px = X(cal.levels[i]);
        const py = Y(cal.observed[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.fillStyle = '#38bdf8';
      for (let i = 0; i < cal.levels.length; i++) {
        ctx.beginPath();
        ctx.arc(X(cal.levels[i]), Y(cal.observed[i]), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // axis labels
    ctx.fillStyle = 'rgba(148,163,184,0.75)';
    ctx.font = '10px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('expected coverage', pad + plotW / 2, H - 1);
    ctx.save();
    ctx.translate(9, 10 + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('observed', 0, 0);
    ctx.restore();
  }, [calibration, tick, width, height]);

  return <canvas ref={ref} className="uq-cal" />;
}
