import { useEffect, useMemo, useState } from 'react'
import { GALLERY, parseSpec, synthesize } from '../lang/synth.ts'
import type { SynthResult } from '../lang/synth.ts'
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
        setOutcome({ result: null, error: parsed.error })
        setRunning(false)
        return
      }
      const result = synthesize(parsed.spec)
      setOutcome({ result, error: null })
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

  const exampleCount = useMemo(() => spec.split('\n').filter((l) => l.includes('=>')).length, [spec])

  // Deep-link support: `?run=<gallery id>` auto-synthesizes that task on mount.
  useEffect(() => {
    const task = initialTask()
    if (!task) return
    const h = setTimeout(() => run(task.spec), 0)
    return () => clearTimeout(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <code>map</code>/<code>filter</code>/<code>foldr</code>. Whatever it finds is then
        re-checked through the <strong>real compiler</strong> before you see it.
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
              inputs &amp; outputs are ordinary Aether values: <code>[1, 2, 3]</code>,{' '}
              <code>(2, 3)</code>, <code>true</code>, <code>&quot;hi&quot;</code>
            </span>
          </div>

          {outcome && <ResultView outcome={outcome} onOpen={openInPlayground} />}
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
    </div>
  )
}

function ResultView({
  outcome,
  onOpen,
}: {
  outcome: Outcome
  onOpen: (src: string) => void
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

      <div className="synth-stats">
        <Stat label="AST size" value={r.size === null ? '—' : String(r.size)} />
        <Stat label="candidates" value={String(r.candidates)} />
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

      {r.verified && r.playgroundSrc && (
        <button className="btn" onClick={() => onOpen(r.playgroundSrc as string)}>
          Open in playground → (run it on all three backends)
        </button>
      )}
    </div>
  )
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="synth-stat">
      <span className="synth-stat-label">{label}</span>
      <span className={`synth-stat-value ${mono ? 'mono' : ''}`}>{value}</span>
    </div>
  )
}
