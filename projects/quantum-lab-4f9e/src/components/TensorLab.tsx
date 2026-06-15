import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { MPS } from '../quantum/MPS';
import { QuantumState, type GateOp } from '../quantum/QuantumState';
import { tebdQuench, exactTFIM, type TEBDResult, type TEBDFrame } from '../quantum/tebd';

/**
 * Tensor-Network lab: a fourth simulation paradigm. Build a circuit on many qubits,
 * pick a bond-dimension ceiling χ, and watch the Matrix Product State engine store and
 * evolve states that would need 2ⁿ amplitudes — plus a live transverse-field-Ising
 * quench evolved with TEBD.
 */

type Preset = 'GHZ chain' | 'Cluster state' | 'Quantum Fourier transform' | 'Random brickwork';

// small deterministic PRNG so a given (preset, n, depth, seed) is reproducible
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCircuit(preset: Preset, n: number, depth: number, seed: number): GateOp[] {
  const ops: GateOp[] = [];
  if (preset === 'GHZ chain') {
    ops.push({ name: 'H', qubits: [0] });
    for (let q = 0; q + 1 < n; q++) ops.push({ name: 'CNOT', qubits: [q, q + 1] });
  } else if (preset === 'Cluster state') {
    for (let q = 0; q < n; q++) ops.push({ name: 'H', qubits: [q] });
    for (let q = 0; q + 1 < n; q++) ops.push({ name: 'CZ', qubits: [q, q + 1] });
  } else if (preset === 'Quantum Fourier transform') {
    for (let j = 0; j < n; j++) {
      ops.push({ name: 'H', qubits: [j] });
      for (let k = j + 1; k < n; k++) ops.push({ name: 'CPhase', qubits: [j, k], params: [Math.PI / 2 ** (k - j)] });
    }
  } else {
    // random brickwork: alternating layers of single-qubit rotations + CZ bricks
    const rnd = mulberry32(seed * 2654435761 + n * 40503 + depth);
    for (let d = 0; d < depth; d++) {
      for (let q = 0; q < n; q++) {
        ops.push({ name: 'Ry', qubits: [q], params: [rnd() * Math.PI] });
        ops.push({ name: 'Rz', qubits: [q], params: [rnd() * 2 * Math.PI] });
      }
      for (let q = d % 2; q + 1 < n; q += 2) ops.push({ name: 'CZ', qubits: [q, q + 1] });
    }
  }
  return ops;
}

interface MpsRun {
  n: number;
  bondDims: number[];
  entropy: number[];
  maxBond: number;
  params: number;
  gates: number;
  trunc: number;
  verifyErr: number | null;
  sampleTop: { idx: number; count: number }[];
  shots: number;
}

