import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Stabilizer, type Generator } from '../quantum/Stabilizer';
import { steanePrepZeroL, runSteane, type ErrorType } from '../quantum/steane';
import { randomizedBenchmark, type RBResult } from '../quantum/rb';
import { CHANNEL_INFO, type ChannelType } from '../quantum/noise';
import type { GateOp } from '../quantum/QuantumState';

type PresetKey = 'GHZ' | 'Line graph' | 'Ring graph' | 'Steane |0⟩ₗ';

/** Build a Clifford circuit for a preset on n qubits. */
function presetOps(key: PresetKey, n: number): { n: number; ops: GateOp[] } {
  if (key === 'Steane |0⟩ₗ') return { n: 7, ops: steanePrepZeroL() };
  const ops: GateOp[] = [];
  if (key === 'GHZ') {
    ops.push({ name: 'H', qubits: [0] });
    for (let q = 0; q < n - 1; q++) ops.push({ name: 'CNOT', qubits: [q, q + 1] });
    return { n, ops };
  }
  // Graph states: H on all, then CZ on each edge of a line or ring.
  for (let q = 0; q < n; q++) ops.push({ name: 'H', qubits: [q] });
  const edges: [number, number][] = [];
  for (let q = 0; q < n - 1; q++) edges.push([q, q + 1]);
  if (key === 'Ring graph' && n > 2) edges.push([n - 1, 0]);
  for (const [a, b] of edges) ops.push({ name: 'CZ', qubits: [a, b] });
  return { n, ops };
}

const PAULI_COLOR: Record<string, string> = { X: '#f87171', Y: '#fbbf24', Z: '#34d399', I: '#334155' };

function GeneratorRow({ gen, index }: { gen: Generator; index: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'monospace', fontSize: 13, lineHeight: 1.7 }}>
      <span style={{ color: '#475569', fontSize: 10, width: 24 }}>g{index + 1}</span>
      <span style={{ color: gen.sign < 0 ? '#f87171' : '#475569', width: 10 }}>{gen.sign < 0 ? '−' : '+'}</span>
      {gen.paulis.map((p, q) => (
        <span key={q} style={{ color: PAULI_COLOR[p], fontWeight: p === 'I' ? 400 : 800, width: 12, textAlign: 'center' }}>{p}</span>
      ))}
    </div>
  );
}

