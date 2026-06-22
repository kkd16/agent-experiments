import { useEffect, useMemo, useState } from 'react'
import {
  parseTM,
  analyzeDeterminism,
  isHalting,
  showTapeSym,
  WILDCARD,
} from '../engine/tm/machine'
import type { TuringMachine, TMTransition } from '../engine/tm/machine'
import { runTM } from '../engine/tm/simulate'
import type { TMConfig, TMOutcome } from '../engine/tm/simulate'
import { TM_EXAMPLES } from '../engine/tm/examples'
import { regexToTM } from '../engine/tm/regular2tm'
import { tmToGraph } from '../engine/tm/diagram'
import Tape from '../components/Tape'
import Graph from '../components/Graph'
import { Stat } from '../components/Stat'
import './TuringView.css'

export type TuringTab = 'run' | 'trace' | 'table' | 'diagram' | 'hierarchy'

const TABS: { id: TuringTab; label: string }[] = [
  { id: 'run', label: 'Run' },
  { id: 'trace', label: 'Trace' },
  { id: 'table', label: 'δ-table' },
  { id: 'diagram', label: 'Diagram' },
  { id: 'hierarchy', label: 'Hierarchy' },
]

interface Props {
  source: string
  onSource: (s: string) => void
  input: string
  onInput: (s: string) => void
  tab: TuringTab
  onTab: (t: TuringTab) => void
}

const MOVE_LABEL: Record<string, string> = { L: 'L ◀', R: 'R ▶', S: 'S ■' }

