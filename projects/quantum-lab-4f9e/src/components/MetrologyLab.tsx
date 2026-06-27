import { useMemo, useState } from 'react';
import {
  scalingCurve, noiseCrossover, noiseCrossoverN, cfiSweep,
  heisenbergQFI, sqlQFI, crbUncertainty, noisyGhzQFI, noisyProductQFI,
} from '../quantum/metrology';

export default function MetrologyLab() {
  return (
    <div style={{ maxWidth: 880 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        Entanglement powers three great applications — <b style={{ color: '#a78bfa' }}>computing</b>,{' '}
        <b style={{ color: '#34d399' }}>cryptography</b>, and <b style={{ color: '#67e8f9' }}>sensing</b>.
        This is the sensing pillar. A phase θ imprinted by <code style={{ color: '#67e8f9' }}>U(θ) = e^{'{'}−iθG{'}'}</code>{' '}
        can be estimated with an uncertainty bounded below by the{' '}
        <b style={{ color: '#a78bfa' }}>quantum Cramér–Rao bound</b>{' '}
        <code style={{ color: '#67e8f9' }}>Δθ ≥ 1/√(ν·F_Q)</code>, where the{' '}
        <b style={{ color: '#34d399' }}>quantum Fisher information</b> F_Q is the most information <i>any</i>{' '}
        measurement could extract. N independent probes give F_Q = N (the <b>standard quantum limit</b>,
        Δθ ∝ 1/√N); an N-qubit GHZ "cat" gives F_Q = N² (the <b>Heisenberg limit</b>, Δθ ∝ 1/N) — a genuine
        √N quantum advantage, the principle behind squeezed-light interferometers and optical atomic clocks.
        Every headline number is proven to machine precision in the Tests tab.
      </p>

      <ScalingCard />
      <SaturationCard />
      <NoiseCard />
    </div>
  );
}

// ─────────────────────────── 1 · the two scaling laws ───────────────────────────

function ScalingCard() {
  const [n, setN] = useState(6);
  const nMax = 16;
  const curve = useMemo(() => scalingCurve(nMax), []);
  const fqG = heisenbergQFI(n);
  const fqP = sqlQFI(n);
  return (
    <Card title="The two scaling laws — standard quantum limit vs the Heisenberg limit" accent="#a78bfa">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        Spend a fixed number of qubits N on estimating a phase. Used <b style={{ color: '#67e8f9' }}>separately</b>{' '}
        (each in <code>|+⟩</code>, the best classical strategy) the Fisher information adds: F_Q = N, so the
        precision improves only as <b>1/√N</b>. Braided into one <b style={{ color: '#34d399' }}>GHZ cat</b>{' '}
        <code>(|0…0⟩ + |1…1⟩)/√2</code>, the state picks up phase N times faster, F_Q = N², and the precision
        improves as <b>1/N</b> — the Heisenberg limit. The gap is a factor of <b style={{ color: '#a78bfa' }}>√N</b>{' '}
        in achievable Δθ, and it widens without bound.
      </p>

      <div style={{ marginBottom: 10 }}>
        <Slider label={`number of qubits N = ${n}`} value={n} min={1} max={nMax} step={1} onChange={(v) => setN(Math.round(v))} color="#a78bfa" />
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Stat label="F_Q product (SQL)" value={fqP.toString()} accent="#67e8f9" />
        <Stat label="F_Q GHZ (Heisenberg)" value={fqG.toString()} accent="#34d399" />
        <Stat label="Δθ product = 1/√N" value={crbUncertainty(fqP).toFixed(4)} accent="#67e8f9" />
        <Stat label="Δθ GHZ = 1/N" value={crbUncertainty(fqG).toFixed(4)} accent="#34d399" />
        <Stat label="advantage (√N)" value={`${Math.sqrt(n).toFixed(3)}×`} accent="#a78bfa" />
      </div>

      <ScalingPlot curve={curve} n={n} />
    </Card>
  );
}

function ScalingPlot({ curve, n }: { curve: { n: number; dThetaSQL: number; dThetaHeis: number }[]; n: number }) {
  const W = 820, H = 220, padL = 46, padR = 14, padT = 14, padB = 30;
  const nMax = curve.length;
  // log–log axes: x = log10(N), y = log10(Δθ)
  const xLog = (v: number) => Math.log10(v);
  const yMin = xLog(curve[nMax - 1].dThetaHeis); // smallest Δθ
  const yMax = xLog(curve[0].dThetaSQL); // largest Δθ (=0 at N=1)
  const xMin = 0, xMax = xLog(nMax);
  const xPix = (v: number) => padL + ((xLog(v) - xMin) / (xMax - xMin)) * (W - padL - padR);
  const yPix = (v: number) => padT + ((yMax - xLog(v)) / (yMax - yMin)) * (H - padT - padB);
  const pSQL = curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.n).toFixed(1)},${yPix(p.dThetaSQL).toFixed(1)}`).join(' ');
  const pHL = curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.n).toFixed(1)},${yPix(p.dThetaHeis).toFixed(1)}`).join(' ');
  const cur = curve[n - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      {[1, 2, 4, 8, 16].filter((v) => v <= nMax).map((v) => (
        <g key={v}>
          <line x1={xPix(v)} y1={padT} x2={xPix(v)} y2={H - padB} stroke="#1e293b" strokeWidth={0.5} />
          <text x={xPix(v)} y={H - 16} fontSize={9} fill="#475569" textAnchor="middle">{v}</text>
        </g>
      ))}
      <path d={pSQL} fill="none" stroke="#67e8f9" strokeWidth={2} />
      <path d={pHL} fill="none" stroke="#34d399" strokeWidth={2} />
      <line x1={xPix(cur.n)} y1={padT} x2={xPix(cur.n)} y2={H - padB} stroke="#a78bfa" strokeWidth={1} strokeDasharray="3 2" />
      <circle cx={xPix(cur.n)} cy={yPix(cur.dThetaSQL)} r={4} fill="#67e8f9" />
      <circle cx={xPix(cur.n)} cy={yPix(cur.dThetaHeis)} r={4} fill="#34d399" />
      <text x={padL + 4} y={padT + 12} fontSize={10} fill="#cbd5e1">estimation uncertainty Δθ (log scale, lower = better)</text>
      <text x={xPix(nMax) - 92} y={yPix(curve[nMax - 1].dThetaSQL) - 6} fontSize={10} fill="#67e8f9">SQL  Δθ ∝ 1/√N</text>
      <text x={xPix(nMax) - 92} y={yPix(curve[nMax - 1].dThetaHeis) + 14} fontSize={10} fill="#34d399">Heisenberg  Δθ ∝ 1/N</text>
      <text x={W / 2} y={H - 2} fontSize={9} fill="#64748b" textAnchor="middle">number of qubits N (log scale)</text>
    </svg>
  );
}

