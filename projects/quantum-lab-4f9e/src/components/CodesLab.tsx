import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { CODE_ZOO } from '../quantum/codes/codeZoo';
import {
  StabilizerCode, singleError, pauliString,
  type Pauli,
} from '../quantum/codes/StabilizerCode';
import { runCodeCycle } from '../quantum/codes/runCode';
import { mulberry32 } from '../quantum/surface/SurfaceCode';

const PAULI_COLOR: Record<string, string> = { X: '#f87171', Y: '#fbbf24', Z: '#34d399', I: '#334155' };

function PauliRow({ label, pauli, accent }: { label: string; pauli: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }}>
      <span style={{ color: accent ?? '#475569', fontSize: 10, width: 34 }}>{label}</span>
      {[...pauli].map((p, q) => (
        <span key={q} style={{ color: PAULI_COLOR[p], fontWeight: p === 'I' ? 400 : 800, width: 12, textAlign: 'center' }}>{p}</span>
      ))}
    </div>
  );
}

export default function CodesLab() {
  const [codeKey, setCodeKey] = useState('five');
  const spec = CODE_ZOO.find((c) => c.key === codeKey) ?? CODE_ZOO[0];

  // Building + distance + decoder are memoised: distance() brute-forces 4ⁿ Paulis.
  const code = useMemo(() => spec.build(), [spec]);
  const info = useMemo(() => {
    const d = code.distance();
    return {
      d,
      valid: code.validity().ok,
      perfect: code.perfect(),
      t: Math.floor((d - 1) / 2),
      decoder: code.buildDecoder(1),
    };
  }, [code]);

  return (
    <div style={{ maxWidth: 820 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        A from-scratch <b style={{ color: '#a78bfa' }}>general stabilizer-code engine</b>. A code is just a
        set of commuting Pauli generators; everything — the <b>syndrome</b> of an error, the exact
        <b> code distance</b>, whether the code is <b>perfect</b>, and the recovery operator — is pure
        GF(2) symplectic linear algebra, no state vector required. The headline is the
        <b style={{ color: '#67e8f9' }}> perfect five-qubit [[5,1,3]] code</b>: the smallest code that
        corrects an arbitrary single-qubit error, non-CSS (genuinely entangling), with its 16 syndromes
        in exact bijection onto the 15 single-qubit errors plus the identity.
      </p>

      <Card title="Code" accent="#a78bfa">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <select value={codeKey} onChange={(e) => setCodeKey(e.target.value)} style={sel}>
            {CODE_ZOO.map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
          </select>
        </div>
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 12px', lineHeight: 1.6 }}>{spec.blurb}</p>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <Metric label="parameters" value={`[[${code.n},${code.k},${info.d}]]`} color="#a78bfa" />
          <Metric label="stabilizers" value={`${code.numChecks}`} color="#67e8f9" />
          <Metric label="corrects" value={info.t >= 1 ? `≤${info.t} error${info.t > 1 ? 's' : ''}` : 'detect only'} color="#34d399" />
          <Metric label="perfect?" value={info.perfect ? '✓ Hamming' : '—'} color={info.perfect ? '#34d399' : '#475569'} />
          <Metric label="well-formed" value={info.valid ? '✓ verified' : '✗'} color={info.valid ? '#34d399' : '#f87171'} />
        </div>

        <div style={{ background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 14px', overflowX: 'auto' }}>
          {code.stabs.map((g, i) => <PauliRow key={i} label={`g${i + 1}`} pauli={pauliString(g)} />)}
          <div style={{ height: 1, background: '#1e293b', margin: '6px 0' }} />
          {code.logicalX.map((l, i) => <PauliRow key={`x${i}`} label={code.k > 1 ? `X̄${i + 1}` : 'X̄'} pauli={pauliString(l)} accent="#f87171" />)}
          {code.logicalZ.map((l, i) => <PauliRow key={`z${i}`} label={code.k > 1 ? `Z̄${i + 1}` : 'Z̄'} pauli={pauliString(l)} accent="#34d399" />)}
        </div>
        <p style={{ fontSize: 10, color: '#475569', margin: '8px 0 0', lineHeight: 1.5 }}>
          The {code.numChecks} generators gᵢ commute and fix a 2<sup>{code.k}</sup>-dimensional code space;
          the logical operators X̄/Z̄ are the minimal Paulis that act <i>within</i> it. The distance d={info.d}
          {info.perfect && <> saturates the quantum Hamming bound 2<sup>n−k</sup> = Σⱼ C(n,j)·3ʲ</>} — computed
          here by brute-force search over all 4<sup>{code.n}</sup> Paulis for the lightest non-trivial logical.
        </p>
      </Card>

      <SyndromeTableCard code={code} perfect={info.perfect} />
      <LiveCycleCard code={code} />
      <ThresholdCard codeKey={codeKey} />
    </div>
  );
}

/** The full syndrome → recovery lookup table the decoder uses. */
function SyndromeTableCard({ code, perfect }: { code: StabilizerCode; perfect: boolean }) {
  const rows = useMemo(() => {
    // For every single-qubit error, show its syndrome and the recovery the table assigns.
    const out: { err: string; syn: string; rec: string }[] = [];
    const types: ('X' | 'Y' | 'Z')[] = ['X', 'Y', 'Z'];
    for (let q = 0; q < code.n; q++) for (const t of types) {
      const e = singleError(code.n, q, t);
      const syn = code.syndrome(e);
      const rec = code.decode(syn);
      out.push({ err: pauliString(e), syn: syn.join(''), rec: pauliString(rec) });
    }
    return out;
  }, [code]);

  const distinct = new Set(rows.map((r) => r.syn));
  const collisions = rows.length - distinct.size;

  return (
    <Card title="Syndrome → recovery table" accent="#67e8f9">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Each single-qubit error anticommutes with some generators, giving a {code.numChecks}-bit syndrome.
        {perfect
          ? ' Because this code is perfect, the map is a bijection: every error has a unique syndrome and is corrected exactly.'
          : ' Errors that share a syndrome (or give the all-zero syndrome) are not uniquely correctable — the hallmark of a finite distance.'}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 6 }}>
        {rows.map((r, i) => {
          const zero = /^0+$/.test(r.syn);
          return (
            <div key={i} style={{
              background: 'rgba(2,6,23,0.5)', border: `1px solid ${zero ? '#7f1d1d' : '#1e293b'}`, borderRadius: 6,
              padding: '5px 9px', fontFamily: 'monospace', fontSize: 11,
            }}>
              <span style={{ color: '#94a3b8' }}>{r.err}</span>
              <span style={{ color: '#475569' }}> → </span>
              <span style={{ color: zero ? '#f87171' : '#67e8f9' }}>{r.syn}</span>
              <span style={{ color: '#475569' }}> ⇒ </span>
              <span style={{ color: '#34d399' }}>{r.rec}</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <Metric label="single errors" value={`${rows.length}`} color="#a78bfa" />
        <Metric label="distinct syndromes" value={`${distinct.size}`} color="#67e8f9" />
        <Metric label="bijection?" value={perfect ? '✓ perfect' : (collisions === 0 ? '—' : '✗ collisions')} color={perfect ? '#34d399' : '#475569'} />
      </div>
    </Card>
  );
}

/** Inject an error and run the live encode→syndrome→correct→verify cycle on the CHP tableau. */
function LiveCycleCard({ code }: { code: StabilizerCode }) {
  const [type, setType] = useState<'X' | 'Y' | 'Z'>('Y');
  const [qubit, setQubit] = useState(0);
  const [q2, setQ2] = useState(-1); // optional second-qubit error (to provoke a distance-limited failure)

  const safeQubit = Math.min(qubit, code.n - 1);
  const run = useMemo(() => {
    let err: Pauli = singleError(code.n, safeQubit, type);
    if (q2 >= 0 && q2 < code.n && q2 !== safeQubit) {
      const e2 = singleError(code.n, q2, type);
      err = { x: err.x.map((b, i) => b ^ e2.x[i]), z: err.z.map((b, i) => b ^ e2.z[i]) };
    }
    return { run: runCodeCycle(code, err), errStr: pauliString(err) };
  }, [code, type, safeQubit, q2]);

  const r = run.run;
  return (
    <Card title="Live syndrome decoding on the stabilizer tableau" accent="#34d399">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        The logical |0…0⟩<sub>L</sub> is loaded directly from the generators (no encoding circuit), an error
        is injected, and the syndrome is read off the <i>live</i> tableau — then cross-checked against the pure
        symplectic syndrome (two independent code paths). The recovery is applied and every stabilizer and
        logical-Z is confirmed back at +1.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={type} onChange={(e) => setType(e.target.value as 'X' | 'Y' | 'Z')} style={sel}>
          {(['X', 'Y', 'Z'] as const).map((t) => <option key={t} value={t}>{t} error</option>)}
        </select>
        <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' }}>
          on qubit
          <input type="range" min={0} max={code.n - 1} value={safeQubit} onChange={(e) => setQubit(parseInt(e.target.value))} style={{ accentColor: '#059669' }} />
          <span style={{ fontFamily: 'monospace', color: '#34d399', width: 14 }}>{safeQubit}</span>
        </label>
        <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' }}>
          + 2nd on
          <input type="range" min={-1} max={code.n - 1} value={q2} onChange={(e) => setQ2(parseInt(e.target.value))} style={{ accentColor: '#b45309' }} />
          <span style={{ fontFamily: 'monospace', color: '#fbbf24', width: 24 }}>{q2 < 0 ? 'off' : `q${q2}`}</span>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Metric label="injected error" value={run.errStr} color="#fbbf24" />
        <Metric label="syndrome" value={r.syndrome.join('') || '∅'} color="#67e8f9" />
        <Metric label="recovery" value={r.correction || 'I'} color="#34d399" />
        <Metric label="residual" value={r.residual === 'logical' ? 'logical ✗' : r.residual === 'I' ? 'trivial' : 'stabilizer'} color={r.residual === 'logical' ? '#f87171' : '#34d399'} />
        <Metric label="recovered" value={r.recovered && r.residual !== 'logical' ? '✓ yes' : '✗ no'} color={r.recovered && r.residual !== 'logical' ? '#34d399' : '#f87171'} />
        <Metric label="tableau ≡ symplectic" value={r.syndromeMatchesSymplectic ? '✓' : '✗'} color={r.syndromeMatchesSymplectic ? '#34d399' : '#f87171'} />
      </div>
      <p style={{ fontSize: 10, color: '#475569', margin: '10px 0 0', lineHeight: 1.5 }}>
        Try a <b style={{ color: '#fbbf24' }}>second-qubit error</b>: a distance-3 code corrects any single
        error but a weight-2 error can push the state across a logical operator (a genuine logical failure) —
        that is exactly what d=3 means.
      </p>
    </Card>
  );
}

const SWEEP_P = [0.005, 0.01, 0.02, 0.035, 0.05, 0.07, 0.1, 0.14, 0.18, 0.25];

/** Monte-Carlo logical error rate vs depolarizing rate, with the bare-qubit break-even line. */
function ThresholdCard({ codeKey }: { codeKey: string }) {
  const [data, setData] = useState<{ key: string; pts: { p: number; pL: number }[] }[] | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    setTimeout(() => {
      const codes = ['five', 'steane', 'shor'].includes(codeKey)
        ? [codeKey, ...['five', 'steane', 'shor'].filter((k) => k !== codeKey)]
        : [codeKey, 'five'];
      const out = codes.map((key) => {
        const c = (CODE_ZOO.find((s) => s.key === key) ?? CODE_ZOO[0]).build();
        const rng = mulberry32(0xC0DE + key.length);
        return { key, pts: SWEEP_P.map((p) => ({ p, pL: c.logicalErrorRate(p, 6000, rng) })) };
      });
      setData(out);
      setBusy(false);
    }, 20);
  };

  return (
    <Card title="Logical error rate & the pseudo-threshold" accent="#f472b6">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Under depolarizing noise of rate <i>p</i>, a bare qubit fails with probability <i>p</i> (the diagonal).
        A distance-3 code instead fails only on ≥2 errors, so its logical error rate is ≈ A·p² — below the
        <b style={{ color: '#f472b6' }}> pseudo-threshold</b> where the curve crosses the diagonal, encoding
        <i> helps</i>; above it, the extra qubits only add noise.
      </p>
      <button onClick={run} disabled={busy} style={btn('#db2777')}>{busy ? 'Sampling…' : '▶ Run Monte-Carlo sweep'}</button>
      {data && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12 }}>
          <ThresholdPlot data={data} />
        </motion.div>
      )}
    </Card>
  );
}

const SERIES_COLOR: Record<string, string> = { five: '#67e8f9', steane: '#a78bfa', shor: '#fbbf24', c422: '#34d399', bitflip: '#f87171' };
const SERIES_LABEL: Record<string, string> = { five: '[[5,1,3]]', steane: '[[7,1,3]]', shor: '[[9,1,3]]', c422: '[[4,2,2]]', bitflip: '[[3,1,1]]' };

function ThresholdPlot({ data }: { data: { key: string; pts: { p: number; pL: number }[] }[] }) {
  const w = 520, h = 300, pad = 40;
  const maxP = 0.25, maxPL = 0.6;
  const xs = (p: number) => pad + (p / maxP) * (w - pad - 12);
  const ys = (v: number) => h - pad - (v / maxPL) * (h - pad - 12);
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 8, border: '1px solid #1e293b' }}>
      {[0, 0.15, 0.3, 0.45, 0.6].map((v) => (
        <g key={v}>
          <line x1={pad} y1={ys(v)} x2={w - 12} y2={ys(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 5} y={ys(v) + 3} fontSize={9} fill="#475569" textAnchor="end">{v.toFixed(2)}</text>
        </g>
      ))}
      {[0, 0.05, 0.1, 0.15, 0.2, 0.25].map((p) => (
        <text key={p} x={xs(p)} y={h - pad + 14} fontSize={9} fill="#475569" textAnchor="middle">{(p * 100).toFixed(0)}%</text>
      ))}
      {/* bare-qubit break-even diagonal p_L = p */}
      <line x1={xs(0)} y1={ys(0)} x2={xs(maxPL < maxP ? maxPL : maxP)} y2={ys(maxPL < maxP ? maxPL : maxP)} stroke="#64748b" strokeWidth={1.5} strokeDasharray="5 4" />
      <text x={xs(0.2)} y={ys(0.2) - 5} fontSize={9} fill="#64748b" transform={`rotate(-22 ${xs(0.2)} ${ys(0.2)})`}>bare qubit p_L = p</text>
      {data.map((series) => {
        const color = SERIES_COLOR[series.key] ?? '#e2e8f0';
        const path = series.pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${xs(pt.p).toFixed(1)},${ys(pt.pL).toFixed(1)}`).join(' ');
        return (
          <g key={series.key}>
            <path d={path} fill="none" stroke={color} strokeWidth={2} opacity={0.9} />
            {series.pts.map((pt, i) => <circle key={i} cx={xs(pt.p)} cy={ys(pt.pL)} r={2.5} fill={color} />)}
          </g>
        );
      })}
      <text x={w - 12} y={h - 6} fontSize={9} fill="#64748b" textAnchor="end">depolarizing rate p</text>
      <text x={pad - 5} y={12} fontSize={9} fill="#64748b" textAnchor="end">p_L</text>
      {data.map((s, i) => (
        <g key={s.key}>
          <rect x={pad + 8 + i * 96} y={10} width={10} height={3} fill={SERIES_COLOR[s.key] ?? '#e2e8f0'} />
          <text x={pad + 22 + i * 96} y={14} fontSize={9} fill="#94a3b8">{SERIES_LABEL[s.key] ?? s.key}</text>
        </g>
      ))}
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