export default function TuringView({ source, onSource, input, onInput, tab, onTab }: Props) {
  const parsed = useMemo(() => parseTM(source), [source])
  const machine = parsed.machine
  const det = useMemo(() => (machine ? analyzeDeterminism(machine) : null), [machine])

  // The full configuration trace, shared by the Run / Trace / Diagram tabs.
  const run = useMemo(
    () => (machine ? runTM(machine, input) : null),
    [machine, input],
  )

  // A single playback cursor shared across tabs (so scrubbing Run also lights the Diagram).
  const [step, setStep] = useState(0)
  const maxStep = run ? Math.max(0, run.trace.length - 1) : 0
  const s = Math.min(step, maxStep)
  // Reset the cursor whenever the trace identity changes (the documented "adjust state on prop
  // change" pattern — a guarded setState during render instead of an effect).
  const traceKey = [source, input].join('')
  const [lastKey, setLastKey] = useState(traceKey)
  if (lastKey !== traceKey) {
    setLastKey(traceKey)
    setStep(0)
  }

  const loadExample = (i: number) => {
    onSource(TM_EXAMPLES[i].source)
    onInput(TM_EXAMPLES[i].input)
  }

  return (
    <div className="workspace tm-ws">
      <main className="viewer">
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="canvas">
          {!machine ? (
            <div className="empty">
              {parsed.errors.length > 0 ? (
                <div className="parse-error gram-error">
                  {parsed.errors.slice(0, 6).map((e, i) => (
                    <div key={i} className="err-msg">
                      line {e.line}: {e.message}
                    </div>
                  ))}
                </div>
              ) : (
                'Write a transition table to begin.'
              )}
            </div>
          ) : tab === 'run' ? (
            <RunTab machine={machine} run={run!} step={s} setStep={setStep} maxStep={maxStep} />
          ) : tab === 'trace' ? (
            <TraceTab machine={machine} run={run!} step={s} setStep={setStep} />
          ) : tab === 'table' ? (
            <TableTab machine={machine} det={det!} />
          ) : tab === 'diagram' ? (
            <DiagramTab machine={machine} run={run!} step={s} />
          ) : (
            <HierarchyTab machine={machine} det={det!} onSource={onSource} onInput={onInput} run={run!} />
          )}
        </div>
      </main>

      <aside className="rail">
        <section className="panel">
          <h2>Turing machine</h2>
          <p className="panel-sub">
            One rule per line: <code>state read → next write move</code>. <code>_</code> is the blank,{' '}
            <code>*</code> a wildcard read / unchanged write, move is <code>L/R/S</code>. Set{' '}
            <code>accept:</code>, <code>start:</code>, <code>blank:</code> with directives;{' '}
            <code>//</code> starts a comment.
          </p>
          <textarea
            className="tm-input"
            value={source}
            spellCheck={false}
            onChange={(e) => onSource(e.target.value)}
            rows={12}
            aria-label="turing machine source"
          />
          <select
            className="examples"
            value=""
            onChange={(e) => e.target.value && loadExample(Number(e.target.value))}
            aria-label="load an example machine"
          >
            <option value="">examples ▾</option>
            {TM_EXAMPLES.map((ex, i) => (
              <option key={i} value={i}>
                {ex.name}
              </option>
            ))}
          </select>
          {machine && det && (
            <div className="tm-badges">
              <span className={`tm-badge ${det.deterministic ? 'det' : 'ndet'}`}>
                {det.deterministic ? 'deterministic' : 'nondeterministic'}
              </span>
              {machine.bounded && <span className="tm-badge lba">linear-bounded</span>}
            </div>
          )}
          {machine && (
            <div className="statline">
              <Stat k="Q" v={machine.states.length} title="control states" />
              <Stat k="Γ" v={machine.tapeAlphabet.length} title="tape alphabet (blank included)" />
              <Stat k="δ" v={machine.transitions.length} title="transition rules" />
            </div>
          )}
          {parsed.errors.length > 0 && machine && (
            <div className="warn small">{parsed.errors.length} line(s) ignored — check the syntax.</div>
          )}
        </section>

        {machine && run && <InputPanel input={input} onInput={onInput} run={run} />}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------

function verdictText(outcome: TMOutcome): { cls: string; label: string } {
  switch (outcome) {
    case 'accept':
      return { cls: 'yes', label: 'accepted' }
    case 'reject':
      return { cls: 'no', label: 'rejected (halted)' }
    case 'timeout':
      return { cls: 'maybe', label: 'may not halt (step budget reached)' }
  }
}

function ruleText(machine: TuringMachine, t: TMTransition): string {
  const read = t.read === WILDCARD ? '∗' : showTapeSym(machine, t.read)
  const write = t.write === WILDCARD ? '∗(same)' : showTapeSym(machine, t.write)
  return `${t.state}, ${read} → ${t.next}, write ${write}, ${MOVE_LABEL[t.move]}`
}

function InputPanel({
  input,
  onInput,
  run,
}: {
  input: string
  onInput: (s: string) => void
  run: ReturnType<typeof runTM>
}) {
  const v = verdictText(run.outcome)
  return (
    <section className="panel">
      <h2>Input tape</h2>
      <p className="panel-sub">The string written on the tape before the machine starts (head at cell 0).</p>
      <input
        className="sim-input"
        value={input}
        spellCheck={false}
        onChange={(e) => onInput(e.target.value)}
        placeholder="input string"
        aria-label="input string"
      />
      <div className={`tm-verdict ${v.cls}`}>
        {input === '' ? 'ε (blank tape)' : input} — {v.label}
      </div>
      <p className="note small">
        {run.deterministic
          ? `${run.steps} step${run.steps === 1 ? '' : 's'} simulated.`
          : `nondeterministic: ${run.explored ?? 0} configurations explored${
              run.outcome === 'accept' ? `, accepting run of ${run.steps} steps found` : ''
            }.`}
      </p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Run — the animated tape.
// ---------------------------------------------------------------------------

function RunTab({
  machine,
  run,
  step,
  setStep,
  maxStep,
}: {
  machine: TuringMachine
  run: ReturnType<typeof runTM>
  step: number
  setStep: (n: number | ((x: number) => number)) => void
  maxStep: number
}) {
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(6) // steps per second

  // Auto-advance while playing. Once the head reaches the end the effect simply stops scheduling —
  // no setState in the effect body (which would trigger cascading renders).
  const active = playing && step < maxStep
  useEffect(() => {
    if (!active) return
    const id = window.setTimeout(() => setStep((x) => Math.min(maxStep, x + 1)), 1000 / speed)
    return () => window.clearTimeout(id)
  }, [active, step, speed, maxStep, setStep])

  // Play/pause; pressing play at the end restarts from the start.
  const togglePlay = () => {
    if (step >= maxStep) {
      setStep(0)
      setPlaying(true)
    } else {
      setPlaying((p) => !p)
    }
  }

  const cfg = run.trace[step]
  const halted = step === maxStep
  const atHalt = halted && (run.outcome === 'accept' || run.outcome === 'reject')
  const v = verdictText(run.outcome)
  const nextRule = nextRuleFor(machine, run, step)

  return (
    <div className="tm-run">
      <div className="tm-state-bar">
        <span className="tm-state-cap">state</span>
        <span
          className={`tm-state-pill${cfg.state === machine.accept ? ' accept' : ''}${
            machine.reject && cfg.state === machine.reject ? ' reject' : ''
          }`}
        >
          {cfg.state}
        </span>
        {atHalt && <span className={`tm-halt ${v.cls}`}>● {v.label}</span>}
        {halted && run.outcome === 'timeout' && <span className="tm-halt maybe">● {v.label}</span>}
        {run.truncated && halted && <span className="note small">trace truncated for display</span>}
      </div>

      <Tape
        cells={cfg.cells}
        min={cfg.min}
        head={cfg.head}
        blank={machine.blank}
        show={(sym) => showTapeSym(machine, sym)}
      />

      <div className="tm-rule-readout">
        {atHalt ? (
          <span className="muted">no further moves — the machine has halted.</span>
        ) : nextRule ? (
          <>
            <span className="tm-rule-cap">next move</span>
            <code className="tm-rule">{ruleText(machine, nextRule)}</code>
          </>
        ) : (
          <span className="muted">no applicable rule — the machine halts and rejects here.</span>
        )}
      </div>

      <div className="sim-controls tm-controls">
        <button onClick={() => { setPlaying(false); setStep(0) }} disabled={step === 0} title="reset">⏮</button>
        <button onClick={() => { setPlaying(false); setStep((x) => Math.max(0, x - 1)) }} disabled={step === 0} title="step back">◀</button>
        <button className="play" onClick={togglePlay} disabled={maxStep === 0} title="play/pause">
          {active ? '⏸' : '▶'}
        </button>
        <button onClick={() => { setPlaying(false); setStep((x) => Math.min(maxStep, x + 1)) }} disabled={step >= maxStep} title="step forward">▶</button>
        <button onClick={() => { setPlaying(false); setStep(maxStep) }} disabled={step >= maxStep} title="to end">⏭</button>
        <span className="step-count">{step} / {maxStep}</span>
        <label className="tm-speed">
          speed
          <input type="range" min={1} max={30} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        </label>
      </div>

      <input
        className="tm-scrub"
        type="range"
        min={0}
        max={maxStep}
        value={step}
        onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)) }}
        aria-label="scrub steps"
      />
    </div>
  )
}

