import { useEffect, useRef, useState } from 'react';
import type { AttnAnalysis } from '../../hooks/useViTTrainer';
import { drawGrid, inkColor } from '../../lib/raster';
import { heatColor, drawAttentionOverlay } from './heat';
import { CLASS_COLORS, rgbCss } from '../../lib/colors';

interface Props {
  analysis: AttnAnalysis | null;
  pixels: Float64Array | null;
  imgSize: number;
  gridSide: number;
  labels: string[];
}

// A small [gridSide × gridSide] attention field painted with the heat ramp.
function MiniHeat({ grid, gridSide, cell = 12 }: { grid: Float64Array; gridSide: number; cell?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let max = 1e-9;
    for (let i = 0; i < grid.length; i++) max = Math.max(max, grid[i]);
    drawGrid(ref.current, grid, gridSide, gridSide, cell, (v) => heatColor(v / max));
  }, [grid, gridSide, cell]);
  return <canvas ref={ref} className="vit-mini" />;
}

export default function AttentionView({ analysis, pixels, imgSize, gridSide, labels }: Props) {
  const glyphRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [depth, setDepth] = useState(99);
  const [smooth, setSmooth] = useState(true);

  const nLayers = analysis ? analysis.rollout.perLayer.length : 0;
  const shownDepth = Math.min(depth, Math.max(0, nLayers - 1));
  const cell = Math.max(6, Math.round(192 / imgSize));

  useEffect(() => {
    if (pixels) drawGrid(glyphRef.current, pixels, imgSize, imgSize, cell, inkColor);
  }, [pixels, imgSize, cell]);

  useEffect(() => {
    if (!analysis || !pixels) return;
    const grid = analysis.rollout.perLayer[shownDepth] ?? analysis.rollout.full;
    drawAttentionOverlay(overlayRef.current, pixels, imgSize, grid, gridSide, cell, smooth);
  }, [analysis, pixels, imgSize, gridSide, cell, shownDepth, smooth]);

  if (!analysis || !pixels) {
    return <p className="muted small">Pick a sample below (or draw one) to see where the classifier attends.</p>;
  }

  const { pred } = analysis;
  return (
    <div className="vit-attn">
      <div className="vit-attn-row">
        <figure className="vit-fig">
          <canvas ref={glyphRef} className="vit-canvas" />
          <figcaption>input · {gridSide}×{gridSide} patches</figcaption>
        </figure>
        <figure className="vit-fig">
          <canvas ref={overlayRef} className="vit-canvas" />
          <figcaption>
            attention rollout → [CLS]{' '}
            <span className="muted">(through layer {shownDepth + 1}/{nLayers})</span>
          </figcaption>
        </figure>
        <div className="vit-pred">
          <div className="muted small">prediction</div>
          <div className="vit-pred-call" style={{ color: rgbCss(CLASS_COLORS[pred.pred % CLASS_COLORS.length]) }}>
            {labels[pred.pred]}
          </div>
          <div className="vit-probs">
            {labels.map((l, c) => (
              <div className="vit-prob" key={l}>
                <span className="vit-prob-l">{l}</span>
                <div className="vit-prob-bar">
                  <span style={{ width: `${pred.probs[c] * 100}%`, background: rgbCss(CLASS_COLORS[c % CLASS_COLORS.length], 0.85) }} />
                </div>
                <span className="vit-prob-v">{(pred.probs[c] * 100).toFixed(0)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="vit-controls-row">
        <label className="vit-slider">
          <span className="muted small">rollout depth</span>
          <input type="range" min={0} max={Math.max(0, nLayers - 1)} step={1} value={shownDepth} onChange={(e) => setDepth(Number(e.target.value))} />
          <span className="mono small">L{shownDepth + 1}</span>
        </label>
        <button className={`chip ${smooth ? 'on' : ''}`} onClick={() => setSmooth((s) => !s)}>
          {smooth ? 'smooth' : 'per-patch'}
        </button>
      </div>

      <div className="vit-heads">
        <div className="muted small vit-heads-title">
          raw per-head attention from [CLS] → patches (rows = layers, columns = heads) — before rollout folds them together
        </div>
        {analysis.attn.maps.map((layer, l) => (
          <div className="vit-head-row" key={l}>
            <span className="vit-head-lab mono small">L{l + 1}</span>
            {layer.map((m, h) => {
              // extract [CLS] (row 0) → patch columns 1.. into a gridSide² field
              const g = new Float64Array(gridSide * gridSide);
              for (let p = 0; p < g.length; p++) g[p] = m[0 * analysis.attn.T + (p + 1)];
              return <MiniHeat key={h} grid={g} gridSide={gridSide} cell={10} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
