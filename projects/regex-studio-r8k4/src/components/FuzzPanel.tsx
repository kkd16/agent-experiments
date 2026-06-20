import { useState } from 'react';
import { DEFAULT_FUZZ, runFuzz, type FuzzReport } from '../engine/fuzz';

// The differential-testing console: draw random regular patterns + strings from
// a seeded PRNG and confirm every engine returns the same verdict. Reproducible
// by seed; one disagreement is a real bug, surfaced with its exact trigger.

export function FuzzPanel() {
  const [seed, setSeed] = useState(DEFAULT_FUZZ.seed);
  const [trials, setTrials] = useState(DEFAULT_FUZZ.trials);
  const [report, setReport] = useState<FuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    // Defer to the next frame so the "running…" state can paint first.
    setTimeout(() => {
      const r = runFuzz({ ...DEFAULT_FUZZ, seed: nextSeed, trials });
      setReport(r);
      setRunning(false);
    }, 0);
  };

  return (
    <div className="fuzz-panel">
      <div className="pane-head">
        <h2>Differential fuzzer</h2>
        <p>
          Ten independent engines — nine hand-written here, plus the platform's own <code>RegExp</code> as an
          external oracle — are asked the same membership question on thousands of random pattern/string pairs. They
          must all agree. The PRNG is seeded, so every run reproduces exactly.
        </p>
      </div>

      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value) | 0)}
            spellCheck={false}
          />
        </label>
        <label className="fuzz-field">
          <span>patterns</span>
          <input
            type="number"
            min={10}
            max={2000}
            value={trials}
            onChange={(e) => setTrials(Math.max(10, Math.min(2000, Number(e.target.value) | 0)))}
          />
        </label>
        <button className="fuzz-run" disabled={running} onClick={() => run(seed)}>
          {running ? 'running…' : 'run'}
        </button>
        <button className="fuzz-run secondary" disabled={running} onClick={() => run((Math.random() * 2 ** 31) | 0)}>
          new seed
        </button>
      </div>

      <div className="fuzz-engines">
        {['subset DFA', 'derivative DFA', 'streaming D', 'Antimirov DFA', 'partial D', 'Glushkov DFA', 'position NFA', 'Pike VM', 'backtracking VM', 'RegExp oracle'].map((n) => (
          <span key={n} className="fuzz-engine-chip">
            {n}
          </span>
        ))}
      </div>

      {!report && !running && (
        <div className="placeholder">Press <strong>run</strong> to cross-check every engine on random inputs.</div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.agreed ? 'ok' : 'bad'}`}>
            {report.agreed ? (
              <>
                <span className="fuzz-big">✓ all engines agree</span>
                <span className="fuzz-sub">
                  {report.checks.toLocaleString()} membership checks across {report.patterns.toLocaleString()} random
                  patterns — no disagreement. {report.elapsedMs} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ disagreement found</span>
                <span className="fuzz-sub">An engine returned a different verdict — the trigger is below.</span>
              </>
            )}
          </div>

          <div className="fuzz-stats">
            <Stat k="patterns" v={report.patterns.toLocaleString()} />
            <Stat k="checks" v={report.checks.toLocaleString()} />
            <Stat k="engines" v={String(report.engines.length)} />
            <Stat k="VM aborts (ReDoS)" v={report.aborts.toLocaleString()} />
            <Stat k="time" v={`${report.elapsedMs} ms`} />
            <Stat k="seed" v={String(report.config.seed)} />
          </div>

          {report.disagreement && (
            <div className="fuzz-counter">
              <h3>Counterexample</h3>
              <div className="fuzz-cx-row">
                <span className="fuzz-cx-key">pattern</span>
                <code className="fuzz-cx-val">/{report.disagreement.pattern}/</code>
              </div>
              <div className="fuzz-cx-row">
                <span className="fuzz-cx-key">input</span>
                <code className="fuzz-cx-val">"{report.disagreement.input}"</code>
              </div>
              <table className="fuzz-cx-table">
                <thead>
                  <tr>
                    <th>engine</th>
                    <th>verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {report.disagreement.results.map((r) => (
                    <tr key={r.engine}>
                      <td>{r.engine}</td>
                      <td>
                        <span className={`fuzz-pill ${r.verdict === 'error' ? 'err' : r.verdict ? 'yes' : 'no'}`}>
                          {r.verdict === 'error' ? 'threw' : r.verdict ? 'match' : 'no match'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="muted-note">
            The fuzzer restricts itself to the regular subset where our engines and JS <code>RegExp</code> agree on
            whole-string membership (literals, <code>.</code>, <code>\d</code>, classes, grouping, alternation and the
            four quantifiers). A backtracking-VM run that hits its step limit is a ReDoS blow-up, not a wrong answer, so
            it is skipped rather than counted ({report.aborts.toLocaleString()} this run).
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="fuzz-stat">
      <span className="fuzz-stat-v">{v}</span>
      <span className="fuzz-stat-k">{k}</span>
    </div>
  );
}
