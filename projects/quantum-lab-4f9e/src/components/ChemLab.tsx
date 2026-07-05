import { useState, useMemo, useEffect } from 'react';
import { motion } from 'framer-motion';
import { MOLECULES, getMolecule, BOHR_TO_ANGSTROM } from '../quantum/chem/molecules';
import {
  solvePoint, runVQEChem, dissociationCurve, equilibrium, refinedEquilibrium,
  type MoleculePoint, type VQEChemResult, type CurvePoint,
} from '../quantum/chem/vqe';
import { prettyPauli } from '../quantum/chem/pauli';

export default function ChemLab() {
  const [molId, setMolId] = useState('h2');
  const mol = getMolecule(molId);
  const [param, setParam] = useState(mol.defaultParam);
  const [curve, setCurve] = useState<CurvePoint[] | null>(null);
  const [vqe, setVqe] = useState<VQEChemResult | null>(null);
  const [vqeBusy, setVqeBusy] = useState(false);

  const point: MoleculePoint = useMemo(() => solvePoint(mol, param), [mol, param]);
  const isAtom = mol.range[0] === mol.range[1];
  const canVQE = mol.correlated && mol.nQubits <= 6;

  const selectMolecule = (id: string) => {
    const m = getMolecule(id);
    setMolId(id);
    setParam(m.defaultParam);
    setVqe(null);
    setCurve(null);
  };

  // Recompute the dissociation curve when the molecule changes. All state writes happen inside
  // the deferred callback (not synchronously in the effect), so the tab stays responsive.
  useEffect(() => {
    if (isAtom) return; // atoms have no curve; selectMolecule already cleared it
    let cancelled = false;
    const id = setTimeout(() => {
      if (cancelled) return;
      setCurve(dissociationCurve(mol, mol.nQubits <= 4 ? 46 : 26));
    }, 30);
    return () => { cancelled = true; clearTimeout(id); };
  }, [molId]); // eslint-disable-line react-hooks/exhaustive-deps

  const eq = useMemo(
    () => (curve && curve.length ? refinedEquilibrium(mol, equilibrium(curve)?.param ?? mol.defaultParam) : null),
    [curve, mol],
  );
  const runVQE = () => {
    setVqeBusy(true);
    setTimeout(() => { setVqe(runVQEChem(mol, param)); setVqeBusy(false); }, 20);
  };

  const sortedTerms = useMemo(
    () => [...point.hamiltonian.terms].sort((a, b) => Math.abs(b.coeff) - Math.abs(a.coeff)),
    [point],
  );

  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ color: '#64748b', fontSize: 12, margin: '0 0 16px', lineHeight: 1.65 }}>
        Real molecules, from first principles — no PySCF, no Qiskit. The lab builds each
        molecule's <b style={{ color: '#a78bfa' }}>Gaussian integrals</b> in closed form, solves
        <b style={{ color: '#a78bfa' }}> Hartree–Fock</b>, maps the electronic Hamiltonian to qubits
        with the <b style={{ color: '#67e8f9' }}>Jordan–Wigner</b> transform, and finds the ground
        state two ways: exact diagonalisation (FCI) and a <b style={{ color: '#67e8f9' }}>UCCSD VQE</b>
        {' '}run on the state-vector simulator. Correlation energy — the part Hartree–Fock misses —
        falls straight out.
      </p>

      {/* Molecule picker */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {MOLECULES.map((m) => (
          <button
            key={m.id}
            onClick={() => selectMolecule(m.id)}
            style={{
              padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
              border: `1px solid ${molId === m.id ? '#7c3aed' : 'rgba(30,58,95,0.6)'}`,
              background: molId === m.id ? 'rgba(124,58,237,0.25)' : 'rgba(14,22,41,0.6)',
              color: molId === m.id ? '#c4b5fd' : '#94a3b8',
              fontSize: 15, fontWeight: 700, minWidth: 64,
            }}
            title={m.name}
          >
            {m.formula}
          </button>
        ))}
      </div>

      <Card title={`${mol.name} · ${mol.formula}`} accent="#a78bfa">
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>{mol.blurb}</p>
        <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 12px', lineHeight: 1.5 }}>
          <b style={{ color: '#475569' }}>Reference:</b> {mol.reference}
        </p>

        {!isAtom && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>
              <span>{mol.paramLabel}</span>
              <span style={{ fontFamily: 'monospace', color: '#67e8f9' }}>
                {param.toFixed(3)} a₀ = {(param * BOHR_TO_ANGSTROM).toFixed(3)} Å
              </span>
            </div>
            <input
              type="range" min={mol.range[0]} max={mol.range[1]} step={0.01} value={param}
              onChange={(e) => { setParam(+e.target.value); setVqe(null); }}
              style={{ width: '100%', accentColor: '#7c3aed' }}
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Metric label="Hartree–Fock" value={point.hf.toFixed(5)} unit="Eₕ" color="#a78bfa" />
          {point.fci != null && <Metric label="Exact (FCI)" value={point.fci.toFixed(5)} unit="Eₕ" color="#67e8f9" />}
          {point.fci != null && <Metric label="Correlation" value={(point.fci - point.hf).toFixed(5)} unit="Eₕ" color="#34d399" />}
          <Metric label="Nuclear rep." value={point.scf.nuclearRepulsion.toFixed(4)} unit="Eₕ" color="#f59e0b" />
          <Metric label="Qubits" value={String(mol.nQubits)} color="#f1f5f9" />
          <Metric label="Pauli terms" value={String(point.hamiltonian.terms.length)} color="#f1f5f9" />
        </div>

        <div style={{ marginTop: 12, fontSize: 11, color: '#94a3b8' }}>
          <b style={{ color: '#64748b' }}>Orbital energies (Eₕ):</b>{' '}
          <span style={{ fontFamily: 'monospace', color: '#cbd5e1' }}>
            {point.scf.orbitalEnergies.map((e, i) => (
              <span key={i} style={{ color: i < mol.nElectrons / 2 ? '#34d399' : '#64748b' }}>
                {e.toFixed(3)}{i < point.scf.orbitalEnergies.length - 1 ? '  ' : ''}
              </span>
            ))}
          </span>
          <span style={{ color: '#475569' }}> (green = occupied)</span>
        </div>
      </Card>

      {/* Dissociation curve */}
      {!isAtom && (
        <Card title="Potential-energy surface (dissociation curve)" accent="#67e8f9">
          <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
            Sweep the geometry and plot the ground-state energy. The minimum is the equilibrium
            bond length; as the atoms separate, Hartree–Fock (which forces the electrons to stay
            paired) rises above the exact curve — the famous <b>static-correlation</b> error that
            VQE and FCI repair.
          </p>
          {!curve && <div style={{ color: '#64748b', fontSize: 12 }}>Computing curve…</div>}
          {curve && curve.length > 0 && (
            <>
              <CurvePlot curve={curve} eqParam={eq?.param} eqEnergy={eq?.energy} current={param} bohr={mol.paramLabel.includes('distance') || mol.formula === 'H₂'} />
              {eq && (
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
                  Equilibrium: <b style={{ color: '#67e8f9', fontFamily: 'monospace' }}>{eq.param.toFixed(3)} a₀</b>
                  {' = '}<b style={{ color: '#67e8f9', fontFamily: 'monospace' }}>{(eq.param * BOHR_TO_ANGSTROM).toFixed(3)} Å</b>,
                  {' '}E = <b style={{ color: '#67e8f9', fontFamily: 'monospace' }}>{eq.energy.toFixed(5)} Eₕ</b>
                  {mol.formula === 'H₂' && <span style={{ color: '#475569' }}> (experiment: 0.741 Å)</span>}
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* VQE */}
      <Card title="Variational Quantum Eigensolver (UCCSD)" accent="#a78bfa">
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
          Prepare the Hartree–Fock state on the qubits, apply the unitary coupled-cluster
          singles-and-doubles ansatz, and let a classical <b>Nelder–Mead</b> optimiser tune the
          excitation amplitudes to minimise ⟨ψ|H|ψ⟩ — the exact hybrid loop that runs on real
          quantum hardware. It converges to the FCI energy, recovering the correlation Hartree–Fock
          cannot see.
        </p>
        {!canVQE ? (
          <div style={{ fontSize: 12, color: '#64748b' }}>
            {mol.formula} uses {mol.nQubits} qubits — beyond the interactive VQE/FCI limit (6). The
            Hartree–Fock curve above still runs from scratch.
          </div>
        ) : (
          <>
            <button onClick={runVQE} disabled={vqeBusy} style={btn('#7c3aed')}>
              {vqeBusy ? 'Optimizing…' : `▶ Run VQE  (${point.excitations.length} excitation${point.excitations.length === 1 ? '' : 's'})`}
            </button>
            {vqe && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                  <Metric label="HF (start)" value={vqe.hf.toFixed(5)} unit="Eₕ" color="#64748b" />
                  <Metric label="VQE" value={vqe.energy.toFixed(5)} unit="Eₕ" color="#a78bfa" />
                  <Metric label="Exact (FCI)" value={vqe.fci.toFixed(5)} unit="Eₕ" color="#67e8f9" />
                  <Metric label="Error vs FCI" value={Math.abs(vqe.energy - vqe.fci).toExponential(1)} unit="Eₕ" color="#34d399" />
                  <Metric label="Correlation" value={vqe.correlation.toFixed(5)} unit="Eₕ" color="#f59e0b" />
                </div>
                <ConvergencePlot history={vqe.history} hf={vqe.hf} fci={vqe.fci} />
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 8 }}>
                  {vqe.nParams} variational parameter{vqe.nParams === 1 ? '' : 's'} ·
                  angles {vqe.thetas.map((t) => t.toFixed(3)).join(', ')}
                </div>
              </motion.div>
            )}
          </>
        )}
      </Card>

      {/* Qubit Hamiltonian */}
      <Card title={`Qubit Hamiltonian (Jordan–Wigner) · ${point.hamiltonian.terms.length} Pauli terms`} accent="#f59e0b">
        <p style={{ fontSize: 12, color: '#94a3b8', margin: '0 0 10px', lineHeight: 1.6 }}>
          The molecular Hamiltonian, mapped to {mol.nQubits} qubits. Constant offset (identity +
          nuclear repulsion): <code style={{ color: '#67e8f9' }}>{point.hamiltonian.constant.toFixed(5)} Eₕ</code>.
          {mol.formula === 'H₂' && ' For H₂ this is the celebrated 15-term operator (14 Pauli terms + the identity, folded into the constant above).'}
        </p>
        <div style={{
          maxHeight: 210, overflowY: 'auto', background: 'rgba(2,6,23,0.5)',
          border: '1px solid #1e293b', borderRadius: 8, padding: '8px 12px',
          fontFamily: 'monospace', fontSize: 12, lineHeight: 1.7,
        }}>
          {sortedTerms.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 10 }}>
              <span style={{ color: t.coeff >= 0 ? '#67e8f9' : '#f87171', minWidth: 78, textAlign: 'right' }}>
                {t.coeff >= 0 ? '+' : ''}{t.coeff.toFixed(5)}
              </span>
              <span style={{ color: '#cbd5e1' }}>{prettyPauli(pad(t.ops, mol.nQubits))}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/** Reconstruct the full-length Pauli string from a sparse ops map, for prettyPauli. */
function pad(ops: Record<number, string>, n: number): string {
  const arr = new Array(n).fill('I');
  for (const k of Object.keys(ops)) arr[+k] = ops[+k];
  return arr.join('');
}

// ---- Plots ---------------------------------------------------------------------------------

function CurvePlot({ curve, eqParam, eqEnergy, current, bohr }: {
  curve: CurvePoint[]; eqParam?: number; eqEnergy?: number; current: number; bohr: boolean;
}) {
  const W = 680, H = 240, pad = 40;
  const xs = curve.map((p) => p.param);
  const hasFci = curve.some((p) => p.fci != null);
  const ys = curve.flatMap((p) => [p.hf, ...(p.fci != null ? [p.fci] : [])]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  const yr = ymax - ymin || 1; ymin -= yr * 0.08; ymax += yr * 0.08;
  const sx = (x: number) => pad + ((x - xmin) / (xmax - xmin)) * (W - 2 * pad);
  const sy = (y: number) => H - pad - ((y - ymin) / (ymax - ymin)) * (H - 2 * pad);
  const path = (sel: (p: CurvePoint) => number | null) => {
    let d = ''; let started = false;
    for (const p of curve) {
      const v = sel(p); if (v == null) continue;
      d += `${started ? 'L' : 'M'}${sx(p.param).toFixed(1)},${sy(v).toFixed(1)} `; started = true;
    }
    return d;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: 'rgba(2,6,23,0.5)', borderRadius: 8, border: '1px solid #1e293b' }}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const y = pad + f * (H - 2 * pad); const e = ymax - f * (ymax - ymin);
        return (
          <g key={f}>
            <line x1={pad} y1={y} x2={W - pad} y2={y} stroke="#1e293b" strokeWidth={1} />
            <text x={6} y={y + 3} fill="#475569" fontSize={9} fontFamily="monospace">{e.toFixed(2)}</text>
          </g>
        );
      })}
      {/* current geometry marker */}
      <line x1={sx(current)} y1={pad} x2={sx(current)} y2={H - pad} stroke="#7c3aed" strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
      <path d={path((p) => p.hf)} fill="none" stroke="#a78bfa" strokeWidth={2} strokeDasharray={hasFci ? '5 4' : undefined} />
      {hasFci && <path d={path((p) => p.fci)} fill="none" stroke="#67e8f9" strokeWidth={2} />}
      {eqParam != null && eqEnergy != null && (
        <circle cx={sx(eqParam)} cy={sy(eqEnergy)} r={4} fill="#34d399" stroke="#022c22" strokeWidth={1} />
      )}
      <text x={W / 2} y={H - 6} fill="#64748b" fontSize={10} textAnchor="middle">{bohr ? 'separation (a₀)' : 'geometry (a₀)'}</text>
      <g fontFamily="sans-serif">
        <rect x={W - pad - 118} y={pad + 4} width={112} height={hasFci ? 34 : 20} fill="rgba(2,6,23,0.7)" stroke="#1e293b" rx={4} />
        <line x1={W - pad - 110} y1={pad + 14} x2={W - pad - 90} y2={pad + 14} stroke="#a78bfa" strokeWidth={2} strokeDasharray="5 4" />
        <text x={W - pad - 84} y={pad + 17} fill="#a78bfa" fontSize={10}>Hartree–Fock</text>
        {hasFci && <><line x1={W - pad - 110} y1={pad + 28} x2={W - pad - 90} y2={pad + 28} stroke="#67e8f9" strokeWidth={2} /><text x={W - pad - 84} y={pad + 31} fill="#67e8f9" fontSize={10}>Exact (FCI)</text></>}
      </g>
    </svg>
  );
}