// ─────────────────────────── 2 · CRB & measurement saturation ───────────────────────────

function SaturationCard() {
  const [n, setN] = useState(3);
  const sweep = useMemo(() => cfiSweep(n, 121), [n]);
  const qfi = heisenbergQFI(n);
  // representative point (middle of the sweep)
  const mid = sweep[Math.floor(sweep.length / 2)];
  return (
    <Card title="The quantum Cramér–Rao bound & saturating it with the right measurement" accent="#34d399">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        F_Q is the <i>best any measurement could do</i>; a real readout achieves its own{' '}
        <b style={{ color: '#67e8f9' }}>classical Fisher information</b> F_C ≤ F_Q. The bound is{' '}
        <b style={{ color: '#34d399' }}>attainable</b>: measuring the GHZ probe in the{' '}
        <b style={{ color: '#34d399' }}>parity</b> basis <code>X^⊗N</code> gives ⟨X^⊗N⟩ = cos(Nθ), whose
        slope packs F_C = N² — exactly the quantum bound, at every phase. But measure <code>Z^⊗N</code>,
        the <i>eigenbasis of the generator J_z you are trying to estimate</i>, and the phase is invisible:
        F_C = 0. The choice of measurement is everything.
      </p>

      <div style={{ marginBottom: 10 }}>
        <Slider label={`GHZ probe size N = ${n}`} value={n} min={2} max={6} step={1} onChange={(v) => setN(Math.round(v))} color="#34d399" />
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Stat label="quantum bound F_Q" value={qfi.toString()} accent="#a78bfa" />
        <Stat label="parity F_C (saturates)" value={mid.fcParity.toFixed(2)} ok={Math.abs(mid.fcParity - qfi) < 1e-6} />
        <Stat label="generator-basis F_C" value={mid.fcZ.toFixed(2)} ok={Math.abs(mid.fcZ) < 1e-6} />
      </div>

      <SaturationPlot sweep={sweep} qfi={qfi} n={n} />
    </Card>
  );
}

