import { useEffect, useRef } from 'react';
import type { RLHandle } from '../../hooks/useRLTrainer';
import { MountainCar, MOUNTAINCAR_LIMITS } from '../../engine/rl-env';
import { argmax } from '../../engine/policy';

interface Props {
  handle: RLHandle;
  tick: number;
}

// The learned MountainCar policy as a phase portrait over position (x-axis) × velocity (y-axis):
// each point is tinted by the greedy action (push-left / coast / push-right) and shaded by the
// critic's value. A solved policy shows the tell-tale "push with your velocity" structure — accel
// right when moving right, left when moving left — that pumps the car up the hill. The live state
// is overlaid as a moving dot, and the goal line at x = 0.5 is marked.
const RES = 48;
const ACTION_RGB: [number, number, number][] = [
  [244, 114, 182], // ← left  (pink)
  [148, 163, 184], // — coast (slate)
  [56, 189, 248], // → right (sky)
];

export default function MountainCarField({ handle, tick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const agent = handle.agent;
    const env = handle.env;
    if (!canvas || !agent || !env || env.kind !== 'mountaincar') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { minPos, maxPos, maxSpeed, goalPos } = MOUNTAINCAR_LIMITS;
    const img = ctx.createImageData(RES, RES);

    // First pass: value range for shading.
    let lo = Infinity;
    let hi = -Infinity;
    const vals = new Float64Array(RES * RES);
    const acts = new Int32Array(RES * RES);
    for (let iy = 0; iy < RES; iy++) {
      const vel = maxSpeed - (iy / (RES - 1)) * 2 * maxSpeed;
      for (let ix = 0; ix < RES; ix++) {
        const pos = minPos + (ix / (RES - 1)) * (maxPos - minPos);
        const obs = Float64Array.from([(pos + 0.3) / 0.9, vel / maxSpeed]);
        const v = agent.valueOf(obs);
        vals[iy * RES + ix] = v;
        acts[iy * RES + ix] = argmax(agent.actionProbs(obs));
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const span = hi - lo < 1e-6 ? 1 : hi - lo;
    for (let k = 0; k < RES * RES; k++) {
      const shade = 0.4 + 0.6 * ((vals[k] - lo) / span); // brighter = higher value
      const [r, g, b] = ACTION_RGB[acts[k]];
      const off = k * 4;
      img.data[off] = Math.round(r * shade);
      img.data[off + 1] = Math.round(g * shade);
      img.data[off + 2] = Math.round(b * shade);
      img.data[off + 3] = 255;
    }
    const offc = document.createElement('canvas');
    offc.width = RES;
    offc.height = RES;
    offc.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(offc, 0, 0, canvas.width, canvas.height);

    // Goal line.
    const gx = ((goalPos - minPos) / (maxPos - minPos)) * canvas.width;
    ctx.strokeStyle = 'rgba(74,222,128,0.7)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, canvas.height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Live state.
    const [pos, vel] = (env as MountainCar).state;
    const px = ((pos - minPos) / (maxPos - minPos)) * canvas.width;
    const py = ((maxSpeed - vel) / (2 * maxSpeed)) * canvas.height;
    ctx.fillStyle = '#fde68a';
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(226,232,240,0.7)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('position →  (★ goal)', canvas.width / 2, canvas.height - 5);
    ctx.save();
    ctx.translate(11, canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('velocity →', 0, 0);
    ctx.restore();
  }, [tick, handle]);

  return (
    <div className="phase-portrait">
      <canvas ref={canvasRef} width={300} height={300} className="phase-canvas" />
      <div className="value-legend">
        <span className="muted small" style={{ color: '#f472b6' }}>← left</span>
        <span className="muted small" style={{ color: '#94a3b8' }}>coast</span>
        <span className="muted small" style={{ color: '#38bdf8' }}>right →</span>
      </div>
    </div>
  );
}
