import { useMemo, useState } from 'react'
import './LiaStudio.css'
import {
  LIA_EXAMPLES,
  OmegaBudgetError,
  PRESBURGER_EXAMPLES,
  bruteForce,
  bruteOptimum,
  omegaTest,
  optimize,
  parseLia,
  parseObjective,
  runLiaChecks,
  verifyModel,
  type Dir,
  type LiaCheckReport,
  type OmegaResult,
  type OptimizeResult,
} from '../lia'
import { ShadowPlot } from './ShadowPlot'
import { PresburgerPanel } from './PresburgerPanel'

type Mode = 'decide' | 'optimize' | 'presburger'
type Source = { kind: 'example'; index: number } | { kind: 'custom' }

interface Decided {
  result: OmegaResult | null
  error: string | null
}

/** Largest half-width K so that (2K+1)^n stays under the in-UI brute budget. */
function boxRadius(n: number): bigint {
  const BUDGET = 80_000
  let k = 1
  while (Math.pow(2 * (k + 1) + 1, n) <= BUDGET && k < 400) k++
  return BigInt(k)
}

interface CrossCheck {
  kind: 'confirm' | 'consistent' | 'outside' | 'mismatch' | 'skip'
  text: string
}

export function LiaStudio() {
  const [mode, setMode] = useState<Mode>('decide')
  const [source, setSource] = useState<Source>({ kind: 'example', index: 0 })
  const [src, setSrc] = useState<string>(LIA_EXAMPLES[0].src)
  const [objSrc, setObjSrc] = useState<string>('x + y')
  const [dir, setDir] = useState<Dir>('max')
  const [checks, setChecks] = useState<LiaCheckReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [showTrace, setShowTrace] = useState(false)

  const parsed = useMemo(() => parseLia(src), [src])

  const decided = useMemo<Decided>(() => {
    if (!parsed.ok) return { result: null, error: null }
    try {
      const result = omegaTest(parsed.constraints, parsed.names.length, (v) => parsed.names[v] ?? `σ${v}`, {
        trace: true,
        maxNodes: 200_000,
        maxTrace: 600,
      })
      return { result, error: null }
    } catch (e) {
      if (e instanceof OmegaBudgetError) return { result: null, error: e.message }
      return { result: null, error: e instanceof Error ? e.message : 'solver error' }
    }
  }, [parsed])

  const cross = useMemo<CrossCheck>(() => {
    if (!parsed.ok || !decided.result) return { kind: 'skip', text: '' }
    const n = parsed.names.length
    if (n > 4) return { kind: 'skip', text: `independent search skipped (${n} variables — box too large)` }
    const K = boxRadius(n)
    const brute = bruteForce(parsed.constraints, n, -K, K)
    const res = decided.result
    if (res.status === 'sat') {
      if (brute.sat) return { kind: 'confirm', text: `confirmed by exhaustive search over [−${K}, ${K}]${sup(n)}` }
      return verifyModel(parsed.constraints, res.model)
        ? { kind: 'outside', text: `model checks out, but lies outside the ±${K} search box` }
        : { kind: 'mismatch', text: 'internal error: model fails the constraints' }
    }
    if (brute.sat) return { kind: 'mismatch', text: 'mismatch: brute force found a solution the solver missed' }
    return { kind: 'consistent', text: `no solution in [−${K}, ${K}]${sup(n)} (consistent with unsat)` }
  }, [parsed, decided])

  // ----- optimization -----
  const objParsed = useMemo(() => (parsed.ok ? parseObjective(objSrc, parsed.names) : null), [parsed, objSrc])
  const opt = useMemo<{ result: OptimizeResult | null; error: string | null }>(() => {
    if (mode !== 'optimize' || !parsed.ok || !objParsed || !objParsed.ok) return { result: null, error: null }
    try {
      const result = optimize(parsed.constraints, parsed.names.length, objParsed.lin, dir, (v) => parsed.names[v] ?? `σ${v}`, {
        maxNodes: 200_000,
        maxSteps: 20_000,
      })
      return { result, error: null }
    } catch (e) {
      if (e instanceof OmegaBudgetError) return { result: null, error: e.message }
      return { result: null, error: e instanceof Error ? e.message : 'optimizer error' }
    }
  }, [mode, parsed, objParsed, dir])

  const optCross = useMemo(() => {
    if (mode !== 'optimize' || !parsed.ok || !objParsed?.ok || !opt.result) return null
    const n = parsed.names.length
    if (n > 4) return null
    const K = boxRadius(n)
    const bo = bruteOptimum(parsed.constraints, n, objParsed.lin, dir, -K, K)
    const r = opt.result
    if (r.status === 'optimal') {
      if (bo.feasible && bo.value === r.value)
        return { ok: true, text: `confirmed: exhaustive search over [−${K}, ${K}]${sup(n)} finds the same optimum ${r.value}` }
      if (bo.feasible)
        return { ok: false, text: `box optimum ${bo.value} ≠ reported ${r.value} (witness may lie outside ±${K})` }
      return { ok: true, text: `no feasible point in [−${K}, ${K}]${sup(n)} — true optimum lies outside the box` }
    }
    if (r.status === 'infeasible')
      return bo.feasible
        ? { ok: false, text: 'mismatch: brute force found a feasible point' }
        : { ok: true, text: `no feasible point in [−${K}, ${K}]${sup(n)} (consistent with infeasible)` }
    return null
  }, [mode, parsed, objParsed, opt, dir])

  const pickExample = (index: number) => {
    setSource({ kind: 'example', index })
    setSrc(LIA_EXAMPLES[index].src)
    setShowTrace(false)
  }
  const onEdit = (v: string) => {
    setSrc(v)
    setSource({ kind: 'custom' })
  }
  const runVerify = () => {
    setChecking(true)
    setTimeout(() => {
      setChecks(runLiaChecks())
      setChecking(false)
    }, 30)
  }

  const blurb = source.kind === 'example' ? LIA_EXAMPLES[source.index].blurb : 'Your own integer linear system.'
  const res = decided.result
  const twoVar = parsed.ok && parsed.names.length === 2

  return (
    <div className="layout">
      <aside className="control lia-side">
        <p className="imc-blurb">
          The <strong>Omega test</strong> (Pugh 1991) decides quantifier-free linear arithmetic over
          the <strong>integers</strong>. This studio goes further: it <strong>optimizes</strong> a
          linear objective over the integer lattice (a SAT–UNSAT descent with exact unboundedness
          detection), draws the <strong>2-D shadow</strong> of a two-variable system, and decides
          full <strong>Presburger arithmetic</strong> with ∀/∃ quantifiers by Cooper's algorithm.
          Everything is <code>BigInt</code>-exact and cross-checked against brute force.
        </p>

        {mode !== 'presburger' && (
          <div className="lia-examples">
            <h3>Examples</h3>
            <div className="lia-ex-grid">
              {LIA_EXAMPLES.map((ex, i) => (
                <button
                  key={i}
                  className={source.kind === 'example' && source.index === i ? 'active' : ''}
                  onClick={() => pickExample(i)}
                  title={ex.blurb}
                >
                  {ex.title}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="lia-selftest">
          <h3>Self-test</h3>
          <p>
            Cross-checks the Omega test, the integer optimizer, Cooper's quantifier elimination and
            the 2-D lattice against exhaustive brute force and an independent bounded evaluator —
            thousands of assertions, verdicts and certificates both.
          </p>
          <button onClick={runVerify} disabled={checking}>
            {checking ? 'Running…' : '▶ Run self-test'}
          </button>
          {checks && (
            <div className={`lia-check ${checks.fail === 0 ? 'ok' : 'bad'}`}>
              {checks.fail === 0 ? (
                <>✓ {checks.pass} assertions passed</>
              ) : (
                <>
                  ✗ {checks.fail} failed / {checks.pass} passed
                  <ul>
                    {checks.messages.slice(0, 6).map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </aside>

      <main className="content">
        <div className="problem-head">
          <div>
            <h2>LIA Studio</h2>
            <p className="subtitle">
              {mode === 'presburger' ? 'Presburger arithmetic — full ∀/∃ by Cooper elimination.' : blurb}
            </p>
          </div>
          <div className="lia-modes">
            <button className={mode === 'decide' ? 'active' : ''} onClick={() => setMode('decide')}>Decide</button>
            <button className={mode === 'optimize' ? 'active' : ''} onClick={() => setMode('optimize')}>Optimize</button>
            <button className={mode === 'presburger' ? 'active' : ''} onClick={() => setMode('presburger')}>Presburger</button>
          </div>
        </div>

        {mode === 'presburger' ? (
          <PresburgerPanel examples={PRESBURGER_EXAMPLES} />
        ) : (
          <>
            <div className="lia-editor">
              <label>Constraints — one relation per line ( =, ≤, ≥, &lt;, &gt; ); coefficients like 3x or 3*x</label>
              <textarea value={src} onChange={(e) => onEdit(e.target.value)} spellCheck={false} rows={8} />
              {!parsed.ok && (
                <div className="banner error">
                  ⚠ {parsed.error}
                  {parsed.line ? ` (line ${parsed.line})` : ''}
                </div>
              )}
            </div>

            {parsed.ok && (
              <div className="lia-summary">
                <span className="lia-chip">
                  {parsed.names.length} variable{parsed.names.length === 1 ? '' : 's'}
                </span>
                <span className="lia-chip">
                  {parsed.constraints.length} constraint{parsed.constraints.length === 1 ? '' : 's'}
                </span>
                <span className="lia-vars">{parsed.names.join(', ')}</span>
              </div>
            )}

            {mode === 'optimize' && parsed.ok && (
              <OptimizePanel
                objSrc={objSrc}
                setObjSrc={setObjSrc}
                dir={dir}
                setDir={setDir}
                objError={objParsed && !objParsed.ok ? objParsed.error : null}
                result={opt.result}
                error={opt.error}
                names={parsed.names}
                cross={optCross}
              />
            )}

            {mode === 'decide' && (
              <DecidePanel res={res} error={decided.error} parsed={parsed} cross={cross} showTrace={showTrace} setShowTrace={setShowTrace} />
            )}

            {twoVar && (
              <section className="view lia-plot">
                <h3>2-D shadow — the integer lattice & its real shadow</h3>
                <ShadowPlot
                  cons={parsed.constraints}
                  names={parsed.names}
                  marks={plotMarks(mode, res, opt.result)}
                  objective={objectiveLine(mode, objParsed, opt.result)}
                />
              </section>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function plotMarks(mode: Mode, res: OmegaResult | null, opt: OptimizeResult | null): { x: bigint; y: bigint; kind: 'sat' | 'opt' }[] {
  if (mode === 'optimize' && opt && opt.status === 'optimal') {
    return [{ x: opt.model.get(0) ?? 0n, y: opt.model.get(1) ?? 0n, kind: 'opt' }]
  }
  if (mode === 'optimize' && opt && opt.status === 'unbounded') {
    return [{ x: opt.point.get(0) ?? 0n, y: opt.point.get(1) ?? 0n, kind: 'sat' }]
  }
  if (res && res.status === 'sat') {
    return [{ x: res.model.get(0) ?? 0n, y: res.model.get(1) ?? 0n, kind: 'sat' }]
  }
  return []
}

function objectiveLine(
  mode: Mode,
  objParsed: { ok: true; lin: import('../lia').Lin } | { ok: false; error: string } | null,
  opt: OptimizeResult | null,
): { a: bigint; b: bigint; value: bigint } | null {
  if (mode !== 'optimize' || !objParsed || !objParsed.ok || !opt || opt.status !== 'optimal') return null
  const a = objParsed.lin.t.get(0) ?? 0n
  const b = objParsed.lin.t.get(1) ?? 0n
  return { a, b, value: opt.value - objParsed.lin.c }
}

function DecidePanel({
  res,
  error,
  parsed,
  cross,
  showTrace,
  setShowTrace,
}: {
  res: OmegaResult | null
  error: string | null
  parsed: ReturnType<typeof parseLia>
  cross: CrossCheck
  showTrace: boolean
  setShowTrace: (f: (s: boolean) => boolean) => void
}) {
  return (
    <>
      {error && <div className="banner error">⚠ {error}</div>}
      {res && (
        <div className={`status-pill-row`}>
          <span className={`status-pill ${res.status === 'sat' ? 'sat' : 'unsat'}`}>
            {res.status === 'sat' ? 'SATISFIABLE' : 'UNSATISFIABLE'}
          </span>
        </div>
      )}

      {res && res.status === 'sat' && (
        <section className="view lia-model">
          <h3>An integer solution</h3>
          <div className="lia-model-grid">
            {[...res.model.entries()].map(([v, val]) => (
              <div key={v} className="lia-assign">
                <span className="lia-name">{parsed.ok ? parsed.names[v] : `x${v}`}</span>
                <span className="lia-eq">=</span>
                <span className="lia-val">{val.toString()}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {res && res.status === 'unsat' && (
        <section className="view lia-unsat">
          <h3>No integer solution exists</h3>
          <p>
            The Omega test eliminated every variable and reached a contradiction — proven over all
            integers, not merely searched.
          </p>
        </section>
      )}

      {res && cross.kind !== 'skip' && (
        <div className={`lia-cross lia-cross-${cross.kind}`}>
          {cross.kind === 'confirm' || cross.kind === 'consistent' || cross.kind === 'outside' ? '✓ ' : '⚠ '}
          {cross.text}
        </div>
      )}
      {res && cross.kind === 'skip' && cross.text && <div className="lia-cross lia-cross-note">{cross.text}</div>}

      {res && res.trace.length > 0 && (
        <section className="view lia-trace">
          <button className="lia-trace-toggle" onClick={() => setShowTrace((s) => !s)}>
            {showTrace ? '▾' : '▸'} Elimination trace — {res.trace.length} step
            {res.trace.length === 1 ? '' : 's'} · {res.nodes} node{res.nodes === 1 ? '' : 's'}
          </button>
          {showTrace && <pre className="lia-trace-body">{res.trace.join('\n')}</pre>}
        </section>
      )}
    </>
  )
}

function OptimizePanel({
  objSrc,
  setObjSrc,
  dir,
  setDir,
  objError,
  result,
  error,
  names,
  cross,
}: {
  objSrc: string
  setObjSrc: (s: string) => void
  dir: Dir
  setDir: (d: Dir) => void
  objError: string | null
  result: OptimizeResult | null
  error: string | null
  names: string[]
  cross: { ok: boolean; text: string } | null
}) {
  return (
    <section className="view lia-opt">
      <div className="lia-opt-row">
        <div className="lia-dir-toggle">
          <button className={dir === 'min' ? 'active' : ''} onClick={() => setDir('min')}>minimize</button>
          <button className={dir === 'max' ? 'active' : ''} onClick={() => setDir('max')}>maximize</button>
        </div>
        <input
          className="lia-obj-input"
          value={objSrc}
          spellCheck={false}
          onChange={(e) => setObjSrc(e.target.value)}
          placeholder="objective, e.g. 3x + 2y"
        />
      </div>
      {objError && <div className="banner error">⚠ objective: {objError}</div>}
      {error && <div className="banner error">⚠ {error}</div>}

      {result && result.status === 'optimal' && (
        <div className="lia-opt-result">
          <div className="lia-opt-value">
            <span className="lia-opt-label">{dir === 'min' ? 'minimum' : 'maximum'}</span>
            <span className="lia-opt-num">{result.value.toString()}</span>
            <span className="lia-opt-at">at</span>
            <span className="lia-opt-pt">
              {[...result.model.entries()].map(([v, val]) => `${names[v] ?? `x${v}`}=${val}`).join(', ')}
            </span>
          </div>
          {result.steps.length > 1 && (
            <div className="lia-opt-steps">
              descent: {result.steps.map((s) => s.value.toString()).join(' → ')} (SAT–UNSAT, {result.steps.length} improvement
              {result.steps.length === 1 ? '' : 's'})
            </div>
          )}
        </div>
      )}

      {result && result.status === 'infeasible' && (
        <div className="lia-cross lia-cross-mismatch">No feasible integer point — the system is infeasible.</div>
      )}

      {result && result.status === 'unbounded' && (
        <div className="lia-opt-result">
          <div className="lia-opt-value">
            <span className="lia-opt-label">{dir === 'min' ? 'minimum' : 'maximum'}</span>
            <span className="lia-opt-num">{dir === 'min' ? '−∞' : '+∞'}</span>
          </div>
          <div className="lia-opt-steps">
            unbounded: the objective improves without limit along the recession ray (
            {[...result.ray.entries()].filter(([, k]) => k !== 0n).map(([v, k]) => `${names[v] ?? `x${v}`}: ${k > 0n ? '+' : ''}${k}`).join(', ')}
            ) from {[...result.point.entries()].map(([v, val]) => `${names[v] ?? `x${v}`}=${val}`).join(', ')}.
          </div>
        </div>
      )}

      {cross && <div className={`lia-cross ${cross.ok ? 'lia-cross-confirm' : 'lia-cross-mismatch'}`}>{cross.ok ? '✓ ' : '⚠ '}{cross.text}</div>}
    </section>
  )
}

function sup(n: number): string {
  const map: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴' }
  return String(n)
    .split('')
    .map((c) => map[c] ?? c)
    .join('')
}