function runMps(preset: Preset, n: number, depth: number, chi: number, seed: number): MpsRun {
  const ops = buildCircuit(preset, n, depth, seed);
  const mps = new MPS(n, chi);
  mps.applyCircuit(ops);
  const bondDims = mps.bondDims();
  const entropy = mps.entropyProfile();
  // cross-check against the exact state vector when it still fits
  let verifyErr: number | null = null;
  if (n <= 12) {
    const sv = new QuantumState(n); ops.forEach((o) => sv.applyGate(o)); sv.normalize();
    const vec = mps.toStateVector();
    const norm = Math.sqrt(vec.reduce((s, z) => s + z.abs2(), 0)) || 1;
    let err = 0;
    for (let i = 0; i < (1 << n); i++) err = Math.max(err, vec[i].scale(1 / norm).sub(sv.amplitudes[i]).abs());
    verifyErr = err;
  }
  const shots = 2000;
  const counts = mps.sampleCounts(shots);
  const sampleTop = [...counts.entries()]
    .map(([idx, count]) => ({ idx, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return {
    n, bondDims, entropy,
    maxBond: mps.maxBondDim(),
    params: mps.paramCount(),
    gates: ops.length,
    trunc: mps.truncationError,
    verifyErr,
    sampleTop, shots,
  };
}

export default function TensorLab() {
  return (
    <div style={{ maxWidth: 780 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        A fourth simulation engine, built from scratch: a <b style={{ color: '#a78bfa' }}>Matrix Product
        State</b> (tensor network). A pure state is written as a chain of rank-3 tensors,
        <code style={{ color: '#67e8f9' }}> |ψ⟩ = Σ A⁰A¹⋯Aⁿ⁻¹</code>, where the <i>bond dimension</i> χ
        is the rank of the Schmidt decomposition across each cut. States with bounded entanglement —
        GHZ, cluster and graph states, shallow circuits, ground states of gapped 1-D chains — keep χ
        small, so the MPS stores them in <b>O(n·χ²)</b> numbers and applies a gate in O(χ³): that is how
        this engine reaches qubit counts the 2ⁿ state vector can never hold. Two-qubit gates are
        re-split with a from-scratch complex <b style={{ color: '#a78bfa' }}>SVD</b> and truncated to χ —
        a controlled approximation whose discarded weight is reported exactly.
      </p>

      <CircuitCard />
      <QuenchCard />
    </div>
  );
}

function CircuitCard() {
  const [preset, setPreset] = useState<Preset>('GHZ chain');
  const [n, setN] = useState(24);
  const [depth, setDepth] = useState(6);
  const [chi, setChi] = useState(16);
  const [seed, setSeed] = useState(1);

  const isBrick = preset === 'Random brickwork';
  const run = useMemo(() => runMps(preset, n, depth, chi, seed), [preset, n, depth, chi, seed]);

  const denseAmps = n <= 53 ? Math.pow(2, n) : Infinity;
  const compression = denseAmps === Infinity ? '> 10¹⁵×' : `${(denseAmps / run.params).toExponential(1)}×`;

  return (
    <Card title="Circuit → Matrix Product State" accent="#a78bfa">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
        <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} style={sel}>
          {(['GHZ chain', 'Cluster state', 'Quantum Fourier transform', 'Random brickwork'] as Preset[]).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <Slider label="qubits" min={3} max={40} value={n} onChange={setN} color="#7c3aed" accent="#a78bfa" />
        {isBrick && <Slider label="depth" min={1} max={10} value={depth} onChange={setDepth} color="#7c3aed" accent="#a78bfa" />}
        <Slider label="max χ" min={1} max={16} value={chi} onChange={setChi} color="#0891b2" accent="#67e8f9" />
        {isBrick && <button onClick={() => setSeed((s) => s + 1)} style={btn('#7c3aed')}>⟳ reshuffle</button>}
      </div>

      <div style={{ display: 'flex', gap: 10, margin: '12px 0', flexWrap: 'wrap' }}>
        <Metric label="MPS parameters" value={run.params.toLocaleString()} color="#34d399" />
        <Metric label="Dense amplitudes (2ⁿ)" value={denseAmps === Infinity ? '> 10¹⁵' : denseAmps.toLocaleString()} color="#f87171" />
        <Metric label="Compression" value={compression} color="#67e8f9" />
        <Metric label="Max bond χ reached" value={`${run.maxBond}`} color="#a78bfa" />
        <Metric label="Truncated weight" value={run.trunc < 1e-12 ? 'exact (0)' : run.trunc.toExponential(2)} color={run.trunc < 1e-9 ? '#34d399' : '#fbbf24'} />
        {run.verifyErr !== null && (
          <Metric label="vs exact state vector" value={run.verifyErr < 1e-9 ? '✓ exact' : `${run.verifyErr.toExponential(1)}`} color={run.verifyErr < 1e-6 ? '#34d399' : '#fbbf24'} />
        )}
      </div>

      <Label>Bond dimension across the chain (the Schmidt rank of each cut)</Label>
      <BarRow values={run.bondDims.slice(1, -1)} color="#7c3aed" fmt={(v) => `${v}`} cap={chi} />

      <Label>Entanglement entropy per cut (bits)</Label>
      <BarRow values={run.entropy} color="#22d3ee" fmt={(v) => v.toFixed(2)} cap={Math.log2(chi) || 1} />

      <Label>Perfect sampling — {run.shots.toLocaleString()} shots (top outcomes)</Label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {run.sampleTop.length === 0 && <span style={{ fontSize: 11, color: '#475569' }}>—</span>}
        {run.sampleTop.map(({ idx, count }) => (
          <span key={idx} style={{ fontFamily: 'monospace', fontSize: 10, color: '#94a3b8', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 6, padding: '3px 7px' }}>
            |{idx.toString(2).padStart(Math.min(run.n, 16), '0').slice(0, 16)}{run.n > 16 ? '…' : ''}⟩
            <span style={{ color: '#a78bfa', marginLeft: 6 }}>{((count / run.shots) * 100).toFixed(1)}%</span>
          </span>
        ))}
      </div>

      <p style={{ fontSize: 10, color: '#475569', margin: '12px 0 0', lineHeight: 1.5 }}>
        GHZ and cluster states stay at χ=2 (1 bit per cut) for any n — exact at any width. The QFT and
        deep random brickwork drive χ up toward 2^(n/2); once it hits the ceiling the SVD truncates the
        smallest Schmidt values and the discarded weight above becomes nonzero. For n ≤ 12 every
        amplitude is checked against the exact state-vector engine.
      </p>
    </Card>
  );
}

function QuenchCard() {
  const [n, setN] = useState(20);
  const [h, setH] = useState(0.8);
  const [chi, setChi] = useState(16);
  const [res, setRes] = useState<TEBDResult | null>(null);
  const [exactErr, setExactErr] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const J = 1, dt = 0.05, steps = 60;

  const doRun = () => {
    setBusy(true);
    setTimeout(() => {
      const r = tebdQuench({ n, J, h, dt, steps, maxBond: chi });
      let err: number | null = null;
      if (n <= 8) {
        const ex = exactTFIM(n, J, h, dt, steps);
        let e = 0; for (let s = 0; s <= steps; s++) e = Math.max(e, Math.abs(r.frames[s].mx - ex[s].mx));
        err = e;
      }
      setRes(r); setExactErr(err); setBusy(false);
    }, 20);
  };

  return (
    <Card title="TEBD — real-time quench of the transverse-field Ising chain" accent="#34d399">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Prepare the fully-polarised <code style={{ color: '#67e8f9' }}>|0…0⟩</code> and quench it with
        <code style={{ color: '#67e8f9' }}> H = −J Σ ZᵢZᵢ₊₁ − h Σ Xᵢ</code>. Each bond Hamiltonian is
        exponentiated exactly and applied in a 2nd-order Trotter sweep, truncating to χ after every gate.
        Watch the famous quench physics: the half-chain entanglement grows <i>linearly</i> in time (a
        correlation light-cone) while the transverse magnetisation oscillates.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Slider label="qubits" min={4} max={32} value={n} onChange={setN} color="#059669" accent="#34d399" />
        <Slider label="field h" min={0.1} max={2} step={0.1} value={h} onChange={setH} color="#059669" accent="#34d399" fmt={(v) => v.toFixed(1)} />
        <Slider label="max χ" min={2} max={16} value={chi} onChange={setChi} color="#0891b2" accent="#67e8f9" />
        <button onClick={doRun} disabled={busy} style={btn('#059669')}>{busy ? 'Evolving…' : '▶ Run quench'}</button>
      </div>
      {res && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <Metric label="final entropy S(t)" value={`${res.frames[res.frames.length - 1].entropy.toFixed(2)} bits`} color="#a78bfa" />
            <Metric label="max bond reached" value={`${Math.max(...res.frames.map((f) => f.maxBond))}`} color="#67e8f9" />
            <Metric label="truncated weight" value={res.frames[res.frames.length - 1].trunc.toExponential(2)} color="#fbbf24" />
            {exactErr !== null && <Metric label="vs exact evolution" value={exactErr.toExponential(1)} color={exactErr < 1e-2 ? '#34d399' : '#f87171'} />}
          </div>
          <Label>Half-chain entanglement entropy vs time (the light-cone)</Label>
          <LinePlot frames={res.frames} pick={(f) => f.entropy} color="#22d3ee" yLabel="S(t) bits" />
          <Label>Transverse ⟨X⟩ (cyan) and longitudinal ⟨Z⟩ (violet) magnetisation</Label>
          <LinePlot frames={res.frames} pick={(f) => f.mx} color="#22d3ee" pick2={(f) => f.mz} color2="#a78bfa" yLabel="magnetisation" symmetric />
        </motion.div>
      )}
    </Card>
  );
}

// ---- shared mini-widgets ----------------------------------------------------------
function Slider({ label, min, max, value, onChange, color, accent, step = 1, fmt }:
  { label: string; min: number; max: number; value: number; onChange: (v: number) => void; color: string; accent: string; step?: number; fmt?: (v: number) => string }) {
  return (
    <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' }}>
      {label}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} style={{ accentColor: color }} />
      <span style={{ fontFamily: 'monospace', color: accent, width: 30 }}>{fmt ? fmt(value) : value}</span>
    </label>
  );
}

function BarRow({ values, color, fmt, cap }: { values: number[]; color: string; fmt: (v: number) => string; cap: number }) {
  const max = Math.max(cap, ...values, 1e-9);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 64, background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 6, padding: '6px 8px', marginBottom: 14, overflowX: 'auto' }}>
      {values.map((v, i) => (
        <div key={i} title={`cut ${i + 1}: ${fmt(v)}`} style={{ flex: '1 0 4px', minWidth: 3, height: `${Math.max((v / max) * 100, 2)}%`, background: color, borderRadius: '2px 2px 0 0', opacity: 0.85 }} />
      ))}
    </div>
  );
}

