import { useEffect, useRef } from 'react';
import type { FDTD } from '../sim/FDTD';

const TRACE_COLORS = ['#5fd0ff', '#ffd166', '#8affc1', '#ff8fab', '#c9a7ff'];

/** Live oscilloscope of Ez(t) at each probe, drawn on its own RAF loop. */
export function Oscilloscope({ sim }: { sim: FDTD }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // grid
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      const probes = sim.probes;
      if (probes.length === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '12px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('place a probe to see Ez(t)', w / 2, h / 2 - 8);
        return;
      }

      // auto-scale to the largest recent amplitude across probes
      let peak = 1e-4;
      for (const p of probes) {
        for (let i = 0; i < p.filled; i++) peak = Math.max(peak, Math.abs(p.history[i]));
      }
      const scale = (h / 2 - 6) / peak;

      probes.forEach((p, idx) => {
        if (p.filled < 2) return;
        ctx.strokeStyle = TRACE_COLORS[idx % TRACE_COLORS.length];
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const N = p.filled;
        for (let i = 0; i < N; i++) {
          // oldest sample first
          const bufIdx = (p.head - N + i + p.history.length) % p.history.length;
          const v = p.history[bufIdx];
          const x = (i / (N - 1)) * w;
          const y = h / 2 - v * scale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [sim]);

  return <canvas ref={ref} className="oscilloscope" />;
}
