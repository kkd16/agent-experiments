import { useMemo, useState } from 'react'
import './SymxStudio.css'
import {
  SYMX_EXAMPLES,
  interpret,
  parseProgram,
  runSymxChecks,
  symExecute,
  type Counterexample,
  type Program,
  type SymResult,
  type SymxCheckReport,
} from '../symx'

type Source = { kind: 'example'; index: number } | { kind: 'custom' }

/** Largest half-width B so (2B+1)^k stays under the in-UI enumeration budget. */
function boxRadius(k: number): bigint {
  const BUDGET = 6000
  let b = 1
  while (Math.pow(2 * (b + 1) + 1, k) <= BUDGET && b < 200) b++
  return BigInt(b)
}

interface BoxCheck {
  kind: 'confirm' | 'mismatch' | 'skip'
  text: string
}

/** Concretely enumerate a small input box to corroborate a safe/unsafe verdict. */
function crossCheck(program: Program, res: SymResult): BoxCheck {
  const k = program.inputs.length
  if (k === 0) {
    const r = interpret(program, new Map())
    if (res.verdict === 'unsafe') return { kind: 'skip', text: '' }
    return r.kind === 'assert-failed'
      ? { kind: 'mismatch', text: 'the single concrete run violates an assertion' }
      : { kind: 'confirm', text: 'the single concrete run reaches the end with every assertion holding' }
  }
  if (k > 4) return { kind: 'skip', text: `independent enumeration skipped (${k} inputs — box too large)` }
  const B = boxRadius(k)
  let violated = false
  const dims: bigint[] = []
  const rec = (d: number) => {
    if (violated) return
    if (d === k) {
      const inputs = new Map<string, bigint>()
      program.inputs.forEach((n, i) => inputs.set(n, dims[i]))
      if (interpret(program, inputs).kind === 'assert-failed') violated = true
      return
    }
    for (let v = -B; v <= B; v++) {
      dims[d] = v
      rec(d + 1)
      if (violated) return
    }
  }
  rec(0)
  const box = `[−${B}, ${B}]${sup(k)}`
  if (res.verdict === 'safe' || res.verdict === 'safe-bounded') {
    return violated
      ? { kind: 'mismatch', text: `verdict ${res.verdict}, yet a concrete input in ${box} violates an assertion` }
      : { kind: 'confirm', text: `no assertion fails across all ${box} integer inputs — consistent with the proof` }
  }
  if (res.verdict === 'unsafe') {
    return violated
      ? { kind: 'confirm', text: `an independent scan of ${box} also finds a violating input` }
      : { kind: 'skip', text: `the counterexample lies outside the ${box} scan box` }
  }
  return { kind: 'skip', text: '' }
}

