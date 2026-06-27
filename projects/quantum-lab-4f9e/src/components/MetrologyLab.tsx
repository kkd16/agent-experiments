import { useMemo, useState } from 'react';
import {
  scalingCurve, noiseCrossover, noiseCrossoverN, cfiSweep,
  heisenbergQFI, sqlQFI, crbUncertainty, noisyGhzQFI, noisyProductQFI,
} from '../quantum/metrology';
import {
  coherentSpinState, oneAxisTwist, squeezingParameter, squeezingSweep, squeezingScaling, husimi,
} from '../quantum/squeezing';

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
      <SqueezingCard />
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

// ─────────────────────────── 4 · spin squeezing (the robust route) ───────────────────────────

function SqueezingCard() {
  const [n, setN] = useState(6);
  const [mu, setMu] = useState(0.3);
  const css = useMemo(() => coherentSpinState(n), [n]);
  const state = useMemo(() => oneAxisTwist(css, n, mu), [css, n, mu]);
  const sq = useMemo(() => squeezingParameter(state, n), [state, n]);
  const sweep = useMemo(() => squeezingSweep(n, 1.6, 161), [n]);
  const scaling = useMemo(() => squeezingScaling(10), []);
  const map = useMemo(() => husimi(state, n, 28, 56), [state, n]);
  return (
    <Card title="The robust alternative — spin squeezing (one-axis twisting & the Wineland parameter)" accent="#fbbf24">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.6 }}>
        If the GHZ cat is too fragile, what do real atomic clocks use? <b style={{ color: '#fbbf24' }}>Spin
        squeezing</b>. Start from the coherent spin state (all spins aligned — the best classical probe, ξ²=1)
        and apply <b style={{ color: '#67e8f9' }}>Kitagawa–Ueda one-axis twisting</b>{' '}
        <code>H = χ·J_z²</code>: a shear that <i>redistributes</i> the quantum noise, narrowing the spin
        fluctuation in the direction that carries phase information at the expense of an irrelevant one — never
        leaving the symmetric Dicke manifold. The <b style={{ color: '#34d399' }}>Wineland parameter</b>{' '}
        <code style={{ color: '#67e8f9' }}>ξ²_R = N·(ΔJ⊥min)²/|⟨J⟩|²</code> drops below 1: a metrological gain
        of 1/ξ², robust to a lost atom in a way the cat never is. Watch the noise blob shear on the sphere.
      </p>

      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ minWidth: 210, flex: 1 }}>
          <Slider label={`number of spins N = ${n}`} value={n} min={2} max={8} step={1} onChange={(v) => setN(Math.round(v))} color="#fbbf24" />
        </div>
        <div style={{ minWidth: 210, flex: 1 }}>
          <Slider label={`twisting strength μ = ${mu.toFixed(3)}`} value={mu} min={0} max={1.6} step={0.005} onChange={setMu} color="#67e8f9" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <HusimiMap grid={map} />
        <div style={{ flex: 1, minWidth: 280 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <Stat label="Wineland ξ²_R" value={sq.xi2.toFixed(3)} ok={sq.xi2 < 1} />
            <Stat label="metrological gain" value={`${sq.gainDb.toFixed(1)} dB`} accent="#34d399" />
            <Stat label="contrast |⟨J⟩|/(N/2)" value={(sq.meanLength / (n / 2)).toFixed(3)} accent="#67e8f9" />
          </div>
          <p style={{ color: '#475569', fontSize: 10, margin: 0, lineHeight: 1.5 }}>
            ξ² &lt; 1 (green) means the probe beats the standard quantum limit. Twist too hard and the mean
            spin shrinks (contrast → 0) and the state over-wraps the sphere — ξ² shoots back up. The optimum
            is a balance, scaling as <b style={{ color: '#fbbf24' }}>ξ² ∝ N^−2/3</b>.
          </p>
          <MuSweepPlot sweep={sweep} mu={mu} />
        </div>
      </div>

      <h4 style={{ margin: '16px 0 6px', fontSize: 12, fontWeight: 700, color: '#cbd5e1' }}>
        optimal squeezing vs N — between the two limits
      </h4>
      <SqueezeScalingPlot scaling={scaling} />
    </Card>
  );
}

