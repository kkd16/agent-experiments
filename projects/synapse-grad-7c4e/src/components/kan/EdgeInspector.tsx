import { useEffect, useRef } from 'react';
import { fmtCoef, type EdgeMode, type LayerCurves, type SymbolicFit } from '../../engine/kan';

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
  fits: SymbolicFit[]; // ranked symbolic fits of the underlying spline (what a snap chooses from)
  mode: EdgeMode | null; // current mode of the selected edge
  onSnap: (name?: string) => void;
  onPrune: () => void;
  onReset: () => void;
}

const MODE_LABEL: Record<EdgeMode, string> = { spline: 'spline', symbolic: 'symbolic', pruned: 'pruned' };

// A magnified view of one edge's learned function φ_{j,i}(x), with the spline's knot positions
// marked along the x-axis — and the interpretability surgery: snap the edge to its closest
// elementary formula (freezing it), prune it to zero, or reset it back to a trained spline.
export default function EdgeInspector({ layers, selected, tick, width, height, fits, mode, onSnap, onPrune, onReset }: Props) {
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

    // the curve — colour by mode (symbolic = amber, pruned = grey, spline = cyan)
    ctx.strokeStyle = edge.mode === 'symbolic' ? '#fbbf24' : edge.mode === 'pruned' ? 'rgba(148,163,184,0.5)' : '#38bdf8';
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
  const top = fits.slice(0, 3);
  const best = top[0];

  const affine = (f: SymbolicFit) =>
    f.name === '1' ? fmtCoef(f.b) : `${fmtCoef(f.a)}·${f.name}${f.b >= 0 ? ' + ' : ' − '}${fmtCoef(Math.abs(f.b))}`;

  return (
    <div>
      <canvas ref={ref} style={{ width, height, maxWidth: '100%' }} className="chart" />
      <div className="edge-head">
        <span className="muted small" style={{ fontFamily: 'ui-monospace, monospace' }}>
          φ on {label}
        </span>
        {mode && <span className={`tag tag-${mode}`}>{MODE_LABEL[mode]}</span>}
      </div>

      {selected && (
        <>
          <div className="edge-fits">
            {top.map((f) => (
              <button
                key={f.name}
                className="edge-fit"
                onClick={() => onSnap(f.name)}
                title={`snap this edge to ${affine(f)}  (freeze it)`}
              >
                <span className="edge-fit-form">≈ {affine(f)}</span>
                <span className="edge-fit-r2" style={{ color: f.r2 > 0.97 ? '#a3e635' : 'var(--muted)' }}>
                  R²={f.r2.toFixed(3)}
                </span>
              </button>
            ))}
            {top.length === 0 && <span className="muted small">—</span>}
          </div>
          <div className="run-row" style={{ marginTop: 6 }}>
            <button className="ghost" onClick={() => onSnap()} disabled={!best} title="freeze to the best-R² formula">
              ⧉ Snap best
            </button>
            <button className="ghost" onClick={onPrune} title="drop this edge (φ ≡ 0)">
              ✕ Prune
            </button>
            <button className="ghost" onClick={onReset} title="back to a trained spline">
              ↺ Reset
            </button>
          </div>
        </>
      )}
    </div>
  );
}
