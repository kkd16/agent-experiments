import { useMemo, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { CODE_ZOO, type ZooEntry } from '../quantum/codes/codeZoo';
import { StabilizerCode, enumeratePaulis } from '../quantum/codes/stabilizerCode';
import { buildDecoder, correctionFor, sweepLER, pseudoThreshold, mulberry32 } from '../quantum/codes/decoder';
import { crossCheck } from '../quantum/codes/tableauCheck';
import { type SymPauli, pauliLetter, pauliString, identity, multiply, weight } from '../quantum/codes/pauli';

const PAULI_COLOR: Record<string, string> = { X: '#f87171', Y: '#fbbf24', Z: '#34d399', I: '#1e293b' };
const FAMILY_COLOR: Record<ZooEntry['family'], string> = {
  repetition: '#64748b', detecting: '#0891b2', perfect: '#a78bfa', css: '#34d399', concatenated: '#f59e0b',
};

/** A coloured Pauli string. */
function PauliRow({ p, label, labelColor }: { p: SymPauli; label: string; labelColor?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'monospace', fontSize: 13, lineHeight: 1.7 }}>
      <span style={{ color: labelColor ?? '#475569', fontSize: 10, width: 30, textAlign: 'right' }}>{label}</span>
      <span style={{ color: p.sign ? '#f87171' : '#475569', width: 8 }}>{p.sign ? '−' : '+'}</span>
      {p.x.map((_, q) => {
        const l = pauliLetter(p.x[q], p.z[q]);
        return <span key={q} style={{ color: PAULI_COLOR[l], fontWeight: l === 'I' ? 400 : 800, width: 12, textAlign: 'center' }}>{l}</span>;
      })}
    </div>
  );
}

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 20, whiteSpace: 'nowrap',
      color: ok ? '#34d399' : '#f87171', background: ok ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
      border: `1px solid ${ok ? 'rgba(52,211,153,0.35)' : 'rgba(248,113,113,0.35)'}`,
    }}>{ok ? '✓ ' : '✕ '}{children}</span>
  );
}

/** Cycle a single-qubit Pauli I → X → Y → Z → I. */
function cyclePauli(p: SymPauli, q: number): SymPauli {
  const next = { x: p.x.slice(), z: p.z.slice(), sign: 0 as const };
  const cur = (p.x[q] ? 1 : 0) + (p.z[q] ? 2 : 0); // I0 X1 Z2 Y3 → want I→X→Y→Z
  const order = [0, 1, 3, 2]; // I, X, Y, Z
  const idx = (order.indexOf(cur) + 1) % 4;
  const v = order[idx];
  next.x[q] = v & 1; next.z[q] = (v >> 1) & 1;
  return next;
}

interface SweepRow { code: StabilizerCode; entry: ZooEntry; color: string; points: { p: number; pL: number }[]; pth: number | null; }

const SWEEP_COLORS = ['#a78bfa', '#34d399', '#f59e0b', '#67e8f9', '#f472b6', '#94a3b8'];
const PS = [0.01, 0.02, 0.035, 0.05, 0.07, 0.1, 0.14, 0.2, 0.28, 0.38];

