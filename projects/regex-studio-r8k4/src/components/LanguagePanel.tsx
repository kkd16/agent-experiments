import { useMemo } from 'react';
import type { DFA } from '../engine/dfa';
import { analyzeLanguage } from '../engine/language';

const MAX_LEN = 8;

export function LanguagePanel({ dfa, notice }: { dfa: DFA | null; notice: string | null }) {
  const info = useMemo(() => (dfa ? analyzeLanguage(dfa, { maxLen: MAX_LEN, examples: 16 }) : null), [dfa]);

  if (!dfa || !info) {
    return <div className="placeholder">{notice ?? 'Fix the pattern to analyse its language.'}</div>;
  }

  return (
    <div className="lang-panel">
      <div className="pane-head">
        <h2>Language</h2>
        <p>Everything below is computed by walking the minimal DFA — the regex is treated as a set of strings.</p>
      </div>

      <div className="lang-grid">
        <div className="lang-card">
          <span className="lang-key">non-empty?</span>
          <span className={`lang-badge ${info.empty ? 'bad' : 'good'}`}>{info.empty ? 'empty ∅' : 'has members'}</span>
        </div>
        <div className="lang-card">
          <span className="lang-key">size</span>
          <span className="lang-badge">
            {info.empty ? '0' : info.finite ? `finite${info.totalIfFinite != null ? ` (${info.totalIfFinite.toLocaleString()})` : ''}` : 'infinite ∞'}
          </span>
        </div>
        <div className="lang-card wide">
          <span className="lang-key">shortest member</span>
          <span className="lang-badge">{info.shortest ? <code>{info.shortest.display}</code> : '—'}</span>
        </div>
      </div>

      {!info.empty && (
        <>
          <h3 className="lang-h3">Exact string counts by length</h3>
          <p className="muted-note">
            How many distinct strings of each length the language contains (full Unicode alphabet, exact BigInt
            arithmetic).
          </p>
          <div className="count-table">
            <table>
              <thead>
                <tr>
                  <th>length</th>
                  {info.countsByLength.map((_, i) => (
                    <th key={i}>{i}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>exact</td>
                  {info.countsByLength.map((c, i) => (
                    <td key={i}>{c.toLocaleString()}</td>
                  ))}
                </tr>
                <tr className="cum-row">
                  <td>≤ length</td>
                  {info.cumulative.map((c, i) => (
                    <td key={i}>{c.toLocaleString()}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <h3 className="lang-h3">Example members (shortlex order)</h3>
          <p className="muted-note">
            {info.examplesExact
              ? 'Every character class here is a single character, so these are literal members.'
              : 'One representative character is chosen per class, so each row is one genuine member of the language.'}
          </p>
          <div className="example-chips">
            {info.examples.length === 0 && <span className="muted-note">no members within the search depth</span>}
            {info.examples.map((s, i) => (
              <code key={i} className="example-chip">
                {s === '' ? 'ε' : s}
              </code>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
