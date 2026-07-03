import { useMemo, useState } from 'react';
import type { Matrix } from '../quantum/Matrix';
import {
  concurrence, entanglementOfFormation, pptAnalysis, chshMax,
  purity, vonNeumann, fidelityToPhiPlus, wernerState, RHO_PHI_PLUS, MAX_MIXED_2Q,
  CLASSICAL_CORRELATED, productState, rhoPsiMinus, randomMixed,
  wernerSweep, WERNER_THRESHOLDS,
  bbpsswCascade, bbpsswStep, bbpsswSimulate,
  monogamy, GHZ3, W3, ghzWInterpolate,
} from '../quantum/entanglement';

export default function EntanglementLab() {
  return (
    <div style={{ maxWidth: 820 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        The <b style={{ color: '#a78bfa' }}>Bell</b> and <b style={{ color: '#a78bfa' }}>Device-Indep</b> tabs
        ask what <i>correlations</i> entanglement can produce. This tab studies entanglement itself as a{' '}
        <b style={{ color: '#34d399' }}>resource</b>. For a general two-qubit <i>mixed</i> state, how much
        entanglement is there — the <b style={{ color: '#67e8f9' }}>Wootters concurrence</b>, the{' '}
        <b style={{ color: '#67e8f9' }}>entanglement of formation</b>, the{' '}
        <b style={{ color: '#67e8f9' }}>negativity</b> — and is there <i>any</i>? The{' '}
        <b style={{ color: '#f59e0b' }}>Peres–Horodecki PPT criterion</b> answers that exactly in 2×2. All of
        it is built from scratch on the lab's own complex eigensolver, and every headline number is checked
        against a closed form to machine precision in the Tests tab.
      </p>

      <InspectorCard />
      <HierarchyCard />
      <DistillationCard />
      <MonogamyCard />
    </div>
  );
}

// ─────────────────────────────── Card A — two-qubit inspector ───────────────────────────────

type StateId = 'phi+' | 'psi-' | 'werner' | 'product' | 'classical' | 'maxmixed' | 'random';
const STATE_LABELS: Record<StateId, string> = {
  'phi+': 'Bell |Φ⁺⟩', 'psi-': 'Singlet |Ψ⁻⟩', werner: 'Werner ρ(p)', product: 'Product |a⟩|b⟩',
  classical: 'Classical mix', maxmixed: 'Maximally mixed', random: 'Random mixed',
};

function InspectorCard() {
  const [id, setId] = useState<StateId>('werner');
  const [p, setP] = useState(0.6);
  const [seed, setSeed] = useState(7);

  const rho = useMemo<Matrix>(() => {
    switch (id) {
      case 'phi+': return RHO_PHI_PLUS;
      case 'psi-': return rhoPsiMinus;
      case 'werner': return wernerState(p);
      case 'product': return productState(0.9, 2.3);
      case 'classical': return CLASSICAL_CORRELATED;
      case 'maxmixed': return MAX_MIXED_2Q;
      case 'random': return randomMixed(seed);
    }
  }, [id, p, seed]);

  const m = useMemo(() => {
    const ppt = pptAnalysis(rho);
    const C = concurrence(rho);
    return {
      C, eof: entanglementOfFormation(rho), ppt, chsh: chshMax(rho),
      purity: purity(rho), S: vonNeumann(rho), fid: fidelityToPhiPlus(rho),
    };
  }, [rho]);

  const entangled = !m.ppt.separable;
  const agree = (m.C > 1e-7) === (m.ppt.negativity > 1e-7);

  return (
    <Card title="Two-qubit inspector — the measures on any state" accent="#a78bfa">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {(Object.keys(STATE_LABELS) as StateId[]).map((s) => (
          <button key={s} onClick={() => setId(s)} style={{
            ...pill, background: id === s ? 'rgba(124,58,237,0.3)' : 'rgba(2,6,23,0.5)',
            color: id === s ? '#a78bfa' : '#64748b', borderColor: id === s ? '#7c3aed' : '#1e293b',
          }}>{STATE_LABELS[s]}</button>
        ))}
      </div>

      {id === 'werner' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginBottom: 3 }}>
            <span>visibility p — depolarised Bell pair p|Φ⁺⟩⟨Φ⁺| + (1−p)I/4</span>
            <span style={{ fontFamily: 'monospace', color: '#a78bfa' }}>p = {p.toFixed(2)}</span>
          </div>
          <input type="range" min={0} max={1} step={0.01} value={p} onChange={(e) => setP(parseFloat(e.target.value))}
            style={{ width: '100%', accentColor: '#7c3aed' }} />
        </div>
      )}
      {id === 'random' && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ ...lab }}>seed
            <input type="range" min={1} max={40} step={1} value={seed} onChange={(e) => setSeed(parseInt(e.target.value))}
              style={{ flex: 1, accentColor: '#7c3aed' }} />
            <span style={{ fontFamily: 'monospace', color: '#a78bfa' }}>{seed}</span>
          </label>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <RhoHeatmap rho={rho} />
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <Stat label="concurrence C" value={m.C.toFixed(4)} accent="#67e8f9" />
            <Stat label="ent. of formation" value={m.eof.toFixed(4)} accent="#67e8f9" />
            <Stat label="negativity N" value={m.ppt.negativity.toFixed(4)} accent="#34d399" />
            <Stat label="log-negativity" value={m.ppt.logNegativity.toFixed(4)} accent="#34d399" />
            <Stat label="purity Tr ρ²" value={m.purity.toFixed(4)} />
            <Stat label="entropy S(ρ)" value={m.S.toFixed(4)} />
            <Stat label="PPT min eig" value={m.ppt.minEigenvalue.toFixed(4)} accent={m.ppt.minEigenvalue < -1e-7 ? '#f472b6' : '#94a3b8'} />
            <Stat label="fidelity ⟨Φ⁺|ρ|Φ⁺⟩" value={m.fid.toFixed(4)} />
            <Stat label="max CHSH" value={m.chsh.toFixed(4)} accent={m.chsh > 2 ? '#f472b6' : '#94a3b8'} />
          </div>
          <div style={{
            padding: '9px 12px', borderRadius: 8,
            background: entangled ? 'rgba(52,211,153,0.08)' : 'rgba(148,163,184,0.06)',
            border: `1px solid ${entangled ? 'rgba(52,211,153,0.3)' : 'rgba(148,163,184,0.2)'}`,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: entangled ? '#34d399' : '#94a3b8' }}>
              {entangled ? 'ENTANGLED' : 'SEPARABLE'} — the partial transpose {entangled ? 'has a negative eigenvalue' : 'stays positive'}
            </div>
            <div style={{ fontSize: 10.5, color: '#64748b', lineHeight: 1.5, marginTop: 3 }}>
              For two qubits, PPT (Peres–Horodecki) is <b>necessary and sufficient</b> for separability, so the
              three verdicts must agree: C&gt;0 ⇔ N&gt;0 ⇔ negative partial transpose.{' '}
              <b style={{ color: agree ? '#34d399' : '#f87171' }}>{agree ? 'They agree ✓' : 'MISMATCH'}</b>.
              {m.chsh > 2 && ' This state also violates the CHSH inequality (S > 2).'}
              {entangled && m.chsh <= 2 && ' Yet its max CHSH ≤ 2 — entangled but Bell-local.'}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function RhoHeatmap({ rho }: { rho: Matrix }) {
  const cells = 4;
  const size = 46;
  const label = ['00', '01', '10', '11'];
  let maxMag = 0;
  for (const row of rho) for (const z of row) maxMag = Math.max(maxMag, z.abs());
  return (
    <div>
      <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>density matrix ρ</div>
      <div style={{ display: 'grid', gridTemplateColumns: `18px repeat(${cells}, ${size}px)`, gap: 2 }}>
        <div />
        {label.map((l) => <div key={`h${l}`} style={{ textAlign: 'center', fontSize: 9, color: '#475569', fontFamily: 'monospace' }}>{l}</div>)}
        {rho.flatMap((row, i) => [
          <div key={`r${i}`} style={{ fontSize: 9, color: '#475569', fontFamily: 'monospace', display: 'flex', alignItems: 'center' }}>{label[i]}</div>,
          ...row.map((z, j) => {
            const mag = z.abs() / (maxMag || 1);
            const hue = z.im >= 0 ? 265 : 190; // phase sign → hue
            return (
              <div key={`${i}-${j}`} style={{
                width: size, height: size, borderRadius: 4, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace', fontSize: 8.5,
                color: mag > 0.5 ? '#e2e8f0' : '#64748b',
                background: `hsla(${hue}, 70%, 55%, ${0.12 + mag * 0.6})`,
                border: '1px solid rgba(30,41,59,0.6)',
              }}>
                <span>{z.re.toFixed(2)}</span>
                {Math.abs(z.im) > 5e-3 && <span style={{ color: '#a78bfa' }}>{z.im > 0 ? '+' : ''}{z.im.toFixed(2)}i</span>}
              </div>
            );
          }),
        ])}
      </div>
    </div>
  );
}

