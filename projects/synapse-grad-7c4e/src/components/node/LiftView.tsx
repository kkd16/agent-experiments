import { useEffect, useRef } from 'react';
import { CLASS_COLORS } from '../../lib/colors';
import { VIZ_FRAMES } from './FlowField';

interface Props {
  view: number;
  tick: number;
  t: number;
  trajCount: number;
  augDim: number;
  sampleTrajectories: (
    count: number,
    frames: number,
  ) => { plane: Float64Array[]; aug: Float64Array[] | null; labels: Int32Array; frames: number } | null;
  size?: number;
}

// The "lift" view — the geometric reason Augmented Neural ODEs work. A 2-D ODE flow is a
// homeomorphism of the plane, so trajectories can never cross; that makes some datasets
// (concentric rings) impossible to pull apart with a linear readout. Augmentation adds extra
// state channels the flow can move through. Here we plot each point's trajectory in the
// (plane-x, first-augment-channel) plane: points start on the line a=0 and *lift off* into the
// added dimension to route around each other. With augDim=0 there is nothing to show.
export default function LiftView({ view, tick, t, trajCount, augDim, sampleTrajectories, size = 220 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef<{ tick: number; traj: ReturnType<Props['sampleTrajectories']> } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = size * 1.4;
    const H = size;
    canvas.width = W;
    canvas.height = H;
    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, W, H);

    if (augDim <= 0) {
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.font = '12px ui-sans-serif, system-ui';
      ctx.fillText('Augment dim = 0 — the flow is confined to the plane.', 12, H / 2 - 6);
      ctx.fillText('Raise “augment” to watch points lift into the extra axis.', 12, H / 2 + 12);
      return;
    }

    if (!cacheRef.current || cacheRef.current.tick !== tick) {
      cacheRef.current = { tick, traj: sampleTrajectories(trajCount, VIZ_FRAMES) };
    }
    const traj = cacheRef.current.traj;
    if (!traj || !traj.aug) return;

    // autoscale the augment axis to its full range across all frames
    let amax = 1e-6;
    for (const fr of traj.aug) for (let i = 1; i < fr.length; i += 2) amax = Math.max(amax, Math.abs(fr[i]));
    amax *= 1.15;

    const pad = 22;
    const toPx = (x: number) => pad + ((x + view) / (2 * view)) * (W - 2 * pad);
    const toPy = (a: number) => H / 2 - (a / amax) * (H / 2 - pad);

    // a = 0 plane (where every point starts)
    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(148,163,184,0.7)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('a = 0  (the plane)', 8, H / 2 - 5);

    const F = traj.frames;
    const curF = Math.max(0, Math.min(F, Math.round(t * F)));
    const k = traj.labels.length;
    const colorOf = (c: number) => CLASS_COLORS[c % CLASS_COLORS.length];

    ctx.lineWidth = 1;
    for (let i = 0; i < k; i++) {
      const col = colorOf(traj.labels[i]);
      ctx.strokeStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.2)`;
      ctx.beginPath();
      for (let f = 0; f <= curF; f++) {
        const fr = traj.aug[f];
        const px = toPx(fr[i * 2]);
        const py = toPy(fr[i * 2 + 1]);
        if (f === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    const fr = traj.aug[curF];
    for (let i = 0; i < k; i++) {
      const col = colorOf(traj.labels[i]);
      ctx.fillStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.95)`;
      ctx.beginPath();
      ctx.arc(toPx(fr[i * 2]), toPy(fr[i * 2 + 1]), 1.9, 0, 2 * Math.PI);
      ctx.fill();
    }
  }, [view, tick, t, trajCount, augDim, sampleTrajectories, size]);

  return <canvas ref={ref} className="lift-canvas" />;
}
