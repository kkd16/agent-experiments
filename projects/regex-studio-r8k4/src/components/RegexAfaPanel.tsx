import { useMemo, useState } from 'react';
import { parseExtended } from '../engine/parser';
import { fromAstE, showE, type EReg } from '../engine/ereg';
import {
  eregToAFA,
  analyzeAFA,
  afaEmptiness,
  afaUniversality,
  bfToString,
  bfVars,
  evalBF,
  wordToIndices,
  runRegexAfaFuzz,
  DEFAULT_REGEX_AFA_FUZZ,
  type AFA,
  type BF,
  type DecisionResult,
  type UniversalityResult,
  type RegexAfaFuzzReport,
} from '../engine/afa';
import { dfaToGraph } from '../engine/graphdata';
import { layoutGraph } from '../engine/layout';
import { AutomatonGraph } from './AutomatonGraph';

const ACCENT = '#2dd4bf';

const EXAMPLES: { pat: string; note: string }[] = [
  { pat: '~(.*aa.*)&.*b.*', note: 'no “aa” AND contains a “b” — a complement ∧ an existential, both free' },
  { pat: '.*a..', note: 'the 3rd symbol from the end is “a” — linear AFA, exponential (2³) DFA' },
  { pat: '.*a.*&.*b.*', note: 'contains an “a” AND a “b” — intersection with no product' },
  { pat: '~(a*)', note: 'the complement of a* — the dual, no determinise-then-flip' },
  { pat: 'a&b', note: 'disjoint — L = ∅ (watch the antichain prove it)' },
  { pat: '~((a|b)*)', note: 'complement of the universal language — also ∅' },
  { pat: '(a|b)*a(a|b)*&(a|b)*b(a|b)*', note: 'a big ∧ — the determinisation blow-up on show' },
];

