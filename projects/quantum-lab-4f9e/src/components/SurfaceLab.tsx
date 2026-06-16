import { useMemo, useState } from 'react';
import {
  buildSurfaceCode, decode, mulberry32,
  type SurfaceCode, type StabType,
} from '../quantum/surface/SurfaceCode';
import {
  spaceTimeShot, phenomThresholdSweep, codeCapacityThresholdSweep,
  lambdaRatios, collapseFit, codeCapacityRate, phenomLogicalErrorRate,
  type DecoderKind, type PhenomThreshold, type CollapseResult, type SpaceTimeShot,
} from '../quantum/surface/spacetime';

type ErrType = 'X' | 'Z';
type Model = 'code-capacity' | 'phenom';

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
      <p style={{ color: '#64748b', fontSize: 12, margin: '-8px 0 18px', lineHeight: 1.6 }}>
        <b style={{ color: '#67e8f9' }}>7.0 — fault tolerance in space-time.</b> Real hardware measures the
        stabilizers <i>repeatedly</i> and each measurement is itself noisy, so the decoding graph becomes
        <b> 3-D</b>: a stack of syndrome rounds whose <b style={{ color: '#a78bfa' }}>time edges</b> absorb
        measurement errors. Alongside the optimal MWPM decoder there is now a from-scratch
        <b style={{ color: '#34d399' }}> Union-Find</b> decoder (Delfosse–Nivelle) — near-linear-time cluster
        growth and peeling — and the labs below locate the phenomenological threshold, compare the two decoders,
        and collapse the finite-size data onto one universal curve.
      </p>
      <DecoderCard />
      <SpaceTimeCard />
      <ThresholdCard />
      <ScalingCard />
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
  const [model, setModel] = useState<Model>('code-capacity');
  const [kind, setKind] = useState<DecoderKind>('mwpm');
  const [res, setRes] = useState<PhenomThreshold | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    setTimeout(() => {
      const seed = (Math.random() * 1e9) | 0;
      const out = model === 'phenom'
        ? phenomThresholdSweep({ distances: [3, 5, 7], samples: Math.max(400, Math.round(samples / 3)), seed, kind })
        : codeCapacityThresholdSweep({ distances: [3, 5, 7], samples, seed, kind });
      setRes(out);
      setBusy(false);
    }, 20);
  };

  const known = model === 'phenom' ? '≈ 3% (phenomenological)' : '≈ 10.3% (code capacity)';
  return (
    <Card title="Error-correction threshold (Monte-Carlo)" accent="#67e8f9">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        The defining property of a good code: below a critical physical error rate <i>p</i><sub>th</sub>, adding
        more qubits (larger <i>d</i>) drives the logical error rate <b>down</b>; above it, more qubits make things
        <b> worse</b>. So the curves for different distances cross at <i>p</i><sub>th</sub>. Switch between the
        <b> code-capacity</b> model (perfect measurements) and the <b>phenomenological</b> model (T=d noisy
        syndrome rounds + measurement errors, decoded in 3-D space-time), and between the optimal
        <b style={{ color: '#a78bfa' }}> MWPM</b> and the fast <b style={{ color: '#34d399' }}>Union-Find</b>
        decoder. The known threshold here is <b style={{ color: '#67e8f9' }}>{known}</b>.
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['code-capacity', 'phenom'] as Model[]).map((mo) => (
            <button key={mo} onClick={() => { setModel(mo); setRes(null); }} style={pill(model === mo)}>
              {mo === 'phenom' ? 'phenomenological' : 'code capacity'}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['mwpm', 'uf'] as DecoderKind[]).map((k) => (
            <button key={k} onClick={() => { setKind(k); setRes(null); }}
              style={{ ...pill(kind === k), color: kind === k ? (k === 'uf' ? '#34d399' : '#a78bfa') : '#64748b' }}>
              {k === 'uf' ? 'Union-Find' : 'MWPM'}
            </button>
          ))}
        </div>
        <label style={lab}>samples
          <input type="range" min={500} max={6000} step={500} value={samples} onChange={(e) => setSamples(parseInt(e.target.value))} style={{ accentColor: '#0891b2', width: 110 }} />
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

