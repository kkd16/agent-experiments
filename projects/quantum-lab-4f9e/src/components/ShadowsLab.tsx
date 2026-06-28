import { useMemo, useState } from 'react';
import { QuantumState } from '../quantum/QuantumState';
import {
  type Pauli, type PauliString, type ObservableEstimate,
  shadowRng, collectPauliShadows, estimateObservables, estimatePurity, estimateRenyi2,
  estimateFidelity, exactPauli, exactReducedPurity, pauliLabel,
  collectCliffordShadows, estimateCliffordFidelity, estimateCliffordPurity,
} from '../quantum/shadows';

// ─────────────────────────────── state presets ───────────────────────────────

type PresetId = 'ghz' | 'w' | 'cluster' | 'product' | 'random';
const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'ghz', label: 'GHZ cat' },
  { id: 'w', label: 'W state' },
  { id: 'cluster', label: 'Cluster (graph) state' },
  { id: 'product', label: 'Random product' },
  { id: 'random', label: 'Random entangled' },
];

function buildState(preset: PresetId, n: number, seed: number): QuantumState {
  const s = new QuantumState(n);
  const rng = shadowRng(seed);
  switch (preset) {
    case 'ghz':
      s.applyGate({ name: 'H', qubits: [0] });
      for (let q = 1; q < n; q++) s.applyGate({ name: 'CNOT', qubits: [0, q] });
      return s;
    case 'w': {
      // |W⟩ = (|10…0⟩ + |01…0⟩ + … )/√n, built by the standard cascade of controlled rotations.
      s.applyGate({ name: 'X', qubits: [n - 1] });
      for (let q = n - 1; q > 0; q--) {
        const theta = 2 * Math.acos(Math.sqrt(1 / (q + 1)));
        // controlled-Ry(theta) on target q-1 by control q, via the CNOT sandwich
        s.applyGate({ name: 'Ry', qubits: [q - 1], params: [theta / 2] });
        s.applyGate({ name: 'CNOT', qubits: [q, q - 1] });
        s.applyGate({ name: 'Ry', qubits: [q - 1], params: [-theta / 2] });
        s.applyGate({ name: 'CNOT', qubits: [q, q - 1] });
        s.applyGate({ name: 'CNOT', qubits: [q - 1, q] });
      }
      return s;
    }
    case 'cluster':
      for (let q = 0; q < n; q++) s.applyGate({ name: 'H', qubits: [q] });
      for (let q = 0; q + 1 < n; q++) s.applyGate({ name: 'CZ', qubits: [q, q + 1] });
      return s;
    case 'product':
      for (let q = 0; q < n; q++) {
        s.applyGate({ name: 'Ry', qubits: [q], params: [rng() * Math.PI * 2] });
        s.applyGate({ name: 'Rz', qubits: [q], params: [rng() * Math.PI * 2] });
      }
      return s;
    case 'random':
    default:
      for (let q = 0; q < n; q++) {
        s.applyGate({ name: 'Ry', qubits: [q], params: [rng() * Math.PI * 2] });
        s.applyGate({ name: 'Rz', qubits: [q], params: [rng() * Math.PI * 2] });
      }
      for (let q = 0; q + 1 < n; q++) s.applyGate({ name: 'CNOT', qubits: [q, q + 1] });
      for (let q = 0; q < n; q++) s.applyGate({ name: 'Ry', qubits: [q], params: [rng() * Math.PI * 2] });
      return s;
  }
}

function single(p: Pauli, q: number, n: number): PauliString {
  const out: PauliString = Array(n).fill('I');
  out[q] = p;
  return out;
}
function pair(p: Pauli, q: number, n: number): PauliString {
  const out: PauliString = Array(n).fill('I');
  out[q] = p;
  out[q + 1] = p;
  return out;
}

// ─────────────────────────────── main component ───────────────────────────────

