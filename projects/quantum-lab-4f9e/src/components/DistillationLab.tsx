import { useMemo, useState } from 'react';
import {
  distill, exactThreshold, LEADING_THRESHOLD, distillCascade, distillMonteCarlo,
  weightEnumerator, CODE_FACTS,
} from '../quantum/distillation';

export default function DistillationLab() {
  return (
    <div style={{ maxWidth: 820 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        The <b style={{ color: '#a78bfa' }}>Solovay–Kitaev</b> tab compiles a computation into{' '}
        <code>{'{'}H, T{'}'}</code> and reports its <b style={{ color: '#34d399' }}>T-count</b>. But the
        T gate cannot be applied transversally on a fault-tolerant machine — each one must be teleported in
        from a <b style={{ color: '#34d399' }}>magic state</b> <code>|T⟩ = (|0⟩ + e<sup>iπ/4</sup>|1⟩)/√2</code>{' '}
        prepared offline, and offline preparation is noisy. <b style={{ color: '#a78bfa' }}>Magic-state
        distillation</b> fixes that: the Bravyi–Kitaev <b style={{ color: '#67e8f9' }}>15-to-1 routine</b> —
        built on the <code>[[15,1,3]]</code> Reed–Muller code that admits a transversal T — turns 15 noisy
        copies into one far cleaner copy using only Clifford gates and post-selection. Its error analysis
        reduces exactly to the classical <code>[15,11,3]</code> Hamming code, and because that code has
        distance 3 with exactly <b style={{ color: '#34d399' }}>35</b> weight-3 logicals, the output error
        obeys the famous cubic law <code style={{ color: '#34d399' }}>p_out = 35 p³</code>. Everything here is
        the exact code enumeration, cross-checked against a Monte-Carlo of the post-selected protocol.
      </p>

      <RoutineCard />
      <CascadeCard />
      <CurveCard />
    </div>
  );
}

// ─────────────────────────────── the 15-to-1 routine ───────────────────────────────

function RoutineCard() {
  const [p, setP] = useState(0.05);
  const res = useMemo(() => distill(p), [p]);
  const thr = useMemo(() => exactThreshold(), []);

  return (
    <Card title="The 15-to-1 routine" accent="#a78bfa">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <Stat label="code" value={`[[${CODE_FACTS.n},${CODE_FACTS.k},${CODE_FACTS.d}]]`} />
        <Stat label="X-stabilizers" value={`${CODE_FACTS.xStabilizers} (Hamming)`} />
        <Stat label="Z-stabilizers" value={String(CODE_FACTS.zStabilizers)} />
        <Stat label="weight-3 logicals" value={String(CODE_FACTS.weight3Logicals)} accent="#34d399" />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginBottom: 3 }}>
          <span>input error rate p (per noisy |T⟩)</span>
          <span style={{ fontFamily: 'monospace', color: '#a78bfa' }}>{(p * 100).toFixed(2)}%</span>
        </div>
        <input type="range" min={0.002} max={0.3} step={0.002} value={p}
          onChange={(e) => setP(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: '#7c3aed' }} />
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Stat label="output error p_out" value={res.pOut.toExponential(3)} accent="#34d399" />
        <Stat label="leading 35 p³" value={res.leading.toExponential(3)} />
        <Stat label="suppression p/p_out" value={`${(p / res.pOut).toFixed(1)}×`} />
        <Stat label="acceptance prob" value={`${(res.pAccept * 100).toFixed(1)}%`} />
        <Stat label="distillation helps?" value={res.improves ? 'yes' : 'no — above p*'} ok={res.improves} />
      </div>

      <div style={{
        padding: '10px 12px', background: res.improves ? 'rgba(52,211,153,0.08)' : 'rgba(245,158,11,0.08)',
        border: `1px solid ${res.improves ? 'rgba(52,211,153,0.3)' : 'rgba(245,158,11,0.3)'}`, borderRadius: 8,
      }}>
        <span style={{ fontSize: 11, color: res.improves ? '#34d399' : '#f59e0b', lineHeight: 1.5 }}>
          {res.improves
            ? `p = ${(p * 100).toFixed(2)}% is below the threshold p* ≈ ${(thr * 100).toFixed(1)}% — the output is cleaner than the input, so repeating the routine drives the error to zero.`
            : `p = ${(p * 100).toFixed(2)}% is above the threshold p* ≈ ${(thr * 100).toFixed(1)}% — distillation makes things worse. Raw states must be prepared below threshold for this to work.`}
        </span>
      </div>
      <p style={{ color: '#475569', fontSize: 10, margin: '8px 0 0', lineHeight: 1.5 }}>
        The exact threshold p* ≈ {(thr * 100).toFixed(1)}% (where p_out = p) sits below the leading-order
        estimate 1/√35 ≈ {(LEADING_THRESHOLD * 100).toFixed(1)}% because of the positive higher-order terms.
        15 inputs yield 1 output, and the routine is heralded — it accepts only {(res.pAccept * 100).toFixed(1)}% of
        batches at this p, discarding the rest.
      </p>
    </Card>
  );
}