/** The rule that fires when stepping from config `i` to `i+1` (it is stored on config i+1 as `via`). */
function nextRuleFor(machine: TuringMachine, run: ReturnType<typeof runTM>, i: number): TMTransition | undefined {
  if (i + 1 < run.trace.length) return run.trace[i + 1].via
  // At the last stored config: only meaningful if it isn't a halt state.
  const cfg = run.trace[i]
  if (isHalting(machine, cfg.state)) return undefined
  return undefined
}

// ---------------------------------------------------------------------------
// Trace — the full configuration list.
// ---------------------------------------------------------------------------

function TraceTab({
  machine,
  run,
  step,
  setStep,
}: {
  machine: TuringMachine
  run: ReturnType<typeof runTM>
  step: number
  setStep: (n: number) => void
}) {
  const cap = 600
  const shown = run.trace.slice(0, cap)
  return (
    <div className="pad-scroll">
      <p className="note">
        Each row is a configuration: the control state and the tape (the head cell is{' '}
        <span className="tm-inline-head">boxed</span>). Click a row to jump the Run animation there.
        {run.trace.length > cap && ` Showing the first ${cap} of ${run.trace.length}.`}
      </p>
      <table className="tm-trace">
        <thead>
          <tr>
            <th>#</th>
            <th>state</th>
            <th>tape</th>
            <th>rule applied</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((cfg, i) => (
            <tr key={i} className={i === step ? 'cur' : ''} onClick={() => setStep(i)}>
              <td className="tm-trace-n">{i}</td>
              <td className="tm-trace-state">{cfg.state}</td>
              <td className="tm-trace-tape">{renderTape(machine, cfg)}</td>
              <td className="tm-trace-rule">{cfg.via ? ruleText(machine, cfg.via) : <span className="muted">— start —</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function renderTape(machine: TuringMachine, cfg: TMConfig) {
  return (
    <span className="tm-tape-mono">
      {cfg.cells.map((sym, i) => {
        const isHead = cfg.min + i === cfg.head
        const g = showTapeSym(machine, sym)
        return (
          <span key={i} className={isHead ? 'tm-inline-head' : undefined}>
            {g}
          </span>
        )
      })}
    </span>
  )
}

// ---------------------------------------------------------------------------
// δ-table — the transition function as a grid.
// ---------------------------------------------------------------------------

function TableTab({ machine, det }: { machine: TuringMachine; det: ReturnType<typeof analyzeDeterminism> }) {
  // Columns: every concrete tape symbol, plus a wildcard column if any `*` rule exists.
  const hasWild = machine.transitions.some((t) => t.read === WILDCARD)
  const cols = [...machine.tapeAlphabet, ...(hasWild ? [WILDCARD] : [])]
  // Rows: non-halting states (states with at least one outgoing rule).
  const rows = machine.states.filter((q) => machine.transitions.some((t) => t.state === q))
  const conflictKey = new Set(det.conflicts.map((c) => `${c.state} ${c.read}`))

  const cell = (q: string, sym: string): TMTransition[] => machine.transitions.filter((t) => t.state === q && t.read === sym)

  return (
    <div className="pad-scroll">
      <p className="note">
        δ(state, read) → (next, write, move). <code>_</code> = blank, <code>∗</code> = wildcard. A cell
        with two rules (highlighted) is where the machine branches — that makes it{' '}
        <b>{det.deterministic ? 'deterministic here' : 'nondeterministic'}</b>.
      </p>
      <div className="tm-table-wrap">
        <table className="tm-delta">
          <thead>
            <tr>
              <th className="corner">δ</th>
              {cols.map((c) => (
                <th key={c}>{c === WILDCARD ? '∗' : showTapeSym(machine, c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((q) => (
              <tr key={q}>
                <th className="tm-delta-state">{q}</th>
                {cols.map((c) => {
                  const ts = cell(q, c)
                  const conflict = conflictKey.has(`${q} ${c}`)
                  return (
                    <td key={c} className={`${ts.length ? '' : 'empty-cell'}${conflict ? ' conflict' : ''}`}>
                      {ts.map((t, i) => (
                        <span key={i} className="tm-cellrule">
                          {t.next}, {t.write === WILDCARD ? '∗' : showTapeSym(machine, t.write)},{' '}
                          {t.move}
                        </span>
                      ))}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note small">
        Halting states (accept <code>{machine.accept}</code>
        {machine.reject ? <>, reject <code>{machine.reject}</code></> : null}, or any state with no
        rules) are omitted as rows. An empty cell means the machine halts there with no move.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Diagram — reuse the shared graph renderer.
// ---------------------------------------------------------------------------

function DiagramTab({ machine, run, step }: { machine: TuringMachine; run: ReturnType<typeof runTM>; step: number }) {
  const { graph, indexOf } = useMemo(() => tmToGraph(machine), [machine])
  const cur = run.trace[Math.min(step, run.trace.length - 1)]
  const highlight = cur ? [indexOf(cur.state)] : []
  return (
    <div className="tm-diagram">
      <Graph graph={graph} highlight={highlight} fitKey={`tm:${machine.states.join()}`} exportName="turing-machine" />
      <p className="note small tm-diagram-note">
        Nodes are control states (the name is under each circle); the accept state has a double ring.
        Edge labels read <code>read→write,move</code> (◀ left, ▶ right, ■ stay). The highlighted node
        is the current Run state — scrub the Run tab to watch the head travel the graph.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hierarchy — where this machine sits, plus the regex → TM bridge.
// ---------------------------------------------------------------------------

const LEVELS = [
  { n: '0', name: 'Recursively enumerable', machine: 'Turing machine', note: 'the unrestricted top of the tower' },
  { n: '1', name: 'Context-sensitive', machine: 'Linear-bounded automaton', note: 'a TM that may not leave its input' },
  { n: '2', name: 'Context-free', machine: 'Pushdown automaton', note: 'the Grammar mode' },
  { n: '3', name: 'Regular', machine: 'Finite automaton', note: 'Explore / Compare / Build' },
]

function HierarchyTab({
  machine,
  onSource,
  onInput,
}: {
  machine: TuringMachine
  det: ReturnType<typeof analyzeDeterminism>
  onSource: (s: string) => void
  onInput: (s: string) => void
  run: ReturnType<typeof runTM>
}) {
  const [regex, setRegex] = useState('(a|b)*ab')
  const [err, setErr] = useState<string | null>(null)
  const here = machine.bounded ? '1' : '0'

  return (
    <div className="pad-scroll tm-hier">
      <h3 className="sec-h">The Chomsky hierarchy</h3>
      <p className="note">
        Each level is recognised by a strictly more powerful machine. This mode is the top: a Turing
        machine recognises the <b>recursively-enumerable</b> languages (and <b>decides</b> them when
        it always halts). Flip on <code>bounded:</code> and it becomes a linear-bounded automaton —
        exactly the <b>context-sensitive</b> level.
      </p>
      <div className="tm-tower">
        {LEVELS.map((lv) => (
          <div key={lv.n} className={`tm-level lv${lv.n}${lv.n === here ? ' here' : ''}`}>
            <div className="tm-level-n">Type-{lv.n}</div>
            <div className="tm-level-body">
              <div className="tm-level-name">{lv.name}</div>
              <div className="tm-level-machine">{lv.machine}</div>
            </div>
            <div className="tm-level-note">{lv.note}</div>
            {lv.n === here && <div className="tm-here-tag">▶ this machine</div>}
          </div>
        ))}
      </div>

      <h3 className="sec-h">The payoff — strictly more power</h3>
      <p className="note">
        The languages <code>aⁿbⁿcⁿ</code> and <code>w#w</code> are <b>not context-free</b> (the v4
        Grammar mode's CFL-pumping tab exhibits the failure) — no pushdown automaton recognises them.
        Yet the gallery's deciders for both run right here. That gap <em>is</em> the strictness of the
        hierarchy, made executable: load <code>aⁿbⁿcⁿ</code> from the examples and watch a machine do
        what a stack cannot.
      </p>

      <h3 className="sec-h">Bridge up: every regex is a Turing machine</h3>
      <p className="note">
        Conversely, every regular language sits inside this level. Compile a regex through the app's
        NFA → DFA → minimal-DFA pipeline into an equivalent <b>read-only, move-right</b> Turing
        machine — a finite automaton with a tape head.
      </p>
      <div className="tm-bridge">
        <input
          className="sim-input"
          value={regex}
          spellCheck={false}
          onChange={(e) => setRegex(e.target.value)}
          placeholder="regex, e.g. (a|b)*ab"
          aria-label="regex to convert"
        />
        <button
          className="ghost-btn"
          onClick={() => {
            const r = regexToTM(regex)
            if (r.machine) {
              setErr(null)
              onSource(tmSource(r.machine))
              onInput('abab')
            } else {
              setErr(r.error ?? 'could not compile')
            }
          }}
        >
          → load as a Turing machine
        </button>
      </div>
      {err && <div className="warn small">{err}</div>}
    </div>
  )
}

/** Serialize a machine to editable DSL (used by the regex bridge). */
function tmSource(tm: TuringMachine): string {
  const lines: string[] = [`start: ${tm.start}`, `accept: ${tm.accept}`]
  if (tm.reject) lines.push(`reject: ${tm.reject}`)
  if (tm.blank !== '_') lines.push(`blank: ${tm.blank}`)
  if (tm.bounded) lines.push('bounded: true')
  lines.push('')
  for (const t of tm.transitions) lines.push(`${t.state} ${t.read} -> ${t.next} ${t.write} ${t.move}`)
  return lines.join('\n')
}
