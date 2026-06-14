import { useMemo, useState } from 'react'
import type { Expr } from '../../lang/ast.ts'
import { compileToJs, runJsModule } from '../../lang/jsBackend.ts'
import type { JsRunResult } from '../../lang/jsBackend.ts'
import { runPipeline } from '../../lang/pipeline.ts'
import { valueToString } from '../../lang/values.ts'

interface Props {
  ast: Expr | null
  /** the current editor source, for running the VM side-by-side */
  code: string
  optimize: boolean
}

interface Comparison {
  js: JsRunResult
  vmResult: string | null
  vmOutput: string[]
  vmEffects: number
  matches: boolean
}

export default function JsPanel({ ast, code, optimize }: Props) {
  const mod = useMemo(() => (ast ? compileToJs(ast) : null), [ast])
  const [cmp, setCmp] = useState<Comparison | null>(null)
  const [showRuntime, setShowRuntime] = useState(false)

  // re-running is cheap; we always recompute against the live source
  const run = (): void => {
    if (!ast) return
    const fresh = compileToJs(ast)
    const js = runJsModule(fresh.full)
    const vm = runPipeline(code, { execute: true, optimize })
    const vmResult = vm.run?.result ? valueToString(vm.run.result) : vm.error ? null : '()'
    const vmOutput = vm.run?.output ?? []
    const vmEffects = vm.run?.effects.length ?? 0
    const matches =
      js.error === null &&
      js.result === vmResult &&
      JSON.stringify(js.output) === JSON.stringify(vmOutput) &&
      js.effects.length === vmEffects
    setCmp({ js, vmResult, vmOutput, vmEffects, matches })
  }

  if (!ast || !mod) return <div className="panel-empty">No JavaScript — fix the error first.</div>

  return (
    <div className="js-panel">
      <p className="panel-note">
        A second backend: the same typed AST is lowered to self-contained JavaScript and run in
        your browser. A tiny runtime mirrors the VM's value model exactly, so the result, printed
        output and turtle drawing match the bytecode VM byte-for-byte.
      </p>

      <div className="js-toolbar">
        <button className="btn primary" onClick={run}>
          ▶ Run JavaScript &amp; compare
        </button>
        {cmp && (
          <span className={`js-badge ${cmp.matches ? 'ok' : 'bad'}`}>
            {cmp.matches ? '✓ matches the VM' : '✗ differs from the VM'}
          </span>
        )}
      </div>

      {cmp && (
        <div className="js-run">
          {cmp.js.error ? (
            <div className="run-error">
              <span className="err-stage">runtime error</span>
              <div className="err-msg">{cmp.js.error}</div>
            </div>
          ) : (
            <>
              <div className="js-cols">
                <div className="js-col">
                  <div className="js-col-head">JavaScript backend</div>
                  <div className="result-line">
                    <span className="result-label">result</span>
                    <code className="result-value">{cmp.js.result}</code>
                  </div>
                  {cmp.js.output.length > 0 && <pre className="js-out">{cmp.js.output.join('\n')}</pre>}
                  {cmp.js.effects.length > 0 && (
                    <div className="run-stats">{cmp.js.effects.length.toLocaleString()} draw commands</div>
                  )}
                </div>
                <div className="js-col">
                  <div className="js-col-head">bytecode VM</div>
                  <div className="result-line">
                    <span className="result-label">result</span>
                    <code className="result-value">{cmp.vmResult ?? '—'}</code>
                  </div>
                  {cmp.vmOutput.length > 0 && <pre className="js-out">{cmp.vmOutput.join('\n')}</pre>}
                  {cmp.vmEffects > 0 && (
                    <div className="run-stats">{cmp.vmEffects.toLocaleString()} draw commands</div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <div className="js-code-block">
        <div className="js-code-head">generated JavaScript — your program</div>
        <pre className="js-code">{mod.user}</pre>
      </div>

      <button className="js-disclose" onClick={() => setShowRuntime((s) => !s)}>
        {showRuntime ? '▾' : '▸'} runtime &amp; standard library ({mod.runtime.split('\n').length +
          mod.prelude.split('\n').length}{' '}
        lines)
      </button>
      {showRuntime && (
        <>
          <div className="js-code-block">
            <div className="js-code-head">runtime</div>
            <pre className="js-code dim">{mod.runtime}</pre>
          </div>
          <div className="js-code-block">
            <div className="js-code-head">standard library (compiled)</div>
            <pre className="js-code dim">{mod.prelude}</pre>
          </div>
        </>
      )}
    </div>
  )
}
