import { rgbCss, POSITIVE_COLOR } from '../../lib/colors';

interface Props {
  confusion: number[][] | null;
  labels: string[];
}

// Row = true class, column = predicted class. The diagonal lighting up (and the off-diagonal
// going dark) is the network getting things right; cells are row-normalized so classes with
// different sample counts compare fairly.
export default function ConfusionMatrix({ confusion, labels }: Props) {
  if (!confusion || confusion.length === 0) return <p className="muted small">Train a step to populate.</p>;
  const C = confusion.length;
  const rowSums = confusion.map((r) => r.reduce((a, b) => a + b, 0));
  let correct = 0;
  let total = 0;
  for (let i = 0; i < C; i++) {
    correct += confusion[i][i];
    total += rowSums[i];
  }
  const acc = total ? correct / total : 0;
  const compact = C > 6;

  return (
    <div className="confusion">
      <div className="conf-grid" style={{ gridTemplateColumns: `auto repeat(${C}, 1fr)` }}>
        <div className="conf-corner" />
        {labels.map((l) => (
          <div className="conf-h" key={`c${l}`}>
            {l}
          </div>
        ))}
        {confusion.map((row, i) => (
          <Row key={i} label={labels[i]} row={row} sum={rowSums[i]} diag={i} compact={compact} />
        ))}
      </div>
      <div className="conf-foot muted small">
        diagonal = correct · subset accuracy <b>{(acc * 100).toFixed(1)}%</b>
      </div>
    </div>
  );
}

function Row({
  label,
  row,
  sum,
  diag,
  compact,
}: {
  label: string;
  row: number[];
  sum: number;
  diag: number;
  compact: boolean;
}) {
  return (
    <>
      <div className="conf-h row">{label}</div>
      {row.map((v, j) => {
        const frac = sum ? v / sum : 0;
        const isDiag = j === diag;
        return (
          <div
            className={`conf-cell ${isDiag ? 'diag' : ''}`}
            key={j}
            style={{ background: rgbCss(POSITIVE_COLOR, 0.08 + frac * 0.85) }}
            title={`${v} of ${sum}`}
          >
            {compact ? (frac > 0.01 ? Math.round(frac * 100) : '') : v}
          </div>
        );
      })}
    </>
  );
}