export default function ShadowsLab() {
  const [ensemble, setEnsemble] = useState<'pauli' | 'clifford'>('pauli');
  const [preset, setPreset] = useState<PresetId>('ghz');
  const [n, setN] = useState(3);
  const [snapshots, setSnapshots] = useState(2000);
  const [seed, setSeed] = useState(1);

  const nClamped = ensemble === 'clifford' ? Math.min(n, 2) : n;

  return (
    <div style={{ maxWidth: 860 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 16px', lineHeight: 1.65 }}>
        You cannot read a 2<sup>n</sup>-amplitude state out of a quantum device — you can only measure it,
        and each shot returns one classical bit-string. <b style={{ color: '#a78bfa' }}>Classical shadows</b>{' '}
        (Huang–Kueng–Preskill 2020) turn a few random measurements into a compact classical sketch that
        predicts <i>many</i> properties at once. Apply a random unitary <code>U</code>, measure to get{' '}
        <code>|b⟩</code>; because the measurement channel <code>M(ρ)=E[U†|b⟩⟨b|U]</code> is a known invertible
        map, one shot gives an <b style={{ color: '#34d399' }}>unbiased snapshot</b>{' '}
        <code>ρ̂ = M⁻¹(U†|b⟩⟨b|U)</code> with <code>E[ρ̂]=ρ</code>. Average <code>tr(O ρ̂)</code> to estimate
        any <code>⟨O⟩</code> you ask for later. Two ensembles: <b style={{ color: '#67e8f9' }}>random Pauli</b>{' '}
        (local — great for many low-weight observables, variance ≤ 3<sup>k</sup>) and{' '}
        <b style={{ color: '#67e8f9' }}>random global Clifford</b> (variance independent of locality — great
        for fidelity and purity). Everything below is cross-checked against the exact state vector.
      </p>

      <Card title="Setup" accent="#a78bfa">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {(['pauli', 'clifford'] as const).map((e) => (
            <button key={e} onClick={() => setEnsemble(e)} style={pill(ensemble === e)}>
              {e === 'pauli' ? 'Random Pauli (local)' : 'Random Clifford (global, n≤2)'}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={lab}>state
            <select value={preset} onChange={(e) => setPreset(e.target.value as PresetId)} style={sel}>
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label style={{ ...lab, flex: 1, minWidth: 180 }}>
            <span style={{ whiteSpace: 'nowrap' }}>qubits {nClamped}</span>
            <input type="range" min={1} max={ensemble === 'clifford' ? 2 : 6} step={1} value={nClamped}
              onChange={(e) => setN(parseInt(e.target.value))} style={{ flex: 1, accentColor: '#7c3aed' }} />
          </label>
          <label style={{ ...lab, flex: 1, minWidth: 220 }}>
            <span style={{ whiteSpace: 'nowrap' }}>snapshots {snapshots}</span>
            <input type="range" min={100} max={5000} step={100} value={snapshots}
              onChange={(e) => setSnapshots(parseInt(e.target.value))} style={{ flex: 1, accentColor: '#0891b2' }} />
          </label>
          <label style={lab}>seed
            <input type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value) || 0)}
              style={{ ...sel, width: 64 }} />
          </label>
        </div>
      </Card>

      {ensemble === 'pauli'
        ? <PauliView preset={preset} n={nClamped} snapshots={snapshots} seed={seed} />
        : <CliffordView preset={preset} n={nClamped} snapshots={snapshots} seed={seed} />}
    </div>
  );
}

// ─────────────────────────────── Pauli ensemble view ───────────────────────────────

function PauliView({ preset, n, snapshots, seed }: { preset: PresetId; n: number; snapshots: number; seed: number }) {
  const data = useMemo(() => {
    const state = buildState(preset, n, seed);
    const snaps = collectPauliShadows(state, snapshots, shadowRng(seed * 2654435761 + 1));

    const observables: PauliString[] = [];
    for (let q = 0; q < n; q++) observables.push(single('Z', q, n));
    for (let q = 0; q < n; q++) observables.push(single('X', q, n));
    for (let q = 0; q + 1 < n; q++) observables.push(pair('Z', q, n));
    const estimates = estimateObservables(state, snaps, observables, 10);

    const purity = estimatePurity(snaps, undefined, shadowRng(seed + 99));
    const half = Array.from({ length: Math.max(1, Math.floor(n / 2)) }, (_, i) => i);
    const renyi = estimateRenyi2(snaps, half, shadowRng(seed + 7));
    const renyiExact = -Math.log2(exactReducedPurity(state, half));
    const fidelity = estimateFidelity(snaps, state);

    // convergence of one mid-weight observable vs sample size
    const probe = observables.find((o) => o.filter((p) => p !== 'I').length === 2) ?? observables[0];
    const probeExact = exactPauli(state, probe);
    const Ms = [100, 200, 500, 1000, 2000, 3500, 5000].filter((m) => m <= snaps.length);
    const conv = Ms.map((m) => {
      const sub = snaps.slice(0, m);
      const est = estimateObservables(state, sub, [probe], 8)[0];
      return { m, err: Math.max(1e-4, Math.abs(est.estimate - probeExact)) };
    });

    return { estimates, purity, renyi, renyiExact, fidelity, half, probe, conv };
  }, [preset, n, snapshots, seed]);

  const maxAbs = Math.max(1, ...data.estimates.map((e) => Math.max(Math.abs(e.exact), Math.abs(e.estimate))));

  return (
    <>
      <Card title={`Many observables from one shadow (${snapshots} snapshots)`} accent="#67e8f9">
        <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.5 }}>
          A single dataset predicts every observable below — the bars compare the shadow estimate
          (median-of-means) against the exact value from the state vector. ZZ correlators are weight-2,
          so they need ~3× more shots than the weight-1 single-qubit terms for the same accuracy.
        </p>
        <ObsChart estimates={data.estimates} maxAbs={maxAbs} />
        <ObsTable estimates={data.estimates} />
      </Card>

      <Card title="Nonlinear functionals — purity, entropy, fidelity" accent="#a78bfa">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Compare label="purity Tr(ρ²)" est={data.purity} exact={1} hint="pure ⇒ 1" />
          <Compare label={`Rényi-2 S₂ (q0…${data.half[data.half.length - 1]})`} est={data.renyi} exact={data.renyiExact} hint="bits" />
          <Compare label="fidelity ⟨ψ|ρ|ψ⟩" est={data.fidelity} exact={1} hint="self ⇒ 1" />
        </div>
        <p style={{ color: '#475569', fontSize: 10, margin: '10px 0 0', lineHeight: 1.5 }}>
          The purity uses a U-statistic over snapshot <i>pairs</i>: <code>tr(σ̂ᵢσ̂ⱼ)</code> per qubit is 5
          (same basis &amp; bit), −4 (same basis, different bit) or ½ (different basis). Restricting the product
          to a subsystem gives <code>Tr(ρ_A²)</code> and hence the 2-Rényi entanglement entropy — entropy from
          randomized measurements, never reconstructing the state.
        </p>
      </Card>

      <Card title="Convergence & the shadow norm" accent="#67e8f9">
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
              error of <code style={{ color: '#a78bfa' }}>{pauliLabel(data.probe)}</code> vs snapshots (log–log) — the
              1/√M Monte-Carlo law
            </div>
            <ConvChart conv={data.conv} />
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
              single-shot variance bound <code style={{ color: '#a78bfa' }}>3ᵏ</code> by Pauli weight k (the shadow
              norm — proven exact in the Tests tab)
            </div>
            <VarChart maxK={Math.min(3, n)} />
          </div>
        </div>
      </Card>
    </>
  );
}

