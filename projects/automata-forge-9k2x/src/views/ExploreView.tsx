import { useEffect, useMemo, useRef, useState } from 'react'
import { parse } from '../engine/parser'
import { deriveAlphabet } from '../engine/alphabet'
import type { Alphabet } from '../engine/alphabet'
import { buildNfa } from '../engine/nfa'
import { minimizeDfa, subsetConstruction } from '../engine/dfa'
import { dfaToGraph, nfaToGraph } from '../engine/graph'
import { dfaToRegex } from '../engine/gnfa'
import { simulateDfa, simulateNfa } from '../engine/simulate'
import type { SimResult } from '../engine/simulate'
import { accepts, sampleLanguage } from '../engine/sample'
import { acceptsSyms } from '../engine/product'
import { OTHER, showSym } from '../engine/types'
import type { Ast, Dfa, Sym } from '../engine/types'
import { astToDer, buildDfaByDerivatives, derivative, nullable, show } from '../engine/derivative'
import { decompose, findPumpableWord, pump, pumpingLength } from '../engine/pumping'
import { nerode } from '../engine/myhill'
import Graph from '../components/Graph'
import AstView from '../components/AstView'
import NerodeTable from '../components/NerodeTable'
import { Stat } from '../components/Stat'
import { EXAMPLES } from '../examples'

export type ExploreTab = 'ast' | 'nfa' | 'dfa' | 'min' | 'der' | 'mn'

const TABS: { id: ExploreTab; label: string }[] = [
  { id: 'ast', label: 'Parse tree' },
  { id: 'nfa', label: 'ε-NFA' },
  { id: 'dfa', label: 'DFA' },
  { id: 'min', label: 'Minimal DFA' },
  { id: 'mn', label: 'Myhill–Nerode' },
  { id: 'der', label: 'Derivatives' },
]

interface Props {
  regex: string
  onRegex: (r: string) => void
  input: string
  onInput: (s: string) => void
  tab: ExploreTab
  onTab: (t: ExploreTab) => void
}

