import { useEffect, useRef } from 'react';

interface Props {
  tick: number;
  kernelMatrix: () => { data: Float64Array; n: number } | null;
}

// The Gram matrix K_ij = k(x_i, x_j) as a heatmap — the covariance structure of the prior over
// the observed inputs. Bright blocks are strongly-correlated (nearby) inputs; the diagonal
// carries the signal + noise variance. This is exactly the matrix the Cholesky factorizes.
export default function KernelHeatmap({ tick, kernelMatrix }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const Wpx = canvas.width;
    const Hpx = canvas.height;
    ctx.clearRect(0, 0, Wpx, Hpx);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, Wpx, Hpx);

    const km = kernelMatrix();
    if (!km) {
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.font = '13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('no data', Wpx / 2, Hpx / 2);
      return;
    }
    const { data, n } = km;
    let max = 0;
    for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
    max = max || 1;
    const cell = Math.min(Wpx, Hpx) / n;
    const ox = (Wpx - cell * n) / 2;
    const oy = (Hpx - cell * n) / 2;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const v = data[i * n + j] / max;
        ctx.fillStyle = ramp(v);
        ctx.fillRect(ox + j * cell, oy + i * cell, cell + 0.5, cell + 0.5);
      }
    }
  }, [tick, kernelMatrix]);

  return <canvas ref={ref} width={220} height={220} className="gp-heatmap" />;
}

// dark → sky ramp for the non-negative covariance entries
function ramp(v: number): string {
  const t = Math.max(0, Math.min(1, v));
  const bg = [11, 18, 32];
  const fg = [56, 189, 248];
  const c = (k: number) => Math.round(bg[k] + (fg[k] - bg[k]) * t);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}