// ─────────────────────────────── Card B — the Werner hierarchy ───────────────────────────────

function HierarchyCard() {
  const sweep = useMemo(() => wernerSweep(161), []);
  const W = 760, H = 260, padL = 42, padR = 16, padT = 16, padB = 40;
  const cw = W - padL - padR, ch = H - padT - padB;
  const xOf = (p: number) => padL + p * cw;
  const yOf = (v: number) => padT + (1 - v) * ch; // v ∈ [0,1]
  const path = (sel: (pt: typeof sweep[number]) => number) =>
    sweep.map((pt, i) => `${i ? 'L' : 'M'}${xOf(pt.p).toFixed(1)},${yOf(sel(pt)).toFixed(1)}`).join(' ');

  const cCurve = path((pt) => pt.concurrence);
  const nCurve = path((pt) => pt.negativity / 0.5); // N ∈ [0,½] → [0,1]
  const sCurve = path((pt) => pt.chsh / (2 * Math.SQRT2)); // S ∈ [0,2√2] → [0,1]
  const regions: { from: number; to: number; color: string; name: string }[] = [
    { from: 0, to: WERNER_THRESHOLDS.separable, color: 'rgba(148,163,184,0.07)', name: 'separable' },
    { from: WERNER_THRESHOLDS.separable, to: WERNER_THRESHOLDS.steerable, color: 'rgba(52,211,153,0.06)', name: 'entangled' },
    { from: WERNER_THRESHOLDS.steerable, to: WERNER_THRESHOLDS.bell, color: 'rgba(103,232,249,0.07)', name: 'steerable' },
    { from: WERNER_THRESHOLDS.bell, to: 1, color: 'rgba(244,114,182,0.08)', name: 'Bell-nonlocal' },
  ];

  return (
    <Card title="The Werner hierarchy — separable ⊃ entangled ⊃ steerable ⊃ Bell-nonlocal" accent="#67e8f9">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 10px', lineHeight: 1.55 }}>
        Sweeping the visibility p of ρ(p) = p|Φ⁺⟩⟨Φ⁺| + (1−p)I/4 walks through the strict hierarchy of
        quantum correlations. Every threshold is an exact rational: entangled at{' '}
        <b style={{ color: '#34d399' }}>p &gt; ⅓</b> (Peres–Horodecki), steerable by projective measurements
        at <b style={{ color: '#67e8f9' }}>p &gt; ½</b> (Wiseman–Jones–Doherty), Bell-nonlocal at{' '}
        <b style={{ color: '#f472b6' }}>p &gt; 1/√2</b> (Horodecki CHSH). Being entangled is <i>not</i> enough
        to be nonlocal.
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
        {regions.map((r) => (
          <g key={r.name}>
            <rect x={xOf(r.from)} y={padT} width={xOf(r.to) - xOf(r.from)} height={ch} fill={r.color} />
            <text x={(xOf(r.from) + xOf(r.to)) / 2} y={padT + 12} textAnchor="middle" fontSize={8.5} fill="#64748b">{r.name}</text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={g}>
            <line x1={padL} y1={yOf(g)} x2={W - padR} y2={yOf(g)} stroke="#1e293b" strokeWidth={0.5} />
            <text x={padL - 5} y={yOf(g) + 3} textAnchor="end" fontSize={8} fill="#475569" fontFamily="monospace">{g}</text>
          </g>
        ))}
        {[WERNER_THRESHOLDS.separable, WERNER_THRESHOLDS.steerable, WERNER_THRESHOLDS.bell].map((t, i) => (
          <g key={t}>
            <line x1={xOf(t)} y1={padT} x2={xOf(t)} y2={padT + ch} stroke={['#34d399', '#67e8f9', '#f472b6'][i]} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
            <text x={xOf(t)} y={H - 22} textAnchor="middle" fontSize={8.5} fill={['#34d399', '#67e8f9', '#f472b6'][i]} fontFamily="monospace">
              {['⅓', '½', '1/√2'][i]}
            </text>
          </g>
        ))}
        {/* the CHSH classical bound line S = 2 → S/(2√2) = 1/√2 */}
        <line x1={padL} y1={yOf(1 / Math.SQRT2)} x2={W - padR} y2={yOf(1 / Math.SQRT2)} stroke="#f472b6" strokeWidth={0.6} strokeDasharray="2 4" opacity={0.5} />
        <path d={sCurve} fill="none" stroke="#f472b6" strokeWidth={2} />
        <path d={nCurve} fill="none" stroke="#34d399" strokeWidth={2} />
        <path d={cCurve} fill="none" stroke="#67e8f9" strokeWidth={2} />
        <text x={padL + cw / 2} y={H - 4} textAnchor="middle" fontSize={9} fill="#475569">visibility p →</text>
        <g transform={`translate(${padL + 8}, ${padT + 4})`}>
          <rect x={0} y={0} width={10} height={3} fill="#67e8f9" /><text x={14} y={4} fontSize={8.5} fill="#67e8f9" fontFamily="monospace">concurrence</text>
          <rect x={90} y={0} width={10} height={3} fill="#34d399" /><text x={104} y={4} fontSize={8.5} fill="#34d399" fontFamily="monospace">negativity ×2</text>
          <rect x={190} y={0} width={10} height={3} fill="#f472b6" /><text x={204} y={4} fontSize={8.5} fill="#f472b6" fontFamily="monospace">CHSH / 2√2</text>
        </g>
      </svg>
    </Card>
  );
}

