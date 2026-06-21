import { useEffect, useRef } from 'react';
import { Tensor } from '../engine/tensor';
import type { TrainerHandle } from '../hooks/useTrainer';
import { diverging } from '../lib/colors';

const DOMAIN = 1.25;
const G = 22; // sampling resolution per tile
const TILE = 52;
const GAP = 14;
const LABEL = 18;

interface Props {
  handle: TrainerHandle;
  tick: number;
}

export default function NeuronGrid({ handle, tick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const model = handle.model;
    if (!canvas || !model || handle.mode !== 'classification') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // one forward pass over the grid yields every hidden layer's activations
    const grid = new Float64Array(G * G * 2);
    let p = 0;
    for (let yy = 0; yy < G; yy++) {
      const gy = DOMAIN - (yy / (G - 1)) * 2 * DOMAIN;
      for (let xx = 0; xx < G; xx++) {
        const gx = -DOMAIN + (xx / (G - 1)) * 2 * DOMAIN;
        grid[p++] = gx;
        grid[p++] = gy;
      }
    }
    const acts = model.activations(Tensor.fromFlat(grid, G * G, 2));
    const layerCount = acts.length;
    const maxUnits = acts.reduce((m, a) => Math.max(m, a.cols), 1);

    const width = layerCount * (TILE + GAP) + GAP;
    const height = LABEL + maxUnits * (TILE + GAP) + GAP;
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';

    const off = document.createElement('canvas');
    off.width = G;
    off.height = G;
    const octx = off.getContext('2d')!;

    for (let l = 0; l < layerCount; l++) {
      const a = acts[l];
      const cx = GAP + l * (TILE + GAP);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`L${l + 1}`, cx + TILE / 2, 12);
      for (let u = 0; u < a.cols; u++) {
        // normalize this unit's field by its peak magnitude over the grid
        let maxAbs = 1e-6;
        for (let i = 0; i < G * G; i++) maxAbs = Math.max(maxAbs, Math.abs(a.data[i * a.cols + u]));
        const img = octx.createImageData(G, G);
        for (let i = 0; i < G * G; i++) {
          const v = a.data[i * a.cols + u] / maxAbs;
          const col = diverging(v);
          const o = i * 4;
          img.data[o] = col[0];
          img.data[o + 1] = col[1];
          img.data[o + 2] = col[2];
          img.data[o + 3] = 255;
        }
        octx.putImageData(img, 0, 0);
        const ty = LABEL + u * (TILE + GAP);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(off, cx, ty, TILE, TILE);
        ctx.strokeStyle = 'rgba(148,163,184,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, ty + 0.5, TILE, TILE);
      }
    }
  }, [handle, tick]);

  if (handle.mode !== 'classification') {
    return <p className="muted small">Neuron feature maps are shown for 2-D classification tasks.</p>;
  }
  return <canvas ref={canvasRef} className="neuron-canvas" />;
}
