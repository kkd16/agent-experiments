import { useMemo, useState } from 'react';
import type { DFA } from '../engine/dfa';
import { learnLStar } from '../engine/learn';
import { rpniLearnFromTarget } from '../engine/rpni';
import { DEFAULT_LEARN_FUZZ, runLearnFuzz, type LearnFuzzReport } from '../engine/learn-verify';
import { dfaToGraph } from '../engine/graphdata';
import { layoutGraph } from '../engine/layout';
import { AutomatonGraph } from './AutomatonGraph';

// The Learn tab. Every other road in the studio starts from the regex you wrote;
// this one hides it and reconstructs the minimal DFA from queries alone — Angluin's
// L* (active: it asks the teacher) and RPNI (passive: it's handed labelled data).

export function LearnPanel({ dfa, notice }: { dfa: DFA | null; notice: string | null }) {
  const lstar = useMemo(() => (dfa ? learnLStar(dfa) : null), [dfa]);
  const rpni = useMemo(() => (dfa ? rpniLearnFromTarget(dfa) : null), [dfa]);
  const learnedLayout = useMemo(
    () => (lstar?.hypothesis ? layoutGraph(dfaToGraph(lstar.hypothesis)) : null),
    [lstar],
  );

  if (!dfa || !lstar) {
    return <div className="placeholder">{notice ?? 'Fix the pattern to learn its language.'}</div>;
  }

  return (
    <div className="learn-panel">
      <div className="pane-head">
        <h2>Learn the language — no regex, only questions</h2>
        <p>
          Every other tab walks the regex you wrote down to an automaton. Here the pattern is hidden behind an
          <strong> oracle</strong>, and the learner rebuilds the minimal DFA from scratch — Angluin's <strong>L*</strong>{' '}
          (active: it interrogates a teacher) and <strong>RPNI</strong> (passive: it is handed labelled examples). The
          teacher is the studio's own engine: membership is a walk over the target DFA, equivalence is the
          product-automaton comparison from the Compare tab — which hands back the shortest counterexample for free.
        </p>
      </div>

      <div className="learn-alpha">
        <span className="lang-key">alphabet (atom classes)</span>
        {lstar.alphabet.length === 0 ? (
          <code className="example-chip">∅ (only ε)</code>
        ) : (
          lstar.alphabet.map((l) => (
            <code key={l.atom} className="example-chip" title={`representative '${String.fromCodePoint(l.rep)}'`}>
              {l.label}
            </code>
          ))
        )}
      </div>

      {/* ---------------- L* (active) ---------------- */}
      <h3 className="lang-h3">Angluin's L* — active learning</h3>
      {lstar.aborted ? (
        <div className="learn-abort">{lstar.log[lstar.log.length - 1]?.detail ?? 'Learning aborted.'}</div>
      ) : (
        <>
          <div className="learn-verdicts">
            <span className={`lang-badge ${lstar.equivalent ? 'good' : 'bad'}`}>
              {lstar.equivalent ? 'learned ≡ target ✓' : 'NOT equivalent ✗'}
            </span>
            <span className={`lang-badge ${lstar.minimal ? 'good' : 'bad'}`}>
              {lstar.minimal
                ? `minimal: ${lstar.targetStates} states ✓ (Myhill–Nerode)`
                : `not minimal (${lstar.canonicalStates} vs ${lstar.targetStates})`}
            </span>
          </div>

          <div className="fuzz-stats">
            <St k="membership queries" v={lstar.membershipQueries.toLocaleString()} />
            <St k="equivalence queries" v={String(lstar.equivalenceQueries)} />
            <St k="conjectures" v={String(lstar.rounds.length)} />
            <St k="learned states (complete)" v={String(lstar.distinctRows)} />
            <St k="|S| access strings" v={String(lstar.finalS)} />
            <St k="|E| experiments" v={String(lstar.finalE)} />
          </div>

          {learnedLayout && (
            <div className="graph-pane learn-graph">
              <div className="pane-head graph-head">
                <div>
                  <h2>The reconstructed DFA</h2>
                  <p>
                    Built only from yes/no answers — never from the regex. It includes the explicit reject sink the
                    minimiser usually drops; minimise it and you land on the studio's own {lstar.targetStates}-state
                    canonical machine.
                  </p>
                </div>
              </div>
              <AutomatonGraph layout={learnedLayout} accent="#c084fc" />
            </div>
          )}

          {lstar.table && (
            <>
              <h4 className="learn-h4">The observation table at termination</h4>
              <p className="muted-note">
                Rows are access strings (top: <strong>S</strong>; bottom: the one-step boundary <strong>S·Σ</strong>),
                columns are distinguishing experiments <strong>E</strong>. A cell is <code>+</code> if{' '}
                <em>row·experiment</em> is in the language. Each <em>distinct row pattern</em> is one state of the
                learned DFA — that is the Myhill–Nerode theorem made tangible.
              </p>
              <div className="count-table learn-table">
                <table>
                  <thead>
                    <tr>
                      <th>access \ E</th>
                      {lstar.table.E.map((e, i) => (
                        <th key={i}>
                          <code>{e}</code>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lstar.table.topRows.map((r, i) => (
                      <tr key={`s${i}`} className="learn-row-s">
                        <td>
                          <code>{r.access}</code>
                        </td>
                        {r.signature.split('').map((b, j) => (
                          <td key={j} className={b === '1' ? 'cell-yes' : 'cell-no'}>
                            {b === '1' ? '+' : '−'}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {lstar.table.bottomRows.map((r, i) => (
                      <tr key={`b${i}`} className="learn-row-b">
                        <td>
                          <code>{r.access}</code>
                        </td>
                        {r.signature.split('').map((b, j) => (
                          <td key={j} className={b === '1' ? 'cell-yes' : 'cell-no'}>
                            {b === '1' ? '+' : '−'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h4 className="learn-h4">Conjectures &amp; counterexamples</h4>
              <div className="learn-rounds">
                {lstar.rounds.map((r, i) => (
                  <div key={i} className="learn-round">
                    <span className="learn-round-n">#{i + 1}</span>
                    <span className="learn-round-body">
                      conjectured a <strong>{r.hypStates}</strong>-state DFA after{' '}
                      {r.membershipSoFar.toLocaleString()} membership queries —{' '}
                      {r.counterexample === null ? (
                        <span className="learn-accept">accepted ✓</span>
                      ) : (
                        <>
                          rejected, counterexample <code className="learn-cx">"{r.counterexample}"</code>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>

              <details className="learn-trace-wrap">
                <summary>full trace ({lstar.log.length} events)</summary>
                <ol className="learn-trace">
                  {lstar.log.map((e, i) => (
                    <li key={i} className={`learn-ev learn-ev-${e.kind}`}>
                      <span className="learn-ev-kind">{e.kind}</span> {e.detail}
                    </li>
                  ))}
                </ol>
              </details>
            </>
          )}
        </>
      )}

      {/* ---------------- RPNI (passive) ---------------- */}
      <h3 className="lang-h3">RPNI — passive learning from labelled data</h3>
      <p className="muted-note">
        No questions allowed: RPNI is handed a fixed bag of labelled strings and merges the states of their prefix-tree
        acceptor, lowest-first, accepting any merge that doesn't make a negative example accepted. A <em>complete</em>{' '}
        sample of every string up to length L is characteristic, so RPNI provably recovers the exact target — here we grow
        L until it does (or the sample gets too big).
      </p>
      {rpni && rpni.dfa ? (
        <>
          <div className="learn-verdicts">
            <span className={`lang-badge ${rpni.exact ? 'good' : 'bad'}`}>
              {rpni.exact ? `recovered the exact ${rpni.targetStates}-state target ✓` : 'sample too small to recover exactly'}
            </span>
          </div>
          <div className="fuzz-stats">
            <St k="sample depth L" v={`≤ ${rpni.maxLen}`} />
            <St k="positive examples" v={rpni.positives.toLocaleString()} />
            <St k="negative examples" v={rpni.negatives.toLocaleString()} />
            <St k="prefix-tree states" v={rpni.ptaStates.toLocaleString()} />
            <St k="after merging" v={String(rpni.learnedStates)} />
            <St k="target states" v={String(rpni.targetStates)} />
          </div>
          {!rpni.exact && rpni.witness && (
            <p className="muted-note">
              Within the length cap the inferred DFA still differs from the target — first disagreement on{' '}
              <code>"{rpni.witness}"</code>. A larger characteristic sample would close the gap (RPNI is correct in the
              limit).
            </p>
          )}
        </>
      ) : (
        <div className="learn-abort">Alphabet too large for a complete sample within the cap.</div>
      )}

      {/* ---------------- the house-style cross-check ---------------- */}
      <CrossCheck />
    </div>
  );
}

function CrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_LEARN_FUZZ.seed);
  const [patterns, setPatterns] = useState(DEFAULT_LEARN_FUZZ.patterns);
  const [report, setReport] = useState<LearnFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      const r = runLearnFuzz({ seed: nextSeed, patterns, runRpni: true });
      setReport(r);
      setRunning(false);
    }, 0);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check the learners</h3>
      <p className="muted-note">
        A seeded fuzzer draws random regular patterns, compiles each to its minimal DFA, and confirms that L*
        reconstructs a DFA that is <strong>equivalent</strong> to the target <strong>and</strong> has exactly the same
        number of states (so it learns the studio's own minimal DFA, not just <em>some</em> equivalent machine), and that
        RPNI recovers it from a complete sample. Any disagreement is a real bug, reported with the pattern.
      </p>
      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <label className="fuzz-field">
          <span>patterns</span>
          <input
            type="number"
            min={10}
            max={2000}
            value={patterns}
            onChange={(e) => setPatterns(Math.max(10, Math.min(2000, Number(e.target.value) | 0)))}
          />
        </label>
        <button className="fuzz-run" disabled={running} onClick={() => run(seed)}>
          {running ? 'running…' : 'run'}
        </button>
        <button className="fuzz-run secondary" disabled={running} onClick={() => run((Math.random() * 2 ** 31) | 0)}>
          new seed
        </button>
      </div>

      {!report && !running && (
        <div className="placeholder">Press <strong>run</strong> to learn hundreds of random languages and verify each.</div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.failures.length === 0 ? 'ok' : 'bad'}`}>
            {report.failures.length === 0 ? (
              <>
                <span className="fuzz-big">✓ every language learned correctly</span>
                <span className="fuzz-sub">
                  {report.patternsTested.toLocaleString()} random patterns — L* recovered the exact minimal DFA every
                  time; RPNI recovered {report.rpniRecovered}/{report.rpniAttempted}. {report.elapsedMs} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failures.length} failure(s)</span>
                <span className="fuzz-sub">A learner produced a wrong automaton — the trigger pattern is below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="patterns" v={report.patternsTested.toLocaleString()} />
            <St k="max DFA states" v={String(report.maxStates)} />
            <St k="max membership Q" v={report.maxMembership.toLocaleString()} />
            <St k="max equivalence Q" v={String(report.maxEquivalence)} />
            <St k="total membership Q" v={report.totalMembership.toLocaleString()} />
            <St k="RPNI recovered" v={`${report.rpniRecovered}/${report.rpniAttempted}`} />
            <St k="time" v={`${report.elapsedMs} ms`} />
            <St k="seed" v={String(report.config.seed)} />
          </div>
          {report.failures.length > 0 && (
            <div className="fuzz-counter">
              <h3>Failures</h3>
              {report.failures.slice(0, 8).map((f, i) => (
                <div key={i} className="fuzz-cx-row">
                  <code className="fuzz-cx-val">/{f.pattern}/</code>
                  <span className="learn-fail-reason">{f.reason}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

function St({ k, v }: { k: string; v: string }) {
  return (
    <div className="fuzz-stat">
      <span className="fuzz-stat-v">{v}</span>
      <span className="fuzz-stat-k">{k}</span>
    </div>
  );
}
