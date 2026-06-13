// "Self-test" view: runs the engine's own test suite in-browser and reports
// pass/fail per case. This is the same suite the project runs head-less in CI.

import { useMemo, useState } from 'react'
import { runTests, type TestResult } from '../db/tests'

export function TestsPanel() {
  const [nonce, setNonce] = useState(0)
  const results = useMemo<TestResult[]>(() => runTests(), [])
  // `nonce` re-runs on demand.
  void nonce

  const groups = useMemo(() => {
    const m = new Map<string, TestResult[]>()
    for (const r of results) {
      const list = m.get(r.group) ?? []
      list.push(r)
      m.set(r.group, list)
    }
    return [...m.entries()]
  }, [results])

  const passed = results.filter((r) => r.pass).length

  return (
    <div className="tests-view">
      <div className="tests-summary">
        <div className={`tests-score ${passed === results.length ? 'all-pass' : 'has-fail'}`}>
          {passed} / {results.length} passing
        </div>
        <p className="tests-blurb">
          These assertions exercise the lexer, parser, three-valued logic, joins, aggregation, the index
          planner, and transactions — the very same engine build this page runs.
        </p>
        <button className="btn" onClick={() => setNonce((n) => n + 1)}>
          Re-run
        </button>
      </div>
      <div className="tests-groups">
        {groups.map(([group, list]) => (
          <div key={group} className="tests-group">
            <h4 className="tests-group-title">
              {group} <span className="tests-group-count">{list.filter((l) => l.pass).length}/{list.length}</span>
            </h4>
            {list.map((r) => (
              <div key={r.name} className={`test-row ${r.pass ? 'pass' : 'fail'}`}>
                <span className="test-mark">{r.pass ? '✓' : '✕'}</span>
                <span className="test-name">{r.name}</span>
                {!r.pass && <span className="test-detail">{r.detail}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