// ─────────────────────────────── cascade ───────────────────────────────

function CascadeCard() {
  const [p, setP] = useState(0.08);
  const [rounds, setRounds] = useState(3);
  const casc = useMemo(() => distillCascade(p, rounds), [p, rounds]);
  const diverges = casc.some((c, i) => i > 0 && c.p >= casc[i - 1].p);

  return (
    <Card title="Cascading rounds — doubly-exponential suppression" accent="#67e8f9">
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ ...lab, flex: 1, minWidth: 220 }}>
          <span style={{ whiteSpace: 'nowrap' }}>raw p {(p * 100).toFixed(1)}%</span>
          <input type="range" min={0.01} max={0.18} step={0.005} value={p}
            onChange={(e) => setP(parseFloat(e.target.value))} style={{ flex: 1, accentColor: '#0891b2' }} />
        </label>
        <label style={lab}>rounds
          <select value={rounds} onChange={(e) => setRounds(parseInt(e.target.value))} style={sel}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 10px', lineHeight: 1.55 }}>
        Feed the cleaned output back in: round r reaches error{' '}
        <code style={{ color: '#67e8f9' }}>≈ 35<sup>(3<sup>r</sup>−1)/2</sup> p<sup>3<sup>r</sup></sup></code> —
        the exponent triples each round. The cost is steep: 15<sup>r</sup> raw states per output.
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: 11, width: '100%' }}>
          <thead>
            <tr style={{ color: '#475569', textAlign: 'right' }}>
              <th style={th}>round</th><th style={th}>error p</th><th style={th}>vs previous</th>
              <th style={th}>raw states / output</th>
            </tr>
          </thead>
          <tbody>
            {casc.map((c, i) => (
              <tr key={c.round} style={{ color: '#cbd5e1', textAlign: 'right' }}>
                <td style={td}>{c.round}</td>
                <td style={{ ...td, color: c.round === 0 ? '#f59e0b' : '#34d399' }}>{c.p.toExponential(3)}</td>
                <td style={{ ...td, color: '#64748b' }}>{i === 0 ? 'raw' : `${(casc[i - 1].p / c.p).toExponential(1)}× better`}</td>
                <td style={td}>{c.rawStates.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {diverges && (
        <p style={{ color: '#f59e0b', fontSize: 11, margin: '10px 0 0' }}>
          ⚠ At this input rate the routine is above threshold — iterating makes the error grow, not shrink.
          Lower the raw p below ≈14%.
        </p>
      )}
    </Card>
  );
}

// ─────────────────────────────── suppression curve + cross-checks ───────────────────────────────

function CurveCard() {
  const thr = useMemo(() => exactThreshold(), []);
  const A = useMemo(() => weightEnumerator(), []);
  const mc = useMemo(() => distillMonteCarlo(0.1, 300000, 7), []);
  const exact = useMemo(() => distill(0.1).pOut, []);

  return (
    <Card title="Suppression curve, threshold & cross-checks" accent="#f59e0b">
      <SuppressionPlot thr={thr} />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '14px 0 14px' }}>
        <Stat label="exact threshold p*" value={`${(thr * 100).toFixed(2)}%`} accent="#a78bfa" />
        <Stat label="Monte-Carlo p_out (p=10%)" value={mc.pOut.toExponential(3)} />
        <Stat label="exact p_out (p=10%)" value={exact.toExponential(3)} accent="#34d399" />
        <Stat label="MC ≈ exact?" value={Math.abs(mc.pOut - exact) < 3e-3 ? 'agree' : 'differ'} ok={Math.abs(mc.pOut - exact) < 3e-3} />
      </div>

      <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
        Hamming[15,11,3] weight enumerator (Z-error patterns the routine cannot detect)
      </div>
      <WeightBars A={A} />
      <p style={{ color: '#475569', fontSize: 10, margin: '8px 0 0', lineHeight: 1.5 }}>
        The <b style={{ color: '#34d399' }}>35 weight-3</b> codewords are the lowest-weight logical errors —
        the smallest way three input faults can conspire to survive post-selection — so they set the leading
        term p_out ≈ 35 p³. There is no weight-1 or weight-2 codeword (distance 3): a single bad T-state is
        always caught.
      </p>
    </Card>
  );
}

