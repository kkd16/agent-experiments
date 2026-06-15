// The live self-test suite for the color engine. Conversions must round-trip, reference values
// must match, and the interpolation / gamut / vision invariants must hold. Re-runnable; the same
// suite gates the build in dev.

import { useMemo, useState } from 'react'
import { runTests, summarize } from '../color/selftest'

export function Tests() {
  const [nonce, setNonce] = useState(0)
  // Re-run when the nonce changes (the suite is deterministic, so this just re-executes it).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const results = useMemo(() => runTests(), [nonce])
  const { passed, total } = summarize(results)
  const groups = [...new Set(results.map((r) => r.group))]
  const allPass = passed === total

  return (
    <div className="tests-page">
      <div className="tests-head">
        <div className={`tests-score ${allPass ? 'good' : 'bad'}`}>
          {passed} / {total} passing
        </div>
        <button className="btn ghost" onClick={() => setNonce((n) => n + 1)}>
          Re-run
        </button>
      </div>
      {groups.map((group) => (
        <section className="card test-group" key={group}>
          <h3>{group}</h3>
          <ul className="test-list">
            {results
              .filter((r) => r.group === group)
              .map((r, i) => (
                <li key={i} className={r.pass ? 'pass' : 'fail'}>
                  <span className="test-icon">{r.pass ? '✓' : '✕'}</span>
                  <span className="test-name">{r.name}</span>
                  <span className="test-detail">{r.detail}</span>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
