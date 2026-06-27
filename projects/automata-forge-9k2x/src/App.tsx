import { useEffect, useRef, useState } from 'react'
import './App.css'
import ExploreView from './views/ExploreView'
import type { ExploreTab } from './views/ExploreView'
import CompareView from './views/CompareView'
import BuildView from './views/BuildView'
import type { BuildTab } from './views/BuildView'
import GrammarView from './views/GrammarView'
import type { GrammarTab } from './views/GrammarView'
import TuringView from './views/TuringView'
import type { TuringTab } from './views/TuringView'
import ParseView from './views/ParseView'
import type { ParseTab } from './views/ParseView'
import LearnView from './views/LearnView'
import type { LearnTab } from './views/LearnView'
import LogicView from './views/LogicView'
import type { LogicTab } from './views/LogicView'
import BranchingView from './views/BranchingView'
import type { BranchingTab } from './views/BranchingView'
import type { Strategy } from './engine/learn/lstar'
import { copyText } from './lib/download'
import { decodeHash, encodeHash } from './lib/hash'
import type { AppState, Mode } from './lib/hash'
import { COMPARE_EXAMPLES, EXAMPLES } from './examples'
import { GRAMMAR_EXAMPLES } from './engine/cfg/examples'
import { TM_EXAMPLES } from './engine/tm/examples'
import { PARSE_EXAMPLES } from './engine/parse/examples'
import { LEARN_EXAMPLES } from './engine/learn/examples'
import { DEFAULT_FORMULA, DEFAULT_MODEL } from './engine/ltl/examples'
import { DEFAULT_FORMULA as CTL_DEFAULT_FORMULA, DEFAULT_MODEL as CTL_DEFAULT_MODEL } from './engine/ctl/examples'
import { BUILD_TEMPLATES } from './engine/edit'

const VALID_TABS: ExploreTab[] = ['ast', 'nfa', 'dfa', 'min', 'der', 'mn']
const VALID_BUILD_TABS: BuildTab[] = ['editor', 'dfa', 'min', 'mn']
const VALID_GRAMMAR_TABS: GrammarTab[] = ['analyze', 'cnf', 'cyk', 'earley', 'tree', 'sampler', 'pda', 'pumping']
const VALID_MACHINE_TABS: TuringTab[] = ['run', 'trace', 'table', 'diagram', 'hierarchy']
const VALID_PARSE_TABS: ParseTab[] = ['class', 'll1', 'automaton', 'table', 'parse']
const VALID_LEARN_TABS: LearnTab[] = ['table', 'hypothesis', 'target']
const VALID_LOGIC_TABS: LogicTab[] = ['formula', 'buchi', 'kripke', 'check', 'verify', 'about']
const VALID_BRANCHING_TABS: BranchingTab[] = ['formula', 'label', 'check', 'verify', 'about']
const VALID_STRATEGIES: Strategy[] = ['angluin', 'rivest-schapire']
const VALID_OPS = ['union', 'inter', 'diffAB', 'diffBA', 'symdiff']

const DEFAULT_STATE: AppState = {
  mode: 'explore',
  explore: { regex: EXAMPLES[0].regex, tab: 'nfa', input: EXAMPLES[0].test },
  compare: {
    a: COMPARE_EXAMPLES[0].a,
    b: COMPARE_EXAMPLES[0].b,
    op: 'inter',
    input: '',
  },
  build: { automaton: BUILD_TEMPLATES[0].make(), tab: 'editor', input: 'aab' },
  grammar: { text: GRAMMAR_EXAMPLES[0].text, tab: 'cyk', input: GRAMMAR_EXAMPLES[0].test },
  machine: { source: TM_EXAMPLES[0].source, tab: 'run', input: TM_EXAMPLES[0].input },
  parse: { text: PARSE_EXAMPLES[1].text, tab: 'class', input: PARSE_EXAMPLES[1].test },
  learn: { regex: LEARN_EXAMPLES[0].regex, tab: 'table', strategy: 'rivest-schapire' },
  logic: { formula: DEFAULT_FORMULA, model: DEFAULT_MODEL, tab: 'check' },
  branching: { formula: CTL_DEFAULT_FORMULA, model: CTL_DEFAULT_MODEL, tab: 'check' },
}