function SuppressionPlot({ thr }: { thr: number }) {
  const W = 720, H = 240, padL = 46, padR = 14, padT = 14, padB = 30;
  const cw = W - padL - padR, ch = H - padT - padB;
  // log-log axes from 1e-4 .. ~0.3
  const lpMin = -4, lpMax = Math.log10(0.3);
  const xOf = (p: number) => padL + ((Math.log10(p) - lpMin) / (lpMax - lpMin)) * cw;
  const yOf = (p: number) => padT + ((lpMax - Math.log10(Math.max(p, 1e-12))) / (lpMax - lpMin)) * ch;

  const pts: number[] = [];
  for (let i = 0; i <= 120; i++) pts.push(Math.pow(10, lpMin + (i / 120) * (lpMax - lpMin)));
  const curve = pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(p).toFixed(1)},${yOf(distill(p).pOut).toFixed(1)}`).join(' ');
  const diag = `M${xOf(Math.pow(10, lpMin))},${yOf(Math.pow(10, lpMin))} L${xOf(0.3)},${yOf(0.3)}`;
  const lead = pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(p).toFixed(1)},${yOf(35 * p * p * p).toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      {[-4, -3, -2, -1].map((e) => (
        <g key={`y${e}`}>
          <line x1={padL} y1={yOf(Math.pow(10, e))} x2={W - padR} y2={yOf(Math.pow(10, e))} stroke="#1e293b" strokeWidth={0.5} />
          <text x={padL - 6} y={yOf(Math.pow(10, e)) + 3} textAnchor="end" fill="#475569" fontSize={9} fontFamily="monospace">1e{e}</text>
        </g>
      ))}
      {[-4, -3, -2, -1].map((e) => (
        <text key={`x${e}`} x={xOf(Math.pow(10, e))} y={H - 10} textAnchor="middle" fill="#475569" fontSize={9} fontFamily="monospace">1e{e}</text>
      ))}
      {/* distillable region shading (p < p*) */}
      <rect x={padL} y={padT} width={xOf(thr) - padL} height={ch} fill="rgba(52,211,153,0.05)" />
      <line x1={xOf(thr)} y1={padT} x2={xOf(thr)} y2={padT + ch} stroke="#a78bfa" strokeWidth={1} strokeDasharray="3 3" />
      <text x={xOf(thr) + 4} y={padT + 12} fill="#a78bfa" fontSize={9} fontFamily="monospace">p* = {(thr * 100).toFixed(1)}%</text>
      {/* break-even diagonal p_out = p */}
      <path d={diag} fill="none" stroke="#475569" strokeWidth={1} strokeDasharray="4 3" />
      {/* leading 35p^3 */}
      <path d={lead} fill="none" stroke="#67e8f9" strokeWidth={1} strokeDasharray="2 3" opacity={0.7} />
      {/* exact suppression curve */}
      <path d={curve} fill="none" stroke="#34d399" strokeWidth={2} />
      {/* axis labels */}
      <text x={padL + cw / 2} y={H - 1} textAnchor="middle" fill="#475569" fontSize={9}>input error p →</text>
      <g transform={`translate(${padL + 10}, ${padT + 6})`}>
        <rect x={0} y={-7} width={10} height={3} fill="#34d399" /><text x={14} y={-3} fill="#34d399" fontSize={9} fontFamily="monospace">exact p_out</text>
        <rect x={92} y={-7} width={10} height={3} fill="#67e8f9" /><text x={106} y={-3} fill="#67e8f9" fontSize={9} fontFamily="monospace">35 p³</text>
        <rect x={150} y={-7} width={10} height={3} fill="#475569" /><text x={164} y={-3} fill="#64748b" fontSize={9} fontFamily="monospace">break-even p_out = p</text>
      </g>
    </svg>
  );
}

function WeightBars({ A }: { A: number[] }) {
  const maxA = Math.max(...A);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 80, background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8, padding: '8px 10px' }}>
      {A.map((a, w) => (
        <div key={w} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
          <span style={{ fontSize: 8, color: a ? '#94a3b8' : '#334155', fontFamily: 'monospace' }}>{a || ''}</span>
          <div style={{
            width: '100%', height: `${(a / maxA) * 100}%`, minHeight: a ? 2 : 0,
            background: w === 3 ? 'linear-gradient(180deg,#34d399,#0891b2)' : 'rgba(124,58,237,0.5)', borderRadius: 2,
          }} />
          <span style={{ fontSize: 8, color: '#475569', fontFamily: 'monospace', marginTop: 2 }}>{w}</span>
        </div>
      ))}
    </div>
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
const th: React.CSSProperties = { padding: '3px 10px', fontWeight: 600, borderBottom: '1px solid #1e293b' };
const td: React.CSSProperties = { padding: '3px 10px' };
