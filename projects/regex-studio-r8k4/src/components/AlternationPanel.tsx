import { useMemo, useState } from 'react';
import {
  parseAFA,
  afaToSource,
  analyzeAFA,
  complementAFA,
  intersectAFA,
  unionAFA,
  evalBF,
  bfToString,
  wordToIndices,
  AFA_GALLERY,
  runAfaFuzz,
  DEFAULT_AFA_FUZZ,
  type AFA,
  type AfaFuzzReport,
} from '../engine/afa';
import { dfaToGraph } from '../engine/graphdata';
import { layoutGraph } from '../engine/layout';
import { AutomatonGraph } from './AutomatonGraph';
import { RegexAfaPanel } from './RegexAfaPanel';

const ACCENT = '#2dd4bf';

export function AlternationPanel({
  source,
  onSourceChange,
}: {
  source: string;
  onSourceChange: (s: string) => void;
}) {
  const parsed = useMemo(() => parseAFA(source), [source]);
  const afa = parsed.afa;

  const analysis = useMemo(() => (afa ? analyzeAFA(afa, 7) : null), [afa]);

  const graph = useMemo(() => (analysis?.minDfa ? dfaToGraph(analysis.minDfa) : null), [analysis]);
  const layout = useMemo(() => (graph ? layoutGraph(graph) : null), [graph]);

  const blowup = analysis && analysis.states > 0 ? analysis.minStates / analysis.states : 1;

  // ── closure operations rewrite the editor source ──────────────────────────
  const applyComplement = () => {
    if (afa) onSourceChange(afaToSource(complementAFA(afa)));
  };
  const applyCombine = (name: string, op: 'and' | 'or') => {
    if (!afa) return;
    const other = AFA_GALLERY.find((g) => g.name === name);
    if (!other) return;
    const b = parseAFA(other.source).afa;
    if (!b) return;
    onSourceChange(afaToSource(op === 'and' ? intersectAFA(afa, b) : unionAFA(afa, b)));
  };

  return (
    <div className="afa-panel deriv-panel">
      <div className="pane-head">
        <h2>Alternation — the automaton that branches ∧ <em>and</em> ∨</h2>
        <p>
          A DFA has one successor; an <strong>NFA</strong> accepts if <em>some</em> run does (existential ∨); a{' '}
          <strong>co-NFA</strong> if <em>every</em> run does (universal ∧). An <strong>alternating</strong> automaton
          does both at once — each transition is an arbitrary <strong>positive boolean formula</strong> over the
          states — and it is <em>still</em> only as strong as a regular language. Two payoffs:{' '}
          <strong>complement is free and linear</strong> (dualise ∧↔∨ and the final set — the same states now accept the
          negation), and <strong>intersection/union are linear</strong> (just ∧/∨ the two initial formulas — no
          product). The price is paid only when you <em>determinise</em>: n alternating states become up to 2ⁿ NFA
          macrostates (sets of states that must <em>all</em> accept the rest), which the studio's own subset
          construction + minimiser then reduce — and cross-check, word for word, against the brute-force alternating
          semantics.
        </p>
      </div>

      {/* the flagship: build a linear AFA straight from a pattern */}
      <RegexAfaPanel />

      <div className="rafa-divider">
        <span>· · · or write an alternating automaton by hand · · ·</span>
      </div>

      {/* gallery */}
      <div className="afa-gallery">
        {AFA_GALLERY.map((g) => (
          <button key={g.name} className="chip" title={g.note} onClick={() => onSourceChange(g.source)}>
            {g.name}
          </button>
        ))}
      </div>

      {/* editor */}
      <textarea
        className={`afa-editor${parsed.error ? ' has-error' : ''}`}
        spellCheck={false}
        value={source}
        onChange={(e) => onSourceChange(e.target.value)}
        rows={Math.min(16, Math.max(6, source.split('\n').length + 1))}
      />
      <p className="muted-note">
        Syntax: <code>alphabet: a b</code> · <code>init: q0 &amp; q1</code> · <code>q0, a -&gt; q0 | q1</code> ·{' '}
        <code>final: q1</code>. Formulas are <strong>positive</strong> — <code>&amp;</code> (∧), <code>|</code> (∨),
        parentheses, <code>true</code>/<code>false</code>. No negation: complement comes from the dual, below. A missing
        (state, symbol) rule is ⊥ (a dead obligation).
      </p>

      {parsed.error && (
        <div className="parse-error">
          <span className="err-msg">
            {parsed.error.message} <span className="muted">(line {parsed.error.line})</span>
          </span>
        </div>
      )}

      {afa && analysis && (
        <>
          {/* closure toolbar */}
          <div className="afa-tools">
            <button className="chip primary" onClick={applyComplement} title="Dualise ∧↔∨ and flip the final set">
              ¬ complement (dualise)
            </button>
            <CombineMenu label="∩ intersect with" op="and" onPick={applyCombine} />
            <CombineMenu label="∪ union with" op="or" onPick={applyCombine} />
          </div>

          {/* stats */}
          <div className="lang-grid afa-stats">
            <Stat k="AFA states" v={String(analysis.states)} accent />
            <Stat k="NFA macrostates" v={analysis.truncated ? '> cap' : String(analysis.nfaStates)} />
            <Stat k="DFA states" v={analysis.truncated ? '—' : String(analysis.dfaStates)} />
            <Stat k="min-DFA states" v={analysis.truncated ? '—' : String(analysis.minStates)} />
            <div className="lang-card">
              <span className="lang-key">determinisation blow-up</span>
              <span className={`lang-badge ${blowup >= 1.5 ? 'good' : ''}`}>
                {analysis.truncated ? 'too large' : `${analysis.states} → ${analysis.minStates} (×${blowup.toFixed(2)})`}
              </span>
            </div>
          </div>

          {/* correctness badge */}
          {!analysis.truncated && (
            <div className={`graph-badge ${analysis.agree ? 'ok' : 'bad'}`}>
              {analysis.agree
                ? `oracle ≡ min-DFA on every word up to length ${analysis.maxLen} ✓ — the alternating semantics and the determinised machine agree`
                : 'DISAGREEMENT — the AFA→NFA construction is wrong (a bug)'}
            </div>
          )}
          {analysis.truncated && (
            <div className="graph-badge warn">
              The macrostate construction exceeded its safety cap — this AFA's NFA is too large to determinise here.
            </div>
          )}

          {/* language read back as a regex */}
          {!analysis.truncated && (
            <p className="muted-note afa-lang">
              <strong>Language</strong> (read off the minimal DFA by Kleene / state-elimination):{' '}
              <code>{analysis.empty ? '∅' : analysis.epsilonOnly ? 'ε' : analysis.regex || 'ε'}</code>
            </p>
          )}

          {/* the transition table */}
          <h3 className="lang-h3">The alternating transition table δ : Q × Σ → B⁺(Q)</h3>
          <p className="muted-note">
            <strong>init</strong> = <code className="afa-formula">{bfToString(afa.init, afa.names)}</code>. A row's cell
            is the positive boolean formula the state hands down the word on that symbol; ⊥ is a dead obligation. A ★
            marks a final state (accepts the empty suffix).
          </p>
          <div className="afa-table-wrap">
            <table className="afa-table">
              <thead>
                <tr>
                  <th>state</th>
                  {afa.symbols.map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {afa.names.map((nm, q) => (
                  <tr key={q}>
                    <th className="afa-state">
                      {nm}
                      {afa.final[q] && <span className="afa-final" title="final">★</span>}
                    </th>
                    {afa.symbols.map((s, si) => (
                      <td key={s}>
                        <code className="afa-formula">{bfToString(afa.delta[q][si], afa.names)}</code>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <RunBox afa={afa} />

          {/* the acceptance strip */}
          {analysis.rows.length > 0 && (
            <>
              <h3 className="lang-h3">Membership — the alternating semantics on every short word</h3>
              <p className="muted-note">
                Each word up to length {analysis.maxLen} evaluated by the definition (δ recursed down the word,
                ∧/∨-folded, bottoming out at the final set). Green = accepted.
              </p>
              <div className="logic-truth">
                {analysis.rows.map((r) => (
                  <span key={r.word} className={`logic-cell ${r.accept ? 'acc' : 'rej'}`}>
                    {r.word === '' ? 'ε' : r.word}
                  </span>
                ))}
              </div>
            </>
          )}

          {/* the determinised machine */}
          {layout && (
            <div className="graph-pane">
              <div className="pane-head graph-head">
                <div>
                  <h3>The minimal DFA — alternation, flattened</h3>
                  <p>
                    The same language every other tab speaks. It flows into Compare, Census, the syntactic monoid and
                    the rest — an AFA is a first-class citizen of the studio.
                  </p>
                </div>
              </div>
              <AutomatonGraph layout={layout} accent={ACCENT} />
            </div>
          )}
        </>
      )}

      <CrossCheck />
    </div>
  );
}

function Stat({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="lang-card">
      <span className="lang-key">{k}</span>
      <span className={`lang-badge ${accent ? 'good' : ''}`}>
        <code>{v}</code>
      </span>
    </div>
  );
}

function CombineMenu({
  label,
  op,
  onPick,
}: {
  label: string;
  op: 'and' | 'or';
  onPick: (name: string, op: 'and' | 'or') => void;
}) {
  return (
    <label className="afa-combine">
      <span>{label}</span>
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value, op);
          e.currentTarget.value = '';
        }}
      >
        <option value="">choose…</option>
        {AFA_GALLERY.map((g) => (
          <option key={g.name} value={g.name}>
            {g.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// Run one word and show the obligation frontier — which states must accept each
// suffix — instead of the (potentially exponential) full run tree.
function RunBox({ afa }: { afa: AFA }) {
  const [word, setWord] = useState('');
  const result = useMemo(() => {
    const idx = wordToIndices(afa, word);
    if (idx === null) return { offAlphabet: true } as const;
    const L = idx.length;
    // frontier[pos][q] = accept(q, word[pos…])
    const frontier: boolean[][] = new Array(L + 1);
    frontier[L] = afa.final.slice();
    for (let pos = L - 1; pos >= 0; pos--) {
      const si = idx[pos];
      frontier[pos] = afa.final.map((_, q) => evalBF(afa.delta[q][si], (r) => frontier[pos + 1][r]));
    }
    const accept = evalBF(afa.init, (q) => frontier[0][q]);
    return { offAlphabet: false, accept, frontier, L } as const;
  }, [afa, word]);

  return (
    <>
      <h3 className="lang-h3">Run a word — the obligation frontier</h3>
      <p className="muted-note">
        Reading right-to-left, which states must accept the remaining suffix (a filled cell = must-accept). The word is
        in the language iff <code>init</code> is satisfied by the leftmost column.
      </p>
      <div className="pattern-box afa-runbox">
        <input
          className="pattern-input"
          value={word}
          spellCheck={false}
          placeholder="type a word over the alphabet…"
          onChange={(e) => setWord(e.target.value)}
        />
      </div>
      {result.offAlphabet ? (
        <div className="graph-badge warn">the word uses a symbol outside the alphabet {`{${afa.symbols.join(' ')}}`}</div>
      ) : (
        <>
          <div className={`graph-badge ${result.accept ? 'ok' : 'bad'}`}>
            {result.accept ? `“${word || 'ε'}” ∈ L(A) — accepted` : `“${word || 'ε'}” ∉ L(A) — rejected`}
          </div>
          <div className="afa-frontier-wrap">
            <table className="afa-frontier">
              <thead>
                <tr>
                  <th></th>
                  {Array.from({ length: result.L + 1 }, (_, pos) => (
                    <th key={pos}>{pos < result.L ? word[pos] : 'ε'}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {afa.names.map((nm, q) => (
                  <tr key={q}>
                    <th className="afa-state">{nm}</th>
                    {result.frontier.map((col, pos) => (
                      <td key={pos} className={`afa-fcell ${col[q] ? 'on' : 'off'}`} title={col[q] ? 'must accept' : '—'} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function CrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_AFA_FUZZ.seed);
  const [trials, setTrials] = useState(DEFAULT_AFA_FUZZ.trials);
  const [report, setReport] = useState<AfaFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      setReport(runAfaFuzz({ ...DEFAULT_AFA_FUZZ, seed: nextSeed, trials }));
      setRunning(false);
    }, 10);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check the construction</h3>
      <p className="muted-note">
        A seeded fuzzer draws random alternating automata and confronts each with the brute-force oracle on{' '}
        <strong>every</strong> word up to length {DEFAULT_AFA_FUZZ.maxLen}: the AFA→NFA→DFA→min pipeline must accept
        exactly the oracle's language, the <strong>dual</strong> must accept its complement, and the ∧/∨ combination of
        two AFAs must accept their intersection/union. Any disagreement is a real bug.
      </p>
      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <label className="fuzz-field">
          <span>automata</span>
          <input
            type="number"
            min={10}
            max={600}
            value={trials}
            onChange={(e) => setTrials(Math.max(10, Math.min(600, Number(e.target.value) | 0)))}
          />
        </label>
        <button className="fuzz-run" disabled={running} onClick={() => run(seed)}>
          {running ? 'running…' : 'run'}
        </button>
        <button className="fuzz-run secondary" disabled={running} onClick={() => run((seed * 1103515245 + 12345) | 0)}>
          new seed
        </button>
      </div>

      {!report && !running && (
        <div className="placeholder">
          Press <strong>run</strong> to build hundreds of random alternating automata and verify each against the oracle.
        </div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.ok ? 'ok' : 'bad'}`}>
            {report.ok ? (
              <>
                <span className="fuzz-big">✓ every automaton construction is correct</span>
                <span className="fuzz-sub">
                  {report.trials} AFAs — {report.membershipChecks.toLocaleString()} membership,{' '}
                  {report.complementChecks.toLocaleString()} complement and {report.closureChecks.toLocaleString()}{' '}
                  closure checks against the oracle, all agree. Largest determinisation blow-up seen: ×
                  {report.maxBlowup.toFixed(2)}. {report.elapsedMs.toFixed(0)} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failure?.kind} mismatch</span>
                <span className="fuzz-sub">A construction disagreed with the oracle — see the counterexample below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="automata" v={String(report.trials)} />
            <St k="membership" v={report.membershipChecks.toLocaleString()} />
            <St k="complement" v={report.complementChecks.toLocaleString()} />
            <St k="closure" v={report.closureChecks.toLocaleString()} />
            <St k="max blow-up" v={`×${report.maxBlowup.toFixed(2)}`} />
            <St k="time" v={`${report.elapsedMs.toFixed(0)} ms`} />
          </div>
          {report.failure && (
            <div className="fuzz-counter">
              <h3>Counterexample</h3>
              <div className="fuzz-cx-row">
                <span className="learn-fail-reason">{report.failure.detail}</span>
              </div>
              <pre className="afa-cx-src">{report.failure.source}</pre>
            </div>
          )}
        </>
      )}
    </>
  );
}

function St({ k, v }: { k: string; v: string }) {
  return (
    <div className="fuzz-stat">
      <span className="fuzz-stat-v">{v}</span>
      <span className="fuzz-stat-k">{k}</span>
    </div>
  );
}
