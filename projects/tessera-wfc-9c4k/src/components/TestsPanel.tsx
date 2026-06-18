import { useCallback, useState } from 'react';
import { runAllTests, testCount, type TestGroup } from '../wfc/tests';

/**
 * Proof Lab — runs the in-app verification suite (the real solver + the connectivity engine,
 * cross-checked against brute force) and shows the verdict. Mirrors the house style of the other
 * engine projects: correctness you can re-run yourself, not just claim.
 */
export default function TestsPanel() {
  const [groups, setGroups] = useState<TestGroup[] | null>(null);
  const [running, setRunning] = useState(false);
  const [ms, setMs] = useState(0);

  const run = useCallback(() => {
    setRunning(true);
    // defer so the button can paint its "running" state before the (synchronous) suite blocks
    setTimeout(() => {
      const t0 = performance.now();
      const g = runAllTests();
      setMs(Math.round(performance.now() - t0));
      setGroups(g);
      setRunning(false);
    }, 16);
  }, []);

  const tally = groups ? testCount(groups) : null;
  const allPass = tally ? tally.passed === tally.total : false;

  return (
    <section className="panel proof">
      <header className="panel-head">
        <h2>Proof Lab</h2>
        {tally && (
          <span className={`badge ${allPass ? 'badge-done' : 'badge-failed'}`}>
            {tally.passed}/{tally.total} {allPass ? 'green' : 'failing'}
          </span>
        )}
      </header>
      <p className="blurb">
        Re-run the verification suite: the connectivity algorithms are cross-checked against
        brute-force references over 1,500 random graphs, and the real solver must prove its global
        guarantees — determinism, valid adjacency, one connected network, routed terminals.
      </p>
      <button className="btn btn-wide" onClick={run} disabled={running} type="button">
        {running ? 'Running…' : groups ? 'Re-run verification' : 'Run verification'}
      </button>
      {groups && (
        <>
          <p className="proof-time">{ms} ms</p>
          {groups.map((g) => (
            <div key={g.group} className="proof-group">
              <h3>{g.group}</h3>
              <ul>
                {g.results.map((r) => (
                  <li key={r.name} className={r.pass ? 'ok' : 'bad'}>
                    <span className="proof-mark">{r.pass ? '✓' : '✕'}</span>
                    <span className="proof-name">{r.name}</span>
                    <span className="proof-detail">{r.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
