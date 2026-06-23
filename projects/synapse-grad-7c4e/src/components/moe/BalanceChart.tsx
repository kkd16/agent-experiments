import { useEffect, useRef } from 'react';

interface Props {
  loadCV: number[]; // coefficient of variation of expert load (→ 0 = balanced)
  aux: number[]; // load-balancing aux term
  width: number;
  height: number;
}

// A two-line trace of how balanced the router is over training: the load coefficient of
// variation (violet) and the raw Switch aux term (amber). Both should fall as the auxiliary
// loss pushes the experts into even use.
export default function BalanceChart({ loadCV, aux, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, width, height);

    const pad = 4;
    ctx.strokeStyle = 'rgba(148,163,184,0.10)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (i / 4) * (height - 2 * pad);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    const finite = (arr: number[]) => arr.filter((v) => Number.isFinite(v));
    const draw = (data: number[], color: string, maxV: number) => {
      if (data.length < 2 || maxV <= 0) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < data.length; i++) {
        if (!Number.isFinite(data[i])) continue;
        const x = pad + (i / (data.length - 1)) * (width - 2 * pad);
        const y = pad + (1 - Math.min(1, data[i] / maxV)) * (height - 2 * pad);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    const cvMax = Math.max(...finite(loadCV), 0.3);
    const auxMax = Math.max(...finite(aux), 1e-6);
    draw(loadCV, '#a78bfa', cvMax);
    draw(aux, '#fbbf24', auxMax);
  }, [loadCV, aux, width, height]);

  return <canvas ref={ref} />;
}
