import { useMemo } from 'react';
import type { QuantumState } from '../quantum/QuantumState';
import { motion } from 'framer-motion';

interface Props {
  state: QuantumState;
  maxStates?: number;
}

function phaseToHue(phase: number): string {
  const hue = ((phase / Math.PI) * 180 + 360) % 360;
  return `hsl(${hue}, 90%, 60%)`;
}

export default function StateVector({ state, maxStates = 32 }: Props) {
  const entries = useMemo(() => {
    const probs = state.probabilities();
    const total = state.amplitudes.length;
    const show = Math.min(total, maxStates);

    return Array.from({ length: show }, (_, i) => {
      const amp = state.amplitudes[i];
      const prob = probs[i];
      const phase = amp.phase();
      const label = state.getStateLabel(i);
      return { i, amp, prob, phase, label };
    }).sort((a, b) => b.prob - a.prob);
  }, [state, maxStates]);

  const maxProb = Math.max(...entries.map((e) => e.prob), 0.001);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
      {entries.map(({ i, amp, prob, phase, label }) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2, delay: i * 0.01 }}
          style={{
            display: 'grid',
            gridTemplateColumns: '70px 1fr 80px',
            alignItems: 'center',
            gap: 8,
            padding: '3px 6px',
            borderRadius: 4,
            background: prob > 0.001 ? 'rgba(100, 200, 255, 0.05)' : 'transparent',
          }}
        >
          <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#94a3b8' }}>{label}</span>

          <div style={{ position: 'relative', height: 16, background: 'rgba(255,255,255,0.05)', borderRadius: 2 }}>
            <motion.div
              animate={{ width: `${(prob / maxProb) * 100}%` }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                height: '100%',
                background: `linear-gradient(90deg, ${phaseToHue(phase)}, ${phaseToHue(phase + 0.5)})`,
                borderRadius: 2,
                opacity: 0.8,
              }}
            />
            {prob > 0.001 && (
              <div
                style={{
                  position: 'absolute',
                  left: 4,
                  top: 0,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: 9,
                  color: 'rgba(255,255,255,0.7)',
                  fontFamily: 'monospace',
                }}
              >
                {(prob * 100).toFixed(1)}%
              </div>
            )}
          </div>

          <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#64748b', textAlign: 'right' }}>
            {amp.toString()}
          </span>
        </motion.div>
      ))}
      {state.amplitudes.length > maxStates && (
        <div style={{ textAlign: 'center', color: '#475569', fontSize: 11 }}>
          ... {state.amplitudes.length - maxStates} more states
        </div>
      )}
    </div>
  );
}
