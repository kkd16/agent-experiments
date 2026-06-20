import { useEffect, useMemo, useState } from 'react';
import './App.css';
import { compile } from './engine/compile';
import { dfaToGraph, nfaToGraph } from './engine/graphdata';
import { layoutGraph } from './engine/layout';
import { toDot, toSvg } from './engine/export';
import { AstView } from './components/AstView';
import { AutomatonGraph } from './components/AutomatonGraph';
import { Debugger } from './components/Debugger';
import { MatchPanel } from './components/MatchPanel';
import { LanguagePanel } from './components/LanguagePanel';
import { ComparePanel } from './components/ComparePanel';
import { SynthesizePanel } from './components/SynthesizePanel';
import { ExplainPanel } from './components/ExplainPanel';
import { RedosPanel } from './components/RedosPanel';
import { PikePanel } from './components/PikePanel';
import { DerivativesPanel } from './components/DerivativesPanel';
import { AntimirovPanel } from './components/AntimirovPanel';
import { FuzzPanel } from './components/FuzzPanel';
import { DEFAULT_EXAMPLE, EXAMPLES } from './data/examples';

type Tab =
  | 'ast'
  | 'nfa'
  | 'dfa'
  | 'min'
  | 'deriv'
  | 'antimirov'
  | 'debug'
  | 'pike'
  | 'language'
  | 'compare'
  | 'synth'
  | 'explain'
  | 'redos'
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
      { id: 'debug', label: 'Debugger' },
      { id: 'pike', label: 'Pike VM' },
    ],
  },
  {
    group: 'analysis',
    tabs: [
      { id: 'language', label: 'Language' },
      { id: 'compare', label: 'Compare' },
      { id: 'synth', label: 'DFA→regex' },
      { id: 'explain', label: 'Explain' },
      { id: 'redos', label: 'ReDoS' },
      { id: 'fuzz', label: 'Fuzz' },
    ],
  },
];

const STORE_KEY = 'regex-studio.v2';

interface Stored {
  pattern: string;
  text: string;
  compare: string;
}

function loadStored(): Stored {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        pattern: parsed.pattern ?? DEFAULT_EXAMPLE.pattern,
        text: parsed.text ?? DEFAULT_EXAMPLE.sample,
        compare: parsed.compare ?? '',
      };
    }
  } catch {
    /* sandboxed preview: ignore */
  }
  return { pattern: DEFAULT_EXAMPLE.pattern, text: DEFAULT_EXAMPLE.sample, compare: '[A-Za-z_]\\w*' };
}

export default function App() {
  const initial = useMemo(() => loadStored(), []);
  const [pattern, setPattern] = useState(initial.pattern);
  const [text, setText] = useState(initial.text);
  const [comparePattern, setComparePattern] = useState(initial.compare);
  const [tab, setTab] = useState<Tab>('nfa');

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ pattern, text, compare: comparePattern }));
    } catch {
      /* ignore */
    }
  }, [pattern, text, comparePattern]);

  const compiled = useMemo(() => compile(pattern), [pattern]);
  const regular = compiled.features ? compiled.features.regular : false;

  const nfaLayout = useMemo(() => (compiled.nfa ? layoutGraph(nfaToGraph(compiled.nfa)) : null), [compiled.nfa]);
  const dfaLayout = useMemo(() => (compiled.dfa ? layoutGraph(dfaToGraph(compiled.dfa)) : null), [compiled.dfa]);
  const minLayout = useMemo(() => (compiled.minDfa ? layoutGraph(dfaToGraph(compiled.minDfa)) : null), [compiled.minDfa]);

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
            <p>A regular-expression engine built from scratch — parse, compile three ways, minimise, run five engines, fuzz, compare and synthesise.</p>
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

            {tab === 'pike' && (
              <PikePanel ast={compiled.ast} groupCount={compiled.groupCount} notice={compiled.error ? 'Fix the pattern first.' : null} />
            )}

            {tab === 'language' && <LanguagePanel dfa={compiled.minDfa} notice={automataNotice} />}

            {tab === 'compare' && (
              <ComparePanel dfaA={compiled.minDfa} noticeA={automataNotice} other={comparePattern} onOtherChange={setComparePattern} />
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

            {tab === 'fuzz' && <FuzzPanel />}
          </div>
        </main>
      </div>

      <footer className="footer">
        Parser · Thompson NFA · subset construction · Brzozowski derivatives · Antimirov partial derivatives (the
        equation automaton) · Moore minimisation · five matching engines (DFA · derivative DFA · partial-derivative NFA ·
        Pike VM · backtracking VM) cross-checked by a seeded differential fuzzer · product-automaton equivalence & ReDoS
        analysis · state-elimination synthesis · DOT/SVG export — all hand-written TypeScript, no regex library.
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
}: {
  title: string;
  blurb: string;
  layout: ReturnType<typeof layoutGraph>;
  accent: string;
  dot?: () => string;
  svgName?: string;
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
