interface Props {
  confusion: number[];
  labels: string[];
}

// Held-out confusion matrix: row = true class, column = the spiking net's prediction. The diagonal
// lights up as it learns; off-diagonal cells are the glyphs it still confuses.
export default function ConfusionMatrix({ confusion, labels }: Props) {
  const K = labels.length;
  if (!confusion || confusion.length !== K * K || K === 0) return <div className="muted small">No evaluation yet.</div>;
  const rowTotals = new Array(K).fill(0);
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) rowTotals[i] += confusion[i * K + j];
  const cell = 20;
  const lab = 20;
  const size = lab + K * cell + 2;

  return (
    <svg width={size} height={size} className="confusion-svg" role="img" aria-label="confusion matrix">
      {labels.map((l, j) => (
        <text key={'c' + j} x={lab + j * cell + cell / 2} y={lab - 6} fill="rgba(148,163,184,0.7)" fontSize="9" textAnchor="middle" fontFamily="ui-monospace, monospace">
          {l}
        </text>
      ))}
      {labels.map((l, i) => (
        <text key={'r' + i} x={lab - 5} y={lab + i * cell + cell / 2} fill="rgba(148,163,184,0.7)" fontSize="9" textAnchor="end" dominantBaseline="middle" fontFamily="ui-monospace, monospace">
          {l}
        </text>
      ))}
      {Array.from({ length: K }, (_, i) =>
        Array.from({ length: K }, (_, j) => {
          const v = confusion[i * K + j];
          const frac = rowTotals[i] ? v / rowTotals[i] : 0;
          const diag = i === j;
          const rgb = diag ? '74,222,128' : '244,114,182';
          return (
            <g key={i + '-' + j}>
              <rect
                x={lab + j * cell}
                y={lab + i * cell}
                width={cell - 1.5}
                height={cell - 1.5}
                fill={`rgba(${rgb},${0.12 + frac * 0.8})`}
                rx={2}
              />
              {v > 0 && (
                <text
                  x={lab + j * cell + (cell - 1.5) / 2}
                  y={lab + i * cell + (cell - 1.5) / 2}
                  fill={frac > 0.4 ? '#0b1220' : 'rgba(226,232,240,0.75)'}
                  fontSize="9"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontFamily="ui-monospace, monospace"
                >
                  {v}
                </text>
              )}
            </g>
          );
        }),
      )}
    </svg>
  );
}
