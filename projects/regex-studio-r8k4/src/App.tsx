import { useEffect, useMemo, useState } from 'react';
import './App.css';
import { compile } from './engine/compile';
import { minimizeHopcroft } from './engine/hopcroft';
import { compareDFAs } from './engine/equivalence';
import { dfaToGraph, nfaToGraph } from './engine/graphdata';
import { layoutGraph } from './engine/layout';
import { toDot, toSvg } from './engine/export';
import { AstView } from './components/AstView';
import { AutomatonGraph } from './components/AutomatonGraph';
import { Debugger } from './components/Debugger';
import { MatchPanel } from './components/MatchPanel';
import { LanguagePanel } from './components/LanguagePanel';
import { ComparePanel } from './components/ComparePanel';
import { CoalgebraPanel } from './components/CoalgebraPanel';
import { SynthesizePanel } from './components/SynthesizePanel';
import { ExplainPanel } from './components/ExplainPanel';
import { RedosPanel } from './components/RedosPanel';
import { PikePanel } from './components/PikePanel';
import { DerivativesPanel } from './components/DerivativesPanel';
import { AntimirovPanel } from './components/AntimirovPanel';
import { GlushkovPanel } from './components/GlushkovPanel';
import { ExtendedPanel } from './components/ExtendedPanel';
import { MonoidPanel } from './components/MonoidPanel';
import { LearnPanel } from './components/LearnPanel';
import { CensusPanel } from './components/CensusPanel';
import { FuzzPanel } from './components/FuzzPanel';
import { UnicodePanel } from './components/UnicodePanel';
import { DEFAULT_EXAMPLE, EXAMPLES } from './data/examples';

type Tab =
  | 'ast'
  | 'nfa'
  | 'dfa'
  | 'min'
  | 'deriv'
  | 'antimirov'
  | 'glushkov'
  | 'extended'
  | 'debug'
  | 'pike'
  | 'language'
  | 'census'
  | 'monoid'
  | 'learn'
  | 'compare'
  | 'coalgebra'
  | 'synth'
  | 'explain'
  | 'redos'
  | 'unicode'
  | 'fuzz';

const TAB_GROUPS: { group: string; tabs: { id: Tab; label: string }[] }[] = [
  {
    group: 'pipeline',
    tabs: [
      { id: 'ast', label: 'AST' },
      { id: 'nfa', label: 'ε-NFA' },
      { id: 'dfa', label: 'DFA' },
      { id: 'min', label: 'Min-DFA' },
      { id: 'deriv', label: 'Derivatives' },
      { id: 'antimirov', label: 'Antimirov' },
      { id: 'glushkov', label: 'Glushkov' },
      { id: 'extended', label: 'Extended &~' },
      { id: 'debug', label: 'Debugger' },
      { id: 'pike', label: 'Pike VM' },
    ],
  },
  {
    group: 'analysis',
    tabs: [
      { id: 'language', label: 'Language' },
      { id: 'census', label: 'Census' },
      { id: 'monoid', label: 'Algebra' },
      { id: 'learn', label: 'Learn' },
      { id: 'compare', label: 'Compare' },
      { id: 'coalgebra', label: 'Coalgebra' },
      { id: 'synth', label: 'DFA→regex' },
      { id: 'explain', label: 'Explain' },
      { id: 'redos', label: 'ReDoS' },
      { id: 'unicode', label: 'Unicode' },
      { id: 'fuzz', label: 'Fuzz' },
    ],
  },
];

const STORE_KEY = 'regex-studio.v2';

interface Stored {
  pattern: string;
  text: string;
  compare: string;
  extended: string;
}

const DEFAULT_EXTENDED = '.*[0-9].*&.*[a-z].*&.{6,}';

function loadStored(): Stored {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        pattern: parsed.pattern ?? DEFAULT_EXAMPLE.pattern,
        text: parsed.text ?? DEFAULT_EXAMPLE.sample,
        compare: parsed.compare ?? '',
        extended: parsed.extended ?? DEFAULT_EXTENDED,
      };
    }
  } catch {
    /* sandboxed preview: ignore */
  }
  return { pattern: DEFAULT_EXAMPLE.pattern, text: DEFAULT_EXAMPLE.sample, compare: '[A-Za-z_]\\w*', extended: DEFAULT_EXTENDED };
}