export default function ExploreView({ regex, onRegex, input, onInput, tab, onTab }: Props) {
  const [rawStep, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [member, setMember] = useState('')

  // --- compile the regex through the whole pipeline -------------------------
  const compiled = useMemo(() => {
    const res = parse(regex)
    if (!res.ok) return { ok: false as const, error: res.error }
    const ast = res.ast
    const alpha = deriveAlphabet(ast)
    const nfa = buildNfa(ast, alpha)
    const dfaFull = subsetConstruction(nfa)
    const minimal = minimizeDfa(dfaFull)
    const der = buildDfaByDerivatives(ast, alpha)
    const derGraph = {
      ...dfaToGraph(der.dfa),
      stateSub: der.regexes.map((r) => (r.length <= 11 ? r : r.slice(0, 10) + '…')),
    }
    return {
      ok: true as const,
      ast,
      alpha,
      nfa,
      dfaFull,
      minimal,
      der,
      nfaGraph: nfaToGraph(nfa),
      dfaGraph: dfaToGraph(dfaFull),
      minGraph: dfaToGraph(minimal),
      derGraph,
      nerode: nerode(dfaFull),
      reconstructed: dfaToRegex(minimal),
    }
  }, [regex])

  // --- simulation for the currently displayed machine -----------------------
  const sim: SimResult | null = useMemo(() => {
    if (!compiled.ok) return null
    if (tab === 'dfa' || tab === 'mn') return simulateDfa(compiled.dfaFull, input, compiled.alpha)
    if (tab === 'min') return simulateDfa(compiled.minimal, input, compiled.alpha)
    if (tab === 'der') return simulateDfa(compiled.der.dfa, input, compiled.alpha)
    return simulateNfa(compiled.nfa, input, compiled.alpha)
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

  const highlight = sim?.steps[step]?.active ?? []

  const samples = useMemo(
    () => (compiled.ok ? sampleLanguage(compiled.minimal, 14) : []),
    [compiled],
  )
  const memberVerdict = useMemo(() => {
    if (!compiled.ok || member === '') return null
    return accepts(compiled.minimal, member, compiled.alpha)
  }, [compiled, member])

  const loadExample = (i: number) => {
    onRegex(EXAMPLES[i].regex)
    onInput(EXAMPLES[i].test)
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
          : tab === 'der'
            ? compiled.derGraph
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
    tab === 'dfa' || tab === 'mn'
      ? 'DFA'
      : tab === 'min'
        ? 'minimal DFA'
        : tab === 'der'
          ? 'derivative DFA'
          : 'ε-NFA'

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
            onChange={(e) => {
              onRegex(e.target.value)
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
                onClick={() => onTab(t.id)}
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
            ) : tab === 'mn' ? (
              <NerodeTable result={compiled.nerode} />
            ) : graph ? (
              <Graph
                graph={graph}
                highlight={highlight}
                fitKey={`${regex}|${tab}`}
                exportName={tab}
              />
            ) : null}
          </div>
          {compiled.ok && tab !== 'ast' && tab !== 'mn' && (
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
              {tab === 'der' ? (
                <span className="hint">states are residual regexes (∂ classes) · same DFA, built by derivatives</span>
              ) : (
                <span className="hint">scroll = zoom · drag = pan · drag a node to move it</span>
              )}
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
                onInput(e.target.value)
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

          {compiled.ok && tab === 'der' && (
            <DerivativeExplorer ast={compiled.ast} alpha={compiled.alpha} />
          )}

          {compiled.ok && tab === 'mn' && (
            <section className="panel">
              <h2>Myhill–Nerode</h2>
              <p className="panel-sub">
                The <strong>table-filling algorithm</strong> on the DFA above. A pair of states is
                marked when some string tells them apart: first the ones ε separates (one accepts,
                one doesn't), then propagate — (p, q) is marked when a symbol sends them to an
                already-marked pair. Each filled cell shows the <strong>round</strong> it fell in;
                hover it for the actual distinguishing string. The surviving unmarked pairs are the{' '}
                <strong>equivalence classes</strong> — exactly the states Hopcroft merges. There are{' '}
                <strong>{compiled.nerode.classes.length}</strong> of them (the trap counts as one),
                matching the minimal DFA.
              </p>
            </section>
          )}

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
                      onInput(s.display === 'ε' ? '' : s.display.replace(/∗/g, '?'))
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

          {compiled.ok && (
            <PumpingPanel minimal={compiled.minimal} regex={regex} />
          )}

          {compiled.ok && (
            <section className="panel">
              <h2>Regex from the DFA</h2>
              <p className="panel-sub">
                State elimination (GNFA) run on the minimal DFA — the other half of Kleene's
                theorem. Equivalent to your input, though rarely identical:
              </p>
              <code className="reconstructed">/{compiled.reconstructed}/</code>
            </section>
          )}

          <section className="panel about">
            <h2>How it works</h2>
            <ol>
              <li>A recursive-descent parser turns the regex into an AST.</li>
              <li>An alphabet is derived; unseen characters fold onto the ∗ symbol.</li>
              <li>Thompson's construction wires the AST into an ε-NFA.</li>
              <li>Subset construction determinizes it into a complete DFA.</li>
              <li>Hopcroft's algorithm merges equivalent states into the minimal DFA.</li>
              <li>Brzozowski derivatives rebuild the same DFA straight from the regex.</li>
              <li>State elimination turns the DFA back into a regex (the loop closes).</li>
            </ol>
          </section>
        </aside>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Derivative explorer: build a word symbol by symbol and watch the residual regex shrink.
// ---------------------------------------------------------------------------
function DerivativeExplorer({ ast, alpha }: { ast: Ast; alpha: Alphabet }) {
  const [word, setWord] = useState<Sym[]>([])
  // Reset the word whenever the regex (its AST identity) changes.
  const [seen, setSeen] = useState(ast)
  if (seen !== ast) {
    setSeen(ast)
    setWord([])
  }

  const start = useMemo(() => astToDer(ast, alpha), [ast, alpha])
  const chain = useMemo(() => {
    const out: { sym: Sym; residual: ReturnType<typeof astToDer> }[] = []
    let cur = start
    for (const s of word) {
      cur = derivative(cur, s)
      out.push({ sym: s, residual: cur })
    }
    return out
  }, [start, word])

  const current = chain.length ? chain[chain.length - 1].residual : start
  const accepted = nullable(current)

  return (
    <section className="panel">
      <h2>Derivative explorer</h2>
      <p className="panel-sub">
        Pick symbols to compute the Brzozowski derivative ∂ₐr step by step. The residual is the
        regex for "what's left to match"; it accepts when it's nullable.
      </p>
      <div className="der-chain">
        <code className="der-term">{show(start)}</code>
        {chain.map((c, i) => (
          <span key={i} className="der-step">
            <span className="der-op">─∂{showSym(c.sym)}→</span>
            <code className="der-term">{show(c.residual)}</code>
          </span>
        ))}
      </div>
      <div className="der-controls">
        {alpha.symbols.map((s, i) => (
          <button key={i} className="der-sym" onClick={() => setWord((w) => [...w, s])}>
            ∂{showSym(s)}
          </button>
        ))}
        <button className="der-sym ghost" onClick={() => setWord((w) => w.slice(0, -1))} disabled={!word.length}>
          ⌫
        </button>
        <button className="der-sym ghost" onClick={() => setWord([])} disabled={!word.length}>
          clear
        </button>
      </div>
      <div className="der-verdict">
        word <code>{word.length ? word.map(showSym).join('') : 'ε'}</code> ·{' '}
        <span className={`pill ${accepted ? 'yes' : 'no'}`}>{accepted ? 'nullable (accepts)' : 'not nullable'}</span>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Pumping-lemma playground.
// ---------------------------------------------------------------------------
function PumpingPanel({ minimal, regex }: { minimal: Dfa; regex: string }) {
  const p = pumpingLength(minimal)
  const auto = useMemo(() => findPumpableWord(minimal, p), [minimal, p])
  const [custom, setCustom] = useState<string | null>(null)
  const [i, setI] = useState(2)

  // Reset when the regex changes.
  const [seen, setSeen] = useState(regex)
  if (seen !== regex) {
    setSeen(regex)
    setCustom(null)
    setI(2)
  }

  // A typed character that is not in the explicit alphabet maps onto the OTHER sentinel.
  const decomp = useMemo(() => {
    const word: Sym[] =
      custom !== null
        ? [...custom].map((c) => (minimal.alphabet.includes(c) ? c : OTHER))
        : auto ?? []
    return decompose(minimal, word)
  }, [minimal, custom, auto])
  const pumped = decomp.ok ? pump(decomp, i) : []
  const pumpedOk = decomp.ok ? acceptsSyms(minimal, pumped) : false

  return (
    <section className="panel">
      <h2>Pumping lemma</h2>
      <p className="panel-sub">
        Pumping length <strong>p = {p}</strong> (states of the minimal DFA). Any accepted word with
        |w| ≥ p has a loop you can repeat: w = x·yⁱ·z stays in the language for every i.
      </p>
      {auto === null && custom === null ? (
        <div className="tape-empty">Every accepted word is shorter than p — the language is finite, so there is nothing to pump.</div>
      ) : !decomp.ok ? (
        <div className="pump-bad">{decomp.reason ?? 'no decomposition'}</div>
      ) : (
        <>
          <div className="pump-word">
            <span className="pump-x">{decomp.x.map(showSym).join('') || 'ε'}</span>
            <span className="pump-y" title="this loop gets pumped">{decomp.y.map(showSym).join('')}</span>
            <span className="pump-z">{decomp.z.map(showSym).join('') || 'ε'}</span>
          </div>
          <div className="pump-legend">
            <span className="pump-x">x</span> prefix · <span className="pump-y">y</span> loop (pumped) ·{' '}
            <span className="pump-z">z</span> suffix · |xy| = {decomp.x.length + decomp.y.length} ≤ p
          </div>
          <div className="pump-i">
            <label>
              i = {i}
              <input
                type="range"
                min={0}
                max={6}
                value={i}
                onChange={(e) => setI(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="pump-result">
            <code>{pumped.map(showSym).join('') || 'ε'}</code>
            <span className={`pill ${pumpedOk ? 'yes' : 'no'}`}>{pumpedOk ? 'accepted ✓' : 'rejected ✗'}</span>
          </div>
        </>
      )}
      <input
        className="pump-input"
        value={custom ?? (auto ? auto.map(showSym).join('') : '')}
        spellCheck={false}
        onChange={(e) => setCustom(e.target.value)}
        placeholder="type a word to pump…"
        aria-label="word to pump"
      />
    </section>
  )
}
