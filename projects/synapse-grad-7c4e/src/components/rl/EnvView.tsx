import { useEffect, useRef } from 'react';
import type { RLHandle, DemoInfo } from '../../hooks/useRLTrainer';
import { CartPole, GridWorld, CARTPOLE_LIMITS, type Cell } from '../../engine/rl-env';

interface Props {
  handle: RLHandle;
  tick: number;
  demoInfo: () => DemoInfo;
  greedy: boolean;
}

const CELL_FILL: Record<Cell, string> = {
  empty: '#0b1220',
  wall: '#334155',
  pit: 'rgba(244,114,182,0.30)',
  goal: 'rgba(74,222,128,0.28)',
  start: 'rgba(56,189,248,0.14)',
};

// The headline live view: the current policy acting in its environment, animated frame by frame.
// CartPole renders the cart-on-track with its hinged pole; GridWorld renders the maze with the
// agent, goal and pits. Both update every frame regardless of whether training is running, so you
// can pause and keep watching the policy you've trained.
export default function EnvView({ handle, tick, demoInfo, greedy }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const env = handle.env;
    if (!canvas || !env) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, W, H);

    if (env.kind === 'cartpole') {
      drawCartPole(ctx, env as CartPole, W, H);
    } else {
      drawGrid(ctx, env as GridWorld, W, H);
    }
  }, [tick, handle]);

  const info = demoInfo();
  const isCart = handle.kind === 'cartpole';

  return (
    <div className="env-view">
      <canvas ref={canvasRef} width={480} height={300} className="env-canvas" />
      <div className="env-foot">
        <span className="muted small">
          {greedy ? 'greedy' : 'sampling'} · episode {Number.isFinite(info.episodeCount) ? info.episodeCount : 0}
        </span>
        <span className="env-stat">
          this episode <b>{info.episodeSteps}</b> {isCart ? 'steps' : 'moves'} · return{' '}
          <b>{info.episodeReturn.toFixed(isCart ? 0 : 2)}</b>
        </span>
        <span className="muted small">
          last <b>{Number.isFinite(info.lastEpisodeReturn) ? info.lastEpisodeReturn.toFixed(isCart ? 0 : 2) : '—'}</b>
        </span>
      </div>
    </div>
  );
}

function drawCartPole(ctx: CanvasRenderingContext2D, env: CartPole, W: number, H: number) {
  const [x, , theta] = env.state;
  const margin = 50;
  const trackY = H * 0.72;
  const scale = (W - 2 * margin) / (2 * CARTPOLE_LIMITS.x);
  const cx = W / 2 + x * scale;

  // Track + limit posts.
  ctx.strokeStyle = 'rgba(148,163,184,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(margin, trackY);
  ctx.lineTo(W - margin, trackY);
  ctx.stroke();
  ctx.fillStyle = 'rgba(244,114,182,0.5)';
  for (const sx of [W / 2 - CARTPOLE_LIMITS.x * scale, W / 2 + CARTPOLE_LIMITS.x * scale]) {
    ctx.fillRect(sx - 1.5, trackY - 14, 3, 28);
  }

  // Cart.
  const cartW = 60;
  const cartH = 26;
  ctx.fillStyle = '#38bdf8';
  roundRect(ctx, cx - cartW / 2, trackY - cartH / 2, cartW, cartH, 5);
  ctx.fill();
  // Wheels.
  ctx.fillStyle = '#0b1220';
  ctx.beginPath();
  ctx.arc(cx - cartW / 2 + 12, trackY + cartH / 2, 5, 0, Math.PI * 2);
  ctx.arc(cx + cartW / 2 - 12, trackY + cartH / 2, 5, 0, Math.PI * 2);
  ctx.fill();

  // Pole.
  const poleLen = H * 0.42;
  const px = cx;
  const py = trackY - cartH / 2;
  const ex = px + poleLen * Math.sin(theta);
  const ey = py - poleLen * Math.cos(theta);
  ctx.strokeStyle = '#a78bfa';
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  // Pivot + bob.
  ctx.fillStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.arc(px, py, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#c4b5fd';
  ctx.beginPath();
  ctx.arc(ex, ey, 7, 0, Math.PI * 2);
  ctx.fill();

  // Angle readout.
  const deg = (theta * 180) / Math.PI;
  ctx.fillStyle = Math.abs(deg) > 8 ? '#fb7185' : 'rgba(148,163,184,0.8)';
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillText(`θ ${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°`, 12, 20);
  ctx.fillText(`x ${x >= 0 ? '+' : ''}${x.toFixed(2)}`, 12, 36);
}

function drawGrid(ctx: CanvasRenderingContext2D, env: GridWorld, W: number, H: number) {
  const { w, h, cells } = env.layout;
  const pad = 8;
  const cell = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
  const ox = (W - cell * w) / 2;
  const oy = (H - cell * h) / 2;

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const k = r * w + c;
      ctx.fillStyle = CELL_FILL[cells[k]];
      ctx.fillRect(ox + c * cell + 1, oy + r * cell + 1, cell - 2, cell - 2);
      if (cells[k] === 'goal') {
        ctx.fillStyle = '#4ade80';
        ctx.font = `${Math.floor(cell * 0.5)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', ox + c * cell + cell / 2, oy + r * cell + cell / 2 + 1);
      } else if (cells[k] === 'pit') {
        ctx.fillStyle = '#fb7185';
        ctx.font = `${Math.floor(cell * 0.42)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('✖', ox + c * cell + cell / 2, oy + r * cell + cell / 2 + 1);
      }
    }
  }

  // Agent.
  const ar = Math.floor(env.pos / w);
  const ac = env.pos % w;
  const acx = ox + ac * cell + cell / 2;
  const acy = oy + ar * cell + cell / 2;
  const grad = ctx.createRadialGradient(acx, acy, 1, acx, acy, cell * 0.45);
  grad.addColorStop(0, '#7dd3fc');
  grad.addColorStop(1, 'rgba(56,189,248,0.05)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(acx, acy, cell * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e0f2fe';
  ctx.beginPath();
  ctx.arc(acx, acy, cell * 0.2, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