export default function App() {
  const initial = useMemo(() => loadStored(), []);
  const [pattern, setPattern] = useState(initial.pattern);
  const [text, setText] = useState(initial.text);
  const [comparePattern, setComparePattern] = useState(initial.compare);
  const [extendedPattern, setExtendedPattern] = useState(initial.extended);
  const [tab, setTab] = useState<Tab>('nfa');

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ pattern, text, compare: comparePattern, extended: extendedPattern }));
    } catch {
      /* ignore */
    }
  }, [pattern, text, comparePattern, extendedPattern]);

  const compiled = useMemo(() => compile(pattern), [pattern]);
  const regular = compiled.features ? compiled.features.regular : false;

  const nfaLayout = useMemo(() => (compiled.nfa ? layoutGraph(nfaToGraph(compiled.nfa)) : null), [compiled.nfa]);
  const dfaLayout = useMemo(() => (compiled.dfa ? layoutGraph(dfaToGraph(compiled.dfa)) : null), [compiled.dfa]);
  const minLayout = useMemo(() => (compiled.minDfa ? layoutGraph(dfaToGraph(compiled.minDfa)) : null), [compiled.minDfa]);

  // A second, independent road to the minimal DFA: Hopcroft's O(n·log n) pass,
  // cross-checked against the Moore result the pipeline already produced.
  const hopcroft = useMemo(() => {
    if (!compiled.dfa || !compiled.minDfa) return null;
    const h = minimizeHopcroft(compiled.dfa);
    const equal = h.states.length === compiled.minDfa.states.length && compareDFAs(h, compiled.minDfa).relation === 'equal';
    return { states: h.states.length, equal };
  }, [compiled.dfa, compiled.minDfa]);

  const stats = useMemo(() => {
    if (!compiled.nfa || !compiled.dfa || !compiled.minDfa) return null;
    return {
      nfaStates: compiled.nfa.stateCount,
      nfaEdges: compiled.nfa.edges.length,
      dfaStates: compiled.dfa.states.length,
      minStates: compiled.minDfa.states.length,
      atoms: compiled.dfa.atoms.length,
      groups: compiled.groupCount,
    };
  }, [compiled]);

  const loadExample = (i: number) => {
    setPattern(EXAMPLES[i].pattern);
    setText(EXAMPLES[i].sample);
  };

  // Why an automata view is unavailable, if it is.
  const automataNotice = compiled.error
    ? `Fix the pattern first.`
    : compiled.features && !compiled.features.regular
      ? `This pattern uses ${compiled.features.reasons.join(', ')} — beyond the regular languages, so it has no finite automaton. The Run panel above still executes it on the backtracking VM.`
      : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">/<span className="logo-star">∗</span>/</span>
          <div>
            <h1>Regex Studio</h1>
            <p>A regular-expression engine built from scratch — parse, compile four ways, minimise, run six engines, extend to the Boolean closure (&amp; ~ −), read the language's <strong>syntactic monoid</strong> (the variety ladder: piecewise-testable · DA/FO² · star-free? · the named group · the egg-box), speak <strong>Unicode</strong> via <code>\p{'{'}…{'}'}</code> derived live from the host, <strong>learn the minimal DFA back from queries</strong> (Angluin's L* · RPNI), <strong>count the language</strong> (the rational generating function · growth rate · entropy), decide equivalence &amp; inclusion <strong>without determinising</strong> (bisimulation up to congruence · antichains), fuzz, compare and synthesise.</p>
          </div>
        </div>
        <a className="repo-link" href="https://en.wikipedia.org/wiki/Thompson%27s_construction" target="_blank" rel="noreferrer">
          how it works ↗
        </a>
      </header>

      <div className="body">
        <aside className="sidebar">
          <section className="card">
            <label className="field-label" htmlFor="pat">
              pattern
            </label>
            <div className={`pattern-box${compiled.error ? ' has-error' : ''}`}>
              <span className="slash">/</span>
              <input
                id="pat"
                className="pattern-input"
                value={pattern}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setPattern(e.target.value)}
                placeholder="type a regex…"
              />
              <span className="slash">/</span>
            </div>
            {compiled.error ? (
              <div className="parse-error">
                <span className="err-caret" style={{ marginLeft: `${compiled.error.index}ch` }}>
                  ▲
                </span>
                <span className="err-msg">
                  {compiled.error.message} (at index {compiled.error.index})
                </span>
              </div>
            ) : (
              <div className="parse-ok">
                parses cleanly
                <span className={`engine-tag ${regular ? 'tag-regular' : 'tag-extended'}`}>
                  {regular ? 'regular' : 'non-regular (VM only)'}
                </span>
              </div>
            )}
          </section>

          {stats && (
            <section className="card stats">
              <h3>Pipeline</h3>
              <Stat label="NFA states" value={stats.nfaStates} />
              <Stat label="NFA edges" value={stats.nfaEdges} />
              <Stat label="alphabet classes" value={stats.atoms} />
              <Stat label="DFA states" value={stats.dfaStates} accent />
              <Stat label="minimal DFA" value={stats.minStates} accent />
              {stats.dfaStates > 0 && (
                <div className="reduction">
                  minimisation removed{' '}
                  <strong>{stats.dfaStates - stats.minStates}</strong> state
                  {stats.dfaStates - stats.minStates === 1 ? '' : 's'}
                </div>
              )}
            </section>
          )}

          <section className="card examples">
            <h3>Examples</h3>
            <ul>
              {EXAMPLES.map((ex, i) => (
                <li key={ex.name}>
                  <button className="example" onClick={() => loadExample(i)} title={ex.note}>
                    <span className="ex-name">{ex.name}</span>
                    <code className="ex-pat">/{ex.pattern}/</code>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <main className="main">
          <MatchPanel compiled={compiled} text={text} onTextChange={setText} />

          <div className="tabs">
            {TAB_GROUPS.map((g) => (
              <div className="tab-group" key={g.group}>
                {g.tabs.map((t) => (
                  <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="view">
            {tab === 'ast' &&
              (compiled.ast ? <AstView ast={compiled.ast} /> : <div className="placeholder">Fix the pattern to see the AST.</div>)}

            {tab === 'nfa' &&
              (nfaLayout && compiled.nfa ? (
                <GraphPane
                  title="ε-NFA — Thompson's construction"
                  blurb="Non-deterministic, with ε (empty) transitions. Many states can be active at once."
                  layout={nfaLayout}
                  accent="#f59e0b"
                  dot={() => toDot(nfaToGraph(compiled.nfa!), 'epsilon_NFA')}
                  svgName="epsilon-nfa"
                />
              ) : (
                <div className="placeholder">{automataNotice}</div>
              ))}

            {tab === 'dfa' &&
              (dfaLayout && compiled.dfa ? (
                <GraphPane
                  title="DFA — subset construction"
                  blurb="Deterministic: exactly one active state per input character. Each state is a set of NFA states."
                  layout={dfaLayout}
                  accent="#60a5fa"
                  dot={() => toDot(dfaToGraph(compiled.dfa!), 'DFA')}
                  svgName="dfa"
                />
              ) : (
                <div className="placeholder">{automataNotice}</div>
              ))}

            {tab === 'min' &&
              (minLayout && compiled.minDfa ? (
                <GraphPane
                  title="Minimal DFA — Moore minimisation"
                  blurb="Equivalent states merged. This is the smallest DFA recognising the same language."
                  layout={minLayout}
                  accent="#34d399"
                  dot={() => toDot(dfaToGraph(compiled.minDfa!), 'minimal_DFA')}
                  svgName="minimal-dfa"
                  badge={
                    hopcroft
                      ? hopcroft.equal
                        ? 'Moore ≡ Hopcroft ✓ — two independent minimisers, one canonical machine (Hopcroft is O(n·log n))'
                        : 'Moore / Hopcroft disagree — this should never happen'
                      : undefined
                  }
                  badgeOk={hopcroft?.equal}
                />
              ) : (
                <div className="placeholder">{automataNotice}</div>
              ))}

            {tab === 'debug' &&
              (compiled.nfa ? (
                <Debugger nfa={compiled.nfa} dfa={compiled.dfa} nfaLayout={nfaLayout} dfaLayout={dfaLayout} text={text} />
              ) : (
                <div className="placeholder">{automataNotice}</div>
              ))}

            {tab === 'deriv' && <DerivativesPanel compiled={compiled} text={text} />}

            {tab === 'antimirov' && <AntimirovPanel compiled={compiled} text={text} />}

            {tab === 'glushkov' && <GlushkovPanel compiled={compiled} text={text} />}

            {tab === 'extended' && (
              <ExtendedPanel pattern={extendedPattern} onPatternChange={setExtendedPattern} text={text} />
            )}

            {tab === 'pike' && (
              <PikePanel ast={compiled.ast} groupCount={compiled.groupCount} notice={compiled.error ? 'Fix the pattern first.' : null} />
            )}

            {tab === 'language' && <LanguagePanel dfa={compiled.minDfa} notice={automataNotice} />}

            {tab === 'census' && <CensusPanel dfa={compiled.minDfa} notice={automataNotice} />}

            {tab === 'monoid' && <MonoidPanel compiled={compiled} />}

            {tab === 'learn' && <LearnPanel dfa={compiled.minDfa} notice={automataNotice} />}

            {tab === 'compare' && (
              <ComparePanel dfaA={compiled.minDfa} noticeA={automataNotice} other={comparePattern} onOtherChange={setComparePattern} />
            )}

            {tab === 'coalgebra' && (
              <CoalgebraPanel
                patternA={pattern}
                other={comparePattern}
                onOtherChange={setComparePattern}
                onUsePair={(a, b) => {
                  setPattern(a);
                  setComparePattern(b);
                }}
                noticeA={automataNotice}
              />
            )}

            {tab === 'synth' && <SynthesizePanel dfa={compiled.minDfa} notice={automataNotice} />}

            {tab === 'explain' && <ExplainPanel ast={compiled.ast} features={compiled.features} />}

            {tab === 'redos' && (
              <RedosPanel
                ast={compiled.ast}
                groupCount={compiled.groupCount}
                features={compiled.features}
                notice={compiled.error ? 'Fix the pattern first.' : null}
                onUseAttack={setText}
              />
            )}

            {tab === 'unicode' && <UnicodePanel pattern={pattern} />}

            {tab === 'fuzz' && <FuzzPanel />}
          </div>
        </main>
      </div>

      <footer className="footer">
        Parser · Thompson NFA · subset construction · Brzozowski derivatives · Antimirov partial derivatives (the
        equation automaton) · Glushkov's position automaton · <strong>Boolean derivatives — the intersection / complement / difference
        closure no NFA can build</strong> · Moore & Hopcroft minimisation (cross-checked) · six matching engines (DFA · derivative DFA · partial-derivative NFA ·
        position automaton · Pike VM · backtracking VM) cross-checked by a seeded differential fuzzer · product-automaton equivalence — plus the modern road that skips
        determinisation: <strong>bisimulation up to congruence</strong> (Bonchi–Pous, the naïve / up-to-equivalence / up-to-congruence ladder) and
        <strong>antichain</strong> inclusion &amp; universality (De Wulf et al.), every verdict cross-checked against the DFA product · ReDoS
        analysis · state-elimination synthesis · the <strong>syntactic monoid</strong> with Green's relations (the egg-box) and the full <strong>variety ladder</strong> — piecewise-testable (Simon) ⊂ DA / FO²[&lt;] ⊂ star-free / FO[&lt;] / counter-free (Schützenberger) — with the syntactic <strong>group named</strong> (ℤ/n, Klein four, Dₙ, Q₈…) and every element wired back to the state-map it induces · <strong>grammatical inference</strong> — Angluin's <strong>L*</strong> reconstructs the minimal DFA from membership &amp; equivalence queries (the observation table, Myhill–Nerode made tangible) and <strong>RPNI</strong> infers it passively from labelled data · <strong>enumerative census</strong> — the rational generating function S(x)=P(x)/Q(x) (Chomsky–Schützenberger) from the transfer matrix, exact word counts, and the growth rate λ (Perron root) with topological entropy ln λ, classifying the language finite / polynomial / exponential · DOT/SVG export — all hand-written TypeScript, no regex library.
      </footer>
    </div>
  );
}

function GraphPane({
  title,
  blurb,
  layout,
  accent,
  dot,
  svgName,
  badge,
  badgeOk,
}: {
  title: string;
  blurb: string;
  layout: ReturnType<typeof layoutGraph>;
  accent: string;
  dot?: () => string;
  svgName?: string;
  badge?: string;
  badgeOk?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copyDot = () => {
    if (!dot) return;
    const text = dot();
    try {
      navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked (sandbox) — ignore */
    }
  };
  const downloadSvg = () => {
    try {
      const blob = new Blob([toSvg(layout, { accent })], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${svgName ?? 'automaton'}.svg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* sandbox / download blocked — ignore */
    }
  };
  return (
    <div className="graph-pane">
      <div className="pane-head graph-head">
        <div>
          <h2>{title}</h2>
          <p>{blurb}</p>
        </div>
        <div className="graph-head-btns">
          <button className="dot-btn" onClick={downloadSvg} title="Download this automaton as a standalone SVG">
            download SVG
          </button>
          {dot && (
            <button className="dot-btn" onClick={copyDot} title="Copy this automaton as Graphviz DOT">
              {copied ? 'copied ✓' : 'copy DOT'}
            </button>
          )}
        </div>
      </div>
      {badge && <div className={`graph-badge${badgeOk ? ' ok' : ' bad'}`}>{badge}</div>}
      <AutomatonGraph layout={layout} accent={accent} />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`stat${accent ? ' stat-accent' : ''}`}>
      <span className="stat-val">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
