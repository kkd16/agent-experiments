import { useMemo, useState } from 'react'
import './AlgebraView.css'
import { syntacticMonoidFromRegex } from '../engine/algebra/monoid'
import type { Monoid } from '../engine/algebra/monoid'
import { greenRelations, eggBoxes } from '../engine/algebra/green'
import type { GreenClasses } from '../engine/algebra/green'
import { analyzeMonoid } from '../engine/algebra/properties'
import type { MonoidProps } from '../engine/algebra/properties'
import { classify } from '../engine/algebra/verdict'
import type { Verdict } from '../engine/algebra/verdict'
import { runAlgebraSelfTest } from '../engine/algebra/selftest'
import { ALGEBRA_EXAMPLES } from '../engine/algebra/examples'
import { showSym, showWord } from '../engine/types'
import { Stat } from '../components/Stat'

export type AlgebraTab = 'monoid' | 'green' | 'structure' | 'starfree' | 'verify' | 'about'

const TABS: { id: AlgebraTab; label: string }[] = [
  { id: 'monoid', label: 'Syntactic monoid' },
  { id: 'green', label: "Green's relations" },
  { id: 'structure', label: 'Structure' },
  { id: 'starfree', label: 'Star-free?' },
  { id: 'verify', label: 'Verify' },
  { id: 'about', label: 'About' },
]

interface Props {
  regex: string
  onRegex: (r: string) => void
  tab: AlgebraTab
  onTab: (t: AlgebraTab) => void
}

/** A stable hue per element id, for colour-coding the Cayley table and egg-box. */
function hue(id: number): number {
  return (id * 47 + 15) % 360
}
function chipStyle(id: number): React.CSSProperties {
  return { background: `hsl(${hue(id)} 70% 92%)`, borderColor: `hsl(${hue(id)} 55% 70%)` }
}

/** Human label for a monoid element: the unit is “1”, everything else its shortest word. */
function elemLabel(mon: Monoid, id: number): string {
  if (id === mon.identity) return '1'
  return showWord(mon.elements[id].word)
}

