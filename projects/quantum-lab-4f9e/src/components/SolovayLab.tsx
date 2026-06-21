import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  type Gate, type SU2, type NamedTarget,
  compileGate, getNet, basicApproximation, su2Rot, su2Dist,
  rzTarget, seededTarget, NAMED_TARGETS,
} from '../quantum/solovay';

const GATE_COLOR: Record<Gate, string> = {
  H: '#a78bfa', T: '#34d399', Ti: '#34d399', S: '#67e8f9', Si: '#67e8f9',
  X: '#f59e0b', Y: '#f59e0b', Z: '#f59e0b',
};
const GATE_LABEL: Record<Gate, string> = {
  H: 'H', T: 'T', Ti: 'T†', S: 'S', Si: 'S†', X: 'X', Y: 'Y', Z: 'Z',
};

export default function SolovayLab() {
  return (
    <div style={{ maxWidth: 820 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        A fault-tolerant quantum computer cannot apply an arbitrary rotation — it has only a{' '}
        <b style={{ color: '#a78bfa' }}>discrete</b> instruction set it can run cheaply and transversally:
        the Clifford gates plus the non-Clifford <code style={{ color: '#34d399' }}>T = diag(1, e^{'{iπ/4}'})</code>.
        The <b style={{ color: '#a78bfa' }}>Solovay–Kitaev algorithm</b> bridges the gap: it compiles{' '}
        <i>any</i> single-qubit gate into a word over <code>{'{'}H, T, T†, S, S†, X, Y, Z{'}'}</code> that
        approximates it to any precision ε, using only <code>O(log<sup>c</sup>(1/ε))</code> gates. The trick is
        a recursion on the leftover error written as a <b style={{ color: '#67e8f9' }}>balanced group
        commutator</b> — every level multiplies the accuracy super-linearly. Everything here is built from
        scratch in SU(2), and every compiled word is multiplied back out in genuine U(2) to confirm it
        reproduces the target.
      </p>

      <CompileCard />
      <ConvergenceCard />
      <InstructionSetCard />
    </div>
  );
}

// ─────────────────────────────── Compile a gate ───────────────────────────────

function CompileCard() {
  const [targetId, setTargetId] = useState<string>('rz');
  const [theta, setTheta] = useState(Math.PI / 8);
  const [depth, setDepth] = useState(3);

  const target: SU2 = useMemo(() => {
    if (targetId === 'rz') return rzTarget(theta);
    const t = NAMED_TARGETS.find((x) => x.id === targetId) as NamedTarget;
    return t.make();
  }, [targetId, theta]);

  const [result, setResult] = useState<ReturnType<typeof compileGate> | null>(null);
  const [busy, setBusy] = useState(false);

  const compile = () => {
    setBusy(true);
    // let the spinner paint before the (synchronous) compile blocks the thread
    setTimeout(() => { setResult(compileGate(target, depth)); setBusy(false); }, 10);
  };

  return (
    <Card title="Compile an arbitrary gate to {H, T}" accent="#a78bfa">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>target
          <select value={targetId} onChange={(e) => { setTargetId(e.target.value); setResult(null); }} style={sel}>
            <option value="rz">Rz(θ) — adjustable</option>
            {NAMED_TARGETS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <label style={lab}>depth n
          <select value={depth} onChange={(e) => { setDepth(parseInt(e.target.value)); setResult(null); }} style={sel}>
            {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button onClick={compile} style={btn} disabled={busy}>{busy ? '… compiling' : '▶ Compile'}</button>
      </div>

      {targetId === 'rz' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginBottom: 3 }}>
            <span>rotation angle θ</span>
            <span style={{ fontFamily: 'monospace', color: '#a78bfa' }}>{(theta / Math.PI).toFixed(3)}π = {theta.toFixed(3)} rad</span>
          </div>
          <input type="range" min={0} max={Math.PI * 2} step={Math.PI / 64} value={theta}
            onChange={(e) => { setTheta(parseFloat(e.target.value)); setResult(null); }}
            style={{ width: '100%', accentColor: '#7c3aed' }} />
        </div>
      )}

      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 10px', lineHeight: 1.55 }}>
        {targetId === 'rz'
          ? 'A z-rotation by an angle with no exact {H,T} word — the canonical Solovay–Kitaev test case.'
          : NAMED_TARGETS.find((t) => t.id === targetId)?.desc}
      </p>

      {result && (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <Stat label="approximation error" value={result.error.toExponential(2)} accent="#34d399" />
            <Stat label="gate count" value={String(result.length)} />
            <Stat label="T-count (T / T†)" value={String(result.tCount)} accent="#34d399" />
            <Stat label="recursion depth" value={String(depth)} />
            <Stat label="reproduces target?" value={result.error < 0.2 ? 'yes' : 'coarse'} ok={result.error < 0.2} />
          </div>

          <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            Compiled word{result.length > 120 ? ` (first 120 of ${result.length})` : ''}
          </div>
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 3, maxHeight: 132, overflowY: 'auto',
            background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8, padding: 8,
          }}>
            {result.reduced.slice(0, 120).map((g, i) => (
              <span key={i} style={{
                padding: '1px 5px', borderRadius: 3, fontFamily: 'monospace', fontSize: 10, fontWeight: 700,
                color: GATE_COLOR[g], background: 'rgba(255,255,255,0.03)', border: `1px solid ${GATE_COLOR[g]}33`,
              }}>{GATE_LABEL[g]}</span>
            ))}
            {result.length > 120 && <span style={{ color: '#475569', fontSize: 10, alignSelf: 'center' }}>… +{result.length - 120} more</span>}
          </div>
          <p style={{ color: '#475569', fontSize: 10, margin: '8px 0 0', lineHeight: 1.5 }}>
            The green <b style={{ color: '#34d399' }}>T / T†</b> gates are the costly, non-Clifford resource —
            each one must be supplied by a distilled magic state on real hardware. Clifford gates
            (<span style={{ color: '#a78bfa' }}>H</span>, <span style={{ color: '#67e8f9' }}>S</span>,{' '}
            <span style={{ color: '#f59e0b' }}>X/Y/Z</span>) are essentially free.
          </p>
        </motion.div>
      )}
      {!result && !busy && (
        <p style={{ color: '#475569', fontSize: 11, margin: '6px 0 0' }}>
          Press Compile. Depth 0 is the raw base-net guess (~0.1 error); each extra level shrinks the error
          super-linearly while multiplying the gate count by ~5.
        </p>
      )}
    </Card>
  );
}

