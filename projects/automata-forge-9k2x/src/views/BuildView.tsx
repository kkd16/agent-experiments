import { useEffect, useMemo, useRef, useState } from 'react'
import EditGraph from '../components/EditGraph'
import type { EditTool } from '../components/EditGraph'
import Graph from '../components/Graph'
import NerodeTable from '../components/NerodeTable'
import { Stat } from '../components/Stat'
import {
  BUILD_TEMPLATES,
  addTransition,
  analyze,
  editToNfa,
  emptyAutomaton,
  removeState,
  removeTransition,
  setStart,
  toggleAccept,
} from '../engine/edit'
import type { EditAutomaton } from '../engine/edit'
import { subsetConstruction, minimizeDfa, prettyDfa } from '../engine/dfa'
import { dfaToGraph } from '../engine/graph'
import { nerode } from '../engine/myhill'
import { nfaToRegex } from '../engine/nfa2regex'
import { dfaToRegex } from '../engine/gnfa'
import { reverseToNfa, complementDfa } from '../engine/operations'
import { simulateDfa, simulateNfa } from '../engine/simulate'
import type { SimResult } from '../engine/simulate'
import { accepts, sampleLanguage } from '../engine/sample'
import { showChar, showSym } from '../engine/types'

export type BuildTab = 'editor' | 'dfa' | 'min' | 'mn'

const TABS: { id: BuildTab; label: string }[] = [
  { id: 'editor', label: 'Editor' },
  { id: 'dfa', label: 'Determinized DFA' },
  { id: 'min', label: 'Minimal DFA' },
  { id: 'mn', label: 'Myhill–Nerode' },
]

interface Props {
  automaton: EditAutomaton
  onAutomaton: (a: EditAutomaton) => void
  tab: BuildTab
  onTab: (t: BuildTab) => void
  input: string
  onInput: (s: string) => void
}