export default function AlgebraView({ regex, onRegex, tab, onTab }: Props) {
  const built = useMemo(() => {
    const res = syntacticMonoidFromRegex(regex)
    if (!res.ok || !res.monoid) return { ok: false as const, error: res.error ?? 'parse error' }
    const mon = res.monoid
    const green = greenRelations(mon)
    const props = analyzeMonoid(mon, green)
    const verdict = classify(mon, props)
    const boxes = eggBoxes(mon, green)
    return { ok: true as const, mon, green, props, verdict, boxes }
  }, [regex])

  const loadExample = (i: number) => onRegex(ALGEBRA_EXAMPLES[i].regex)

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
            onChange={(e) => onRegex(e.target.value)}
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
          {ALGEBRA_EXAMPLES.map((ex, i) => (
            <option key={i} value={i}>
              {ex.name}
            </option>
          ))}
        </select>
        {built.ok && (
          <div className="statline">
            <Stat k="|M|" v={built.mon.order} title="size of the syntactic monoid" />
            <Stat k="states" v={built.mon.n} title="states of the complete minimal DFA it acts on" />
            <Stat k="idem" v={built.props.idempotents.length} title="idempotents (e·e = e)" />
            <Stat k="J" v={built.props.counts.j} title="number of J- (= D-) classes" />
            <span
              className={`sf-badge ${built.verdict.starFree ? 'yes' : 'no'}`}
              title="Schützenberger: star-free ⟺ aperiodic"
            >
              {built.verdict.starFree ? 'star-free' : 'counts'}
            </span>
          </div>
        )}
      </section>

      {!built.ok ? (
        <div className="parse-error">
          <span className="err-msg">parse error: {built.error}</span>
        </div>
      ) : (
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
            <div className="canvas alg-canvas">
              {tab === 'monoid' && <MonoidTab mon={built.mon} />}
              {tab === 'green' && <GreenTab mon={built.mon} green={built.green} boxes={built.boxes} />}
              {tab === 'structure' && <StructureTab mon={built.mon} props={built.props} verdict={built.verdict} />}
              {tab === 'starfree' && <StarFreeTab mon={built.mon} verdict={built.verdict} />}
              {tab === 'verify' && <VerifyTab />}
              {tab === 'about' && <AboutTab />}
            </div>
          </main>

          <aside className="rail">
            <section className="panel">
              <h2>The recogniser</h2>
              <p className="panel-sub">
                The syntactic monoid is the <strong>transition monoid</strong> of the minimal
                complete DFA — each word acts on its states, and two words are the same element
                exactly when they act identically. Open <em>Explore</em> to see the automaton drawn.
              </p>
              <div className="recog-facts">
                <div><span>states</span><b>{built.mon.n}</b></div>
                <div><span>start</span><b>q{built.mon.start}</b></div>
                <div><span>accepting</span><b>{[...built.mon.accepting].map((q) => `q${q}`).join(', ') || '∅'}</b></div>
                <div>
                  <span>alphabet</span>
                  <b>{built.mon.alphabet.map((s) => showSym(s)).join(' ')}</b>
                </div>
                <div><span>generators η(a)</span><b>{built.mon.gens.map((id) => elemLabel(built.mon, id)).join(' ')}</b></div>
              </div>
            </section>
            <ContextPanel tab={tab} mon={built.mon} props={built.props} verdict={built.verdict} regex={regex} />
          </aside>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Syntactic-monoid tab: element list + Cayley (multiplication) table.
// ---------------------------------------------------------------------------
function MonoidTab({ mon }: { mon: Monoid }) {
  const [hi, setHi] = useState<number | null>(null)
  if (mon.truncated)
    return (
      <div className="empty">
        The transition monoid exceeded the size cap for this pattern. Try a smaller language — the
        algebra is meant for the compact examples where the whole monoid fits on screen.
      </div>
    )

  const accepting = new Set(mon.elements.filter((e) => e.accepting).map((e) => e.id))

  return (
    <div className="alg-pane">
      <div className="alg-elems">
        <div className="alg-elems-head">
          <span>
            <strong>{mon.order}</strong> element{mon.order === 1 ? '' : 's'}. Each is a transformation
            of the {mon.n} DFA states; the highlighted column is the start state q{mon.start}, whose
            image decides membership.
          </span>
        </div>
        <table className="elem-table">
          <thead>
            <tr>
              <th>word</th>
              <th>q0…q{mon.n - 1} ↦</th>
              <th>flags</th>
            </tr>
          </thead>
          <tbody>
            {mon.elements.map((e) => (
              <tr
                key={e.id}
                className={hi === e.id ? 'hi' : ''}
                onMouseEnter={() => setHi(e.id)}
                onMouseLeave={() => setHi(null)}
              >
                <td>
                  <code className="elem-chip" style={chipStyle(e.id)}>
                    {elemLabel(mon, e.id)}
                  </code>
                </td>
                <td>
                  <span className="transform">
                    {e.transform.map((t, q) => (
                      <span key={q} className={`tcell${q === mon.start ? ' start' : ''}${mon.accepting.has(t) ? ' acc' : ''}`}>
                        {t}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="elem-flags">
                  {e.id === mon.identity && <span className="flag unit" title="identity (image of ε)">1</span>}
                  {mon.gens.includes(e.id) && <span className="flag gen" title="generator: image of a single letter">gen</span>}
                  {e.idempotent && <span className="flag idem" title="idempotent: e·e = e">e²=e</span>}
                  {accepting.has(e.id) && <span className="flag acc" title="in the accepting set P = η(L)">∈P</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="cayley-wrap">
        <div className="alg-elems-head">
          <span>
            <strong>Cayley table</strong> — row a, column b gives the product a·b (read a, then b).
            Hover to trace.
          </span>
        </div>
        <div className="cayley-scroll">
          <table className="cayley">
            <thead>
              <tr>
                <th className="corner">·</th>
                {mon.elements.map((e) => (
                  <th key={e.id} className={hi === e.id ? 'hi' : ''}>
                    <code style={chipStyle(e.id)}>{elemLabel(mon, e.id)}</code>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mon.elements.map((a) => (
                <tr key={a.id}>
                  <th className={hi === a.id ? 'hi' : ''}>
                    <code style={chipStyle(a.id)}>{elemLabel(mon, a.id)}</code>
                  </th>
                  {mon.elements.map((b) => {
                    const p = mon.mult[a.id][b.id]
                    return (
                      <td
                        key={b.id}
                        className={p === hi ? 'hi-cell' : ''}
                        style={chipStyle(p)}
                        onMouseEnter={() => setHi(p)}
                        onMouseLeave={() => setHi(null)}
                        title={`${elemLabel(mon, a.id)} · ${elemLabel(mon, b.id)} = ${elemLabel(mon, p)}`}
                      >
                        {elemLabel(mon, p)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Green's relations: the egg-box diagrams.
// ---------------------------------------------------------------------------
function GreenTab({ mon, green, boxes }: { mon: Monoid; green: GreenClasses; boxes: ReturnType<typeof eggBoxes> }) {
  return (
    <div className="alg-pane green-pane">
      <p className="green-intro">
        Each box is a <strong>𝒟-class</strong> (= 𝒥-class here, since the monoid is finite). Rows are{' '}
        <strong>ℛ-classes</strong>, columns are <strong>ℒ-classes</strong>, and every cell is one{' '}
        <strong>ℋ-class</strong>. A ★ marks a cell that contains an <strong>idempotent</strong> — those
        ℋ-classes are <strong>groups</strong>, all isomorphic within a box. A box with a star is{' '}
        <em>regular</em>. Non-trivial group cells (|ℋ| &gt; 1) are exactly the obstruction to
        star-freeness.
      </p>
      <div className="eggboxes">
        {boxes.map((box) => (
          <div key={box.jIndex} className={`eggbox${box.regular ? ' regular' : ''}`}>
            <div className="eggbox-head">
              𝒟-class · {box.members.length} element{box.members.length === 1 ? '' : 's'} ·{' '}
              {box.rows.length}×{box.cols.length}
              {box.regular ? <span className="tag reg">regular</span> : <span className="tag null">null</span>}
            </div>
            <table className="egg">
              <tbody>
                {box.cells.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} className={cell ? (cell.group ? 'cell group' : 'cell') : 'cell empty'}>
                        {cell && (
                          <div className="hclass">
                            {cell.group && <span className="star" title={`group of order ${cell.order}`}>★</span>}
                            {cell.hClass.map((x) => (
                              <code key={x} className="elem-chip sm" style={chipStyle(x)}>
                                {elemLabel(mon, x)}
                              </code>
                            ))}
                          </div>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      <div className="green-counts">
        <span><strong>{green.rClasses.length}</strong> ℛ-classes</span>
        <span><strong>{green.lClasses.length}</strong> ℒ-classes</span>
        <span><strong>{green.jClasses.length}</strong> 𝒟/𝒥-classes</span>
        <span><strong>{green.hClasses.length}</strong> ℋ-classes</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Structure: the property checklist and the variety ladder.
// ---------------------------------------------------------------------------
function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className={ok ? 'ok' : 'no'}>
      <span className="v-ic">{ok ? '✓' : '·'}</span>
      <span className="c-body">{children}</span>
    </li>
  )
}

function StructureTab({ mon, props, verdict }: { mon: Monoid; props: MonoidProps; verdict: Verdict }) {
  const w = props.aperiodicWitness
  const cw = props.commutativeWitness
  return (
    <div className="alg-pane struct-pane">
      <div className="struct-cols">
        <section>
          <h3>Properties of M(L)</h3>
          <ul className="checklist">
            <Check ok={props.trivial}>
              <strong>Trivial</strong> — |M| = 1 {props.trivial ? '' : `(here ${mon.order})`}
            </Check>
            <Check ok={props.aperiodic}>
              <strong>Aperiodic</strong> (no non-trivial subgroup ⟺ ℋ-trivial)
              {!props.aperiodic && w && (
                <span className="witness">
                  witness: “{showWord(mon.elements[w.element].word)}” has period {w.period} —{' '}
                  {w.seq.map((s) => elemLabel(mon, s)).join(' → ')} → …
                </span>
              )}
              {props.aperiodic && props.aperiodicIndex !== undefined && (
                <span className="witness">stability index n = {props.aperiodicIndex}: mⁿ = mⁿ⁺¹ for all m</span>
              )}
            </Check>
            <Check ok={props.jTrivial}>
              <strong>𝒥-trivial</strong> (every 𝒥-class a singleton) — piecewise testable
            </Check>
            <Check ok={props.rTrivial}>
              <strong>ℛ-trivial</strong> · <span className={props.lTrivial ? 'yes' : 'dim'}>ℒ-trivial {props.lTrivial ? '✓' : '·'}</span>
            </Check>
            <Check ok={props.commutative}>
              <strong>Commutative</strong> (ab = ba)
              {!props.commutative && cw && (
                <span className="witness">
                  witness: {elemLabel(mon, cw[0])}·{elemLabel(mon, cw[1])} = {elemLabel(mon, mon.mult[cw[0]][cw[1]])} ≠{' '}
                  {elemLabel(mon, mon.mult[cw[1]][cw[0]])} = {elemLabel(mon, cw[1])}·{elemLabel(mon, cw[0])}
                </span>
              )}
            </Check>
            <Check ok={props.band}>
              <strong>Band</strong> (every element idempotent) · {props.idempotents.length}/{mon.order} idempotent
            </Check>
            <Check ok={props.semilattice}>
              <strong>Semilattice</strong> (commutative band)
            </Check>
            <Check ok={props.group}>
              <strong>Group</strong> (a single idempotent — every element invertible)
            </Check>
          </ul>
        </section>
        <section>
          <h3>Where the language lands</h3>
          <table className="variety-table">
            <thead>
              <tr><th></th><th>algebra</th><th>language class</th></tr>
            </thead>
            <tbody>
              {verdict.varieties.map((v) => (
                <tr key={v.name} className={v.holds ? 'holds' : 'no'}>
                  <td className="v-name">
                    <span className="v-ic">{v.holds ? '✓' : '·'}</span>{v.name}
                  </td>
                  <td className="v-alg"><code>{v.algebra}</code></td>
                  <td className="v-lang">{v.language || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="variety-foot">
            By Eilenberg's variety theorem each algebraic property above names a class of regular
            languages. The ✓ rows are the tightest classes containing this language.
          </p>
        </section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Star-free verdict: Schützenberger's theorem and the logic bridge.
// ---------------------------------------------------------------------------
function StarFreeTab({ mon, verdict }: { mon: Monoid; verdict: Verdict }) {
  const chain = ['star-free', 'aperiodic M(L)', 'counter-free DFA', 'FO[<] definable', 'LTL definable']
  return (
    <div className="alg-pane sf-pane">
      <div className={`sf-card ${verdict.starFree ? 'yes' : 'no'}`}>
        <div className="sf-verdict">{verdict.starFree ? '✓' : '✗'} {verdict.headline}</div>
        <p className="sf-detail">{verdict.detail}</p>
      </div>

      <div className="sf-chain">
        <div className="sf-chain-title">
          Schützenberger–McNaughton–Papert–Kamp: for a regular language these are all{' '}
          <strong>equivalent</strong>, and all decided by the one algebraic test —
        </div>
        <div className="sf-chain-row">
          {chain.map((c, i) => (
            <span key={c} className="sf-link">
              <span className={`sf-node ${verdict.starFree ? 'on' : 'off'}`}>{c}</span>
              {i < chain.length - 1 && <span className="sf-eq">⟺</span>}
            </span>
          ))}
        </div>
      </div>

      {verdict.obstruction && (
        <div className="sf-obstruction">
          <h4>The counting obstruction</h4>
          <p>
            The element for “{verdict.obstruction.word}” has order/period{' '}
            <strong>{verdict.obstruction.period}</strong>: iterating it cycles through{' '}
            {verdict.obstruction.period} distinct transformations instead of stabilising. That hidden
            cyclic group lets the language count modulo {verdict.obstruction.period}, and{' '}
            <strong>no first-order sentence over (&lt;) can count</strong> — hence no star-free
            expression exists.
          </p>
        </div>
      )}

      <div className="sf-bridge">
        <h4>Bridge to the logic modes</h4>
        <p>
          Over finite words, <strong>LTL = FO[&lt;] = star-free</strong>. So this very monoid decides
          whether the language you built in <em>Explore</em> could equally have been written as an{' '}
          <em>LTL</em> or first-order property. Aperiodic here ⟺ expressible there. The{' '}
          <span className="sf-tag">{verdict.piecewiseTestable ? 'piecewise-testable' : 'not piecewise-testable'}</span>{' '}
          flag (𝒥-triviality) further pins it to Σ₁ — boolean combinations of “contains the subword …”.
        </p>
        <p className="sf-foot">Syntactic monoid order {mon.order}; the smallest algebra that recognises the language.</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Verify: run the proof harness live.
// ---------------------------------------------------------------------------
function VerifyTab() {
  const [res, setRes] = useState<ReturnType<typeof runAlgebraSelfTest> | null>(null)
  return (
    <div className="alg-pane verify-pane">
      <div className="verify-head">
        <p>
          Every algebraic claim this mode makes is re-derived from scratch and cross-checked several
          independent ways — the monoid axioms, the recognition theorem, Green's structure, and three
          separate aperiodicity computations — plus a table of hand-verified known answers and a
          negative control.
        </p>
        <button className="run-btn" onClick={() => setRes(runAlgebraSelfTest())}>
          run all checks
        </button>
      </div>
      {res && (
        <>
          <div className={`verify-banner ${res.ok ? 'ok' : 'bad'}`}>
            {res.ok ? '✓' : '✗'} {res.passed}/{res.total} checks passed
          </div>
          <ul className="verify-list">
            {res.results.map((r, i) => (
              <li key={i} className={r.pass ? 'ok' : 'bad'}>
                <span className="v-ic">{r.pass ? '✓' : '✗'}</span>
                <span className="v-name">{r.name}</span>
                <span className="v-detail">{r.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// About.
// ---------------------------------------------------------------------------
function AboutTab() {
  return (
    <div className="alg-pane about-pane">
      <h3>The algebraic view of regular languages</h3>
      <p>
        Every regular language <em>L</em> has a smallest monoid that recognises it — its{' '}
        <strong>syntactic monoid</strong> <em>M(L)</em>, the algebraic twin of the minimal
        automaton. Where the automaton answers <em>“does this string belong?”</em>, the monoid answers{' '}
        <em>“what does this string</em> do<em>?”</em>: two words are identified exactly when they are
        interchangeable in every context — the <strong>syntactic congruence</strong>.
      </p>
      <p>
        We compute it concretely as the <strong>transition monoid</strong> of the minimal complete
        DFA: each word acts on the state set as a function, and those functions, under composition,
        form <em>M(L)</em>. From that one finite table everything else follows.
      </p>
      <ol>
        <li><strong>Green's relations</strong> ℛ, ℒ, 𝒥, ℋ carve the monoid into an “egg-box” of ideals — the coordinate system of finite semigroup theory.</li>
        <li>An <strong>ℋ-class with an idempotent is a group</strong>; the monoid is <strong>aperiodic</strong> exactly when every such group is trivial.</li>
        <li><strong>Schützenberger's theorem (1965):</strong> <em>L</em> is <strong>star-free</strong> ⟺ <em>M(L)</em> is aperiodic.</li>
        <li><strong>McNaughton–Papert / Kamp:</strong> star-free ⟺ definable in <strong>first-order logic FO[&lt;]</strong> ⟺ definable in <strong>LTL</strong> (over finite words).</li>
        <li><strong>Simon's theorem (1975):</strong> <em>L</em> is <strong>piecewise testable</strong> ⟺ <em>M(L)</em> is 𝒥-trivial.</li>
        <li><strong>Eilenberg's variety theorem</strong> makes this a dictionary: varieties of finite monoids ⟷ varieties of regular languages.</li>
      </ol>
      <p>
        Everything is written from scratch — the monoid construction by BFS over the generators, the
        Green's-relation partition from principal ideals, the aperiodicity and variety tests, and the
        proof harness that cross-checks them. Nothing here is a library call.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Contextual rail panel that changes with the active tab.
// ---------------------------------------------------------------------------
function ContextPanel({
  tab,
  mon,
  props,
  verdict,
  regex,
}: {
  tab: AlgebraTab
  mon: Monoid
  props: MonoidProps
  verdict: Verdict
  regex: string
}) {
  if (tab === 'monoid')
    return (
      <section className="panel">
        <h2>Reading it</h2>
        <p className="panel-sub">
          The <strong>{mon.order}</strong> rows are the distinct behaviours of words in{' '}
          <code>/{regex}/</code>. The generators (one per letter) sit near the top; products fill out
          the rest by BFS, each labelled with its shortest word. An element is{' '}
          <strong>accepting</strong> (∈P) when it carries the start state into an accept state — that
          set <em>is</em> the language, read algebraically.
        </p>
      </section>
    )
  if (tab === 'green')
    return (
      <section className="panel">
        <h2>Why egg-boxes</h2>
        <p className="panel-sub">
          Green's relations are the “coordinates” of a finite monoid. The picture exposes the group
          H-classes at a glance: if any starred cell holds more than one element, the language{' '}
          <strong>counts</strong> and cannot be star-free. Here the biggest group H-class has order{' '}
          <strong>{maxGroupOrder(mon, props)}</strong>.
        </p>
      </section>
    )
  if (tab === 'structure' || tab === 'starfree')
    return (
      <section className="panel">
        <h2>Verdict</h2>
        <p className="panel-sub">
          {verdict.starFree ? (
            <>This language is <strong>star-free</strong> — aperiodic, first-order, LTL-expressible.</>
          ) : (
            <>This language is <strong>not star-free</strong> — its monoid hides a non-trivial group.</>
          )}
          {' '}Run the <em>Verify</em> tab to see every claim re-proved.
        </p>
      </section>
    )
  return (
    <section className="panel">
      <h2>From scratch</h2>
      <p className="panel-sub">
        The monoid, Green's relations, the aperiodicity test and this proof harness are all
        hand-written. No semigroup library is imported anywhere.
      </p>
    </section>
  )
}

function maxGroupOrder(mon: Monoid, props: MonoidProps): number {
  // The largest H-class that contains an idempotent (= largest subgroup).
  // Recompute cheaply from Green data via properties would need green; approximate via order-1 when aperiodic.
  return props.aperiodic ? 1 : largestSubgroup(mon)
}

function largestSubgroup(mon: Monoid): number {
  // For each idempotent e, its H-class is a group; find the largest by scanning e·M·e ∩ (units around e).
  // Cheap route: group elements by (right ideal, left ideal) already gives H-classes; recompute here.
  const rightKey = new Array<string>(mon.order)
  const leftKey = new Array<string>(mon.order)
  for (let a = 0; a < mon.order; a++) {
    const R = new Set<number>()
    const L = new Set<number>()
    for (let x = 0; x < mon.order; x++) {
      R.add(mon.mult[a][x])
      L.add(mon.mult[x][a])
    }
    rightKey[a] = [...R].sort((p, q) => p - q).join(',')
    leftKey[a] = [...L].sort((p, q) => p - q).join(',')
  }
  const size = new Map<string, number>()
  const hasIdem = new Map<string, boolean>()
  for (let a = 0; a < mon.order; a++) {
    const k = `${rightKey[a]}|${leftKey[a]}`
    size.set(k, (size.get(k) ?? 0) + 1)
    if (mon.elements[a].idempotent) hasIdem.set(k, true)
  }
  let max = 1
  for (const [k, s] of size) if (hasIdem.get(k) && s > max) max = s
  return max
}
