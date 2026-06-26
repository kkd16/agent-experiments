import { useState } from 'react';
import { runSelfTests, type TestResult } from '../lib/selftest';

export function SelfTestLab() {
  // Run once at mount (during the lazy initializer — no effect needed).
  const [results, setResults] = useState<TestResult[]>(() => runSelfTests());
  const [running, setRunning] = useState(false);

  const rerun = () => {
    setRunning(true);
    // let the button paint its "running" state before the synchronous suite runs
    requestAnimationFrame(() => {
      const r = runSelfTests();
      setResults(r);
      setRunning(false);
    });
  };

  const groups = [...new Set(results.map((r) => r.group))];
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const allOk = passed === total;

  return (
    <div className="lab">
      <div className="lab-intro">
        <h2>Self-tests</h2>
        <p>
          The whole simulator is only worth anything if the kernel is truly deterministic and the
          protocols truly uphold their invariants. This suite proves both — including randomized
          chaos runs that subject Raft, Paxos and <b>PBFT</b> to over a thousand crashes, restarts and
          partitions (with an actively-equivocating Byzantine primary in PBFT's case) and assert every
          safety property holds throughout. It runs live, right here in your browser.
        </p>
      </div>

      <div className="selftest-summary">
        <span className={`status-pill ${allOk ? 'ok' : 'bad'}`}>
          {passed}/{total} passing
        </span>
        <button className="btn primary" onClick={rerun} disabled={running}>
          {running ? 'Running…' : '↻ Re-run suite'}
        </button>
      </div>

      <div className="selftest-groups">
        {groups.map((g) => (
          <div className="selftest" key={g}>
            <div className="panel-head">
              <span>{g}</span>
              <span className="muted" style={{ fontWeight: 400, fontSize: '0.75rem' }}>
                {results.filter((r) => r.group === g && r.ok).length}/{results.filter((r) => r.group === g).length}
              </span>
            </div>
            {results
              .filter((r) => r.group === g)
              .map((r) => (
                <div className={`selftest-row ${r.ok ? 'ok' : 'bad'}`} key={r.name}>
                  <span className="mark">{r.ok ? '✓' : '✕'}</span>
                  <span className="st-name">{r.name}</span>
                  <span className="detail">{r.detail}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
