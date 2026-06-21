import { useEffect, useRef } from 'react';
import type { RLHandle, DemoInfo } from '../../hooks/useRLTrainer';
import { CartPole, CARTPOLE_LIMITS } from '../../engine/rl-env';

interface Props {
  handle: RLHandle;
  tick: number;
  demoInfo: () => DemoInfo;
}

// The learned CartPole policy as a landscape: sweep the pole angle (x-axis) and angular velocity
// (y-axis) with the cart centred and still, and colour each point by the probability of pushing
// *right*. A good policy shows a clean diagonal decision surface — push right when the pole leans
// or falls right, left when it leans left — and the live state is overlaid as a moving dot.
const RES = 40;
const THETA_RANGE = CARTPOLE_LIMITS.theta * 1.1;
const THETADOT_RANGE = 2.5;

export default function PhasePortrait({ handle, tick, demoInfo }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const agent = handle.agent;
    const env = handle.env;
    if (!canvas || !agent || !env || env.kind !== 'cartpole') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(RES, RES);

    for (let iy = 0; iy < RES; iy++) {
      // top = +thetadot
      const thetaDot = THETADOT_RANGE - (iy / (RES - 1)) * 2 * THETADOT_RANGE;
      for (let ix = 0; ix < RES; ix++) {
        const theta = -THETA_RANGE + (ix / (RES - 1)) * 2 * THETA_RANGE;
        const obs = Float64Array.from([0, 0, theta / CARTPOLE_LIMITS.theta, thetaDot / 3]);
        const probs = agent.actionProbs(obs);
        const pRight = probs[1];
        // pink (push left) → dark → sky (push right)
        const off = (iy * RES + ix) * 4;
        const [r, g, b] = pRight > 0.5 ? mix([15, 23, 42], [56, 189, 248], (pRight - 0.5) * 2) : mix([15, 23, 42], [244, 114, 182], (0.5 - pRight) * 2);
        img.data[off] = r;
        img.data[off + 1] = g;
        img.data[off + 2] = b;
        img.data[off + 3] = 255;
      }
    }
    // Upscale the small field crisply onto the canvas.
    const off = document.createElement('canvas');
    off.width = RES;
    off.height = RES;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

    // Overlay the live state.
    const info = demoInfo();
    if (info && env.kind === 'cartpole') {
      const [, , theta, thetaDot] = (env as CartPole).state;
      const px = ((theta + THETA_RANGE) / (2 * THETA_RANGE)) * canvas.width;
      const py = ((THETADOT_RANGE - thetaDot) / (2 * THETADOT_RANGE)) * canvas.height;
      if (px >= 0 && px <= canvas.width && py >= 0 && py <= canvas.height) {
        ctx.fillStyle = '#fde68a';
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Axes labels.
    ctx.fillStyle = 'rgba(226,232,240,0.7)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('angle θ →', canvas.width / 2, canvas.height - 5);
    ctx.save();
    ctx.translate(11, canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('angular vel →', 0, 0);
    ctx.restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, handle]);

  return (
    <div className="phase-portrait">
      <canvas ref={canvasRef} width={300} height={300} className="phase-canvas" />
      <div className="value-legend">
        <span className="muted small">push left</span>
        <span className="phase-ramp" />
        <span className="muted small">push right</span>
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