// ─────────────────────────────── Card C — distillation (BBPSSW) ───────────────────────────────

function DistillationCard() {
  const [F0, setF0] = useState(0.7);
  const [rounds, setRounds] = useState(6);
  const casc = useMemo(() => bbpsswCascade(F0, rounds), [F0, rounds]);
  const p0 = (4 * F0 - 1) / 3;
  const check = useMemo(() => {
    if (p0 < 0 || p0 > 1) return null;
    const sim = bbpsswSimulate(wernerState(p0));
    return { sim: sim.Fout, cf: bbpsswStep(F0), diff: Math.abs(sim.Fout - bbpsswStep(F0)) };
  }, [F0, p0]);
  const above = F0 > 0.5;

  return (
    <Card title="Entanglement distillation — the BBPSSW recurrence" accent="#f59e0b">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.55 }}>
        Noisy channels degrade a Bell pair to a Werner state of fidelity F. Distillation trades <i>many</i> weak
        pairs for <i>fewer</i> stronger ones using only local operations + classical communication: apply a
        bilateral CNOT to two pairs, measure one and keep the other only when the outcomes agree. F = ½ is the
        unstable fixed point — <b style={{ color: '#34d399' }}>above it the map climbs to a pure Bell pair</b>,
        below it collapses to the maximally mixed ¼. F &gt; ½ ⇔ the pair is entangled ⇔ it is distillable
        (true for every two-qubit NPT state).
      </p>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <label style={{ ...lab, flex: 1, minWidth: 220 }}>
          <span style={{ whiteSpace: 'nowrap' }}>input fidelity F {F0.toFixed(3)}</span>
          <input type="range" min={0.3} max={0.99} step={0.005} value={F0} onChange={(e) => setF0(parseFloat(e.target.value))} style={{ flex: 1, accentColor: '#f59e0b' }} />
        </label>
        <label style={lab}>rounds
          <select value={rounds} onChange={(e) => setRounds(parseInt(e.target.value))} style={sel}>
            {[2, 4, 6, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <CobwebPlot F0={F0} rounds={rounds} />
        <div style={{ flex: 1, minWidth: 260, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: 10.5, width: '100%' }}>
            <thead>
              <tr style={{ color: '#475569', textAlign: 'right' }}>
                <th style={th}>round</th><th style={th}>fidelity F</th><th style={th}>concurrence</th><th style={th}>accept</th><th style={th}>pairs/out</th>
              </tr>
            </thead>
            <tbody>
              {casc.map((c, i) => (
                <tr key={c.round} style={{ color: '#cbd5e1', textAlign: 'right' }}>
                  <td style={td}>{c.round}</td>
                  <td style={{ ...td, color: c.F > 0.5 ? '#34d399' : '#f59e0b' }}>{c.F.toFixed(6)}</td>
                  <td style={td}>{c.concurrence.toFixed(4)}</td>
                  <td style={{ ...td, color: '#64748b' }}>{i === 0 ? '—' : `${(c.accept * 100).toFixed(0)}%`}</td>
                  <td style={{ ...td, color: '#64748b' }}>{c.pairsPerOutput < 1e6 ? c.pairsPerOutput.toFixed(1) : c.pairsPerOutput.toExponential(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '12px 0 0' }}>
        <Stat label="regime" value={above ? 'distillable' : 'below threshold'} ok={above} />
        {check && <Stat label="sim F′ (16-dim)" value={check.sim.toFixed(6)} accent="#a78bfa" />}
        {check && <Stat label="closed-form F′" value={check.cf.toFixed(6)} accent="#34d399" />}
        {check && <Stat label="sim ≈ formula?" value={check.diff < 1e-9 ? 'exact' : check.diff.toExponential(1)} ok={check.diff < 1e-9} />}
      </div>
      <p style={{ color: '#475569', fontSize: 10, margin: '8px 0 0', lineHeight: 1.5 }}>
        The single-step map F′ is derived in closed form <i>and</i> reproduced by an exact 16-dimensional
        simulation of the bilateral-CNOT protocol on ρ⊗ρ (post-selecting on agreeing target measurements) —
        they agree to machine precision. The cobweb shows F zig-zagging up to the F = 1 attractor.
      </p>
    </Card>
  );
}

function CobwebPlot({ F0, rounds }: { F0: number; rounds: number }) {
  const W = 300, H = 260, pad = 34;
  const cw = W - pad - 12, ch = H - pad - 12;
  const xOf = (f: number) => pad + f * cw;
  const yOf = (f: number) => (H - pad) - f * ch;
  const curve: string[] = [];
  for (let i = 0; i <= 100; i++) { const f = i / 100; curve.push(`${i ? 'L' : 'M'}${xOf(f).toFixed(1)},${yOf(bbpsswStep(f)).toFixed(1)}`); }
  // cobweb path
  const cob: string[] = [`M${xOf(F0).toFixed(1)},${yOf(0).toFixed(1)}`];
  let f = F0;
  for (let r = 0; r < rounds; r++) {
    const fn = bbpsswStep(f);
    cob.push(`L${xOf(f).toFixed(1)},${yOf(fn).toFixed(1)}`); // up to the map
    cob.push(`L${xOf(fn).toFixed(1)},${yOf(fn).toFixed(1)}`); // across to the diagonal
    f = fn;
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: 300, maxWidth: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      {/* diagonal F′ = F */}
      <line x1={xOf(0)} y1={yOf(0)} x2={xOf(1)} y2={yOf(1)} stroke="#475569" strokeWidth={1} strokeDasharray="4 3" />
      {/* unstable fixed point at ½ */}
      <line x1={xOf(0.5)} y1={pad} x2={xOf(0.5)} y2={H - pad} stroke="#f59e0b" strokeWidth={0.6} strokeDasharray="2 3" opacity={0.6} />
      <path d={curve.join(' ')} fill="none" stroke="#67e8f9" strokeWidth={1.8} />
      <path d={cob.join(' ')} fill="none" stroke="#34d399" strokeWidth={1} opacity={0.9} />
      <circle cx={xOf(F0)} cy={yOf(0)} r={2.5} fill="#f59e0b" />
      <text x={xOf(0.5)} y={H - pad + 12} textAnchor="middle" fontSize={8} fill="#f59e0b" fontFamily="monospace">½</text>
      <text x={W / 2} y={H - 6} textAnchor="middle" fontSize={8.5} fill="#475569">F (input) →</text>
      <text x={10} y={pad - 6} fontSize={8.5} fill="#67e8f9" fontFamily="monospace">F′ = map(F)</text>
    </svg>
  );
}

// ─────────────────────────────── Card D — monogamy (CKW) ───────────────────────────────

function MonogamyCard() {
  const [s, setS] = useState(0);
  const [preset, setPreset] = useState<'ghz' | 'w' | 'mix'>('ghz');
  const psi = useMemo(() => (preset === 'ghz' ? GHZ3 : preset === 'w' ? W3 : ghzWInterpolate(s)), [preset, s]);
  const m = useMemo(() => monogamy(psi), [psi]);
  const shareSum = m.cAB * m.cAB + m.cAC * m.cAC;

  const barW = 320, barH = 26;
  const total = Math.max(m.cSq_Abc, shareSum, 1e-6);
  const wAB = (m.cAB * m.cAB / total) * barW;
  const wAC = (m.cAC * m.cAC / total) * barW;
  const wTau = (m.tangle / total) * barW;

  return (
    <Card title="Monogamy of entanglement & the 3-tangle (Coffman–Kundu–Wootters)" accent="#34d399">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.55 }}>
        Entanglement cannot be freely shared. For any three-qubit pure state, the entanglement of qubit A with
        the <i>rest</i> bounds what it can hold pairwise: <b style={{ color: '#67e8f9' }}>C²(A|BC) ≥ C²<sub>AB</sub> + C²<sub>AC</sub></b>.
        The slack is the permutation-invariant <b style={{ color: '#34d399' }}>3-tangle τ</b> — genuine tripartite
        entanglement. |GHZ⟩ is all τ (τ = 1, no pairwise entanglement); |W⟩ is all pairwise (τ = 0, C<sub>AB</sub> = C<sub>AC</sub> = ⅔) — the two inequivalent classes of tripartite entanglement.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {(['ghz', 'w', 'mix'] as const).map((pr) => (
          <button key={pr} onClick={() => setPreset(pr)} style={{
            ...pill, background: preset === pr ? 'rgba(52,211,153,0.2)' : 'rgba(2,6,23,0.5)',
            color: preset === pr ? '#34d399' : '#64748b', borderColor: preset === pr ? '#34d399' : '#1e293b',
          }}>{pr === 'ghz' ? '|GHZ⟩' : pr === 'w' ? '|W⟩' : 'interpolate'}</button>
        ))}
      </div>
      {preset === 'mix' && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginBottom: 3 }}>
            <span>|ψ(s)⟩ ∝ √(1−s)|GHZ⟩ + √s|W⟩</span>
            <span style={{ fontFamily: 'monospace', color: '#34d399' }}>s = {s.toFixed(2)}</span>
          </div>
          <input type="range" min={0} max={1} step={0.01} value={s} onChange={(e) => setS(parseFloat(e.target.value))} style={{ width: '100%', accentColor: '#34d399' }} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Stat label="C²(A|BC)" value={m.cSq_Abc.toFixed(4)} accent="#67e8f9" />
        <Stat label="C_AB" value={m.cAB.toFixed(4)} />
        <Stat label="C_AC" value={m.cAC.toFixed(4)} />
        <Stat label="C²_AB + C²_AC" value={shareSum.toFixed(4)} />
        <Stat label="3-tangle τ" value={m.tangle.toFixed(4)} accent="#34d399" />
        <Stat label="CKW holds?" value={m.satisfied ? 'yes' : 'no'} ok={m.satisfied} />
      </div>

      <div style={{ fontSize: 10, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>
        C²(A|BC) = C²_AB (pairwise) + C²_AC (pairwise) + τ (tripartite)
      </div>
      <svg viewBox={`0 0 ${barW} ${barH}`} style={{ width: '100%', maxWidth: barW, height: 'auto' }}>
        <rect x={0} y={0} width={barW} height={barH} fill="rgba(2,6,23,0.6)" stroke="#1e293b" rx={4} />
        <rect x={0} y={0} width={wAB} height={barH} fill="rgba(103,232,249,0.55)" />
        <rect x={wAB} y={0} width={wAC} height={barH} fill="rgba(96,165,250,0.55)" />
        <rect x={wAB + wAC} y={0} width={wTau} height={barH} fill="rgba(52,211,153,0.65)" />
        <line x1={(m.cSq_Abc / total) * barW} y1={-2} x2={(m.cSq_Abc / total) * barW} y2={barH + 2} stroke="#e2e8f0" strokeWidth={1.2} />
      </svg>
      <p style={{ color: '#475569', fontSize: 10, margin: '6px 0 0', lineHeight: 1.5 }}>
        The white line marks C²(A|BC); the filled segments are the pairwise shares plus the residual tangle,
        which sum to exactly it — the CKW identity is saturated for pure states. Slide from |GHZ⟩ to |W⟩ to watch
        entanglement migrate from the tripartite τ into the pairwise bonds.
      </p>
    </Card>
  );
}

// ─────────────────────────────── shared bits ───────────────────────────────

function Stat({ label, value, ok, accent }: { label: string; value: string; ok?: boolean; accent?: string }) {
  const color = ok === undefined ? (accent ?? '#cbd5e1') : ok ? '#34d399' : '#f59e0b';
  return (
    <div style={{ padding: '6px 10px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 7, minWidth: 64 }}>
      <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color }}>{value}{ok !== undefined && (ok ? ' ✓' : '')}</div>
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
const th: React.CSSProperties = { padding: '3px 8px', fontWeight: 600, borderBottom: '1px solid #1e293b' };
const td: React.CSSProperties = { padding: '3px 8px' };
const pill: React.CSSProperties = { padding: '4px 10px', borderRadius: 6, border: '1px solid', fontSize: 11, cursor: 'pointer', fontWeight: 600 };