export default function CodeZooLab() {
  const [sel, setSel] = useState(3); // default: the [[5,1,3]] perfect code
  const entry = CODE_ZOO[sel];

  const { code, dec, validity, xcheck, t } = useMemo(() => {
    const code = new StabilizerCode(entry.stabilizers);
    const dec = buildDecoder(code);
    const validity = code.validate(entry.stabilizers);
    const t = code.correctableWeight();
    const xcheck = crossCheck(code, dec, enumeratePaulis(code.n, 1));
    return { code, dec, validity, xcheck, t };
  }, [entry]);

  const [err, setErr] = useState<SymPauli>(() => identity(code.n));
  // keep err sized to the current code
  const error = err.x.length === code.n ? err : identity(code.n);

  const decoded = useMemo(() => {
    const syn = code.syndrome(error);
    const correction = correctionFor(code, dec, error);
    const residual = multiply(error, correction);
    const inS = code.inStabilizer(residual);
    const detected = syn.some((b) => b);
    return { syn, correction, residual, inS, detected };
  }, [code, dec, error]);

  const setErrOnQubit = useCallback((q: number) => setErr((p) => {
    const base = p.x.length === code.n ? p : identity(code.n);
    return cyclePauli(base, q);
  }), [code.n]);

  const randomError = useCallback(() => {
    setErr(() => {
      const e = identity(code.n);
      const w = 1 + Math.floor(Math.random() * Math.min(2, code.n));
      const picks = new Set<number>();
      while (picks.size < w) picks.add(Math.floor(Math.random() * code.n));
      for (const q of picks) { const v = 1 + Math.floor(Math.random() * 3); e.x[q] = v & 1; e.z[q] = (v >> 1) & 1; }
      return e;
    });
  }, [code.n]);

  // --- threshold sweep (computed on demand) ---
  const [sweep, setSweep] = useState<SweepRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const runSweep = useCallback(() => {
    setBusy(true);
    setTimeout(() => {
      const rows: SweepRow[] = CODE_ZOO.map((e, i) => {
        const c = new StabilizerCode(e.stabilizers);
        const dc = buildDecoder(c);
        const rng = mulberry32(0x51ab ^ (i * 2654435761));
        const res = sweepLER(c, dc, PS, 4000, rng);
        return { code: c, entry: e, color: SWEEP_COLORS[i % SWEEP_COLORS.length], points: res.map((r) => ({ p: r.p, pL: r.pL })), pth: pseudoThreshold(res) };
      });
      setSweep(rows);
      setBusy(false);
    }, 20);
  }, []);

  return (
    <div style={{ maxWidth: 860 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 16px', lineHeight: 1.6 }}>
        A stabilizer code is defined by a handful of commuting Pauli checks — and <em>everything</em> else
        (the <code>[[n,k,d]]</code> label, the logical operators, the syndrome table, the fault-tolerance
        threshold) is <strong>derived</strong> from them by exact GF(2) symplectic linear algebra. Pick a code
        from the zoo; the panel recomputes its whole theory from the generators alone, and cross-checks every
        claim against the from-scratch CHP tableau simulator.
      </p>

      {/* code selector */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
        {CODE_ZOO.map((e, i) => (
          <button key={e.key} onClick={() => setSel(i)} style={{
            padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: sel === i ? 700 : 500,
            border: `1px solid ${sel === i ? FAMILY_COLOR[e.family] : '#1e293b'}`,
            background: sel === i ? `${FAMILY_COLOR[e.family]}22` : 'rgba(2,6,23,0.4)',
            color: sel === i ? '#e2e8f0' : '#94a3b8', transition: 'all .15s',
          }}>{e.name}</button>
        ))}
      </div>

      <motion.div key={entry.key} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{ fontFamily: 'monospace', fontSize: 26, fontWeight: 800, color: FAMILY_COLOR[entry.family] }}>{code.label()}</span>
          <span style={{ fontSize: 16, color: '#e2e8f0', fontWeight: 700 }}>{entry.name}</span>
          <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: FAMILY_COLOR[entry.family], border: `1px solid ${FAMILY_COLOR[entry.family]}55`, borderRadius: 4, padding: '2px 6px' }}>{entry.family}</span>
        </div>
        <p style={{ color: '#94a3b8', fontSize: 12.5, lineHeight: 1.65, margin: '0 0 14px' }}>{entry.blurb}</p>

        {/* validity + property badges */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
          <Badge ok={validity.commuting}>generators commute</Badge>
          <Badge ok={validity.independent}>independent (r = {code.r})</Badge>
          <Badge ok={xcheck.prepared}>codeword prepared on tableau</Badge>
          <Badge ok={xcheck.syndromeAgree}>syndromes match simulator</Badge>
          <Badge ok={xcheck.corrected}>weight-1 errors corrected live</Badge>
          {code.isCSS() && <span style={pill('#34d399')}>CSS code</span>}
          {entry.family === 'perfect' && <span style={pill('#a78bfa')}>perfect · saturates Hamming bound</span>}
          <span style={pill('#64748b')}>corrects any weight ≤ {Number.isFinite(t) ? t : '—'}</span>
        </div>

        {/* generators & logicals */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
          <Card title={`${code.r} stabilizer generators`}>
            {code.gens.map((g, i) => <PauliRow key={i} p={g} label={`g${i + 1}`} />)}
          </Card>
          <Card title={`${code.k} logical qubit${code.k === 1 ? '' : 's'} · derived operators`}>
            {code.k === 0 ? <span style={{ color: '#475569', fontSize: 12 }}>no logical qubits</span> :
              code.logicalX.map((_, i) => (
                <div key={i}>
                  <PauliRow p={code.logicalX[i]} label={`X̄${sub(i + 1, code.k)}`} labelColor="#f87171" />
                  <PauliRow p={code.logicalZ[i]} label={`Z̄${sub(i + 1, code.k)}`} labelColor="#34d399" />
                </div>
              ))}
          </Card>
        </div>

        {/* interactive decoder */}
        <Card title="Inject an error — watch the syndrome decode">
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
            Click a qubit to cycle its error <span style={{ color: PAULI_COLOR.X }}>I→X→Y→Z</span>. The syndrome is
            the parity of each check against the error; the decoder returns the minimum-weight fix; success means the
            residual lands back in the stabilizer group.
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
            {Array.from({ length: code.n }, (_, q) => {
              const l = pauliLetter(error.x[q], error.z[q]);
              return (
                <button key={q} onClick={() => setErrOnQubit(q)} style={{
                  width: 38, height: 44, borderRadius: 8, cursor: 'pointer', fontFamily: 'monospace', fontSize: 16, fontWeight: 800,
                  border: `1px solid ${l === 'I' ? '#1e293b' : PAULI_COLOR[l]}`, background: l === 'I' ? 'rgba(2,6,23,0.5)' : `${PAULI_COLOR[l]}22`, color: PAULI_COLOR[l] === '#1e293b' ? '#475569' : PAULI_COLOR[l],
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                }}>
                  <span>{l}</span>
                  <span style={{ fontSize: 8, color: '#475569' }}>q{q}</span>
                </button>
              );
            })}
            <button onClick={randomError} style={{ ...miniBtn, marginLeft: 6 }}>🎲 random</button>
            <button onClick={() => setErr(identity(code.n))} style={miniBtn}>clear</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontFamily: 'monospace', fontSize: 12.5, alignItems: 'center' }}>
            <span style={{ color: '#64748b' }}>error E</span>
            <span style={{ color: '#e2e8f0' }}>{pauliString(error)}  <span style={{ color: '#475569' }}>(weight {weight(error)})</span></span>
            <span style={{ color: '#64748b' }}>syndrome</span>
            <span>{decoded.syn.map((b, i) => <span key={i} style={{ color: b ? '#fbbf24' : '#334155', fontWeight: 800 }}>{b}</span>)}
              <span style={{ color: '#475569', marginLeft: 8 }}>{decoded.detected ? 'error detected' : 'trivial syndrome'}</span></span>
            <span style={{ color: '#64748b' }}>correction C</span>
            <span style={{ color: '#a78bfa' }}>{pauliString(decoded.correction)}</span>
            <span style={{ color: '#64748b' }}>residual E·C</span>
            <span style={{ color: decoded.inS ? '#34d399' : '#f87171' }}>{pauliString(decoded.residual)}</span>
          </div>
          <div style={{ marginTop: 12 }}>
            {weight(error) === 0 ? (
              <span style={verdict('#64748b')}>no error</span>
            ) : decoded.inS ? (
              <span style={verdict('#34d399')}>✓ RECOVERED — residual is a stabilizer, logical state intact</span>
            ) : (
              <span style={verdict('#f87171')}>✕ LOGICAL FAILURE — residual is a nontrivial logical operator{weight(error) > t ? ` (weight ${weight(error)} > t = ${t})` : ''}</span>
            )}
          </div>
        </Card>

        {/* threshold plot */}
        <Card title="Code-capacity threshold — where does encoding start to help?">
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
            Monte-Carlo logical error rate p<sub>L</sub> vs physical depolarizing rate p, in log–log. A code helps
            wherever its curve dips <em>below</em> the grey break-even line p<sub>L</sub> = p; the crossing is its
            pseudo-threshold. Distance-3 codes fall as p<sub>L</sub> ∝ p², the classic quadratic suppression.
          </div>
          {!sweep ? (
            <button onClick={runSweep} disabled={busy} style={runBtn}>{busy ? 'Running 240k shots…' : '▶ Run Monte-Carlo sweep (all codes)'}</button>
          ) : (
            <>
              <ThresholdPlot rows={sweep} highlight={entry.key} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10, justifyContent: 'center' }}>
                {sweep.map((r) => (
                  <span key={r.entry.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: r.entry.key === entry.key ? '#e2e8f0' : '#94a3b8' }}>
                    <span style={{ width: 11, height: 3, background: r.color, borderRadius: 2 }} />
                    {r.entry.name} {r.pth ? <span style={{ color: '#64748b' }}>· p*≈{(r.pth * 100).toFixed(1)}%</span> : ''}
                  </span>
                ))}
              </div>
              <button onClick={runSweep} disabled={busy} style={{ ...runBtn, marginTop: 12 }}>{busy ? 'Running…' : '↻ Re-run'}</button>
            </>
          )}
        </Card>
      </motion.div>
    </div>
  );
}