function SaturationPlot({ sweep, qfi, n }: { sweep: { theta: number; fcParity: number; fcZ: number }[]; qfi: number; n: number }) {
  const W = 820, H = 200, padL = 46, padR = 14, padT = 14, padB = 30;
  const tMax = Math.PI / n;
  const yMax = qfi * 1.15;
  const xPix = (t: number) => padL + (t / tMax) * (W - padL - padR);
  const yPix = (v: number) => padT + ((yMax - v) / yMax) * (H - padT - padB);
  const pPar = sweep.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.theta).toFixed(1)},${yPix(p.fcParity).toFixed(1)}`).join(' ');
  const pZ = sweep.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.theta).toFixed(1)},${yPix(p.fcZ).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      <line x1={padL} y1={yPix(qfi)} x2={W - padR} y2={yPix(qfi)} stroke="#a78bfa" strokeWidth={1.4} strokeDasharray="5 3" />
      <text x={padL + 4} y={yPix(qfi) - 5} fontSize={10} fill="#a78bfa">quantum bound F_Q = N² = {qfi}</text>
      <path d={pPar} fill="none" stroke="#34d399" strokeWidth={2.4} />
      <path d={pZ} fill="none" stroke="#f59e0b" strokeWidth={2} />
      <text x={W - 150} y={yPix(qfi) + 16} fontSize={10} fill="#34d399">parity X^⊗N (saturates)</text>
      <text x={padL + 6} y={yPix(0) - 6} fontSize={10} fill="#f59e0b">generator basis Z^⊗N → F_C = 0</text>
      {[0, 0.5, 1].map((f) => (
        <text key={f} x={6} y={yPix(qfi * f) + 3} fontSize={9} fill="#475569">{(qfi * f).toFixed(0)}</text>
      ))}
      <text x={W / 2} y={H - 2} fontSize={9} fill="#64748b" textAnchor="middle">phase θ ∈ (0, π/N) — classical Fisher information of each readout</text>
    </svg>
  );
}

// ─────────────────────────── 3 · noise & the fragility of the advantage ───────────────────────────

function NoiseCard() {
  const [lambda, setLambda] = useState(0.1);
  const nMax = 24;
  const curve = useMemo(() => noiseCrossover(nMax, lambda), [lambda]);
  const nStar = noiseCrossoverN(nMax, lambda);
  return (
    <Card title="Why the cat is fragile — dephasing erases the Heisenberg advantage (Huelga)" accent="#f472b6">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        The same delocalised coherence that makes a GHZ cat so phase-sensitive makes it{' '}
        <b style={{ color: '#f472b6' }}>maximally sensitive to dephasing</b>. Under independent phase noise of
        strength λ per qubit the cat's single global coherence decays as (1−λ)^N, so{' '}
        <code style={{ color: '#34d399' }}>F_Q(GHZ) = N²(1−λ)^N</code> — the N² rises, then the exponential
        wins. A product probe only loses a constant factor: <code style={{ color: '#67e8f9' }}>F_Q(product) = N(1−λ)</code>.
        Past a critical size the cat is <b>worse</b> than doing nothing clever — the{' '}
        <b style={{ color: '#f472b6' }}>Huelga et al. (1997)</b> result that turned practical metrology toward
        robust spin-<i>squeezing</i> rather than fragile cat states.
      </p>

      <div style={{ marginBottom: 10 }}>
        <Slider label={`dephasing per qubit λ = ${lambda.toFixed(3)}`} value={lambda} min={0.005} max={0.4} step={0.005} onChange={setLambda} color="#f472b6" />
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <Stat label="GHZ peak at" value={Number.isFinite(nStar) ? `N=${Math.max(1, nStar - 1)}` : '—'} accent="#34d399" />
        <Stat label="product overtakes GHZ at" value={Number.isFinite(nStar) ? `N=${nStar}` : 'never'} accent="#f472b6" ok={Number.isFinite(nStar)} />
        <Stat label="F_Q(GHZ) @ N=20" value={noisyGhzQFI(20, lambda).toFixed(1)} accent="#34d399" />
        <Stat label="F_Q(product) @ N=20" value={noisyProductQFI(20, lambda).toFixed(1)} accent="#67e8f9" />
      </div>

      <NoisePlot curve={curve} nStar={nStar} />
    </Card>
  );
}

function NoisePlot({ curve, nStar }: { curve: { n: number; ghz: number; product: number }[]; nStar: number }) {
  const W = 820, H = 220, padL = 46, padR = 14, padT = 14, padB = 30;
  const nMax = curve.length;
  const yMax = Math.max(...curve.map((p) => Math.max(p.ghz, p.product))) * 1.1 || 1;
  const xPix = (v: number) => padL + ((v - 1) / (nMax - 1)) * (W - padL - padR);
  const yPix = (v: number) => padT + ((yMax - v) / yMax) * (H - padT - padB);
  const pG = curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.n).toFixed(1)},${yPix(p.ghz).toFixed(1)}`).join(' ');
  const pP = curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.n).toFixed(1)},${yPix(p.product).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      {[5, 10, 15, 20].filter((v) => v <= nMax).map((v) => (
        <g key={v}>
          <line x1={xPix(v)} y1={padT} x2={xPix(v)} y2={H - padB} stroke="#1e293b" strokeWidth={0.5} />
          <text x={xPix(v)} y={H - 16} fontSize={9} fill="#475569" textAnchor="middle">{v}</text>
        </g>
      ))}
      {Number.isFinite(nStar) && (
        <g>
          <line x1={xPix(nStar)} y1={padT} x2={xPix(nStar)} y2={H - padB} stroke="#f472b6" strokeWidth={1} strokeDasharray="3 2" />
          <text x={xPix(nStar)} y={padT + 10} fontSize={9} fill="#f472b6" textAnchor="middle">crossover N={nStar}</text>
        </g>
      )}
      <path d={pG} fill="none" stroke="#34d399" strokeWidth={2.2} />
      <path d={pP} fill="none" stroke="#67e8f9" strokeWidth={2.2} />
      <text x={padL + 4} y={padT + 12} fontSize={10} fill="#cbd5e1">quantum Fisher information F_Q</text>
      <text x={xPix(nMax) - 150} y={yPix(curve[nMax - 1].ghz) + 4} fontSize={10} fill="#34d399">GHZ: N²(1−λ)^N</text>
      <text x={xPix(nMax) - 150} y={yPix(curve[nMax - 1].product) - 6} fontSize={10} fill="#67e8f9">product: N(1−λ)</text>
      <text x={W / 2} y={H - 2} fontSize={9} fill="#64748b" textAnchor="middle">number of qubits N — the GHZ advantage rises then collapses</text>
    </svg>
  );
}

// ─────────────────────────── shared bits ───────────────────────────

function Slider({ label, value, min, max, step, onChange, color }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; color: string }) {
  return (
    <label style={{ fontSize: 11, color: '#94a3b8', display: 'block' }}>
      <span style={{ display: 'block', marginBottom: 2 }}><b style={{ color }}>{label}</b></span>
      <input type="range" min={min} max={max} step={step ?? (max - min) / 240} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))} style={{ width: '100%', accentColor: color }} />
    </label>
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
