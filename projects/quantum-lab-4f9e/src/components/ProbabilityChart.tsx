import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import type { QuantumState } from '../quantum/QuantumState';

interface Props {
  state: QuantumState;
  maxBars?: number;
}

const GRADIENT_COLORS = [
  '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95',
  '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a',
  '#0891b2', '#0e7490', '#155e75', '#164e63',
  '#059669', '#047857', '#065f46', '#064e3b',
];

interface TooltipEntry { label: string; probability: number }

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: TooltipEntry }[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{
      background: '#1e293b',
      border: '1px solid #334155',
      borderRadius: 6,
      padding: '6px 10px',
      fontSize: 12,
      fontFamily: 'monospace',
      color: '#e2e8f0',
    }}>
      <div>{d.label}</div>
      <div style={{ color: '#7c3aed' }}>{d.probability.toFixed(2)}%</div>
    </div>
  );
}

export default function ProbabilityChart({ state, maxBars = 16 }: Props) {
  const data = useMemo(() => {
    const probs = state.probabilities();
    const total = Math.min(probs.length, maxBars);

    const entries = probs.slice(0, total).map((p, i) => ({
      label: state.getStateLabel(i),
      probability: parseFloat((p * 100).toFixed(2)),
      raw: p,
      index: i,
    }));

    if (probs.length > maxBars) {
      const rest = probs.slice(maxBars).reduce((s, p) => s + p, 0);
      if (rest > 0.001) {
        entries.push({ label: `...+${probs.length - maxBars}`, probability: parseFloat((rest * 100).toFixed(2)), raw: rest, index: maxBars });
      }
    }

    return entries.filter((e) => e.raw > 1e-6);
  }, [state, maxBars]);

  if (data.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: '#475569', padding: 20, fontSize: 12 }}>
        No non-zero probability states
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 5, right: 5, bottom: 20, left: 0 }}>
          <XAxis
            dataKey="label"
            tick={{ fill: '#64748b', fontSize: 9, fontFamily: 'monospace' }}
            angle={-45}
            textAnchor="end"
            interval={0}
          />
          <YAxis
            tick={{ fill: '#64748b', fontSize: 10 }}
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            width={35}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey="probability" radius={[2, 2, 0, 0]}>
            {data.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={GRADIENT_COLORS[entry.index % GRADIENT_COLORS.length]}
                opacity={0.9}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