function ThresholdPlot({ res }: { res: PhenomThreshold }) {
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
// Space-time decoding under phenomenological noise
// ---------------------------------------------------------------------------

function SpaceTimeCard() {
  const [d, setD] = useState(5);
  const [T, setT] = useState(5);
  const [p, setP] = useState(0.03);
  const [kind, setKind] = useState<DecoderKind>('mwpm');
  const [seed, setSeed] = useState(1);

  const code = useMemo(() => buildSurfaceCode(d), [d]);
  const shot = useMemo<SpaceTimeShot>(
    () => spaceTimeShot({ d, T, p, kind, detType: 'Z', rng: mulberry32(seed * 2654435761) }),
    [d, T, p, kind, seed],
  );

  return (
    <Card title="Space-time decoder — phenomenological noise" accent="#67e8f9">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Now the syndrome is measured <b>T = {T}</b> times, each round flipping every data qubit (rate <i>p</i>) and
        every <i>measured outcome</i> (rate <i>p</i>) — then one final perfect readout. A <b style={{ color: COL.defect }}>detection
        event</b> fires wherever the syndrome <i>changes</i> between rounds; a lone measurement error makes a
        vertical pair across two layers. The decoder matches these events in the 3-D space-time graph and reads the
        correction off the data plane.
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>distance d
          <select value={d} onChange={(e) => setD(parseInt(e.target.value))} style={sel}>
            {[3, 5, 7].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label style={lab}>rounds T
          <input type="range" min={1} max={9} step={1} value={T} onChange={(e) => setT(parseInt(e.target.value))} style={{ accentColor: '#0891b2', width: 80 }} />
          <span style={{ fontFamily: 'monospace', color: '#67e8f9', width: 16 }}>{T}</span>
        </label>
        <label style={lab}>p = q
          <input type="range" min={0.005} max={0.1} step={0.005} value={p} onChange={(e) => setP(parseFloat(e.target.value))} style={{ accentColor: '#7c3aed', width: 90 }} />
          <span style={{ fontFamily: 'monospace', color: '#a78bfa', width: 40 }}>{(p * 100).toFixed(1)}%</span>
        </label>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['mwpm', 'uf'] as DecoderKind[]).map((k) => (
            <button key={k} onClick={() => setKind(k)}
              style={{ ...pill(kind === k), color: kind === k ? (k === 'uf' ? '#34d399' : '#a78bfa') : '#64748b' }}>
              {k === 'uf' ? 'Union-Find' : 'MWPM'}
            </button>
          ))}
        </div>
        <button onClick={() => setSeed((s) => s + 1)} style={btn('#7c3aed')}>🎲 sample history</button>
      </div>

      <SpaceTimeStrip code={code} shot={shot} />

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Metric label="detector layers" value={String(shot.layers)} color="#67e8f9" />
        <Metric label="detection events" value={String(shot.nDefects)} color={COL.defect} />
        <Metric label="accumulated X errors" value={String(shot.accumulated.length)} color={COL.err} />
        <Metric label="correction weight" value={String(shot.correction.length)} color={COL.corr} />
        <Metric label="residual weight" value={String(shot.residual.length)} color="#94a3b8" />
        <div style={{
          padding: '10px 14px', borderRadius: 8, textAlign: 'center', fontWeight: 800, fontSize: 13, alignSelf: 'stretch',
          display: 'flex', alignItems: 'center',
          background: shot.logicalError ? 'rgba(220,38,38,0.15)' : 'rgba(16,185,129,0.15)',
          border: `1px solid ${shot.logicalError ? '#dc2626' : '#10b981'}`,
          color: shot.logicalError ? '#f87171' : '#34d399',
        }}>
          {shot.logicalError ? '✗ LOGICAL ERROR' : '✓ corrected'}
        </div>
      </div>
    </Card>
  );
}

