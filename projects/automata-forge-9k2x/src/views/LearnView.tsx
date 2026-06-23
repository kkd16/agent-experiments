import { useEffect, useMemo, useRef, useState } from 'react'
import { parse } from '../engine/parser'
import { deriveAlphabet } from '../engine/alphabet'
import { buildNfa } from '../engine/nfa'
import { subsetConstruction, minimizeDfa } from '../engine/dfa'
import { completeDfa } from '../engine/product'
import { dfaToGraph } from '../engine/graph'
import { showSym, showWord } from '../engine/types'
import { DfaTeacher } from '../engine/learn/teacher'
import { traceLearning } from '../engine/learn/lstar'
import type { LearnFrame, Strategy } from '../engine/learn/lstar'
import Graph from '../components/Graph'
import ObservationTable from '../components/ObservationTable'
import { Stat } from '../components/Stat'
import { LEARN_EXAMPLES } from '../engine/learn/examples'
import './LearnView.css'

export type LearnTab = 'table' | 'hypothesis' | 'target'

const TABS: { id: LearnTab; label: string }[] = [
  { id: 'table', label: 'Observation table' },
  { id: 'hypothesis', label: 'Hypothesis' },
  { id: 'target', label: 'Target (hidden)' },
]

interface Props {
  regex: string
  onRegex: (r: string) => void
  strategy: Strategy
  onStrategy: (s: Strategy) => void
  tab: LearnTab
  onTab: (t: LearnTab) => void
}