/** Sanitize a decoded state so a hand-edited URL can never wedge a view. */
function clean(s: AppState): AppState {
  const tab = VALID_TABS.includes(s.explore.tab as ExploreTab) ? s.explore.tab : 'nfa'
  const op = VALID_OPS.includes(s.compare.op) ? s.compare.op : 'inter'
  const btab = VALID_BUILD_TABS.includes(s.build.tab as BuildTab) ? s.build.tab : 'editor'
  const gtab = VALID_GRAMMAR_TABS.includes(s.grammar.tab as GrammarTab) ? s.grammar.tab : 'cyk'
  const mtab = VALID_MACHINE_TABS.includes(s.machine.tab as TuringTab) ? s.machine.tab : 'run'
  const ptab = VALID_PARSE_TABS.includes(s.parse.tab as ParseTab) ? s.parse.tab : 'class'
  const ltab = VALID_LEARN_TABS.includes(s.learn.tab as LearnTab) ? s.learn.tab : 'table'
  const lgtab = VALID_LOGIC_TABS.includes(s.logic.tab as LogicTab) ? s.logic.tab : 'check'
  const brtab = VALID_BRANCHING_TABS.includes(s.branching.tab as BranchingTab) ? s.branching.tab : 'check'
  const lstrat = VALID_STRATEGIES.includes(s.learn.strategy as Strategy)
    ? s.learn.strategy
    : 'rivest-schapire'
  return {
    ...s,
    explore: { ...s.explore, tab },
    compare: { ...s.compare, op },
    build: { ...s.build, tab: btab },
    grammar: { ...s.grammar, tab: gtab },
    machine: { ...s.machine, tab: mtab },
    parse: { ...s.parse, tab: ptab },
    learn: { ...s.learn, tab: ltab, strategy: lstrat },
    logic: { ...s.logic, tab: lgtab },
    branching: { ...s.branching, tab: brtab },
  }
}

