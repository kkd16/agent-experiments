import { useState } from 'react';
import { runSelfTest, type SelfTestReport } from '../engine/selftest';

// One-click proof that every hand-derived backward pass matches finite differences.
export default function SelfTestPanel() {
  const [report, setReport] = useState<SelfTestReport | null>(null);
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    // Defer so the button can show its busy state before the (sub-second) sync work runs.
    setTimeout(() => {
      setReport(runSelfTest(7));
      setBusy(false);
    }, 0);
  };

  return (
    <div className="selftest">
      <button className="ghost wide" onClick={run} disabled={busy}>
        {busy ? 'Checking…' : '⚙ Run engine self-test'}
      </button>
      {report && (
        <div className={`selftest-res ${report.passed ? 'ok' : 'warn'}`}>
          <div className="selftest-head">
            {report.passed ? '✓' : '⚠'} {report.ops.length} ops · max rel err{' '}
            <b>{report.maxRelError.toExponential(2)}</b>
          </div>
          <div className="selftest-grid">
            {report.ops.map((o) => (
              <div className="selftest-row" key={o.name} title={`${o.checked} entries checked`}>
                <span className="op-name">{o.name}</span>
                <span className={o.maxRelError < 1e-4 ? 'op-ok' : 'op-warn'}>{o.maxRelError.toExponential(1)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
