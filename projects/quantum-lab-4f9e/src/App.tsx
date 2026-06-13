import { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { QuantumState, type GateOp } from './quantum/QuantumState';
import { ALGORITHMS, type Algorithm } from './quantum/algorithms';
import CircuitEditor from './components/CircuitEditor';
import StateVector from './components/StateVector';
import ProbabilityChart from './components/ProbabilityChart';
import AlgorithmPanel from './components/AlgorithmPanel';
import MeasurementPanel from './components/MeasurementPanel';
import BlochSphere from './components/BlochSphere';

type Tab = 'builder' | 'algorithms' | 'about';
type VizTab = 'state' | 'probabilities' | 'bloch' | 'measure';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('algorithms');
  const [vizTab, setVizTab] = useState<VizTab>('probabilities');
  const [numQubits, setNumQubits] = useState(2);
  const [ops, setOps] = useState<GateOp[]>([]);
  const [selectedAlgo, setSelectedAlgo] = useState<Algorithm | null>(ALGORITHMS[0]);
  const [stepIndex, setStepIndex] = useState<number | null>(null);

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
    if (currentNumQubits < 2) return [];
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

        <nav style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
          {(['builder', 'algorithms', 'about'] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '5px 12px',
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
              {tab === 'builder' ? '🔧 Builder' : tab === 'algorithms' ? '⚡ Algorithms' : '📖 About'}
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
        </div>
      </header>

      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <AnimatePresence mode="wait">
          {activeTab === 'about' ? (
            <motion.div
              key="about"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{ flex: 1, padding: '24px 32px', overflowY: 'auto' }}
            >
              <AboutPage />
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
              </div>

              <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                <div style={{
                  display: 'flex',
                  borderBottom: '1px solid rgba(30, 58, 95, 0.4)',
                  background: 'rgba(2, 6, 23, 0.4)',
                  flexShrink: 0,
                }}>
                  {(['probabilities', 'state', 'bloch', 'measure'] as VizTab[]).map((t) => (
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
                      {t === 'probabilities' ? '📊' : t === 'state' ? '🌊' : t === 'bloch' ? '🌐' : '⚡'} {t}
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
          content: 'The bipartite entanglement entropy S = -Tr(ρ_A log₂ ρ_A) is computed for every contiguous bipartition. S=0 means the state is separable (product state). S=1 means maximally entangled (like a Bell pair). This is computed via partial trace of the density matrix.',
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
