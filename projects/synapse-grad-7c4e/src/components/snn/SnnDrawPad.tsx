import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeDrawing } from '../../engine/images';
import { CLASS_COLORS, rgbCss } from '../../lib/colors';
import type { SNNTrace } from '../../engine/snn';
import type { SnnHandle } from '../../hooks/useSnnTrainer';
import SpikeRaster from './SpikeRaster';

interface Props {
  handle: SnnHandle;
  tick: number;
  classify: (pixels: Float64Array) => { trace: SNNTrace | null };
}

function softmax(logits: Float64Array): Float64Array {
  let mx = -Infinity;
  for (const v of logits) mx = Math.max(mx, v);
  let sum = 0;
  const out = new Float64Array(logits.length);
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - mx);
    sum += out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum || 1;
  return out;
}

// Draw a glyph and watch the spiking network encode it into a spike train and classify it live —
// the trained LIF net running on your own handwriting, its raster and per-class softmax updating as
// you draw. The stroke is captured on a high-res buffer, downsampled to the input grid, then
// recentred/rescaled (`normalizeDrawing`) to match the placement the net trained on.
export default function SnnDrawPad({ handle, tick, classify }: Props) {
  const { size, labels } = handle;
  const SUP = 4;
  const R = size * SUP;
  const DISPLAY = 200;

  const bufRef = useRef<Float64Array>(new Float64Array(R * R));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPt = useRef<[number, number] | null>(null);
  const [probs, setProbs] = useState<Float64Array | null>(null);
  const [trace, setTrace] = useState<SNNTrace | null>(null);
  const [hasInk, setHasInk] = useState(false);

  const paint = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    c.width = R;
    c.height = R;
    const img = ctx.createImageData(R, R);
    const buf = bufRef.current;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.min(1, buf[i]);
      const b = Math.round(v * 240);
      img.data[i * 4] = 8 + Math.round(b * 0.5);
      img.data[i * 4 + 1] = 12 + b;
      img.data[i * 4 + 2] = 20 + Math.round(b * 0.9);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [R]);

  const runClassify = useCallback(() => {
    const buf = bufRef.current;
    const small = new Float64Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let dy = 0; dy < SUP; dy++) for (let dx = 0; dx < SUP; dx++) s += buf[(y * SUP + dy) * R + (x * SUP + dx)];
        small[y * size + x] = s / (SUP * SUP);
      }
    }
    let ink = false;
    for (let i = 0; i < small.length; i++) if (small[i] > 0.15) ink = true;
    setHasInk(ink);
    if (!ink) {
      setProbs(null);
      setTrace(null);
      return;
    }
    const norm = normalizeDrawing(small, size);
    const { trace: tr } = classify(norm);
    setTrace(tr);
    setProbs(tr ? softmax(tr.logits) : null);
  }, [size, R, classify]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runClassify();
  }, [tick, runClassify]);

  const toBuf = (e: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [((e.clientX - rect.left) / rect.width) * R, ((e.clientY - rect.top) / rect.height) * R];
  };
  const stamp = (x0: number, y0: number, x1: number, y1: number) => {
    const buf = bufRef.current;
    const radius = R * 0.07;
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x0 + (x1 - x0) * t;
      const cy = y0 + (y1 - y0) * t;
      const r = Math.ceil(radius);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const px = Math.round(cx + dx);
          const py = Math.round(cy + dy);
          if (px < 0 || px >= R || py < 0 || py >= R) continue;
          const d = Math.hypot(dx, dy);
          if (d > radius) continue;
          const v = 1 - (d / radius) * 0.4;
          const idx = py * R + px;
          buf[idx] = Math.min(1, Math.max(buf[idx], v));
        }
      }
    }
  };
  const onDown = (e: React.PointerEvent) => {
    drawing.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = toBuf(e);
    lastPt.current = p;
    stamp(p[0], p[1], p[0], p[1]);
    paint();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const p = toBuf(e);
    const last = lastPt.current ?? p;
    stamp(last[0], last[1], p[0], p[1]);
    lastPt.current = p;
    paint();
    runClassify();
  };
  const onUp = () => {
    drawing.current = false;
    lastPt.current = null;
    runClassify();
  };
  const clear = () => {
    bufRef.current.fill(0);
    paint();
    setProbs(null);
    setTrace(null);
    setHasInk(false);
  };

  useEffect(() => {
    paint();
  }, [paint]);

  const pred = probs ? probs.reduce((best, v, i, a) => (v > a[best] ? i : best), 0) : -1;
  const topConf = probs && pred >= 0 ? probs[pred] : 0;

  return (
    <div className="snn-draw">
      <div className="drawpad-main">
        <canvas
          ref={canvasRef}
          className="draw-canvas"
          style={{ width: DISPLAY, height: DISPLAY }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
        />
        <div className="draw-probs">
          {labels.map((l, c) => {
            const p = probs ? probs[c] : 0;
            const col = CLASS_COLORS[c % CLASS_COLORS.length];
            return (
              <div className="draw-prob" key={l}>
                <span className="draw-prob-l">{l}</span>
                <div className="draw-prob-bar">
                  <span style={{ width: `${p * 100}%`, background: rgbCss(col, 0.85) }} />
                </div>
                <span className="draw-prob-v">{(p * 100).toFixed(0)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="draw-foot">
        <button className="ghost" onClick={clear}>
          Clear
        </button>
        <span className="muted small">
          {hasInk && pred >= 0 ? (
            <>
              spiking net says <b className="draw-call">{labels[pred]}</b> ({(topConf * 100).toFixed(0)}%)
            </>
          ) : (
            'draw a glyph above — it becomes a spike train'
          )}
        </span>
      </div>
      {hasInk && trace && (
        <div className="snn-draw-raster">
          <div className="muted small" style={{ marginBottom: 4 }}>your glyph, spiking through the network:</div>
          <SpikeRaster trace={trace} width={360} />
        </div>
      )}
    </div>
  );
}
