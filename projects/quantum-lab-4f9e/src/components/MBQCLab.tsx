import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  EXAMPLES, buildExample, runPattern, oracleApply, fidelity, randomInput, mbqcRng,
  clusterState, stabilizerGenerator, pauliExpectation,
  type ExampleId, type Pattern, type Graph,
} from '../quantum/mbqc';

export default function MBQCLab() {
  return (
    <div style={{ maxWidth: 820 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.65 }}>
        <b style={{ color: '#a78bfa' }}>Measurement-based quantum computation</b> — the{' '}
        <b style={{ color: '#67e8f9' }}>one-way quantum computer</b> — turns the circuit model inside out.
        There are no gates. You prepare one big, fixed, entangled <b>cluster state</b> and then compute by{' '}
        <i>measuring its qubits one at a time</i> in adaptively chosen single-qubit bases. Measurement is
        random and irreversible, yet feeding each outcome forward into later measurement angles — and undoing
        a final Pauli <b>byproduct</b> — makes the computation deterministic. The whole thing is universal.
        Every pattern below is the genuine cluster-state simulation, cross-checked live against an independent
        circuit-model oracle.
      </p>

      <CompileCard />
      <DeterminismCard />
      <GraphStateCard />
    </div>
  );
}

// ─────────────────────────────── compile a gate to a cluster ───────────────────────────────

