import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { type Mat } from '../quantum/kak';
import {
  type QGate, type Shannon, type FTShannon,
  shannonDecompose, optimizeCircuit, circuitToMatrix, distModPhase, faultTolerantShannon,
} from '../quantum/shannon';
import { SHANNON_GATES, seededUnitary } from '../quantum/shannonGates';

const theoretical = (n: number) => Math.round(0.75 * 4 ** n - 3 * 2 ** (n - 1));

export default function ShannonLab() {
  const [gateId, setGateId] = useState('toffoli');
  const [seed, setSeed] = useState(0x2026_0623);
  const [optimize, setOptimize] = useState(true);

  const gate = SHANNON_GATES.find((g) => g.id === gateId)!;
  const n = gate.qubits;

  const U: Mat = useMemo(() => (gate.id.startsWith('rand') ? seededUnitary(n, seed) : gate.make()), [gate, n, seed]);
  const raw: Shannon = useMemo(() => shannonDecompose(U, n), [U, n]);
  const optGates: QGate[] = useMemo(() => optimizeCircuit(raw.gates), [raw]);
  const shown = optimize ? optGates : raw.gates;
  const shownCnots = shown.filter((g) => g.kind === 'cnot').length;
  const shownSingle = shown.length - shownCnots;
  const optErr = useMemo(() => (optimize ? distModPhase(U, circuitToMatrix(optGates, n)) : raw.reconError), [optimize, U, optGates, n, raw]);

  return (
    <div style={{ maxWidth: 880 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        This lab can already compile <b style={{ color: '#a78bfa' }}>one</b> qubit (Solovay–Kitaev) and{' '}
        <b style={{ color: '#a78bfa' }}>two</b> qubits (the KAK decomposition). The{' '}
        <b style={{ color: '#67e8f9' }}>Quantum Shannon Decomposition</b> is the{' '}
        <b style={{ color: '#67e8f9' }}>n-qubit</b> generalisation: recursively split a 2ⁿ×2ⁿ unitary by
        its top qubit with the <b style={{ color: '#34d399' }}>cosine–sine decomposition</b> into two
        quantum multiplexors around a uniformly-controlled Rʏ, demultiplex each multiplexor through the{' '}
        <b style={{ color: '#f59e0b' }}>eigendecomposition of a unitary</b>, and bottom out in the ZYZ
        Euler angles. Every <i>n</i>-qubit gate becomes a {'{'}Rz, Ry, CNOT{'}'} circuit costing exactly{' '}
        <code style={{ color: '#67e8f9' }}>(¾)·4ⁿ − 3·2ⁿ⁻¹</code> CNOTs — built from scratch and reproducing
        the gate to machine precision.
      </p>

      <DecomposeCard
        gateId={gateId} setGateId={setGateId} setSeed={setSeed}
        gate={gate} n={n} raw={raw}
        optimize={optimize} setOptimize={setOptimize}
        shownCnots={shownCnots} shownSingle={shownSingle} optErr={optErr}
      />
      <CircuitCard gates={shown} n={n} />
      <RecursionCard n={n} />
      <ScalingCard n={n} cnots={shownCnots} structured={gate.structured && optimize} />
      <FaultTolerantCard U={U} n={n} cnots={raw.cnots} />
    </div>
  );
}

// ─────────────────────────────── decompose card ───────────────────────────────

function DecomposeCard({
  gateId, setGateId, setSeed, gate, n, raw, optimize, setOptimize, shownCnots, shownSingle, optErr,
}: {
  gateId: string; setGateId: (s: string) => void; setSeed: (n: number) => void;
  gate: typeof SHANNON_GATES[number]; n: number; raw: Shannon;
  optimize: boolean; setOptimize: (b: boolean) => void;
  shownCnots: number; shownSingle: number; optErr: number;
}) {
  const reduced = optimize && shownCnots < raw.cnots;
  return (
    <Card title="Decompose any n-qubit gate into CNOTs + rotations" accent="#a78bfa">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>gate
          <select value={gateId} onChange={(e) => setGateId(e.target.value)} style={sel}>
            {[2, 3, 4, 5].map((q) => (
              <optgroup key={q} label={`${q} qubits`}>
                {SHANNON_GATES.filter((g) => g.qubits === q).map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        {gate.id.startsWith('rand') && (
          <button onClick={() => setSeed((Math.random() * 2 ** 31) >>> 0)} style={btnGhost}>🎲 reseed</button>
        )}
        <label style={{ ...lab, marginLeft: 'auto', cursor: 'pointer' }}>
          <input type="checkbox" checked={optimize} onChange={(e) => setOptimize(e.target.checked)} style={{ accentColor: '#7c3aed' }} />
          peephole optimise
        </label>
      </div>

      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px' }}>{gate.desc}</p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <Stat label="qubits" value={`${n}  ·  ${1 << n}×${1 << n}`} accent="#a78bfa" />
        <Stat label={reduced ? 'CNOTs (optimised)' : 'CNOTs'} value={reduced ? `${shownCnots}  ◂ ${raw.cnots}` : String(shownCnots)} accent="#f59e0b" />
        <Stat label="theoretical (¾·4ⁿ−3·2ⁿ⁻¹)" value={String(theoretical(n))} accent="#64748b" />
        <Stat label="1-qubit gates" value={String(shownSingle)} accent="#67e8f9" />
        <Stat label="reconstruction" value={optErr.toExponential(1)} ok={optErr < 1e-6} />
      </div>
      <p style={{ color: '#475569', fontSize: 10, margin: '6px 0 0', lineHeight: 1.5 }}>
        The synthesised circuit reproduces the gate (up to a global phase) to{' '}
        <b style={{ color: '#34d399' }}>{optErr.toExponential(1)}</b>. A <i>generic</i> gate hits the full{' '}
        <b style={{ color: '#f59e0b' }}>{theoretical(n)}</b>-CNOT bound; structured gates collapse far below it
        under the peephole pass (adjacent CNOT cancellation + rotation fusion).
      </p>
    </Card>
  );
}

// ─────────────────────────────── circuit diagram ───────────────────────────────

function CircuitCard({ gates, n }: { gates: QGate[]; n: number }) {
  const CAP = 150;
  const display = gates.slice(0, CAP);
  const colW = 30, x0 = 44, top = 22, rowH = 34;
  const cols = display.length;
  const width = Math.max(560, x0 + cols * colW + 20);
  const height = top + n * rowH + 16;
  const yq = (q: number) => top + q * rowH;

  return (
    <Card title={`Synthesised {Rz, Ry, CNOT} circuit · ${gates.filter((g) => g.kind === 'cnot').length} CNOTs`} accent="#f59e0b">
      <div style={{ overflowX: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
        <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', minWidth: Math.min(width, 840), height: 'auto', display: 'block' }}>
          {Array.from({ length: n }, (_, q) => (
            <g key={q}>
              <line x1={x0 - 22} y1={yq(q)} x2={width - 8} y2={yq(q)} stroke="#334155" strokeWidth={1.3} />
              <text x={12} y={yq(q) + 4} fill="#64748b" fontSize={11} fontFamily="monospace">q{q}</text>
            </g>
          ))}
          {display.map((g, i) => {
            const cx = x0 + i * colW + colW / 2;
            if (g.kind === 'cnot') {
              const yc = yq(g.control), yt = yq(g.target);
              return (
                <g key={i}>
                  <line x1={cx} y1={yc} x2={cx} y2={yt} stroke="#f59e0b" strokeWidth={1.6} />
                  <circle cx={cx} cy={yc} r={4} fill="#f59e0b" />
                  <circle cx={cx} cy={yt} r={8} fill="none" stroke="#f59e0b" strokeWidth={1.6} />
                  <line x1={cx} y1={yt - 8} x2={cx} y2={yt + 8} stroke="#f59e0b" strokeWidth={1.6} />
                </g>
              );
            }
            const y = yq(g.target);
            const color = g.kind === 'ry' ? '#67e8f9' : '#a78bfa';
            return (
              <g key={i}>
                <rect x={cx - 12} y={y - 11} width={24} height={22} rx={4} fill={`${color}22`} stroke={`${color}99`} strokeWidth={1} />
                <text x={cx} y={y + 3} textAnchor="middle" fill={color} fontSize={9} fontFamily="monospace" fontWeight={700}>{g.kind === 'ry' ? 'Ry' : 'Rz'}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <p style={{ color: '#475569', fontSize: 10, margin: '8px 0 0', lineHeight: 1.5 }}>
        Purple <b style={{ color: '#a78bfa' }}>Rz</b> and cyan <b style={{ color: '#67e8f9' }}>Ry</b> are
        single-qubit rotations; orange links are <b style={{ color: '#f59e0b' }}>CNOTs</b>.
        {gates.length > CAP && <> Showing the first {CAP} of {gates.length} ops.</>}
      </p>
    </Card>
  );
}

// ─────────────────────────────── recursion tree ───────────────────────────────

function RecursionCard({ n }: { n: number }) {
  // Per-level breakdown of the recursion. A k-qubit node emits 3 uniformly-controlled rotations
  // (1 Ry + 2 Rz) of 2^{k-1} CNOTs each = 3·2^{k-1}, and 4 child (k-1)-qubit nodes.
  const rows: { k: number; nodes: number; perNode: number; total: number }[] = [];
  for (let k = n; k >= 2; k--) {
    const nodes = 4 ** (n - k);
    const perNode = 3 * 2 ** (k - 1);
    rows.push({ k, nodes, perNode, total: nodes * perNode });
  }
  const leaves = 4 ** (n - 1);
  const totalCnots = rows.reduce((s, r) => s + r.total, 0);

  return (
    <Card title="The recursion — one cosine–sine split per qubit" accent="#34d399">
      <p style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.6, margin: '0 0 12px' }}>
        Each <b style={{ color: '#67e8f9' }}>k</b>-qubit unitary splits (via the cosine–sine decomposition)
        into <b>4</b> child (k−1)-qubit gates plus <b>3 uniformly-controlled rotations</b> — one central Rʏ
        and two demultiplexed R_z — each costing 2<sup>k−1</sup> CNOTs. Recurse to the 1-qubit ZYZ leaves:
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto auto', gap: '4px 16px', fontSize: 11, fontFamily: 'monospace', marginBottom: 10 }}>
        <div style={hdr}>level</div><div style={hdr}>nodes (4^d)</div><div style={hdr}>CNOTs / node</div><div style={hdr}>CNOTs</div>
        {rows.map((r) => (
          <Row key={r.k}>
            <span style={{ color: '#a78bfa' }}>{r.k}-qubit</span>
            <span style={{ color: '#cbd5e1' }}>{r.nodes}</span>
            <span style={{ color: '#67e8f9' }}>3·2^{r.k - 1} = {r.perNode}</span>
            <span style={{ color: '#f59e0b' }}>{r.total}</span>
          </Row>
        ))}
        <Row>
          <span style={{ color: '#64748b' }}>1-qubit leaves</span>
          <span style={{ color: '#cbd5e1' }}>{leaves}</span>
          <span style={{ color: '#64748b' }}>ZYZ · 0</span>
          <span style={{ color: '#64748b' }}>0</span>
        </Row>
      </div>
      <div style={{ padding: '8px 10px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12, fontFamily: 'monospace', color: '#34d399' }}>
        Σ = {totalCnots} CNOTs = (¾)·4<sup>{n}</sup> − 3·2<sup>{n - 1}</sup> ✓
      </div>
    </Card>
  );
}

// ─────────────────────────────── scaling chart ───────────────────────────────

function ScalingCard({ n, cnots, structured }: { n: number; cnots: number; structured: boolean }) {
  const W = 560, H = 220, padL = 44, padB = 26, padT = 14, padR = 14;
  const ns = [1, 2, 3, 4, 5, 6];
  const vals = ns.map((k) => Math.max(1, theoretical(k)));
  const maxLog = Math.log10(theoretical(6));
  const x = (k: number) => padL + ((k - 1) / 5) * (W - padL - padR);
  const y = (v: number) => padT + (1 - Math.log10(Math.max(1, v)) / maxLog) * (H - padT - padB);

  return (
    <Card title="The cost of universality — CNOTs grow as ¾·4ⁿ" accent="#67e8f9">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: W, height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
        {[1, 10, 100, 1000].map((g) => g <= theoretical(6) && (
          <g key={g}>
            <line x1={padL} y1={y(g)} x2={W - padR} y2={y(g)} stroke="#1e293b" strokeWidth={1} />
            <text x={padL - 6} y={y(g) + 3} textAnchor="end" fill="#475569" fontSize={9} fontFamily="monospace">{g}</text>
          </g>
        ))}
        {ns.map((k) => <text key={k} x={x(k)} y={H - 8} textAnchor="middle" fill="#64748b" fontSize={10} fontFamily="monospace">n={k}</text>)}
        <polyline points={ns.map((k, i) => `${x(k)},${y(vals[i])}`).join(' ')} fill="none" stroke="#7c3aed" strokeWidth={2} />
        {ns.map((k, i) => <circle key={k} cx={x(k)} cy={y(vals[i])} r={3} fill="#a78bfa" />)}
        {/* current gate */}
        <motion.circle cx={x(n)} cy={y(cnots)} r={7} fill={structured ? '#34d399' : '#f59e0b'} stroke="#0a0f1e" strokeWidth={2}
          animate={{ cx: x(n), cy: y(cnots) }} transition={{ type: 'spring', stiffness: 120, damping: 18 }} />
        <text x={x(n)} y={y(cnots) - 12} textAnchor="middle" fill={structured ? '#34d399' : '#f59e0b'} fontSize={10} fontFamily="monospace" fontWeight={700}>{cnots}</text>
      </svg>
      <p style={{ color: '#475569', fontSize: 10, margin: '8px 0 0', lineHeight: 1.5 }}>
        The purple curve is the textbook QSD bound (¾·4ⁿ−3·2ⁿ⁻¹), log scale. Your gate is the{' '}
        {structured ? <b style={{ color: '#34d399' }}>green</b> : <b style={{ color: '#f59e0b' }}>orange</b>} dot —
        {structured ? ' a structured gate the optimiser pulls below the generic bound.' : ' a generic gate sitting on the bound (this cost is irreducible by counting).'}
      </p>
    </Card>
  );
}

// ─────────────────────────────── fault-tolerant ───────────────────────────────

function FaultTolerantCard({ U, n, cnots }: { U: Mat; n: number; cnots: number }) {
  const [depth, setDepth] = useState(2);
  const [result, setResult] = useState<FTShannon | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    setTimeout(() => { setResult(faultTolerantShannon(U, n, depth)); setBusy(false); }, 10);
  };

  return (
    <Card title="Compile to a fault-tolerant {H, T, CNOT} circuit" accent="#34d399">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.55 }}>
        The loop closes with the lab's <b style={{ color: '#a78bfa' }}>Solovay–Kitaev</b> engine: every
        single-qubit rotation in the QSD circuit is compiled into a discrete {'{'}H, T, …{'}'} word, so an{' '}
        <i>arbitrary {n}-qubit</i> unitary becomes a real {'{'}H, T, CNOT{'}'} circuit with a total{' '}
        <b style={{ color: '#34d399' }}>T-count</b> — the magic states a fault-tolerant machine must distil.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>SK depth
          <select value={depth} onChange={(e) => { setDepth(parseInt(e.target.value)); setResult(null); }} style={sel}>
            {[1, 2, 3].map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <button onClick={run} style={btn} disabled={busy}>{busy ? '… compiling' : '▶ Compile'}</button>
        <span style={{ fontSize: 10, color: '#475569' }}>{cnots} CNOTs · {result ? result.words.length : '—'} rotations to compile</span>
      </div>
      {result && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Stat label="CNOTs" value={String(result.cnots)} accent="#f59e0b" />
            <Stat label="total T-count" value={result.tCount.toLocaleString()} accent="#34d399" />
            <Stat label="1-qubit gates" value={result.gateCount.toLocaleString()} accent="#67e8f9" />
            <Stat label="error (depth-SK)" value={result.error.toExponential(2)} ok={result.error < 0.5} />
          </div>
          <p style={{ color: '#475569', fontSize: 10, margin: '8px 0 0' }}>
            Higher SK depth → smaller error but a larger T-count. This is the real resource bill for running an
            arbitrary {n}-qubit unitary on a fault-tolerant machine.
          </p>
        </motion.div>
      )}
      {!result && !busy && (
        <p style={{ color: '#475569', fontSize: 11, margin: '6px 0 0' }}>
          Press Compile. Each rotation costs an O(log 1/ε) {'{'}H,T{'}'} word; the T-counts add up fast.
        </p>
      )}
    </Card>
  );
}

// ─────────────────────────────── shared bits ───────────────────────────────

const hdr: React.CSSProperties = { fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' };
function Row({ children }: { children: React.ReactNode }) { return <>{children}</>; }

function Stat({ label, value, ok, accent }: { label: string; value: string; ok?: boolean; accent?: string }) {
  const color = ok === undefined ? (accent ?? '#cbd5e1') : ok ? '#34d399' : '#f59e0b';
  return (
    <div style={{ padding: '6px 10px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 7, minWidth: 70 }}>
      <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color }}>
        {value}{ok !== undefined && (ok ? ' ✓' : '')}
      </div>
    </div>
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

const sel: React.CSSProperties = { padding: '6px 10px', borderRadius: 6, background: '#0a0f1e', color: '#e2e8f0', border: '1px solid #334155', fontSize: 12 };
const lab: React.CSSProperties = { fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' };
const btn: React.CSSProperties = { padding: '6px 14px', borderRadius: 6, background: 'linear-gradient(135deg, #7c3aed, #0891b2)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const btnGhost: React.CSSProperties = { padding: '5px 12px', borderRadius: 6, background: 'rgba(124,58,237,0.15)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)', fontSize: 11, fontWeight: 600, cursor: 'pointer' };
