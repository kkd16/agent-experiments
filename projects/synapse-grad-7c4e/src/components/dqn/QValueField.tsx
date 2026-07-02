import { useEffect, useMemo, useRef } from 'react';
import type { DQNHandle } from '../../hooks/useDQNTrainer';
import {
  GridWorld,
  CartPole,
  MountainCar,
  makeEnv,
  CARTPOLE_LIMITS,
  MOUNTAINCAR_LIMITS,
} from '../../engine/rl-env';
import { qForward } from '../../engine/dqn';

interface Props {
  handle: DQNHandle;
  tick: number;
}

const ARROWS = ['↑', '→', '↓', '←'];

// The headline value picture. For GridWorld: the learned state-value V(s) = max_a Q(s,a) painted
// as a heatmap over every cell with the greedy action drawn as an arrow — value floods backward
// from the ★ goal and the arrows organise into a path, exactly the picture value iteration draws,
// here learned by a neural net from one-hot states. For the continuous envs: max_a Q over a 2-D
// slice of state space (CartPole: pole angle × angular velocity; MountainCar: position × velocity)
// with the live state marked, so you watch the value landscape the agent is climbing.
export default function QValueField({ handle, tick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const kind = handle.kind;

  // A scratch env used only to produce correctly-scaled observations for the continuous slices
  // (so we never mutate the animated demo env).
  const scratch = useMemo(
    () => (kind !== 'gridworld' ? makeEnv(kind, handle.gridLayoutId, () => 0.5, 0.99) : null),
    [kind, handle.gridLayoutId],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const agent = handle.agent;
    const env = handle.env;
    if (!canvas || !agent || !env) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (env.kind === 'gridworld') drawGridField(ctx, agent, env as GridWorld, canvas.width, canvas.height);
    else if (env.kind === 'cartpole') drawCartPoleField(ctx, agent, env as CartPole, scratch as CartPole, canvas.width, canvas.height);
    else drawMountainCarField(ctx, agent, env as MountainCar, scratch as MountainCar, canvas.width, canvas.height);
  }, [tick, handle, scratch]);

  const legend =
    kind === 'gridworld'
      ? 'V(s) = max_a Q(s,a) per cell, greedy action arrowed'
      : kind === 'cartpole'
        ? 'max_a Q over pole angle × angular velocity'
        : 'max_a Q over position × velocity';

  return (
    <div className="value-field">
      <canvas ref={canvasRef} width={300} height={300} className="value-canvas" />
      <div className="value-legend">
        <span className="muted small">low</span>
        <span className="value-ramp" />
        <span className="muted small">high · {legend}</span>
      </div>
    </div>
  );
}

