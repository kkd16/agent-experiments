import { useEffect, useRef } from 'react';
import { NCA_TARGETS, renderTarget, type GridMeta } from '../../engine/nca';

interface Props {
  targetId: string;
  onPick: (id: string) => void;
}

const THUMB = 30; // render resolution of each thumbnail
const PX = 46; // displayed size

function ThumbButton({ id, label, active, onPick }: { id: string; label: string; active: boolean; onPick: (id: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const meta: GridMeta = { N: 1, H: THUMB, W: THUMB, C: 4 };
    const t = renderTarget(id, meta);
    const img = ctx.createImageData(THUMB, THUMB);
    const bg = [10, 13, 20];
    for (let p = 0; p < THUMB * THUMB; p++) {
      const a = Math.min(1, Math.max(0, t[p * 4 + 3]));
      img.data[p * 4] = (Math.min(1, t[p * 4]) * 255) + (1 - a) * bg[0];
      img.data[p * 4 + 1] = (Math.min(1, t[p * 4 + 1]) * 255) + (1 - a) * bg[1];
      img.data[p * 4 + 2] = (Math.min(1, t[p * 4 + 2]) * 255) + (1 - a) * bg[2];
      img.data[p * 4 + 3] = 255;
    }
    const off = document.createElement('canvas');
    off.width = THUMB;
    off.height = THUMB;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, PX, PX);
    ctx.drawImage(off, 0, 0, PX, PX);
  }, [id]);
  return (
    <button className={`target-thumb ${active ? 'on' : ''}`} title={label} onClick={() => onPick(id)}>
      <canvas ref={ref} width={PX} height={PX} />
    </button>
  );
}

// The procedural target gallery — every glyph is SDF-rendered on the fly (no bundled assets).
export default function TargetPicker({ targetId, onPick }: Props) {
  return (
    <div className="target-grid">
      {NCA_TARGETS.map((t) => (
        <ThumbButton key={t.id} id={t.id} label={t.label} active={t.id === targetId} onPick={onPick} />
      ))}
    </div>
  );
}
