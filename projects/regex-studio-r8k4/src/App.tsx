import { useEffect, useMemo, useState } from 'react';
import './App.css';
import { compile } from './engine/compile';
import { dfaToGraph, nfaToGraph } from './engine/graphdata';
import { layoutGraph } from './engine/layout';
import { AstView } from './components/AstView';
import { AutomatonGraph } from './components/AutomatonGraph';
import { Debugger } from './components/Debugger';
import { TestPanel } from './components/TestPanel';
import { DEFAULT_EXAMPLE, EXAMPLES } from './data/examples';

type Tab = 'ast' | 'nfa' | 'dfa' | 'min' | 'debug';

const TABS: { id: Tab; label: string }[] = [
  { id: 'ast', label: 'AST' },
  { id: 'nfa', label: 'ε-NFA' },
  { id: 'dfa', label: 'DFA' },
  { id: 'min', label: 'Min-DFA' },
  { id: 'debug', label: 'Debugger' },
];

const STORE_KEY = 'regex-studio.v1';

function loadStored(): { pattern: string; text: string } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* sandboxed preview: ignore */
  }
  return { pattern: DEFAULT_EXAMPLE.pattern, text: DEFAULT_EXAMPLE.sample };
}

export default function App() {
  const initial = useMemo(() => loadStored(), []);
  const [pattern, setPattern] = useState(initial.pattern);
  const [text, setText] = useState(initial.text);
  const [tab, setTab] = useState<Tab>('nfa');

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ pattern, text }));
    } catch {
      /* ignore */
    }
  }, [pattern, text]);

  const compiled = useMemo(() => compile(pattern), [pattern]);

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">/<span className="logo-star">∗</span>/</span>
          <div>
            <h1>Regex Studio</h1>
            <p>A regular-expression engine built from scratch — parse, compile, minimise, and watch it run.</p>
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
              <div className="parse-ok">parses cleanly</div>
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
          <TestPanel dfa={compiled.minDfa} text={text} onTextChange={setText} />

          <div className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>

          <div className="view">
            {compiled.error && tab !== 'ast' && (
              <div className="placeholder">Fix the pattern to see the {labelFor(tab)}.</div>
            )}
            {tab === 'ast' && <AstView ast={compiled.ast} />}
            {tab === 'nfa' && nfaLayout && (
              <GraphPane
                title="ε-NFA — Thompson's construction"
                blurb="Non-deterministic, with ε (empty) transitions. Many states can be active at once."
                layout={nfaLayout}
                accent="#f59e0b"
              />
            )}
            {tab === 'dfa' && dfaLayout && (
              <GraphPane
                title="DFA — subset construction"
                blurb="Deterministic: exactly one active state per input character. Each state is a set of NFA states."
                layout={dfaLayout}
                accent="#60a5fa"
              />
            )}
            {tab === 'min' && minLayout && (
              <GraphPane
                title="Minimal DFA — Moore minimisation"
                blurb="Equivalent states merged. This is the smallest DFA recognising the same language."
                layout={minLayout}
                accent="#34d399"
              />
            )}
            {tab === 'debug' && (
              <Debugger nfa={compiled.nfa} dfa={compiled.dfa} nfaLayout={nfaLayout} dfaLayout={dfaLayout} text={text} />
            )}
          </div>
        </main>
      </div>

      <footer className="footer">
        Parser · Thompson NFA · subset construction · Moore minimisation — all hand-written TypeScript, no regex library.
      </footer>
    </div>
  );
}

function GraphPane({
  title,
  blurb,
  layout,
  accent,
}: {
  title: string;
  blurb: string;
  layout: ReturnType<typeof layoutGraph>;
  accent: string;
}) {
  return (
    <div className="graph-pane">
      <div className="pane-head">
        <h2>{title}</h2>
        <p>{blurb}</p>
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

function labelFor(tab: Tab): string {
  return TABS.find((t) => t.id === tab)?.label ?? '';
}
