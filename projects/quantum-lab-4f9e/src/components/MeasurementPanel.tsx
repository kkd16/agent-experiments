import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { QuantumState } from '../quantum/QuantumState';

interface Props {
  state: QuantumState;
}

interface HistoryEntry {
  results: number[];
  probabilities: number[];
  timestamp: number;
}

export default function MeasurementPanel({ state }: Props) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [shots, setShots] = useState(100);
  const [sampledCounts, setSampledCounts] = useState<Record<string, number> | null>(null);

  const measureOnce = useCallback(() => {
    const { results, probabilities } = state.measureAll();
    setHistory((h) => [{ results, probabilities, timestamp: Date.now() }, ...h.slice(0, 19)]);
    setSampledCounts(null);
  }, [state]);

  const runShots = useCallback(() => {
    const counts: Record<string, number> = {};
    const probs = state.probabilities();

    for (let s = 0; s < shots; s++) {
      const r = Math.random(); let cumulative = 0, outcome = 0;
      for (let i = 0; i < probs.length; i++) {
        cumulative += probs[i];
        if (r < cumulative) { outcome = i; break; }
      }
      const key = outcome.toString(2).padStart(state.numQubits, '0');
      counts[key] = (counts[key] ?? 0) + 1;
    }
    setSampledCounts(counts);
    setHistory([]);
  }, [state, shots]);

  const maxCount = sampledCounts ? Math.max(...Object.values(sampledCounts)) : 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={measureOnce}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            background: 'linear-gradient(135deg, #7c3aed, #5b21b6)',
            color: '#fff',
            fontWeight: 700,
            fontSize: 12,
            cursor: 'pointer',
            boxShadow: '0 0 12px rgba(124, 58, 237, 0.5)',
          }}
        >
          ⚛ Measure Once
        </motion.button>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="number"
            value={shots}
            onChange={(e) => setShots(Math.max(1, Math.min(10000, parseInt(e.target.value) || 100)))}
            style={{
              width: 70,
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: 6,
              padding: '7px 8px',
              color: '#e2e8f0',
              fontSize: 12,
              fontFamily: 'monospace',
            }}
          />
          <motion.button
            whileTap={{ scale: 0.95 }}
            onClick={runShots}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: '1px solid #0891b2',
              background: 'rgba(8, 145, 178, 0.1)',
              color: '#0891b2',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Run {shots} Shots
          </motion.button>
        </div>

        {(history.length > 0 || sampledCounts) && (
          <button
            onClick={() => { setHistory([]); setSampledCounts(null); }}
            style={{
              padding: '7px 10px',
              borderRadius: 6,
              border: '1px solid #334155',
              background: 'transparent',
              color: '#64748b',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Shot distribution */}
      <AnimatePresence>
        {sampledCounts && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            style={{
              background: 'rgba(8, 145, 178, 0.05)',
              border: '1px solid rgba(8, 145, 178, 0.2)',
              borderRadius: 8,
              padding: 12,
            }}
          >
            <div style={{ fontSize: 11, color: '#0891b2', marginBottom: 8, fontWeight: 600 }}>
              {shots} shot distribution:
            </div>
            {Object.entries(sampledCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([state, count]) => (
                <div key={state} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 40px', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>|{state}⟩</span>
                  <div style={{ height: 12, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${(count / maxCount) * 100}%`,
                      background: 'linear-gradient(90deg, #0891b2, #7c3aed)',
                      borderRadius: 2,
                    }} />
                  </div>
                  <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace', textAlign: 'right' }}>
                    {((count / shots) * 100).toFixed(1)}%
                  </span>
                </div>
              ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* History */}
      <AnimatePresence>
        {history.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            <div style={{ fontSize: 10, color: '#475569', marginBottom: 2 }}>Measurement history (newest first):</div>
            {history.map((h, i) => (
              <motion.div
                key={h.timestamp}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.02 }}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  padding: '4px 8px',
                  background: i === 0 ? 'rgba(124, 58, 237, 0.1)' : 'rgba(255,255,255,0.02)',
                  borderRadius: 4,
                  borderLeft: i === 0 ? '2px solid #7c3aed' : '2px solid transparent',
                }}
              >
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: i === 0 ? '#a78bfa' : '#64748b' }}>
                  |{h.results.map((b) => b).join('')}⟩
                </span>
                <span style={{ fontSize: 9, color: '#374151' }}>
                  p≈{(h.probabilities[parseInt(h.results.join(''), 2)] * 100).toFixed(1)}%
                </span>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {history.length === 0 && !sampledCounts && (
        <div style={{ color: '#334155', fontSize: 11, textAlign: 'center', padding: 12 }}>
          Measure the quantum state to collapse it to a classical outcome. The quantum superposition vanishes upon measurement (Born rule).
        </div>
      )}
    </div>
  );
}
