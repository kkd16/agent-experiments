import { useEffect, useMemo, useRef, useState } from 'react';
import type { DQNHandle } from '../../hooks/useDQNTrainer';
import { GridWorld } from '../../engine/rl-env';
import { qForward, tabularQStar } from '../../engine/dqn';

interface Props {
  handle: DQNHandle;
  tick: number;
  gamma: number;
}

// The rigor headline. GridWorld is a finite, deterministic MDP, so a from-scratch value-iteration
// solver gives the EXACT optimal Q*(s,a). This view scatters the neural DQN's learned Q against
// that ground truth — every point (Q*, Q_learned) should collapse onto the y = x line as the net
// converges — beside a per-cell grid coloured by whether the learned greedy action matches the
// optimal one, and the single-figure mean |Q − Q*| and policy-match read-outs.
export default function GroundTruthView({ handle, tick, gamma }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement>(null);

  const star = useMemo(() => {
    const env = handle.env;
    if (!env || env.kind !== 'gridworld') return null;
    return tabularQStar((env as GridWorld).layout, gamma);
  }, [handle.env, gamma]);

  const [stats, setStats] = useState({ err: NaN, match: NaN, cells: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const gcanvas = gridCanvasRef.current;
    const agent = handle.agent;
    const env = handle.env;
    if (!canvas || !gcanvas || !agent || !env || env.kind !== 'gridworld' || !star) return;
    const grid = env as GridWorld;
    const { w, h, cells } = grid.layout;

    // Collect (Q*, Q_learned) pairs and greedy-action agreement per non-terminal cell.
    const pts: [number, number][] = [];
    let errSum = 0;
    let count = 0;
    let matched = 0;
    let ncells = 0;
    let lo = Infinity;
    let hi = -Infinity;
    const agree = new Int8Array(w * h).fill(-1);
    for (let s = 0; s < w * h; s++) {
      const cell = cells[s];
      if (cell === 'wall' || cell === 'goal' || cell === 'pit') continue;
      const q = qForward(agent.online, grid.observeCell(s));
      let best = 0;
      let bv = q[0];
      let starMax = star.Q[s * 4];
      for (let a = 0; a < 4; a++) {
        const qs = star.Q[s * 4 + a];
        pts.push([qs, q[a]]);
        errSum += Math.abs(q[a] - qs);
        count++;
        lo = Math.min(lo, qs, q[a]);
        hi = Math.max(hi, qs, q[a]);
        if (q[a] > bv) {
          bv = q[a];
          best = a;
        }
        if (qs > starMax) starMax = qs;
      }
      // Co-optimal greedy action (ties the state's best Q*) counts as a policy match.
      const ok = star.Q[s * 4 + best] >= starMax - 1e-9;
      agree[s] = ok ? 1 : 0;
      if (ok) matched++;
      ncells++;
    }
    setStats({ err: count ? errSum / count : NaN, match: ncells ? matched / ncells : NaN, cells: ncells });

    // Scatter.
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(0, 0, W, H);
      const pad = 26;
      if (hi - lo < 1e-6) hi = lo + 1;
      const span = hi - lo;
      const toX = (v: number) => pad + ((v - lo) / span) * (W - pad - 8);
      const toY = (v: number) => H - pad - ((v - lo) / span) * (H - pad - 8);
      // y = x reference line.
      ctx.strokeStyle = 'rgba(74,222,128,0.6)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(toX(lo), toY(lo));
      ctx.lineTo(toX(hi), toY(hi));
      ctx.stroke();
      ctx.setLineDash([]);
      // Axes labels.
      ctx.fillStyle = 'rgba(148,163,184,0.85)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('Q* (value iteration) →', pad, H - 6);
      ctx.save();
      ctx.translate(12, H - pad);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('learned Q →', 0, 0);
      ctx.restore();
      // Points.
      ctx.fillStyle = 'rgba(56,189,248,0.75)';
      for (const [x, y] of pts) {
        ctx.beginPath();
        ctx.arc(toX(x), toY(y), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Policy-agreement grid.
    const gctx = gcanvas.getContext('2d');
    if (gctx) {
      const W = gcanvas.width;
      const H = gcanvas.height;
      gctx.clearRect(0, 0, W, H);
      gctx.fillStyle = '#05080f';
      gctx.fillRect(0, 0, W, H);
      const cell = Math.min(W / w, H / h);
      const ox = (W - cell * w) / 2;
      const oy = (H - cell * h) / 2;
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const k = r * w + c;
          const x = ox + c * cell;
          const y = oy + r * cell;
          const cur = cells[k];
          let fill = '#0b1220';
          if (cur === 'wall') fill = '#334155';
          else if (cur === 'goal') fill = 'rgba(74,222,128,0.5)';
          else if (cur === 'pit') fill = 'rgba(244,114,182,0.5)';
          else if (agree[k] === 1) fill = 'rgba(74,222,128,0.75)';
          else if (agree[k] === 0) fill = 'rgba(251,113,133,0.85)';
          gctx.fillStyle = fill;
          gctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        }
      }
    }
  }, [tick, handle, star]);

  if (!star) {
    return <p className="muted small">The Q vs Q* ground-truth comparison is only defined for GridWorld (a finite MDP).</p>;
  }

  const s = stats;
  return (
    <div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <canvas ref={canvasRef} width={240} height={240} className="value-canvas" />
        <div>
          <canvas ref={gridCanvasRef} width={180} height={180} className="value-canvas" />
          <div className="muted small" style={{ marginTop: 6 }}>
            <span style={{ color: '#4ade80' }}>■</span> optimal action &nbsp;
            <span style={{ color: '#fb7185' }}>■</span> suboptimal
          </div>
        </div>
      </div>
      <div className="stat-row" style={{ marginTop: 10 }}>
        <div className="stat">
          <span className="muted small">mean |Q − Q*|</span>
          <b>{Number.isFinite(s.err) ? s.err.toFixed(3) : '—'}</b>
        </div>
        <div className="stat">
          <span className="muted small">policy match</span>
          <b>{Number.isFinite(s.match) ? (s.match * 100).toFixed(0) + '%' : '—'}</b>
        </div>
        <div className="stat">
          <span className="muted small">cells</span>
          <b>{s.cells}</b>
        </div>
      </div>
    </div>
  );
}