function drawGridField(ctx: CanvasRenderingContext2D, agent: DQNHandle['agent'], grid: GridWorld, CW: number, CH: number) {
  if (!agent) return;
  const { w, h, cells } = grid.layout;
  const value = new Float64Array(w * h);
  const greedy = new Int32Array(w * h);
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < w * h; k++) {
    if (cells[k] === 'wall') {
      value[k] = NaN;
      continue;
    }
    const q = qForward(agent.online, grid.observeCell(k));
    let best = 0;
    let bv = q[0];
    for (let a = 1; a < q.length; a++)
      if (q[a] > bv) {
        bv = q[a];
        best = a;
      }
    value[k] = bv;
    greedy[k] = best;
    if (cells[k] !== 'goal' && cells[k] !== 'pit') {
      if (bv < lo) lo = bv;
      if (bv > hi) hi = bv;
    }
  }
  const span = hi - lo < 1e-6 ? 1 : hi - lo;
  const cell = Math.min(CW / w, CH / h);
  const ox = (CW - cell * w) / 2;
  const oy = (CH - cell * h) / 2;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const k = r * w + c;
      const x = ox + c * cell;
      const y = oy + r * cell;
      if (cells[k] === 'wall') {
        ctx.fillStyle = '#334155';
        ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        continue;
      }
      const t = (value[k] - lo) / span;
      ctx.fillStyle = valueColor(t);
      ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      if (cells[k] !== 'goal' && cells[k] !== 'pit') {
        ctx.fillStyle = 'rgba(15,23,42,0.85)';
        ctx.font = `${Math.floor(cell * 0.5)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ARROWS[greedy[k]], x + cell / 2, y + cell / 2 + 1);
      } else {
        ctx.fillStyle = cells[k] === 'goal' ? '#052e16' : '#4c0519';
        ctx.font = `${Math.floor(cell * 0.45)}px system-ui`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(cells[k] === 'goal' ? '★' : '✖', x + cell / 2, y + cell / 2 + 1);
      }
    }
  }
}

// Sample max_a Q over a 2-D grid using the scratch env for correctly-scaled observations.
function drawSliceField(
  ctx: CanvasRenderingContext2D,
  agent: NonNullable<DQNHandle['agent']>,
  scratch: { state: Float64Array; observe: () => Float64Array },
  setState: (i: number, j: number) => void,
  dotXY: [number, number] | null,
  CW: number,
  CH: number,
) {
  const N = 48;
  const vals = new Float64Array(N * N);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      setState(i / (N - 1), j / (N - 1));
      const q = qForward(agent.online, scratch.observe());
      let m = q[0];
      for (let a = 1; a < q.length; a++) if (q[a] > m) m = q[a];
      vals[j * N + i] = m;
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
  }
  const span = hi - lo < 1e-6 ? 1 : hi - lo;
  const cw = CW / N;
  const ch = CH / N;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      ctx.fillStyle = valueColor((vals[j * N + i] - lo) / span);
      ctx.fillRect(i * cw, (N - 1 - j) * ch, cw + 1, ch + 1);
    }
  }
  if (dotXY) {
    const [fx, fy] = dotXY;
    const px = fx * CW;
    const py = (1 - fy) * CH;
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawCartPoleField(
  ctx: CanvasRenderingContext2D,
  agent: NonNullable<DQNHandle['agent']>,
  env: CartPole,
  scratch: CartPole,
  CW: number,
  CH: number,
) {
  const thMax = CARTPOLE_LIMITS.theta;
  const tdMax = 2.5;
  const setState = (i: number, j: number) => {
    scratch.state[0] = 0;
    scratch.state[1] = 0;
    scratch.state[2] = (i * 2 - 1) * thMax * 1.15; // angle across x
    scratch.state[3] = (j * 2 - 1) * tdMax; // angular velocity across y
  };
  const th = env.state[2];
  const td = env.state[3];
  const dot: [number, number] = [
    Math.max(0, Math.min(1, (th / (thMax * 1.15) + 1) / 2)),
    Math.max(0, Math.min(1, (td / tdMax + 1) / 2)),
  ];
  drawSliceField(ctx, agent, scratch, setState, dot, CW, CH);
  axisLabels(ctx, 'pole angle →', '↑ angular vel', CH);
}

function drawMountainCarField(
  ctx: CanvasRenderingContext2D,
  agent: NonNullable<DQNHandle['agent']>,
  env: MountainCar,
  scratch: MountainCar,
  CW: number,
  CH: number,
) {
  const { minPos, maxPos, maxSpeed } = MOUNTAINCAR_LIMITS;
  const setState = (i: number, j: number) => {
    scratch.state[0] = minPos + i * (maxPos - minPos);
    scratch.state[1] = (j * 2 - 1) * maxSpeed;
  };
  const dot: [number, number] = [
    Math.max(0, Math.min(1, (env.state[0] - minPos) / (maxPos - minPos))),
    Math.max(0, Math.min(1, (env.state[1] / maxSpeed + 1) / 2)),
  ];
  drawSliceField(ctx, agent, scratch, setState, dot, CW, CH);
  axisLabels(ctx, 'position →', '↑ velocity', CH);
}

function axisLabels(ctx: CanvasRenderingContext2D, xlab: string, ylab: string, CH: number) {
  ctx.fillStyle = 'rgba(226,232,240,0.85)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(xlab, 6, CH - 5);
  ctx.save();
  ctx.translate(12, CH - 6);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(ylab, 0, 0);
  ctx.restore();
}

// Cold (low value) → warm (high value): deep blue → teal → green → amber.
function valueColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  const stops: [number, [number, number, number]][] = [
    [0, [15, 23, 42]],
    [0.4, [14, 116, 144]],
    [0.7, [34, 197, 94]],
    [1, [250, 204, 21]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (x >= a && x <= b) {
      const f = (x - a) / (b - a);
      return `rgb(${Math.round(ca[0] + (cb[0] - ca[0]) * f)},${Math.round(ca[1] + (cb[1] - ca[1]) * f)},${Math.round(
        ca[2] + (cb[2] - ca[2]) * f,
      )})`;
    }
  }
  return 'rgb(250,204,21)';
}
