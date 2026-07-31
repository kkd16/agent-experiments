import type { CompiledFormula } from '../../engine/kan';

interface Props {
  compiled: CompiledFormula | null;
  classify: boolean;
}

// The headline of the interpretability pipeline: the whole KAN rendered as a closed-form
// expression per output. As edges are snapped to symbols (or pruned), the opaque φ(...) placeholders
// vanish and the coverage bar fills toward 100% — the network literally *becomes an equation*.
export default function KANFormula({ compiled, classify }: Props) {
  if (!compiled) return null;
  const pct = Math.round(compiled.coverage * 100);
  const labelFor = (k: number) => (classify ? `logit ${k}` : 'y');

  return (
    <div>
      <div className="kan-mode-tally">
        <span className="tag tag-spline">{compiled.spline} spline</span>
        <span className="tag tag-symbolic">{compiled.symbolic} symbolic</span>
        <span className="tag tag-pruned">{compiled.pruned} pruned</span>
      </div>
      <div className="kan-coverage" title="fraction of edges that are no longer opaque splines">
        <div className="kan-coverage-fill" style={{ width: `${pct}%` }} />
        <span className="kan-coverage-label">{pct}% compiled</span>
      </div>
      <div className="kan-formulas">
        {compiled.formulas.map((f, k) => (
          <div className="kan-formula" key={k}>
            <span className="kan-formula-lhs">{labelFor(k)} =</span>
            <span className="kan-formula-rhs">{f}</span>
          </div>
        ))}
      </div>
      {compiled.spline > 0 ? (
        <p className="muted small">
          <b>φ(·)</b> marks an edge still carried by its B-spline — snap it (or auto-snap) to collapse it into a symbol.
        </p>
      ) : (
        <p className="muted small">
          Every active edge is symbolic — this is the exact function the network computes, distilled from the trained splines.
        </p>
      )}
    </div>
  );
}