function ConvergencePlot({ history, hf, fci }: { history: number[]; hf: number; fci: number }) {
  const W = 680, H = 170, pad = 40;
  if (!history.length) return null;
  const ys = [...history, hf, fci];
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  const yr = ymax - ymin || 1; ymin -= yr * 0.05; ymax += yr * 0.05;
  const sx = (i: number) => pad + (i / (history.length - 1 || 1)) * (W - 2 * pad);
  const sy = (y: number) => H - pad - ((y - ymin) / (ymax - ymin)) * (H - 2 * pad);
  let d = ''; history.forEach((e, i) => { d += `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(e).toFixed(1)} `; });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: 'rgba(2,6,23,0.5)', borderRadius: 8, border: '1px solid #1e293b' }}>
      <line x1={pad} y1={sy(fci)} x2={W - pad} y2={sy(fci)} stroke="#67e8f9" strokeWidth={1} strokeDasharray="4 4" opacity={0.7} />
      <text x={W - pad + 2} y={sy(fci) + 3} fill="#67e8f9" fontSize={9} textAnchor="end">FCI</text>
      <line x1={pad} y1={sy(hf)} x2={W - pad} y2={sy(hf)} stroke="#64748b" strokeWidth={1} strokeDasharray="4 4" opacity={0.5} />
      <path d={d} fill="none" stroke="#a78bfa" strokeWidth={2} />
      <text x={W / 2} y={H - 6} fill="#64748b" fontSize={10} textAnchor="middle">optimiser evaluation → energy (Eₕ)</text>
    </svg>
  );
}

// ---- Shared bits ---------------------------------------------------------------------------

function Card({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(14,22,41,0.6)', border: '1px solid rgba(30,58,95,0.5)', borderRadius: 12, padding: '16px 18px', marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 800, color: accent }}>{title}</h3>
      {children}
    </div>
  );
}
function Metric({ label, value, unit, color }: { label: string; value: string; unit?: string; color: string }) {
  return (
    <div style={{ background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', borderRadius: 8, padding: '6px 12px' }}>
      <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color, fontFamily: 'monospace' }}>
        {value}{unit && <span style={{ fontSize: 10, color: '#475569', marginLeft: 3 }}>{unit}</span>}
      </div>
    </div>
  );
}
function btn(color: string): React.CSSProperties {
  return { padding: '7px 16px', borderRadius: 8, border: 'none', background: color, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
}