export default function App() {
  const [state, setState] = useState<AppState>(() =>
    clean(decodeHash(window.location.hash, DEFAULT_STATE)),
  )
  const [shared, setShared] = useState(false)

  // Keep the URL hash in sync with state (write only when it actually differs).
  const lastHash = useRef('')
  useEffect(() => {
    const h = encodeHash(state)
    lastHash.current = h
    if (window.location.hash !== h) {
      window.history.replaceState(null, '', h)
    }
  }, [state])

  // Respond to external hash changes (shared links, back/forward).
  useEffect(() => {
    const onHash = () => {
      const next = clean(decodeHash(window.location.hash, state))
      if (encodeHash(next) !== encodeHash(state)) setState(next)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [state])

  const setMode = (mode: Mode) => setState((s) => ({ ...s, mode }))

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◎</span>
          <div>
            <h1>Automata Forge</h1>
            <p className="tag">
              {state.mode === 'explore'
                ? 'regex → ε-NFA → DFA → minimal DFA → derivatives, built from scratch'
                : state.mode === 'compare'
                  ? 'compare two regexes: product construction, boolean algebra & equivalence'
                  : state.mode === 'build'
                    ? 'draw your own automaton — determinize, minimize & read off a regex'
                    : state.mode === 'grammar'
                      ? 'context-free grammars: normalize, parse (CYK & Earley), build a PDA & pump'
                      : state.mode === 'parse'
                        ? 'parser generators: LL(1) & LR(0)/SLR/LALR/LR(1) tables, the item automaton & live parses'
                        : state.mode === 'learn'
                          ? 'active learning: Angluin’s L* infers the minimal DFA from membership & equivalence queries'
                          : state.mode === 'logic'
                            ? 'temporal logic: LTL → Büchi automaton, then model-check a system & get a counterexample'
                            : state.mode === 'branching'
                              ? 'branching time: CTL model checking by the labelling algorithm — Sat-set fixpoints & witness trees'
                              : 'Turing machines: the top of the hierarchy — run, trace & watch the tape'}
            </p>
          </div>
        </div>
        <div className="header-actions">
          <div className="mode-switch" role="tablist" aria-label="mode">
            <button
              role="tab"
              aria-selected={state.mode === 'explore'}
              className={`mode-btn${state.mode === 'explore' ? ' active' : ''}`}
              onClick={() => setMode('explore')}
            >
              Explore
            </button>
            <button
              role="tab"
              aria-selected={state.mode === 'compare'}
              className={`mode-btn${state.mode === 'compare' ? ' active' : ''}`}
              onClick={() => setMode('compare')}
            >
              Compare
            </button>
            <button
              role="tab"
              aria-selected={state.mode === 'build'}
              className={`mode-btn${state.mode === 'build' ? ' active' : ''}`}
              onClick={() => setMode('build')}
            >
              Build
            </button>
            <button
              role="tab"
              aria-selected={state.mode === 'grammar'}
              className={`mode-btn${state.mode === 'grammar' ? ' active' : ''}`}
              onClick={() => setMode('grammar')}
            >
              Grammar
            </button>
            <button
              role="tab"
              aria-selected={state.mode === 'parse'}
              className={`mode-btn${state.mode === 'parse' ? ' active' : ''}`}
              onClick={() => setMode('parse')}
            >
              Parse
            </button>
            <button
              role="tab"
              aria-selected={state.mode === 'learn'}
              className={`mode-btn${state.mode === 'learn' ? ' active' : ''}`}
              onClick={() => setMode('learn')}
            >
              Learn
            </button>
            <button
              role="tab"
              aria-selected={state.mode === 'machine'}
              className={`mode-btn${state.mode === 'machine' ? ' active' : ''}`}
              onClick={() => setMode('machine')}
            >
              Machine
            </button>
            <button
              role="tab"
              aria-selected={state.mode === 'logic'}
              className={`mode-btn${state.mode === 'logic' ? ' active' : ''}`}
              onClick={() => setMode('logic')}
            >
              Logic
            </button>
            <button
              role="tab"
              aria-selected={state.mode === 'branching'}
              className={`mode-btn${state.mode === 'branching' ? ' active' : ''}`}
              onClick={() => setMode('branching')}
            >
              Branching
            </button>
          </div>
          <button
            className="share-btn"
            title="Copy a shareable link to this exact workspace"
            onClick={async () => {
              const url = window.location.origin + window.location.pathname + encodeHash(state)
              const ok = await copyText(url)
              if (ok) {
                setShared(true)
                window.setTimeout(() => setShared(false), 1500)
              }
            }}
          >
            {shared ? '✓ link copied' : '🔗 share'}
          </button>
        </div>
      </header>

      {state.mode === 'branching' ? (
        <BranchingView
          formula={state.branching.formula}
          onFormula={(formula) => setState((s) => ({ ...s, branching: { ...s.branching, formula } }))}
          model={state.branching.model}
          onModel={(model) => setState((s) => ({ ...s, branching: { ...s.branching, model } }))}
          tab={state.branching.tab as BranchingTab}
          onTab={(tab) => setState((s) => ({ ...s, branching: { ...s.branching, tab } }))}
        />
      ) : state.mode === 'logic' ? (
        <LogicView
          formula={state.logic.formula}
          onFormula={(formula) => setState((s) => ({ ...s, logic: { ...s.logic, formula } }))}
          model={state.logic.model}
          onModel={(model) => setState((s) => ({ ...s, logic: { ...s.logic, model } }))}
          tab={state.logic.tab as LogicTab}
          onTab={(tab) => setState((s) => ({ ...s, logic: { ...s.logic, tab } }))}
        />
      ) : state.mode === 'machine' ? (
        <TuringView
          source={state.machine.source}
          onSource={(source) => setState((s) => ({ ...s, machine: { ...s.machine, source } }))}
          input={state.machine.input}
          onInput={(input) => setState((s) => ({ ...s, machine: { ...s.machine, input } }))}
          tab={state.machine.tab as TuringTab}
          onTab={(tab) => setState((s) => ({ ...s, machine: { ...s.machine, tab } }))}
        />
      ) : state.mode === 'parse' ? (
        <ParseView
          text={state.parse.text}
          onText={(text) => setState((s) => ({ ...s, parse: { ...s.parse, text } }))}
          input={state.parse.input}
          onInput={(input) => setState((s) => ({ ...s, parse: { ...s.parse, input } }))}
          tab={state.parse.tab as ParseTab}
          onTab={(tab) => setState((s) => ({ ...s, parse: { ...s.parse, tab } }))}
        />
      ) : state.mode === 'learn' ? (
        <LearnView
          regex={state.learn.regex}
          onRegex={(regex) => setState((s) => ({ ...s, learn: { ...s.learn, regex } }))}
          strategy={state.learn.strategy as Strategy}
          onStrategy={(strategy) => setState((s) => ({ ...s, learn: { ...s.learn, strategy } }))}
          tab={state.learn.tab as LearnTab}
          onTab={(tab) => setState((s) => ({ ...s, learn: { ...s.learn, tab } }))}
        />
      ) : state.mode === 'grammar' ? (
        <GrammarView
          text={state.grammar.text}
          onText={(text) => setState((s) => ({ ...s, grammar: { ...s.grammar, text } }))}
          input={state.grammar.input}
          onInput={(input) => setState((s) => ({ ...s, grammar: { ...s.grammar, input } }))}
          tab={state.grammar.tab as GrammarTab}
          onTab={(tab) => setState((s) => ({ ...s, grammar: { ...s.grammar, tab } }))}
        />
      ) : state.mode === 'explore' ? (
        <ExploreView
          regex={state.explore.regex}
          onRegex={(regex) => setState((s) => ({ ...s, explore: { ...s.explore, regex } }))}
          input={state.explore.input}
          onInput={(input) => setState((s) => ({ ...s, explore: { ...s.explore, input } }))}
          tab={state.explore.tab as ExploreTab}
          onTab={(tab) => setState((s) => ({ ...s, explore: { ...s.explore, tab } }))}
        />
      ) : state.mode === 'build' ? (
        <BuildView
          automaton={state.build.automaton}
          onAutomaton={(automaton) => setState((s) => ({ ...s, build: { ...s.build, automaton } }))}
          tab={state.build.tab as BuildTab}
          onTab={(tab) => setState((s) => ({ ...s, build: { ...s.build, tab } }))}
          input={state.build.input}
          onInput={(input) => setState((s) => ({ ...s, build: { ...s.build, input } }))}
        />
      ) : (
        <CompareView
          a={state.compare.a}
          b={state.compare.b}
          op={state.compare.op}
          input={state.compare.input}
          onA={(a) => setState((s) => ({ ...s, compare: { ...s.compare, a } }))}
          onB={(b) => setState((s) => ({ ...s, compare: { ...s.compare, b } }))}
          onOp={(op) => setState((s) => ({ ...s, compare: { ...s.compare, op } }))}
          onInput={(input) => setState((s) => ({ ...s, compare: { ...s.compare, input } }))}
        />
      )}
    </div>
  )
}
