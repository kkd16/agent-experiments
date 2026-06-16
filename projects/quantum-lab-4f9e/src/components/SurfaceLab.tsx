import { useMemo, useState } from 'react';
import {
  buildSurfaceCode, decode, mulberry32, thresholdSweep,
  type SurfaceCode, type StabType, type ThresholdResult,
} from '../quantum/surface/SurfaceCode';

type ErrType = 'X' | 'Z';

const COL = {
  x: '#f87171', z: '#34d399', err: '#f87171', errZ: '#60a5fa',
  defect: '#fbbf24', corr: '#a78bfa', wire: '#1e293b', qubit: '#0b1220',
};

export default function SurfaceLab() {
  return (
    <div style={{ maxWidth: 860 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        The <b style={{ color: '#a78bfa' }}>surface code</b> is the leading architecture for
        fault-tolerant quantum computing — a topological <code style={{ color: '#67e8f9' }}>[[d²,1,d]]</code> stabilizer
        code that stores one logical qubit in string-like operators spread across a 2-D lattice of <i>d²</i> data
        qubits, protected by <i>d²−1</i> weight-≤4 parity checks. A local error lights up a pair of checks
        (a <b style={{ color: COL.defect }}>defect</b>); the decoder must guess the hidden error chain that
        produced them. Below it all runs a from-scratch <b style={{ color: '#a78bfa' }}>Minimum-Weight Perfect
        Matching</b> decoder — Edmonds' blossom algorithm on a graph whose vertices are the lit-up checks and
        whose edge weights are lattice distances.
      </p>
      <DecoderCard />
      <ThresholdCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interactive single-shot decoder
// ---------------------------------------------------------------------------

function DecoderCard() {
  const [d, setD] = useState(5);
  const [errType, setErrType] = useState<ErrType>('X');
  const [errs, setErrs] = useState<Set<number>>(new Set());
  const [p, setP] = useState(0.08);
  const [seed, setSeed] = useState(1);

  const code = useMemo(() => buildSurfaceCode(d), [d]);
  const detType: StabType = errType === 'X' ? 'Z' : 'X';

  const result = useMemo(() => {
    const dec = decode(code, errs, detType);
    const residual = new Set(errs);
    for (const q of dec.correction) { if (residual.has(q)) residual.delete(q); else residual.add(q); }
    const logSupport = errType === 'X' ? code.logicalZ : code.logicalX;
    let parity = 0; for (const q of logSupport) if (residual.has(q)) parity++;
    return { dec, residual, logical: (parity & 1) === 1 };
  }, [code, errs, detType, errType]);

  const setRandom = () => {
    const rng = mulberry32(seed * 2654435761);
    const next = new Set<number>();
    for (let q = 0; q < code.nData; q++) if (rng() < p) next.add(q);
    setErrs(next);
    setSeed((s) => s + 1);
  };

  const toggleQubit = (q: number) => {
    setErrs((prev) => { const n = new Set(prev); if (n.has(q)) n.delete(q); else n.add(q); return n; });
  };

  const defectCount = result.dec.defects.length;

  return (
    <Card title="MWPM decoder — single shot" accent="#a78bfa">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>distance d
          <select value={d} onChange={(e) => { setD(parseInt(e.target.value)); setErrs(new Set()); }} style={sel}>
            {[3, 5, 7, 9].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['X', 'Z'] as ErrType[]).map((t) => (
            <button key={t} onClick={() => { setErrType(t); setErrs(new Set()); }}
              style={{ ...pill(errType === t), color: errType === t ? (t === 'X' ? COL.err : COL.errZ) : '#64748b' }}>
              {t} errors
            </button>
          ))}
        </div>
        <label style={lab}>p
          <input type="range" min={0} max={0.3} step={0.01} value={p} onChange={(e) => setP(parseFloat(e.target.value))} style={{ accentColor: '#7c3aed', width: 90 }} />
          <span style={{ fontFamily: 'monospace', color: '#a78bfa', width: 30 }}>{p.toFixed(2)}</span>
        </label>
        <button onClick={setRandom} style={btn('#7c3aed')}>🎲 sample errors</button>
        <button onClick={() => setErrs(new Set())} style={btn('#334155')}>clear</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 16, alignItems: 'start' }}>
        <Lattice code={code} errType={errType} errs={errs} result={result} onToggle={toggleQubit} />
        <div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Metric label={`${errType}-errors injected`} value={String(errs.size)} color={errType === 'X' ? COL.err : COL.errZ} />
            <Metric label={`defects (${detType}-checks lit)`} value={String(defectCount)} color={COL.defect} />
            <Metric label="correction weight" value={String(result.dec.correction.length)} color={COL.corr} />
            <Metric label="matched pairs" value={String(result.dec.matching.length)} color="#67e8f9" />
            <div style={{
              padding: '10px 12px', borderRadius: 8, textAlign: 'center', fontWeight: 800, fontSize: 13,
              background: result.logical ? 'rgba(220,38,38,0.15)' : 'rgba(16,185,129,0.15)',
              border: `1px solid ${result.logical ? '#dc2626' : '#10b981'}`,
              color: result.logical ? '#f87171' : '#34d399',
            }}>
              {errs.size === 0 ? 'no error' : result.logical ? '✗ LOGICAL ERROR' : '✓ corrected'}
            </div>
          </div>
          <p style={{ fontSize: 10, color: '#475569', marginTop: 10, lineHeight: 1.5 }}>
            The residual error (error ⊕ correction) always commutes with every check. It is harmless if it is a
            product of stabilizers, but a <b style={{ color: '#f87171' }}>logical failure</b> if it forms a
            string spanning the code — the decoder picked the wrong homology class. Click any qubit to toggle an
            error by hand.
          </p>
        </div>
      </div>

      <p style={{ fontSize: 10, color: '#475569', margin: '10px 0 0', lineHeight: 1.5 }}>
        {errType === 'X'
          ? <>Showing <b style={{ color: COL.err }}>X (bit-flip) errors</b>, detected by the <b style={{ color: COL.z }}>Z-type checks</b> (green). An X chain ending on the rough boundary is correctable; one connecting the two smooth boundaries is a logical X.</>
          : <>Showing <b style={{ color: COL.errZ }}>Z (phase-flip) errors</b>, detected by the <b style={{ color: COL.x }}>X-type checks</b> (red). The roles of the two boundaries swap relative to bit-flip errors.</>}
      </p>
    </Card>
  );
}

function Lattice({ code, errType, errs, result, onToggle }: {
  code: SurfaceCode; errType: ErrType; errs: Set<number>;
  result: { dec: ReturnType<typeof decode>; residual: Set<number>; logical: boolean };
  onToggle: (q: number) => void;
}) {
  const d = code.d;
  const cell = Math.min(54, 300 / d);
  const m = cell; // outer margin (room for boundary plaquettes)
  const W = m * 2 + (d - 1) * cell;
  const px = (c: number) => m + c * cell;
  const py = (r: number) => m + r * cell;
  const detType: StabType = errType === 'X' ? 'Z' : 'X';
  const defectSet = new Set(result.dec.defects);
  const corrSet = new Set(result.dec.correction);
  const errColor = errType === 'X' ? COL.err : COL.errZ;

  // plaquette centre in pixels
  const cpx = (s: { cx: number; cy: number }) => ({ x: m + s.cx * cell, y: m + s.cy * cell });

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${W}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 10, border: '1px solid #1e293b', maxWidth: 420 }}>
      {/* plaquettes */}
      {code.stabs.map((s, i) => {
        const isDet = s.type === detType;
        const fired = defectSet.has(i);
        const base = s.type === 'X' ? COL.x : COL.z;
        const pts = s.qubits.map((q) => `${px(code.data[q].c)},${py(code.data[q].r)}`);
        if (s.boundary) {
          // weight-2: triangle qubit–center–qubit bulging outside the lattice
          const c = cpx(s);
          const poly = `${pts[0]} ${c.x},${c.y} ${pts[1]}`;
          return (
            <polygon key={i} points={poly}
              fill={fired ? COL.defect : base} fillOpacity={fired ? 0.32 : isDet ? 0.14 : 0.05}
              stroke={fired ? COL.defect : base} strokeOpacity={isDet ? 0.6 : 0.2} strokeWidth={fired ? 2 : 1} />
          );
        }
        return (
          <polygon key={i} points={pts.join(' ')}
            fill={fired ? COL.defect : base} fillOpacity={fired ? 0.30 : isDet ? 0.12 : 0.04}
            stroke={fired ? COL.defect : base} strokeOpacity={isDet ? 0.5 : 0.18} strokeWidth={fired ? 2 : 1} />
        );
      })}

      {/* matching lines (along the correction, between defect centres / to boundary) */}
      {result.dec.matching.map((mch, i) => {
        const a = cpx(code.stabs[mch.a]);
        if (mch.toBoundary) {
          // draw towards the nearest lattice boundary
          const s = code.stabs[mch.a];
          let bx = s.cx, by = s.cy;
          const dl = s.cx, dr = (d - 1) - s.cx, dt = s.cy, db = (d - 1) - s.cy;
          const mn = Math.min(dl, dr, dt, db);
          if (mn === dl) bx = -0.6; else if (mn === dr) bx = d - 0.4; else if (mn === dt) by = -0.6; else by = d - 0.4;
          return <line key={i} x1={a.x} y1={a.y} x2={m + bx * cell} y2={m + by * cell} stroke={COL.corr} strokeWidth={2.5} strokeDasharray="4 3" opacity={0.85} />;
        }
        const b = cpx(code.stabs[mch.b]);
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={COL.corr} strokeWidth={2.5} strokeDasharray="4 3" opacity={0.85} />;
      })}

      {/* data qubits */}
      {code.data.map((dq, q) => {
        const hasErr = errs.has(q);
        const inCorr = corrSet.has(q);
        return (
          <g key={q} onClick={() => onToggle(q)} style={{ cursor: 'pointer' }}>
            {inCorr && <circle cx={px(dq.c)} cy={py(dq.r)} r={cell * 0.26} fill="none" stroke={COL.corr} strokeWidth={2.5} />}
            <circle cx={px(dq.c)} cy={py(dq.r)} r={cell * 0.16} fill={hasErr ? errColor : COL.qubit}
              stroke={hasErr ? errColor : '#334155'} strokeWidth={1.5} />
            {hasErr && <text x={px(dq.c)} y={py(dq.r) + 3} fontSize={cell * 0.2} fill="#0b1220" textAnchor="middle" fontWeight={800}>{errType}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Threshold experiment
// ---------------------------------------------------------------------------

function ThresholdCard() {
  const [samples, setSamples] = useState(2000);
  const [res, setRes] = useState<ThresholdResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    setTimeout(() => {
      setRes(thresholdSweep({ distances: [3, 5, 7], samples, seed: (Math.random() * 1e9) | 0 }));
      setBusy(false);
    }, 20);
  };

  return (
    <Card title="Error-correction threshold (Monte-Carlo)" accent="#67e8f9">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        The defining property of a good code: below a critical physical error rate <i>p</i><sub>th</sub>, adding
        more qubits (larger <i>d</i>) drives the logical error rate <b>down</b>; above it, more qubits make things
        <b> worse</b>. So the curves for different distances all cross at <i>p</i><sub>th</sub>. Each data qubit
        is flipped independently with probability <i>p</i> and decoded by MWPM. The code-capacity threshold of the
        surface code under MWPM is known to be ≈ <b style={{ color: '#67e8f9' }}>10.3%</b> — this experiment finds it.
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>samples / point
          <input type="range" min={500} max={6000} step={500} value={samples} onChange={(e) => setSamples(parseInt(e.target.value))} style={{ accentColor: '#0891b2', width: 120 }} />
          <span style={{ fontFamily: 'monospace', color: '#67e8f9', width: 40 }}>{samples}</span>
        </label>
        <button onClick={run} disabled={busy} style={btn('#0891b2')}>{busy ? 'Running…' : '▶ Run sweep'}</button>
        {res?.threshold != null && (
          <Metric label="estimated p_th" value={`${(res.threshold * 100).toFixed(1)}%`} color="#67e8f9" />
        )}
      </div>
      {res && <ThresholdPlot res={res} />}
    </Card>
  );
}

const DIST_COLORS = ['#f87171', '#fbbf24', '#34d399', '#67e8f9'];

function ThresholdPlot({ res }: { res: ThresholdResult }) {
  const w = 560, h = 280, padL = 50, padB = 38, padT = 14, padR = 14;
  const ps = res.points.map((pt) => pt.p);
  const pMin = Math.min(...ps), pMax = Math.max(...ps);
  const xs = (p: number) => padL + ((p - pMin) / (pMax - pMin)) * (w - padL - padR);
  const ys = (v: number) => padT + (1 - v) * (h - padT - padB);

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 8, border: '1px solid #1e293b' }}>
        {/* gridlines */}
        {[0, 0.1, 0.2, 0.3, 0.4, 0.5].map((v) => (
          <g key={v}>
            <line x1={padL} y1={ys(v)} x2={w - padR} y2={ys(v)} stroke="#1e293b" strokeWidth={1} />
            <text x={padL - 6} y={ys(v) + 3} fontSize={9} fill="#475569" textAnchor="end">{v.toFixed(1)}</text>
          </g>
        ))}
        {ps.map((p) => (
          <text key={p} x={xs(p)} y={h - padB + 14} fontSize={8} fill="#475569" textAnchor="middle">{(p * 100).toFixed(0)}</text>
        ))}
        {/* threshold marker */}
        {res.threshold != null && (
          <g>
            <line x1={xs(res.threshold)} y1={padT} x2={xs(res.threshold)} y2={h - padB} stroke="#7c3aed" strokeWidth={1.5} strokeDasharray="5 4" opacity={0.7} />
            <text x={xs(res.threshold)} y={padT + 10} fontSize={9} fill="#a78bfa" textAnchor="middle">p_th ≈ {(res.threshold * 100).toFixed(1)}%</text>
          </g>
        )}
        {/* curves */}
        {res.distances.map((d, di) => {
          const path = res.points.map((pt, i) => `${i === 0 ? 'M' : 'L'}${xs(pt.p).toFixed(1)},${ys(pt.rates[di].rate).toFixed(1)}`).join(' ');
          return (
            <g key={d}>
              <path d={path} fill="none" stroke={DIST_COLORS[di]} strokeWidth={2.2} opacity={0.9} />
              {res.points.map((pt, i) => (
                <circle key={i} cx={xs(pt.p)} cy={ys(pt.rates[di].rate)} r={2.6} fill={DIST_COLORS[di]} />
              ))}
            </g>
          );
        })}
        <text x={padL - 38} y={padT + (h - padT - padB) / 2} fontSize={10} fill="#64748b" textAnchor="middle" transform={`rotate(-90 ${padL - 38} ${padT + (h - padT - padB) / 2})`}>logical error rate</text>
        <text x={(w + padL) / 2} y={h - 4} fontSize={10} fill="#64748b" textAnchor="middle">physical error rate p (%)</text>
      </svg>
      <div style={{ display: 'flex', gap: 14, marginTop: 8, justifyContent: 'center' }}>
        {res.distances.map((d, di) => (
          <span key={d} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#94a3b8' }}>
            <span style={{ width: 14, height: 3, background: DIST_COLORS[di], display: 'inline-block', borderRadius: 2 }} /> d = {d}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

function Card({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(14,22,41,0.6)', border: '1px solid rgba(30,58,95,0.5)', borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 800, color: accent }}>{title}</h3>
      {children}
    </div>
  );
}
function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8, padding: '6px 12px' }}>
      <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}
function btn(color: string): React.CSSProperties {
  return { padding: '7px 14px', borderRadius: 8, border: 'none', background: color, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
}
function pill(active: boolean): React.CSSProperties {
  return { padding: '6px 12px', borderRadius: 6, border: `1px solid ${active ? '#7c3aed' : '#1e293b'}`, background: active ? 'rgba(124,58,237,0.15)' : 'transparent', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
}
const sel: React.CSSProperties = { padding: '5px 8px', borderRadius: 6, background: '#0a0f1e', color: '#e2e8f0', border: '1px solid #334155', fontSize: 12, marginLeft: 6 };
const lab: React.CSSProperties = { fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' };
