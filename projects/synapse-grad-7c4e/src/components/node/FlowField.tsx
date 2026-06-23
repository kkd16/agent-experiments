import { useEffect, useRef } from 'react';
import { CLASS_COLORS } from '../../lib/colors';

export const VIZ_FRAMES = 32;

interface Props {
  view: number;
  classes: number;
  res: number;
  trajCount: number;
  tick: number;
  t: number; // scrub time in [0,1]
  showField: boolean;
  showVectors: boolean;
  showTraj: boolean;
  decisionField: (res: number) => { cls: Int32Array; conf: Float64Array; res: number } | null;
  sampleTrajectories: (
    count: number,
    frames: number,
  ) => { plane: Float64Array[]; aug: Float64Array[] | null; labels: Int32Array; frames: number } | null;
  vectorField: (res: number, t: number) => Float64Array | null;
  dataPoints: () => { xy: Float64Array; labels: Int32Array } | null;
  size?: number;
}

// The headline of the Neural-ODE lab. A single canvas that fuses four views of the same learned
// dynamics: the terminal decision regions (background), the *time-dependent* learned vector
// field f_θ(·, t) at the scrubbed time t (a quiver that morphs as you drag the slider), the
// trajectories every sample point traces from t=0 → t (so you literally watch the data flow and
// untangle), and the live position of each point at time t. Drag the time slider (or hit play)
// and the field + cloud animate continuously — depth made into time.
export default function FlowField({
  view,
  classes,
  res,
  trajCount,
  tick,
  t,
  showField,
  showVectors,
  showTraj,
  decisionField,
  sampleTrajectories,
  vectorField,
  dataPoints,
  size = 460,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Cache the heavy, t-independent queries by training tick so scrubbing stays smooth.
  const cacheRef = useRef<{
    tick: number;
    field: ReturnType<Props['decisionField']>;
    traj: ReturnType<Props['sampleTrajectories']>;
    pts: ReturnType<Props['dataPoints']>;
  } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = size;
    const H = size;
    canvas.width = W;
    canvas.height = H;

    if (!cacheRef.current || cacheRef.current.tick !== tick) {
      cacheRef.current = {
        tick,
        field: decisionField(res),
        traj: sampleTrajectories(trajCount, VIZ_FRAMES),
        pts: dataPoints(),
      };
    }
    const { field, traj, pts } = cacheRef.current;

    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, W, H);

    const toPx = (x: number) => ((x + view) / (2 * view)) * W;
    const toPy = (y: number) => ((view - y) / (2 * view)) * H;
    const colorOf = (c: number) => CLASS_COLORS[c % CLASS_COLORS.length];

    // 1) terminal decision regions
    if (showField && field) {
      const off = document.createElement('canvas');
      off.width = field.res;
      off.height = field.res;
      const octx = off.getContext('2d');
      if (octx) {
        const img = octx.createImageData(field.res, field.res);
        for (let i = 0; i < field.cls.length; i++) {
          const col = colorOf(field.cls[i]);
          const conf = field.conf[i];
          const a = 0.16 + 0.55 * Math.max(0, (conf - 1 / classes) / (1 - 1 / classes));
          img.data[i * 4] = col[0];
          img.data[i * 4 + 1] = col[1];
          img.data[i * 4 + 2] = col[2];
          img.data[i * 4 + 3] = Math.round(a * 255);
        }
        octx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(off, 0, 0, W, H);
      }
    }

    // 2) learned vector field at time t
    if (showVectors) {
      const vres = 15;
      const vf = vectorField(vres, t);
      if (vf) {
        let maxMag = 1e-9;
        for (let i = 0; i < vres * vres; i++) {
          const dx = vf[i * 4 + 2];
          const dy = vf[i * 4 + 3];
          maxMag = Math.max(maxMag, Math.hypot(dx, dy));
        }
        const cell = (2 * view) / vres;
        const scale = (cell / maxMag) * 0.85 * (W / (2 * view));
        ctx.lineWidth = 1;
        for (let i = 0; i < vres * vres; i++) {
          const x = vf[i * 4];
          const y = vf[i * 4 + 1];
          const dx = vf[i * 4 + 2];
          const dy = vf[i * 4 + 3];
          const mag = Math.hypot(dx, dy);
          const px = toPx(x);
          const py = toPy(y);
          const ex = px + dx * scale;
          const ey = py - dy * scale;
          const a = 0.18 + 0.5 * Math.min(1, mag / maxMag);
          ctx.strokeStyle = `rgba(148, 197, 255, ${a})`;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          // arrowhead
          const ang = Math.atan2(ey - py, ex - px);
          const ah = 3;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - ah * Math.cos(ang - 0.4), ey - ah * Math.sin(ang - 0.4));
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - ah * Math.cos(ang + 0.4), ey - ah * Math.sin(ang + 0.4));
          ctx.stroke();
        }
      }
    }

    // 3) trajectories from 0 → t, plus the moving cloud at time t
    if (traj) {
      const F = traj.frames;
      const curF = Math.max(0, Math.min(F, Math.round(t * F)));
      const k = traj.labels.length;
      if (showTraj && curF > 0) {
        ctx.lineWidth = 1;
        for (let i = 0; i < k; i++) {
          const col = colorOf(traj.labels[i]);
          ctx.strokeStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.22)`;
          ctx.beginPath();
          for (let f = 0; f <= curF; f++) {
            const fr = traj.plane[f];
            const px = toPx(fr[i * 2]);
            const py = toPy(fr[i * 2 + 1]);
            if (f === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }
      // moving points at time t
      const fr = traj.plane[curF];
      for (let i = 0; i < k; i++) {
        const col = colorOf(traj.labels[i]);
        const px = toPx(fr[i * 2]);
        const py = toPy(fr[i * 2 + 1]);
        ctx.fillStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.95)`;
        ctx.beginPath();
        ctx.arc(px, py, 2.1, 0, 2 * Math.PI);
        ctx.fill();
      }
    } else if (pts) {
      // no model yet — just scatter the raw data
      for (let i = 0; i < pts.labels.length; i++) {
        const col = colorOf(pts.labels[i]);
        ctx.fillStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.85)`;
        ctx.beginPath();
        ctx.arc(toPx(pts.xy[i * 2]), toPy(pts.xy[i * 2 + 1]), 2, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    // time read-out
    ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
    ctx.font = '12px ui-monospace, monospace';
    ctx.fillText(`t = ${t.toFixed(2)}`, 10, 18);
  }, [view, classes, res, trajCount, tick, t, showField, showVectors, showTraj, decisionField, sampleTrajectories, vectorField, dataPoints, size]);

  return <canvas ref={ref} className="flow-canvas" />;
}
