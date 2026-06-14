// SelfTests.tsx — the verification view. Runs the engine's invariant checks and
// reports them, so a visitor can confirm the renderer is provably correct rather
// than merely plausible-looking.

import { useState } from 'react'
import { runSelfTests } from '../../engine/selftest'
import type { TestResult } from '../../engine/selftest'

export function SelfTests() {
  const [results, setResults] = useState<TestResult[] | null>(null)
  const [running, setRunning] = useState(false)
  const [ms, setMs] = useState(0)

  const run = () => {
    setRunning(true)
    setResults(null)
    // Defer so the "running" state paints before the (blocking) test sweep.
    setTimeout(() => {
      const t0 = performance.now()
      const r = runSelfTests()
      setMs(performance.now() - t0)
      setResults(r)
      setRunning(false)
    }, 30)
  }

  const passCount = results ? results.filter((r) => r.pass).length : 0
  const allPass = results ? passCount === results.length : false

  return (
    <div className="verify">
      <div className="verify-intro">
        <h2>Verification suite</h2>
        <p>
          A path tracer is only as trustworthy as its math. These checks assert the invariants a
          correct renderer must satisfy — energy conservation (white-furnace), exact BVH-vs-brute-force
          agreement, sampler/pdf consistency, and the analytic Fresnel &amp; Snell laws. No pixels are
          judged by eye.
        </p>
        <button className="btn primary" onClick={run} disabled={running} type="button">
          {running ? 'Running…' : 'Run verification'}
        </button>
        {results && (
          <span className={allPass ? 'verdict ok' : 'verdict bad'}>
            {passCount}/{results.length} passed · {ms.toFixed(0)} ms
          </span>
        )}
      </div>

      {results && (
        <ul className="test-list">
          {results.map((r) => (
            <li key={r.name} className={r.pass ? 'test pass' : 'test fail'}>
              <span className="test-mark">{r.pass ? '✓' : '✕'}</span>
              <span className="test-name">{r.name}</span>
              <span className="test-detail">{r.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
