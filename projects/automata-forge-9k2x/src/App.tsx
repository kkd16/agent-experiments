import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { parse } from './engine/parser'
import { deriveAlphabet } from './engine/alphabet'
import { buildNfa } from './engine/nfa'
import { minimizeDfa, subsetConstruction } from './engine/dfa'
import { dfaToGraph, nfaToGraph } from './engine/graph'
import { simulateDfa, simulateNfa } from './engine/simulate'
import type { SimResult } from './engine/simulate'
import { accepts, sampleLanguage } from './engine/sample'
import { showSym } from './engine/types'
import Graph from './components/Graph'
import AstView from './components/AstView'
import { EXAMPLES } from './examples'

type Tab = 'ast' | 'nfa' | 'dfa' | 'min'

const TABS: { id: Tab; label: string }[] = [
  { id: 'ast', label: 'Parse tree' },
  { id: 'nfa', label: 'ε-NFA' },
  { id: 'dfa', label: 'DFA' },
  { id: 'min', label: 'Minimal DFA' },
]

export default function App() {
  const [regex, setRegex] = useState(EXAMPLES[0].regex)
  const [tab, setTab] = useState<Tab>('nfa')
  const [input, setInput] = useState(EXAMPLES[0].test)
  const [rawStep, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [member, setMember] = useState('')

  // --- compile the regex through the whole pipeline -------------------------
  const compiled = useMemo(() => {
    const res = parse(regex)
    if (!res.ok) return { ok: false as const, error: res.error }
    const ast = res.ast
    const alpha = deriveAlphabet(ast)
    const nfa = buildNfa(ast)
    const dfaFull = subsetConstruction(nfa)
    const minimal = minimizeDfa(dfaFull)
    return {
      ok: true as const,
      ast,
      alpha,
      nfa,
      dfaFull,
      minimal,
      nfaGraph: nfaToGraph(nfa),
      dfaGraph: dfaToGraph(dfaFull),
      minGraph: dfaToGraph(minimal),
    }
  }, [regex])

  // --- simulation for the currently displayed machine -----------------------
  const sim: SimResult | null = useMemo(() => {
    if (!compiled.ok) return null
    if (tab === 'dfa') return simulateDfa(compiled.dfaFull, input, compiled.alpha)
    if (tab === 'min') return simulateDfa(compiled.minimal, input, compiled.alpha)
    // 'nfa' and 'ast' both use the NFA trace.
    return simulateNfa(compiled.nfa, input, compiled.alpha)
  }, [compiled, tab, input])

  const maxStep = sim ? sim.steps.length - 1 : 0
  // Derive the visible step rather than clamping in an effect (avoids cascading renders).
  const step = Math.min(rawStep, maxStep)
  const isPlaying = playing && step < maxStep

  // Auto-play through the trace. The "stop at the end" decision lives in the guard, not in a
  // synchronous setState, so this effect only ever schedules a timer.
  const playRef = useRef<number | null>(null)
  useEffect(() => {
    if (!playing || step >= maxStep) return
    playRef.current = window.setTimeout(() => setStep((s) => Math.min(s + 1, maxStep)), 650)
    return () => {
      if (playRef.current) window.clearTimeout(playRef.current)
    }
  }, [playing, step, maxStep])

  const highlight = sim?.steps[step]?.active ?? []

  // --- language sampler -----------------------------------------------------
  const samples = useMemo(
    () => (compiled.ok ? sampleLanguage(compiled.minimal, 14) : []),
    [compiled],
  )
  const memberVerdict = useMemo(() => {
    if (!compiled.ok || member === '') return null
    return accepts(compiled.minimal, member, compiled.alpha)
  }, [compiled, member])

  const loadExample = (i: number) => {
    setRegex(EXAMPLES[i].regex)
    setInput(EXAMPLES[i].test)
    setStep(0)
    setPlaying(false)
  }

  const graph = !compiled.ok
    ? null
    : tab === 'nfa'
      ? compiled.nfaGraph
      : tab === 'dfa'
        ? compiled.dfaGraph
        : tab === 'min'
          ? compiled.minGraph
          : null

  const stats = compiled.ok
    ? {
        alpha: compiled.alpha.symbols.length,
        nfa: compiled.nfa.numStates,
        dfa: compiled.dfaFull.numStates,
        min: compiled.minimal.numStates,
      }
    : null

  const machineName =
    tab === 'dfa' ? 'DFA' : tab === 'min' ? 'minimal DFA' : 'ε-NFA'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◎</span>
          <div>
            <h1>Automata Forge</h1>
            <p className="tag">regex → ε-NFA → DFA → minimal DFA, built from scratch</p>
          </div>
        </div>
        {stats && (
          <div className="statline">
            <Stat k="Σ" v={stats.alpha} title="alphabet size (incl. ∗ = any other char)" />
            <Stat k="NFA" v={stats.nfa} title="ε-NFA states (Thompson)" />
            <Stat k="DFA" v={stats.dfa} title="subset-construction states (complete, with trap)" />
            <Stat k="min" v={stats.min} title="Hopcroft-minimized states" />
            {stats.dfa > 0 && (
              <span className="reduce" title="DFA states removed by minimization">
                −{Math.round((1 - stats.min / stats.dfa) * 100)}%
              </span>
            )}
          </div>
        )}
      </header>

      <section className="input-bar">
        <label className="regex-field">
          <span className="slash">/</span>
          <input
            value={regex}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setRegex(e.target.value)
              setStep(0)
              setPlaying(false)
            }}
            placeholder="type a regular expression…"
            aria-label="regular expression"
          />
          <span className="slash">/</span>
        </label>
        <select
          className="examples"
          value=""
          onChange={(e) => e.target.value && loadExample(Number(e.target.value))}
          aria-label="load an example"
        >
          <option value="">examples ▾</option>
          {EXAMPLES.map((ex, i) => (
            <option key={i} value={i}>
              {ex.name}
            </option>
          ))}
        </select>
      </section>

      {!compiled.ok ? (
        <div className="parse-error">
          <pre>
            {'/' + regex + '/'}
            {'\n  '}
            {' '.repeat(compiled.error.pos)}
            <span className="caret">^</span>
          </pre>
          <span className="err-msg">parse error: {compiled.error.message}</span>
        </div>
      ) : (
        <div className="alpha-bar">
          <span className="alpha-tag">alphabet</span>
          {compiled.alpha.symbols.map((s, i) => (
            <code key={i} className="alpha-sym">
              {showSym(s)}
            </code>
          ))}
          {compiled.alpha.truncated && (
            <span className="warn">large range truncated for display</span>
          )}
        </div>
      )}

      <div className="workspace">
        <main className="viewer">
          <nav className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`tab${tab === t.id ? ' active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="canvas">
            {!compiled.ok ? (
              <div className="empty">Fix the pattern to see its machines.</div>
            ) : tab === 'ast' ? (
              <AstView ast={compiled.ast} />
            ) : graph ? (
              <Graph graph={graph} highlight={highlight} fitKey={`${regex}|${tab}`} />
            ) : null}
          </div>
          {compiled.ok && tab !== 'ast' && (
            <div className="legend">
              <span>
                <i className="dot start" /> start
              </span>
              <span>
                <i className="dot accept" /> accepting
              </span>
              <span>
                <i className="dot active" /> active
              </span>
              <span className="hint">scroll = zoom · drag = pan · drag a node to move it</span>
            </div>
          )}
        </main>

        <aside className="rail">
          <section className="panel">
            <h2>Simulate</h2>
            <p className="panel-sub">
              Run a string through the <strong>{machineName}</strong>.
              {tab === 'nfa' || tab === 'ast'
                ? ' The whole active set (ε-closure) lights up at each step.'
                : ' One state is active at each step.'}
            </p>
            <input
              className="sim-input"
              value={input}
              spellCheck={false}
              onChange={(e) => {
                setInput(e.target.value)
                setStep(0)
                setPlaying(false)
              }}
              placeholder="input string"
              aria-label="simulation input string"
            />
            <div className="tape">
              {input.length === 0 && <span className="tape-empty">ε (empty string)</span>}
              {[...input].map((ch, i) => {
                const consumed = i < step
                const current = i === step - 1
                return (
                  <span
                    key={i}
                    className={`cell${consumed ? ' consumed' : ''}${current ? ' current' : ''}`}
                  >
                    {ch === ' ' ? '␣' : ch}
                  </span>
                )
              })}
            </div>
            <div className="sim-controls">
              <button onClick={() => { setStep(0); setPlaying(false) }} disabled={step === 0}>⏮</button>
              <button onClick={() => { setStep((s) => Math.max(0, s - 1)); setPlaying(false) }} disabled={step === 0}>◀</button>
              <button
                className="play"
                onClick={() => {
                  if (step >= maxStep) {
                    setStep(0)
                    setPlaying(true)
                  } else {
                    setPlaying((p) => !p)
                  }
                }}
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
              {sim && (
                <span className="active-states">
                  active: {highlight.length ? highlight.map((s) => `q${s}`).join(', ') : '∅'}
                </span>
              )}
            </div>
          </section>

          <section className="panel">
            <h2>Language</h2>
            <p className="panel-sub">
              Shortest strings the minimal DFA accepts (∗ = any other char) — click to load:
            </p>
            <div className="samples">
              {samples.length === 0 ? (
                <span className="tape-empty">∅ — the language is empty</span>
              ) : (
                samples.map((s, i) => (
                  <code
                    key={i}
                    className="sample"
                    onClick={() => {
                      setInput(s.display === 'ε' ? '' : s.display.replace(/∗/g, '?'))
                      setStep(0)
                      setPlaying(false)
                    }}
                  >
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
                aria-label="membership test string"
              />
              {memberVerdict !== null && (
                <span className={`pill ${memberVerdict ? 'yes' : 'no'}`}>
                  {memberVerdict ? 'in language' : 'rejected'}
                </span>
              )}
            </div>
          </section>

          <section className="panel about">
            <h2>How it works</h2>
            <ol>
              <li>A recursive-descent parser turns the regex into an AST.</li>
              <li>An alphabet is derived; unseen characters fold onto the ∗ symbol.</li>
              <li>Thompson's construction wires the AST into an ε-NFA.</li>
              <li>Subset construction determinizes it into a complete DFA.</li>
              <li>Hopcroft's algorithm merges equivalent states into the minimal DFA.</li>
            </ol>
          </section>
        </aside>
      </div>
    </div>
  )
}

function Stat({ k, v, title }: { k: string; v: number; title: string }) {
  return (
    <span className="stat" title={title}>
      <span className="stat-k">{k}</span>
      <span className="stat-v">{v}</span>
    </span>
  )
}
