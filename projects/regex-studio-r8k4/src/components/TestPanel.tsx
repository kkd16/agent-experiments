import { useMemo } from 'react';
import type { DFA } from '../engine/dfa';
import { dfaAccepts, searchAll, toCodePoints } from '../engine/simulate';

interface Props {
  dfa: DFA | null;
  text: string;
  onTextChange: (t: string) => void;
}

export function TestPanel({ dfa, text, onTextChange }: Props) {
  const result = useMemo(() => {
    if (!dfa) return null;
    const { matches, emptyMatches } = searchAll(dfa, text);
    const whole = dfaAccepts(dfa, text);
    return { matches, emptyMatches, whole };
  }, [dfa, text]);

  const chars = useMemo(() => Array.from(text), [text]);

  // Map each code-point index to a match id for highlighting.
  const matchOf = useMemo(() => {
    const arr = new Int32Array(chars.length).fill(-1);
    if (result) {
      result.matches.forEach((m, idx) => {
        for (let i = m.start; i < m.end && i < arr.length; i++) arr[i] = idx;
      });
    }
    return arr;
  }, [result, chars.length]);

  return (
    <div className="test-panel">
      <div className="panel-head">
        <h2>Test string</h2>
        {result && (
          <div className="verdict-row">
            <span className={`chip ${result.whole ? 'chip-yes' : 'chip-no'}`}>
              {result.whole ? 'full match ✓' : 'no full match'}
            </span>
            <span className="chip chip-count">
              {result.matches.length} match{result.matches.length === 1 ? '' : 'es'}
            </span>
            {result.emptyMatches > 0 && <span className="chip chip-muted">{result.emptyMatches} empty</span>}
          </div>
        )}
      </div>
      <textarea
        className="test-input"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        spellCheck={false}
        rows={3}
        placeholder="Type text to search…"
      />
      <div className="highlight" aria-hidden>
        {chars.length === 0 ? (
          <span className="hl-placeholder">matches appear here</span>
        ) : (
          chars.map((ch, i) => {
            const id = matchOf[i];
            const prev = i > 0 ? matchOf[i - 1] : -1;
            const startsMatch = id >= 0 && id !== prev;
            return (
              <span
                key={i}
                className={id >= 0 ? `hl-match hue-${id % 6}` : 'hl-plain'}
                data-start={startsMatch || undefined}
              >
                {ch === '\n' ? '↵\n' : ch === ' ' ? ' ' : ch}
              </span>
            );
          })
        )}
      </div>
      <p className="muted-note">
        Highlighting uses the minimal DFA with leftmost-longest, non-overlapping matching.{' '}
        {dfa ? `${toCodePoints(text).length} code points scanned.` : ''}
      </p>
    </div>
  );
}
