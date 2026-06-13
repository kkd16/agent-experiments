import type { PipelineResult } from '../lang/pipeline.ts'
import { valueToString } from '../lang/values.ts'

interface Props {
  result: PipelineResult | null
  hasRun: boolean
}

export default function OutputView({ result, hasRun }: Props) {
  if (!result) {
    return <div className="panel-empty">Press Run (⌘/Ctrl ↵) to evaluate your program.</div>
  }

  if (result.error) {
    const { stage, message, span } = result.error
    return (
      <div className="output-view">
        <div className="run-error">
          <span className="err-stage">{stage} error</span>
          {span && span.line > 0 && <span className="err-loc">line {span.line}:{span.col}</span>}
          <div className="err-msg">{message}</div>
        </div>
      </div>
    )
  }

  const run = result.run
  return (
    <div className="output-view">
      <div className="result-line">
        <span className="result-label">result</span>
        <code className="result-value">
          {run?.result ? valueToString(run.result) : '()'}
        </code>
        {result.programType && <span className="result-type">: {result.programType}</span>}
      </div>

      {run && run.output.length > 0 && (
        <div className="stdout">
          <div className="stdout-head">stdout</div>
          <pre>{run.output.join('\n')}</pre>
        </div>
      )}

      {run && (
        <div className="run-stats">
          {run.steps.toLocaleString()} VM steps
          {run.effects.length > 0 && <> · {run.effects.length.toLocaleString()} draw commands</>}
        </div>
      )}

      {!hasRun && <div className="panel-empty">Press Run to evaluate.</div>}
    </div>
  )
}