/** A horizontal strip of per-round mini-lattices showing which checks fired a detector. */
function SpaceTimeStrip({ code, shot }: { code: SurfaceCode; shot: SpaceTimeShot }) {
  const zStabs = code.zStabIdx;
  const cell = Math.min(20, 150 / code.d);
  const m = cell;
  const W = m * 2 + (code.d - 1) * cell;
  return (
    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6 }}>
      {shot.defectLayers.map((layer, t) => {
        const fired = new Set(layer);
        return (
          <div key={t} style={{ flex: '0 0 auto', textAlign: 'center' }}>
            <svg width={W} height={W} viewBox={`0 0 ${W} ${W}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: `1px solid ${t === shot.layers - 1 ? '#34d399' : '#1e293b'}` }}>
              {/* faint data-qubit grid */}
              {code.data.map((dq, q) => (
                <circle key={q} cx={m + dq.c * cell} cy={m + dq.r * cell} r={1.6} fill="#1e293b" />
              ))}
              {/* Z-check positions, lit if a detector fired */}
              {zStabs.map((gi) => {
                const s = code.stabs[gi];
                const x = m + s.cx * cell, y = m + s.cy * cell;
                const on = fired.has(gi);
                return <circle key={gi} cx={x} cy={y} r={on ? cell * 0.34 : cell * 0.14}
                  fill={on ? COL.defect : '#334155'} fillOpacity={on ? 0.95 : 0.4}
                  stroke={on ? COL.defect : 'none'} strokeWidth={on ? 1.5 : 0} />;
              })}
            </svg>
            <div style={{ fontSize: 9, color: t === shot.layers - 1 ? '#34d399' : '#64748b', marginTop: 2 }}>
              {t === shot.layers - 1 ? 'final ✓' : `round ${t}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finite-size scaling: Λ ratios + universal data collapse
// ---------------------------------------------------------------------------

function ScalingCard() {
  const [model, setModel] = useState<Model>('code-capacity');
  const [kind, setKind] = useState<DecoderKind>('mwpm');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{
    lambda: { d: number; lambda: number; pL_d: number; pL_d2: number }[];
    lamP: number;
    collapse: CollapseResult;
  } | null>(null);

  const run = () => {
    setBusy(true);
    setTimeout(() => {
      const seed = (Math.random() * 1e9) | 0;
      const lamP = model === 'phenom' ? 0.02 : 0.05;
      const lambda = lambdaRatios({ distances: [3, 5, 7, 9], p: lamP, samples: model === 'phenom' ? 1500 : 4000, seed, model, kind }).pairs;

      const distances = [3, 5, 7];
      const ps = model === 'phenom'
        ? [0.02, 0.025, 0.03, 0.035, 0.04, 0.045]
        : [0.08, 0.09, 0.10, 0.11, 0.12, 0.13];
      const rng = mulberry32(seed ^ 0x9e37);
      const pts: { d: number; p: number; pL: number }[] = [];
      const samples = model === 'phenom' ? 1200 : 2500;
      for (const dd of distances) for (const pp of ps) {
        const rate = model === 'phenom'
          ? phenomLogicalErrorRate(dd, pp, samples, rng, { kind })
          : codeCapacityRate(dd, pp, samples, rng, kind);
        pts.push({ d: dd, p: pp, pL: rate });
      }
      const collapse = collapseFit(pts, model === 'phenom'
        ? { pthRange: [0.015, 0.05], nuRange: [0.8, 1.8], grid: 36 }
        : { pthRange: [0.07, 0.13], nuRange: [0.8, 1.8], grid: 36 });

      setOut({ lambda, lamP, collapse });
      setBusy(false);
    }, 20);
  };

  return (
    <Card title="Finite-size scaling — Λ ratios & universal collapse" accent="#fbbf24">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Two sharper readouts of fault tolerance. <b style={{ color: '#fbbf24' }}>Λ<sub>d</sub> = p<sub>L</sub>(d)/p<sub>L</sub>(d+2)</b> is
        the suppression factor from two extra rows of qubits: Λ &gt; 1 (and growing) means the code is working.
        And near threshold every curve is a single function of <b>x = (p − p<sub>th</sub>)·d<sup>1/ν</sup></b> — fitting
        the (p<sub>th</sub>, ν) that <b>collapse</b> all the data onto one curve is the gold-standard threshold estimate.
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['code-capacity', 'phenom'] as Model[]).map((mo) => (
            <button key={mo} onClick={() => { setModel(mo); setOut(null); }} style={pill(model === mo)}>
              {mo === 'phenom' ? 'phenomenological' : 'code capacity'}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['mwpm', 'uf'] as DecoderKind[]).map((k) => (
            <button key={k} onClick={() => { setKind(k); setOut(null); }}
              style={{ ...pill(kind === k), color: kind === k ? (k === 'uf' ? '#34d399' : '#a78bfa') : '#64748b' }}>
              {k === 'uf' ? 'Union-Find' : 'MWPM'}
            </button>
          ))}
        </div>
        <button onClick={run} disabled={busy} style={btn('#d97706')}>{busy ? 'Running…' : '▶ Run scaling analysis'}</button>
      </div>

      {out && (
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 16, alignItems: 'start' }}>
          <div>
            <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', marginBottom: 6 }}>Λ at p = {(out.lamP * 100).toFixed(0)}%</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {out.lambda.map((x) => (
                <div key={x.d} style={{ background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 6, padding: '5px 10px' }}>
                  <div style={{ fontSize: 10, color: '#94a3b8' }}>Λ<sub>{x.d}</sub> = p<sub>L</sub>({x.d})/p<sub>L</sub>({x.d + 2})</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: x.lambda > 1 ? '#34d399' : '#f87171', fontFamily: 'monospace' }}>
                    {Number.isFinite(x.lambda) ? x.lambda.toFixed(2) : '∞'}×
                  </div>
                  <div style={{ fontSize: 8, color: '#475569', fontFamily: 'monospace' }}>{x.pL_d.toExponential(1)} → {x.pL_d2.toExponential(1)}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
              <Metric label="fitted p_th" value={`${(out.collapse.pth * 100).toFixed(1)}%`} color="#fbbf24" />
              <Metric label="ν" value={out.collapse.nu.toFixed(2)} color="#67e8f9" />
            </div>
          </div>
          <CollapsePlot c={out.collapse} />
        </div>
      )}
    </Card>
  );
}

