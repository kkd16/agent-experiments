import { useEffect, useRef } from 'react';
import type { DQNHandle, DQNDemoInfo } from '../../hooks/useDQNTrainer';
import {
  CartPole,
  GridWorld,
  MountainCar,
  CARTPOLE_LIMITS,
  MOUNTAINCAR_LIMITS,
  type Cell,
} from '../../engine/rl-env';

interface Props {
  handle: DQNHandle;
  tick: number;
  demoInfo: () => DQNDemoInfo;
}

const CELL_FILL: Record<Cell, string> = {
  empty: '#0b1220',
  wall: '#334155',
  pit: 'rgba(244,114,182,0.30)',
  goal: 'rgba(74,222,128,0.28)',
  start: 'rgba(56,189,248,0.14)',
};

// The live greedy agent acting in its environment, animated frame-by-frame — the current
// argmax_a Q(s,a) policy, running whether or not training is on so you can pause and keep watching.
export default function EnvView({ handle, tick, demoInfo }: Props) {
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
    if (env.kind === 'cartpole') drawCartPole(ctx, env as CartPole, W, H);
    else if (env.kind === 'mountaincar') drawMountainCar(ctx, env as MountainCar, demoInfo(), W, H);
    else drawGrid(ctx, env as GridWorld, W, H);
  }, [tick, handle, demoInfo]);

  const info = demoInfo();
  const kind = handle.kind;
  const dec = kind === 'gridworld' ? 2 : kind === 'mountaincar' ? 1 : 0;
  const unit = kind === 'gridworld' ? 'moves' : 'steps';

  return (
    <div className="env-view">
      <canvas ref={canvasRef} width={480} height={300} className="env-canvas" />
      <div className="env-foot">
        <span className="muted small">greedy · episode {Number.isFinite(info.episodeCount) ? info.episodeCount : 0}</span>
        <span className="env-stat">
          this episode <b>{info.episodeSteps}</b> {unit} · return <b>{info.episodeReturn.toFixed(dec)}</b>
        </span>
        <span className="muted small">
          last <b>{Number.isFinite(info.lastEpisodeReturn) ? info.lastEpisodeReturn.toFixed(dec) : '—'}</b>
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
  ctx.strokeStyle = 'rgba(148,163,184,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(margin, trackY);
  ctx.lineTo(W - margin, trackY);
  ctx.stroke();
  ctx.fillStyle = 'rgba(244,114,182,0.5)';
  for (const sx of [W / 2 - CARTPOLE_LIMITS.x * scale, W / 2 + CARTPOLE_LIMITS.x * scale]) ctx.fillRect(sx - 1.5, trackY - 14, 3, 28);
  const cartW = 60;
  const cartH = 26;
  ctx.fillStyle = '#38bdf8';
  roundRect(ctx, cx - cartW / 2, trackY - cartH / 2, cartW, cartH, 5);
  ctx.fill();
  ctx.fillStyle = '#0b1220';
  ctx.beginPath();
  ctx.arc(cx - cartW / 2 + 12, trackY + cartH / 2, 5, 0, Math.PI * 2);
  ctx.arc(cx + cartW / 2 - 12, trackY + cartH / 2, 5, 0, Math.PI * 2);
  ctx.fill();
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
  ctx.fillStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.arc(px, py, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#c4b5fd';
  ctx.beginPath();
  ctx.arc(ex, ey, 7, 0, Math.PI * 2);
  ctx.fill();
  const deg = (theta * 180) / Math.PI;
  ctx.fillStyle = Math.abs(deg) > 8 ? '#fb7185' : 'rgba(148,163,184,0.8)';
  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'left';
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

function drawMountainCar(ctx: CanvasRenderingContext2D, env: MountainCar, info: DQNDemoInfo, W: number, H: number) {
  const { minPos, maxPos, goalPos } = MOUNTAINCAR_LIMITS;
  const margin = 30;
  const plotW = W - 2 * margin;
  const toX = (p: number) => margin + ((p - minPos) / (maxPos - minPos)) * plotW;
  const baseY = H * 0.82;
  const hScale = H * 0.32;
  const toY = (p: number) => baseY - Math.sin(3 * p) * hScale;
  ctx.strokeStyle = 'rgba(148,163,184,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 120; i++) {
    const p = minPos + (i / 120) * (maxPos - minPos);
    const x = toX(p);
    const y = toY(p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.lineTo(toX(maxPos), H);
  ctx.lineTo(toX(minPos), H);
  ctx.closePath();
  ctx.fillStyle = 'rgba(30,41,59,0.6)';
  ctx.fill();
  const gx = toX(goalPos);
  const gy = toY(goalPos);
  ctx.strokeStyle = 'rgba(74,222,128,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(gx, gy);
  ctx.lineTo(gx, gy - 28);
  ctx.stroke();
  ctx.fillStyle = '#4ade80';
  ctx.beginPath();
  ctx.moveTo(gx, gy - 28);
  ctx.lineTo(gx + 16, gy - 23);
  ctx.lineTo(gx, gy - 18);
  ctx.closePath();
  ctx.fill();
  const [pos] = env.state;
  const carX = toX(pos);
  const carY = toY(pos);
  const slope = -Math.cos(3 * pos) * 3 * (hScale / plotW) * (maxPos - minPos);
  const ang = Math.atan(slope);
  ctx.save();
  ctx.translate(carX, carY - 6);
  ctx.rotate(ang);
  ctx.fillStyle = '#38bdf8';
  roundRect(ctx, -14, -8, 28, 12, 4);
  ctx.fill();
  ctx.fillStyle = '#0b1220';
  ctx.beginPath();
  ctx.arc(-8, 5, 3.5, 0, Math.PI * 2);
  ctx.arc(8, 5, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(148,163,184,0.85)';
  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`x ${pos.toFixed(2)}  v ${env.state[1].toFixed(3)}`, 12, 20);
  const aLbl = info.q ? ['← left', '— coast', '→ right'][info.action] : '';
  if (aLbl) ctx.fillText(`greedy ${aLbl}`, 12, 36);
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
