import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  runVQE, runQAOA, tfimHamiltonian, type VQEResult, type QAOAResult, type Graph,
} from '../quantum/variational';

const GRAPHS: Record<string, Graph> = {
  'Triangle (K₃)': { n: 3, edges: [[0, 1], [1, 2], [2, 0]] },
  'Square (C₄)': { n: 4, edges: [[0, 1], [1, 2], [2, 3], [3, 0]] },
  'Bowtie': { n: 5, edges: [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 2]] },
};

export default function VariationalLab() {
  const [vqe, setVqe] = useState<VQEResult | null>(null);
  const [qaoa, setQaoa] = useState<{ res: QAOAResult; graph: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [graphKey, setGraphKey] = useState<keyof typeof GRAPHS | string>('Square (C₄)');
  const [layers, setLayers] = useState(2);

  const doVQE = () => {
    setBusy('vqe');
    setTimeout(() => { setVqe(runVQE(tfimHamiltonian())); setBusy(null); }, 20);
  };
  const doQAOA = () => {
    setBusy('qaoa');
    setTimeout(() => { setQaoa({ res: runQAOA(GRAPHS[graphKey], layers), graph: graphKey }); setBusy(null); }, 20);
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        Hybrid quantum-classical algorithms: the state-vector simulator acts as the "quantum
        processor" while a classical <b>Nelder–Mead</b> optimizer tunes the circuit angles — exactly
        the loop that runs on today's NISQ hardware.
      </p>

      {/* VQE */}
      <Card title="Variational Quantum Eigensolver (VQE)" accent="#a78bfa">
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
          Finds the ground-state energy of the 2-site transverse-field Ising model
          <code style={{ color: '#67e8f9' }}> H = Z₀Z₁ + 0.6(X₀+X₁)</code> with a hardware-efficient
          Ry–CNOT–Ry ansatz. The optimizer minimises ⟨ψ(θ)|H|ψ(θ)⟩.
        </p>
        <button onClick={doVQE} disabled={busy === 'vqe'} style={btn('#7c3aed')}>
          {busy === 'vqe' ? 'Optimizing…' : '▶ Run VQE'}
        </button>
        {vqe && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <Metric label="VQE energy" value={vqe.energy.toFixed(5)} color="#a78bfa" />
              <Metric label="Exact (diagonalised)" value={vqe.exact.toFixed(5)} color="#67e8f9" />
              <Metric label="Error" value={Math.abs(vqe.energy - vqe.exact).toExponential(1)} color="#34d399" />
            </div>
            <ConvergencePlot data={vqe.iterations.map((p) => p.energy)} exact={vqe.exact} />
            <div style={{ fontSize: 10, color: '#475569', marginTop: 6, fontFamily: 'monospace' }}>
              θ* = [{vqe.theta.map((t) => t.toFixed(3)).join(', ')}]
            </div>
          </motion.div>
        )}
      </Card>

      {/* QAOA */}
      <Card title="QAOA — MaxCut" accent="#67e8f9">
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
          The Quantum Approximate Optimization Algorithm partitions a graph's vertices to maximise
          the number of cut edges. Alternating cost (ZZ) and mixer (Rx) layers are tuned to amplify
          optimal-cut bitstrings.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <select value={graphKey} onChange={(e) => setGraphKey(e.target.value)} style={sel}>
            {Object.keys(GRAPHS).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' }}>
            layers p=
            <input type="range" min={1} max={3} value={layers} onChange={(e) => setLayers(parseInt(e.target.value))} style={{ accentColor: '#0891b2' }} />
            <span style={{ fontFamily: 'monospace', color: '#67e8f9' }}>{layers}</span>
          </label>
          <button onClick={doQAOA} disabled={busy === 'qaoa'} style={btn('#0891b2')}>
            {busy === 'qaoa' ? 'Optimizing…' : '▶ Run QAOA'}
          </button>
        </div>
        {qaoa && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <Metric label="Optimal cut" value={String(qaoa.res.maxCut)} color="#67e8f9" />
              <Metric label="QAOA ⟨C⟩" value={qaoa.res.expectedCut.toFixed(3)} color="#a78bfa" />
              <Metric label="Approx ratio" value={(qaoa.res.expectedCut / qaoa.res.maxCut).toFixed(3)} color="#34d399" />
            </div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#475569', textTransform: 'uppercase', marginBottom: 6 }}>Most probable outcomes</div>
            {qaoa.res.topStates.map((s, i) => {
              const bits = s.state.toString(2).padStart(GRAPHS[qaoa.graph].n, '0');
              const optimal = s.cut === qaoa.res.maxCut;
              return (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 70px', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 12, color: optimal ? '#34d399' : '#94a3b8' }}>|{bits}⟩</span>
                  <div style={{ height: 10, background: 'rgba(255,255,255,0.05)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${s.prob * 100}%`, background: optimal ? 'linear-gradient(90deg,#059669,#34d399)' : 'linear-gradient(90deg,#7c3aed,#0891b2)', borderRadius: 3 }} />
                  </div>
                  <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#64748b', textAlign: 'right' }}>cut {s.cut} · {(s.prob * 100).toFixed(0)}%</span>
                </div>
              );
            })}
          </motion.div>
        )}
      </Card>
    </div>
  );
}

function ConvergencePlot({ data, exact }: { data: number[]; exact: number }) {
  const w = 480, h = 90, pad = 4;
  const all = [...data, exact];
  const lo = Math.min(...all), hi = Math.max(...all);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / (data.length - 1 || 1)) * (w - 2 * pad);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (h - 2 * pad);
  const path = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b' }}>
      <line x1={pad} y1={y(exact)} x2={w - pad} y2={y(exact)} stroke="#67e8f9" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
      <text x={w - pad} y={y(exact) - 3} fontSize={9} fill="#67e8f9" textAnchor="end">exact ground</text>
      <path d={path} fill="none" stroke="#a78bfa" strokeWidth={2} />
      {data.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={2} fill="#a78bfa" />)}
    </svg>
  );
}

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
  return { padding: '7px 16px', borderRadius: 8, border: 'none', background: color, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
}
const sel: React.CSSProperties = { padding: '6px 10px', borderRadius: 6, background: '#0a0f1e', color: '#e2e8f0', border: '1px solid #334155', fontSize: 12 };
