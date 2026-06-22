import { useEffect, useRef } from 'react';
import type { RLHandle, DemoInfo } from '../../hooks/useRLTrainer';
import { Pendulum, PENDULUM_LIMITS } from '../../engine/rl-env';

interface Props {
  handle: RLHandle;
  tick: number;
  demoInfo: () => DemoInfo;
}

// The learned continuous policy as a torque landscape: sweep the pole angle θ (x-axis, 0 = upright)
// and angular velocity θ̇ (y-axis) and colour each point by the Gaussian *mean* torque the policy
// would apply there — blue for a hard left torque, red for a hard right one. A solved swing-up
// policy shows the characteristic energy-pumping pinwheel: torque with the spin to pump energy in
// while hanging, then brake near the top. The live state is overlaid as a moving dot.
const RES = 48;

export default function PendulumField({ handle, tick, demoInfo }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const agent = handle.agent;
    const env = handle.env;
    if (!canvas || !agent || !env || env.kind !== 'pendulum') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(RES, RES);
    const maxT = PENDULUM_LIMITS.maxTorque;

    for (let iy = 0; iy < RES; iy++) {
      const thetaDot = PENDULUM_LIMITS.maxSpeed - (iy / (RES - 1)) * 2 * PENDULUM_LIMITS.maxSpeed;
      for (let ix = 0; ix < RES; ix++) {
        const theta = -Math.PI + (ix / (RES - 1)) * 2 * Math.PI;
        const obs = Float64Array.from([Math.cos(theta), Math.sin(theta), thetaDot / PENDULUM_LIMITS.maxSpeed]);
        const u = Math.max(-maxT, Math.min(maxT, agent.actionMean(obs)[0]));
        const t = u / maxT; // [-1, 1]
        const off = (iy * RES + ix) * 4;
        const [r, g, b] = t > 0 ? mix([15, 23, 42], [248, 113, 113], t) : mix([15, 23, 42], [56, 189, 248], -t);
        img.data[off] = r;
        img.data[off + 1] = g;
        img.data[off + 2] = b;
        img.data[off + 3] = 255;
      }
    }
    const off = document.createElement('canvas');
    off.width = RES;
    off.height = RES;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

    // Overlay the live state.
    const [theta, thetaDot] = (env as Pendulum).state;
    const wrapped = ((theta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const px = ((wrapped + Math.PI) / (2 * Math.PI)) * canvas.width;
    const py = ((PENDULUM_LIMITS.maxSpeed - thetaDot) / (2 * PENDULUM_LIMITS.maxSpeed)) * canvas.height;
    if (px >= 0 && px <= canvas.width && py >= 0 && py <= canvas.height) {
      ctx.fillStyle = '#fde68a';
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Upright marker line at θ = 0.
    ctx.strokeStyle = 'rgba(226,232,240,0.25)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(canvas.width / 2, 0);
    ctx.lineTo(canvas.width / 2, canvas.height);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(226,232,240,0.7)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('angle θ (0 = up) →', canvas.width / 2, canvas.height - 5);
    ctx.save();
    ctx.translate(11, canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('angular vel →', 0, 0);
    ctx.restore();
  }, [tick, handle]);

  void demoInfo;
  return (
    <div className="phase-portrait">
      <canvas ref={canvasRef} width={300} height={300} className="phase-canvas" />
      <div className="value-legend">
        <span className="muted small">torque −</span>
        <span className="pend-ramp" />
        <span className="muted small">torque +</span>
      </div>
    </div>
  );
}

function mix(a: number[], b: number[], t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * x),
    Math.round(a[1] + (b[1] - a[1]) * x),
    Math.round(a[2] + (b[2] - a[2]) * x),
  ];
}
