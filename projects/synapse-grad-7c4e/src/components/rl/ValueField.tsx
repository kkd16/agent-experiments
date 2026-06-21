import { useEffect, useRef } from 'react';
import type { RLHandle } from '../../hooks/useRLTrainer';
import { GridWorld } from '../../engine/rl-env';
import { argmax } from '../../engine/policy';

interface Props {
  handle: RLHandle;
  tick: number;
}

// The iconic RL picture for a gridworld: the critic's learned value V(s) painted as a heatmap over
// every cell, with the greedy policy drawn as an arrow in each cell. Watch value flood backward
// from the goal and the arrows organise into a coherent path while pits stay cold.
const ARROWS = ['↑', '→', '↓', '←'];

export default function ValueField({ handle, tick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const agent = handle.agent;
    const env = handle.env;
    if (!canvas || !agent || !env || env.kind !== 'gridworld') return;
    const grid = env as GridWorld;
    const { w, h, cells } = grid.layout;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Evaluate value + greedy action over every cell.
    const values = new Float64Array(w * h);
    const greedy = new Int32Array(w * h);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < w * h; k++) {
      if (cells[k] === 'wall') {
        values[k] = NaN;
        continue;
      }
      const obs = grid.observeCell(k);
      const v = agent.valueOf(obs);
      values[k] = v;
      greedy[k] = argmax(agent.actionProbs(obs));
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo < 1e-6 ? 1 : hi - lo;

    const cell = Math.min(canvas.width / w, canvas.height / h);
    const ox = (canvas.width - cell * w) / 2;
    const oy = (canvas.height - cell * h) / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

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
        const t = (values[k] - lo) / span;
        ctx.fillStyle = valueColor(t);
        ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        // Greedy-policy arrow (skip terminal cells).
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
  }, [tick, handle]);

  return (
    <div className="value-field">
      <canvas ref={canvasRef} width={300} height={300} className="value-canvas" />
      <div className="value-legend">
        <span className="muted small">low V</span>
        <span className="value-ramp" />
        <span className="muted small">high V</span>
      </div>
    </div>
  );
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
      const r = Math.round(ca[0] + (cb[0] - ca[0]) * f);
      const g = Math.round(ca[1] + (cb[1] - ca[1]) * f);
      const bl = Math.round(ca[2] + (cb[2] - ca[2]) * f);
      return `rgb(${r},${g},${bl})`;
    }
  }
  return 'rgb(250,204,21)';
}