function CollapsePlot({ c }: { c: CollapseResult }) {
  const w = 460, h = 280, padL = 50, padB = 38, padT = 14, padR = 14;
  const xs0 = c.points.map((p) => p.x).concat(c.curve.map((q) => q.x));
  const ys0 = c.points.map((p) => p.pL).concat(c.curve.map((q) => q.y));
  const xMin = Math.min(...xs0), xMax = Math.max(...xs0);
  const yMin = Math.min(0, ...ys0), yMax = Math.max(...ys0) * 1.05 || 1;
  const X = (x: number) => padL + ((x - xMin) / (xMax - xMin || 1)) * (w - padL - padR);
  const Y = (y: number) => padT + (1 - (y - yMin) / (yMax - yMin || 1)) * (h - padT - padB);
  const dists = [...new Set(c.points.map((p) => p.d))].sort((a, b) => a - b);
  const curvePath = c.curve.map((q, i) => `${i === 0 ? 'M' : 'L'}${X(q.x).toFixed(1)},${Y(q.y).toFixed(1)}`).join(' ');
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 8, border: '1px solid #1e293b' }}>
        <path d={curvePath} fill="none" stroke="#fbbf24" strokeWidth={2} opacity={0.55} strokeDasharray="4 3" />
        {c.points.map((pt, i) => {
          const di = dists.indexOf(pt.d);
          return <circle key={i} cx={X(pt.x)} cy={Y(pt.pL)} r={3.4} fill={DIST_COLORS[di % DIST_COLORS.length]} opacity={0.95} />;
        })}
        <line x1={X(0)} y1={padT} x2={X(0)} y2={h - padB} stroke="#7c3aed" strokeWidth={1.2} strokeDasharray="5 4" opacity={0.6} />
        <text x={X(0)} y={padT + 10} fontSize={9} fill="#a78bfa" textAnchor="middle">p = p_th</text>
        <text x={padL - 38} y={padT + (h - padT - padB) / 2} fontSize={10} fill="#64748b" textAnchor="middle" transform={`rotate(-90 ${padL - 38} ${padT + (h - padT - padB) / 2})`}>logical error rate</text>
        <text x={(w + padL) / 2} y={h - 4} fontSize={10} fill="#64748b" textAnchor="middle">rescaled (p − p_th)·d^(1/ν)</text>
      </svg>
      <div style={{ display: 'flex', gap: 14, marginTop: 8, justifyContent: 'center' }}>
        {dists.map((d, di) => (
          <span key={d} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#94a3b8' }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: DIST_COLORS[di % DIST_COLORS.length], display: 'inline-block' }} /> d = {d}
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
