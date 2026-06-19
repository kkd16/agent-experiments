import { useMemo, useState } from 'react';
import {
  loschmidtRate, loschmidtFiniteN, loschmidtDense, criticalTimes, criticalModes,
  dtop, geometricPhaseProfile,
} from '../quantum/xyChain';

/**
 * Dynamics lab — the non-equilibrium counterpart of the Free-Fermion lab. A quantum quench of the
 * (periodic, anisotropic) XY chain that CROSSES the critical point exhibits a **dynamical quantum
 * phase transition**: the Loschmidt return-rate function develops non-analytic cusps in real time,
 * and an integer **dynamical topological order parameter** ν_D(t) jumps by +1 at each one. Both are
 * computed from the exact momentum-space free-fermion solution and cross-checked against an
 * independent dense 2ⁿ time evolution.
 */
export default function DynamicsLab() {
  return (
    <div style={{ maxWidth: 820 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 18px', lineHeight: 1.6 }}>
        Prepare the ground state of the periodic XY chain at field <code style={{ color: '#67e8f9' }}>h_i</code>,
        then quench to <code style={{ color: '#67e8f9' }}>h_f</code>. With periodic boundaries the chain
        factorises into independent momentum modes, so the <b style={{ color: '#c4b5fd' }}>Loschmidt
        amplitude</b> G(t) = ⟨ψ₀|e<sup>−iH_f t</sup>|ψ₀⟩ is an exact product over modes. When the quench{' '}
        <b style={{ color: '#f472b6' }}>crosses the critical point</b>, the return-rate function
        l(t) = −lim (1/N) ln|G(t)|² develops <b style={{ color: '#f472b6' }}>non-analytic cusps</b> — a{' '}
        <b style={{ color: '#c4b5fd' }}>dynamical quantum phase transition</b> (Heyl–Polkovnikov–Kehrein) —
        at the critical times tₙ* = (2n+1)π/εₖ*. The <b style={{ color: '#fbbf24' }}>dynamical topological
        order parameter</b> ν_D(t), the integer winding of the Pancharatnam geometric phase across the
        Brillouin zone, is 0 before the first cusp and jumps by exactly +1 at each one.
      </p>
      <DqptCard />
      <DtopCard />
    </div>
  );
}

// ------------------------------------------------------------------ DQPT rate function
function DqptCard() {
  const [hi, setHi] = useState(2.0);
  const [hf, setHf] = useState(0.5);
  const [g, setG] = useState(1.0);
  const TMAX = 8, NT = 240, NDENSE = 8;

  const data = useMemo(() => {
    const times = Array.from({ length: NT }, (_, i) => (i + 0.5) * TMAX / NT);
    const l = loschmidtRate(1, hi, hf, g, times, 1600);
    const denseT = Array.from({ length: 41 }, (_, i) => (i + 0.5) * TMAX / 41);
    const dense = loschmidtDense(NDENSE, 1, hi, hf, g, denseT);
    const ff = loschmidtFiniteN(NDENSE, 1, hi, hf, g, denseT);
    let worst = 0;
    for (let i = 0; i < dense.length; i++) worst = Math.max(worst, Math.abs(dense[i] - ff[i]));
    const cts = criticalTimes(1, hi, hf, g, TMAX);
    const modes = criticalModes(1, hi, hf, g);
    return { times, l, denseT, dense, cts, modes, worst };
  }, [hi, hf, g]);

  const crosses = data.modes.length > 0;
  return (
    <Card title="Dynamical quantum phase transition — the Loschmidt cusps" accent="#f472b6">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        The thermodynamic rate function l(t) (solid) is the per-site decay rate of the return
        probability. Dots are an independent exact dense {NDENSE}-site evolution. A quench that{' '}
        <b style={{ color: '#f472b6' }}>crosses h = 1</b> produces the cusps (dashed lines = critical
        times); a non-crossing quench stays smooth.
      </p>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Slider label="h init" min={0.1} max={3} step={0.05} value={hi} onChange={setHi} color="#db2777" accent="#f472b6" fmt={(v) => v.toFixed(2)} />
        <Slider label="h quench" min={0.1} max={3} step={0.05} value={hf} onChange={setHf} color="#db2777" accent="#f472b6" fmt={(v) => v.toFixed(2)} />
        <Slider label="anisotropy γ" min={0} max={1} step={0.05} value={g} onChange={setG} color="#db2777" accent="#f472b6" fmt={(v) => v.toFixed(2)} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <Metric label="DQPT?" value={crosses ? '✓ yes' : '— none'} color={crosses ? '#f472b6' : '#475569'} />
        <Metric label="critical modes k*" value={data.modes.length ? data.modes.map((k) => k.toFixed(3)).join(', ') : '—'} color="#c4b5fd" />
        <Metric label="# cusps shown" value={`${data.cts.length}`} color="#67e8f9" />
        <Metric label="vs exact dense" value={data.worst < 1e-8 ? '✓ exact' : data.worst.toExponential(1)} color={data.worst < 1e-8 ? '#34d399' : '#fbbf24'} />
      </div>
      <Label>Return-rate function l(t) — cusps at the critical times (dashed)</Label>
      <RatePlot times={data.times} l={data.l} cts={data.cts} denseT={data.denseT} dense={data.dense} />
      <p style={{ fontSize: 10, color: '#475569', margin: '8px 0 0', lineHeight: 1.5 }}>
        The cusps are the times at which a Fisher zero of the boundary partition function Z(t) =
        ⟨ψ₀|e<sup>−iH_f t</sup>|ψ₀⟩ crosses the real-time axis — the dynamical analogue of a free-energy
        non-analyticity at an equilibrium phase transition.
      </p>
    </Card>
  );
}

// ------------------------------------------------------------------ DTOP
function DtopCard() {
  const [hi, setHi] = useState(2.0);
  const [hf, setHf] = useState(0.5);
  const [g, setG] = useState(1.0);
  const [tSel, setTSel] = useState(2.0);
  const TMAX = 8, NT = 160;

  const data = useMemo(() => {
    const times = Array.from({ length: NT }, (_, i) => (i + 0.5) * TMAX / NT);
    const nu = times.map((t) => dtop(1, hi, hf, g, t, 1600).nu);
    const cts = criticalTimes(1, hi, hf, g, TMAX);
    const profile = geometricPhaseProfile(1, hi, hf, g, tSel, 240);
    const nuSel = dtop(1, hi, hf, g, tSel, 2400).nu;
    return { times, nu, cts, profile, nuSel };
  }, [hi, hf, g, tSel]);

  return (
    <Card title="Dynamical topological order parameter ν_D(t)" accent="#fbbf24">
      <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
        ν_D(t) is the integer winding number of the Pancharatnam geometric phase
        φₖ<sup>G</sup>(t) = arg⟨uₖ(0)|uₖ(t)⟩ + Eₖ t across the half Brillouin zone k ∈ [0, π]. It is a{' '}
        <b style={{ color: '#fbbf24' }}>topological</b> label of the non-equilibrium state between
        successive DQPTs: <b>0 before the first cusp, then 1, 2, 3, …</b> jumping by exactly one at each.
      </p>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Slider label="h init" min={0.1} max={3} step={0.05} value={hi} onChange={setHi} color="#d97706" accent="#fbbf24" fmt={(v) => v.toFixed(2)} />
        <Slider label="h quench" min={0.1} max={3} step={0.05} value={hf} onChange={setHf} color="#d97706" accent="#fbbf24" fmt={(v) => v.toFixed(2)} />
        <Slider label="anisotropy γ" min={0} max={1} step={0.05} value={g} onChange={setG} color="#d97706" accent="#fbbf24" fmt={(v) => v.toFixed(2)} />
      </div>
      <Label>ν_D(t): integer step function jumping +1 at each DQPT (dashed = critical times)</Label>
      <StepPlot times={data.times} nu={data.nu} cts={data.cts} tMax={TMAX} />
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', margin: '6px 0 10px', flexWrap: 'wrap' }}>
        <Slider label="snapshot t" min={0.1} max={TMAX} step={0.05} value={tSel} onChange={setTSel} color="#0d9488" accent="#5eead4" fmt={(v) => v.toFixed(2)} />
        <Metric label="ν_D at this t" value={`${data.nuSel}`} color="#fbbf24" />
      </div>
      <Label>Geometric phase φₖ<sup>G</sup> across the Brillouin zone at t — it winds ν_D times</Label>
      <WindingPlot profile={data.profile} />
    </Card>
  );
}

// ------------------------------------------------------------------ plots
function RatePlot({ times, l, cts, denseT, dense }:
  { times: number[]; l: number[]; cts: number[]; denseT: number[]; dense: number[] }) {
  const w = 560, h = 170, pad = 44;
  const tMax = times[times.length - 1];
  const yMax = Math.max(...l, ...dense, 0.1) * 1.08;
  const sx = (t: number) => pad + (t / tMax) * (w - pad - 12);
  const sy = (v: number) => 12 + (1 - v / yMax) * (h - 36);
  const path = times.map((t, i) => `${i === 0 ? 'M' : 'L'}${sx(t).toFixed(1)},${sy(l[i]).toFixed(1)}`).join(' ');
  const yt = [yMax, yMax / 2, 0];
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 6 }}>
      {yt.map((v, i) => (
        <g key={i}>
          <line x1={pad} y1={sy(v)} x2={w - 12} y2={sy(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 4} y={sy(v) + 3} fontSize={8} fill="#475569" textAnchor="end">{v.toFixed(2)}</text>
        </g>
      ))}
      {cts.map((t, i) => (
        <line key={i} x1={sx(t)} y1={10} x2={sx(t)} y2={h - 18} stroke="#f472b6" strokeWidth={1} strokeDasharray="3 3" opacity={0.65} />
      ))}
      {denseT.map((t, i) => <circle key={i} cx={sx(t)} cy={sy(dense[i])} r={1.9} fill="#67e8f9" opacity={0.9} />)}
      <path d={path} fill="none" stroke="#f472b6" strokeWidth={1.8} />
      {[0, tMax / 2, tMax].map((t, i) => <text key={i} x={sx(t)} y={h - 4} fontSize={8} fill="#475569" textAnchor="middle">{t.toFixed(1)}</text>)}
      <text x={w - 12} y={h - 4} fontSize={9} fill="#64748b" textAnchor="end">time t</text>
      <text x={pad - 4} y={9} fontSize={9} fill="#64748b" textAnchor="end">l(t)</text>
    </svg>
  );
}