export default function StabilizerLab() {
  const [preset, setPreset] = useState<PresetKey>('GHZ');
  const [nQubits, setNQubits] = useState(5);
  const scalable = preset === 'GHZ' || preset === 'Line graph' || preset === 'Ring graph';

  const { generators, n, gateCount } = useMemo(() => {
    const { n, ops } = presetOps(preset, nQubits);
    const st = Stabilizer.fromCircuit(n, ops);
    return { generators: st.generators(), n, gateCount: ops.length };
  }, [preset, nQubits]);

  const svBytes = n <= 53 ? (1 << Math.min(n, 30)) * 16 : Infinity;
  const tableauBytes = 2 * n * (2 * n + 1);
  const showGen = generators.slice(0, 16);

  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        A second simulation engine built from scratch: the <b style={{ color: '#a78bfa' }}>Aaronson–Gottesman
        stabilizer tableau</b>. A Clifford circuit's state is the joint <code style={{ color: '#67e8f9' }}>+1</code>
        eigenstate of <i>n</i> Pauli generators, so tracking those <i>n</i> strings — instead of 2ⁿ
        amplitudes — simulates H, S, the Paulis, CNOT, CZ and SWAP in <b>polynomial</b> time. That is
        the Gottesman–Knill theorem, and it is why a 30-qubit entangled state is instant here.
      </p>

      <Card title="Stabilizer generators" accent="#a78bfa">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <select value={preset} onChange={(e) => setPreset(e.target.value as PresetKey)} style={sel}>
            {(['GHZ', 'Line graph', 'Ring graph', 'Steane |0⟩ₗ'] as PresetKey[]).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          {scalable && (
            <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' }}>
              qubits
              <input type="range" min={2} max={30} value={nQubits} onChange={(e) => setNQubits(parseInt(e.target.value))} style={{ accentColor: '#7c3aed' }} />
              <span style={{ fontFamily: 'monospace', color: '#a78bfa', width: 22 }}>{nQubits}</span>
            </label>
          )}
          <span style={{ fontSize: 10, color: '#475569', fontFamily: 'monospace' }}>{n} qubits · {gateCount} Clifford gates</span>
        </div>

        <div style={{ background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 14px', overflowX: 'auto' }}>
          {showGen.map((g, i) => <GeneratorRow key={i} gen={g} index={i} />)}
          {generators.length > showGen.length && (
            <div style={{ color: '#475569', fontSize: 11, marginTop: 6 }}>… and {generators.length - showGen.length} more generators</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <Metric label="State-vector memory" value={svBytes === Infinity ? '> EB' : fmtBytes(svBytes)} color="#f87171" />
          <Metric label="Tableau memory" value={`${tableauBytes} bits`} color="#34d399" />
          <Metric label="Compression" value={svBytes === Infinity ? 'astronomical' : `${(svBytes * 8 / tableauBytes).toExponential(1)}×`} color="#67e8f9" />
        </div>
        <p style={{ fontSize: 10, color: '#475569', margin: '8px 0 0', lineHeight: 1.5 }}>
          GHZ generators read <code style={{ color: '#67e8f9' }}>+XX…X</code> then <code style={{ color: '#67e8f9' }}>+Zᵢ Zᵢ₊₁</code>;
          a graph state's are the canonical <code style={{ color: '#67e8f9' }}>Kᵥ = Xᵥ ∏ Z₍ᵥ₎</code>. These generate the
          full stabilizer group of 2ⁿ Paulis that fix the state.
        </p>
      </Card>

      <SteaneCard />
      <RBCard />
    </div>
  );
}

function SteaneCard() {
  const [type, setType] = useState<ErrorType>('Y');
  const [qubit, setQubit] = useState(2);
  const run = useMemo(() => runSteane({ type, qubit }), [type, qubit]);
  const synStr = (s: [number, number, number]) => s.join('');

  return (
    <Card title="Steane [[7,1,3]] code — live syndrome decoding" accent="#67e8f9">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Encode the logical |0⟩ₗ across 7 qubits, inject any single-qubit Pauli error, and watch the
        stabilizer tableau report the 3-bit X- and Z-syndromes that pinpoint it (qubit q carries
        Hamming column q+1, so the syndrome <i>is</i> the position in binary). The error is then
        corrected and every stabilizer verified back at +1.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={type} onChange={(e) => setType(e.target.value as ErrorType)} style={sel}>
          {(['X', 'Y', 'Z'] as ErrorType[]).map((t) => <option key={t} value={t}>{t} error</option>)}
        </select>
        <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' }}>
          on qubit
          <input type="range" min={0} max={6} value={qubit} onChange={(e) => setQubit(parseInt(e.target.value))} style={{ accentColor: '#0891b2' }} />
          <span style={{ fontFamily: 'monospace', color: '#67e8f9', width: 14 }}>{qubit}</span>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Metric label="Z-syndrome (→ X err)" value={synStr(run.zSyndrome)} color="#f87171" />
        <Metric label="located bit-flip" value={run.detectedXAt < 0 ? 'none' : `q${run.detectedXAt}`} color="#f87171" />
        <Metric label="X-syndrome (→ Z err)" value={synStr(run.xSyndrome)} color="#34d399" />
        <Metric label="located phase-flip" value={run.detectedZAt < 0 ? 'none' : `q${run.detectedZAt}`} color="#34d399" />
        <Metric label="recovered" value={run.recovered ? '✓ yes' : '✗ no'} color={run.recovered ? '#34d399' : '#f87171'} />
      </div>
    </Card>
  );
}

const RB_CHANNELS: ChannelType[] = ['depolarizing', 'amplitude-damping', 'phase-damping', 'bit-flip'];

function RBCard() {
  const [channel, setChannel] = useState<ChannelType>('depolarizing');
  const [strength, setStrength] = useState(0.04);
  const [res, setRes] = useState<RBResult | null>(null);
  const [busy, setBusy] = useState(false);

  const doRun = () => {
    setBusy(true);
    setTimeout(() => {
      setRes(randomizedBenchmark({ channel, strength, sequences: 16, lengths: [1, 2, 4, 8, 16, 32, 64, 128] }));
      setBusy(false);
    }, 20);
  };

  return (
    <Card title="Randomized benchmarking" accent="#34d399">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        The industry-standard way to measure gate quality. Random Clifford sequences (closed with the
        exact inverse) <i>twirl</i> any noise into a depolarizing channel, so the survival probability
        decays as <code style={{ color: '#67e8f9' }}>p(m) = ½ + A·fᵐ</code> and the single number <i>f</i>
        gives the average error per gate — immune to state-prep and measurement errors.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={channel} onChange={(e) => setChannel(e.target.value as ChannelType)} style={sel}>
          {RB_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_INFO[c].label}</option>)}
        </select>
        <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' }}>
          strength p
          <input type="range" min={0} max={0.2} step={0.005} value={strength} onChange={(e) => setStrength(parseFloat(e.target.value))} style={{ accentColor: '#059669' }} />
          <span style={{ fontFamily: 'monospace', color: '#34d399', width: 36 }}>{strength.toFixed(3)}</span>
        </label>
        <button onClick={doRun} disabled={busy} style={btn('#059669')}>{busy ? 'Running…' : '▶ Run RB'}</button>
      </div>
      {res && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <Metric label="decay f" value={res.fit.f.toFixed(4)} color="#a78bfa" />
            <Metric label="avg error / Clifford" value={res.fit.r.toFixed(4)} color="#f87171" />
            <Metric label="avg gate fidelity" value={(1 - res.fit.r).toFixed(4)} color="#34d399" />
          </div>
          <RBPlot res={res} />
        </motion.div>
      )}
    </Card>
  );
}

function RBPlot({ res }: { res: RBResult }) {
  const w = 480, h = 150, pad = 28;
  const maxM = Math.max(...res.points.map((p) => p.length));
  const xs = (m: number) => pad + (Math.log2(m + 1) / Math.log2(maxM + 1)) * (w - pad - 8);
  const ys = (v: number) => 8 + (1 - (v - 0.5) / 0.5) * (h - pad - 8);
  const steps = 60;
  let path = '';
  for (let i = 0; i <= steps; i++) {
    const m = (maxM * i) / steps;
    path += `${i === 0 ? 'M' : 'L'}${xs(m).toFixed(1)},${ys(res.curve(m)).toFixed(1)} `;
  }
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b' }}>
      {[0.5, 0.75, 1].map((v) => (
        <g key={v}>
          <line x1={pad} y1={ys(v)} x2={w - 8} y2={ys(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 4} y={ys(v) + 3} fontSize={8} fill="#475569" textAnchor="end">{v.toFixed(2)}</text>
        </g>
      ))}
      <path d={path} fill="none" stroke="#34d399" strokeWidth={2} opacity={0.8} />
      {res.points.map((p, i) => (
        <circle key={i} cx={xs(p.length)} cy={ys(p.survival)} r={3} fill="#a78bfa" stroke="#0a0f1e" strokeWidth={1} />
      ))}
      {res.points.map((p, i) => (
        <text key={`t${i}`} x={xs(p.length)} y={h - 8} fontSize={8} fill="#475569" textAnchor="middle">{p.length}</text>
      ))}
      <text x={w - 8} y={h - 8} fontSize={9} fill="#64748b" textAnchor="end">sequence length m</text>
      <text x={pad - 4} y={6} fontSize={9} fill="#64748b" textAnchor="end">P(survive)</text>
    </svg>
  );
}

function fmtBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 ? 1 : 0)} ${u[i]}`;
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
