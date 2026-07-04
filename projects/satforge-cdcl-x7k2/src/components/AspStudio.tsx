import { useMemo, useState } from 'react'
import './AspStudio.css'
import {
  parseProgram,
  ground,
  solveAsp,
  wellFoundedModel,
  buildCompletion,
  formatAnswerSet,
  runAspChecks,
  ASP_EXAMPLES,
  type GroundProgram,
  type AspSolveResult,
  type WellFounded,
} from '../asp'

const MAX_ENUM = 3000

interface Analysis {
  program: GroundProgram
  groundErrors: string[]
  result: AspSolveResult | null
  wfm: WellFounded | null
  completionClauses: number
  bodyVars: number
}

function analyze(code: string): { parseErrors: string[]; ruleCount: number; analysis: Analysis | null } {
  const parsed = parseProgram(code)
  const g = ground(parsed.rules)
  const comp = buildCompletion(g.program)
  const result =
    g.errors.length > 0
      ? null
      : solveAsp(g.program, { maxAnswerSets: MAX_ENUM, maxIterations: 400000, maxTimeMs: 8000 })
  const wfm = wellFoundedModel(g.program)
  return {
    parseErrors: parsed.errors,
    ruleCount: parsed.rules.length,
    analysis: {
      program: g.program,
      groundErrors: g.errors,
      result,
      wfm,
      completionClauses: comp.cnf.clauses.length,
      bodyVars: comp.numVars - g.program.numAtoms,
    },
  }
}