export function SymxStudio() {
  const [source, setSource] = useState<Source>({ kind: 'example', index: 0 })
  const [src, setSrc] = useState<string>(SYMX_EXAMPLES[0].src)
  const [unroll, setUnroll] = useState(8)
  const [checks, setChecks] = useState<SymxCheckReport | null>(null)
  const [checking, setChecking] = useState(false)

  const parsed = useMemo(() => parseProgram(src), [src])
  const result = useMemo<SymResult | null>(() => {
    if (!parsed.ok) return null
    return symExecute(parsed.program, { unroll })
  }, [parsed, unroll])
  const box = useMemo<BoxCheck | null>(() => {
    if (!parsed.ok || !result) return null
    return crossCheck(parsed.program, result)
  }, [parsed, result])

  const pickExample = (index: number) => {
    setSource({ kind: 'example', index })
    setSrc(SYMX_EXAMPLES[index].src)
  }
  const onEdit = (v: string) => {
    setSrc(v)
    setSource({ kind: 'custom' })
  }
  const runVerify = () => {
    setChecking(true)
    setTimeout(() => {
      setChecks(runSymxChecks())
      setChecking(false)
    }, 30)
  }

  const blurb = source.kind === 'example' ? SYMX_EXAMPLES[source.index].blurb : 'Your own Mini program.'

  return (
    <div className="layout">
      <aside className="control lia-side">
        <p className="imc-blurb">
          The <strong>Symbolic Studio</strong> verifies programs by <strong>symbolic execution</strong>:
          it walks every path of a tiny imperative language, turns the branch guards into linear
          integer constraints, and discharges each <code>assert</code> to the very same{' '}
          <strong>Omega test</strong> the LIA Studio uses. A violated assertion comes back with a
          concrete <strong>counterexample input</strong>; a clean loop-free program is proven safe
          for <em>all</em> integers. Loops unroll to a bound — bounded model checking in miniature.
          Every verdict is refereed by an independent concrete interpreter.
        </p>

        <div className="lia-examples">
          <h3>Programs</h3>
          <div className="lia-ex-grid">
            {SYMX_EXAMPLES.map((ex, i) => (
              <button key={i} className={source.kind === 'example' && source.index === i ? 'active' : ''} onClick={() => pickExample(i)} title={ex.blurb}>
                {ex.title}
              </button>
            ))}
          </div>
        </div>

        <div className="lia-examples symx-bound">
          <h3>Unroll bound K</h3>
          <div className="symx-bound-row">
            <input type="range" min={1} max={16} value={unroll} onChange={(e) => setUnroll(Number(e.target.value))} />
            <span className="symx-bound-val">{unroll}</span>
          </div>
          <p className="symx-hint">Each <code>while</code> runs at most K times per path. Loop-free programs ignore K and are verified unconditionally.</p>
        </div>

        <div className="lia-selftest">
          <h3>Self-test</h3>
          <p>
            Replays every reported counterexample on the concrete interpreter and brute-forces a
            small input box for hundreds of randomly generated programs — soundness and completeness,
            verdicts and witnesses both.
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
            <h2>Symbolic Studio</h2>
            <p className="subtitle">{source.kind === 'example' ? SYMX_EXAMPLES[source.index].title : 'Custom program'} — {blurb}</p>
          </div>
          {result && <VerdictPill result={result} />}
        </div>

        <div className="symx-editor">
          <label>Mini program — inputs are symbolic; verify with assert / assume</label>
          <textarea value={src} onChange={(e) => onEdit(e.target.value)} spellCheck={false} rows={14} />
          {!parsed.ok && (
            <div className="banner error">
              ⚠ {parsed.error}
              {parsed.line ? ` (line ${parsed.line})` : ''}
            </div>
          )}
        </div>

        {result && parsed.ok && (
          <>
            {result.error && <div className="banner warn">{result.error}</div>}

            <div className="symx-stats">
              <span className="lia-chip">{result.inputs.length} input{result.inputs.length === 1 ? '' : 's'}</span>
              <span className="lia-chip">{result.stats.completePaths} complete path{result.stats.completePaths === 1 ? '' : 's'}</span>
              {result.stats.boundedPaths > 0 && <span className="lia-chip warn">{result.stats.boundedPaths} hit bound K={result.unroll}</span>}
              {result.stats.violationPaths > 0 && <span className="lia-chip bad">{result.stats.violationPaths} violating</span>}
              <span className="lia-chip">{result.stats.assertChecks} assert check{result.stats.assertChecks === 1 ? '' : 's'}</span>
              <span className="lia-chip">{result.stats.omegaCalls} Omega quer{result.stats.omegaCalls === 1 ? 'y' : 'ies'}</span>
              {result.stats.truncated && <span className="lia-chip bad">budget hit</span>}
            </div>

            {result.verdict === 'unsafe' && <ViolationView cexs={result.counterexamples} program={parsed.program} />}

            {(result.verdict === 'safe' || result.verdict === 'safe-bounded') && (
              <section className="view symx-safe">
                <h3>{result.verdict === 'safe' ? 'Verified safe — for all inputs' : `Safe up to ${result.unroll} loop iterations`}</h3>
                <p>
                  {result.verdict === 'safe'
                    ? 'Every assertion holds on every path, and no path was cut by the unroll bound — so this is a proof over all integers, not a search.'
                    : `No assertion can fail within ${result.unroll} unrollings of any loop. Paths that would run longer are flagged, not verified — raise K to push the bound.`}
                </p>
              </section>
            )}

            {result.verdict === 'unknown' && !result.error && (
              <div className="banner warn">The search hit its budget before finishing — the verdict is inconclusive. Lower the unroll bound or simplify the program.</div>
            )}

            {box && box.kind !== 'skip' && <div className={`symx-cross symx-cross-${box.kind}`}>{box.kind === 'confirm' ? '✓ ' : '⚠ '}{box.text}</div>}
            {box && box.kind === 'skip' && box.text && <div className="symx-cross symx-cross-note">{box.text}</div>}

            <PathView result={result} />
          </>
        )}
      </main>
    </div>
  )
}