// ─────────────────────────────── global Clifford view ───────────────────────────────

function CliffordView({ preset, n, snapshots, seed }: { preset: PresetId; n: number; snapshots: number; seed: number }) {
  const data = useMemo(() => {
    const state = buildState(preset, n, seed);
    const snaps = collectCliffordShadows(state, snapshots, shadowRng(seed * 40503 + 3));
    const dim = 1 << n;
    const fidelity = estimateCliffordFidelity(snaps, state);
    const purity = estimateCliffordPurity(snaps, dim, shadowRng(seed + 11));
    const exactPurity = state.amplitudes.reduce((s, a) => s + a.abs2(), 0); // 1 for normalized pure
    return { fidelity, purity, exactPurity };
  }, [preset, n, snapshots, seed]);

  return (
    <Card title={`Global Clifford shadows (n=${n}, exact 3-design)`} accent="#67e8f9">
      <p style={{ color: '#475569', fontSize: 11, margin: '0 0 12px', lineHeight: 1.55 }}>
        The unitary is a uniform n-qubit Clifford — drawn from the fully enumerated group
        (24 for n=1, 11520 for n=2), so the ensemble is an exact unitary 3-design and the estimator is exact.
        The inverse channel is <code>ρ̂ = (2ⁿ+1) U†|b⟩⟨b|U − I</code>, and the variance of an observable is
        bounded by <code>3·tr(O₀²)</code> — independent of locality, the regime where global Clifford shadows
        beat the Pauli ones. Direct fidelity estimation reads off{' '}
        <code>(2ⁿ+1)|⟨ψ|s⟩|² − 1</code> per snapshot.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Compare label="fidelity ⟨ψ|ρ|ψ⟩" est={data.fidelity} exact={1} hint="self ⇒ 1" />
        <Compare label="purity Tr(ρ²)" est={data.purity} exact={data.exactPurity} hint="pure ⇒ 1" />
      </div>
      <p style={{ color: '#475569', fontSize: 10, margin: '10px 0 0', lineHeight: 1.5 }}>
        Increase the snapshot count to watch both estimates converge to 1. Try n=2 with a Bell/GHZ state —
        the global-Clifford purity estimator never has to touch individual qubits.
      </p>
    </Card>
  );
}

