import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { type Mat, canonicalGate, makhlinInvariants } from '../quantum/kak';
import {
  type CircuitOp, type Synthesis, type FTCircuit,
  synthesize, faultTolerant, NAMED_GATES, seededSU4,
} from '../quantum/kakCircuit';
import { type Gate } from '../quantum/solovay';

// Format an angle as a multiple of π when close, else radians.
function fmtAngle(a: number): string {
  const frac = a / Math.PI;
  if (Math.abs(frac) < 1e-9) return '0';
  for (const [v, s] of [[1 / 4, 'π/4'], [-1 / 4, '−π/4'], [1 / 2, 'π/2'], [-1 / 2, '−π/2'], [1 / 8, 'π/8'], [-1 / 8, '−π/8'], [3 / 8, '3π/8'], [1, 'π'], [-1, '−π']] as [number, string][]) {
    if (Math.abs(frac - v) < 1e-6) return s;
  }
  return `${frac.toFixed(3)}π`;
}

const GATE_COLOR: Record<Gate, string> = {
  H: '#a78bfa', T: '#34d399', Ti: '#34d399', S: '#67e8f9', Si: '#67e8f9',
  X: '#f59e0b', Y: '#f59e0b', Z: '#f59e0b',
};
const GATE_LABEL: Record<Gate, string> = { H: 'H', T: 'T', Ti: 'T†', S: 'S', Si: 'S†', X: 'X', Y: 'Y', Z: 'Z' };

