import { useCallback, useEffect, useRef, useState } from 'react';
import type { VisionHandle, Prediction } from '../../hooks/useVisionTrainer';
import { normalizeDrawing } from '../../engine/images';
import { CLASS_COLORS, rgbCss } from '../../lib/colors';

interface Props {
  handle: VisionHandle;
  tick: number;
  predict: (pixels: Float64Array) => Prediction | null;
}

// Draw a digit/shape with the mouse and watch the trained CNN classify it live. The stroke
// is captured on a high-res buffer, downsampled to the network's input size, then recentred
// and rescaled (`normalizeDrawing`) so it matches the placement the model trained on.
export default function DrawPad({ handle, tick, predict }: Props) {
  const { imgSize, labels } = handle;
  const SUP = 4; // supersample factor for smooth strokes
  const R = imgSize * SUP;
  const DISPLAY = 224;

  const bufRef = useRef<Float64Array>(new Float64Array(R * R));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPt = useRef<[number, number] | null>(null);
  const [pred, setPred] = useState<Prediction | null>(null);
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
      img.data[i * 4] = 8 + b;
      img.data[i * 4 + 1] = 12 + b;
      img.data[i * 4 + 2] = 20 + b;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [R]);

  const runPredict = useCallback(() => {
    const buf = bufRef.current;
    // downsample R×R -> imgSize×imgSize by block average
    const small = new Float64Array(imgSize * imgSize);
    for (let y = 0; y < imgSize; y++) {
      for (let x = 0; x < imgSize; x++) {
        let s = 0;
        for (let dy = 0; dy < SUP; dy++) {
          for (let dx = 0; dx < SUP; dx++) {
            s += buf[(y * SUP + dy) * R + (x * SUP + dx)];
          }
        }
        small[y * imgSize + x] = s / (SUP * SUP);
      }
    }
    let ink = false;
    for (let i = 0; i < small.length; i++) if (small[i] > 0.15) ink = true;
    setHasInk(ink);
    if (!ink) {
      setPred(null);
      return;
    }
    const norm = normalizeDrawing(small, imgSize);
    setPred(predict(norm));
  }, [imgSize, R, SUP, predict]);

  // Re-classify when the model updates (training tick) and on mount. Syncing the prediction
  // to the (external) live model is exactly what an effect is for here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runPredict();
  }, [tick, runPredict]);

  const toBuf = (e: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * R;
    const y = ((e.clientY - rect.top) / rect.height) * R;
    return [x, y];
  };

  const stamp = (x0: number, y0: number, x1: number, y1: number) => {
    const buf = bufRef.current;
    const radius = R * 0.06;
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
    runPredict();
  };
  const onUp = () => {
    drawing.current = false;
    lastPt.current = null;
    runPredict();
  };

  const clear = () => {
    bufRef.current.fill(0);
    paint();
    setPred(null);
    setHasInk(false);
  };

  useEffect(() => {
    paint();
  }, [paint]);

  const topConf = pred ? pred.probs[pred.pred] : 0;

  return (
    <div className="drawpad">
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
            const p = pred ? pred.probs[c] : 0;
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
          {hasInk && pred ? (
            <>
              prediction <b className="draw-call">{labels[pred.pred]}</b> ({(topConf * 100).toFixed(0)}%)
            </>
          ) : (
            'draw a glyph above'
          )}
        </span>
      </div>
    </div>
  );
}
