import { useMemo } from 'react';
import type { Compiled } from '../engine/compile';
import { dfaAccepts, searchAll, toCodePoints } from '../engine/simulate';
import { runVM, searchVM, type VMMatch } from '../engine/vm';

interface Props {
  compiled: Compiled;
  text: string;
  onTextChange: (t: string) => void;
}

const STEP_WARN = 50_000;

export function MatchPanel({ compiled, text, onTextChange }: Props) {
  const { ast, minDfa, groupCount, features } = compiled;
  const chars = useMemo(() => Array.from(text), [text]);
  const codeLen = useMemo(() => toCodePoints(text).length, [text]);

  const vm = useMemo(() => {
    if (!ast) return null;
    return searchVM(ast, groupCount, text, { stepLimit: 4_000_000 });
  }, [ast, groupCount, text]);

  // Whole-string acceptance: exact via DFA when regular, else an anchored VM run.
  const fullMatch = useMemo(() => {
    if (minDfa) return dfaAccepts(minDfa, text);
    if (!ast) return null;
    const r = runVM(ast, groupCount, text, { stepLimit: 4_000_000 });
    return !!r.match && r.match.start === 0 && r.match.end === codeLen;
  }, [ast, minDfa, groupCount, text, codeLen]);

  const dfaResult = useMemo(() => (minDfa ? searchAll(minDfa, text) : null), [minDfa, text]);

  const matches = useMemo(() => vm?.matches ?? [], [vm]);

  // index → match id for primary highlighting; index → captured? for underlines.
  const { matchOf, capOf } = useMemo(() => {
    const m = new Int32Array(chars.length).fill(-1);
    const c = new Int32Array(chars.length).fill(-1);
    matches.forEach((mt, idx) => {
      for (let i = mt.start; i < mt.end && i < m.length; i++) m[i] = idx;
      mt.groups.forEach((g, gi) => {
        if (gi === 0 || !g) return;
        for (let i = g.start; i < g.end && i < c.length; i++) c[i] = gi;
      });
    });
    return { matchOf: m, capOf: c };
  }, [matches, chars.length]);

  const aborted = vm?.aborted ?? false;
  const steps = vm?.steps ?? 0;

  return (
    <div className="test-panel">
      <div className="panel-head">
        <h2>Run</h2>
        <div className="verdict-row">
          {fullMatch != null && (
            <span className={`chip ${fullMatch ? 'chip-yes' : 'chip-no'}`}>
              {fullMatch ? 'full match ✓' : 'no full match'}
            </span>
          )}
          <span className="chip chip-count">
            {matches.length} match{matches.length === 1 ? '' : 'es'}
          </span>
          {groupCount > 0 && <span className="chip chip-muted">{groupCount} group{groupCount === 1 ? '' : 's'}</span>}
        </div>
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
            const captured = capOf[i] >= 0;
            return (
              <span
                key={i}
                className={`${id >= 0 ? `hl-match hue-${id % 6}` : 'hl-plain'}${captured ? ' hl-cap' : ''}`}
                data-start={startsMatch || undefined}
              >
                {ch === '\n' ? '↵\n' : ch === ' ' ? ' ' : ch}
              </span>
            );
          })
        )}
      </div>

      <EngineBar
        regular={features?.regular ?? true}
        steps={steps}
        aborted={aborted}
        dfaMatches={dfaResult?.matches.length ?? null}
      />

      {groupCount > 0 && matches.length > 0 && <CaptureTable matches={matches} text={text} groupCount={groupCount} />}

      <p className="muted-note">
        The <strong>backtracking VM</strong> runs every feature (captures, backreferences, anchors, lookaround).{' '}
        {minDfa
          ? 'Because this pattern is regular, the minimal DFA also decides it in guaranteed linear time.'
          : 'This pattern is non-regular, so only the VM can run it — there is no DFA.'}{' '}
        {codeLen} code points scanned.
      </p>
    </div>
  );
}

function EngineBar({
  regular,
  steps,
  aborted,
  dfaMatches,
}: {
  regular: boolean;
  steps: number;
  aborted: boolean;
  dfaMatches: number | null;
}) {
  const hot = aborted || steps > STEP_WARN;
  return (
    <div className="engine-bar">
      <div className={`engine-stat${hot ? ' engine-hot' : ''}`}>
        <span className="engine-name">backtracking VM</span>
        <span className="engine-val">
          {aborted ? 'step limit hit — catastrophic backtracking!' : `${steps.toLocaleString()} steps`}
        </span>
      </div>
      <div className="engine-stat engine-good">
        <span className="engine-name">automaton (DFA)</span>
        <span className="engine-val">
          {regular
            ? `linear — one pass${dfaMatches != null ? `, ${dfaMatches} match${dfaMatches === 1 ? '' : 'es'}` : ''}`
            : 'n/a — language is not regular'}
        </span>
      </div>
    </div>
  );
}

function CaptureTable({ matches, text, groupCount }: { matches: VMMatch[]; text: string; groupCount: number }) {
  const chars = Array.from(text);
  const slice = (a: number, b: number) => chars.slice(a, b).join('') || '∅';
  const shown = matches.slice(0, 6);
  return (
    <div className="capture-table">
      <table>
        <thead>
          <tr>
            <th>match</th>
            {Array.from({ length: groupCount }, (_, i) => (
              <th key={i}>#{i + 1}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((m, mi) => (
            <tr key={mi}>
              <td className="cap-whole">
                <code>{slice(m.start, m.end)}</code>
              </td>
              {Array.from({ length: groupCount }, (_, gi) => {
                const g = m.groups[gi + 1];
                return (
                  <td key={gi}>{g ? <code>{slice(g.start, g.end)}</code> : <span className="cap-none">—</span>}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {matches.length > shown.length && <p className="muted-note">…and {matches.length - shown.length} more.</p>}
    </div>
  );
}
