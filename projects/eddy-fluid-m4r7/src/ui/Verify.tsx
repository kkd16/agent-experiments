// Verify.tsx — runs the numerical verification suite and shows the results.
//
// A solver you can't check is a solver you can't trust. This page runs the same
// invariant + closed-form checks the project's `selftest.ts` defines, live, in
// the browser, and reports each one with the number it measured.

import { useEffect, useState } from 'react';
import { runSelfTest, type SelfTestReport } from '../sim/selftest';

export function Verify() {
  const [report, setReport] = useState<SelfTestReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = () => {
    setRunning(true);
    // Defer so the button can show its running state before the (sync) work.
    window.setTimeout(() => {
      setReport(runSelfTest());
      setRunning(false);
    }, 20);
  };

  // Run once on mount — scheduled (not synchronous) so it doesn't setState in the
  // effect body, and cleaned up if we unmount first.
  useEffect(() => {
    const id = window.setTimeout(() => setReport(runSelfTest()), 30);
    return () => window.clearTimeout(id);
  }, []);

  const allPass = report ? report.passed === report.total : false;

  return (
    <div className="verify">
      <div className="verify-inner">
        <div className="verify-head">
          <h1>Verification suite</h1>
          <button type="button" className="primary" onClick={run} disabled={running}>
            {running ? 'Running…' : 'Re-run checks'}
          </button>
        </div>
        <p className="lede">
          Every operator in the solver has an invariant it must obey or a closed-form answer it must
          match. These checks build small, deterministic solvers and assert those properties
          directly — no eyeballing pixels. Green means the maths is sound.
        </p>

        {report && (
          <div className={`verify-summary ${allPass ? 'ok' : 'bad'}`}>
            <strong>
              {report.passed} / {report.total} checks passed
            </strong>
            <span>{report.ms.toFixed(0)} ms</span>
          </div>
        )}

        {report?.groups.map((g) => (
          <section key={g.title} className="verify-group">
            <h2>{g.title}</h2>
            <p className="verify-blurb">{g.blurb}</p>
            {g.checks.map((c) => (
              <div key={c.name} className={`verify-check ${c.pass ? 'pass' : 'fail'}`}>
                <div className="verify-check-head">
                  <span className="verify-badge">{c.pass ? '✓' : '✕'}</span>
                  <span className="verify-name">{c.name}</span>
                  <span className="verify-measured">{c.measured}</span>
                </div>
                <p className="verify-detail">{c.detail}</p>
              </div>
            ))}
          </section>
        ))}

        <a className="back" href="#/">
          ← Back to the studio
        </a>
      </div>
    </div>
  );
}
