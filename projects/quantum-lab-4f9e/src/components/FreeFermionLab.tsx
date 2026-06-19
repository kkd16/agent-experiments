import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  solveTFIM, solveXY, blockEntropy, pfeutyEnergyDensity, centralCharge,
  mutualInfoVsSeparation,
} from '../quantum/FreeFermion';
import { ffQuench, exactQuenchDense } from '../quantum/ffQuench';
import { dispersion, groundEnergyDensity, transverseMagnetization } from '../quantum/xyChain';
import { tfimMPO, exactGroundEnergyMPO } from '../quantum/MPO';

/**
 * Free-Fermion lab: the TFIM is *secretly free*. Jordan–Wigner + Bogoliubov–de Gennes
 * solve it EXACTLY in O(n³) at chain lengths the 2ⁿ state vector cannot hold and DMRG
 * only approximates — so this engine is an exact oracle that recovers genuine universal
 * physics: the quantum critical point, the Ising-CFT central charge c = ½, the Pfeuty
 * thermodynamic energy, and the entanglement light-cone of a real-time quench.
 */
export default function FreeFermionLab() {
  return (
    <div style={{ maxWidth: 800 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        The transverse-field Ising chain is the one model in this lab that is{' '}
        <b style={{ color: '#5eead4' }}>secretly free</b>: the{' '}
        <b style={{ color: '#5eead4' }}>Jordan–Wigner</b> transform maps the spins onto
        non-interacting fermions, and a <b style={{ color: '#5eead4' }}>Bogoliubov–de Gennes</b>{' '}
        diagonalisation — which here is literally a singular-value decomposition of an n×n matrix,
        reusing the lab&apos;s from-scratch complex SVD — solves the 2ⁿ-dimensional problem{' '}
        <b>exactly in O(n³)</b>. That makes it an <i>exact oracle</i>: it agrees with the TFIM
        ground energy from exact diagonalisation and DMRG to machine precision, and then runs far
        past them — recovering the quantum critical point, the Ising-CFT central charge{' '}
        <code style={{ color: '#67e8f9' }}>c = ½</code>, the closed-form thermodynamic energy, and
        the entanglement light-cone of a quench, at hundreds of sites. (We solve
        <code style={{ color: '#67e8f9' }}> H = −J ΣXX − h ΣZ</code>; the lab&apos;s circuit
        convention is its on-site Hadamard image, with identical spectrum and entanglement.)
      </p>

      <SpectrumCard />
      <XyCard />
      <PhaseCard />
      <MutualInfoCard />
      <CentralChargeCard />
      <QuenchCard />
    </div>
  );
}

// --------------------------------------------------------------------------- XY anisotropy
function XyCard() {
  const [h, setH] = useState(1.0);
  const [g, setG] = useState(0.5);
  const data = useMemo(() => {
    const disp = Array.from({ length: 80 }, (_, i) => {
      const k = (i + 0.5) * Math.PI / 80;
      return { k, e: dispersion(k, 1, h, g) };
    });
    const e0 = groundEnergyDensity(1, h, g);
    const mz = transverseMagnetization(1, h, g);
    const gap = solveXY(96, 1, h, g).gap;
    return { disp, e0, mz, gap };
  }, [h, g]);
  return (
    <Card title="The anisotropic XY model — beyond the Ising point" accent="#818cf8">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        The transverse-field Ising chain is the <code style={{ color: '#67e8f9' }}>γ = 1</code> point of
        a one-parameter family, the <b style={{ color: '#818cf8' }}>anisotropic XY model</b>{' '}
        H = −Σ[(1+γ)/2 XX + (1−γ)/2 YY] − hΣZ. The Jordan–Wigner image is still quadratic — only the
        pairing term changes — so the same SVD solves it for any γ. Its phase diagram has TWO critical
        lines: the <b style={{ color: '#f472b6' }}>Ising transition h = 1</b> (any γ ≠ 0) and the{' '}
        <b style={{ color: '#22d3ee' }}>anisotropy line γ = 0</b> for h &lt; 1 (the isotropic XX model,
        a gapless critical phase).
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Slider label="field h" min={0.05} max={2.5} step={0.05} value={h} onChange={setH} color="#4f46e5" accent="#818cf8" fmt={(v) => v.toFixed(2)} />
        <Slider label="anisotropy γ" min={0} max={1} step={0.05} value={g} onChange={setG} color="#4f46e5" accent="#818cf8" fmt={(v) => v.toFixed(2)} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <Metric label="energy / site e₀" value={data.e0.toFixed(5)} color="#818cf8" />
        <Metric label="⟨Z⟩ magnetisation" value={data.mz.toFixed(4)} color="#67e8f9" />
        <Metric label="gap (n=96)" value={data.gap.toFixed(4)} color={data.gap < 0.05 ? '#f472b6' : '#94a3b8'} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <Label>Dispersion εₖ vs k</Label>
          <DispersionPlot disp={data.disp} />
        </div>
        <div>
          <Label>Phase diagram (h, γ) — you are here ●</Label>
          <PhaseDiagram h={h} g={g} />
        </div>
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------------- mutual information
function MutualInfoCard() {
  const [n, setN] = useState(48);
  const [h, setH] = useState(1.0);
  const [g, setG] = useState(1.0);
  const [w, setW] = useState(2);
  const pts = useMemo(() => {
    const sol = solveXY(n, 1, h, g);
    return mutualInfoVsSeparation(sol, w);
  }, [n, h, g, w]);
  const peak = pts.length ? Math.max(...pts.map((p) => p.I)) : 0;
  return (
    <Card title="Mutual information between disjoint blocks" accent="#34d399">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Two separated blocks A, B of width w. Their <b style={{ color: '#34d399' }}>mutual information</b>{' '}
        I(A:B) = S_A + S_B − S_{'{A∪B}'} bounds <i>all</i> correlations between the regions — computed
        exactly from the ground state&apos;s Majorana covariance matrix. Off criticality it{' '}
        <b style={{ color: '#34d399' }}>decays exponentially</b> with the gap-set correlation length; at
        the quantum critical point <b>h = 1</b> it decays only algebraically (a long-range echo of the
        underlying CFT).
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Slider label="sites n" min={16} max={96} value={n} onChange={setN} color="#059669" accent="#34d399" />
        <Slider label="field h" min={0.1} max={2.5} step={0.05} value={h} onChange={setH} color="#059669" accent="#34d399" fmt={(v) => v.toFixed(2)} />
        <Slider label="anisotropy γ" min={0.1} max={1} step={0.05} value={g} onChange={setG} color="#059669" accent="#34d399" fmt={(v) => v.toFixed(2)} />
        <Slider label="block width w" min={1} max={4} value={w} onChange={setW} color="#059669" accent="#34d399" />
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <Metric label="I(A:B) at d=1" value={pts.length ? pts[0].I.toFixed(4) : '—'} color="#34d399" />
        <Metric label="peak I" value={peak.toFixed(4)} color="#67e8f9" />
        <Metric label="regime" value={Math.abs(h - 1) < 0.06 ? 'critical' : h > 1 ? 'paramagnet' : 'ordered'} color="#a78bfa" />
      </div>
      <Label>I(A:B) vs block separation d (log axis) — straight line ⇒ exponential decay</Label>
      <DecayPlot pts={pts} />
    </Card>
  );
}

function DispersionPlot({ disp }: { disp: { k: number; e: number }[] }) {
  const wd = 270, ht = 120, pad = 30;
  const eMax = Math.max(...disp.map((d) => d.e), 0.1) * 1.08;
  const sx = (k: number) => pad + (k / Math.PI) * (wd - pad - 8);
  const sy = (v: number) => 10 + (1 - v / eMax) * (ht - 28);
  const path = disp.map((d, i) => `${i === 0 ? 'M' : 'L'}${sx(d.k).toFixed(1)},${sy(d.e).toFixed(1)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${wd} ${ht}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b' }}>
      {[eMax, eMax / 2, 0].map((v, i) => (
        <g key={i}><line x1={pad} y1={sy(v)} x2={wd - 8} y2={sy(v)} stroke="#1e293b" /><text x={pad - 3} y={sy(v) + 3} fontSize={7} fill="#475569" textAnchor="end">{v.toFixed(1)}</text></g>
      ))}
      <path d={path} fill="none" stroke="#818cf8" strokeWidth={1.8} />
      <text x={pad} y={ht - 3} fontSize={7} fill="#475569">0</text>
      <text x={wd - 8} y={ht - 3} fontSize={7} fill="#475569" textAnchor="end">π</text>
    </svg>
  );
}

function PhaseDiagram({ h, g }: { h: number; g: number }) {
  const wd = 270, ht = 120, pad = 26;
  const hMax = 2.5;
  const sx = (gg: number) => pad + gg * (wd - pad - 8);
  const sy = (hh: number) => ht - 22 - (hh / hMax) * (ht - 34);
  return (
    <svg width="100%" viewBox={`0 0 ${wd} ${ht}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b' }}>
      {/* paramagnet shading h>1 */}
      <rect x={sx(0)} y={sy(hMax)} width={wd - pad - 8} height={sy(1) - sy(hMax)} fill="rgba(244,114,182,0.06)" />
      {/* Ising critical line h=1 */}
      <line x1={sx(0)} y1={sy(1)} x2={sx(1)} y2={sy(1)} stroke="#f472b6" strokeWidth={1.6} />
      {/* gamma=0 critical line for h<1 */}
      <line x1={sx(0)} y1={sy(1)} x2={sx(0)} y2={sy(0)} stroke="#22d3ee" strokeWidth={1.6} />
      <circle cx={sx(g)} cy={sy(Math.min(h, hMax))} r={3.4} fill="#fde047" stroke="#000" strokeWidth={0.5} />
      <text x={sx(0.5)} y={sy(1.7)} fontSize={7} fill="#f472b6" textAnchor="middle">paramagnet</text>
      <text x={sx(0.55)} y={sy(0.4)} fontSize={7} fill="#94a3b8" textAnchor="middle">ordered</text>
      <text x={sx(1) - 2} y={ht - 3} fontSize={7} fill="#475569" textAnchor="end">γ=1</text>
      <text x={sx(0) + 2} y={ht - 3} fontSize={7} fill="#475569">γ=0</text>
      <text x={pad - 3} y={sy(1) + 2} fontSize={7} fill="#f472b6" textAnchor="end">h=1</text>
    </svg>
  );
}

function DecayPlot({ pts }: { pts: { d: number; I: number }[] }) {
  const w = 540, h = 130, pad = 46;
  if (pts.length === 0) return null;
  const floor = 1e-7;
  const ys = pts.map((p) => Math.log10(Math.max(p.I, floor)));
  const yMax = Math.max(...ys, -1), yMin = Math.min(...ys, yMax - 1);
  const xMax = Math.max(...pts.map((p) => p.d));
  const sx = (d: number) => pad + ((d - 1) / (xMax - 1 || 1)) * (w - pad - 12);
  const sy = (ly: number) => 12 + (1 - (ly - yMin) / (yMax - yMin || 1)) * (h - 34);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.d).toFixed(1)},${sy(ys[i]).toFixed(1)}`).join(' ');
  const yt = [yMax, (yMax + yMin) / 2, yMin];
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 6 }}>
      {yt.map((v, i) => (
        <g key={i}><line x1={pad} y1={sy(v)} x2={w - 12} y2={sy(v)} stroke="#1e293b" /><text x={pad - 4} y={sy(v) + 3} fontSize={8} fill="#475569" textAnchor="end">10{sup(v)}</text></g>
      ))}
      <path d={path} fill="none" stroke="#34d399" strokeWidth={1.8} />
      {pts.map((p, i) => <circle key={i} cx={sx(p.d)} cy={sy(ys[i])} r={2.1} fill="#34d399" />)}
      <text x={w - 12} y={h - 4} fontSize={9} fill="#64748b" textAnchor="end">separation d</text>
      <text x={pad - 4} y={9} fontSize={9} fill="#64748b" textAnchor="end">I(A:B)</text>
    </svg>
  );
}
function sup(v: number): string {
  const n = Math.round(v);
  const map: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  return String(n).split('').map((c) => map[c] || c).join('');
}

// --------------------------------------------------------------------------- Spectrum / energy
function SpectrumCard() {
  const [n, setN] = useState(64);
  const [h, setH] = useState(1.0);
  const data = useMemo(() => {
    const sol = solveTFIM(n, 1, h);
    const pf = pfeutyEnergyDensity(1, h);
    const exact = n <= 8 ? exactGroundEnergyMPO(tfimMPO(n, 1, h)) : null;
    return { sol, pf, exact };
  }, [n, h]);
  const { sol, pf, exact } = data;
  const dExact = exact !== null ? Math.abs(sol.groundEnergy - exact) : null;

  return (
    <Card title="Bogoliubov spectrum & exact ground energy" accent="#5eead4">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Diagonalise H on n sites and read off the single-particle <b>Bogoliubov energies</b> Λ_k
        (the cost to create one quasiparticle) and the many-body ground energy
        E₀ = −½ Σ Λ_k. The dispersion ε_k = 2√(J²+h²−2Jh cos k) has a gap{' '}
        <b style={{ color: '#5eead4' }}>2|J−h|</b> that closes at the critical field h = J. For
        n ≤ 8 the energy is checked against exact diagonalisation of the lab&apos;s own TFIM MPO;
        for any n it matches the closed-form Pfeuty thermodynamic value.
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Slider label="sites n" min={4} max={256} value={n} onChange={setN} color="#0d9488" accent="#5eead4" />
        <Slider label="field h" min={0.1} max={2.5} step={0.05} value={h} onChange={setH} color="#0d9488" accent="#5eead4" fmt={(v) => v.toFixed(2)} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <Metric label="ground energy E₀" value={sol.groundEnergy.toFixed(4)} color="#5eead4" />
        <Metric label="energy / site" value={sol.energyPerSite.toFixed(5)} color="#a78bfa" />
        <Metric label="Pfeuty e₀ (n→∞)" value={pf.toFixed(5)} color="#67e8f9" />
        <Metric label="quasiparticle gap" value={sol.gap.toFixed(4)} color={sol.gap < 0.05 ? '#f472b6' : '#94a3b8'} />
        {dExact !== null && <Metric label="vs exact diag" value={dExact < 1e-7 ? '✓ exact' : dExact.toExponential(1)} color={dExact < 1e-7 ? '#34d399' : '#fbbf24'} />}
      </div>
      <Label>Bogoliubov single-particle spectrum Λ_k (ascending) — the gap is the first bar</Label>
      <Bars values={sol.spectrum} color="#0d9488" cap={Math.max(...sol.spectrum, 1)} />
      <p style={{ fontSize: 10, color: '#475569', margin: '10px 0 0', lineHeight: 1.5 }}>
        At n = 256 this is a 256-dimensional SVD — instant — versus the 2²⁵⁶ amplitudes the state
        vector would need. The gap shrinks like 1/n at h = J (a finite-size remnant of the closing
        bulk gap); away from criticality it stays open at 2|J−h|.
      </p>
    </Card>
  );
}

// --------------------------------------------------------------------------- Phase transition
function PhaseCard() {
  const [n, setN] = useState(64);
  const pts = useMemo(() => {
    const STEPS = 41;
    return Array.from({ length: STEPS }, (_, i) => {
      const h = 0.05 + (i / (STEPS - 1)) * 2.4;
      const sol = solveTFIM(n, 1, h);
      return { h, gap: sol.gap, entropy: blockEntropy(sol, n >> 1) };
    });
  }, [n]);
  return (
    <Card title="Quantum phase transition — the exact gap & entanglement" accent="#f472b6">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Sweep the transverse field h. The <b style={{ color: '#f472b6' }}>quasiparticle gap</b>{' '}
        vanishes at the <b>quantum critical point h = J = 1</b> (and reopens on both sides), while
        the half-chain <b style={{ color: '#22d3ee' }}>entanglement entropy</b> peaks there — the
        ground-state fingerprint of a continuous quantum phase transition. The same physics the
        DMRG phase-scan card finds variationally, here computed exactly.
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Slider label="sites n" min={8} max={96} value={n} onChange={setN} color="#db2777" accent="#f472b6" />
      </div>
      <Label>Quasiparticle gap vs field h (closes at the critical point)</Label>
      <SweepPlot pts={pts} pick={(p) => p.gap} xs={(p) => p.h} color="#f472b6" yLabel="gap" marker={1} />
      <Label>Half-chain entanglement entropy vs field h (peaks at the critical point)</Label>
      <SweepPlot pts={pts} pick={(p) => p.entropy} xs={(p) => p.h} color="#22d3ee" yLabel="S (bits)" marker={1} />
    </Card>
  );
}

// --------------------------------------------------------------------------- Central charge
function CentralChargeCard() {
  const [n, setN] = useState(96);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ c: number; pts: { x: number; S: number }[]; ms: number } | null>(null);
  const doRun = () => {
    setBusy(true);
    setTimeout(() => {
      const t0 = performance.now();
      const fit = centralCharge(n, 1, 1, n > 64 ? 4 : 2);
      setRes({ c: fit.c, pts: fit.points.map((p) => ({ x: p.x, S: p.S * Math.LN2 })), ms: performance.now() - t0 });
      setBusy(false);
    }, 20);
  };
  return (
    <Card title="The Ising central charge c = ½ from entanglement scaling" accent="#a78bfa">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Exactly at criticality (h = J), the chain is described by a conformal field theory, and the
        block entanglement entropy obeys the <b style={{ color: '#a78bfa' }}>Calabrese–Cardy</b> law
        S(L) = (c/6) ln[(2n/π) sin(πL/n)] + const. A straight-line fit recovers the{' '}
        <b>central charge c</b> — the universal number that labels the universality class. For the
        transverse-field Ising chain it is exactly <code style={{ color: '#67e8f9' }}>½</code>. We
        read it straight off the entanglement of an exactly-solved critical chain.
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Slider label="sites n" min={32} max={160} value={n} onChange={setN} color="#7c3aed" accent="#a78bfa" />
        <button onClick={doRun} disabled={busy} style={btn('#7c3aed')}>{busy ? 'Fitting…' : '▶ Fit central charge'}</button>
      </div>
      {res && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <Metric label="fitted central charge c" value={res.c.toFixed(4)} color={Math.abs(res.c - 0.5) < 0.04 ? '#34d399' : '#fbbf24'} />
            <Metric label="expected (Ising CFT)" value="0.5000" color="#a78bfa" />
            <Metric label="fit time" value={`${res.ms.toFixed(0)} ms`} color="#94a3b8" />
          </div>
          <Label>Entanglement entropy S(L) [nats] vs the Calabrese–Cardy variable — slope = c</Label>
          <ScatterFit pts={res.pts} slope={res.c} color="#a78bfa" />
        </motion.div>
      )}
    </Card>
  );
}

// --------------------------------------------------------------------------- Quench
function QuenchCard() {
  const [n, setN] = useState(48);
  const [hi, setHi] = useState(0.2);
  const [hf, setHf] = useState(1.5);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ frames: { t: number; mZ: number; entropy: number }[]; exact: { mZ: number; entropy: number }[] | null; ms: number } | null>(null);
  const doRun = () => {
    setBusy(true);
    setTimeout(() => {
      const t0 = performance.now();
      const dt = 0.15, steps = 36;
      const q = ffQuench(n, 1, hi, hf, dt, steps);
      const exact = n <= 8 ? exactQuenchDense(n, 1, hi, hf, dt, steps) : null;
      setRes({ frames: q.frames, exact, ms: performance.now() - t0 });
      setBusy(false);
    }, 20);
  };
  const worstE = res?.exact ? Math.max(...res.frames.map((f, i) => Math.abs(f.entropy - res.exact![i].entropy))) : null;
  return (
    <Card title="Real-time quench — the entanglement light-cone" accent="#fb923c">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        Prepare the ground state at field h_i, then suddenly evolve under a different field h_f.
        Because the state stays Gaussian forever, we never touch a 2ⁿ vector — we evolve the
        fermionic two-point functions in O(n³) per step. The half-chain entanglement{' '}
        <b style={{ color: '#fb923c' }}>grows linearly then saturates</b> (a quasiparticle{' '}
        light-cone), reaching values whose Schmidt rank 2^S no MPS or exact simulator could store.
        For n ≤ 8 every step is checked against exact dense time evolution.
      </p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Slider label="sites n" min={4} max={72} value={n} onChange={setN} color="#ea580c" accent="#fb923c" />
        <Slider label="h init" min={0.1} max={3} step={0.1} value={hi} onChange={setHi} color="#ea580c" accent="#fb923c" fmt={(v) => v.toFixed(1)} />
        <Slider label="h quench" min={0.1} max={3} step={0.1} value={hf} onChange={setHf} color="#ea580c" accent="#fb923c" fmt={(v) => v.toFixed(1)} />
        <button onClick={doRun} disabled={busy} style={btn('#ea580c')}>{busy ? 'Evolving…' : '▶ Run quench'}</button>
      </div>
      {res && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <Metric label="final half-chain S" value={`${res.frames[res.frames.length - 1].entropy.toFixed(2)} bits`} color="#fb923c" />
            <Metric label="≈ Schmidt rank" value={`2^${res.frames[res.frames.length - 1].entropy.toFixed(1)}`} color="#67e8f9" />
            {worstE !== null && <Metric label="vs exact evolution" value={worstE < 1e-4 ? '✓ exact' : worstE.toExponential(1)} color={worstE < 1e-4 ? '#34d399' : '#fbbf24'} />}
            <Metric label="run time" value={`${res.ms.toFixed(0)} ms`} color="#94a3b8" />
          </div>
          <Label>Half-chain entanglement entropy vs time (the light-cone)</Label>
          <TimePlot frames={res.frames} pick={(f) => f.entropy} color="#fb923c" yLabel="S (bits)" />
          <Label>Mean field-direction magnetisation ⟨Z⟩ vs time</Label>
          <TimePlot frames={res.frames} pick={(f) => f.mZ} color="#22d3ee" yLabel="⟨Z⟩" symmetric />
        </motion.div>
      )}
    </Card>
  );
}

// --------------------------------------------------------------------------- plots
function Bars({ values, color, cap }: { values: number[]; color: string; cap: number }) {
  const max = Math.max(cap, 1e-9);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 70, background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 6, padding: '6px 8px', marginBottom: 12, overflowX: 'auto' }}>
      {values.map((v, i) => (
        <div key={i} title={`Λ${i} = ${v.toFixed(4)}`} style={{ flex: '1 0 2px', minWidth: 2, height: `${Math.max((v / max) * 100, 1)}%`, background: color, borderRadius: '2px 2px 0 0', opacity: 0.85 }} />
      ))}
    </div>
  );
}

function SweepPlot<T>({ pts, pick, xs, color, yLabel, marker }: { pts: T[]; pick: (p: T) => number; xs: (p: T) => number; color: string; yLabel: string; marker?: number }) {
  const w = 540, h = 130, pad = 42;
  const X = pts.map(xs), Y = pts.map(pick);
  const xMin = Math.min(...X), xMax = Math.max(...X);
  const yMin = Math.min(...Y, 0), yMax = Math.max(...Y, 1e-9);
  const sx = (v: number) => pad + ((v - xMin) / (xMax - xMin || 1)) * (w - pad - 10);
  const sy = (v: number) => 10 + (1 - (v - yMin) / (yMax - yMin || 1)) * (h - 30);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(xs(p)).toFixed(1)},${sy(pick(p)).toFixed(1)}`).join(' ');
  const yt = [yMax, (yMax + yMin) / 2, yMin], xt = [xMin, (xMin + xMax) / 2, xMax];
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 14 }}>
      {yt.map((v, i) => (
        <g key={i}>
          <line x1={pad} y1={sy(v)} x2={w - 10} y2={sy(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 4} y={sy(v) + 3} fontSize={8} fill="#475569" textAnchor="end">{v.toFixed(2)}</text>
        </g>
      ))}
      {marker !== undefined && marker >= xMin && marker <= xMax && (
        <g>
          <line x1={sx(marker)} y1={6} x2={sx(marker)} y2={h - 16} stroke="#f87171" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
          <text x={sx(marker)} y={h - 20} fontSize={8} fill="#f87171" textAnchor="middle">h = J</text>
        </g>
      )}
      {xt.map((v, i) => <text key={i} x={sx(v)} y={h - 4} fontSize={8} fill="#475569" textAnchor="middle">{v.toFixed(1)}</text>)}
      <path d={path} fill="none" stroke={color} strokeWidth={1.8} />
      <text x={pad - 4} y={8} fontSize={9} fill="#64748b" textAnchor="end">{yLabel}</text>
    </svg>
  );
}