export default function LearnView({ regex, onRegex, strategy, onStrategy, tab, onTab }: Props) {
  const [cursor, setCursor] = useState(0)
  const [playing, setPlaying] = useState(false)

  // Compile the (hidden) target and run the whole learning trace. Pure data the slider scrubs.
  const session = useMemo(() => {
    const res = parse(regex)
    if (!res.ok) return { ok: false as const, error: res.error }
    const ast = res.ast
    const alpha = deriveAlphabet(ast)
    const target = completeDfa(minimizeDfa(subsetConstruction(buildNfa(ast, alpha))))
    const teacher = new DfaTeacher(target)
    const frames = traceLearning(teacher, strategy)
    return { ok: true as const, alpha, target, frames }
  }, [regex, strategy])

  const frameCount = session.ok ? session.frames.length : 0
  const maxCursor = Math.max(0, frameCount - 1)
  const clamped = Math.min(cursor, maxCursor)
  const frame: LearnFrame | null = session.ok ? session.frames[clamped] : null
  const isPlaying = playing && clamped < maxCursor

  // Auto-advance while playing.
  const playRef = useRef<number | null>(null)
  useEffect(() => {
    if (!playing || clamped >= maxCursor) return
    playRef.current = window.setTimeout(() => setCursor((c) => Math.min(c + 1, maxCursor)), 750)
    return () => {
      if (playRef.current) window.clearTimeout(playRef.current)
    }
  }, [playing, clamped, maxCursor])

  const reset = () => {
    setCursor(0)
    setPlaying(false)
  }
  const loadExample = (i: number) => {
    onRegex(LEARN_EXAMPLES[i].regex)
    reset()
  }
  const changeRegex = (r: string) => {
    onRegex(r)
    reset()
  }
  const changeStrategy = (s: Strategy) => {
    onStrategy(s)
    reset()
  }

  // How many conjectures have been posed up to (and including) this frame.
  const conjectureNo = session.ok
    ? session.frames.slice(0, clamped + 1).filter((f) => f.event.kind === 'conjecture').length
    : 0

  const finalFrame = session.ok ? session.frames[session.frames.length - 1] : null
  const converged = finalFrame?.event.kind === 'done'

  const hypGraph = useMemo(() => {
    if (!frame?.hyp) return null
    const g = dfaToGraph(frame.hyp.dfa)
    return {
      ...g,
      stateSub: frame.hyp.access.map((a) => {
        const w = showWord(a)
        return w.length <= 8 ? w : w.slice(0, 7) + '…'
      }),
    }
  }, [frame])

  const targetGraph = useMemo(() => (session.ok ? dfaToGraph(session.target) : null), [session])

  return (
    <>
      <section className="input-bar">
        <label className="regex-field">
          <span className="slash">/</span>
          <input
            value={regex}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => changeRegex(e.target.value)}
            placeholder="a regular language to learn…"
            aria-label="target regular expression"
          />
          <span className="slash">/</span>
        </label>
        <select
          className="examples"
          value=""
          onChange={(e) => e.target.value && loadExample(Number(e.target.value))}
          aria-label="load an example target"
        >
          <option value="">examples ▾</option>
          {LEARN_EXAMPLES.map((ex, i) => (
            <option key={i} value={i}>
              {ex.name}
            </option>
          ))}
        </select>
        <div className="strat-switch" role="tablist" aria-label="counterexample strategy">
          <button
            role="tab"
            aria-selected={strategy === 'angluin'}
            className={`strat-btn${strategy === 'angluin' ? ' active' : ''}`}
            title="Angluin 1987 — add every prefix of the counterexample to S"
            onClick={() => changeStrategy('angluin')}
          >
            Angluin
          </button>
          <button
            role="tab"
            aria-selected={strategy === 'rivest-schapire'}
            className={`strat-btn${strategy === 'rivest-schapire' ? ' active' : ''}`}
            title="Rivest–Schapire 1993 — binary-search one distinguishing suffix into E"
            onClick={() => changeStrategy('rivest-schapire')}
          >
            Rivest–Schapire
          </button>
        </div>
        {frame && (
          <div className="statline">
            <Stat k="states" v={frame.table.classes.length} title="states discovered so far (distinct row signatures in S)" />
            <Stat k="|E|" v={frame.table.E.length} title="experiments (columns)" />
            <Stat k="MQ" v={frame.membershipQueries} title="distinct membership queries to the teacher" />
            <Stat k="EQ" v={frame.equivalenceQueries} title="equivalence queries to the teacher" />
          </div>
        )}
      </section>

      {!session.ok ? (
        <div className="parse-error">
          <pre>
            {'/' + regex + '/'}
            {'\n  '}
            {' '.repeat(session.error.pos)}
            <span className="caret">^</span>
          </pre>
          <span className="err-msg">parse error: {session.error.message}</span>
        </div>
      ) : (
        <div className="alpha-bar">
          <span className="alpha-tag">alphabet</span>
          {session.alpha.symbols.map((s, i) => (
            <code key={i} className="alpha-sym">
              {showSym(s)}
            </code>
          ))}
          <span className="learn-hint">the learner sees only this Σ — never the target machine</span>
        </div>
      )}

      <div className="workspace">
        <main className="viewer">
          <nav className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`tab${tab === t.id ? ' active' : ''}`}
                onClick={() => onTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="canvas">
            {!session.ok ? (
              <div className="empty">Fix the pattern to start a learning session.</div>
            ) : tab === 'table' && frame ? (
              <ObservationTable table={frame.table} event={frame.event} />
            ) : tab === 'hypothesis' ? (
              hypGraph ? (
                <Graph graph={hypGraph} fitKey={`${regex}|${strategy}|hyp|${frame?.hyp?.dfa.numStates}`} exportName="hypothesis" />
              ) : (
                <div className="empty">No hypothesis yet — the table must close first.</div>
              )
            ) : tab === 'target' && targetGraph ? (
              <Graph graph={targetGraph} fitKey={`${regex}|target`} exportName="target" />
            ) : null}
          </div>
          {session.ok && (
            <div className="legend learn-legend">
              {tab === 'table' ? (
                <>
                  <span><i className="dot start" /> same colour = same discovered state</span>
                  <span className="learn-defect-key">↑ closedness defect (promoted)</span>
                  <span className="hint">cells are membership bits T[s·e]</span>
                </>
              ) : tab === 'target' ? (
                <span className="hint">
                  the ground truth the learner is converging to — it is <strong>never queried directly</strong>,
                  only through membership &amp; equivalence answers
                </span>
              ) : (
                <>
                  <span><i className="dot start" /> start</span>
                  <span><i className="dot accept" /> accepting</span>
                  <span className="hint">states are labelled by their access string</span>
                </>
              )}
            </div>
          )}
        </main>

        <aside className="rail">
          <section className="panel">
            <h2>Learning trace</h2>
            <p className="panel-sub">
              Scrub through L* one atomic action at a time — each membership bit, each table repair,
              each conjecture and counterexample.
            </p>
            <div className="sim-controls">
              <button onClick={reset} disabled={clamped === 0} title="restart">⏮</button>
              <button onClick={() => { setCursor((c) => Math.max(0, c - 1)); setPlaying(false) }} disabled={clamped === 0} title="step back">◀</button>
              <button
                className="play"
                onClick={() => {
                  if (clamped >= maxCursor) { setCursor(0); setPlaying(true) }
                  else setPlaying((p) => !p)
                }}
              >
                {isPlaying ? '⏸ pause' : clamped >= maxCursor ? '↺ replay' : '▶ play'}
              </button>
              <button onClick={() => { setCursor((c) => Math.min(maxCursor, c + 1)); setPlaying(false) }} disabled={clamped >= maxCursor} title="step forward">▶</button>
              <button onClick={() => { setCursor(maxCursor); setPlaying(false) }} disabled={clamped >= maxCursor} title="run to convergence">⏭</button>
            </div>
            <div className="learn-progress">
              <span className="step-count">step {clamped} / {maxCursor}</span>
              {converged && clamped === maxCursor && <span className="pill yes">learned ✓</span>}
            </div>
          </section>

          {frame && (
            <section className="panel learn-event">
              <h2>What just happened</h2>
              <EventCard frame={frame} conjectureNo={conjectureNo} />
            </section>
          )}

          {session.ok && (
            <section className="panel">
              <h2>Convergence</h2>
              {converged ? (
                <p className="panel-sub">
                  L* reconstructed the <strong>minimal DFA</strong> ({finalFrame!.hyp!.dfa.numStates}{' '}
                  states) using <strong>{finalFrame!.membershipQueries}</strong> distinct membership
                  queries and <strong>{finalFrame!.equivalenceQueries}</strong> equivalence queries
                  (+{finalFrame!.cacheHits} cached table re-reads). The result is{' '}
                  <em>provably</em> the unique minimal automaton — verified live against the product
                  equivalence check.
                </p>
              ) : (
                <p className="panel-sub">
                  Learning in progress. So far: {frame?.table.classes.length} states,{' '}
                  {frame?.membershipQueries} membership and {frame?.equivalenceQueries} equivalence
                  queries.
                </p>
              )}
            </section>
          )}

          <section className="panel">
            <h2>{strategy === 'angluin' ? 'Angluin (1987)' : 'Rivest–Schapire (1993)'}</h2>
            <p className="panel-sub">
              {strategy === 'angluin' ? (
                <>
                  The original counterexample rule: add <strong>every prefix</strong> of the
                  counterexample to S. Simple, but it can leave the table <em>inconsistent</em>, so a
                  repair step then adds an experiment a·e to E to split the confused rows.
                </>
              ) : (
                <>
                  A <strong>binary search</strong> over the counterexample finds the one position
                  where the hypothesis "lies", and adds a single distinguishing <strong>suffix</strong>{' '}
                  to E. Only ⌈log₂ m⌉ membership queries per counterexample, and the table stays
                  consistent by construction — no consistency repairs ever needed.
                </>
              )}
            </p>
          </section>

          <section className="panel about">
            <h2>How L* works</h2>
            <ol>
              <li>Keep a table: rows = access strings S (∪ their extensions S·Σ), columns = experiments E.</li>
              <li>Each cell T[s·e] is one membership query: does the target accept s·e?</li>
              <li>A row's bit-vector is its signature; equal signatures ⇒ same state (so far).</li>
              <li><strong>Close</strong> the table: every boundary row must match some S-row.</li>
              <li><strong>Consistency</strong>: equal rows must stay equal after every symbol.</li>
              <li>Read off a hypothesis DFA and ask an equivalence query.</li>
              <li>Fold the counterexample back in and repeat — until the teacher says yes.</li>
            </ol>
          </section>
        </aside>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// A human description of the current step.
// ---------------------------------------------------------------------------
function EventCard({ frame, conjectureNo }: { frame: LearnFrame; conjectureNo: number }) {
  const ev = frame.event
  switch (ev.kind) {
    case 'init':
      return (
        <p className="panel-sub">
          Initialised the table with <code>S = {'{ε}'}</code> and <code>E = {'{ε}'}</code>, and asked
          the first membership query.
        </p>
      )
    case 'close':
      return (
        <p className="panel-sub">
          <span className="ev-tag close">close</span> Boundary row <code>{showWord(ev.promoted)}</code>{' '}
          has a signature no S-row had, so it is <strong>promoted into S</strong> as a brand-new
          state.
        </p>
      )
    case 'consistent':
      return (
        <p className="panel-sub">
          <span className="ev-tag consistent">consistency</span> Rows <code>{showWord(ev.s1)}</code> and{' '}
          <code>{showWord(ev.s2)}</code> looked identical but diverge after{' '}
          <code>{showSym(ev.symbol)}</code>. Added experiment <code>{showWord(ev.added)}</code> to E to
          tell them apart.
        </p>
      )
    case 'conjecture':
      return ev.counterexample === null ? (
        <p className="panel-sub">
          <span className="ev-tag ok">conjecture #{conjectureNo}</span> The {ev.hyp.numStates}-state
          hypothesis is <strong>accepted by the teacher</strong> — it is exactly the target language.
        </p>
      ) : (
        <p className="panel-sub">
          <span className="ev-tag conj">conjecture #{conjectureNo}</span> Proposed a{' '}
          {ev.hyp.numStates}-state DFA. The teacher disagrees and returns the shortest{' '}
          <strong>counterexample</strong> <code>{showWord(ev.counterexample)}</code>.
        </p>
      )
    case 'counterexample':
      return ev.strategy === 'angluin' ? (
        <p className="panel-sub">
          <span className="ev-tag ce">counterexample</span> Folded <code>{showWord(ev.word)}</code> in
          by adding its prefixes{' '}
          {ev.addedRows && ev.addedRows.length
            ? ev.addedRows.map((r, i) => (
                <code key={i} className="ev-chip">{showWord(r)}</code>
              ))
            : '(none new)'}{' '}
          to S.
        </p>
      ) : (
        <p className="panel-sub">
          <span className="ev-tag ce">counterexample</span> Binary-searched <code>{showWord(ev.word)}</code>;
          the hypothesis flips at position <strong>i = {ev.breakpoint}</strong>, so the distinguishing
          suffix <code>{showWord(ev.addedSuffix ?? [])}</code> is added to E.
        </p>
      )
    case 'done':
      return (
        <p className="panel-sub">
          <span className="ev-tag ok">done</span> The hypothesis equals the target. The minimal DFA
          has <strong>{ev.hyp.numStates}</strong> states.
        </p>
      )
  }
}