export function AspStudio() {
  const [code, setCode] = useState<string>(ASP_EXAMPLES[0].code)
  const [exampleId, setExampleId] = useState<string>(ASP_EXAMPLES[0].id)
  const [selected, setSelected] = useState<number>(0)
  const [selfTest, setSelfTest] = useState<{ pass: number; fail: number; ms: number } | null>(null)
  const [testing, setTesting] = useState(false)

  const { parseErrors, ruleCount, analysis } = useMemo(() => analyze(code), [code])
  const example = ASP_EXAMPLES.find((e) => e.id === exampleId)

  const loadExample = (id: string) => {
    const ex = ASP_EXAMPLES.find((e) => e.id === id)
    if (!ex) return
    setExampleId(id)
    setCode(ex.code)
    setSelected(0)
  }

  const runSelfTest = () => {
    setTesting(true)
    setTimeout(() => {
      const t0 = performance.now()
      const r = runAspChecks()
      setSelfTest({ pass: r.pass, fail: r.fail, ms: Math.round(performance.now() - t0) })
      setTesting(false)
    }, 20)
  }

  const result = analysis?.result ?? null
  const answerSets = result?.answerSets ?? []
  const sel = Math.min(selected, Math.max(0, answerSets.length - 1))
  const selSet = answerSets[sel] ?? []
  const selSetIds = new Set(selSet)
  const wfm = analysis?.wfm ?? null
  const wfTrue = new Set(wfm?.trueAtoms ?? [])
  const wfFalse = new Set(wfm?.falseAtoms ?? [])

  return (
    <div className="layout">
      <aside className="control asp-side">
        <p className="imc-blurb">
          <strong>Answer Set Programming</strong> — declarative problem solving under the{' '}
          <em>stable model semantics</em>. You describe <em>what</em> a solution looks like; the solver
          finds every set of atoms that is exactly self-justifying. It reuses SatForge's own CDCL core
          via Clark's completion and ASSAT-style loop formulas.
        </p>

        <div className="smt-examples asp-examples">
          <h3>Gallery</h3>
          {ASP_EXAMPLES.map((ex) => (
            <button
              key={ex.id}
              className={ex.id === exampleId ? 'active' : ''}
              onClick={() => loadExample(ex.id)}
              title={ex.blurb}
            >
              {ex.name}
            </button>
          ))}
        </div>

        <div className="asp-selftest">
          <h3>Correctness</h3>
          <p className="imc-note">
            The native solver is cross-checked against a brute-force Gelfond–Lifschitz reduct oracle on
            thousands of random programs — and every model it reports is independently re-verified.
          </p>
          <button onClick={runSelfTest} disabled={testing}>
            {testing ? 'Running…' : 'Run self-test'}
          </button>
          {selfTest && (
            <div className={`asp-test-result ${selfTest.fail === 0 ? 'ok' : 'bad'}`}>
              {selfTest.fail === 0 ? '✓' : '✗'} {selfTest.pass} passed, {selfTest.fail} failed
              <span className="asp-test-ms"> · {selfTest.ms} ms</span>
            </div>
          )}
        </div>
      </aside>

      <main className="content asp-content">
        <div className="problem-head">
          <div>
            <h2>ASP Studio</h2>
            <p className="subtitle">{example?.blurb ?? 'Write a logic program and enumerate its answer sets.'}</p>
          </div>
        </div>

        <div className="asp-editor">
          <textarea
            spellCheck={false}
            value={code}
            onChange={(e) => {
              setCode(e.target.value)
              setExampleId('')
              setSelected(0)
            }}
          />
        </div>

        {parseErrors.map((err, i) => (
          <div key={`p${i}`} className="banner error">
            ⚠ {err}
          </div>
        ))}
        {analysis?.groundErrors.map((err, i) => (
          <div key={`g${i}`} className="banner warn">
            {err}
          </div>
        ))}

        {ruleCount === 0 && parseErrors.length === 0 && (
          <div className="placeholder">Write some rules above to enumerate answer sets.</div>
        )}

        {result && ruleCount > 0 && (
          <>
            <div className="imc-cards asp-cards">
              <div className={`imc-card ${result.status === 'sat' ? 'asp-sat' : 'asp-unsat'}`}>
                <h3>Answer sets</h3>
                <div className="asp-bignum">
                  {result.count}
                  {!result.complete && <span className="asp-plus">+</span>}
                </div>
                <div className="asp-cardsub">
                  {result.status === 'unsat'
                    ? 'unsatisfiable — no stable model'
                    : result.complete
                      ? result.count === 1
                        ? 'a single stable model'
                        : 'stable models (complete enumeration)'
                      : `showing first ${result.count} (capped)`}
                </div>
              </div>

              <div className="imc-card">
                <h3>Ground program</h3>
                <div className="asp-statgrid">
                  <span>atoms</span>
                  <b>{analysis!.program.numAtoms}</b>
                  <span>rules</span>
                  <b>{analysis!.program.rules.length}</b>
                  <span>completion clauses</span>
                  <b>{analysis!.completionClauses}</b>
                  <span>body variables</span>
                  <b>{analysis!.bodyVars}</b>
                </div>
              </div>

              <div className="imc-card">
                <h3>How it solved it</h3>
                <div className="asp-statgrid">
                  <span>CDCL re-solves</span>
                  <b>{result.stats.iterations}</b>
                  <span>supported models seen</span>
                  <b>{result.stats.supportedModels}</b>
                  <span>loop formulas added</span>
                  <b className={result.stats.loopFormulas > 0 ? 'asp-hl' : ''}>{result.stats.loopFormulas}</b>
                  <span>time</span>
                  <b>{result.stats.timeMs} ms</b>
                </div>
              </div>
            </div>

            {wfm && (
              <div className="imc-panel asp-wfm">
                <h3>Well-founded model</h3>
                <p className="imc-note">
                  The deterministic three-valued core, computed by the alternating fixpoint. True atoms
                  hold in <em>every</em> answer set, false atoms in <em>none</em>; the undefined atoms are
                  the genuine choices the search must resolve.
                </p>
                <div className="asp-wfm-rows">
                  <div className="asp-wfm-row">
                    <span className="asp-wfm-label asp-true">true · {wfm.trueAtoms.length}</span>
                    <div className="asp-chips">
                      {wfm.trueAtoms.map((a) => (
                        <span key={a} className="asp-chip asp-chip-true">
                          {analysis!.program.atomNames[a]}
                        </span>
                      ))}
                      {wfm.trueAtoms.length === 0 && <span className="asp-empty">—</span>}
                    </div>
                  </div>
                  <div className="asp-wfm-row">
                    <span className="asp-wfm-label asp-undef">undefined · {wfm.undefinedAtoms.length}</span>
                    <div className="asp-chips">
                      {wfm.undefinedAtoms.map((a) => (
                        <span key={a} className="asp-chip asp-chip-undef">
                          {analysis!.program.atomNames[a]}
                        </span>
                      ))}
                      {wfm.undefinedAtoms.length === 0 && <span className="asp-empty">—</span>}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {answerSets.length > 0 && (
              <div className="imc-panel">
                <h3>Answer-set browser</h3>
                <div className="asp-browser">
                  <div className="asp-setlist">
                    {answerSets.slice(0, 500).map((s, i) => (
                      <button
                        key={i}
                        className={i === sel ? 'active' : ''}
                        onClick={() => setSelected(i)}
                      >
                        <span className="asp-setidx">#{i + 1}</span>
                        <span className="asp-setsize">{s.length} atoms</span>
                      </button>
                    ))}
                    {answerSets.length > 500 && <div className="asp-more">…and {answerSets.length - 500} more</div>}
                  </div>
                  <div className="asp-setview">
                    <div className="asp-setcode">{formatAnswerSet(analysis!.program, selSet)}</div>
                    <div className="asp-atomgrid">
                      {Array.from({ length: analysis!.program.numAtoms }, (_, k) => k + 1).map((a) => {
                        const on = selSetIds.has(a)
                        const cls = on ? 'on' : wfFalse.has(a) ? 'wf-false' : wfTrue.has(a) ? 'wf-true-off' : ''
                        return (
                          <span key={a} className={`asp-atom ${cls}`}>
                            {analysis!.program.atomNames[a]}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
