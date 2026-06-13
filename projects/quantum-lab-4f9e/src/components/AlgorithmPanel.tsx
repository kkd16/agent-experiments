import { motion } from 'framer-motion';
import { ALGORITHMS, type Algorithm } from '../quantum/algorithms';

interface Props {
  selectedAlgo: Algorithm | null;
  onSelect: (algo: Algorithm) => void;
}

const TAG_COLORS: Record<string, string> = {
  '2': '#0891b2',
  '3': '#7c3aed',
  '4': '#d97706',
  '5': '#dc2626',
};

export default function AlgorithmPanel({ selectedAlgo, onSelect }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ALGORITHMS.map((algo) => {
        const isSelected = selectedAlgo?.name === algo.name;
        return (
          <motion.button
            key={algo.name}
            onClick={() => onSelect(algo)}
            whileHover={{ x: 2, scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 4,
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${isSelected ? '#7c3aed' : '#1e3a5f'}`,
              background: isSelected ? 'rgba(124, 58, 237, 0.15)' : 'rgba(14, 22, 41, 0.8)',
              cursor: 'pointer',
              textAlign: 'left',
              width: '100%',
              transition: 'all 0.15s',
            }}
          >
            <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8 }}>
              <span style={{
                fontSize: 12,
                fontWeight: 700,
                color: isSelected ? '#a78bfa' : '#94a3b8',
                fontFamily: 'monospace',
                flex: 1,
              }}>
                {algo.name}
              </span>
              <span style={{
                fontSize: 9,
                padding: '2px 6px',
                borderRadius: 3,
                background: TAG_COLORS[String(algo.numQubits)] ?? '#374151',
                color: '#fff',
                fontFamily: 'monospace',
              }}>
                {algo.numQubits}q
              </span>
            </div>
            {isSelected && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                style={{ overflow: 'hidden' }}
              >
                <p style={{ margin: 0, fontSize: 10, color: '#64748b', lineHeight: 1.5 }}>
                  {algo.description}
                </p>
                <div style={{
                  marginTop: 6,
                  padding: '6px 8px',
                  background: 'rgba(124, 58, 237, 0.1)',
                  borderRadius: 4,
                  borderLeft: '2px solid #7c3aed',
                }}>
                  <p style={{ margin: 0, fontSize: 10, color: '#a78bfa', lineHeight: 1.5 }}>
                    {algo.interpretation}
                  </p>
                </div>
              </motion.div>
            )}
          </motion.button>
        );
      })}
    </div>
  );
}
