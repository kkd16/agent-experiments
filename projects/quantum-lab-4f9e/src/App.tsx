import { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { QuantumState, type GateOp } from './quantum/QuantumState';
import { ALGORITHMS, type Algorithm } from './quantum/algorithms';
import { NO_NOISE, isNoiseActive, type NoiseModel } from './quantum/noise';
import { decodeFromHash } from './quantum/serialize';
import CircuitEditor from './components/CircuitEditor';
import StateVector from './components/StateVector';
import ProbabilityChart from './components/ProbabilityChart';
import AlgorithmPanel from './components/AlgorithmPanel';
import MeasurementPanel from './components/MeasurementPanel';
import BlochSphere from './components/BlochSphere';
import DensityLab from './components/DensityLab';
import VariationalLab from './components/VariationalLab';
import StabilizerLab from './components/StabilizerLab';
import SurfaceLab from './components/SurfaceLab';
import TensorLab from './components/TensorLab';
import FreeFermionLab from './components/FreeFermionLab';
import DynamicsLab from './components/DynamicsLab';
import ShorLab from './components/ShorLab';
import MBQCLab from './components/MBQCLab';
import SolovayLab from './components/SolovayLab';
import SynthLab from './components/SynthLab';
import ShannonLab from './components/ShannonLab';
import DistillationLab from './components/DistillationLab';
import NonlocalityLab from './components/NonlocalityLab';
import DeviceIndependentLab from './components/DeviceIndependentLab';
import MetrologyLab from './components/MetrologyLab';
import TestsPanel from './components/TestsPanel';
import ExportPanel from './components/ExportPanel';
import { schmidtDecompose } from './quantum/Schmidt';

type Tab = 'builder' | 'algorithms' | 'shor' | 'solovay' | 'synth' | 'shannon' | 'distill' | 'bell' | 'deviceindep' | 'metrology' | 'mbqc' | 'variational' | 'stabilizer' | 'surface' | 'tensor' | 'freefermion' | 'dynamics' | 'tests' | 'about';
type VizTab = 'state' | 'probabilities' | 'bloch' | 'density' | 'measure';

const PAGE_TABS: Tab[] = ['about', 'shor', 'solovay', 'synth', 'shannon', 'distill', 'bell', 'deviceindep', 'metrology', 'mbqc', 'variational', 'stabilizer', 'surface', 'tensor', 'freefermion', 'dynamics', 'tests'];

// Parse a shared circuit from the URL hash (#c=…) once, before mount — sandbox-safe.
function loadSharedCircuit(): { numQubits: number; ops: GateOp[] } | null {
  try {
    const m = typeof location !== 'undefined' ? location.hash.match(/c=([^&]+)/) : null;
    if (!m) return null;
    const doc = decodeFromHash(m[1]);
    return doc && doc.ops.length ? { numQubits: doc.numQubits, ops: doc.ops } : null;
  } catch {
    return null;
  }
}

export default function App() {
  const shared = loadSharedCircuit();
  const [activeTab, setActiveTab] = useState<Tab>(shared ? 'builder' : 'algorithms');
  const [vizTab, setVizTab] = useState<VizTab>('probabilities');
  const [numQubits, setNumQubits] = useState(shared?.numQubits ?? 2);
  const [ops, setOps] = useState<GateOp[]>(shared?.ops ?? []);
  const [selectedAlgo, setSelectedAlgo] = useState<Algorithm | null>(ALGORITHMS[0]);
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const [noise, setNoise] = useState<NoiseModel>(NO_NOISE);

  const currentOps = useMemo(() => {
    if (activeTab === 'algorithms' && selectedAlgo) {
      if (stepIndex !== null) return selectedAlgo.ops.slice(0, stepIndex + 1);
      return selectedAlgo.ops;
    }
    return ops;
  }, [activeTab, selectedAlgo, ops, stepIndex]);

  const currentNumQubits = useMemo(() => {
    if (activeTab === 'algorithms' && selectedAlgo) return selectedAlgo.numQubits;
    return numQubits;
  }, [activeTab, selectedAlgo, numQubits]);

  const quantumState = useMemo(() => {
    const state = new QuantumState(currentNumQubits);
    for (const op of currentOps) {
      try { state.applyGate(op); } catch { /* skip invalid */ }
    }
    return state;
  }, [currentNumQubits, currentOps]);

  const handleAlgoSelect = useCallback((algo: Algorithm) => {
    setSelectedAlgo(algo);
    setStepIndex(null);
  }, []);

  const entropies = useMemo(() => {
    // Skip the O(2^n·…) eigensolves for very wide circuits (e.g. the 9-qubit Shor code).
    if (currentNumQubits < 2 || currentNumQubits > 6) return [];
    return Array.from({ length: currentNumQubits - 1 }, (_, i) =>
      quantumState.entanglementEntropy(i + 1)
    );
  }, [quantumState, currentNumQubits]);

  const maxEntropy = entropies.length > 0 ? Math.max(...entropies) : 0;

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #020617 0%, #0a0f1e 50%, #070d1f 100%)',
      color: '#e2e8f0',
      fontFamily: "'Inter', system-ui, sans-serif",
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 0,
        background: 'radial-gradient(ellipse at 20% 50%, rgba(124, 58, 237, 0.04) 0%, transparent 60%), radial-gradient(ellipse at 80% 20%, rgba(8, 145, 178, 0.04) 0%, transparent 60%)',
      }} />

      <header style={{
        position: 'relative',
        zIndex: 10,
        padding: '14px 20px',
        borderBottom: '1px solid rgba(30, 58, 95, 0.5)',
        background: 'rgba(2, 6, 23, 0.8)',
        backdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 34,
            height: 34,
            borderRadius: 8,
            background: 'linear-gradient(135deg, #7c3aed, #0891b2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            boxShadow: '0 0 20px rgba(124, 58, 237, 0.4)',
          }}>
            ⚛
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 800, letterSpacing: '-0.3px', color: '#f1f5f9' }}>
              Quantum Lab
            </h1>
            <p style={{ margin: 0, fontSize: 9, color: '#475569' }}>Interactive Quantum Circuit Simulator</p>
          </div>
        </div>

        <nav style={{ display: 'flex', gap: 2, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {(['builder', 'algorithms', 'shor', 'solovay', 'synth', 'shannon', 'distill', 'bell', 'deviceindep', 'metrology', 'mbqc', 'variational', 'stabilizer', 'surface', 'tensor', 'freefermion', 'dynamics', 'tests', 'about'] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '5px 11px',
                borderRadius: 6,
                border: 'none',
                background: activeTab === tab ? 'rgba(124, 58, 237, 0.3)' : 'transparent',
                color: activeTab === tab ? '#a78bfa' : '#64748b',
                fontSize: 11,
                fontWeight: activeTab === tab ? 700 : 400,
                cursor: 'pointer',
                textTransform: 'capitalize',
                transition: 'all 0.15s',
              }}
            >
              {tab === 'builder' ? '🔧 Builder' : tab === 'algorithms' ? '⚡ Algorithms'
                : tab === 'shor' ? '🔢 Shor'
                : tab === 'solovay' ? '🧭 Solovay–Kitaev'
                : tab === 'synth' ? '🔧 2-Qubit Synthesis'
                : tab === 'shannon' ? '🪜 n-Qubit Synthesis'
                : tab === 'distill' ? '💎 Distillation'
                : tab === 'bell' ? '🔔 Bell'
                : tab === 'deviceindep' ? '🛡️ Device-Indep'
                : tab === 'metrology' ? '📡 Metrology'
                : tab === 'mbqc' ? '🕹️ One-Way'
                : tab === 'variational' ? '🧬 Variational' : tab === 'stabilizer' ? '🧱 Stabilizer'
                : tab === 'surface' ? '🔲 Surface' : tab === 'tensor' ? '🕸️ Tensor'
                : tab === 'freefermion' ? '🪢 Free Fermion'
                : tab === 'dynamics' ? '🌀 Dynamics'
                : tab === 'tests' ? '🧪 Tests' : '📖 About'}
            </button>
          ))}
        </nav>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{
            padding: '2px 7px',
            background: 'rgba(124, 58, 237, 0.15)',
            border: '1px solid rgba(124, 58, 237, 0.3)',
            borderRadius: 4,
            fontSize: 10,
            color: '#a78bfa',
            fontFamily: 'monospace',
          }}>
            {currentNumQubits}q / {1 << currentNumQubits} states
          </span>
          <span style={{
            padding: '2px 7px',
            background: maxEntropy > 0.5 ? 'rgba(8, 145, 178, 0.15)' : 'rgba(30, 41, 59, 0.5)',
            border: `1px solid ${maxEntropy > 0.5 ? 'rgba(8, 145, 178, 0.4)' : '#1e293b'}`,
            borderRadius: 4,
            fontSize: 10,
            color: maxEntropy > 0.5 ? '#67e8f9' : '#475569',
            fontFamily: 'monospace',
          }}>
            {maxEntropy > 0.1 ? `S≈${maxEntropy.toFixed(2)} bits` : 'separable'}
          </span>
          {isNoiseActive(noise) && (
            <span style={{
              padding: '2px 7px',
              background: 'rgba(220, 38, 38, 0.15)',
              border: '1px solid rgba(220, 38, 38, 0.4)',
              borderRadius: 4,
              fontSize: 10,
              color: '#f87171',
              fontFamily: 'monospace',
            }}>
              ◉ noisy
            </span>
          )}
        </div>
      </header>

      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <AnimatePresence mode="wait">
          {PAGE_TABS.includes(activeTab) ? (
            <motion.div
              key={activeTab}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{ flex: 1, padding: '24px 32px', overflowY: 'auto' }}
            >
              {activeTab === 'about' && <AboutPage />}
              {activeTab === 'shor' && <ShorLab />}
              {activeTab === 'solovay' && <SolovayLab />}
              {activeTab === 'synth' && <SynthLab />}
              {activeTab === 'shannon' && <ShannonLab />}
              {activeTab === 'distill' && <DistillationLab />}
              {activeTab === 'bell' && <NonlocalityLab />}
              {activeTab === 'deviceindep' && <DeviceIndependentLab />}
              {activeTab === 'metrology' && <MetrologyLab />}
              {activeTab === 'mbqc' && <MBQCLab />}
              {activeTab === 'variational' && <VariationalLab />}
              {activeTab === 'stabilizer' && <StabilizerLab />}
              {activeTab === 'surface' && <SurfaceLab />}
              {activeTab === 'tensor' && <TensorLab />}
              {activeTab === 'freefermion' && <FreeFermionLab />}
              {activeTab === 'dynamics' && <DynamicsLab />}
              {activeTab === 'tests' && <TestsPanel />}
            </motion.div>
          ) : (
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.2 }}
              style={{
                flex: 1,
                display: 'grid',
                gridTemplateColumns: '1fr 340px',
                minHeight: 0,
                overflow: 'hidden',
              }}
            >
              <div style={{
                borderRight: '1px solid rgba(30, 58, 95, 0.4)',
                overflowY: 'auto',
                padding: 20,
              }}>
                <AnimatePresence mode="wait">
                  {activeTab === 'builder' ? (
                    <motion.div key="builder" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                      <SectionTitle>Circuit Builder</SectionTitle>
                      <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 16px' }}>
                        Drag gates from the palette onto the qubit wires. Click a gate to remove it.
                      </p>
                      <CircuitEditor
                        numQubits={numQubits}
                        onNumQubitsChange={setNumQubits}
                        ops={ops}
                        onOpsChange={setOps}
                      />
                    </motion.div>
                  ) : (
                    <motion.div key="algorithms" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                      <SectionTitle>Quantum Algorithms</SectionTitle>
                      <p style={{ color: '#475569', fontSize: 12, margin: '4px 0 12px' }}>
                        {ALGORITHMS.length} pre-built circuits demonstrating quantum advantage. Click to simulate and step through gate by gate.
                      </p>

                      {selectedAlgo && (
                        <motion.div
                          layout
                          style={{
                            marginBottom: 12,
                            padding: '10px 12px',
                            background: 'rgba(124, 58, 237, 0.08)',
                            border: '1px solid rgba(124, 58, 237, 0.2)',
                            borderRadius: 8,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                            <span style={{ fontSize: 11, fontWeight: 700, color: '#a78bfa' }}>
                              Step-through: {stepIndex !== null ? `gate ${stepIndex + 1}/${selectedAlgo.ops.length}` : 'full circuit'}
                            </span>
                            <div style={{ display: 'flex', gap: 3 }}>
                              <button
                                onClick={() => setStepIndex(null)}
                                style={stepBtnStyle(stepIndex === null)}
                              >All</button>
                              {selectedAlgo.ops.map((_, i) => (
                                <button key={i} onClick={() => setStepIndex(i)} style={stepBtnStyle(stepIndex === i)}>
                                  {i + 1}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                            {selectedAlgo.ops.map((op, i) => {
                              const isActive = stepIndex === null || i <= (stepIndex ?? -1);
                              return (
                                <span key={i} style={{
                                  padding: '2px 6px',
                                  borderRadius: 3,
                                  fontSize: 10,
                                  fontFamily: 'monospace',
                                  background: isActive ? 'rgba(124, 58, 237, 0.2)' : 'rgba(255,255,255,0.03)',
                                  color: isActive ? '#a78bfa' : '#374151',
                                  border: `1px solid ${isActive ? 'rgba(124,58,237,0.3)' : 'transparent'}`,
                                  transition: 'all 0.2s',
                                }}>
                                  {op.name} q{op.qubits.join(',')}
                                </span>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}

                      <AlgorithmPanel selectedAlgo={selectedAlgo} onSelect={handleAlgoSelect} />
                    </motion.div>
                  )}
                </AnimatePresence>

                <ExportPanel
                  numQubits={currentNumQubits}
                  ops={currentOps}
                  name={activeTab === 'algorithms' ? selectedAlgo?.name : 'custom-circuit'}
                />
              </div>

              <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                <div style={{
                  display: 'flex',
                  borderBottom: '1px solid rgba(30, 58, 95, 0.4)',
                  background: 'rgba(2, 6, 23, 0.4)',
                  flexShrink: 0,
                }}>
                  {(['probabilities', 'state', 'bloch', 'density', 'measure'] as VizTab[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => setVizTab(t)}
                      style={{
                        padding: '8px 10px',
                        border: 'none',
                        borderBottom: `2px solid ${vizTab === t ? '#7c3aed' : 'transparent'}`,
                        background: 'transparent',
                        color: vizTab === t ? '#a78bfa' : '#475569',
                        fontSize: 10,
                        fontWeight: vizTab === t ? 700 : 400,
                        cursor: 'pointer',
                        textTransform: 'capitalize',
                      }}
                    >
                      {t === 'probabilities' ? '📊' : t === 'state' ? '🌊' : t === 'bloch' ? '🌐' : t === 'density' ? '🌫️' : '⚡'} {t}
                    </button>
                  ))}
                </div>

                <div style={{ flex: 1, padding: 14, overflowY: 'auto' }}>
                  <AnimatePresence mode="wait">
                    {vizTab === 'probabilities' && (
                      <motion.div key="prob" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                        <SectionTitle>Measurement Probabilities</SectionTitle>
                        <ProbabilityChart state={quantumState} />
                        <EntanglementInfo entropies={entropies} numQubits={currentNumQubits} />
                      </motion.div>
                    )}
                    {vizTab === 'state' && (
                      <motion.div key="sv" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                        <SectionTitle>State Vector</SectionTitle>
                        <p style={{ color: '#475569', fontSize: 11, margin: '4px 0 10px' }}>
                          Complex amplitudes — bar width = probability, color = phase.
                        </p>
                        <StateVector state={quantumState} />
                        <SchmidtPanel state={quantumState} numQubits={currentNumQubits} />
                      </motion.div>
                    )}
                    {vizTab === 'bloch' && (
                      <motion.div key="bloch" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                        <SectionTitle>Bloch Spheres</SectionTitle>
                        <p style={{ color: '#475569', fontSize: 11, margin: '4px 0 12px' }}>
                          Reduced single-qubit states. Drag to orbit. r&lt;1 = mixed/entangled.
                        </p>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                          {Array.from({ length: currentNumQubits }, (_, q) => {
                            const bv = quantumState.blochVector(q);
                            const r = Math.sqrt(bv[0] ** 2 + bv[1] ** 2 + bv[2] ** 2);
                            return (
                              <div key={q} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                                <BlochSphere blochVector={bv} qubitIndex={q} />
                                <div style={{ fontSize: 9, color: '#64748b', fontFamily: 'monospace', textAlign: 'center' }}>
                                  r={r.toFixed(2)} {r < 0.95 ? '(mixed)' : '(pure)'}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </motion.div>
                    )}
                    {vizTab === 'density' && (
                      <motion.div key="density" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                        <SectionTitle>Density Matrix & Noise</SectionTitle>
                        <DensityLab numQubits={currentNumQubits} ops={currentOps} noise={noise} onNoiseChange={setNoise} />
                      </motion.div>
                    )}
                    {vizTab === 'measure' && (
                      <motion.div key="measure" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                        <SectionTitle>Quantum Measurement</SectionTitle>
                        <MeasurementPanel state={quantumState} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function stepBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '2px 6px',
    borderRadius: 3,
    border: `1px solid ${active ? '#7c3aed' : '#1e293b'}`,
    background: active ? 'rgba(124,58,237,0.2)' : 'rgba(255,255,255,0.02)',
    color: active ? '#a78bfa' : '#475569',
    fontSize: 9,
    cursor: 'pointer',
    fontFamily: 'monospace',
    minWidth: 20,
  };
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{
      margin: '0 0 8px',
      fontSize: 11,
      fontWeight: 700,
      color: '#475569',
      textTransform: 'uppercase',
      letterSpacing: '0.1em',
    }}>
      {children}
    </h2>
  );
}

function SchmidtPanel({ state, numQubits }: { state: QuantumState; numQubits: number }) {
  if (numQubits < 2 || numQubits > 6) return null;
  const cut = Math.floor(numQubits / 2);
  const sd = schmidtDecompose(state, cut);
  const maxW = Math.max(...sd.weights, 1e-9);
  return (
    <div style={{
      marginTop: 14,
      padding: '10px 12px',
      background: 'rgba(124, 58, 237, 0.05)',
      border: '1px solid rgba(124, 58, 237, 0.15)',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Schmidt decomposition · q0…{cut - 1} | q{cut}…{numQubits - 1}
        </div>
        <span style={{ fontSize: 9, color: '#64748b', fontFamily: 'monospace' }}>
          rank {sd.rank}/{sd.maxRank} · S={sd.entropy.toFixed(3)}
        </span>
      </div>
      {sd.coefficients.filter((c) => c > 1e-6).slice(0, 8).map((c, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 46px', gap: 6, alignItems: 'center', marginBottom: 3 }}>
          <span style={{ fontSize: 9, color: '#64748b', fontFamily: 'monospace' }}>λ{i + 1}</span>
          <div style={{ height: 7, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(sd.weights[i] / maxW) * 100}%`, background: 'linear-gradient(90deg, #7c3aed, #67e8f9)', borderRadius: 2, transition: 'width 0.4s ease' }} />
          </div>
          <span style={{ fontSize: 9, color: '#a78bfa', fontFamily: 'monospace', textAlign: 'right' }}>{c.toFixed(3)}</span>
        </div>
      ))}
      <div style={{ marginTop: 6, fontSize: 9, color: '#334155' }}>
        |ψ⟩ = Σ λᵢ|aᵢ⟩|bᵢ⟩. Schmidt rank 1 ⇔ a product state across the cut; rank &gt; 1 ⇔ entangled.
      </div>
    </div>
  );
}

function EntanglementInfo({ entropies, numQubits }: { entropies: number[]; numQubits: number }) {
  if (numQubits < 2) return null;
  return (
    <div style={{
      marginTop: 14,
      padding: '10px 12px',
      background: 'rgba(8, 145, 178, 0.05)',
      border: '1px solid rgba(8, 145, 178, 0.15)',
      borderRadius: 8,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#0891b2', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Entanglement Entropy
      </div>
      {entropies.map((s, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 42px', gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: '#64748b', fontFamily: 'monospace' }}>q0…{i} | {i + 1}…</span>
          <div style={{ height: 7, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.min(100, (s / Math.max(numQubits, 1)) * 100)}%`,
              background: 'linear-gradient(90deg, #0891b2, #7c3aed)',
              borderRadius: 2,
              transition: 'width 0.4s ease',
            }} />
          </div>
          <span style={{ fontSize: 9, color: '#0891b2', fontFamily: 'monospace', textAlign: 'right' }}>
            {s.toFixed(3)}
          </span>
        </div>
      ))}
      <div style={{ marginTop: 6, fontSize: 9, color: '#334155' }}>
        Von Neumann entropy S = -Tr(ρ log₂ ρ). S=0 separable, S=1 maximally entangled (Bell state).
      </div>
    </div>
  );
}

function AboutPage() {
  return (
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} style={{ marginBottom: 28 }}>
        <h2 style={{
          fontSize: 26,
          fontWeight: 800,
          margin: '0 0 8px',
          background: 'linear-gradient(135deg, #a78bfa, #67e8f9)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}>
          Quantum Lab
        </h2>
        <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.7, margin: 0 }}>
          A full quantum circuit simulator running entirely in your browser. No server, no Python, no Qiskit — pure TypeScript.
        </p>
      </motion.div>

      {[
        {
          title: 'State Vector Simulation',
          content: 'The quantum state is represented as a complex amplitude vector of 2ⁿ entries for n qubits. Gates are applied as unitary matrix operations via tensor products. Measurement follows the Born rule: outcomes are sampled proportional to |amplitude|².',
        },
        {
          title: 'Quantum Engine (from scratch)',
          content: 'Built entirely from scratch in TypeScript: Complex number arithmetic, sparse tensor gate application, state vector simulation supporting up to 6 qubits (64 amplitudes). Includes 15+ gates: H, X, Y, Z, S, T, Rx, Ry, Rz, Phase, CNOT, CZ, SWAP, Toffoli, Fredkin, CPhase.',
        },
        {
          title: 'Quantum Algorithms',
          content: 'Deutsch-Jozsa (exponential oracle speedup), Grover\'s Search Algorithm (√N quadratic speedup), Quantum Fourier Transform (core of Shor\'s factoring), Bernstein-Vazirani (linear speedup), Simon\'s Period-Finding, Bell states, GHZ/W states, Quantum Teleportation.',
        },
        {
          title: 'Visualizations',
          content: 'Probability histograms, state vector amplitude/phase display (phase encoded as hue), Bloch sphere per qubit via Three.js (reduced density matrix via partial trace), bipartite von Neumann entanglement entropy, and Monte Carlo measurement sampling.',
        },
        {
          title: 'Bloch Sphere Physics',
          content: 'The Bloch sphere maps any single-qubit state to a unit sphere. |0⟩ = north pole, |1⟩ = south pole, |+⟩ = +x axis. Superpositions live on the surface (r=1, pure state). For entangled qubits, the reduced state becomes mixed — the point moves inside the sphere (r<1).',
        },
        {
          title: 'Entanglement Entropy',
          content: 'The bipartite entanglement entropy S = -Tr(ρ_A log₂ ρ_A) is computed for every contiguous bipartition via an exact Hermitian eigensolver (a complex cyclic-Jacobi diagonaliser written from scratch). S=0 means separable; S=1 means maximally entangled (a Bell pair).',
        },
        {
          title: 'Open Systems & Noise (Density Matrix)',
          content: 'Beyond pure states, the lab simulates open quantum systems with a full density-matrix engine: ρ evolves as ρ → UρU† under gates and ρ → Σ KρK† under Kraus noise channels — depolarizing, amplitude/phase damping, and bit/phase flips. Watch the purity Tr(ρ²) drop and Bloch vectors retract inside the sphere as decoherence sets in.',
        },
        {
          title: 'Stabilizer Engine (Gottesman–Knill)',
          content: 'A second simulation paradigm: the Aaronson–Gottesman stabilizer tableau tracks a Clifford state by its n Pauli generators instead of 2ⁿ amplitudes, so H/S/Pauli/CNOT/CZ/SWAP circuits run in polynomial time — a 30-qubit GHZ state is instant. The Stabilizer tab reads off the generators live (GHZ → +XX…X, +ZᵢZᵢ₊₁), with a memory comparison the state vector cannot win.',
        },
        {
          title: 'Quantum Error Correction',
          content: 'The 3-qubit bit-flip and phase-flip codes and the 9-qubit Shor code reversibly correct single-qubit errors via majority-vote (Toffoli) decoders. The Steane [[7,1,3]] CSS code goes further with live syndrome decoding on the stabilizer tableau: inject any single-qubit Pauli error and watch the 3-bit Hamming syndrome pinpoint and correct it — verified across all 21 errors.',
        },
        {
          title: 'Variational Algorithms (VQE & QAOA)',
          content: 'A hybrid quantum-classical loop: the simulator is the "QPU" and a from-scratch optimizer tunes circuit angles. VQE finds the ground-state energy of a transverse-field Ising Hamiltonian via BOTH derivative-free Nelder–Mead and exact analytic parameter-shift gradient descent (the method real hardware uses), matching exact diagonalization; QAOA solves MaxCut on small graphs.',
        },
        {
          title: 'Randomized Benchmarking & Schmidt',
          content: 'Randomized benchmarking sends random Clifford sequences through a noise channel and fits the survival-probability decay p(m)=½+A·fᵐ to extract the average gate fidelity — immune to SPAM errors. The Schmidt decomposition factorises any bipartite state |ψ⟩=Σλᵢ|aᵢ⟩|bᵢ⟩, exposing the Schmidt rank and the spectrum behind the entanglement entropy.',
        },
        {
          title: 'Tensor Networks (Matrix Product States & TEBD)',
          content: 'A fourth simulation paradigm: a Matrix Product State writes |ψ⟩ as a chain of rank-3 tensors whose bond dimension χ is the Schmidt rank across each cut. Bounded-entanglement states (GHZ, cluster/graph states, shallow circuits, gapped 1-D ground states) keep χ small, so the MPS stores them in O(n·χ²) numbers and runs gates in O(χ³) — reaching 40+ qubits the 2ⁿ vector can never hold. Two-qubit gates re-split via a from-scratch complex SVD truncated to χ, with the discarded Schmidt weight reported exactly. The Tensor tab also runs TEBD: a real-time transverse-field-Ising quench that shows entanglement spreading linearly in a correlation light-cone — matched to exact dynamics on small chains.',
        },
        {
          title: 'DMRG — Variational Ground States (MPO + Lanczos)',
          content: 'The Density Matrix Renormalization Group, the workhorse of 1-D many-body physics, built from scratch on the same tensor-network engine. The Hamiltonian is encoded as a Matrix Product Operator (the operator analogue of an MPS — bond dimension 3 for the Ising chain, 5 for Heisenberg/XXZ, independent of length). DMRG sweeps the chain fusing two sites into a wavefunction, builds the effective Hamiltonian from the contracted environments and finds its lowest eigenpair with a matrix-free Lanczos iteration, then re-splits with a truncated SVD. The energy descends to the variational minimum — matching exact diagonalisation of the same operator to machine precision on small chains — while the energy variance ⟨H²⟩−⟨H⟩², from a double-layer MPO contraction, goes to zero: the basis-independent certificate that the state really is an eigenstate, at chain lengths a 2ⁿ vector could never diagonalise. Scanning a model parameter then traces a quantum phase transition: the ground-state entanglement entropy peaks exactly where the gap closes (the Ising critical field h=1; the gapless XXZ critical line −1<Δ<1).',
        },
        {
          title: 'Surface Code & MWPM Decoding (Topological QEC)',
          content: 'The surface code — the leading architecture for fault-tolerant quantum computing — built from scratch with a real decoder. The rotated planar [[d²,1,d]] code lays one logical qubit across a d×d lattice of data qubits protected by d²−1 weight-≤4 stabilizer checks; a local error lights up a pair of checks, and the decoder must infer the hidden error chain. That inference is Minimum-Weight Perfect Matching, solved here by a faithful from-scratch implementation of Edmonds\' blossom algorithm (Galil\'s O(V³) primal-dual matching) — there is no reduction of general-graph matching to flow, so blossoms (odd alternating cycles) are contracted on the fly. Interactively inject X or Z errors on any lattice and watch the checks fire, the matching form, and the residual be classified as a harmless stabilizer or a logical failure. A Monte-Carlo sweep then reproduces the hallmark of a working code — an error-correction threshold near 10.3%, below which more qubits suppress the logical error rate and above which they amplify it, the distance-d curves all crossing at p_th.',
        },
        {
          title: 'Fault Tolerance in Space-Time (Phenomenological Noise + Union-Find)',
          content: 'Real hardware measures the stabilizers repeatedly, and each measurement is itself noisy — so a single bad readout is indistinguishable from a data error that flickers on for one round. The fix is to decode in space-time: stack T noisy syndrome rounds into a 3-D matching graph whose time edges absorb measurement errors while space edges absorb data errors, with a detection event wherever the syndrome changes between rounds. Both the optimal MWPM decoder and a from-scratch Union-Find decoder (Delfosse–Nivelle — near-linear-time cluster growth + a peeling decoder, provably correct up to the code distance) run on this graph. The phenomenological threshold (~3%, well below the 10.3% code-capacity figure) is reproduced, the two decoders are cross-checked, and the finite-size data is distilled two ways: the suppression factor Λ = p_L(d)/p_L(d+2) > 1 of a working code, and a universal data collapse that fits (p_th, ν) by folding every distance/error-rate curve onto one scaling function.',
        },
        {
          title: 'Free Fermions — the Exactly-Solvable TFIM (Jordan–Wigner + Bogoliubov)',
          content: 'The transverse-field Ising chain is secretly free: the Jordan–Wigner transform maps the spins onto non-interacting fermions, turning the 2ⁿ problem into a quadratic Hamiltonian that diagonalises EXACTLY in O(n³). The Lieb–Schultz–Mattis solution is, remarkably, just a singular-value decomposition of an n×n matrix — so the lab\'s from-scratch complex SVD does the work, giving the Bogoliubov single-particle spectrum and the ground energy E₀ = −½ΣΛ_k. This is an exact oracle: it reproduces the lab\'s own TFIM ground energy from exact diagonalisation and DMRG to machine precision, and then runs far past them — to hundreds of sites. The quasiparticle gap 2|J−h| closes at the quantum critical point h=J, where the half-chain entanglement peaks. Block entanglement comes from the ground state\'s Majorana covariance matrix (Peschel), and a Calabrese–Cardy fit of S(L) reads off the Ising-CFT central charge c=½ — the universal number naming the universality class — straight from the entanglement of an exactly-solved critical chain. The ground energy per site matches the closed-form Pfeuty thermodynamic integral. And a real-time quench (ground state at h_i, evolved under h_f) stays Gaussian forever, so its fermionic correlation matrices evolve in O(n³) per step — reproducing the entanglement light-cone (linear growth then saturation) at sizes whose Schmidt rank 2^S no MPS or exact simulator could ever store, with every small-n step checked against exact dense time evolution.',
        },
        {
          title: 'Dynamical Quantum Phase Transitions & the XY Model',
          content: 'The free-fermion engine, generalised to the anisotropic XY chain (the Ising point is γ=1) and solved in momentum space with periodic boundaries, makes the headline non-equilibrium phenomenon of the last decade exactly tractable. Quench the field across the critical point and the Loschmidt return-rate function l(t) = −lim (1/N) ln|⟨ψ₀|e^{−iH_f t}|ψ₀⟩|² develops non-analytic cusps in real time — a dynamical quantum phase transition (Heyl–Polkovnikov–Kehrein), the dynamical analogue of a free-energy singularity, where Fisher zeros of the boundary partition function cross the time axis at the critical times tₙ*=(2n+1)π/εₖ*. An integer dynamical topological order parameter ν_D(t) — the winding of the Pancharatnam geometric phase across the Brillouin zone (Budich–Heyl) — is 0 before the first cusp and jumps by exactly +1 at each one. Everything is cross-checked to machine precision against an independent dense 2ⁿ time evolution. The Free-Fermion lab also gains the XY phase diagram (the Ising line h=1 and the anisotropy line γ=0) and the exact mutual information between disjoint blocks, which decays exponentially off-criticality and algebraically at h=1.',
        },
        {
          title: "Shor's Algorithm — Factoring by Order-Finding",
          content: "The result that launched quantum computing, built from scratch end to end: factoring an integer N into its prime factors. Shor's insight is that factoring reduces to ORDER-FINDING — find the period r of x ↦ a·x mod N for a random base a, and gcd(a^(r/2) ± 1, N) are real factors. The period is found quantumly by phase-estimating the eigenphase s/r of the modular-multiplication unitary, then recovering r from the measured s/r with a continued-fraction expansion. The lab builds the genuine circuit two independent ways — a full (n+t)-qubit register with t controlled modular multipliers + an inverse QFT, and the hardware-friendly iterative variant that recycles a single ancilla measured bit-by-bit with classical feedback — and grades both against an exact closed-form Dirichlet-kernel distribution to machine precision. The Shor tab actually factors 15, 21, 33, 35… live: watch the random base chosen, the order-finding spectrum peak at the rationals k/r, the continued fraction reconstruct r, and the factor tree resolve.",
        },
        {
          title: 'Nonlocality, Bell Tests & Quantum Pseudo-telepathy',
          content: "Quantum mechanics does not merely compute faster — it describes a genuinely non-classical world, and this pillar makes that precise, all on the exact state-vector engine. (1) THE CHSH INEQUALITY: Alice and Bob each choose one of two ±1 observables A(θ)=cosθ·Z+sinθ·X on a shared Bell pair, forming the correlator E(a,b)=⟨ψ|A(a)⊗B(b)|ψ⟩ (computed by expanding the tensor product into the four Pauli terms ZZ,ZX,XZ,XX). The Bell quantity S=E(a,b)+E(a,b′)+E(a′,b)−E(a′,b′) can never exceed 2 in ANY local-hidden-variable theory (Bell 1964 / CHSH 1969) — yet the Bell state reaches S=2√2≈2.828, TSIRELSON'S BOUND. A from-scratch Nelder–Mead maximiser rediscovers the optimum, a Monte-Carlo certificate shows thousands of random qubit strategies never exceed 2√2 (the bound is a ceiling, not a coincidence), and the live S(θ) sweep plots the violation against the classical band. Reframed as the CHSH game (referee sends x,y; players win iff a⊕b=x∧y), the dictionary p=(S+4)/8 turns this into a strict quantum advantage: cos²(π/8)≈85.4% vs the classical 75%, with no communication. (2) THE GHZ / MERMIN GAME — quantum PSEUDO-TELEPATHY: three players sharing |GHZ⟩ answer a⊕b⊕c=x∨y∨z (for questions with x⊕y⊕z=0) and win EVERY time by measuring X for input 0 and Y for input 1; the Mermin correlations ⟨XXX⟩=+1, ⟨XYY⟩=⟨YXY⟩=⟨YYX⟩=−1 (verified on the engine) force a perfect win, while a brute force over all 64 classical strategies caps at 3/4 — multiplying the four win constraints yields 0=1, a parity contradiction proving no classical strategy can be perfect. (3) THE MERMIN–PERES MAGIC-SQUARE GAME: a 3×3 grid of two-qubit Pauli observables whose every row multiplies to +I and every column to +I except the last (−I). The whole operator algebra is verified from scratch on 4×4 matrices — each cell is an involutory (±1-valued) Hermitian observable, the three cells of any row/column mutually commute (jointly measurable), and the product identities hold exactly — and the product-of-everything parity (+1 by rows, −1 by columns) is the certificate bounding classical play at 8/9. Two shared Bell pairs let quantum players win all 81 questions with certainty: on |Φ⁺⟩⊗|Φ⁺⟩ all nine shared cells correlate at exactly +1 (the entangled-state identity (M⊗I)|Ω⟩=(I⊗Mᵀ)|Ω⟩), verified by an explicit 4-qubit simulation. (4) MERMIN–KLYSHKO — nonlocality that grows exponentially with size: the n-party generalisation of CHSH, the Mermin polynomial Mₙ built by the recursion Mₙ=½[Mₙ₋₁(Aₙ+Aₙ′)+M′ₙ₋₁(Aₙ−Aₙ′)], obeys |⟨Mₙ⟩|≤1 in every LHV theory but the n-qubit GHZ state reaches 2^((n−1)/2) — so unlike CHSH's fixed 2√2 ceiling, the quantum-over-classical ratio doubles every two parties (22.6× at n=10). The quantum values are read off the engine (the Mermin operator on |GHZₙ⟩ with the optimal X–Y plane settings) and the LHV bound 1 is brute-forced over all 2²ⁿ deterministic assignments. Every headline number is proven to machine precision in the Tests tab.",
        },
        {
          title: 'Device-Independent Quantum Information (NPA SDP, SOS, Randomness, Steering, Eberhard)',
          content: "The device-independent pillar turns nonlocality into a resource and a security primitive — trust NOTHING about the boxes' internal physics, only the observed statistics, and still prove things. Its centrepiece is a from-scratch SEMIDEFINITE-PROGRAMMING solver (the workhorse of modern quantum information), built on the lab's own Jacobi eigensolver: a Burer–Monteiro low-rank primal over the elliptope plus an eigenvalue-penalised dual. With it the NAVASCUÉS–PIRONIO–ACÍN hierarchy (level 1) computes Tsirelson's bound S ≤ 2√2 as a CERTIFIED CEILING — the moment matrix Γ of operator inner products is necessarily PSD, so maximising the Bell functional over Γ ⪰ 0, diag = 1 upper-bounds EVERY quantum strategy in any dimension (where 15.0's Monte-Carlo only sampled qubit strategies, this proves the ceiling); the primal and dual both land on 2√2 with a vanishing duality gap. An independent, basis-independent OPERATOR SUM-OF-SQUARES certificate 2√2·I − S = (1/√2)(u²+v²) is verified to be the exact zero matrix, a second proof needing no numerics. Then the consequences: DEVICE-INDEPENDENT RANDOMNESS, where an observed S certifies P_guess = ½ + ½√(2−S²/4) against any adversary who built the devices, so the min-entropy rises from 0 bits at S=2 to 1 full bit at 2√2; EPR STEERING, the asymmetric middle of the hierarchy, with the steering ellipsoid (Jevtic et al.) drawn live and the CJWR inequalities S_n = (1/√n)|Σ⟨AₖBₖ⟩| ≤ 1 violated up to S₂=√2, S₃=√3 with the Werner critical visibility w > 1/√n; the DETECTION LOOPHOLE, where the maximally-entangled CH threshold is η > 2(√2−1) ≈ 82.8% but Eberhard's non-maximally-entangled states push it toward 2/3 ≈ 66.7% (computed by minimising the per-configuration η* = M/Q over measurements); and the POPESCU–ROHRLICH box, the no-signalling correlation reaching the algebraic maximum S = 4, placing quantum theory's 2√2 strictly between the local bound 2 and what causality alone permits. Every headline number — the SDP primal=dual=2√2, the SOS residual ~1e-16, the randomness endpoints, S₃=√3, the Eberhard threshold, the PR box's S=4 and no-signalling — is proven to machine precision in the Tests tab.",
        },
        {
          title: 'Quantum Metrology & Sensing (Fisher Information, the Heisenberg Limit, Huelga)',
          content: "The third great application of entanglement, alongside computing and cryptography: measuring better. A phase θ imprinted by U(θ) = e^{−iθG} is estimated with an uncertainty bounded below by the QUANTUM CRAMÉR–RAO BOUND Δθ ≥ 1/√(ν·F_Q), where the QUANTUM FISHER INFORMATION F_Q — built here from scratch — is the most information ANY measurement could extract. For a pure probe F_Q = 4·Var(G); the lab anchors everything on the collective generator G = J_z = ½ΣZᵢ so every number is an exact rational. N independent |+⟩ probes give F_Q = N — the STANDARD QUANTUM LIMIT, Δθ ∝ 1/√N — while an N-qubit GHZ cat (|0…0⟩+|1…1⟩)/√2 accumulates phase N times faster for F_Q = N², the HEISENBERG LIMIT Δθ ∝ 1/N: a genuine √N quantum advantage with no classical analogue, the principle behind LIGO's squeezed light and optical atomic clocks. The general open-system case is handled by the SLD formula F_Q = 2Σ|⟨i|∂_θρ|j⟩|²/(λᵢ+λⱼ) on an eigendecomposition of ρ (the lab's Jacobi eigensolver), verified to reduce to 4·Var(G) on pure states. The bound is shown to be ATTAINABLE: measuring the parity X^⊗N gives ⟨X^⊗N⟩ = cos(Nθ) whose classical Fisher information saturates F_C = N² = F_Q at every phase, whereas measuring Z^⊗N — the eigenbasis of the very generator being estimated — extracts exactly F_C = 0, and F_C ≤ F_Q holds everywhere (the quantum Cramér–Rao ordering). The honest punchline is fragility: under independent dephasing λ the cat's single global coherence decays as (1−λ)^N, so F_Q(GHZ) = N²(1−λ)^N rises then collapses below the product probe's F_Q(product) = N(1−λ) past a critical N — the Huelga et al. (1997) result that the Heisenberg advantage is erased by Markovian noise, the reason real metrology turned to robust spin-squeezing rather than fragile cat states — which the lab now BUILDS: the Kitagawa–Ueda one-axis-twisting Hamiltonian H = χ·J_z² acting on a coherent spin state, the collective spin operators J_a = ½Σσ_a applied to the 2^N vector, the full spin covariance and the WINELAND parameter ξ²_R = N·(ΔJ⊥min)²/|⟨J⟩|², with a Husimi-Q quasiprobability that shows the noise blob shear on the Bloch sphere. Twisting conserves the Casimir ⟨J²⟩=(N/2)(N/2+1) (the state stays in the symmetric Dicke manifold), gives genuine sub-SQL squeezing ξ²<1 bounded by 1/ξ²≤N, and deepens with N along the ξ²∝N^−2/3 law — a noise-robust advantage where the GHZ cat had none. Every headline number is proven to machine precision in the Tests tab.",
        },
        {
          title: 'Solovay–Kitaev — Compiling to a Fault-Tolerant Gate Set',
          content: "A real fault-tolerant machine cannot apply an arbitrary rotation — it has only a discrete instruction set it can run cheaply and transversally: the Clifford gates plus the non-Clifford T = diag(1, e^{iπ/4}). The Clifford gates alone are classically simulable (the Gottesman–Knill theorem — exactly the lab's stabilizer engine), but adding T makes {H,T} dense in SU(2). The Solovay–Kitaev algorithm, built here from scratch, compiles ANY single-qubit gate into a word over {H,T,T†,S,S†,X,Y,Z} approximating it to precision ε with only O(log^c(1/ε)) gates. It works by a recursion: a precomputed ε₀-net of short words gives a crude base approximation, then the leftover error Δ = U·U_{n−1}† (a small rotation near the identity) is written as a BALANCED GROUP COMMUTATOR Δ = V W V† W† — via the Dawson–Nielsen construction using only rotations and axis–angle algebra, no eigensolver — whose factors V, W are √-closer to the identity, and V and W are themselves approximated recursively. The error contracts super-linearly, ε_n ≈ c·ε_{n−1}^{3/2}, so depth 3–5 reaches 10⁻³ to 10⁻⁶. The Solovay–Kitaev tab compiles a target you choose (a Rz(θ) slider or famous gates like V=√X), reports the error, gate count and the all-important T-count (the costly non-Clifford resource each compiled word consumes), shows the compiled word itself, and sweeps the recursion depth to plot the convergence law on a log scale. Verified to machine precision: every compiled word multiplied back out in genuine U(2) reproduces its target up to a global phase, the group-commutator identity holds to ~1e-13, and the error/length scaling follows the Solovay–Kitaev theorem.",
        },
        {
          title: 'Magic-State Distillation — Manufacturing the T Gate',
          content: "The partner of Solovay–Kitaev. SK tells you the T-count of a computation, but the T gate cannot be applied transversally on a fault-tolerant code — each one must be teleported in from a magic state |T⟩ = (|0⟩ + e^{iπ/4}|1⟩)/√2 prepared offline, and offline preparation is noisy. Magic-state distillation, built here from scratch, turns many low-fidelity copies into fewer high-fidelity ones using only Clifford gates and post-selection. The workhorse is the Bravyi–Kitaev 15-to-1 routine on the [[15,1,3]] punctured Reed–Muller code (the code that admits a transversal T). Its error analysis reduces exactly to the classical [15,11,3] Hamming code: a noisy |T⟩ carries a phase (Z) error with probability p; the routine post-selects on a trivial X-syndrome (the error must be a Hamming codeword) and the surviving error is a logical fault iff it is an odd-weight codeword. Because the Hamming code has distance 3 with exactly 35 weight-3 codewords, the output error obeys the celebrated cubic law p_out = 35 p³ — below a threshold p* ≈ 14.2% the output is cleaner than the input, so cascading the routine drives the error toward zero doubly-exponentially (the exponent triples each round) at a cost of 15^r raw states per output. The Distillation tab sweeps the input rate against the exact output (summed over all 2¹¹ Hamming codewords), shows the suppression curve crossing the break-even line at the threshold, plots the weight enumerator with its 35 weight-3 logicals highlighted, runs the cascade, and cross-checks the exact enumeration against a Monte-Carlo of the post-selected protocol.",
        },
        {
          title: 'Two-Qubit Synthesis & the KAK Decomposition (compiling any gate to CNOTs)',
          content: "The partner of Solovay–Kitaev, lifted to two qubits. A real machine has no \"arbitrary U(4)\" instruction — only single-qubit rotations and ONE entangler, the CNOT. The structure theorem that makes universal compilation possible is the KAK (Cartan) decomposition of SU(4), built here from scratch: every two-qubit gate factors as U = e^{iφ}(A₀⊗A₁)·exp(i(cx XX + cy YY + cz ZZ))·(B₀⊗B₁) — a layer of single-qubit gates, a purely non-local interaction fixed by three numbers (cx,cy,cz), and another single-qubit layer. The recovery is the magic-basis trick (Kraus–Cirac/Makhlin): in the Bell basis a single-qubit pair becomes a REAL orthogonal matrix and the interaction becomes diagonal, so U is O₁·F·O₂ with O₁,O₂ ∈ SO(4) — extracted by a real SIMULTANEOUS DIAGONALISATION of the commuting real and imaginary parts of ŨŨᵀ (robust even when eigenvalues coincide, as they do for CNOT and iSWAP). The triple (cx,cy,cz) is a complete local invariant living in the Weyl chamber, and it dictates the geometric MINIMUM number of CNOTs: 0 (local), 1 (the CNOT corner), 2 (the cz=0 face — iSWAP, √iSWAP, the Berkeley B gate), or 3 (the interior — SWAP, √SWAP, a generic gate). The canonical interaction is realised by the optimal three-CNOT Cartan circuit (Vatan–Williams) whose rotation angles are read straight off (cx,cy,cz), and the whole gate is synthesised into {Rz, Ry, CNOT} reproducing it to ~1e-12. Then the fault-tolerant step closes the loop with the lab's Solovay–Kitaev engine: every single-qubit gate is compiled into a discrete {H,T,…} word, so an arbitrary two-qubit gate becomes a real {H,T,CNOT} circuit with a total T-count — the magic-state budget. The 2-Qubit Synthesis tab decomposes CNOT/CZ/iSWAP/√iSWAP/√SWAP/SWAP/the B gate/a random SU(4) (or a custom interaction), plots its address in the Weyl-chamber tetrahedron, shows the Makhlin local invariants G₁,G₂, draws the synthesised circuit, and compiles the fault-tolerant version live. Verified to machine precision: reconstruction over hundreds of random gates, the recovered coordinates matching the input class, the locality of both layers, the optimal CNOT counts of the named gates, and the end-to-end fault-tolerant circuit.",
        },
        {
          title: 'n-Qubit Synthesis — the Quantum Shannon Decomposition (compiling ANY gate)',
          content: "The capstone of the lab's compilation story: having synthesised one qubit (Solovay–Kitaev) and two (the KAK decomposition), the Quantum Shannon Decomposition (Shende–Bullock–Markov) does ANY number of qubits, built here from scratch. The structure theorem is the COSINE–SINE DECOMPOSITION: partition a 2ⁿ×2ⁿ unitary by its top qubit into four 2ⁿ⁻¹ blocks, and it factors as U = diag(L0,L1)·[[C,−S],[S,C]]·diag(R0†,R1†) — two block-diagonal 'quantum multiplexors' (controlled by the top qubit) sandwiching a central [[C,−S],[S,C]] that is exactly a uniformly-controlled Rʏ on the top qubit, with C=cos θ, S=sin θ. The CSD is recovered from two block SVDs (via the lab's Hermitian eigensolver on the Gram matrix) plus an orthonormal completion; cos²+sin²=1 and every block stays unitary. Each multiplexor diag(A,B) then DEMULTIPLEXES: diag(A,B) = (I⊗V)·(uniformly-controlled R_z)·(I⊗W) where V and the rotation angles come from the EIGENDECOMPOSITION OF A UNITARY matrix A·B† — itself new machinery, built by simultaneously diagonalising the two commuting Hermitian parts (W+W†)/2 and (W−W†)/2i, robust through the repeated eigenvalues of structured gates. That leaves two (n−1)-qubit gates V,W applied unconditionally to the lower wires — recurse — and three uniformly-controlled rotations, each lowered to the OPTIMAL 2ⁿ⁻¹ CNOTs via the Gray-code / Walsh–Hadamard angle transform (Möttönen et al.). The base case n=1 is the ZYZ Euler decomposition. The whole synthesis reproduces any gate to machine precision (~1e-11 at 5 qubits) at exactly (¾)·4ⁿ − 3·2ⁿ⁻¹ CNOTs — 6, 36, 168, 720 for n=2…5. A peephole optimiser (adjacent-CNOT cancellation + rotation fusion) then collapses STRUCTURED gates — QFT, Toffoli, Fredkin, the Grover diffusion, modular adders — far below that generic bound, while a Haar-random SU(2ⁿ) sits exactly on it (the cost is irreducible by counting). The n-Qubit Synthesis tab decomposes a chosen gate, draws the {Rz,Ry,CNOT} circuit, shows the per-level recursion breakdown summing to the closed form, plots the ¾·4ⁿ cost curve with your gate marked, and — closing the loop with Solovay–Kitaev — compiles every rotation into a discrete {H,T,…} word so an arbitrary n-qubit unitary becomes a real {H,T,CNOT} circuit with a total T-count, the magic-state bill of universality. Verified to machine precision across ten new self-tests: the unitary eigensolver, the CSD reconstruction and Pythagorean identity, the exact demultiplexor, the uniformly-controlled rotation at the optimal CNOT count, the full QSD on random SU(2ⁿ) and on QFT/Toffoli/Fredkin, the closed-form CNOT count, and the end-to-end fault-tolerant compile.",
        },
        {
          title: 'Measurement-Based Quantum Computation (the One-Way Computer)',
          content: "A wholly different model of computation, built from scratch and cross-checked against the circuit model. Instead of applying gates, you prepare one large, fixed, entangled cluster state and compute purely by measuring its qubits one at a time in adaptively chosen single-qubit bases — the entanglement is the resource and (irreversible, random) measurement drives the computation. The lab implements the measurement calculus (Danos–Kashefi–Panangaden): patterns of N (prepare |+⟩), E (entangle with CZ), and M (measure at plane-angle φ = (−1)^{sX}·α + sZ·π, fed forward from earlier outcomes), with a universal {J(α), CZ} compiler that turns any single-qubit unitary (via its Euler angles) and CNOT into a cluster + a measurement schedule, propagating the Pauli byproduct operators symbolically. A dynamic state-vector engine frees each qubit the moment it is measured, so a computation of any depth keeps a live register no bigger than the number of logical wires — the MBQC memory advantage made concrete (a depth-deep two-wire circuit spreads over dozens of physical qubits but never holds more than three at once). The headline is determinism from randomness: every run records different measurement outcomes, yet undoing the known byproduct frame yields a byte-for-byte identical logical state — verified to machine precision against an independent dense circuit oracle over hundreds of random inputs and outcome strings. Cluster states are shown to be graph states, the +1 eigenstates of the generators K_v = X_v ∏_{w∼v} Z_w.",
        },
        {
          title: 'Phase Estimation & Tooling',
          content: 'Quantum Phase Estimation recovers eigenphases via phase kickback + inverse QFT. Circuits export to OpenQASM 2.0 (Qiskit/IBM-compatible) and JSON, with shareable URLs, depth/gate metrics, and a 123-case in-browser self-test suite proving the engine correct against exact references — including the Quantum Shannon Decomposition synthesising arbitrary n-qubit gates to machine precision at the textbook ¾·4ⁿ CNOT count, the Solovay–Kitaev compiler reproducing arbitrary gates up to global phase and magic-state distillation\'s 35 p³ law, the measurement-based one-way computer reproducing the circuit model to machine precision — including Shor\'s order-finding distribution vs an exact analytic comb and the end-to-end factoring of 15/21/33/35, the free-fermion TFIM vs exact diagonalisation and the Pfeuty thermodynamic limit, the recovered central charge c=½, the quench vs exact dense evolution, the anisotropic-XY ground energy and the dynamical phase transition (Loschmidt rate + topological order parameter) vs exact dense time evolution, DMRG vs exact diagonalisation, the surface-code MWPM decoder vs brute-force matching, the Union-Find decoder vs MWPM, and both the code-capacity and phenomenological QEC threshold crossings.',
        },
      ].map(({ title, content }, i) => (
        <motion.div
          key={title}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.07 }}
          style={{
            marginBottom: 16,
            padding: '14px 18px',
            background: 'rgba(14, 22, 41, 0.6)',
            border: '1px solid rgba(30, 58, 95, 0.5)',
            borderRadius: 10,
          }}
        >
          <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 700, color: '#7c3aed' }}>{title}</h3>
          <p style={{ margin: 0, fontSize: 12, color: '#64748b', lineHeight: 1.7 }}>{content}</p>
        </motion.div>
      ))}
    </div>
  );
}