// ─────────────────────────────── charts ───────────────────────────────

function ObsChart({ estimates, maxAbs }: { estimates: ObservableEstimate[]; maxAbs: number }) {
  const W = 820, rowH = 22, padL = 70, mid = (W - padL) / 2 + padL;
  const H = estimates.length * rowH + 10;
  const scale = (W - padL - 16) / 2 / maxAbs;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <line x1={mid} y1={0} x2={mid} y2={H} stroke="#1e293b" strokeWidth={1} />
      {estimates.map((e, i) => {
        const y = i * rowH + 6;
        const exX = mid + e.exact * scale;
        const estX = mid + e.estimate * scale;
        return (
          <g key={e.label}>
            <text x={padL - 8} y={y + rowH / 2} fill="#64748b" fontSize={10} fontFamily="monospace" textAnchor="end">{e.label}</text>
            {/* exact marker */}
            <rect x={Math.min(mid, exX)} y={y + 3} width={Math.abs(exX - mid)} height={rowH - 12} fill="rgba(103,232,249,0.18)" />
            <line x1={exX} y1={y + 1} x2={exX} y2={y + rowH - 4} stroke="#67e8f9" strokeWidth={2} />
            {/* estimate marker */}
            <circle cx={estX} cy={y + rowH / 2 - 1} r={3.2} fill="#a78bfa" />
            {/* error bar from stderr */}
            <line x1={estX - e.stderr * scale} y1={y + rowH / 2 - 1} x2={estX + e.stderr * scale} y2={y + rowH / 2 - 1} stroke="#a78bfa" strokeWidth={1} opacity={0.6} />
          </g>
        );
      })}
      <text x={padL} y={H - 1} fill="#334155" fontSize={8}>−{maxAbs.toFixed(1)}</text>
      <text x={mid} y={H - 1} fill="#334155" fontSize={8} textAnchor="middle">0</text>
      <text x={W - 16} y={H - 1} fill="#334155" fontSize={8} textAnchor="end">+{maxAbs.toFixed(1)}</text>
    </svg>
  );
}