function StepPlot({ times, nu, cts, tMax }: { times: number[]; nu: number[]; cts: number[]; tMax: number }) {
  const w = 560, h = 150, pad = 40;
  const nMax = Math.max(...nu, 1) + 0.5;
  const sx = (t: number) => pad + (t / tMax) * (w - pad - 12);
  const sy = (v: number) => 12 + (1 - v / nMax) * (h - 36);
  let d = `M${sx(times[0]).toFixed(1)},${sy(nu[0]).toFixed(1)}`;
  for (let i = 1; i < times.length; i++) d += ` L${sx(times[i]).toFixed(1)},${sy(nu[i - 1]).toFixed(1)} L${sx(times[i]).toFixed(1)},${sy(nu[i]).toFixed(1)}`;
  const ticks = Array.from({ length: Math.ceil(nMax) }, (_, i) => i);
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 14 }}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad} y1={sy(v)} x2={w - 12} y2={sy(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 4} y={sy(v) + 3} fontSize={8} fill="#475569" textAnchor="end">{v}</text>
        </g>
      ))}
      {cts.map((t, i) => <line key={i} x1={sx(t)} y1={10} x2={sx(t)} y2={h - 18} stroke="#fbbf24" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />)}
      <path d={d} fill="none" stroke="#fbbf24" strokeWidth={2} />
      {[0, tMax / 2, tMax].map((t, i) => <text key={i} x={sx(t)} y={h - 4} fontSize={8} fill="#475569" textAnchor="middle">{t.toFixed(1)}</text>)}
      <text x={w - 12} y={h - 4} fontSize={9} fill="#64748b" textAnchor="end">time t</text>
      <text x={pad - 4} y={9} fontSize={9} fill="#64748b" textAnchor="end">ν_D</text>
    </svg>
  );
}