function LinePlot({ frames, pick, color, pick2, color2, yLabel, symmetric }:
  { frames: TEBDFrame[]; pick: (f: TEBDFrame) => number; color: string; pick2?: (f: TEBDFrame) => number; color2?: string; yLabel: string; symmetric?: boolean }) {
  const w = 520, h = 150, pad = 32;
  const tMax = frames[frames.length - 1].t || 1;
  const vals = frames.map(pick).concat(pick2 ? frames.map(pick2) : []);
  const vMax = symmetric ? 1 : Math.max(...vals, 1e-6) * 1.1;
  const vMin = symmetric ? -1 : 0;
  const xs = (t: number) => pad + (t / tMax) * (w - pad - 10);
  const ys = (v: number) => 10 + (1 - (v - vMin) / (vMax - vMin)) * (h - pad - 10);
  const pathOf = (f: (x: TEBDFrame) => number) => frames.map((fr, i) => `${i === 0 ? 'M' : 'L'}${xs(fr.t).toFixed(1)},${ys(f(fr)).toFixed(1)}`).join(' ');
  const ticks = symmetric ? [-1, 0, 1] : [0, vMax / 2, vMax];
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 14 }}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad} y1={ys(v)} x2={w - 10} y2={ys(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 4} y={ys(v) + 3} fontSize={8} fill="#475569" textAnchor="end">{v.toFixed(1)}</text>
        </g>
      ))}
      {pick2 && <path d={pathOf(pick2)} fill="none" stroke={color2} strokeWidth={1.8} opacity={0.85} />}
      <path d={pathOf(pick)} fill="none" stroke={color} strokeWidth={1.8} />
      <text x={w - 10} y={h - 6} fontSize={9} fill="#64748b" textAnchor="end">time t</text>
      <text x={pad - 4} y={8} fontSize={9} fill="#64748b" textAnchor="end">{yLabel}</text>
    </svg>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, margin: '4px 0 6px' }}>{children}</div>;
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
