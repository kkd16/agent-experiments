import { useMemo, useState } from 'react'
import { TEST_CASES, runSuite } from '../lang/testSuite.ts'
import type { TestResult } from '../lang/testSuite.ts'
import { runPropertySuite } from '../lang/propertySuite.ts'
import type { PropSelfResult } from '../lang/propertySuite.ts'

export default function Tests() {
  const [results, setResults] = useState<TestResult[] | null>(null)
  const [propResults, setPropResults] = useState<PropSelfResult[] | null>(null)
  const [running, setRunning] = useState(false)

  const run = (): void => {
    setRunning(true)
    // let the button paint its "running" state before the (synchronous) suite
    setTimeout(() => {
      setResults(runSuite())
      setPropResults(runPropertySuite())
      setRunning(false)
    }, 10)
  }

  const summary = useMemo(() => {
    if (!results) return null
    const passed = results.filter((r) => r.ok).length
    return { passed, total: results.length }
  }, [results])

  const groups = useMemo(() => {
    const order: string[] = []
    for (const c of TEST_CASES) if (!order.includes(c.group)) order.push(c.group)
    return order
  }, [])

  return (
    <div className="page tests-page">
      <h1>Self-tests</h1>
      <p className="page-lead">
        {TEST_CASES.length} cases run through the entire pipeline — lexer, parser, Hindley–Milner
        inference, type-class resolution, dictionary-passing elaboration, bytecode compilation and
        the VM. Every case that produces a value is <em>also</em> compiled to JavaScript and run, so
        a green row proves the <strong>two backends agree</strong>. It all runs in your browser.
      </p>

      <div className="tests-toolbar">
        <button className="btn primary" onClick={run} disabled={running}>
          {running ? 'running…' : results ? '↻ Run again' : '▶ Run all tests'}
        </button>
        {summary && (
          <span className={`tests-badge ${summary.passed === summary.total ? 'ok' : 'bad'}`}>
            {summary.passed} / {summary.total} passing
          </span>
        )}
      </div>

      {results && (
        <div className="tests-results">
          {groups.map((g) => {
            const rows = results.filter((r) => r.group === g)
            if (rows.length === 0) return null
            const gp = rows.filter((r) => r.ok).length
            return (
              <div className="tests-group" key={g}>
                <h3 className="tests-group-head">
                  {g} <span className="tests-group-count">{gp}/{rows.length}</span>
                </h3>
                <table className="tests-table">
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.name} className={r.ok ? 'pass' : 'fail'}>
                        <td className="tests-mark">{r.ok ? '✓' : '✗'}</td>
                        <td className="tests-name">{r.name}</td>
                        <td className="tests-detail">
                          <code>{r.detail}</code>
                          {r.type && <span className="tests-type"> : {r.type}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      )}

      {propResults && (
        <div className="tests-results">
          <div className="tests-group">
            <h3 className="tests-group-head">
              Aether Check — engine self-tests{' '}
              <span className="tests-group-count">
                {propResults.filter((r) => r.ok).length}/{propResults.length}
              </span>
            </h3>
            <p className="panel-note tiny">
              These assert the property engine itself: true laws pass, false ones are falsified and
              shrunk, runtime crashes are caught with the offending input, recursive ADTs generate &
              terminate, and even <em>function</em> arguments are generated (higher-order laws).
            </p>
            <table className="tests-table">
              <tbody>
                {propResults.map((r) => (
                  <tr key={r.name} className={r.ok ? 'pass' : 'fail'}>
                    <td className="tests-mark">{r.ok ? '✓' : '✗'}</td>
                    <td className="tests-name">{r.name}</td>
                    <td className="tests-detail">
                      <code>{r.detail}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!results && (
        <p className="panel-note">Press “Run all tests” to execute the suite live.</p>
      )}
    </div>
  )
}