function ScatterFit({ pts, slope, color }: { pts: { x: number; S: number }[]; slope: number; color: string }) {
  const w = 540, h = 150, pad = 44;
  const X = pts.map((p) => p.x), Y = pts.map((p) => p.S);
  const xMin = Math.min(...X), xMax = Math.max(...X), yMin = Math.min(...Y), yMax = Math.max(...Y);
  const sx = (v: number) => pad + ((v - xMin) / (xMax - xMin || 1)) * (w - pad - 10);
  const sy = (v: number) => 10 + (1 - (v - yMin) / (yMax - yMin || 1)) * (h - 30);
  // best-fit line through the data mean with the fitted slope
  const mx = X.reduce((a, b) => a + b, 0) / X.length, my = Y.reduce((a, b) => a + b, 0) / Y.length;
  const lineY = (x: number) => my + slope * (x - mx);
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 8 }}>
      <line x1={sx(xMin)} y1={sy(lineY(xMin))} x2={sx(xMax)} y2={sy(lineY(xMax))} stroke="#34d399" strokeWidth={1.5} strokeDasharray="5 3" opacity={0.85} />
      {pts.map((p, i) => <circle key={i} cx={sx(p.x)} cy={sy(p.S)} r={2.2} fill={color} />)}
      <text x={w - 12} y={18} fontSize={9} fill="#34d399" textAnchor="end">slope c = {slope.toFixed(3)}</text>
      <text x={w - 10} y={h - 4} fontSize={9} fill="#64748b" textAnchor="end">(1/6) ln[(2n/π) sin(πL/n)]</text>
      <text x={pad - 4} y={8} fontSize={9} fill="#64748b" textAnchor="end">S (nats)</text>
    </svg>
  );
}

