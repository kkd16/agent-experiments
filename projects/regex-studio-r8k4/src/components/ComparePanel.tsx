import { useMemo } from 'react';
import { compile } from '../engine/compile';
import type { DFA } from '../engine/dfa';
import { compareDFAs, type Relation, type Witness } from '../engine/equivalence';

interface Props {
  dfaA: DFA | null;
  noticeA: string | null; // why pattern A has no DFA (if non-regular)
  other: string;
  onOtherChange: (s: string) => void;
}

const RELATION_TEXT: Record<Relation, { title: string; blurb: string; symbol: string }> = {
  equal: { title: 'Equivalent', blurb: 'Both patterns accept exactly the same set of strings.', symbol: 'A = B' },
  subset: { title: 'A is a strict subset of B', blurb: 'Everything A matches, B matches too — but not vice versa.', symbol: 'A ⊂ B' },
  superset: { title: 'A is a strict superset of B', blurb: 'Everything B matches, A matches too — but not vice versa.', symbol: 'A ⊃ B' },
  disjoint: { title: 'Disjoint', blurb: 'No string is matched by both patterns.', symbol: 'A ∩ B = ∅' },
  overlap: { title: 'Overlapping', blurb: 'They share some strings, but each also matches strings the other rejects.', symbol: 'A ∩ B ≠ ∅' },
};

export function ComparePanel({ dfaA, noticeA, other, onOtherChange }: Props) {
  const compiledB = useMemo(() => compile(other), [other]);
  const dfaB = compiledB.minDfa;

  const result = useMemo(() => (dfaA && dfaB ? compareDFAs(dfaA, dfaB) : null), [dfaA, dfaB]);

  return (
    <div className="compare-panel">
      <div className="pane-head">
        <h2>Equivalence &amp; containment</h2>
        <p>
          Compares the two languages by walking the product automaton A×B over a shared alphabet refinement. The
          shortest <em>distinguishing string</em> is the textbook proof that two regexes differ.
        </p>
      </div>

      <label className="field-label" htmlFor="cmp">
        compare against pattern B
      </label>
      <div className={`pattern-box${compiledB.error ? ' has-error' : ''}`}>
        <span className="slash">/</span>
        <input
          id="cmp"
          className="pattern-input"
          value={other}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onOtherChange(e.target.value)}
          placeholder="a second regex…"
        />
        <span className="slash">/</span>
      </div>

      {!dfaA && <div className="placeholder">{noticeA ?? 'Pattern A needs a valid regular pattern to compare.'}</div>}
      {dfaA && compiledB.error && (
        <div className="parse-error static">
          {compiledB.error.message} (at index {compiledB.error.index})
        </div>
      )}
      {dfaA && !compiledB.error && !dfaB && (
        <div className="placeholder">
          Pattern B uses non-regular features{compiledB.features ? ` (${compiledB.features.reasons.join(', ')})` : ''} —
          equivalence is only decidable for regular languages.
        </div>
      )}

      {result && (
        <div className="compare-result">
          <div className={`relation rel-${result.relation}`}>
            <span className="rel-symbol">{RELATION_TEXT[result.relation].symbol}</span>
            <div>
              <strong>{RELATION_TEXT[result.relation].title}</strong>
              <p>{RELATION_TEXT[result.relation].blurb}</p>
            </div>
          </div>

          <div className="witness-grid">
            <WitnessCard label="in A but not B" w={result.inAOnly} empty="— none —" />
            <WitnessCard label="in B but not A" w={result.inBOnly} empty="— none —" />
            <WitnessCard label="in both (A ∩ B)" w={result.inBoth} empty="— none —" />
          </div>
        </div>
      )}
    </div>
  );
}

function WitnessCard({ label, w, empty }: { label: string; w: Witness | null; empty: string }) {
  return (
    <div className="witness-card">
      <span className="witness-label">{label}</span>
      {w ? <code className="witness-text">{w.display}</code> : <span className="witness-none">{empty}</span>}
    </div>
  );
}
