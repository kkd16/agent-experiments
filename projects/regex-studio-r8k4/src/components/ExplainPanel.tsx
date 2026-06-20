import type { AstFeatures, RegexNode } from '../engine/compile';
import { explainTopLevel } from '../engine/explain';

export function ExplainPanel({ ast, features }: { ast: RegexNode | null; features: AstFeatures | null }) {
  if (!ast) return <div className="placeholder">Fix the pattern to read its plain-English explanation.</div>;
  return (
    <div className="explain-panel">
      <div className="pane-head">
        <h2>Plain English</h2>
        <p>The parse tree, read back as a sentence.</p>
      </div>
      <p className="explain-text">{explainTopLevel(ast)}</p>
      {features && features.reasons.length > 0 && (
        <div className="explain-features">
          This pattern uses {features.reasons.join(', ')} — features that go beyond the regular languages, so it runs on
          the backtracking VM rather than the automata pipeline.
        </div>
      )}
    </div>
  );
}