function ThresholdPlot({ rows, highlight }: { rows: SweepRow[]; highlight: string }) {
  const w = 560, h = 340, padL = 54, padB = 42, padT = 16, padR = 16;
  const lx = (p: number) => Math.log10(p);
  const ly = (pL: number) => Math.log10(Math.max(pL, 1e-5));
  const xMin = lx(0.008), xMax = lx(0.45), yMin = ly(1e-4), yMax = ly(1);
  const X = (p: number) => padL + ((lx(p) - xMin) / (xMax - xMin)) * (w - padL - padR);
  const Y = (pL: number) => padT + (1 - (ly(pL) - yMin) / (yMax - yMin)) * (h - padT - padB);
  const decades = [-4, -3, -2, -1, 0];
  const xticks = [0.01, 0.02, 0.05, 0.1, 0.2, 0.4];
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 8, border: '1px solid #1e293b' }}>
      {decades.map((e) => (
        <g key={e}>
          <line x1={padL} y1={Y(10 ** e)} x2={w - padR} y2={Y(10 ** e)} stroke="#1e293b" strokeWidth={1} />
          <text x={padL - 8} y={Y(10 ** e) + 3} fontSize={9} fill="#64748b" textAnchor="end">10{sup(e)}</text>
        </g>
      ))}
      {xticks.map((p) => (
        <g key={p}>
          <line x1={X(p)} y1={padT} x2={X(p)} y2={h - padB} stroke="#0f172a" strokeWidth={1} />
          <text x={X(p)} y={h - padB + 14} fontSize={9} fill="#64748b" textAnchor="middle">{(p * 100).toFixed(p < 0.1 ? 1 : 0)}%</text>
        </g>
      ))}
      {/* break-even line pL = p */}
      <line x1={X(0.008)} y1={Y(0.008)} x2={X(0.45)} y2={Y(0.45)} stroke="#475569" strokeWidth={1.4} strokeDasharray="5 4" />
      <text x={X(0.32)} y={Y(0.32) - 6} fontSize={9} fill="#64748b" textAnchor="middle" transform={`rotate(30 ${X(0.32)} ${Y(0.32)})`}>break-even p_L = p</text>
      {rows.map((r) => {
        const pts = r.points.filter((q) => q.pL > 0);
        const path = pts.map((q, i) => `${i === 0 ? 'M' : 'L'}${X(q.p).toFixed(1)},${Y(q.pL).toFixed(1)}`).join(' ');
        const hot = r.entry.key === highlight;
        return (
          <g key={r.entry.key} opacity={hot ? 1 : 0.6}>
            <path d={path} fill="none" stroke={r.color} strokeWidth={hot ? 2.6 : 1.5} />
            {pts.map((q, i) => <circle key={i} cx={X(q.p)} cy={Y(q.pL)} r={hot ? 3 : 2} fill={r.color} />)}
          </g>
        );
      })}
      <text x={padL - 40} y={padT + (h - padT - padB) / 2} fontSize={10} fill="#64748b" textAnchor="middle" transform={`rotate(-90 ${padL - 40} ${padT + (h - padT - padB) / 2})`}>logical error rate p_L</text>
      <text x={(w + padL) / 2} y={h - 4} fontSize={10} fill="#64748b" textAnchor="middle">physical depolarizing rate p</text>
    </svg>
  );
}

// --- small style helpers ---
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(2,6,23,0.4)', border: '1px solid #1e293b', borderRadius: 10, padding: 14, marginBottom: 16 }}>
      <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}
const pill = (c: string): React.CSSProperties => ({ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 20, color: c, background: `${c}18`, border: `1px solid ${c}55` });
const verdict = (c: string): React.CSSProperties => ({ fontSize: 12.5, fontWeight: 700, color: c, fontFamily: 'monospace' });
const miniBtn: React.CSSProperties = { padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 11, border: '1px solid #1e293b', background: 'rgba(2,6,23,0.5)', color: '#94a3b8', height: 44 };
const runBtn: React.CSSProperties = { padding: '9px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 700, border: '1px solid #7c3aed55', background: 'rgba(124,58,237,0.18)', color: '#a78bfa' };

function sub(i: number, k: number): string { return k === 1 ? '' : String(i); }
function sup(e: number): string { const m: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴' }; return String(e).split('').map((c) => m[c] ?? c).join(''); }