function WindingPlot({ profile }: { profile: { k: number; phi: number }[] }) {
  const w = 560, h = 130, pad = 44;
  const sx = (k: number) => pad + (k / Math.PI) * (w - pad - 12);
  const sy = (v: number) => 12 + (1 - v / (2 * Math.PI)) * (h - 34);
  // break the polyline where φ wraps (jump > π) so the wrap doesn't draw a vertical streak
  const segs: string[] = [];
  let cur = '';
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    if (i > 0 && Math.abs(p.phi - profile[i - 1].phi) > Math.PI) { segs.push(cur); cur = ''; }
    cur += `${cur ? 'L' : 'M'}${sx(p.k).toFixed(1)},${sy(p.phi).toFixed(1)} `;
  }
  if (cur) segs.push(cur);
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: 'rgba(2,6,23,0.5)', borderRadius: 6, border: '1px solid #1e293b', marginBottom: 6 }}>
      {[2 * Math.PI, Math.PI, 0].map((v, i) => (
        <g key={i}>
          <line x1={pad} y1={sy(v)} x2={w - 12} y2={sy(v)} stroke="#1e293b" strokeWidth={1} />
          <text x={pad - 4} y={sy(v) + 3} fontSize={8} fill="#475569" textAnchor="end">{i === 0 ? '2π' : i === 1 ? 'π' : '0'}</text>
        </g>
      ))}
      {segs.map((d, i) => <path key={i} d={d} fill="none" stroke="#5eead4" strokeWidth={1.8} />)}
      {[0, 0.5, 1].map((f, i) => <text key={i} x={sx(f * Math.PI)} y={h - 4} fontSize={8} fill="#475569" textAnchor="middle">{i === 0 ? '0' : i === 1 ? 'π/2' : 'π'}</text>)}
      <text x={w - 12} y={h - 4} fontSize={9} fill="#64748b" textAnchor="end">momentum k</text>
      <text x={pad - 4} y={9} fontSize={9} fill="#64748b" textAnchor="end">φ<tspan dy={-3} fontSize={6}>G</tspan></text>
    </svg>
  );
}

// ------------------------------------------------------------------ shared UI atoms
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