function CompileCard() {
  const [id, setId] = useState<ExampleId>('cnot');
  const [theta, setTheta] = useState(Math.PI / 3);
  const [seed, setSeed] = useState(3);
  const spec = EXAMPLES.find((e) => e.id === id)!;
  const usesTheta = id === 'rz' || id === 'rx' || id === 'u';

  const pat = useMemo(() => buildExample(id, theta), [id, theta]);

  // A run on |0…0⟩ for the displayed probabilities + adapted angles + outcomes.
  const run = useMemo(() => {
    const dim = 1 << pat.nWires;
    const inp = Array.from({ length: dim }, (_, i) => ({ re: i === 0 ? 1 : 0, im: 0 }));
    return runPattern(pat, inp, mbqcRng(seed));
  }, [pat, seed]);

  // The live cross-check: a random input through both the cluster and the oracle.
  const fid = useMemo(() => {
    let worst = 1;
    const rng = mbqcRng(seed * 7 + 1);
    for (let k = 0; k < 8; k++) {
      const inp = randomInput(pat.nWires, rng);
      const got = runPattern(pat, inp, rng).state.amplitudes(pat.outputs);
      worst = Math.min(worst, fidelity(got, oracleApply(pat.logical, pat.nWires, inp)));
    }
    return worst;
  }, [pat, seed]);

  const probs = run.state.amplitudes(pat.outputs).map((a) => a.re * a.re + a.im * a.im);
  const correction = pat.corrections.map((c, w) => {
    const xs = c.xDeps.reduce((s, q) => s ^ (run.outcomes.get(q) ?? 0), 0);
    const zs = c.zDeps.reduce((s, q) => s ^ (run.outcomes.get(q) ?? 0), 0);
    return { w, x: xs, z: zs, xDeps: c.xDeps, zDeps: c.zDeps };
  });

  return (
    <Card title="Compile a gate to a cluster" accent="#a78bfa">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>pattern
          <select value={id} onChange={(e) => setId(e.target.value as ExampleId)} style={sel}>
            {EXAMPLES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </label>
        {usesTheta && (
          <label style={lab}>θ = {theta.toFixed(2)}
            <input type="range" min={0} max={6.28} step={0.01} value={theta}
              onChange={(e) => setTheta(parseFloat(e.target.value))} style={{ width: 120 }} />
          </label>
        )}
        <label style={lab}>seed
          <input type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value) || 0)}
            style={{ ...sel, width: 60 }} />
        </label>
        <button onClick={() => setSeed((s) => s + 1)} style={btn}>⟳ re-measure</button>
      </div>

      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 10px', lineHeight: 1.5 }}>{spec.desc}</p>

      <ClusterView pat={pat} run={run} />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
        <Stat label="logical wires" value={String(pat.nWires)} />
        <Stat label="physical qubits" value={String(pat.nodes.length)} />
        <Stat label="measurements" value={String(pat.commands.filter((c) => c.t === 'M').length)} />
        <Stat label="live register" value={`${pat.nWires} qubits`} />
        <Stat label="✓ vs circuit oracle" value={`fid ${fid.toFixed(6)}`} ok={fid > 1 - 1e-9} />
      </div>

      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Panel title="Byproduct correction (this run)">
          {correction.map((c) => (
            <div key={c.w} style={{ fontFamily: 'monospace', fontSize: 11, color: '#cbd5e1', lineHeight: 1.7 }}>
              wire {c.w}: apply{' '}
              <span style={{ color: c.x ? '#f472b6' : '#475569' }}>X^{c.x}</span>{' '}
              <span style={{ color: c.z ? '#67e8f9' : '#475569' }}>Z^{c.z}</span>
              <span style={{ color: '#475569' }}> {c.xDeps.length || c.zDeps.length ? `(from outcomes)` : ''}</span>
            </div>
          ))}
          <p style={{ color: '#475569', fontSize: 9.5, margin: '6px 0 0', lineHeight: 1.5 }}>
            The random outcomes leave the answer in a Pauli frame X^a Z^b; undoing it recovers the exact
            logical state — the same one for <i>every</i> outcome string.
          </p>
        </Panel>
        <Panel title="Output on |0…0⟩ (after correction)">
          {probs.map((p, i) => p > 1e-9 && (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '46px 1fr 42px', gap: 6, alignItems: 'center', marginBottom: 3 }}>
              <span style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>
                |{i.toString(2).padStart(pat.nWires, '0')}⟩
              </span>
              <div style={{ height: 7, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${p * 100}%`, background: 'linear-gradient(90deg,#7c3aed,#67e8f9)', borderRadius: 2 }} />
              </div>
              <span style={{ fontSize: 10, color: '#a78bfa', fontFamily: 'monospace', textAlign: 'right' }}>{p.toFixed(3)}</span>
            </div>
          ))}
        </Panel>
      </div>
    </Card>
  );
}

// The cluster graph: nodes laid out by (column, wire); inputs left, outputs right,
// interior measured qubits annotated with their measurement angle and (after a run)
// the sampled outcome and the angle actually measured.
function ClusterView({ pat, run }: { pat: Pattern; run: ReturnType<typeof runPattern> }) {
  const maxCol = Math.max(...pat.nodes.map((n) => n.col), 1);
  const dx = 80, dy = 70, padX = 40, padY = 36;
  const W = padX * 2 + maxCol * dx;
  const H = padY * 2 + (pat.nWires - 1) * dy;
  const pos = (n: { col: number; wire: number }) => ({ x: padX + n.col * dx, y: padY + n.wire * dy });
  const byId = new Map(pat.nodes.map((n) => [n.id, n]));
  // measurement base angle per qubit
  const baseAngle = new Map<number, number>();
  for (const c of pat.commands) if (c.t === 'M') baseAngle.set(c.q, c.base);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', maxHeight: 280, background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 10 }}>
      {/* edges (CZ entanglement) */}
      {pat.edges.map(([a, b], i) => {
        const pa = pos(byId.get(a)!), pb = pos(byId.get(b)!);
        return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="rgba(124,58,237,0.45)" strokeWidth={2} />;
      })}
      {/* nodes */}
      {pat.nodes.map((n) => {
        const p = pos(n);
        const measured = run.outcomes.has(n.id);
        const out = run.outcomes.get(n.id);
        const isOutput = n.role === 'output';
        const color = isOutput ? '#34d399' : n.role === 'input' && !measured ? '#67e8f9' : '#a78bfa';
        const ba = baseAngle.get(n.id);
        return (
          <g key={n.id}>
            <circle cx={p.x} cy={p.y} r={14} fill="rgba(2,6,23,0.95)" stroke={color}
              strokeWidth={2} opacity={measured ? 0.55 : 1} />
            <text x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central" fill={color}
              fontSize={11} fontFamily="monospace" fontWeight={700}>
              {isOutput ? 'out' : measured ? out : '+'}
            </text>
            {ba !== undefined && (
              <text x={p.x} y={p.y - 22} textAnchor="middle" fill="#64748b" fontSize={9} fontFamily="monospace">
                {fmtAngle(run.angles.get(n.id) ?? ba)}
              </text>
            )}
          </g>
        );
      })}
      {/* wire labels */}
      {Array.from({ length: pat.nWires }, (_, w) => (
        <text key={w} x={6} y={padY + w * dy} dominantBaseline="central" fill="#475569" fontSize={10} fontFamily="monospace">q{w}</text>
      ))}
    </svg>
  );
}

function fmtAngle(a: number): string {
  const r = a / Math.PI;
  if (Math.abs(r) < 1e-6) return '0';
  const rounded = Math.round(r * 4) / 4;
  if (Math.abs(rounded - r) < 1e-6) {
    const sign = rounded < 0 ? '−' : '';
    const m = Math.abs(rounded);
    if (m === 1) return `${sign}π`;
    if (m === 0.5) return `${sign}π/2`;
    if (m === 0.25) return `${sign}π/4`;
    if (m === 0.75) return `${sign}3π/4`;
    return `${sign}${m}π`;
  }
  return `${r.toFixed(2)}π`;
}

// ─────────────────────────────── determinism demonstrator ───────────────────────────────

function DeterminismCard() {
  const [id, setId] = useState<ExampleId>('u');
  const spec = EXAMPLES.find((e) => e.id === id)!;
  const data = useMemo(() => {
    const pat = buildExample(id, 1.1);
    const inp = randomInput(pat.nWires, mbqcRng(7));
    const base = runPattern(pat, inp, mbqcRng(1)).state.amplitudes(pat.outputs);
    const rows: { seed: number; outcomes: string; fid: number }[] = [];
    let worst = 1;
    for (let s = 1; s <= 10; s++) {
      const res = runPattern(pat, inp, mbqcRng(s * 13 + 2));
      const f = fidelity(base, res.state.amplitudes(pat.outputs));
      worst = Math.min(worst, f);
      const oc = pat.commands.filter((c) => c.t === 'M').map((c) => res.outcomes.get((c as { q: number }).q) ?? 0).join('');
      rows.push({ seed: s, outcomes: oc, fid: f });
    }
    return { rows, worst };
  }, [id]);

  return (
    <Card title="Determinism from randomness" accent="#34d399">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <label style={lab}>pattern
          <select value={id} onChange={(e) => setId(e.target.value as ExampleId)} style={sel}>
            {EXAMPLES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </label>
        <span style={{ fontSize: 10, color: '#475569' }}>{spec.nWires}-wire · same input, 10 different outcome strings</span>
      </div>
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 10px', lineHeight: 1.55 }}>
        Each row is the <i>same</i> computation with a different random measurement record. The measurement
        outcomes differ every time — but the corrected output is byte-for-byte identical (fidelity 1). That
        is the magic of MBQC: randomness is steered, not feared.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '4px 14px', alignItems: 'center', fontFamily: 'monospace', fontSize: 11 }}>
        <span style={th}>run</span><span style={th}>measurement outcomes</span><span style={{ ...th, textAlign: 'right' }}>fid vs run 1</span>
        {data.rows.map((row) => (
          <Row key={row.seed} row={row} />
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stat label="worst-case fidelity across all runs" value={data.worst.toFixed(12)} ok={data.worst > 1 - 1e-9} />
      </div>
    </Card>
  );
}

function Row({ row }: { row: { seed: number; outcomes: string; fid: number } }) {
  return (
    <>
      <span style={{ color: '#64748b' }}>{row.seed}</span>
      <span style={{ color: '#a78bfa', letterSpacing: '2px' }}>{row.outcomes || '∅'}</span>
      <span style={{ color: row.fid > 1 - 1e-9 ? '#34d399' : '#f87171', textAlign: 'right' }}>{row.fid.toFixed(9)}</span>
    </>
  );
}

// ─────────────────────────────── graph-state stabilizers ───────────────────────────────

const GRAPHS: { name: string; g: Graph }[] = [
  { name: 'Line (4)', g: { n: 4, edges: [[0, 1], [1, 2], [2, 3]] } },
  { name: 'Ring (5)', g: { n: 5, edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0]] } },
  { name: 'Star (5)', g: { n: 5, edges: [[0, 1], [0, 2], [0, 3], [0, 4]] } },
  { name: 'Box (4)', g: { n: 4, edges: [[0, 1], [1, 2], [2, 3], [3, 0]] } },
  { name: 'Box+X (4)', g: { n: 4, edges: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2], [1, 3]] } },
];

const PCOLOR: Record<string, string> = { I: '#334155', X: '#f472b6', Y: '#fbbf24', Z: '#67e8f9' };

function GraphStateCard() {
  const [idx, setIdx] = useState(1);
  const { name, g } = GRAPHS[idx];
  const data = useMemo(() => {
    const st = clusterState(g);
    return Array.from({ length: g.n }, (_, v) => {
      const K = stabilizerGenerator(g, v);
      return { v, paulis: K.paulis, exp: pauliExpectation(st, K.paulis) };
    });
  }, [g]);
  const worst = Math.min(...data.map((d) => d.exp));

  return (
    <Card title="Graph states & their stabilizers" accent="#67e8f9">
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {GRAPHS.map((gr, i) => (
          <button key={gr.name} onClick={() => setIdx(i)}
            style={{ ...pill, ...(i === idx ? pillOn : {}) }}>{gr.name}</button>
        ))}
      </div>
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 10px', lineHeight: 1.55 }}>
        The cluster state <b style={{ color: '#67e8f9' }}>|G⟩</b> for graph <b>{name}</b> is the unique
        +1 eigenstate of all <b>n</b> generators <code>K_v = X_v ∏<sub>w∼v</sub> Z_w</code>. These are the
        rules the one-way computer runs on — measuring a qubit propagates these correlations forward.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '4px 14px', alignItems: 'center' }}>
        {data.map((d) => (
          <div key={d.v} style={{ display: 'contents' }}>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#64748b' }}>K<sub>{d.v}</sub></span>
            <div style={{ display: 'flex', gap: 3 }}>
              {d.paulis.map((p, i) => (
                <span key={i} style={{
                  width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: 4, fontFamily: 'monospace', fontSize: 11, fontWeight: 700,
                  color: PCOLOR[p], background: p === 'I' ? 'rgba(255,255,255,0.02)' : `${PCOLOR[p]}1a`,
                  border: `1px solid ${p === 'I' ? '#1e293b' : PCOLOR[p] + '55'}`,
                }}>{p}</span>
              ))}
            </div>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: d.exp > 1 - 1e-9 ? '#34d399' : '#f87171', textAlign: 'right' }}>
              ⟨K⟩ = {d.exp.toFixed(4)}
            </span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stat label="all generators stabilise |G⟩" value={`min ⟨K_v⟩ = ${worst.toFixed(9)}`} ok={worst > 1 - 1e-9} />
      </div>
    </Card>
  );
}

// ─────────────────────────────── shared bits ───────────────────────────────

function Stat({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div style={{ padding: '6px 10px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 7, minWidth: 70 }}>
      <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: ok === undefined ? '#cbd5e1' : ok ? '#34d399' : '#f87171' }}>
        {value}{ok !== undefined && (ok ? ' ✓' : ' ✗')}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(2,6,23,0.45)', border: '1px solid #1e293b', borderRadius: 8, padding: '8px 12px' }}>
      <div style={{ fontSize: 9.5, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Card({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      style={{ background: 'rgba(14,22,41,0.6)', border: '1px solid rgba(30,58,95,0.5)', borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 800, color: accent }}>{title}</h3>
      {children}
    </motion.div>
  );
}

const sel: React.CSSProperties = { padding: '6px 10px', borderRadius: 6, background: '#0a0f1e', color: '#e2e8f0', border: '1px solid #334155', fontSize: 12 };
const lab: React.CSSProperties = { fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' };
const btn: React.CSSProperties = { padding: '6px 14px', borderRadius: 6, background: 'linear-gradient(135deg, #7c3aed, #0891b2)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const th: React.CSSProperties = { fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' };
const pill: React.CSSProperties = { padding: '5px 11px', borderRadius: 6, background: 'rgba(255,255,255,0.02)', color: '#94a3b8', border: '1px solid #1e293b', fontSize: 11, cursor: 'pointer' };
const pillOn: React.CSSProperties = { background: 'rgba(8,145,178,0.18)', color: '#67e8f9', border: '1px solid rgba(8,145,178,0.5)' };