export default function BuildView({ automaton, onAutomaton, tab, onTab, input, onInput }: Props) {
  const [tool, setTool] = useState<EditTool>('move')
  const [member, setMember] = useState('')
  const [rawStep, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)

  const states = automaton.states
  const idxOf = (id: number) => states.findIndex((s) => s.id === id)
  const an = analyze(automaton)

  // --- run the whole pipeline on the drawn machine --------------------------
  const compiled = useMemo(() => {
    const c = editToNfa(automaton)
    if (!c) return null
    const dfaFull = subsetConstruction(c.nfa)
    const minimal = minimizeDfa(dfaFull)
    const revDfa = minimizeDfa(subsetConstruction(reverseToNfa(prettyDfa(dfaFull))))
    const compDfa = complementDfa(minimal)
    return {
      ...c,
      dfaFull,
      minimal,
      nerode: nerode(dfaFull),
      dfaGraph: dfaToGraph(dfaFull),
      minGraph: dfaToGraph(minimal),
      directRegex: nfaToRegex(c.nfa),
      dfaRegex: dfaToRegex(minimal),
      reverseRegex: dfaToRegex(revDfa),
      complementRegex: dfaToRegex(prettyDfa(compDfa)),
    }
  }, [automaton])

  // --- simulation for the active tab ----------------------------------------
  const sim: SimResult | null = useMemo(() => {
    if (!compiled) return null
    if (tab === 'dfa' || tab === 'mn') return simulateDfa(compiled.dfaFull, input, compiled.alphabet)
    if (tab === 'min') return simulateDfa(compiled.minimal, input, compiled.alphabet)
    return simulateNfa(compiled.nfa, input, compiled.alphabet)
  }, [compiled, tab, input])

  const maxStep = sim ? sim.steps.length - 1 : 0
  const step = Math.min(rawStep, maxStep)
  const isPlaying = playing && step < maxStep
  const playRef = useRef<number | null>(null)
  useEffect(() => {
    if (!playing || step >= maxStep) return
    playRef.current = window.setTimeout(() => setStep((s) => Math.min(s + 1, maxStep)), 650)
    return () => {
      if (playRef.current) window.clearTimeout(playRef.current)
    }
  }, [playing, step, maxStep])

  const active = useMemo(() => sim?.steps[step]?.active ?? [], [sim, step])
  // On the editor canvas, map the NFA's active indices back to editor state ids.
  const editorHighlight = useMemo(() => {
    if (!compiled || tab !== 'editor') return []
    return active.map((i) => compiled.toEditId[i]).filter((id) => id >= 0)
  }, [compiled, tab, active])

  const samples = useMemo(
    () => (compiled ? sampleLanguage(compiled.minimal, 14) : []),
    [compiled],
  )
  const memberVerdict = useMemo(() => {
    if (!compiled || member === '') return null
    return accepts(compiled.minimal, member, compiled.alphabet)
  }, [compiled, member])

  const resetSim = () => {
    setStep(0)
    setPlaying(false)
  }
  const edit = (next: EditAutomaton) => {
    onAutomaton(next)
    resetSim()
  }

  const stats = compiled
    ? {
        states: states.length,
        alpha: compiled.alphabet.symbols.length,
        dfa: compiled.dfaFull.numStates,
        min: compiled.minimal.numStates,
      }
    : null

  // --- transition add form --------------------------------------------------
  const [tf, setTf] = useState<{ from: number; to: number; sym: string; eps: boolean }>({
    from: 0,
    to: 0,
    sym: '',
    eps: false,
  })

  const machineName =
    tab === 'editor' ? `your ${an.kind === 'empty' ? 'machine' : an.kind}` : tab === 'min' ? 'minimal DFA' : 'DFA'

  return (
    <>
      <section className="input-bar">
        <select
          className="examples"
          value=""
          onChange={(e) => {
            if (e.target.value) {
              edit(BUILD_TEMPLATES[Number(e.target.value)].make())
            }
          }}
          aria-label="load a template"
        >
          <option value="">load a machine ▾</option>
          {BUILD_TEMPLATES.map((t, i) => (
            <option key={i} value={i}>
              {t.name}
            </option>
          ))}
        </select>
        <button className="examples" onClick={() => edit(emptyAutomaton())}>
          clear ✕
        </button>
        <div className={`kind-badge ${an.kind === 'empty' ? 'empty' : an.kind === 'DFA' ? 'dfa' : 'nfa'}`}>
          {an.kind === 'empty' ? 'no states' : an.kind}
          {an.kind === 'DFA' && (an.complete ? ' · complete' : ' · partial')}
          {an.hasEpsilon ? '' : ''}
        </div>
        {an.noStart && states.length > 0 && <span className="warn">⚠ no start state set</span>}
        {stats && (
          <div className="statline">
            <Stat k="Q" v={stats.states} title="states you drew" />
            <Stat k="Σ" v={stats.alpha} title="alphabet size" />
            <Stat k="DFA" v={stats.dfa} title="determinized states (with trap)" />
            <Stat k="min" v={stats.min} title="minimal DFA states" />
          </div>
        )}
      </section>

      <div className="workspace">
        <main className="viewer">
          {tab === 'editor' && (
            <div className="edit-toolbar" role="toolbar" aria-label="editor tools">
              <button className={`edit-tool${tool === 'move' ? ' active' : ''}`} onClick={() => setTool('move')} title="Select & drag states">
                ✥ Move
              </button>
              <button className={`edit-tool${tool === 'state' ? ' active' : ''}`} onClick={() => setTool('state')} title="Click the canvas to add a state">
                ＋ State
              </button>
              <button className={`edit-tool${tool === 'edge' ? ' active' : ''}`} onClick={() => setTool('edge')} title="Click a source state, then a target, to add a transition">
                → Edge
              </button>
              <button className={`edit-tool${tool === 'delete' ? ' active' : ''}`} onClick={() => setTool('delete')} title="Click a state or transition to delete it">
                ⌫ Delete
              </button>
              <span className="edit-tool-spacer" />
              <span className="edit-toolhint">double-click a state = toggle accepting</span>
            </div>
          )}
          {tab !== 'editor' && (
            <nav className="tabs">
              {TABS.map((t) => (
                <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => onTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </nav>
          )}
          {tab === 'editor' && (
            <nav className="tabs subtabs">
              {TABS.map((t) => (
                <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => onTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </nav>
          )}

          <div className="canvas">
            {tab === 'editor' ? (
              <EditGraph automaton={automaton} onChange={edit} tool={tool} highlight={editorHighlight} />
            ) : !compiled ? (
              <div className="empty">Draw a machine and set a start state to determinize it.</div>
            ) : tab === 'mn' ? (
              <NerodeTable result={compiled.nerode} />
            ) : (
              <Graph
                graph={tab === 'min' ? compiled.minGraph : compiled.dfaGraph}
                highlight={active}
                fitKey={`${tab}|${states.length}|${automaton.transitions.length}`}
                exportName={tab === 'min' ? 'minimal' : 'dfa'}
              />
            )}
          </div>

          {tab !== 'mn' && (
            <div className="legend">
              <span><i className="dot start" /> start</span>
              <span><i className="dot accept" /> accepting</span>
              <span><i className="dot active" /> active</span>
              <span className="hint">
                {tab === 'editor'
                  ? 'build it here · every machine below updates live'
                  : 'scroll = zoom · drag = pan'}
              </span>
            </div>
          )}
        </main>

        <aside className="rail">
          {/* ---- structure editor ---- */}
          <section className="panel">
            <h2>States</h2>
            {states.length === 0 ? (
              <p className="tape-empty">No states yet. Use ＋ State on the canvas.</p>
            ) : (
              <ul className="struct-list">
                {states.map((s, i) => (
                  <li key={s.id}>
                    <span className="struct-q">q{i}</span>
                    <label className="struct-ctl" title="start state">
                      <input
                        type="radio"
                        name="build-start"
                        checked={automaton.start === s.id}
                        onChange={() => edit(setStart(automaton, s.id))}
                      />
                      start
                    </label>
                    <label className="struct-ctl" title="accepting state">
                      <input
                        type="checkbox"
                        checked={s.accepting}
                        onChange={() => edit(toggleAccept(automaton, s.id))}
                      />
                      accept
                    </label>
                    <button className="struct-del" title="delete state" onClick={() => edit(removeState(automaton, s.id))}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <h2>Transitions</h2>
            {automaton.transitions.length === 0 ? (
              <p className="tape-empty">No transitions yet.</p>
            ) : (
              <ul className="struct-list">
                {automaton.transitions.map((t, i) => (
                  <li key={i}>
                    <span className="struct-trans">
                      q{idxOf(t.from)} <span className="struct-arrow">—{t.symbol === null ? 'ε' : showChar(t.symbol)}→</span> q{idxOf(t.to)}
                    </span>
                    <button className="struct-del" title="delete transition" onClick={() => edit(removeTransition(automaton, i))}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {states.length > 0 && (
              <div className="trans-add">
                <select value={tf.from} onChange={(e) => setTf({ ...tf, from: Number(e.target.value) })}>
                  {states.map((s, i) => <option key={s.id} value={i}>q{i}</option>)}
                </select>
                <input
                  className="trans-sym"
                  value={tf.eps ? 'ε' : tf.sym}
                  disabled={tf.eps}
                  spellCheck={false}
                  placeholder="sym"
                  onChange={(e) => setTf({ ...tf, sym: e.target.value })}
                />
                <select value={tf.to} onChange={(e) => setTf({ ...tf, to: Number(e.target.value) })}>
                  {states.map((s, i) => <option key={s.id} value={i}>q{i}</option>)}
                </select>
                <label className="trans-eps" title="ε-transition">
                  <input type="checkbox" checked={tf.eps} onChange={(e) => setTf({ ...tf, eps: e.target.checked })} />ε
                </label>
                <button
                  className="trans-addbtn"
                  onClick={() => {
                    const from = states[tf.from]?.id
                    const to = states[tf.to]?.id
                    if (from === undefined || to === undefined) return
                    if (tf.eps) edit(addTransition(automaton, from, to, null))
                    else {
                      let next = automaton
                      for (const ch of tf.sym) next = addTransition(next, from, to, ch)
                      edit(next)
                    }
                    setTf({ ...tf, sym: '' })
                  }}
                >
                  add
                </button>
              </div>
            )}
          </section>

          {/* ---- simulate ---- */}
          <section className="panel">
            <h2>Simulate</h2>
            <p className="panel-sub">
              Run a string through <strong>{machineName}</strong>.
              {tab === 'editor' ? ' Every reachable configuration (ε-closure) lights up.' : ' One state is active at each step.'}
            </p>
            <input
              className="sim-input"
              value={input}
              spellCheck={false}
              onChange={(e) => {
                onInput(e.target.value)
                resetSim()
              }}
              placeholder="input string"
              aria-label="simulation input"
            />
            <div className="tape">
              {input.length === 0 && <span className="tape-empty">ε (empty string)</span>}
              {[...input].map((ch, i) => {
                const consumed = i < step
                const current = i === step - 1
                return (
                  <span key={i} className={`cell${consumed ? ' consumed' : ''}${current ? ' current' : ''}`}>
                    {ch === ' ' ? '␣' : ch}
                  </span>
                )
              })}
            </div>
            <div className="sim-controls">
              <button onClick={() => resetSim()} disabled={step === 0}>⏮</button>
              <button onClick={() => { setStep((s) => Math.max(0, s - 1)); setPlaying(false) }} disabled={step === 0}>◀</button>
              <button
                className="play"
                onClick={() => {
                  if (step >= maxStep) { setStep(0); setPlaying(true) } else setPlaying((p) => !p)
                }}
                disabled={!sim}
              >
                {isPlaying ? '⏸ pause' : '▶ play'}
              </button>
              <button onClick={() => { setStep((s) => Math.min(maxStep, s + 1)); setPlaying(false) }} disabled={step >= maxStep}>▶</button>
              <button onClick={() => { setStep(maxStep); setPlaying(false) }} disabled={step >= maxStep}>⏭</button>
            </div>
            <div className="sim-status">
              <span className="step-count">step {step} / {maxStep}</span>
              {sim && step === maxStep && (
                <span className={`verdict ${sim.accepted ? 'accept' : 'reject'}`}>
                  {sim.accepted ? '✓ accepted' : sim.stuck ? '✗ rejected (stuck)' : '✗ rejected'}
                </span>
              )}
            </div>
          </section>

          {/* ---- language ---- */}
          {compiled && (
            <section className="panel">
              <h2>Language</h2>
              <p className="panel-sub">Shortest strings your machine accepts — click to load:</p>
              <div className="samples">
                {samples.length === 0 ? (
                  <span className="tape-empty">∅ — the language is empty</span>
                ) : (
                  samples.map((s, i) => (
                    <code key={i} className="sample" onClick={() => { onInput(s.display === 'ε' ? '' : s.display); resetSim() }}>
                      {s.display}
                    </code>
                  ))
                )}
              </div>
              <div className="member">
                <input
                  value={member}
                  spellCheck={false}
                  onChange={(e) => setMember(e.target.value)}
                  placeholder="test membership…"
                  aria-label="membership test"
                />
                {memberVerdict !== null && (
                  <span className={`pill ${memberVerdict ? 'yes' : 'no'}`}>
                    {memberVerdict ? 'in language' : 'rejected'}
                  </span>
                )}
              </div>
            </section>
          )}

          {/* ---- reconstructed regex + closure ---- */}
          {compiled && (
            <section className="panel">
              <h2>Regex from your machine</h2>
              <p className="panel-sub">
                State elimination run <strong>directly on the {an.kind}</strong> (no determinization)
                — Kleene's theorem closing the loop:
              </p>
              <code className="reconstructed">/{compiled.directRegex}/</code>
              <p className="panel-sub" style={{ marginTop: 8 }}>via the minimal DFA (often tidier):</p>
              <code className="reconstructed">/{compiled.dfaRegex}/</code>
            </section>
          )}

          {compiled && (
            <section className="panel">
              <h2>Closure properties</h2>
              <p className="panel-sub">
                Regular languages are closed under these operations — here are regexes for them,
                computed straight from your machine:
              </p>
              <div className="closure-row">
                <span className="closure-tag">reverse</span>
                <code className="reconstructed inline">/{compiled.reverseRegex}/</code>
              </div>
              <div className="closure-row">
                <span className="closure-tag">complement</span>
                <code className="reconstructed inline">/{compiled.complementRegex}/</code>
              </div>
              <p className="panel-sub" style={{ marginTop: 8, marginBottom: 0 }}>
                (complement is over Σ = {'{'}
                {compiled.alphabet.symbols.map(showSym).join(', ') || '∅'}
                {'}'} — symbols outside Σ are always rejected.)
              </p>
            </section>
          )}

          <section className="panel about">
            <h2>How it works</h2>
            <ol>
              <li>You draw states and transitions (a DFA, NFA, or ε-NFA).</li>
              <li>Accepting states route via ε to one synthetic accept, giving a clean ε-NFA.</li>
              <li>Subset construction determinizes it; Hopcroft minimizes it.</li>
              <li>Myhill–Nerode recovers the same classes by the table-filling algorithm.</li>
              <li>State elimination reads a regex straight off your (possibly nondeterministic) machine.</li>
              <li>Reversal and complement are read off too — closure made tangible.</li>
            </ol>
          </section>
        </aside>
      </div>
    </>
  )
}
