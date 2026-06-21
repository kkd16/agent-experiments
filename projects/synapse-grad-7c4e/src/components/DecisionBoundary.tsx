import { useEffect, useRef } from 'react';
import { Tensor } from '../engine/tensor';
import type { TrainerHandle } from '../hooks/useTrainer';
import { CLASS_COLORS, mix } from '../lib/colors';

const DOMAIN = 1.25;
const RES = 100; // grid resolution for the probability field
const BG: [number, number, number] = [15, 23, 42];

interface Props {
  handle: TrainerHandle;
  tick: number;
  selected: [number, number] | null;
  onSelect: (p: [number, number]) => void;
  size: number;
}

function dataToPx(v: number, size: number): number {
  return ((v + DOMAIN) / (2 * DOMAIN)) * size;
}

export default function DecisionBoundary({ handle, tick, selected, onSelect, size }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ds = handle.classData;
    const model = handle.model;
    if (!canvas || !ds || !model) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const classes = ds.classes;

    // 1) probability field on a coarse grid, drawn through an offscreen ImageData.
    const grid = new Float64Array(RES * RES * 2);
    let p = 0;
    for (let yy = 0; yy < RES; yy++) {
      const gy = DOMAIN - (yy / (RES - 1)) * 2 * DOMAIN; // top→down
      for (let xx = 0; xx < RES; xx++) {
        const gx = -DOMAIN + (xx / (RES - 1)) * 2 * DOMAIN;
        grid[p++] = gx;
        grid[p++] = gy;
      }
    }
    const logits = model.forward(Tensor.fromFlat(grid, RES * RES, 2));
    const img = ctx.createImageData(RES, RES);
    const row = new Float64Array(classes);
    for (let i = 0; i < RES * RES; i++) {
      let max = -Infinity;
      for (let c = 0; c < classes; c++) {
        row[c] = logits.data[i * classes + c];
        if (row[c] > max) max = row[c];
      }
      let sum = 0;
      for (let c = 0; c < classes; c++) {
        row[c] = Math.exp(row[c] - max);
        sum += row[c];
      }
      let best = 0;
      let bv = -Infinity;
      for (let c = 0; c < classes; c++) {
        row[c] /= sum;
        if (row[c] > bv) {
          bv = row[c];
          best = c;
        }
      }
      const conf = (bv - 1 / classes) / (1 - 1 / classes); // 0..1
      const col = mix(BG, CLASS_COLORS[best], 0.18 + 0.6 * conf);
      const o = i * 4;
      img.data[o] = col[0];
      img.data[o + 1] = col[1];
      img.data[o + 2] = col[2];
      img.data[o + 3] = 255;
    }
    // upscale the small field smoothly to fill the canvas
    const off = document.createElement('canvas');
    off.width = RES;
    off.height = RES;
    off.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(off, 0, 0, size, size);

    // 2) data points
    for (let i = 0; i < ds.n; i++) {
      const px = dataToPx(ds.X[i * 2], size);
      const py = size - dataToPx(ds.X[i * 2 + 1], size);
      const col = CLASS_COLORS[ds.y[i] % CLASS_COLORS.length];
      ctx.beginPath();
      ctx.arc(px, py, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(2,6,23,0.85)';
      ctx.stroke();
    }

    // 3) the selected sample (drives the autograd-tape view)
    if (selected) {
      const px = dataToPx(selected[0], size);
      const py = size - dataToPx(selected[1], size);
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#f8fafc';
      ctx.fill();
    }
  }, [handle, tick, selected, size]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const x = -DOMAIN + fx * 2 * DOMAIN;
    const y = DOMAIN - fy * 2 * DOMAIN;
    onSelect([x, y]);
  };

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      onClick={handleClick}
      className="board"
      title="Click to move the probe point"
    />
  );
}
