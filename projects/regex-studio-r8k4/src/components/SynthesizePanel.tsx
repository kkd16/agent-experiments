import { useMemo } from 'react';
import type { DFA } from '../engine/dfa';
import { buildDFA } from '../engine/dfa';
import { buildNFA } from '../engine/nfa';
import { minimizeDFA } from '../engine/minimize';
import { compareDFAs } from '../engine/equivalence';
import { dfaToRegex } from '../engine/synthesize';

export function SynthesizePanel({ dfa, notice }: { dfa: DFA | null; notice: string | null }) {
  const synth = useMemo(() => (dfa ? dfaToRegex(dfa) : null), [dfa]);

  // Re-verify: compile the reconstructed expression and confirm it accepts the
  // identical language. This is an end-to-end proof the round trip is faithful.
  const verified = useMemo(() => {
    if (!dfa || !synth) return null;
    try {
      const min = minimizeDFA(buildDFA(buildNFA(synth.ast)));
      return compareDFAs(dfa, min).relation === 'equal';
    } catch {
      return false;
    }
  }, [dfa, synth]);

  if (!dfa || !synth) {
    return <div className="placeholder">{notice ?? 'Fix the pattern to synthesise a regex from its DFA.'}</div>;
  }

  const display = synth.empty ? '∅ (matches nothing)' : synth.epsilonOnly ? 'ε (the empty string only)' : synth.regex;

  return (
    <div className="synth-panel">
      <div className="pane-head">
        <h2>DFA → regex (state elimination)</h2>
        <p>
          The classic round trip: rip every state out of the minimal DFA one at a time, rerouting paths through the
          rule <code>R(i,q)·R(q,q)*·R(q,j)</code>, until a single edge spells out a regular expression for the whole
          language.
        </p>
      </div>

      <div className="synth-result">
        <span className="synth-label">reconstructed pattern</span>
        <code className="synth-regex">{display}</code>
      </div>

      {verified !== null && (
        <div className={`synth-verify ${verified ? 'good' : 'bad'}`}>
          {verified
            ? '✓ verified — re-compiling this expression yields a DFA equivalent to the original.'
            : '⚠ the reconstruction could not be auto-verified.'}
        </div>
      )}

      <p className="muted-note">
        State elimination doesn’t usually return your original source — it returns <em>a</em> regex for the same
        language, often shaped quite differently. The verification above confirms they’re equivalent regardless.
        Notation: <code>·</code> concatenation, <code>|</code> alternation, <code>*</code> Kleene star,{' '}
        <code>[\s\S]</code> any character.
      </p>
    </div>
  );
}
