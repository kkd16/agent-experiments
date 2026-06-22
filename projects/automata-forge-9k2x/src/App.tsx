import { useEffect, useRef, useState } from 'react'
import './App.css'
import ExploreView from './views/ExploreView'
import type { ExploreTab } from './views/ExploreView'
import CompareView from './views/CompareView'
import { copyText } from './lib/download'
import { decodeHash, encodeHash } from './lib/hash'
import type { AppState, Mode } from './lib/hash'
import { COMPARE_EXAMPLES, EXAMPLES } from './examples'

const VALID_TABS: ExploreTab[] = ['ast', 'nfa', 'dfa', 'min', 'der']
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
}

/** Sanitize a decoded state so a hand-edited URL can never wedge a view. */
function clean(s: AppState): AppState {
  const tab = VALID_TABS.includes(s.explore.tab as ExploreTab) ? s.explore.tab : 'nfa'
  const op = VALID_OPS.includes(s.compare.op) ? s.compare.op : 'inter'
  return { ...s, explore: { ...s.explore, tab }, compare: { ...s.compare, op } }
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
                : 'compare two regexes: product construction, boolean algebra & equivalence'}
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

      {state.mode === 'explore' ? (
        <ExploreView
          regex={state.explore.regex}
          onRegex={(regex) => setState((s) => ({ ...s, explore: { ...s.explore, regex } }))}
          input={state.explore.input}
          onInput={(input) => setState((s) => ({ ...s, explore: { ...s.explore, input } }))}
          tab={state.explore.tab as ExploreTab}
          onTab={(tab) => setState((s) => ({ ...s, explore: { ...s.explore, tab } }))}
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
