import { useMemo, useState } from 'react'
import { runSelfTests } from '../engine/selftest'
import type { TestResult } from '../engine/selftest'

/** Runs the engine's assertion suite in-browser and renders a green/red report. */
export default function SelfTestPanel() {
  // Held in state so "Re-run" re-executes the suite (e.g. to re-roll RAND paths).
  const [results, setResults] = useState<TestResult[]>(() => runSelfTests())

  const groups = useMemo(() => {
    const map = new Map<string, TestResult[]>()
    for (const t of results) {
      if (!map.has(t.group)) map.set(t.group, [])
      map.get(t.group)!.push(t)
    }
    return [...map.entries()]
  }, [results])

  const passed = results.filter((t) => t.pass).length
  const total = results.length
  const allGreen = passed === total

  return (
    <div className="panel selftest">
      <div className="panel-head">
        <h3>Engine self-test</h3>
        <span className={allGreen ? 'badge ok' : 'badge bad'}>
          {passed}/{total} passing
        </span>
      </div>
      <button className="btn small" onClick={() => setResults(runSelfTests())}>
        Re-run
      </button>
      <div className="selftest-groups">
        {groups.map(([group, tests]) => {
          const ok = tests.filter((t) => t.pass).length
          return (
            <details key={group} open={ok !== tests.length}>
              <summary>
                <span className={ok === tests.length ? 'dot ok' : 'dot bad'} /> {group}
                <span className="muted">
                  {' '}
                  {ok}/{tests.length}
                </span>
              </summary>
              <ul>
                {tests.map((t, i) => (
                  <li key={i} className={t.pass ? 'pass' : 'fail'}>
                    <span className="mark">{t.pass ? '✓' : '✗'}</span> {t.name}
                    {!t.pass && t.detail ? <span className="detail"> — {t.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          )
        })}
      </div>
    </div>
  )
}
