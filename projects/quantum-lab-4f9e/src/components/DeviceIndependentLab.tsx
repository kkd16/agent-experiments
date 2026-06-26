import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { npaLevel1, chshSOSCertificate, TSIRELSON } from '../quantum/npa';
import { randomnessCurve, guessingProbability, certifiedMinEntropy } from '../quantum/randomness';
import {
  wernerData, pureData, steeringEllipsoid, cjwrSteering, criticalVisibility, wernerSweep, type TwoQubitData,
} from '../quantum/steering';
import { detectionThreshold, thresholdCurve, CHSH_THRESHOLD, EBERHARD_LIMIT, type ThresholdPoint } from '../quantum/detection';
import { ceilings, LOCAL_BOUND, QUANTUM_BOUND, NO_SIGNALLING_BOUND } from '../quantum/nosignaling';

export default function DeviceIndependentLab() {
  return (
    <div style={{ maxWidth: 880 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        The <b style={{ color: '#a78bfa' }}>device-independent</b> programme turns nonlocality into a{' '}
        <b style={{ color: '#34d399' }}>resource and a security primitive</b>: trust <i>nothing</i> about
        the internal physics of the boxes — not the Hilbert-space dimension, not what the measurements
        really are — and still prove things from the observed statistics alone. This pillar adds the
        machinery that requires: a from-scratch <b style={{ color: '#67e8f9' }}>semidefinite-programming
        solver</b> that computes Tsirelson's bound as a <i>certified ceiling</i> (not a sampled maximum),
        an independent sum-of-squares proof, certified randomness, EPR steering, the detection loophole,
        and the no-signalling foil. Every headline number is proven to machine precision in the Tests tab.
      </p>

      <NPACard />
      <SOSCard />
      <RandomnessCard />
      <SteeringCard />
      <DetectionCard />
      <CeilingsCard />
    </div>
  );
}

// ─────────────────────────────── NPA / SDP ───────────────────────────────

function NPACard() {
  const [seedNonce, setSeedNonce] = useState(0);
  const npa = useMemo(() => npaLevel1(), [seedNonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const gapTiny = npa.gap < 1e-2;
  return (
    <Card title="NPA hierarchy — Tsirelson's bound as a CERTIFIED ceiling (an SDP, from scratch)" accent="#a78bfa">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        The deep question is not "can quantum <i>reach</i> S = 2√2?" but "can it <i>exceed</i> 2√2 — in{' '}
        <b>any</b> dimension, with <b>any</b> measurements?" That is a quantifier over all of Hilbert space.
        The <b style={{ color: '#a78bfa' }}>Navascués–Pironio–Acín</b> hierarchy makes it a{' '}
        <b style={{ color: '#67e8f9' }}>semidefinite program</b>: any quantum correlation has a moment
        matrix Γ of operator inner products that is necessarily positive-semidefinite, so maximising the
        Bell functional over <code style={{ color: '#67e8f9' }}>Γ ⪰ 0, diag = 1</code> is an upper bound on
        every quantum strategy. At level 1 the bound is tight for CHSH — and the from-scratch SDP solver
        (Burer–Monteiro primal + an eigenvalue-penalised dual, built on the lab's Jacobi eigensolver) lands
        exactly on <b style={{ color: '#34d399' }}>2√2</b>.
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '0 0 12px' }}>
        <Stat label="SDP primal (best Γ)" value={npa.primal.toFixed(5)} accent="#a78bfa" />
        <Stat label="SDP dual (certificate)" value={npa.upperBound.toFixed(5)} accent="#67e8f9" />
        <Stat label="Tsirelson 2√2" value={TSIRELSON.toFixed(5)} accent="#34d399" />
        <Stat label="duality gap" value={npa.gap.toExponential(1)} ok={gapTiny} />
        <button onClick={() => setSeedNonce((n) => n + 1)} style={btn}>↻ re-solve</button>
      </div>

      <ConvergenceBar primal={npa.primal} dual={npa.upperBound} />

      <h4 style={subhead}>the optimal moment matrix Γ (5×5)</h4>
      <MomentMatrix M={npa.moment} />

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: '#475569', marginBottom: 4 }}>realised correlators E_xy (= ±1/√2)</div>
          <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace' }}>
            <tbody>
              {[0, 1].map((x) => (
                <tr key={x}>
                  {[0, 1].map((y) => (
                    <td key={y} style={{ ...td, color: npa.correlators[x][y] >= 0 ? '#34d399' : '#f472b6', border: '1px solid #1e293b', textAlign: 'center', padding: '4px 10px' }}>
                      {npa.correlators[x][y] >= 0 ? '+' : ''}{npa.correlators[x][y].toFixed(3)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: '#64748b', lineHeight: 1.6, maxWidth: 420 }}>
          The dual variables <code style={{ color: '#67e8f9' }}>y = [{npa.dualY.map((v) => v.toFixed(2)).join(', ')}]</code> form
          the slack <code>Diag(y) − C ⪰ 0</code> (λ_min = {npa.slackMinEig.toExponential(1)}), so{' '}
          <code>⟨C, Γ⟩ ≤ Σyᵢ = {npa.upperBound.toFixed(4)}</code> for <b>every</b> feasible Γ — the rigorous
          proof that no quantum (or even no-signalling-but-PSD) strategy beats 2√2.
        </div>
      </div>
    </Card>
  );
}

function ConvergenceBar({ primal, dual }: { primal: number; dual: number }) {
  const lo = 2, hi = 4;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  return (
    <div style={{ position: 'relative', height: 40, background: 'rgba(2,6,23,0.6)', border: '1px solid #1e293b', borderRadius: 8, overflow: 'hidden', marginBottom: 12 }}>
      <div style={{ position: 'absolute', left: `${pct(2)}%`, top: 0, bottom: 0, width: 1, background: '#f59e0b' }} />
      <div style={{ position: 'absolute', left: `${pct(2)}%`, top: 2, fontSize: 9, color: '#f59e0b', paddingLeft: 3 }}>local 2</div>
      <div style={{ position: 'absolute', left: `${pct(NO_SIGNALLING_BOUND)}%`, top: 0, bottom: 0, width: 1, background: '#f472b6', transform: 'translateX(-1px)' }} />
      <div style={{ position: 'absolute', left: `${pct(NO_SIGNALLING_BOUND)}%`, top: 2, fontSize: 9, color: '#f472b6', transform: 'translateX(-46px)' }}>no-sig 4</div>
      <div style={{ position: 'absolute', left: `${pct(TSIRELSON)}%`, top: 0, bottom: 0, width: 2, background: '#34d399', boxShadow: '0 0 8px #34d399' }} />
      <div style={{ position: 'absolute', left: `${pct(TSIRELSON)}%`, bottom: 2, fontSize: 9, color: '#34d399', transform: 'translateX(-52px)' }}>2√2 ≈ 2.828</div>
      <motion.div animate={{ left: `${pct(primal)}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        style={{ position: 'absolute', left: `${pct(primal)}%`, top: 8, width: 9, height: 9, marginLeft: -4, borderRadius: '50%', background: '#a78bfa', border: '1px solid #fff' }} title={`primal ${primal.toFixed(4)}`} />
      <motion.div animate={{ left: `${pct(dual)}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }}
        style={{ position: 'absolute', left: `${pct(dual)}%`, bottom: 12, width: 9, height: 9, marginLeft: -4, borderRadius: '50%', background: '#67e8f9', border: '1px solid #fff' }} title={`dual ${dual.toFixed(4)}`} />
    </div>
  );
}

function MomentMatrix({ M }: { M: number[][] }) {
  const labels = ['1', 'A₀', 'A₁', 'B₀', 'B₁'];
  const color = (v: number) => {
    const t = Math.max(-1, Math.min(1, v));
    if (t >= 0) return `rgba(52,211,153,${0.12 + 0.5 * t})`;
    return `rgba(244,114,182,${0.12 + 0.5 * -t})`;
  };
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 10, fontFamily: 'monospace' }}>
      <thead>
        <tr><th style={{ ...td, color: '#475569' }}></th>{labels.map((l) => <th key={l} style={{ ...td, color: '#94a3b8', padding: '2px 8px' }}>{l}</th>)}</tr>
      </thead>
      <tbody>
        {M.map((row, i) => (
          <tr key={i}>
            <td style={{ ...td, color: '#94a3b8', padding: '2px 8px' }}>{labels[i]}</td>
            {row.map((v, j) => (
              <td key={j} style={{ ...td, textAlign: 'center', padding: '4px 8px', color: '#e2e8f0', background: color(v), border: '1px solid rgba(30,41,59,0.6)' }}>
                {v >= 0 ? '+' : ''}{v.toFixed(2)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─────────────────────────────── SOS certificate ───────────────────────────────

function SOSCard() {
  const sos = useMemo(() => chshSOSCertificate(), []);
  return (
    <Card title="An independent operator sum-of-squares proof of 2√2" accent="#67e8f9">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        The SDP is numerical; here is a <b style={{ color: '#34d399' }}>fully rigorous, basis-independent</b>{' '}
        proof. Using only <code style={{ color: '#67e8f9' }}>A² = B² = I</code> and{' '}
        <code style={{ color: '#67e8f9' }}>[Aₓ, Bᵧ] = 0</code>, the CHSH operator obeys the identity
      </p>
      <div style={{ textAlign: 'center', fontFamily: 'monospace', fontSize: 13, color: '#e2e8f0', margin: '0 0 12px', padding: '10px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
        2√2·I − S = (1/√2)( u² + v² ),
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>u = A₀ − (B₀+B₁)/√2,&nbsp;&nbsp;&nbsp;v = A₁ − (B₀−B₁)/√2</div>
      </div>
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        The right side is a sum of squares of Hermitian operators, hence <b>positive-semidefinite</b> — so{' '}
        <code>2√2·I − S ⪰ 0</code> for <i>every</i> state and representation. We verify it is the{' '}
        <b style={{ color: '#34d399' }}>exact zero matrix</b> on a concrete 4×4 representation.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="‖2√2·I − S − (1/√2)(u²+v²)‖" value={sos.residual.toExponential(1)} ok={sos.residual < 1e-12} />
        <Stat label="u², v² both PSD" value={sos.squaresPSD ? 'yes' : 'no'} ok={sos.squaresPSD} />
        <Stat label="⟨Φ⁺|S|Φ⁺⟩ (attains 2√2)" value={sos.expectation.toFixed(5)} ok={Math.abs(sos.expectation - TSIRELSON) < 1e-9} />
      </div>
    </Card>
  );
}

// ─────────────────────────────── DI randomness ───────────────────────────────

function RandomnessCard() {
  const [S, setS] = useState(2.6);
  const curve = useMemo(() => randomnessCurve(161), []);
  const pG = guessingProbability(S);
  const h = certifiedMinEntropy(S);
  return (
    <Card title="Device-independent randomness — bits certified by the violation" accent="#34d399">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        A CHSH value S &gt; 2 certifies that the outcomes are <b style={{ color: '#34d399' }}>genuinely
        unpredictable</b> — not merely to us, but to <i>any adversary</i>, even one who built the devices
        and holds a system entangled with them. The optimal guessing probability is{' '}
        <code style={{ color: '#67e8f9' }}>P_guess(S) = ½ + ½√(2 − S²/4)</code> (Pironio et al.), and the
        certified min-entropy <code>H_min = −log₂ P_guess</code> is the number of near-perfect private
        random bits an extractor can distil per use.
      </p>
      <div style={{ marginBottom: 10 }}>
        <Slider label={`observed CHSH S = ${S.toFixed(3)}`} value={S} min={2} max={TSIRELSON} onChange={setS} color="#34d399" />
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Stat label="P_guess (adversary)" value={pG.toFixed(4)} accent="#f59e0b" />
        <Stat label="certified H_min (bits)" value={h.toFixed(4)} ok={h > 0} />
        <Stat label="at S=2 (classical)" value="0 bits" accent="#f59e0b" />
        <Stat label="at S=2√2 (Tsirelson)" value="1 bit" accent="#34d399" />
      </div>
      <RandomnessPlot curve={curve} S={S} h={h} />
    </Card>
  );
}

function RandomnessPlot({ curve, S, h }: { curve: { S: number; hMin: number }[]; S: number; h: number }) {
  const W = 820, H = 200, padL = 40, padR = 12, padT = 12, padB = 28;
  const x0 = 2, x1 = TSIRELSON;
  const xPix = (s: number) => padL + ((s - x0) / (x1 - x0)) * (W - padL - padR);
  const yPix = (v: number) => padT + (1 - v) * (H - padT - padB);
  const path = curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.S).toFixed(1)},${yPix(p.hMin).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      {[0, 0.25, 0.5, 0.75, 1].map((y) => (
        <g key={y}>
          <line x1={padL} y1={yPix(y)} x2={W - padR} y2={yPix(y)} stroke="#1e293b" strokeWidth={0.5} />
          <text x={4} y={yPix(y) + 3} fontSize={9} fill="#475569">{y}</text>
        </g>
      ))}
      <path d={path} fill="none" stroke="#34d399" strokeWidth={2} />
      <line x1={xPix(S)} y1={padT} x2={xPix(S)} y2={H - padB} stroke="#a78bfa" strokeWidth={1} strokeDasharray="3 2" />
      <circle cx={xPix(S)} cy={yPix(h)} r={4} fill="#a78bfa" />
      <text x={padL + 2} y={padT + 10} fontSize={10} fill="#34d399">certified randomness H_min (bits)</text>
      <text x={xPix(2) + 2} y={H - 12} fontSize={9} fill="#f59e0b">S=2</text>
      <text x={xPix(TSIRELSON) - 30} y={H - 12} fontSize={9} fill="#34d399">2√2</text>
      <text x={W / 2} y={H - 1} fontSize={9} fill="#64748b" textAnchor="middle">observed CHSH value S</text>
    </svg>
  );
}

// ─────────────────────────────── EPR steering ───────────────────────────────

type StateKind = 'werner' | 'pure';

function SteeringCard() {
  const [kind, setKind] = useState<StateKind>('werner');
  const [w, setW] = useState(0.8);
  const [theta, setTheta] = useState(Math.PI / 4);
  const data: TwoQubitData = kind === 'werner' ? wernerData(w) : pureData(theta);
  const ell = useMemo(() => steeringEllipsoid(data), [data]);
  const s2 = cjwrSteering(data, 2);
  const s3 = cjwrSteering(data, 3);
  const sweep = useMemo(() => wernerSweep(101), []);
  return (
    <Card title="EPR steering — between entanglement and Bell-nonlocality" accent="#f472b6">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        <b style={{ color: '#f472b6' }}>Steering</b> (Schrödinger's word) is the asymmetric middle child of
        the hierarchy: Alice can collapse Bob's state into ensembles no local-hidden-<i>state</i> model can
        explain — strictly weaker than Bell-nonlocality, strictly stronger than entanglement. Its picture is
        the <b style={{ color: '#67e8f9' }}>steering ellipsoid</b>: the set of Bloch vectors Alice can steer
        Bob to. A maximally-entangled state fills the whole Bloch ball; the CJWR inequality{' '}
        <code style={{ color: '#67e8f9' }}>S_n = (1/√n)|Σ⟨AₖBₖ⟩| ≤ 1</code> detects when it is too big to fake.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <label style={lab}>state
          <select value={kind} onChange={(e) => setKind(e.target.value as StateKind)} style={sel}>
            <option value="werner">Werner: w|Ψ⁻⟩⟨Ψ⁻| + (1−w)I/4</option>
            <option value="pure">pure: cosθ|00⟩ + sinθ|11⟩</option>
          </select>
        </label>
        {kind === 'werner'
          ? <div style={{ minWidth: 220 }}><Slider label={`visibility w = ${w.toFixed(3)}`} value={w} min={0} max={1} onChange={setW} color="#f472b6" /></div>
          : <div style={{ minWidth: 220 }}><Slider label={`angle θ = ${(theta / Math.PI).toFixed(3)}π`} value={theta} min={0.02} max={Math.PI / 2 - 0.02} onChange={setTheta} color="#f472b6" /></div>}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <EllipsoidView ell={ell} />
        <div style={{ flex: 1, minWidth: 280 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <Stat label="semi-axes" value={ell.semiAxes.map((x) => x.toFixed(2)).join(', ')} accent="#67e8f9" />
            <Stat label="rel. volume" value={ell.relativeVolume.toFixed(3)} accent="#67e8f9" />
          </div>
          <WinBars rows={[
            { label: 'LHS bound', value: 1 / 2, color: '#f59e0b', raw: 1 },
            { label: 'S₂ (2 settings)', value: s2.value / 2, color: s2.steerable ? '#34d399' : '#64748b', raw: s2.value },
            { label: 'S₃ (3 settings)', value: s3.value / 2, color: s3.steerable ? '#34d399' : '#64748b', raw: s3.value },
          ]} />
          <p style={{ color: '#475569', fontSize: 10, margin: '10px 0 0', lineHeight: 1.5 }}>
            Steerable when S_n &gt; 1. The singlet gives S₂ = √2, S₃ = √3. For a Werner state S_n = w√n, so
            it is n-setting steerable exactly when <b style={{ color: '#f472b6' }}>w &gt; 1/√n</b> (≈
            {criticalVisibility(2).toFixed(3)} for n=2, {criticalVisibility(3).toFixed(3)} for n=3).
          </p>
        </div>
      </div>

      <h4 style={subhead}>Werner visibility sweep — the critical thresholds</h4>
      <SteeringSweepPlot sweep={sweep} />
    </Card>
  );
}

function EllipsoidView({ ell }: { ell: { center: number[]; semiAxes: number[] } }) {
  const R = 70, cx = 80, cy = 80;
  // Project onto the x–z plane (axis 0 = x semi-axis, axis 2 = z semi-axis for our diagonal states).
  const rx = Math.max(0.001, ell.semiAxes[0]) * R;
  const rz = Math.max(0.001, ell.semiAxes[2]) * R;
  const ecx = cx + (ell.center[0] || 0) * R;
  const ecy = cy - (ell.center[2] || 0) * R;
  return (
    <svg viewBox="0 0 160 160" style={{ width: 160, height: 160, background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8, flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#334155" strokeWidth={1} strokeDasharray="3 3" />
      <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} stroke="#1e293b" strokeWidth={0.5} />
      <line x1={cx} y1={cy - R} x2={cx} y2={cy + R} stroke="#1e293b" strokeWidth={0.5} />
      <ellipse cx={ecx} cy={ecy} rx={rx} ry={rz} fill="rgba(244,114,182,0.18)" stroke="#f472b6" strokeWidth={1.5} />
      <circle cx={ecx} cy={ecy} r={2} fill="#f472b6" />
      <text x={cx} y={14} fontSize={8} fill="#475569" textAnchor="middle">Bob's steering ellipsoid</text>
      <text x={cx + R - 6} y={cy - 4} fontSize={8} fill="#475569">x</text>
      <text x={cx + 3} y={cy - R + 10} fontSize={8} fill="#475569">z</text>
    </svg>
  );
}

function SteeringSweepPlot({ sweep }: { sweep: { w: number; S2: number; S3: number }[] }) {
  const W = 820, H = 180, padL = 36, padR = 12, padT = 12, padB = 26;
  const yMax = Math.sqrt(3) * 1.08;
  const xPix = (w: number) => padL + w * (W - padL - padR);
  const yPix = (v: number) => padT + ((yMax - v) / yMax) * (H - padT - padB);
  const p2 = sweep.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.w).toFixed(1)},${yPix(p.S2).toFixed(1)}`).join(' ');
  const p3 = sweep.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.w).toFixed(1)},${yPix(p.S3).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      <line x1={padL} y1={yPix(1)} x2={W - padR} y2={yPix(1)} stroke="#f59e0b" strokeWidth={1.2} strokeDasharray="4 3" />
      <text x={padL + 4} y={yPix(1) - 4} fontSize={10} fill="#f59e0b">LHS bound = 1 (unsteerable below)</text>
      {[criticalVisibility(2), criticalVisibility(3)].map((wc, i) => (
        <g key={i}>
          <line x1={xPix(wc)} y1={padT} x2={xPix(wc)} y2={H - padB} stroke={i ? '#67e8f9' : '#34d399'} strokeWidth={0.8} strokeDasharray="2 2" />
          <text x={xPix(wc)} y={H - 14} fontSize={8} fill={i ? '#67e8f9' : '#34d399'} textAnchor="middle">1/√{i ? 3 : 2}</text>
        </g>
      ))}
      <path d={p2} fill="none" stroke="#34d399" strokeWidth={1.8} />
      <path d={p3} fill="none" stroke="#67e8f9" strokeWidth={1.8} />
      <text x={W - 60} y={yPix(Math.SQRT2) - 4} fontSize={9} fill="#34d399">S₂</text>
      <text x={W - 60} y={yPix(Math.sqrt(3)) - 4} fontSize={9} fill="#67e8f9">S₃</text>
      <text x={W / 2} y={H - 2} fontSize={9} fill="#64748b" textAnchor="middle">Werner visibility w</text>
    </svg>
  );
}

// ─────────────────────────────── Detection loophole / Eberhard ───────────────────────────────

function DetectionCard() {
  const [curve, setCurve] = useState<ThresholdPoint[] | null>(null);
  const [busy, setBusy] = useState(false);
  const anchor = useMemo(() => detectionThreshold(Math.PI / 4), []);
  const trace = () => {
    setBusy(true);
    // Defer so the spinner paints before the heavy sweep blocks the thread.
    setTimeout(() => { setCurve(thresholdCurve(0.18, 20)); setBusy(false); }, 20);
  };
  return (
    <Card title="The detection loophole — and how Eberhard closed it" accent="#f59e0b">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        Every real Bell test misses particles. If detectors fire with probability η &lt; 1, a purely{' '}
        <b style={{ color: '#f59e0b' }}>local</b> model can fake the coincidence statistics — so a
        loophole-free violation needs η above a threshold. The famous facts: the{' '}
        <b style={{ color: '#a78bfa' }}>maximally-entangled</b> state needs a punishing{' '}
        <b>η &gt; 2(√2−1) ≈ 82.8%</b>, but <b style={{ color: '#34d399' }}>Eberhard</b> (1993) showed that
        dialling the entanglement <i>down</i> drops the threshold all the way to{' '}
        <b style={{ color: '#34d399' }}>η &gt; 2/3 ≈ 66.7%</b> — less entanglement, more robustness.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <Stat label="max-entangled η* = 2(√2−1)" value={(anchor?.eta ?? CHSH_THRESHOLD).toFixed(4)} accent="#a78bfa" />
        <Stat label="Eberhard limit 2/3" value={EBERHARD_LIMIT.toFixed(4)} accent="#34d399" />
        <button onClick={trace} disabled={busy} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'optimising…' : curve ? '↻ re-trace frontier' : '▶ trace the η frontier'}
        </button>
      </div>
      {curve && <EberhardPlot curve={curve} />}
      <p style={{ color: '#475569', fontSize: 10, margin: '10px 0 0', lineHeight: 1.5 }}>
        For each state |ψ(θ)⟩ = cosθ|00⟩ + sinθ|11⟩ we minimise the per-configuration threshold η* = M/Q of
        the Clauser–Horne inequality over the four measurement angles (multi-start Nelder–Mead). The frontier
        starts at 2(√2−1) for the maximally-entangled state (θ = π/4) and falls toward the analytic Eberhard
        limit 2/3 as the entanglement → 0 (the deep small-θ tail is numerically delicate, so the curve is
        traced over the robust range).
      </p>
    </Card>
  );
}

function EberhardPlot({ curve }: { curve: ThresholdPoint[] }) {
  const W = 820, H = 220, padL = 44, padR = 12, padT = 12, padB = 30;
  const xMin = 0, xMax = 1; // entanglement (concurrence) axis
  const yMin = 0.6, yMax = 0.86;
  const xPix = (c: number) => padL + ((c - xMin) / (xMax - xMin)) * (W - padL - padR);
  const yPix = (e: number) => padT + ((yMax - e) / (yMax - yMin)) * (H - padT - padB);
  const sorted = [...curve].sort((a, b) => a.entanglement - b.entanglement);
  const path = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.entanglement).toFixed(1)},${yPix(p.eta).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      <line x1={padL} y1={yPix(EBERHARD_LIMIT)} x2={W - padR} y2={yPix(EBERHARD_LIMIT)} stroke="#34d399" strokeWidth={1.2} strokeDasharray="4 3" />
      <text x={padL + 4} y={yPix(EBERHARD_LIMIT) + 12} fontSize={10} fill="#34d399">Eberhard limit 2/3 ≈ 0.667</text>
      <line x1={padL} y1={yPix(CHSH_THRESHOLD)} x2={W - padR} y2={yPix(CHSH_THRESHOLD)} stroke="#a78bfa" strokeWidth={1} strokeDasharray="2 3" />
      <text x={padL + 4} y={yPix(CHSH_THRESHOLD) - 4} fontSize={10} fill="#a78bfa">CHSH (max-entangled) 2(√2−1) ≈ 0.828</text>
      {[0.6, 0.65, 0.7, 0.75, 0.8, 0.85].map((y) => (
        <text key={y} x={6} y={yPix(y) + 3} fontSize={9} fill="#475569">{y.toFixed(2)}</text>
      ))}
      <path d={path} fill="none" stroke="#f59e0b" strokeWidth={2} />
      {sorted.map((p, i) => <circle key={i} cx={xPix(p.entanglement)} cy={yPix(p.eta)} r={2.5} fill="#f59e0b" />)}
      <text x={W / 2} y={H - 2} fontSize={9} fill="#64748b" textAnchor="middle">entanglement (concurrence) of |ψ(θ)⟩ — 1 = maximal, → 0 = product</text>
      <text x={padL + 2} y={padT + 10} fontSize={10} fill="#f59e0b">required detector efficiency η*</text>
    </svg>
  );
}

// ─────────────────────────────── Three ceilings / PR box ───────────────────────────────

function CeilingsCard() {
  const rows = useMemo(() => ceilings(), []);
  return (
    <Card title="The PR box & the three ceilings — where quantum theory sits" accent="#67e8f9">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        Is 2√2 forced by causality, or special to quantum mechanics? <b style={{ color: '#f472b6' }}>Popescu
        and Rohrlich</b> answered: the PR box <code style={{ color: '#67e8f9' }}>P(a,b|x,y) = ½·[a⊕b = x∧y]</code>{' '}
        reaches the <i>algebraic</i> maximum <b style={{ color: '#f472b6' }}>S = 4</b> while remaining{' '}
        <b>no-signalling</b>. So CHSH lives in a strict hierarchy — quantum theory is <i>more</i> nonlocal
        than any classical theory, yet <i>less</i> than causality alone allows. The NPA ceiling is a genuine,
        non-trivial fact about nature.
      </p>
      <NumberLine local={LOCAL_BOUND} quantum={QUANTUM_BOUND} nosig={NO_SIGNALLING_BOUND} />
      <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace', width: '100%', marginTop: 12 }}>
        <thead>
          <tr style={{ color: '#94a3b8' }}>
            <th style={th}>theory</th><th style={th}>max CHSH S</th><th style={th}>CHSH-game win</th><th style={th}>note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.name} style={{ color: '#cbd5e1', background: i % 2 ? 'rgba(2,6,23,0.4)' : 'transparent' }}>
              <td style={{ ...td, color: i === 1 ? '#34d399' : i === 2 ? '#f472b6' : '#f59e0b', fontWeight: 700 }}>{row.name}</td>
              <td style={td}>{row.chsh.toFixed(4)}</td>
              <td style={td}>{(row.gameWin * 100).toFixed(1)}%</td>
              <td style={{ ...td, color: '#475569' }}>{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function NumberLine({ local, quantum, nosig }: { local: number; quantum: number; nosig: number }) {
  const W = 820, H = 70, padL = 20, padR = 20;
  const lo = 1.7, hi = 4.2;
  const xPix = (v: number) => padL + ((v - lo) / (hi - lo)) * (W - padL - padR);
  const marks: { v: number; label: string; color: string }[] = [
    { v: local, label: 'local 2', color: '#f59e0b' },
    { v: quantum, label: 'quantum 2√2', color: '#34d399' },
    { v: nosig, label: 'no-signalling 4', color: '#f472b6' },
  ];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
      <line x1={padL} y1={38} x2={W - padR} y2={38} stroke="#334155" strokeWidth={2} />
      <rect x={xPix(local)} y={34} width={xPix(quantum) - xPix(local)} height={8} fill="rgba(52,211,153,0.25)" />
      <rect x={xPix(quantum)} y={34} width={xPix(nosig) - xPix(quantum)} height={8} fill="rgba(244,114,182,0.18)" />
      {marks.map((m) => (
        <g key={m.label}>
          <line x1={xPix(m.v)} y1={26} x2={xPix(m.v)} y2={50} stroke={m.color} strokeWidth={2} />
          <circle cx={xPix(m.v)} cy={38} r={4} fill={m.color} />
          <text x={xPix(m.v)} y={20} fontSize={10} fill={m.color} textAnchor="middle" fontWeight={700}>{m.label}</text>
          <text x={xPix(m.v)} y={64} fontSize={9} fill="#475569" textAnchor="middle">{m.v.toFixed(3)}</text>
        </g>
      ))}
    </svg>
  );
}

// ─────────────────────────────── shared bits ───────────────────────────────

function Slider({ label, value, min, max, onChange, color }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; color: string }) {
  return (
    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block' }}>
      <span style={{ display: 'block', marginBottom: 2 }}><b style={{ color }}>{label}</b></span>
      <input type="range" min={min} max={max} step={(max - min) / 240} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} style={{ width: '100%', accentColor: color }} />
    </label>
  );
}

function WinBars({ rows }: { rows: { label: string; value: number; color: string; raw?: number }[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {rows.map((row) => (
        <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 130, fontSize: 10, color: '#94a3b8', textAlign: 'right', flexShrink: 0 }}>{row.label}</span>
          <div style={{ flex: 1, height: 18, background: 'rgba(2,6,23,0.6)', border: '1px solid #1e293b', borderRadius: 5, overflow: 'hidden', position: 'relative' }}>
            <motion.div initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(1, row.value)) * 100}%` }} transition={{ duration: 0.5 }}
              style={{ height: '100%', background: row.color, opacity: 0.7 }} />
          </div>
          <span style={{ width: 52, fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: row.color }}>{(row.raw ?? row.value).toFixed(3)}</span>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, ok, accent }: { label: string; value: string; ok?: boolean; accent?: string }) {
  const color = ok === undefined ? (accent ?? '#cbd5e1') : ok ? '#34d399' : '#f59e0b';
  return (
    <div style={{ padding: '6px 10px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 7, minWidth: 70 }}>
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
const btn: React.CSSProperties = { padding: '6px 14px', borderRadius: 6, background: 'linear-gradient(135deg, #7c3aed, #0891b2)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const subhead: React.CSSProperties = { margin: '16px 0 6px', fontSize: 12, fontWeight: 700, color: '#cbd5e1' };
const th: React.CSSProperties = { padding: '3px 8px', fontWeight: 600, borderBottom: '1px solid #1e293b', textAlign: 'left' };
const td: React.CSSProperties = { padding: '3px 8px' };