function VerdictPill({ result }: { result: SymResult }) {
  const map: Record<SymResult['verdict'], { cls: string; label: string }> = {
    safe: { cls: 'sat', label: 'SAFE' },
    'safe-bounded': { cls: 'sat', label: `SAFE ≤ K=${result.unroll}` },
    unsafe: { cls: 'unsat', label: 'UNSAFE' },
    unknown: { cls: 'unknown', label: 'UNKNOWN' },
  }
  const { cls, label } = map[result.verdict]
  return (
    <div className={`status-pill ${cls}`}>
      <strong>{label}</strong>
      <span>{result.counterexamples.length > 0 ? `${result.counterexamples.length} bug${result.counterexamples.length === 1 ? '' : 's'}` : `${result.stats.completePaths} paths`}</span>
    </div>
  )
}

function ViolationView({ cexs, program }: { cexs: Counterexample[]; program: Program }) {
  return (
    <section className="view symx-viol">
      <h3>
        {cexs.length} assertion violation{cexs.length === 1 ? '' : 's'} — each with a concrete counterexample
      </h3>
      <div className="symx-cex-list">
        {cexs.slice(0, 12).map((cex, i) => {
          const inputs = new Map<string, bigint>()
          for (const { name, value } of cex.inputs) inputs.set(name, value)
          const replay = interpret(program, inputs)
          const reproduced = replay.kind === 'assert-failed'
          return (
            <div key={i} className="symx-cex">
              <div className="symx-cex-head">
                <code className="symx-assert">assert({cex.assertText})</code>
                <span className={`symx-repro ${reproduced ? 'ok' : 'bad'}`}>
                  {reproduced ? '✓ reproduced concretely' : `⚠ interpreter says ${replay.kind}`}
                </span>
              </div>
              <div className="symx-cex-inputs">
                {cex.inputs.length === 0 ? (
                  <span className="symx-muted">no inputs</span>
                ) : (
                  cex.inputs.map((x) => (
                    <span key={x.name} className="symx-assign">
                      <span className="symx-name">{x.name}</span>
                      <span className="symx-eq">=</span>
                      <span className="symx-val">{x.value.toString()}</span>
                    </span>
                  ))
                )}
              </div>
              {cex.guards.length > 0 && (
                <div className="symx-guards">
                  path: {cex.guards.map((g, j) => (
                    <span key={j} className="symx-guard">
                      {g}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {cexs.length > 12 && <div className="symx-muted">…and {cexs.length - 12} more.</div>}
      </div>
    </section>
  )
}

function PathView({ result }: { result: SymResult }) {
  const [open, setOpen] = useState(false)
  if (result.paths.length === 0) return null
  const icon = (k: string) => (k === 'complete' ? '✓' : k === 'bounded' ? '∞' : '✗')
  return (
    <section className="view symx-paths">
      <button className="symx-paths-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Explored paths — {result.paths.length} shown ({result.stats.completePaths} complete, {result.stats.boundedPaths} bounded, {result.stats.violationPaths} violating)
      </button>
      {open && (
        <ul className="symx-path-list">
          {result.paths.slice(0, 60).map((p, i) => (
            <li key={i} className={`symx-path symx-path-${p.kind}`}>
              <span className="symx-path-icon">{icon(p.kind)}</span>
              {p.guards.length === 0 ? <span className="symx-muted">⟨no branches⟩</span> : p.guards.map((g, j) => <span key={j} className="symx-guard">{g}</span>)}
            </li>
          ))}
        </ul>
      )}
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