// ─────────────────────────────── Convergence law ───────────────────────────────

interface SweepPoint { n: number; error: number; length: number; tCount: number; }

function ConvergenceCard() {
  const [targetId, setTargetId] = useState<string>('v');
  const [data, setData] = useState<SweepPoint[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    setTimeout(() => {
      const target = targetId === 'rz5' ? rzTarget(Math.PI / 5)
        : targetId === 'seed' ? seededTarget(20260621)
        : (NAMED_TARGETS.find((t) => t.id === targetId) as NamedTarget).make();
      const pts: SweepPoint[] = [];
      for (let n = 0; n <= 5; n++) {
        const r = compileGate(target, n);
        pts.push({ n, error: r.error, length: r.length, tCount: r.tCount });
      }
      setData(pts);
      setBusy(false);
    }, 10);
  };

  return (
    <Card title="The convergence law — ε shrinks, gate count grows" accent="#67e8f9">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={lab}>target
          <select value={targetId} onChange={(e) => { setTargetId(e.target.value); setData(null); }} style={sel}>
            <option value="v">V = √X</option>
            <option value="rz5">Rz(π/5)</option>
            <option value="rx_1">Rx(1 rad)</option>
            <option value="seed">Random (seeded)</option>
          </select>
        </label>
        <button onClick={run} style={btn} disabled={busy}>{busy ? '… running' : '▶ Sweep depth 0 → 5'}</button>
      </div>

      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 10px', lineHeight: 1.55 }}>
        The Solovay–Kitaev theorem promises <code style={{ color: '#67e8f9' }}>ε<sub>n</sub> ≈ c · ε<sub>n−1</sub><sup>3/2</sup></code>{' '}
        (each level super-linearly better) at the cost of a 5× longer word. On a log scale the error falls
        away as a near-straight, steepening line — the hallmark of a doubly-exponential approach to the exact gate.
      </p>

      {data && <SweepChart data={data} />}

      {data && (
        <div style={{ marginTop: 12, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: 11, width: '100%' }}>
            <thead>
              <tr style={{ color: '#475569', textAlign: 'right' }}>
                <th style={th}>depth n</th><th style={th}>error ε</th><th style={th}>ε ratio</th>
                <th style={th}>gates</th><th style={th}>T-count</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.n} style={{ color: '#cbd5e1', textAlign: 'right' }}>
                  <td style={td}>{p.n}</td>
                  <td style={{ ...td, color: '#34d399' }}>{p.error.toExponential(2)}</td>
                  <td style={{ ...td, color: '#64748b' }}>{i === 0 ? '—' : (data[i - 1].error / p.error).toFixed(1) + '×'}</td>
                  <td style={td}>{p.length}</td>
                  <td style={{ ...td, color: '#34d399' }}>{p.tCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!data && !busy && (
        <p style={{ color: '#475569', fontSize: 11, margin: '6px 0 0' }}>
          Press Sweep to compile the same gate at recursion depths 0 through 5 and watch the error collapse.
        </p>
      )}
    </Card>
  );
}

function SweepChart({ data }: { data: SweepPoint[] }) {
  const W = 720, H = 220, padL = 52, padR = 52, padT = 14, padB = 28;
  const cw = W - padL - padR, ch = H - padT - padB;
  const errs = data.map((d) => Math.max(d.error, 1e-12));
  const logE = errs.map((e) => Math.log10(e));
  const eMin = Math.min(...logE), eMax = Math.max(...logE);
  const eSpan = Math.max(0.5, eMax - eMin);
  const lens = data.map((d) => d.length);
  const lMax = Math.max(...lens, 1);
  const xOf = (n: number) => padL + (n / 5) * cw;
  const yErr = (e: number) => padT + ((eMax - Math.log10(Math.max(e, 1e-12))) / eSpan) * ch;
  const yLen = (l: number) => padT + ch - (l / lMax) * ch;

  const errPath = data.map((d, i) => `${i ? 'L' : 'M'}${xOf(d.n).toFixed(1)},${yErr(d.error).toFixed(1)}`).join(' ');
  const lenPath = data.map((d, i) => `${i ? 'L' : 'M'}${xOf(d.n).toFixed(1)},${yLen(d.length).toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      {/* gridlines + left axis (error, log) */}
      {Array.from({ length: 5 }, (_, i) => {
        const frac = i / 4;
        const y = padT + frac * ch;
        const logVal = eMax - frac * eSpan;
        return (
          <g key={i}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#1e293b" strokeWidth={0.5} />
            <text x={padL - 6} y={y + 3} textAnchor="end" fill="#34d399" fontSize={9} fontFamily="monospace">
              1e{Math.round(logVal)}
            </text>
          </g>
        );
      })}
      {/* right axis (gate count) */}
      {Array.from({ length: 5 }, (_, i) => {
        const frac = i / 4;
        const y = padT + ch - frac * ch;
        return (
          <text key={i} x={W - padR + 6} y={y + 3} textAnchor="start" fill="#67e8f9" fontSize={9} fontFamily="monospace">
            {Math.round(frac * lMax)}
          </text>
        );
      })}
      {/* x ticks */}
      {data.map((d) => (
        <text key={d.n} x={xOf(d.n)} y={H - 8} textAnchor="middle" fill="#475569" fontSize={10} fontFamily="monospace">n={d.n}</text>
      ))}
      {/* length line */}
      <path d={lenPath} fill="none" stroke="#67e8f9" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.8} />
      {data.map((d) => <circle key={`l${d.n}`} cx={xOf(d.n)} cy={yLen(d.length)} r={3} fill="#67e8f9" />)}
      {/* error line */}
      <path d={errPath} fill="none" stroke="#34d399" strokeWidth={2} />
      {data.map((d) => <circle key={`e${d.n}`} cx={xOf(d.n)} cy={yErr(d.error)} r={3.5} fill="#34d399" />)}
      {/* legend */}
      <g transform={`translate(${padL + 8}, ${padT + 6})`}>
        <rect x={0} y={-7} width={10} height={3} fill="#34d399" />
        <text x={14} y={-3} fill="#34d399" fontSize={9} fontFamily="monospace">error ε (log)</text>
        <rect x={108} y={-7} width={10} height={3} fill="#67e8f9" />
        <text x={122} y={-3} fill="#67e8f9" fontSize={9} fontFamily="monospace">gate count</text>
      </g>
    </svg>
  );
}

// ─────────────────────────────── Instruction set & net ───────────────────────────────

function InstructionSetCard() {
  const stats = useMemo(() => {
    const net = getNet();
    let worst = 0;
    let s = 0x5eed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let t = 0; t < 50; t++) {
      const u: [number, number, number] = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const nn = Math.hypot(u[0], u[1], u[2]);
      const U = su2Rot([u[0] / nn, u[1] / nn, u[2] / nn], rnd() * 2 * Math.PI);
      worst = Math.max(worst, su2Dist(U, basicApproximation(U, net).U));
    }
    return { size: net.length, cover: worst };
  }, []);

  const gens: { g: Gate; desc: string }[] = [
    { g: 'H', desc: 'Hadamard — basis change, the Clifford generator' },
    { g: 'T', desc: 'π/8 gate — the non-Clifford generator (with H, dense in SU(2))' },
    { g: 'Ti', desc: 'T† — inverse π/8 gate' },
    { g: 'S', desc: 'phase gate = T²' },
    { g: 'Si', desc: 'S† — inverse phase gate' },
    { g: 'X', desc: 'Pauli X (NOT)' },
    { g: 'Y', desc: 'Pauli Y' },
    { g: 'Z', desc: 'Pauli Z = S²' },
  ];

  return (
    <Card title="The instruction set & the base net" accent="#f59e0b">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        The Clifford gates alone are <i>not</i> universal — by the Gottesman–Knill theorem they are
        classically simulable (that is exactly the lab's stabilizer engine). Adding the single gate{' '}
        <b style={{ color: '#34d399' }}>T</b> makes <code>{'{'}H, T{'}'}</code> generate a{' '}
        <b style={{ color: '#a78bfa' }}>dense</b> subgroup of SU(2): their words come arbitrarily close to
        every gate. Solovay–Kitaev makes "arbitrarily close" <i>efficient</i>.
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <Stat label="base-net words (≤ len 16)" value={stats.size.toLocaleString()} />
        <Stat label="covering radius ε₀" value={stats.cover.toFixed(3)} accent="#34d399" />
        <Stat label="generators" value="8" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
        {gens.map(({ g, desc }) => (
          <div key={g} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
            background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8,
          }}>
            <span style={{
              width: 30, height: 30, flexShrink: 0, borderRadius: 6, display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontFamily: 'monospace', fontSize: 13, fontWeight: 800,
              color: GATE_COLOR[g], background: `${GATE_COLOR[g]}18`, border: `1px solid ${GATE_COLOR[g]}55`,
            }}>{GATE_LABEL[g]}</span>
            <span style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.4 }}>{desc}</span>
          </div>
        ))}
      </div>

      <p style={{ color: '#475569', fontSize: 10, margin: '12px 0 0', lineHeight: 1.5 }}>
        The base net is every reduced word up to length 16, deduplicated by its SU(2) value — a fixed mesh
        covering the group with radius ε₀ ≈ {stats.cover.toFixed(2)}. Below this radius the recursion takes
        over, and three to five levels reach errors of 10⁻³ to 10⁻⁶.
      </p>
    </Card>
  );
}

// ─────────────────────────────── shared bits ───────────────────────────────

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
const th: React.CSSProperties = { padding: '3px 10px', fontWeight: 600, borderBottom: '1px solid #1e293b' };
const td: React.CSSProperties = { padding: '3px 10px' };