function TimePlot<T extends { t: number }>({ frames, pick, color, yLabel, symmetric }: { frames: T[]; pick: (f: T) => number; color: string; yLabel: string; symmetric?: boolean }) {
  const w = 540, h = 130, pad = 36;
  const tMax = frames[frames.length - 1].t || 1;
  const vals = frames.map(pick);
  const vMax = symmetric ? 1 : Math.max(...vals, 1e-6) * 1.1;
  const vMin = symmetric ? -1 : 0;
  const sx = (t: number) => pad + (t / tMax) * (w - pad - 10);
  const sy = (v: number) => 10 + (1 - (v - vMin) / (vMax - vMin)) * (h - 28);
  const path = frames.map((f, i) => `${i === 0 ? 'M' : 'L'}${sx(f.t).toFixed(1)},${sy(pick(f)).toFixed(1)}`).join(' ');
  const ticks = symmetric ? [-1, 0, 1] : [vMax, vMax / 2, 0];
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 14 }}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad} y1={sy(v)} x2={w - 10} y2={sy(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 4} y={sy(v) + 3} fontSize={8} fill="#475569" textAnchor="end">{v.toFixed(1)}</text>
        </g>
      ))}
      <path d={path} fill="none" stroke={color} strokeWidth={1.8} />
      <text x={w - 10} y={h - 4} fontSize={9} fill="#64748b" textAnchor="end">time t</text>
      <text x={pad - 4} y={8} fontSize={9} fill="#64748b" textAnchor="end">{yLabel}</text>
    </svg>
  );
}

// --------------------------------------------------------------------------- shared UI atoms
function Slider({ label, min, max, value, onChange, color, accent, step = 1, fmt }:
  { label: string; min: number; max: number; value: number; onChange: (v: number) => void; color: string; accent: string; step?: number; fmt?: (v: number) => string }) {
  return (
    <label style={{ fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' }}>
      {label}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} style={{ accentColor: color }} />
      <span style={{ fontFamily: 'monospace', color: accent, width: 34 }}>{fmt ? fmt(value) : value}</span>
    </label>
  );
}
function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4, margin: '4px 0 6px' }}>{children}</div>;
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
