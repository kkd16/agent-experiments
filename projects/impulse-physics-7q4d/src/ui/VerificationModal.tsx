import { useMemo } from 'react';
import { runVerification, type CheckResult } from '../verify/suite';

/** Overlay that runs the engine's correctness suite live and shows results. */
export default function VerificationModal({ onClose }: { onClose: () => void }) {
  const results = useMemo(() => runVerification(), []);
  const passed = results.filter((r) => r.passed).length;
  const groups = useMemo(() => groupBy(results), [results]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Engine verification</h2>
            <p className="modal-sub">
              Every check exercises a real engine path — mass integrals, GJK/EPA, manifolds,
              conservation laws, determinism, broadphase and ray casting.
            </p>
          </div>
          <div className={`verdict${passed === results.length ? ' ok' : ' bad'}`}>
            {passed}/{results.length} passing
          </div>
        </header>
        <div className="modal-body">
          {[...groups.entries()].map(([group, items]) => (
            <div className="verify-group" key={group}>
              <h3>{group}</h3>
              {items.map((r) => (
                <div className={`verify-row${r.passed ? ' pass' : ' fail'}`} key={r.name}>
                  <span className="verify-mark">{r.passed ? '✓' : '✕'}</span>
                  <span className="verify-name">{r.name}</span>
                  <span className="verify-detail">{r.detail}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <footer className="modal-foot">
          <button className="btn primary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}

function groupBy(results: CheckResult[]): Map<string, CheckResult[]> {
  const map = new Map<string, CheckResult[]>();
  for (const r of results) {
    const list = map.get(r.group) ?? [];
    list.push(r);
    map.set(r.group, list);
  }
  return map;
}