export default function SynthLab() {
  const [gateId, setGateId] = useState<string>('cnot');
  const [coords, setCoords] = useState<[number, number, number]>([0.4, 0.25, 0.1]);
  const [seed, setSeed] = useState(0x2026_0622);

  const U: Mat = useMemo(() => {
    if (gateId === 'custom') return canonicalGate(coords[0], coords[1], coords[2]);
    if (gateId === 'random') return seededSU4(seed);
    return NAMED_GATES.find((g) => g.id === gateId)!.make();
  }, [gateId, coords, seed]);

  const syn = useMemo(() => synthesize(U), [U]);

  return (
    <div style={{ maxWidth: 860 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        A real quantum computer has no "arbitrary two-qubit gate" instruction — it has single-qubit
        rotations and <b style={{ color: '#f59e0b' }}>one</b> entangler, the CNOT. The structure theorem
        that makes universal compilation possible is the <b style={{ color: '#a78bfa' }}>KAK (Cartan)
        decomposition</b> of SU(4): <i>every</i> two-qubit gate factors as a layer of single-qubit gates,
        a purely non-local interaction <code style={{ color: '#67e8f9' }}>exp(i(cx XX + cy YY + cz ZZ))</code>{' '}
        fixed by three numbers, and another single-qubit layer. Those three numbers are a{' '}
        <b style={{ color: '#67e8f9' }}>complete local invariant</b> — they live in the Weyl chamber and
        dictate the <b style={{ color: '#f59e0b' }}>minimum number of CNOTs</b> (0–3). Built from scratch
        via the magic-basis simultaneous diagonalisation; feed the single-qubit pieces through
        Solovay–Kitaev and the whole gate becomes a fault-tolerant {'{'}H, T, CNOT{'}'} circuit.
      </p>

      <SynthCard gateId={gateId} setGateId={setGateId} coords={coords} setCoords={setCoords} setSeed={setSeed} U={U} syn={syn} />
      <ChamberCard syn={syn} />
      <FaultTolerantCard U={U} optimal={syn.optimalCnots} />
    </div>
  );
}

// ─────────────────────────────── synthesis card ───────────────────────────────

function SynthCard({
  gateId, setGateId, coords, setCoords, setSeed, U, syn,
}: {
  gateId: string; setGateId: (s: string) => void;
  coords: [number, number, number]; setCoords: (c: [number, number, number]) => void;
  setSeed: (n: number) => void; U: Mat; syn: Synthesis;
}) {
  const mk = useMemo(() => makhlinInvariants(U), [U]);
  const cnotColor = ['#64748b', '#34d399', '#67e8f9', '#f59e0b'][syn.optimalCnots];

  return (
    <Card title="Decompose & synthesise any two-qubit gate" accent="#a78bfa">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>gate
          <select value={gateId} onChange={(e) => setGateId(e.target.value)} style={sel}>
            {NAMED_GATES.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
            <option value="custom">Custom interaction</option>
          </select>
        </label>
        {gateId === 'random' && (
          <button onClick={() => setSeed((Math.random() * 2 ** 31) >>> 0)} style={btnGhost}>🎲 reseed</button>
        )}
      </div>

      {gateId === 'custom' && (
        <div style={{ marginBottom: 12, display: 'grid', gap: 6 }}>
          {(['cx', 'cy', 'cz'] as const).map((nm, i) => (
            <div key={nm}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8' }}>
                <span>{nm}</span><span style={{ fontFamily: 'monospace', color: '#67e8f9' }}>{fmtAngle(coords[i])}</span>
              </div>
              <input type="range" min={-Math.PI / 4} max={Math.PI / 4} step={Math.PI / 64} value={coords[i]}
                onChange={(e) => { const c = [...coords] as [number, number, number]; c[i] = parseFloat(e.target.value); setCoords(c); }}
                style={{ width: '100%', accentColor: '#7c3aed' }} />
            </div>
          ))}
        </div>
      )}
      {gateId !== 'custom' && gateId !== 'random' && (
        <p style={{ color: '#475569', fontSize: 11, margin: '0 0 10px' }}>{NAMED_GATES.find((g) => g.id === gateId)?.desc}</p>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Stat label="canonical (cx, cy, cz)" value={`(${fmtAngle(syn.canonCoords[0])}, ${fmtAngle(syn.canonCoords[1])}, ${fmtAngle(syn.canonCoords[2])})`} accent="#67e8f9" />
        <Stat label="optimal CNOTs" value={String(syn.optimalCnots)} accent={cnotColor} />
        <Stat label="Makhlin G₁" value={fmtC(mk.G1)} />
        <Stat label="Makhlin G₂" value={mk.G2.re.toFixed(3)} />
        <Stat label="reconstruction" value={syn.reconError.toExponential(1)} ok={syn.reconError < 1e-9} />
      </div>

      <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
        Synthesised circuit · {syn.cnots} CNOT{syn.cnots === 1 ? '' : 's'} + single-qubit rotations
      </div>
      <CircuitDiagram ops={syn.ops} />
      <p style={{ color: '#475569', fontSize: 10, margin: '8px 0 0', lineHeight: 1.5 }}>
        The two outer purple boxes on each wire are the local layers (A, B); the orange dots/⊕ are CNOTs;
        the cyan boxes are the canonical-interaction rotations whose angles are read straight off (cx, cy, cz).
        The realised circuit reproduces the gate to <b style={{ color: '#34d399' }}>{syn.reconError.toExponential(1)}</b>.
      </p>
    </Card>
  );
}

// ─────────────────────────────── circuit diagram ───────────────────────────────

function CircuitDiagram({ ops }: { ops: CircuitOp[] }) {
  // Lay ops out into columns; a CNOT occupies one column spanning both wires.
  const W = 820;
  const colW = 56;
  const x0 = 40;
  const yq = [44, 96];
  const cols = ops.length;
  const width = Math.max(W, x0 * 2 + cols * colW);
  const H = 140;

  return (
    <div style={{ overflowX: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      <svg viewBox={`0 0 ${width} ${H}`} style={{ width: '100%', minWidth: Math.min(width, 820), height: 'auto', display: 'block' }}>
        {/* wires */}
        {yq.map((y, q) => (
          <g key={q}>
            <line x1={x0 - 18} y1={y} x2={width - 12} y2={y} stroke="#334155" strokeWidth={1.5} />
            <text x={10} y={y + 4} fill="#64748b" fontSize={12} fontFamily="monospace">q{q}</text>
          </g>
        ))}
        {ops.map((op, i) => {
          const cx = x0 + i * colW + colW / 2;
          if (op.kind === 'cnot') {
            const yc = yq[op.control], yt = yq[op.target];
            return (
              <g key={i}>
                <line x1={cx} y1={yc} x2={cx} y2={yt} stroke="#f59e0b" strokeWidth={2} />
                <circle cx={cx} cy={yc} r={5} fill="#f59e0b" />
                <circle cx={cx} cy={yt} r={11} fill="none" stroke="#f59e0b" strokeWidth={2} />
                <line x1={cx - 11} y1={yt} x2={cx + 11} y2={yt} stroke="#f59e0b" strokeWidth={2} />
                <line x1={cx} y1={yt - 11} x2={cx} y2={yt + 11} stroke="#f59e0b" strokeWidth={2} />
              </g>
            );
          }
          const y = yq[op.qubit];
          const label = op.kind === 'rot' ? `R${op.axis}` : op.label;
          const sub = op.kind === 'rot' ? fmtAngle(op.angle) : '';
          const color = op.kind === 'rot' ? '#67e8f9' : '#a78bfa';
          return (
            <g key={i}>
              <rect x={cx - 20} y={y - 15} width={40} height={30} rx={6} fill={`${color}1f`} stroke={`${color}88`} strokeWidth={1.2} />
              <text x={cx} y={op.kind === 'rot' ? y - 1 : y + 4} textAnchor="middle" fill={color} fontSize={11} fontFamily="monospace" fontWeight={700}>{label}</text>
              {sub && <text x={cx} y={y + 10} textAnchor="middle" fill="#7dd3fc" fontSize={8} fontFamily="monospace">{sub}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─────────────────────────────── Weyl chamber ───────────────────────────────

function ChamberCard({ syn }: { syn: Synthesis }) {
  // The Weyl chamber is the tetrahedron O–A–B–L with
  //   O=(0,0,0) identity, A=(π/4,0,0) CNOT, B=(π/4,π/4,0) iSWAP, L=(π/4,π/4,π/4) SWAP.
  const k = (Math.PI / 4);
  const verts: Record<string, [number, number, number]> = {
    O: [0, 0, 0], A: [k, 0, 0], B: [k, k, 0], L: [k, k, k],
  };
  const W = 360, Hh = 320;
  // isometric-ish projection
  const proj = (p: [number, number, number]): [number, number] => {
    const [x, y, z] = p.map((v) => v / k); // 0..1
    const sx = (x - y * 0.5 - z * 0.18) ;
    const sy = (z * 0.92 + y * 0.45) ;
    return [70 + sx * 220, 250 - sy * 200];
  };
  const pts = Object.fromEntries(Object.entries(verts).map(([n, v]) => [n, proj(v)])) as Record<string, [number, number]>;
  const edges: [string, string][] = [['O', 'A'], ['A', 'B'], ['B', 'L'], ['O', 'B'], ['O', 'L'], ['A', 'L']];
  const gp = proj(syn.canonCoords);
  const cnotColor = ['#64748b', '#34d399', '#67e8f9', '#f59e0b'][syn.optimalCnots];

  return (
    <Card title="The Weyl chamber — a gate's address in two-qubit space" accent="#67e8f9">
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
        <svg viewBox={`0 0 ${W} ${Hh}`} style={{ width: 360, maxWidth: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
          {/* faces (subtle) */}
          <polygon points={[pts.O, pts.A, pts.B].map((p) => p.join(',')).join(' ')} fill="rgba(103,232,249,0.05)" />
          <polygon points={[pts.O, pts.B, pts.L].map((p) => p.join(',')).join(' ')} fill="rgba(124,58,237,0.05)" />
          {edges.map(([a, b], i) => (
            <line key={i} x1={pts[a][0]} y1={pts[a][1]} x2={pts[b][0]} y2={pts[b][1]} stroke="#334155" strokeWidth={1.3} strokeDasharray={a === 'O' && b === 'L' ? '3 3' : undefined} />
          ))}
          {Object.entries(pts).map(([n, p]) => {
            const labels: Record<string, string> = { O: 'I (0)', A: 'CNOT (1)', B: 'iSWAP (2)', L: 'SWAP (3)' };
            return (
              <g key={n}>
                <circle cx={p[0]} cy={p[1]} r={4} fill="#475569" />
                <text x={p[0] + (n === 'O' ? -8 : 8)} y={p[1] + (n === 'L' ? -8 : 16)} textAnchor={n === 'O' ? 'end' : 'start'} fill="#64748b" fontSize={10} fontFamily="monospace">{labels[n]}</text>
              </g>
            );
          })}
          {/* the gate */}
          <motion.circle cx={gp[0]} cy={gp[1]} r={7} fill={cnotColor} stroke="#0a0f1e" strokeWidth={2}
            animate={{ cx: gp[0], cy: gp[1] }} transition={{ type: 'spring', stiffness: 120, damping: 18 }} />
          <circle cx={gp[0]} cy={gp[1]} r={12} fill="none" stroke={cnotColor} strokeWidth={1} opacity={0.5} />
        </svg>

        <div style={{ flex: 1, minWidth: 220 }}>
          <p style={{ color: '#94a3b8', fontSize: 12, lineHeight: 1.6, margin: '0 0 10px' }}>
            Modulo single-qubit gates, every two-qubit gate is one point in this tetrahedron. The four
            corners are the canonical representatives of each CNOT-cost class, and the cost is geometric:
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, color: '#64748b', fontSize: 11, lineHeight: 1.7 }}>
            <li><b style={{ color: '#34d399' }}>1 CNOT</b> — the CNOT corner only</li>
            <li><b style={{ color: '#67e8f9' }}>2 CNOTs</b> — the base face cz = 0</li>
            <li><b style={{ color: '#f59e0b' }}>3 CNOTs</b> — the interior (a generic gate)</li>
          </ul>
          <div style={{ marginTop: 12, padding: '8px 10px', background: 'rgba(2,6,23,0.5)', border: `1px solid ${cnotColor}55`, borderRadius: 8 }}>
            <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>this gate</div>
            <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: cnotColor }}>
              {syn.optimalCnots} CNOT{syn.optimalCnots === 1 ? '' : 's'}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────── fault tolerant ───────────────────────────────

function FaultTolerantCard({ U, optimal }: { U: Mat; optimal: number }) {
  const [depth, setDepth] = useState(3);
  const [result, setResult] = useState<FTCircuit | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    setTimeout(() => { setResult(faultTolerant(U, depth)); setBusy(false); }, 10);
  };

  return (
    <Card title="Compile to a fault-tolerant {H, T, CNOT} circuit" accent="#34d399">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.55 }}>
        Every single-qubit gate in the synthesised circuit is itself compiled by{' '}
        <b style={{ color: '#a78bfa' }}>Solovay–Kitaev</b> into a discrete {'{'}H, T, …{'}'} word, so the
        whole two-qubit gate becomes a circuit a fault-tolerant machine can actually run. The headline cost
        is the <b style={{ color: '#34d399' }}>T-count</b> — every T gate must be teleported in from a
        distilled magic state.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>SK depth
          <select value={depth} onChange={(e) => { setDepth(parseInt(e.target.value)); setResult(null); }} style={sel}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button onClick={run} style={btn} disabled={busy}>{busy ? '… compiling' : '▶ Compile'}</button>
      </div>

      {result && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <Stat label="CNOTs" value={String(result.cnots)} accent="#f59e0b" />
            <Stat label="total T-count" value={String(result.tCount)} accent="#34d399" />
            <Stat label="1-qubit gates" value={String(result.gateCount)} />
            <Stat label="error" value={result.error.toExponential(2)} ok={result.error < 0.05} />
            <Stat label="optimal CNOTs" value={String(optimal)} />
          </div>
          <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            Compiled single-qubit words (one per box in the circuit)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
            {result.words.map((w, i) => (
              'cnot' in w ? (
                <div key={i} style={{ fontFamily: 'monospace', fontSize: 11, color: '#f59e0b', padding: '2px 8px' }}>
                  ● CNOT  q{w.control} → q{w.target}
                </div>
              ) : (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '2px 8px', background: 'rgba(2,6,23,0.4)', borderRadius: 6 }}>
                  <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace', minWidth: 70 }}>q{w.qubit} · {w.word.length}g · {w.tCount}T</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                    {w.word.length === 0 && <span style={{ fontSize: 10, color: '#475569' }}>identity</span>}
                    {w.word.slice(0, 48).map((g, j) => (
                      <span key={j} style={{ padding: '0 4px', borderRadius: 3, fontFamily: 'monospace', fontSize: 9, fontWeight: 700, color: GATE_COLOR[g], background: 'rgba(255,255,255,0.03)' }}>{GATE_LABEL[g]}</span>
                    ))}
                    {w.word.length > 48 && <span style={{ color: '#475569', fontSize: 9 }}>… +{w.word.length - 48}</span>}
                  </div>
                </div>
              )
            ))}
          </div>
        </motion.div>
      )}
      {!result && !busy && (
        <p style={{ color: '#475569', fontSize: 11, margin: '6px 0 0' }}>
          Press Compile. Clifford gates (CNOT, iSWAP, SWAP) compile to T-count 0; a generic gate needs
          thousands of T gates at depth 3 — the real price of fault tolerance.
        </p>
      )}
    </Card>
  );
}

// ─────────────────────────────── shared bits ───────────────────────────────

function fmtC(z: { re: number; im: number }): string {
  if (Math.abs(z.im) < 1e-4) return z.re.toFixed(3);
  return `${z.re.toFixed(2)}${z.im >= 0 ? '+' : '−'}${Math.abs(z.im).toFixed(2)}i`;
}

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
