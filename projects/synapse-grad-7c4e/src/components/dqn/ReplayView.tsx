import { useEffect, useRef, useState } from 'react';
import type { DQNHandle } from '../../hooks/useDQNTrainer';

interface Props {
  handle: DQNHandle;
  tick: number;
  bufferFill: number;
}

// The experience replay buffer — DQN's off-policy engine. A fill bar shows how full the ring
// buffer is; the histogram bins the one-step rewards of every transition currently stored, so you
// can see the reward landscape the learner samples from (e.g. GridWorld: a wall of −stepCost with
// rare +1 goals and −1 pits). This is the data DQN reuses, decoupling learning from acting.
export default function ReplayView({ handle, tick, bufferFill }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [store, setStore] = useState({ size: 0, cap: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const agent = handle.agent;
    if (!canvas || !agent) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, W, H);

    const rewards = agent.replay.rewards();
    setStore({ size: agent.replay.size(), cap: agent.replay.capacity() });
    if (rewards.length === 0) return;

    // Histogram of one-step rewards.
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of rewards) {
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    if (hi - lo < 1e-6) {
      lo -= 0.5;
      hi += 0.5;
    }
    const BINS = 28;
    const bins = new Float64Array(BINS);
    for (const r of rewards) {
      let b = Math.floor(((r - lo) / (hi - lo)) * BINS);
      if (b < 0) b = 0;
      if (b >= BINS) b = BINS - 1;
      bins[b]++;
    }
    let maxCount = 0;
    for (const c of bins) maxCount = Math.max(maxCount, c);
    const pad = 6;
    const bw = (W - 2 * pad) / BINS;
    for (let i = 0; i < BINS; i++) {
      const bh = maxCount > 0 ? (bins[i] / maxCount) * (H - 22) : 0;
      const binLo = lo + (i / BINS) * (hi - lo);
      ctx.fillStyle = binLo >= 0.5 ? '#4ade80' : binLo <= -0.5 ? '#fb7185' : 'rgba(56,189,248,0.7)';
      ctx.fillRect(pad + i * bw, H - 16 - bh, Math.max(1, bw - 1), bh);
    }
    // Zero tick.
    if (lo < 0 && hi > 0) {
      const zx = pad + ((0 - lo) / (hi - lo)) * (W - 2 * pad);
      ctx.strokeStyle = 'rgba(148,163,184,0.5)';
      ctx.beginPath();
      ctx.moveTo(zx, 2);
      ctx.lineTo(zx, H - 16);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(148,163,184,0.85)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(lo.toFixed(2), pad, H - 4);
    ctx.textAlign = 'right';
    ctx.fillText(hi.toFixed(2), W - pad, H - 4);
    ctx.textAlign = 'center';
    ctx.fillText('one-step reward', W / 2, H - 4);
  }, [tick, handle, bufferFill]);

  return (
    <div>
      <div className="replay-bar" style={{ position: 'relative', height: 12, background: '#0b1220', borderRadius: 6, overflow: 'hidden', marginBottom: 8 }}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${Math.max(1, bufferFill * 100)}%`,
            background: 'linear-gradient(90deg,#0e7490,#38bdf8)',
          }}
        />
      </div>
      <div className="muted small" style={{ marginBottom: 6 }}>
        {store.size.toLocaleString()} / {store.cap.toLocaleString()} transitions stored ({(bufferFill * 100).toFixed(0)}%)
      </div>
      <canvas ref={canvasRef} width={320} height={140} className="chart" />
    </div>
  );
}
