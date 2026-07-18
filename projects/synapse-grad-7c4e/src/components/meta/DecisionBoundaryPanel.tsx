import { useEffect, useRef } from 'react';
import type { ClfAdaptationView } from '../../hooks/useMetaTrainer';
import type { ClfField } from '../../engine/meta';
import { CLASS_COLORS } from './palette';

interface Props {
  view: ClfAdaptationView | null;
  stepIdx: number;
  showRandom: boolean;
  width: number;
  height: number;
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

// The learner's decision regions over the plane after `stepIdx` inner steps — meta-init on the
// left, and (optionally) a random init on the right for contrast. The support points are drawn on
// top in their true class colour. Scrubbing shows the boundary crystallise in a step or two from
// the meta-init while the random init lags.
export default function DecisionBoundaryPanel({ view, stepIdx, showRandom, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, width, height);
    if (!view) return;

    const gap = showRandom ? 14 : 0;
    const panels = showRandom ? 2 : 1;
    const side = Math.min(height - 20, (width - gap) / panels);
    const totalW = side * panels + gap * (panels - 1);
    const x0 = (width - totalW) / 2;
    const y0 = (height - side) / 2;

    const drawPanel = (fields: ClfField[], ox: number, label: string, dim: boolean) => {
      const field = fields[Math.min(stepIdx, fields.length - 1)];
      const res = field.res;
      const cell = side / res;
      // decision regions
      for (let gy = 0; gy < res; gy++) {
        for (let gx = 0; gx < res; gx++) {
          const i = gy * res + gx;
          const cls = field.cls[i];
          const conf = field.conf[i];
          const a = (0.14 + Math.min(1, Math.max(0, (conf - 1 / CLASS_COLORS.length))) * 0.55) * (dim ? 0.6 : 1);
          ctx.fillStyle = rgba(CLASS_COLORS[cls % CLASS_COLORS.length], a);
          ctx.fillRect(ox + gx * cell, y0 + gy * cell, cell + 0.6, cell + 0.6);
        }
      }
      // support points
      const sc = (v: number) => ((v + view.view) / (2 * view.view)) * side;
      const sup = view.support;
      for (let k = 0; k < sup.n; k++) {
        const px = ox + sc(sup.x[k * 2]);
        const py = y0 + (side - sc(sup.x[k * 2 + 1]));
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fillStyle = CLASS_COLORS[sup.y[k] % CLASS_COLORS.length];
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(11,18,32,0.95)';
        ctx.stroke();
      }
      // frame + label
      ctx.strokeStyle = 'rgba(148,163,184,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(ox, y0, side, side);
      ctx.font = '11px ui-sans-serif, system-ui';
      ctx.fillStyle = 'rgba(226,232,240,0.9)';
      ctx.fillText(label, ox + 6, y0 + 15);
    };

    drawPanel(view.metaFields, x0, 'meta-init', false);
    if (showRandom) drawPanel(view.randomFields, x0 + side + gap, 'random init', true);
  }, [view, stepIdx, showRandom, width, height]);

  return <canvas ref={ref} style={{ width, height, display: 'block', borderRadius: 8 }} />;
}
