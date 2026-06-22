import { useMemo, useState } from 'react'
import { parse } from '../engine/parser'
import { compareAsts, OPS, shortestWitness } from '../engine/product'
import type { OpId } from '../engine/product'
import { dfaToGraph } from '../engine/graph'
import { dfaToRegex } from '../engine/gnfa'
import { simulateDfa } from '../engine/simulate'
import { accepts, sampleLanguage } from '../engine/sample'
import { showSym } from '../engine/types'
import type { Sym } from '../engine/types'
import Graph from '../components/Graph'
import { Stat } from '../components/Stat'
import { COMPARE_EXAMPLES } from '../examples'

type View = 'A' | 'B' | OpId

const OP_LABEL: Record<OpId, string> = {
  union: '∪',
  inter: '∩',
  diffAB: 'A−B',
  diffBA: 'B−A',
  symdiff: '⊕',
}

interface Props {
  a: string
  b: string
  op: string
  input: string
  onA: (v: string) => void
  onB: (v: string) => void
  onOp: (v: string) => void
  onInput: (v: string) => void
}

function showWord(syms: Sym[] | null): string {
  if (syms === null) return '—'
  return syms.length ? syms.map(showSym).join('') : 'ε'
}

export default function CompareView({ a, b, op, input, onA, onB, onOp, onInput }: Props) {
  const [member, setMember] = useState('')

  const parsed = useMemo(() => {
    const ra = parse(a)
    const rb = parse(b)
    return { ra, rb }
  }, [a, b])

  const cmp = useMemo(() => {
    if (!parsed.ra.ok || !parsed.rb.ok) return null
    return compareAsts(parsed.ra.ast, parsed.rb.ast)
  }, [parsed])

  // The persisted operator (from the URL); falls back to intersection if hand-edited junk.
  const persistedOp: OpId = (op as OpId) in OP_LABEL ? (op as OpId) : 'inter'
  // Viewing a raw input (A or B) is a transient choice that doesn't change the persisted operator.
  const [rawView, setRawView] = useState<'A' | 'B' | null>(null)
  const effectiveView: View = rawView ?? persistedOp

  const shown = useMemo(() => {
    if (!cmp) return null
    if (effectiveView === 'A') return { dfa: cmp.dfaA, name: 'A' }
    if (effectiveView === 'B') return { dfa: cmp.dfaB, name: 'B' }
    return { dfa: cmp.results[effectiveView], name: `A ${OP_LABEL[effectiveView]} B` }
  }, [cmp, effectiveView])

  const shownSim = useMemo(
    () => (cmp && shown ? simulateDfa(shown.dfa, input, cmp.alphabet) : null),
    [cmp, shown, input],
  )
  const shownSamples = useMemo(() => (shown ? sampleLanguage(shown.dfa, 12) : []), [shown])
  const shownWitness = useMemo(() => (shown ? shortestWitness(shown.dfa) : null), [shown])
  const shownRegex = useMemo(() => (shown ? dfaToRegex(shown.dfa) : ''), [shown])
  const shownMember = useMemo(() => {
    if (!cmp || !shown || member === '') return null
    return accepts(shown.dfa, member, cmp.alphabet)
  }, [cmp, shown, member])

  const rel = cmp?.relations

  const loadExample = (i: number) => {
    onA(COMPARE_EXAMPLES[i].a)
    onB(COMPARE_EXAMPLES[i].b)
  }

  const tabs: { id: View; label: string }[] = [
    { id: 'A', label: 'A' },
    { id: 'B', label: 'B' },
    ...OPS.map((o) => ({ id: o.id as View, label: OP_LABEL[o.id] })),
  ]

  const maxStep = shownSim ? shownSim.steps.length - 1 : 0
  const [rawStep, setStep] = useState(0)
  const step = Math.min(rawStep, maxStep)
  const highlight = shownSim?.steps[step]?.active ?? []

  return (
    <>
      <section className="input-bar compare-bar">
        <div className="compare-fields">
          <label className="regex-field small">
            <span className="ab-tag a">A</span>
            <input
              value={a}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => onA(e.target.value)}
              placeholder="regex A…"
              aria-label="regular expression A"
            />
          </label>
          <label className="regex-field small">
            <span className="ab-tag b">B</span>
            <input
              value={b}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => onB(e.target.value)}
              placeholder="regex B…"
              aria-label="regular expression B"
            />
          </label>
        </div>
        <select
          className="examples"
          value=""
          onChange={(e) => e.target.value && loadExample(Number(e.target.value))}
          aria-label="load a comparison example"
        >
          <option value="">examples ▾</option>
          {COMPARE_EXAMPLES.map((ex, i) => (
            <option key={i} value={i}>
              {ex.name}
            </option>
          ))}
        </select>
        {cmp && (
          <div className="statline">
            <Stat k="Σ" v={cmp.alphabet.symbols.length} title="shared alphabet size" />
            <Stat k="A" v={cmp.dfaA.numStates} title="minimal DFA states for A" />
            <Stat k="B" v={cmp.dfaB.numStates} title="minimal DFA states for B" />
          </div>
        )}
      </section>

      {!parsed.ra.ok || !parsed.rb.ok ? (
        <div className="parse-error">
          <span className="err-msg">
            parse error in {!parsed.ra.ok ? 'A' : 'B'}:{' '}
            {!parsed.ra.ok ? parsed.ra.error.message : !parsed.rb.ok ? parsed.rb.error.message : ''}
          </span>
        </div>
      ) : (
        rel && (
          <div className={`relations-banner ${rel.equivalent ? 'eq' : 'neq'}`}>
            <span className="rel-verdict">
              {rel.equivalent ? 'L(A) = L(B)  ·  equivalent' : 'L(A) ≠ L(B)  ·  not equivalent'}
            </span>
            {!rel.equivalent && rel.witness && (
              <span className="rel-witness">
                shortest distinguisher: <code>{showWord(rel.witness)}</code> — accepted by{' '}
                <strong>{rel.witnessSide}</strong> only
              </span>
            )}
            <span className="rel-tags">
              <span className={`rel-tag ${rel.aSubsetB ? 'on' : ''}`} title="L(A) ⊆ L(B)">A ⊆ B</span>
              <span className={`rel-tag ${rel.bSubsetA ? 'on' : ''}`} title="L(B) ⊆ L(A)">B ⊆ A</span>
              <span className={`rel-tag ${rel.disjoint ? 'on' : ''}`} title="L(A) ∩ L(B) = ∅">
                disjoint
              </span>
            </span>
          </div>
        )
      )}

      <div className="workspace">
        <main className="viewer">
          <nav className="tabs">
            {tabs.map((t) => (
              <button
                key={t.id}
                className={`tab${effectiveView === t.id ? ' active' : ''}`}
                onClick={() => {
                  if (t.id in OP_LABEL) {
                    onOp(t.id)
                    setRawView(null)
                  } else {
                    setRawView(t.id as 'A' | 'B')
                  }
                  setStep(0)
                }}
                title={t.id in OP_LABEL ? OPS.find((o) => o.id === t.id)?.label : `view machine ${t.label}`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="canvas">
            {!cmp ? (
              <div className="empty">Fix both patterns to compare them.</div>
            ) : shown ? (
              <Graph
                graph={dfaToGraph(shown.dfa)}
                highlight={highlight}
                fitKey={`${a}|${b}|${effectiveView}`}
                exportName={effectiveView}
              />
            ) : null}
          </div>
          {cmp && (
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
              <span className="hint">
                showing <strong>{shown?.name}</strong> · product-construction DFA, minimized
              </span>
            </div>
          )}
        </main>

        <aside className="rail">
          <section className="panel">
            <h2>This language</h2>
            <p className="panel-sub">
              Currently viewing <strong>{shown?.name ?? '—'}</strong>
              {shown && ` — ${shown.dfa.numStates} states.`}
            </p>
            {shown && (
              <div className="lang-status">
                {shownWitness === null ? (
                  <span className="pill no">∅ — empty language</span>
                ) : (
                  <span className="pill yes">
                    non-empty · shortest member <code>{showWord(shownWitness)}</code>
                  </span>
                )}
              </div>
            )}
            <div className="samples">
              {shownSamples.length === 0 ? (
                <span className="tape-empty">∅ — the language is empty</span>
              ) : (
                shownSamples.map((s, i) => (
                  <code
                    key={i}
                    className="sample"
                    onClick={() => {
                      onInput(s.display === 'ε' ? '' : s.display.replace(/∗/g, '?'))
                      setStep(0)
                    }}
                  >
                    {s.display}
                  </code>
                ))
              )}
            </div>
          </section>

          {cmp && shown && (
            <section className="panel">
              <h2>Simulate</h2>
              <p className="panel-sub">Run a string through <strong>{shown.name}</strong>.</p>
              <input
                className="sim-input"
                value={input}
                spellCheck={false}
                onChange={(e) => {
                  onInput(e.target.value)
                  setStep(0)
                }}
                placeholder="input string"
                aria-label="simulation input string"
              />
              <div className="tape">
                {input.length === 0 && <span className="tape-empty">ε (empty string)</span>}
                {[...input].map((ch, i) => {
                  const consumed = i < step
                  const cur = i === step - 1
                  return (
                    <span key={i} className={`cell${consumed ? ' consumed' : ''}${cur ? ' current' : ''}`}>
                      {ch === ' ' ? '␣' : ch}
                    </span>
                  )
                })}
              </div>
              <div className="sim-controls">
                <button onClick={() => setStep(0)} disabled={step === 0}>⏮</button>
                <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>◀</button>
                <button onClick={() => setStep((s) => Math.min(maxStep, s + 1))} disabled={step >= maxStep}>▶</button>
                <button onClick={() => setStep(maxStep)} disabled={step >= maxStep}>⏭</button>
              </div>
              <div className="sim-status">
                <span className="step-count">step {step} / {maxStep}</span>
                {shownSim && step === maxStep && (
                  <span className={`verdict ${shownSim.accepted ? 'accept' : 'reject'}`}>
                    {shownSim.accepted ? '✓ accepted' : shownSim.stuck ? '✗ rejected (stuck)' : '✗ rejected'}
                  </span>
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
                {shownMember !== null && (
                  <span className={`pill ${shownMember ? 'yes' : 'no'}`}>
                    {shownMember ? 'in language' : 'rejected'}
                  </span>
                )}
              </div>
            </section>
          )}

          {cmp && shown && (
            <section className="panel">
              <h2>Regex for this language</h2>
              <p className="panel-sub">
                State elimination on the {shown.name} DFA — a regex for the combined language:
              </p>
              <code className="reconstructed">/{shownRegex}/</code>
            </section>
          )}

          <section className="panel about">
            <h2>How it works</h2>
            <ol>
              <li>Both regexes are compiled over one shared alphabet.</li>
              <li>Each becomes a complete DFA (subset construction).</li>
              <li>
                The <strong>product DFA</strong> runs both at once; its states are pairs of states.
              </li>
              <li>
                Each boolean op is just a different accepting rule on those pairs — one product gives
                ∪, ∩, A−B, B−A and ⊕.
              </li>
              <li>
                Equivalence is decided by emptiness of A ⊕ B; a non-empty symmetric difference yields
                the shortest distinguishing string.
              </li>
            </ol>
          </section>
        </aside>
      </div>
    </>
  )
}
