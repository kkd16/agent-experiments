import { useEffect, useMemo, useState } from 'react';
import type { Compiled } from '../engine/compile';
import { layoutGraph } from '../engine/layout';
import { toDot, toSvg } from '../engine/export';
import { AutomatonGraph } from './AutomatonGraph';
import {
  analyzeWeighted,
  defaultWeightsFor,
  parseAlphabet,
  WEIGHTED_EXAMPLES,
  type WeightMode,
} from '../engine/weighted';
import { SEMIRINGS, SEMIRING_IDS, SEMIRING_MEANING, type SemiringId } from '../engine/weighted/semiring';
import {
  DEFAULT_WEIGHTED_FUZZ,
  runWeightedFuzz,
  type WeightedFuzzReport,
} from '../engine/weighted/weighted-verify';

const ACCENT = '#f0abfc'; // a distinct hue for the weighted tab

interface Persisted {
  semiring: SemiringId;
  alphabet: string;
  mode: WeightMode;
  letters: Record<string, string>;
  seed: number;
  word: string;
}

const DEFAULTS: Persisted = {
  semiring: 'counting',
  alphabet: 'abc',
  mode: 'uniform',
  letters: defaultWeightsFor('counting'),
  seed: 1,
  word: 'ababb',
};

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem('rs-weighted');
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) };
  } catch {
    /* sandbox / disabled storage — fall back to defaults */
  }
  return DEFAULTS;
}