function ObsTable({ estimates }: { estimates: ObservableEstimate[] }) {
  return (
    <div style={{ overflowX: 'auto', marginTop: 10 }}>
      <table style={{ borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: 11, width: '100%' }}>
        <thead>
          <tr style={{ color: '#475569', textAlign: 'right' }}>
            <th style={th}>observable</th><th style={th}>weight</th><th style={th}>shadow</th>
            <th style={th}>exact</th><th style={th}>error</th>
          </tr>
        </thead>
        <tbody>
          {estimates.map((e) => (
            <tr key={e.label} style={{ color: '#cbd5e1', textAlign: 'right' }}>
              <td style={{ ...td, color: '#a78bfa', textAlign: 'left' }}>{e.label}</td>
              <td style={td}>{e.weight}</td>
              <td style={td}>{e.estimate.toFixed(3)}</td>
              <td style={{ ...td, color: '#67e8f9' }}>{e.exact.toFixed(3)}</td>
              <td style={{ ...td, color: e.error < 0.1 ? '#34d399' : '#f59e0b' }}>{e.error.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConvChart({ conv }: { conv: { m: number; err: number }[] }) {
  const W = 360, H = 160, padL = 36, padB = 22, padT = 8;
  if (conv.length < 2) return null;
  const xs = conv.map((c) => Math.log10(c.m));
  const ys = conv.map((c) => Math.log10(c.err));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys, -3), ymax = Math.max(...ys, 0);
  const sx = (x: number) => padL + ((x - xmin) / (xmax - xmin || 1)) * (W - padL - 8);
  const sy = (y: number) => padT + (1 - (y - ymin) / (ymax - ymin || 1)) * (H - padT - padB);
  const path = xs.map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(ys[i]).toFixed(1)}`).join(' ');
  // reference 1/√M slope line through the first point
  const refY0 = ys[0];
  const ref = xs.map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(refY0 - 0.5 * (x - xs[0])).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }}>
      <rect x={padL} y={padT} width={W - padL - 8} height={H - padT - padB} fill="rgba(2,6,23,0.4)" stroke="#1e293b" />
      <path d={ref} stroke="#334155" strokeWidth={1} strokeDasharray="4 3" fill="none" />
      <path d={path} stroke="#a78bfa" strokeWidth={2} fill="none" />
      {conv.map((c, i) => <circle key={c.m} cx={sx(xs[i])} cy={sy(ys[i])} r={2.6} fill="#67e8f9" />)}
      <text x={padL} y={H - 6} fill="#475569" fontSize={8}>{conv[0].m}</text>
      <text x={W - 8} y={H - 6} fill="#475569" fontSize={8} textAnchor="end">{conv[conv.length - 1].m} snaps</text>
      <text x={4} y={padT + 8} fill="#475569" fontSize={8}>err</text>
      <text x={W - 10} y={padT + 10} fill="#334155" fontSize={8} textAnchor="end">dashed = 1/√M</text>
    </svg>
  );
}

function VarChart({ maxK }: { maxK: number }) {
  const ks = Array.from({ length: maxK }, (_, i) => i + 1);
  const max = 3 ** maxK;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: 150, padding: '4px 4px 0' }}>
      {ks.map((k) => {
        const v = 3 ** k;
        return (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, height: '100%', justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 10, color: '#a78bfa', fontFamily: 'monospace' }}>{v}</span>
            <div style={{ width: '70%', height: `${(v / max) * 100}%`, minHeight: 3, background: 'linear-gradient(180deg,#a78bfa,#0891b2)', borderRadius: 3 }} />
            <span style={{ fontSize: 9, color: '#475569', fontFamily: 'monospace', marginTop: 3 }}>k={k}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────── shared bits ───────────────────────────────

function Compare({ label, est, exact, hint }: { label: string; est: number; exact: number; hint: string }) {
  const err = Math.abs(est - exact);
  const ok = err < 0.12;
  return (
    <div style={{ padding: '8px 12px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8, minWidth: 150 }}>
      <div style={{ fontSize: 9, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 17, fontFamily: 'monospace', fontWeight: 700, color: ok ? '#34d399' : '#f59e0b' }}>{est.toFixed(3)}</div>
      <div style={{ fontSize: 9, color: '#64748b', fontFamily: 'monospace' }}>exact {exact.toFixed(3)} · {hint}</div>
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

function pill(active: boolean): React.CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 7, cursor: 'pointer', fontSize: 11, fontWeight: active ? 700 : 500,
    border: `1px solid ${active ? '#7c3aed' : '#1e293b'}`,
    background: active ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.02)',
    color: active ? '#a78bfa' : '#64748b',
  };
}

const sel: React.CSSProperties = { padding: '6px 10px', borderRadius: 6, background: '#0a0f1e', color: '#e2e8f0', border: '1px solid #334155', fontSize: 12 };
const lab: React.CSSProperties = { fontSize: 11, color: '#94a3b8', display: 'flex', gap: 6, alignItems: 'center' };
const th: React.CSSProperties = { padding: '3px 10px', fontWeight: 600, borderBottom: '1px solid #1e293b' };
const td: React.CSSProperties = { padding: '3px 10px' };
