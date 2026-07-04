import { useEffect, useMemo, useState } from 'react'
import { GALLERY, parseSpec, runSynthSelfTests, synthesize, synthesizeWithOracle } from '../lang/synth.ts'
import type { CegisStep, SynthResult, SynthSelfResult } from '../lang/synth.ts'
import { setPendingCode } from '../share.ts'
import { navigate } from '../router.ts'

const DEFAULT_SPEC = GALLERY[2].spec // "sum a list" — reads well as a first taste

/** The gallery task named by a `#/synthesize?run=<id>` deep-link, if any. */
function initialTask(): { spec: string } | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash
  const qi = hash.indexOf('?')
  if (qi === -1) return null
  const id = new URLSearchParams(hash.slice(qi + 1)).get('run')
  return (id && GALLERY.find((t) => t.id === id)) || null
}

interface Outcome {
  result: SynthResult | null
  error: string | null
  /** examples the Auto-CEGIS loop auto-labelled from a reference (null if no `ref:`) */
  added: CegisStep[] | null
  iterations: number
}

export default function Synthesize() {
  const [spec, setSpec] = useState(() => initialTask()?.spec ?? DEFAULT_SPEC)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [running, setRunning] = useState(false)

  const run = (source: string): void => {
    setRunning(true)
    setOutcome(null)
    // paint the "working" state before the (synchronous) search runs
    setTimeout(() => {
      const parsed = parseSpec(source)
      if (!parsed.spec) {
        setOutcome({ result: null, error: parsed.error, added: null, iterations: 0 })
        setRunning(false)
        return
      }
      // A `ref:` line turns on the Auto-CEGIS loop: the reference labels the
      // ambiguous inputs itself, so the search converges with no hand-labelling.
      if (parsed.spec.ref) {
        const cg = synthesizeWithOracle(parsed.spec)
        setOutcome({ result: cg.result, error: null, added: cg.added, iterations: cg.iterations })
      } else {
        const result = synthesize(parsed.spec)
        setOutcome({ result, error: null, added: null, iterations: 0 })
      }
      setRunning(false)
    }, 20)
  }

  const loadTask = (taskSpec: string): void => {
    setSpec(taskSpec)
    setOutcome(null)
  }

  const openInPlayground = (src: string): void => {
    setPendingCode(src)
    navigate('/')
  }

  // Append a distinguishing example, then re-run — the CEGIS disambiguation loop.
  const addExample = (line: string): void => {
    const next = `${spec.replace(/\s+$/, '')}\n${line}`
    setSpec(next)
    run(next)
  }

  const exampleCount = useMemo(() => spec.split('\n').filter((l) => l.includes('=>')).length, [spec])

  // Deep-link support: `?run=<gallery id>` auto-synthesizes that task on mount.
  useEffect(() => {
    const task = initialTask()
    if (!task) return
    const h = setTimeout(() => run(task.spec), 0)
    return () => clearTimeout(h)
  }, [])

  return (
    <div className="page synth-page">
      <h1>Synthesize</h1>
      <p className="page-lead">
        Don&rsquo;t write the function — <em>describe</em> it. Give a few input&nbsp;⇒&nbsp;output
        examples and Aether will <strong>write the program for you</strong>: a from-scratch
        bottom-up enumerative synthesizer (the family behind Escher / EUSolver — no solver, no
        library) reads the <em>types</em> off your examples, grows a bank of candidate terms with
        observational-equivalence pruning, and even synthesizes the lambdas passed to{' '}
        <code>map</code>/<code>filter</code>/<code>foldr</code>. It handles{' '}
        <strong>several arguments</strong> (<code>a, b =&gt; c</code> — no tupling), and now writes{' '}
        <strong>genuinely recursive programs</strong> — a <code>let rec</code> over a list argument
        (guarded, paramorphic, counter-driven) for functions <em>no fold can express</em>. It{' '}
        <strong>ranks</strong> every program that fits by AST size then real VM-step cost, and{' '}
        <strong>warns you when your examples are ambiguous</strong> — showing an input two candidates
        disagree on. Give it a <code>ref:</code> line and it closes that loop itself
        (<strong>Auto-CEGIS</strong>): the reference labels the ambiguous inputs for you until the
        program is pinned down. Whatever it picks is re-checked through the{' '}
        <strong>real compiler</strong> before you see it.
      </p>

      <div className="synth-layout">
        <section className="synth-input">
          <div className="synth-input-head">
            <h3>Examples</h3>
            <span className="synth-hint">
              one <code>input =&gt; output</code> per line · {exampleCount} example
              {exampleCount === 1 ? '' : 's'}
            </span>
          </div>
          <textarea
            className="synth-spec"
            spellCheck={false}
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            rows={8}
          />
          <div className="synth-actions">
            <button className="btn primary" onClick={() => run(spec)} disabled={running}>
              {running ? 'searching…' : '✦ Synthesize'}
            </button>
            <span className="synth-note">
              values are ordinary Aether: <code>[1, 2, 3]</code>, <code>(2, 3)</code>,{' '}
              <code>true</code>, <code>&quot;hi&quot;</code> · separate multiple arguments with commas:{' '}
              <code>2, 3 =&gt; 5</code> · add a <code>ref: fn x -&gt; …</code> line to auto-resolve
              ambiguity
            </span>
          </div>

          {outcome && <ResultView outcome={outcome} onOpen={openInPlayground} onAddExample={addExample} />}
        </section>

        <aside className="synth-gallery">
          <h3>Try one</h3>
          <div className="synth-tasks">
            {GALLERY.map((t) => (
              <button
                key={t.id}
                className="synth-task"
                onClick={() => {
                  loadTask(t.spec)
                  run(t.spec)
                }}
                title={t.blurb}
              >
                <span className="synth-task-title">{t.title}</span>
                <span className="synth-task-blurb">{t.blurb}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>

      <SelfCheck />
    </div>
  )
}

/** A live engine self-check: runs the whole search + real-compiler verification
 * over a battery of specs and proves the synthesizer still works, end to end. */
function SelfCheck() {
  const [rows, setRows] = useState<SynthSelfResult[] | null>(null)
  const [busy, setBusy] = useState(false)

  const runIt = (): void => {
    setBusy(true)
    setRows(null)
    setTimeout(() => {
      setRows(runSynthSelfTests())
      setBusy(false)
    }, 20)
  }

  const passed = rows ? rows.filter((r) => r.ok).length : 0
  const allOk = rows !== null && passed === rows.length

  return (
    <section className="synth-selfcheck">
      <div className="synth-selfcheck-head">
        <button className="btn" onClick={runIt} disabled={busy}>
          {busy ? 'running…' : '▶ Run engine self-check'}
        </button>
        {rows && (
          <span className={`synth-selfcheck-tally ${allOk ? 'ok' : 'bad'}`}>
            {passed}/{rows.length} passing
          </span>
        )}
        <span className="synth-note">
          each row runs the full search and re-verifies the found program through the real compiler
        </span>
      </div>
      {rows && (
        <ul className="synth-selfcheck-list">
          {rows.map((r, i) => (
            <li key={i} className={`synth-selfcheck-row ${r.ok ? 'ok' : 'bad'}`}>
              <span className="synth-selfcheck-mark">{r.ok ? '✓' : '✗'}</span>
              <span className="synth-selfcheck-name">{r.name}</span>
              <span className="synth-selfcheck-detail">{r.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ResultView({
  outcome,
  onOpen,
  onAddExample,
}: {
  outcome: Outcome
  onOpen: (src: string) => void
  onAddExample: (line: string) => void
}) {
  if (outcome.error) {
    return (
      <div className="synth-result bad">
        <div className="synth-result-head">Couldn&rsquo;t read the examples</div>
        <p className="synth-msg">{outcome.error}</p>
      </div>
    )
  }
  const r = outcome.result
  if (!r) return null
  const added = outcome.added

  if (!r.program) {
    return (
      <div className="synth-result none">
        <div className="synth-result-head">No program found</div>
        <p className="synth-msg">{r.message}</p>
        <div className="synth-stats">
          <Stat label="goal" value={r.goalType} mono />
          <Stat label="candidates" value={String(r.candidates)} />
          <Stat label="time" value={`${r.millis} ms`} />
        </div>
      </div>
    )
  }

  return (
    <div className={`synth-result ${r.verified ? 'ok' : 'bad'}`}>
      <div className="synth-result-head">
        {r.verified ? '✓ Found & verified' : '✗ Candidate rejected by the compiler'}
        <span className="synth-type">{r.type}</span>
      </div>

      <pre className="synth-program">{r.program}</pre>

      {added && added.length > 0 && (
        <div className="synth-cegis">
          <div className="synth-cegis-head">
            <span className="synth-cegis-badge">⟳ Auto-CEGIS</span>
            your <code>ref:</code> oracle labelled {added.length} distinguishing input
            {added.length === 1 ? '' : 's'} to pin the program down
          </div>
          <ul className="synth-cegis-list">
            {added.map((a, i) => (
              <li className="synth-cegis-row" key={i}>
                <code className="synth-cegis-in">{a.input}</code>
                <span className="synth-cegis-arrow">⇒</span>
                <code className="synth-cegis-out">{a.output}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="synth-stats">
        <Stat label="AST size" value={r.size === null ? '—' : String(r.size)} />
        <Stat label="candidates" value={String(r.candidates)} />
        <Stat label="solutions" value={String(r.alternatives.length + 1)} />
        <Stat label="time" value={`${r.millis} ms`} />
      </div>

      <table className="synth-checks">
        <thead>
          <tr>
            <th>input</th>
            <th>expected</th>
            <th>got</th>
            <th aria-label="ok" />
          </tr>
        </thead>
        <tbody>
          {r.rows.map((row, i) => (
            <tr key={i} className={row.ok ? 'ok' : 'bad'}>
              <td>{row.input}</td>
              <td>{row.expected}</td>
              <td>{row.got}</td>
              <td className="synth-check-mark">{row.ok ? '✓' : '✗'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {r.ambiguity && (
        <div className="synth-ambig">
          <div className="synth-ambig-head">
            <span className="synth-ambig-badge">△ Ambiguous</span>
            these programs all fit your examples but <strong>disagree</strong> on{' '}
            <code>{r.ambiguity.inputSrc}</code>
          </div>
          <div className="synth-ambig-opts">
            {r.ambiguity.options.map((o, i) => (
              <div className="synth-ambig-opt" key={i}>
                <code className="synth-ambig-prog">{lastLine(o.program)}</code>
                <span className="synth-ambig-arrow">→</span>
                <code className="synth-ambig-out">{o.outputSrc}</code>
                <button
                  className="synth-mini-btn"
                  title="Add this as an example and search again"
                  onClick={() => onAddExample(`${r.ambiguity!.inputSrc} => ${o.outputSrc}`)}
                >
                  + pick this
                </button>
              </div>
            ))}
          </div>
          <p className="synth-ambig-note">
            Add the intended answer to disambiguate — the search will re-run and narrow the space.
          </p>
        </div>
      )}

      {r.alternatives.length > 0 && (
        <div className="synth-alts">
          <div className="synth-alts-head">Other programs that fit (ranked)</div>
          <ul className="synth-alts-list">
            {r.alternatives.map((a, i) => (
              <li className="synth-alt" key={i}>
                <code className="synth-alt-prog">{lastLine(a.program)}</code>
                <span className="synth-alt-meta">
                  size {a.size}
                  {a.steps !== null ? ` · ${a.steps} steps` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.verified && r.playgroundSrc && (
        <button className="btn" onClick={() => onOpen(r.playgroundSrc as string)}>
          Open in playground → (run it on all three backends)
        </button>
      )}
    </div>
  )
}

/** Programs may carry helper `let`s on earlier lines; the clause is the last line. */
function lastLine(program: string): string {
  const lines = program.split('\n')
  return lines[lines.length - 1]
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="synth-stat">
      <span className="synth-stat-label">{label}</span>
      <span className={`synth-stat-value ${mono ? 'mono' : ''}`}>{value}</span>
    </div>
  )
}