export function RegexAfaPanel() {
  const [pattern, setPattern] = useState(EXAMPLES[0].pat);

  const built = useMemo(() => {
    const pr = parseExtended(pattern);
    if (!pr.ast) return { error: pr.error?.message ?? 'parse error' } as const;
    let ereg: EReg;
    try {
      ereg = fromAstE(pr.ast);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) } as const;
    }
    const b = eregToAFA(ereg);
    return { ereg, ...b } as const;
  }, [pattern]);

  const info = 'afa' in built ? built : null;
  const afa = info?.afa ?? null;
  const analysis = useMemo(() => (afa ? analyzeAFA(afa, 7) : null), [afa]);
  const emptiness = useMemo(() => (afa ? afaEmptiness(afa) : null), [afa]);
  const universality = useMemo(() => (afa ? afaUniversality(afa) : null), [afa]);
  const graph = useMemo(() => (analysis?.minDfa ? dfaToGraph(analysis.minDfa) : null), [analysis]);
  const layout = useMemo(() => (graph ? layoutGraph(graph) : null), [graph]);

  const blowup = analysis && analysis.states > 0 ? analysis.minStates / analysis.states : 1;

  return (
    <div className="rafa">
      <div className="pane-head">
        <h3>Start from a regular expression — the linear alternating construction</h3>
        <p>
          The tab above lets you <em>write</em> an AFA. This builds one from a <strong>pattern</strong> — the alternating
          twin of Thompson/Glushkov/Antimirov. A plain expression compiles to its{' '}
          <strong>Antimirov partial-derivative</strong> states (≤ #letters + 1 — genuinely <em>linear</em>); and the two
          operations that cost a determinisation everywhere else are free here:{' '}
          <code>a &amp; b</code> is a <strong>∧ join</strong> (no product) and <code>~a</code> is the{' '}
          <strong>dual</strong> (no complete-then-flip). Type an extended regex (the <code>Extended &amp;~</code>{' '}
          grammar: <code>&amp;</code> intersection, <code>~</code> complement, <code>−</code> difference) and watch the
          linear AFA sit beside its exponential DFA.
        </p>
      </div>

      <div className="rafa-examples">
        {EXAMPLES.map((e) => (
          <button key={e.pat} className="chip" title={e.note} onClick={() => setPattern(e.pat)}>
            {e.pat}
          </button>
        ))}
      </div>

      <div className={`pattern-box${'error' in built ? ' has-error' : ''}`}>
        <span className="pattern-slash">/</span>
        <input
          className="pattern-input"
          value={pattern}
          spellCheck={false}
          placeholder="type an extended regex, e.g. ~(.*aa.*)&.*b.*"
          onChange={(e) => setPattern(e.target.value)}
        />
        <span className="pattern-slash">/</span>
      </div>

      {'error' in built && <div className="parse-error"><span className="err-msg">{built.error}</span></div>}

      {afa && info && (
        <>
          <p className="muted-note rafa-norm">
            <strong>Normalised:</strong> <code className="afa-formula">{showE(info.ereg)}</code> ·{' '}
            <strong>alphabet</strong> Σ = <code>{`{ ${afa.symbols.join(' ')} }`}</code>
            {info.alphabet.full && <span className="muted"> (one symbol stands for “any other character”)</span>} ·{' '}
            <span className={info.usedFallback ? 'rafa-warn' : 'rafa-ok'}>{info.note}</span>
          </p>

          {analysis && (
            <div className="lang-grid afa-stats">
              <Stat k="AFA states (linear)" v={String(analysis.states)} accent />
              <Stat k="NFA macrostates" v={analysis.truncated ? '> cap' : String(analysis.nfaStates)} />
              <Stat k="min-DFA states" v={analysis.truncated ? '—' : String(analysis.minStates)} />
              <div className="lang-card">
                <span className="lang-key">determinisation blow-up</span>
                <span className={`lang-badge ${blowup >= 1.5 ? 'good' : ''}`}>
                  {analysis.truncated ? 'too large' : `${analysis.states} → ${analysis.minStates} (×${blowup.toFixed(2)})`}
                </span>
              </div>
            </div>
          )}

          {analysis && !analysis.truncated && (
            <div className={`graph-badge ${analysis.agree ? 'ok' : 'bad'}`}>
              {analysis.agree
                ? `L(AFA) ≡ L(regex) on every word up to length ${analysis.maxLen} ✓ — the alternating construction, its determinisation and the ereg span-oracle all agree`
                : 'DISAGREEMENT — the regex→AFA construction is wrong (a bug)'}
            </div>
          )}

          {/* the two deciders — straight on the AFA, no determinisation */}
          {emptiness && universality && (
            <div className="rafa-decide">
              <DecideCard
                title="Emptiness — is L = ∅ ?"
                sub="antichain over ⊆-minimal macrostates"
                res={emptiness}
                verdictTrue="L = ∅ (empty)"
                verdictFalse="L ≠ ∅ (non-empty)"
                isPositive={emptiness.empty}
                witnessLabel="shortest accepted word"
                symbolsEmpty={afa.symbols.length === 0}
              />
              <DecideCard
                title="Universality — is L = Σ* ?"
                sub="emptiness of the free dual ~A"
                res={universality}
                verdictTrue="L = Σ* (universal)"
                verdictFalse="L ≠ Σ* (not universal)"
                isPositive={(universality as UniversalityResult).universal}
                witnessLabel="shortest rejected word"
                symbolsEmpty={afa.symbols.length === 0}
              />
            </div>
          )}

          {/* transition table */}
          <h4 className="rafa-h4">The alternating transition table δ : Q × Σ → B⁺(Q)</h4>
          <p className="muted-note">
            <strong>init</strong> = <code className="afa-formula">{bfToString(afa.init, afa.names)}</code>. Each state is
            an Antimirov residual (its remaining obligation); ★ marks a nullable (final) one. ⊥ is a dead branch.
          </p>
          <div className="afa-table-wrap">
            <table className="afa-table">
              <thead>
                <tr>
                  <th>state (residual)</th>
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
                      {afa.final[q] && <span className="afa-final" title="final / nullable">★</span>}
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

          <RunTree afa={afa} />

          {layout && (
            <div className="graph-pane">
              <div className="pane-head graph-head">
                <div>
                  <h4>The minimal DFA — the same language, flattened</h4>
                  <p>What the linear AFA determinises to. The blow-up above is the price alternation lets you avoid.</p>
                </div>
              </div>
              <AutomatonGraph layout={layout} accent={ACCENT} />
            </div>
          )}
        </>
      )}

      <RegexCrossCheck />
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

function DecideCard({
  title,
  sub,
  res,
  verdictTrue,
  verdictFalse,
  isPositive,
  witnessLabel,
  symbolsEmpty,
}: {
  title: string;
  sub: string;
  res: DecisionResult;
  verdictTrue: string;
  verdictFalse: string;
  isPositive: boolean;
  witnessLabel: string;
  symbolsEmpty: boolean;
}) {
  if (!res.decided)
    return (
      <div className="rafa-card">
        <div className="rafa-card-title">{title}</div>
        <div className="rafa-card-sub">{sub}</div>
        <div className="graph-badge warn">too large to sweep macrostates (n &gt; 16)</div>
      </div>
    );
  const saving = res.naiveExplored && res.explored > 0 ? res.naiveExplored / res.explored : null;
  return (
    <div className="rafa-card">
      <div className="rafa-card-title">{title}</div>
      <div className="rafa-card-sub">{sub}</div>
      <div className={`rafa-verdict ${isPositive ? 'pos' : 'neg'}`}>{isPositive ? verdictTrue : verdictFalse}</div>
      {res.witness !== null && (
        <div className="rafa-witness">
          {witnessLabel}: <code>{res.witness === '' ? 'ε' : res.witness}</code>
        </div>
      )}
      <div className="rafa-metrics">
        <span>
          antichain expanded <strong>{res.explored}</strong>
        </span>
        {res.naiveExplored !== null && (
          <span>
            vs naive <strong>{res.naiveExplored}</strong>
            {saving && saving >= 1.2 ? ` (×${saving.toFixed(1)} fewer)` : ''}
          </span>
        )}
        {res.budgetHit && <span className="rafa-warn">budget hit</span>}
      </div>
      {symbolsEmpty && <div className="muted rafa-tiny">alphabet is empty — Σ* = {'{ε}'}</div>}
    </div>
  );
}

// ── The animated alternating run tree ────────────────────────────────────────
// Each state at a position expands into the ∧/∨ formula it hands down the word,
// whose variable leaves recurse into the next position — the alternating run as
// a real tree of ∧-nodes and ∨-nodes, coloured by whether each is satisfied.

const MAX_TREE_LEN = 6;

function RunTree({ afa }: { afa: AFA }) {
  const [word, setWord] = useState('');
  const idx = wordToIndices(afa, word);

  const acc = useMemo(() => {
    if (!idx) return null;
    const L = idx.length;
    const table: boolean[][] = new Array(L + 1);
    table[L] = afa.final.slice();
    for (let pos = L - 1; pos >= 0; pos--) {
      const si = idx[pos];
      table[pos] = afa.final.map((_, q) => evalBF(afa.delta[q][si], (r) => table[pos + 1][r]));
    }
    return table;
  }, [afa, idx]);

  const tooLong = (idx?.length ?? 0) > MAX_TREE_LEN;
  const accept = idx && acc ? evalBF(afa.init, (q) => acc[0][q]) : false;

  return (
    <>
      <h4 className="rafa-h4">The alternating run tree</h4>
      <p className="muted-note">
        Read a word and watch the run <em>branch</em>: an ∧-node demands <em>all</em> its children accept the rest of the
        word, an ∨-node demands <em>one</em>. A green node is satisfied; the word is in the language iff{' '}
        <code>init</code> is.
      </p>
      <div className="pattern-box afa-runbox">
        <input
          className="pattern-input"
          value={word}
          spellCheck={false}
          placeholder={`type a word over { ${afa.symbols.join(' ')} }…`}
          onChange={(e) => setWord(e.target.value)}
        />
      </div>
      {!idx ? (
        <div className="graph-badge warn">the word uses a symbol outside Σ = {`{ ${afa.symbols.join(' ')} }`}</div>
      ) : (
        <>
          <div className={`graph-badge ${accept ? 'ok' : 'bad'}`}>
            {accept ? `“${word || 'ε'}” ∈ L — accepted` : `“${word || 'ε'}” ∉ L — rejected`}
          </div>
          {tooLong ? (
            <div className="muted-note">
              (tree hidden for words longer than {MAX_TREE_LEN} — the obligation frontier in the tab above stays compact
              for long words)
            </div>
          ) : (
            acc && (
              <div className="rafa-tree">
                <div className="rafa-tree-root">
                  <span className="rt-init">init =</span>
                  <FormulaNode afa={afa} idx={idx} acc={acc} f={afa.init} pos={0} />
                </div>
              </div>
            )
          )}
        </>
      )}
    </>
  );
}

function FormulaNode({
  afa,
  idx,
  acc,
  f,
  pos,
}: {
  afa: AFA;
  idx: number[];
  acc: boolean[][];
  f: BF;
  pos: number;
}) {
  const truth = evalBF(f, (r) => acc[pos][r]);
  const cls = truth ? 'rt-true-node' : 'rt-false-node';
  switch (f.k) {
    case 'true':
      return <span className={`rt-leaf ${cls}`}>⊤</span>;
    case 'false':
      return <span className={`rt-leaf ${cls}`}>⊥</span>;
    case 'var':
      return <StateNode afa={afa} idx={idx} acc={acc} q={f.q} pos={pos} />;
    case 'and':
    case 'or': {
      const op = f.k === 'and' ? '∧' : '∨';
      return (
        <span className={`rt-conn ${cls}`}>
          <span className="rt-paren">(</span>
          <FormulaNode afa={afa} idx={idx} acc={acc} f={f.a} pos={pos} />
          <span className="rt-op">{op}</span>
          <FormulaNode afa={afa} idx={idx} acc={acc} f={f.b} pos={pos} />
          <span className="rt-paren">)</span>
        </span>
      );
    }
  }
}

function StateNode({
  afa,
  idx,
  acc,
  q,
  pos,
}: {
  afa: AFA;
  idx: number[];
  acc: boolean[][];
  q: number;
  pos: number;
}) {
  const L = idx.length;
  const ok = acc[pos][q];
  if (pos === L) {
    return (
      <span className={`rt-state rt-terminal ${ok ? 'rt-on' : 'rt-off'}`} title={ok ? 'nullable — accepts ε' : 'not nullable'}>
        {afa.names[q]} {afa.final[q] ? '★' : '✗'}
      </span>
    );
  }
  const sym = afa.symbols[idx[pos]];
  const formula = afa.delta[q][idx[pos]];
  const branches = bfVars(formula).size > 0; // ⊤/⊥ leaves render inline, no rule
  return (
    <span className="rt-state-wrap">
      <span className={`rt-state ${ok ? 'rt-on' : 'rt-off'}`}>
        {afa.names[q]}
        <span className="rt-arrow"> —{sym}→</span>
      </span>
      {branches ? (
        <span className="rt-children">
          <FormulaNode afa={afa} idx={idx} acc={acc} f={formula} pos={pos + 1} />
        </span>
      ) : (
        <FormulaNode afa={afa} idx={idx} acc={acc} f={formula} pos={pos + 1} />
      )}
    </span>
  );
}

// ── the proof console for this road ──────────────────────────────────────────
function RegexCrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_REGEX_AFA_FUZZ.seed);
  const [trials, setTrials] = useState(DEFAULT_REGEX_AFA_FUZZ.trials);
  const [report, setReport] = useState<RegexAfaFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      setReport(runRegexAfaFuzz({ ...DEFAULT_REGEX_AFA_FUZZ, seed: nextSeed, trials }));
      setRunning(false);
    }, 10);
  };

  return (
    <>
      <h4 className="rafa-h4">Cross-check the regex → AFA construction</h4>
      <p className="muted-note">
        A seeded fuzzer draws random <strong>extended</strong> regexes and confronts each built AFA, on every word up to
        length {DEFAULT_REGEX_AFA_FUZZ.maxLen}, with three independent authorities: the <code>ereg</code> span-oracle
        (membership by <code>ends(A&amp;B)=ends A ∩ ends B</code>, <code>ends(~A)=</code>complement), the AFA→NFA→DFA→min
        pipeline, and the determinised DFA's own emptiness/universality (which the antichain deciders must match, witness
        for witness). Any disagreement is a real bug.
      </p>
      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <label className="fuzz-field">
          <span>regexes</span>
          <input
            type="number"
            min={20}
            max={2000}
            value={trials}
            onChange={(e) => setTrials(Math.max(20, Math.min(2000, Number(e.target.value) | 0)))}
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
          Press <strong>run</strong> to build hundreds of random extended regexes and verify each AFA against all three
          authorities.
        </div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.ok ? 'ok' : 'bad'}`}>
            {report.ok ? (
              <>
                <span className="fuzz-big">✓ every regex → AFA construction is correct</span>
                <span className="fuzz-sub">
                  {report.trials} regexes — {report.membershipChecks.toLocaleString()} oracle,{' '}
                  {report.determinisedChecks.toLocaleString()} determinised and {report.deciderChecks.toLocaleString()}{' '}
                  emptiness/universality checks, all agree. Largest blow-up ×{report.maxBlowup.toFixed(2)}; the antichain
                  expanded up to ×{report.maxSaving.toFixed(1)} fewer macrostates than a determiniser.{' '}
                  {report.fallbacks} used the non-linear fallback. {report.elapsedMs.toFixed(0)} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failure?.kind} mismatch</span>
                <span className="fuzz-sub">A construction disagreed — see the counterexample below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="regexes" v={String(report.trials)} />
            <St k="oracle" v={report.membershipChecks.toLocaleString()} />
            <St k="determinised" v={report.determinisedChecks.toLocaleString()} />
            <St k="deciders" v={report.deciderChecks.toLocaleString()} />
            <St k="max blow-up" v={`×${report.maxBlowup.toFixed(2)}`} />
            <St k="antichain win" v={`×${report.maxSaving.toFixed(1)}`} />
            <St k="fallbacks" v={String(report.fallbacks)} />
            <St k="time" v={`${report.elapsedMs.toFixed(0)} ms`} />
          </div>
          {report.failure && (
            <div className="fuzz-counter">
              <h4>Counterexample</h4>
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