function HusimiMap({ grid }: { grid: number[][] }) {
  const rows = grid.length;
  const cols = grid[0].length;
  const max = Math.max(1e-12, ...grid.flat());
  const cell = 3;
  const W = cols * cell, H = rows * cell;
  return (
    <div style={{ flexShrink: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: 224, height: 224 * (rows / cols), background: '#020617', border: '1px solid #1e293b', borderRadius: 8 }}>
        {grid.map((row, ti) => row.map((v, pi) => {
          const t = Math.pow(v / max, 0.6);
          if (t < 0.02) return null;
          const r = Math.round(40 + 215 * t);
          const g = Math.round(40 + 100 * t);
          const b = Math.round(120 + 80 * t);
          return <rect key={`${ti}-${pi}`} x={pi * cell} y={ti * cell} width={cell} height={cell} fill={`rgb(${r},${g},${b})`} />;
        }))}
      </svg>
      <div style={{ fontSize: 8, color: '#475569', textAlign: 'center', marginTop: 2 }}>Husimi Q on the spin sphere (θ↓, φ→)</div>
    </div>
  );
}

function MuSweepPlot({ sweep, mu }: { sweep: { mu: number; xi2: number }[]; mu: number }) {
  const W = 480, H = 120, padL = 30, padR = 8, padT = 10, padB = 20;
  const muMax = sweep[sweep.length - 1].mu;
  const yMax = 1.6;
  const xPix = (m: number) => padL + (m / muMax) * (W - padL - padR);
  const yPix = (v: number) => padT + ((yMax - Math.min(yMax, v)) / yMax) * (H - padT - padB);
  const path = sweep.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.mu).toFixed(1)},${yPix(p.xi2).toFixed(1)}`).join(' ');
  const cur = sweep.reduce((a, b) => (Math.abs(b.mu - mu) < Math.abs(a.mu - mu) ? b : a), sweep[0]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', marginTop: 8, background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      <line x1={padL} y1={yPix(1)} x2={W - padR} y2={yPix(1)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 3" />
      <text x={padL + 2} y={yPix(1) - 3} fontSize={8} fill="#f59e0b">SQL ξ²=1</text>
      <path d={path} fill="none" stroke="#fbbf24" strokeWidth={2} />
      <line x1={xPix(cur.mu)} y1={padT} x2={xPix(cur.mu)} y2={H - padB} stroke="#67e8f9" strokeWidth={1} strokeDasharray="2 2" />
      <circle cx={xPix(cur.mu)} cy={yPix(cur.xi2)} r={3} fill="#67e8f9" />
      <text x={W / 2} y={H - 4} fontSize={8} fill="#64748b" textAnchor="middle">twisting strength μ — ξ²_R</text>
    </svg>
  );
}

function SqueezeScalingPlot({ scaling }: { scaling: { n: number; xi2: number; heisenberg: number }[] }) {
  const W = 820, H = 180, padL = 50, padR = 14, padT = 14, padB = 28;
  const nMax = scaling[scaling.length - 1].n;
  const xLog = (v: number) => Math.log10(v);
  const yMin = xLog(1 / nMax) - 0.1, yMax = 0.1;
  const xMin = xLog(2), xMax = xLog(nMax);
  const xPix = (v: number) => padL + ((xLog(v) - xMin) / (xMax - xMin)) * (W - padL - padR);
  const yPix = (v: number) => padT + ((yMax - xLog(v)) / (yMax - yMin)) * (H - padT - padB);
  const pXi = scaling.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.n).toFixed(1)},${yPix(p.xi2).toFixed(1)}`).join(' ');
  const pHL = scaling.map((p, i) => `${i === 0 ? 'M' : 'L'}${xPix(p.n).toFixed(1)},${yPix(p.heisenberg).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8 }}>
      <line x1={padL} y1={yPix(1)} x2={W - padR} y2={yPix(1)} stroke="#f59e0b" strokeWidth={1.2} strokeDasharray="4 3" />
      <text x={padL + 4} y={yPix(1) - 4} fontSize={10} fill="#f59e0b">SQL ξ² = 1</text>
      <path d={pHL} fill="none" stroke="#34d399" strokeWidth={1.6} strokeDasharray="5 3" />
      <path d={pXi} fill="none" stroke="#fbbf24" strokeWidth={2.4} />
      {[2, 4, 6, 8, 10].filter((v) => v <= nMax).map((v) => (
        <text key={v} x={xPix(v)} y={H - 14} fontSize={9} fill="#475569" textAnchor="middle">{v}</text>
      ))}
      <text x={xPix(nMax) - 110} y={yPix(scaling[scaling.length - 1].xi2) - 6} fontSize={10} fill="#fbbf24">one-axis twisting (∝ N^−2/3)</text>
      <text x={xPix(nMax) - 110} y={yPix(scaling[scaling.length - 1].heisenberg) + 12} fontSize={10} fill="#34d399">Heisenberg 1/N</text>
      <text x={W / 2} y={H - 2} fontSize={9} fill="#64748b" textAnchor="middle">number of spins N (log–log: ξ²_R, lower = better)</text>
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
