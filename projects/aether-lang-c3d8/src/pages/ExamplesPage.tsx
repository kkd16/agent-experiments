import { EXAMPLES } from '../examples.ts'
import { setPendingCode } from '../share.ts'
import { navigate } from '../router.ts'

export default function ExamplesPage() {
  const open = (code: string): void => {
    setPendingCode(code)
    navigate('/')
  }
  return (
    <div className="page examples-page">
      <h1>Examples</h1>
      <p className="page-lead">
        A spread of programs — recursion, higher-order functions, pure lambda-calculus encodings,
        and turtle graphics. Open any of them in the playground to run, inspect, and debug.
      </p>
      <div className="example-grid">
        {EXAMPLES.map((ex) => (
          <div className="example-card" key={ex.id}>
            <div className="example-card-head">
              <h3>{ex.title}</h3>
              {ex.visual && <span className="badge">visual</span>}
            </div>
            <p className="example-blurb">{ex.blurb}</p>
            <pre className="example-preview">{ex.code.trim().split('\n').slice(0, 8).join('\n')}</pre>
            <button className="btn primary" onClick={() => open(ex.code)}>
              Open in playground →
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