export function WeightedPanel({ compiled }: { compiled: Compiled }) {
  const init = useMemo(() => loadPersisted(), []);
  const [semiring, setSemiring] = useState<SemiringId>(init.semiring);
  const [alphabet, setAlphabet] = useState(init.alphabet);
  const [mode, setMode] = useState<WeightMode>(init.mode);
  const [letters, setLetters] = useState<Record<string, string>>(init.letters);
  const [seed, setSeed] = useState(init.seed);
  const [word, setWord] = useState(init.word);
  // The pattern lives in the shared top editor; an example surfaces a one-click
  // "load" hint here rather than reaching across components to overwrite it.
  const [pendingPattern, setPendingPattern] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem('rs-weighted', JSON.stringify({ semiring, alphabet, mode, letters, seed, word }));
    } catch {
      /* ignore */
    }
  }, [semiring, alphabet, mode, letters, seed, word]);

  // When switching semiring, refresh the by-letter defaults if the user hasn't
  // diverged far (keeps the table sensible for the new carrier).
  const pickSemiring = (id: SemiringId) => {
    setSemiring(id);
    setLetters(defaultWeightsFor(id));
  };

  const analysis = useMemo(
    () => analyzeWeighted({ source: compiled.source, semiring, alphabet, weights: { mode, letters, seed }, word }),
    [compiled.source, semiring, alphabet, mode, letters, seed, word],
  );

  const layout = useMemo(() => (analysis.graph ? layoutGraph(analysis.graph) : null), [analysis.graph]);
  const alphaLetters = useMemo(() => parseAlphabet(alphabet || 'abc').map((c) => String.fromCodePoint(c)), [alphabet]);

  const applyExample = (i: number) => {
    const ex = WEIGHTED_EXAMPLES[i];
    pickSemiring(ex.semiring);
    setMode(ex.weights.mode);
    if (ex.weights.mode === 'letter') setLetters(ex.weights.letters);
    if (ex.weights.mode === 'seed') setSeed(ex.weights.seed);
    setWord(ex.word);
    setPendingPattern(ex.source);
  };

  return (
    <div className="weighted-panel">
      <div className="pane-head">
        <h2>Weighted automata — one machine, every semiring</h2>
        <p>
          A weighted automaton is the studio's ε-free <strong>position automaton</strong> with a weight{' '}
          <code>κ</code> from a <strong>semiring</strong> on each state. A word's weight is the ⊕-sum, over every
          accepting run, of the ⊗-product along it. Swap the semiring and the <em>same</em> automaton computes a
          different thing — recognition, ambiguity, the cheapest parse, the likeliest run, the total mass. This is
          Schützenberger's rational power series and Mohri's algebraic path problem, lowered onto Glushkov's machine.
        </p>
      </div>

      {/* --- semiring picker --- */}
      <div className="wt-semirings">
        {SEMIRING_IDS.map((id) => (
          <button
            key={id}
            className={`wt-sr${semiring === id ? ' active' : ''}`}
            onClick={() => pickSemiring(id)}
            title={SEMIRING_MEANING[id]}
          >
            {SEMIRINGS[id].name}
          </button>
        ))}
      </div>
      <p className="wt-meaning">
        <span className="wt-meaning-tag">weight =</span> {SEMIRING_MEANING[semiring]}
      </p>

      {/* --- controls --- */}
      <div className="wt-controls">
        <label className="wt-field">
          <span>working alphabet Σ</span>
          <input className="wt-input" value={alphabet} onChange={(e) => setAlphabet(e.target.value)} spellCheck={false} />
        </label>
        <div className="wt-field">
          <span>weighting κ</span>
          <div className="wt-modes">
            {(['uniform', 'letter', 'seed'] as WeightMode[]).map((m) => (
              <button key={m} className={`wt-mode${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>
                {m === 'uniform' ? 'all 1̄' : m === 'letter' ? 'by letter' : 'seeded'}
              </button>
            ))}
          </div>
        </div>
        {mode === 'letter' && (
          <div className="wt-lettertable">
            {alphaLetters.map((ch) => (
              <label key={ch} className="wt-letter">
                <span>{ch}</span>
                <input
                  className="wt-winput"
                  value={letters[ch] ?? ''}
                  placeholder="1"
                  spellCheck={false}
                  onChange={(e) => setLetters({ ...letters, [ch]: e.target.value })}
                />
              </label>
            ))}
          </div>
        )}
        {mode === 'seed' && (
          <label className="wt-field">
            <span>seed</span>
            <input
              className="wt-input small"
              type="number"
              value={seed}
              onChange={(e) => setSeed(Number(e.target.value) | 0)}
            />
          </label>
        )}
      </div>

      {pendingPattern && pendingPattern !== compiled.source && (
        <div className="wt-pending">
          Example pattern: <code>{pendingPattern}</code> — paste it into the editor above to load it.{' '}
          <button className="wt-pending-x" onClick={() => setPendingPattern(null)}>
            dismiss
          </button>
        </div>
      )}

      {analysis.error ? (
        <div className="placeholder">{analysis.error}</div>
      ) : (
        <>
          {/* --- word weight verdict --- */}
          <div className="wt-verdict">
            <div className="wt-word-row">
              <label className="wt-field grow">
                <span>weigh a word</span>
                <input className="wt-input" value={word} onChange={(e) => setWord(e.target.value)} spellCheck={false} />
              </label>
              <div className="wt-weight">
                <span className="wt-weight-label">weight</span>
                <span className="wt-weight-val">{analysis.wordWeight}</span>
              </div>
            </div>
            <div className="wt-word-meta">
              <span className="wt-chip">{analysis.wordRuns} accepting run{analysis.wordRuns === 1 ? '' : 's'}</span>
              {analysis.wordAgree !== undefined && (
                <span className={`wt-chip ${analysis.wordAgree ? 'ok' : 'bad'}`}>
                  {analysis.wordAgree ? 'forward ≡ brute path-sum ✓' : 'forward ≠ brute ✗'}
                </span>
              )}
              {analysis.wordCapped && <span className="wt-chip">enumeration capped</span>}
            </div>
          </div>

          {/* --- the WFA graph --- */}
          {layout && analysis.graph && (
            <GraphCard layout={layout} graph={analysis.graph} states={analysis.states ?? 0} positions={analysis.positions ?? 0} />
          )}

          {/* --- position weights --- */}
          {analysis.positionWeights && analysis.positionWeights.length > 0 && (
            <div className="wt-posweights">
              <h3 className="wt-h3">state weights κ</h3>
              <div className="wt-posrow">
                {analysis.positionWeights.map((p) => (
                  <span key={p.pos} className="wt-pos">
                    <span className="wt-pos-id">{p.pos}</span>
                    <span className="wt-pos-class">{p.label}</span>
                    <span className="wt-pos-w">{p.weight}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* --- the all-words closure + the eliminated weighted regex --- */}
          <div className="wt-closure">
            <h3 className="wt-h3">all-words closure — λ·M*·γ</h3>
            <p className="muted-note">
              The ⊕ over <em>every</em> word of its weight: the total path count (Counting), the shortest distance
              (Tropical), the language mass (Probability). Computed by Lehmann's matrix asteration, and{' '}
              <strong>cross-checked</strong> by eliminating the automaton's states into a weighted regular expression
              (Kleene's theorem over a semiring) and re-evaluating it.
            </p>
            <div className="wt-closure-grid">
              <div className="wt-closure-cell">
                <span className="wt-closure-k">value over Σ = {`{${alphaLetters.join(', ')}}`}</span>
                <span className="wt-closure-v">
                  {analysis.closureValue}
                  {analysis.closureInfinite && <span className="wt-inf"> (diverges — an accepting cycle)</span>}
                </span>
                {!analysis.closureInfinite && (
                  <span className="wt-closure-sub">
                    {analysis.closureConverged
                      ? 'finite — confirmed by the brute Σ*-sum'
                      : 'closed-form (Lehmann ≡ state-elimination regex)'}
                  </span>
                )}
              </div>
              <div className="wt-closure-cell wide">
                <span className="wt-closure-k">the automaton, eliminated to a weighted regex ({analysis.regexSize} nodes)</span>
                <code className="wt-regex">{analysis.closureRegex}</code>
              </div>
            </div>
          </div>

          {/* --- gallery --- */}
          <div className="wt-gallery">
            <h3 className="wt-h3">readings to try</h3>
            <div className="wt-examples">
              {WEIGHTED_EXAMPLES.map((ex, i) => (
                <button key={i} className="wt-example" onClick={() => applyExample(i)}>
                  <code>{ex.source}</code>
                  <span className="wt-example-sr">{SEMIRINGS[ex.semiring].name}</span>
                  <span className="wt-example-blurb">{ex.blurb}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <SelfTestConsole />
    </div>
  );
}

function GraphCard({
  layout,
  graph,
  states,
  positions,
}: {
  layout: ReturnType<typeof layoutGraph>;
  graph: import('../engine/layout').GraphInput;
  states: number;
  positions: number;
}) {
  const [copied, setCopied] = useState(false);
  const copyDot = () => {
    try {
      navigator.clipboard?.writeText(toDot(graph, 'weighted_automaton'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked (sandbox) — ignore */
    }
  };
  const downloadSvg = () => {
    try {
      const blob = new Blob([toSvg(layout, { accent: ACCENT })], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'weighted-automaton.svg';
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
          <h2>The weighted automaton</h2>
          <p>
            <code>ι</code> is the start; states <code>1…{positions}</code> are the linearised letter positions
            ({states} states total). Edges read <code>class / κ</code> (the weight is dropped when it is 1̄);
            double-circled states are accepting.
          </p>
        </div>
        <div className="graph-head-btns">
          <button className="dot-btn" onClick={downloadSvg} title="Download as a standalone SVG">
            download SVG
          </button>
          <button className="dot-btn" onClick={copyDot} title="Copy as Graphviz DOT">
            {copied ? 'copied ✓' : 'copy DOT'}
          </button>
        </div>
      </div>
      <AutomatonGraph layout={layout} accent={ACCENT} />
    </div>
  );
}

function SelfTestConsole() {
  const [seed, setSeed] = useState(DEFAULT_WEIGHTED_FUZZ.seed);
  const [patterns, setPatterns] = useState(DEFAULT_WEIGHTED_FUZZ.patterns);
  const [report, setReport] = useState<WeightedFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (s: number) => {
    setRunning(true);
    setSeed(s);
    // defer so the button shows its disabled state before the (sync) sweep
    setTimeout(() => {
      setReport(runWeightedFuzz({ seed: s, patterns }));
      setRunning(false);
    }, 10);
  };

  return (
    <div className="wt-selftest">
      <h3 className="wt-h3">cross-check console — differential verification</h3>
      <p className="muted-note">
        Every claim is checked against an independent computation over seeded random patterns × semirings ×
        weightings × words: forward ≡ backward ≡ brute path-enumeration per word; the <strong>Boolean</strong> weight
        ≡ the DFA's verdict; the <strong>Counting</strong> weight ≡ the Ambiguity tab's run count; and the all-words
        closure agrees across Lehmann, the iterative ⊕Mᵏ, the state-elimination regex and the brute Σ*-sum. The PRNG
        is seeded, so any counterexample reproduces.
      </p>
      <div className="fuzz-controls">
        <label className="wt-field">
          <span>seed</span>
          <input className="wt-input small" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <label className="wt-field">
          <span>patterns</span>
          <input
            className="wt-input small"
            type="number"
            value={patterns}
            onChange={(e) => setPatterns(Math.max(1, Number(e.target.value) | 0))}
          />
        </label>
        <button className="fuzz-run" disabled={running} onClick={() => run(seed)}>
          {running ? 'running…' : 'run'}
        </button>
        <button className="fuzz-run secondary" disabled={running} onClick={() => run((Math.random() * 2 ** 31) | 0)}>
          random seed
        </button>
      </div>
      {report && (
        <div className={`wt-report ${report.failures.length === 0 ? 'ok' : 'bad'}`}>
          <div className="wt-report-head">
            {report.failures.length === 0 ? (
              <strong>✓ all green</strong>
            ) : (
              <strong>✗ {report.failures.length} disagreement{report.failures.length === 1 ? '' : 's'}</strong>
            )}
            <span className="wt-report-sub">
              {report.patternsTested} patterns · {report.wordChecks.toLocaleString()} word checks ·{' '}
              {report.closureChecks.toLocaleString()} closure checks · {report.crossTabChecks.toLocaleString()} cross-tab
              · {report.lawChecks.toLocaleString()} algebra laws · {report.elapsedMs.toFixed(0)}ms
            </span>
          </div>
          {report.failures.slice(0, 6).map((f, i) => (
            <div key={i} className="wt-report-fail">
              <span className="wt-report-sr">{f.semiring}</span> <code>{f.pattern}</code> — {f.detail}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
