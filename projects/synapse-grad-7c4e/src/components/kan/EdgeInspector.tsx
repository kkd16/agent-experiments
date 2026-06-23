import { useEffect, useRef } from 'react';
import type { LayerCurves } from '../../engine/kan';

interface Sel {
  layer: number;
  i: number;
  j: number;
}

interface Props {
  layers: LayerCurves[] | null;
  selected: Sel | null;
  tick: number;
  width: number;
  height: number;
}

// A magnified view of one edge's learned function φ_{j,i}(x), with the spline's knot positions
// marked along the x-axis — so you can watch the control points bend the curve as it trains, and
// see new knots appear when the grid is refined.
export default function EdgeInspector({ layers, selected, tick, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, width, height);

    if (!layers || !selected || selected.layer >= layers.length) {
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.font = '12px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Click an edge in the diagram', width / 2, height / 2);
      return;
    }
    const layer = layers[selected.layer];
    const edge = layer.edges.find((e) => e.i === selected.i && e.j === selected.j);
    if (!edge) return;

    const padL = 30;
    const padR = 10;
    const padT = 12;
    const padB = 22;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    let lo = Infinity;
    let hi = -Infinity;
    for (const v of edge.ys) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo < 1e-6) {
      lo -= 0.5;
      hi += 0.5;
    }
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;

    const toX = (x: number) => padL + (plotW * (x - layer.lo)) / (layer.hi - layer.lo);
    const toY = (v: number) => padT + plotH - (plotH * (v - lo)) / (hi - lo);

    // knot ticks (gridSize + 1 interior knots over [lo,hi])
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.lineWidth = 1;
    for (let k = 0; k <= layer.gridSize; k++) {
      const x = layer.lo + ((layer.hi - layer.lo) * k) / layer.gridSize;
      const px = toX(x);
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.stroke();
    }

    // zero axis
    if (lo < 0 && hi > 0) {
      ctx.strokeStyle = 'rgba(148,163,184,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, toY(0));
      ctx.lineTo(padL + plotW, toY(0));
      ctx.stroke();
    }

    // the curve
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let s = 0; s < edge.xs.length; s++) {
      const px = toX(edge.xs[s]);
      const py = toY(edge.ys[s]);
      if (s === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // axis labels
    ctx.fillStyle = 'rgba(148,163,184,0.75)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(hi.toFixed(2), 2, padT);
    ctx.textBaseline = 'bottom';
    ctx.fillText(lo.toFixed(2), 2, padT + plotH);
    ctx.textAlign = 'center';
    ctx.fillText(layer.lo.toFixed(1), padL, height - 10);
    ctx.fillText(layer.hi.toFixed(1), padL + plotW, height - 10);
  }, [layers, selected, tick, width, height]);

  const label = selected ? `layer ${selected.layer + 1}: node ${selected.i} → node ${selected.j}` : '—';

  return (
    <div>
      <canvas ref={ref} style={{ width, height, maxWidth: '100%' }} className="chart" />
      <div className="muted small" style={{ marginTop: 6, fontFamily: 'ui-monospace, monospace' }}>
        φ on {label}
      </div>
    </div>
  );
}
