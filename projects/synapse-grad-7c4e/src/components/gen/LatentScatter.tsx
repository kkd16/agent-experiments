import { useEffect, useMemo, useRef } from 'react';
import type { GenHandle, ScatterPoint } from '../../hooks/useGenTrainer';

interface Props {
  handle: GenHandle;
  tick: number;
  span: number;
  latentScatter: () => { points: ScatterPoint[]; stdU: number; stdV: number } | null;
}

// Distinct hue per class (works for up to 10 digit classes, unlike the 4-colour shape palette).
function classHue(cls: number, total: number): string {
  const hue = (cls / Math.max(1, total)) * 330;
  return `hsl(${hue}, 75%, 62%)`;
}

// The encoded latent code, flattened to 2-D (the same top-2 PCA axes the manifold sweeps),
// one dot per sample coloured by its true class. As the VAE learns, same-class glyphs cluster
// — you literally watch an *unsupervised* model discover the classes in its latent space. The
// dashed box marks the window the latent-manifold panel decodes.
export default function LatentScatter({ handle, tick, span, latentScatter }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick refreshes as weights change
  const data = useMemo(() => latentScatter(), [latentScatter, tick]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const S = 280;
    canvas.width = S;
    canvas.height = S;
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, S, S);

    const rx = Math.max(1e-6, data.stdU * (span + 0.6));
    const ry = Math.max(1e-6, data.stdV * (span + 0.6));
    const toX = (x: number) => S / 2 + (x / rx) * (S / 2);
    const toY = (y: number) => S / 2 - (y / ry) * (S / 2);

    // axes
    ctx.strokeStyle = 'rgba(148,163,184,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, S / 2);
    ctx.lineTo(S, S / 2);
    ctx.moveTo(S / 2, 0);
    ctx.lineTo(S / 2, S);
    ctx.stroke();

    // manifold window box
    ctx.strokeStyle = 'rgba(226,232,240,0.35)';
    ctx.setLineDash([4, 3]);
    const bx0 = toX(-data.stdU * span);
    const bx1 = toX(data.stdU * span);
    const by0 = toY(data.stdV * span);
    const by1 = toY(-data.stdV * span);
    ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
    ctx.setLineDash([]);

    for (const p of data.points) {
      ctx.fillStyle = classHue(p.cls, handle.classes);
      ctx.globalAlpha = 0.78;
      ctx.beginPath();
      ctx.arc(toX(p.x), toY(p.y), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [data, span, handle.classes]);

  if (!data) return <p className="muted small">Encoding latent space…</p>;
  return (
    <div className="scatter">
      <canvas ref={ref} className="scatter-canvas" />
      <div className="scatter-legend">
        {handle.labels.map((l, i) => (
          <span key={i} className="scatter-key">
            <span className="dot" style={{ background: classHue(i, handle.classes) }} /> {l}
          </span>
        ))}
      </div>
    </div>
  );
}
