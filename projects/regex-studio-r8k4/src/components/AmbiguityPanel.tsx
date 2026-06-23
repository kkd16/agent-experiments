import { useMemo, useState } from 'react';
import type { RegexNode } from '../engine/ast';
import {
  analyzeAmbiguity,
  glushkovENFA,
  symbolAtoms,
  bruteCounts,
  transferRuns,
  enumerateRuns,
  type AmbClass,
  type AmbiguityReport,
} from '../engine/ambiguity';
import { buildGlushkov, positionToGraph } from '../engine/glushkov';
import { layoutGraph } from '../engine/layout';
import { AutomatonGraph } from './AutomatonGraph';
import {
  DEFAULT_AMBIGUITY_FUZZ,
  runAmbiguityFuzz,
  type AmbiguityFuzzReport,
} from '../engine/ambiguity-verify';

const CLASS_LABEL: Record<AmbClass, string> = {
  unambiguous: 'unambiguous',
  finite: 'finitely ambiguous',
  polynomial: 'polynomially ambiguous',
  exponential: 'exponentially ambiguous',
};

const CLASS_BLURB: Record<AmbClass, string> = {
  unambiguous:
    'Every word has at most one accepting run — the automaton never has to guess. The squared automaton N×N has no useful off-diagonal state.',
  finite:
    'The number of runs is capped by a constant, no matter how long the word: neither the EDA nor the IDA pattern occurs. Some word has ≥2 runs, but the count never grows with length.',
  polynomial:
    'The run count grows like a polynomial nᵈ in the word length. The IDA pattern occurs (the triple automaton has a path (p,p,q) ⇝ (p,q,q)), but never the doubled-cycle EDA pattern, so growth stays sub-exponential.',
  exponential:
    'The run count explodes like 2^Θ(n): some state has two distinct cycles spelling one word (EDA), so each pump doubles the number of decompositions. This is exactly the condition that makes a backtracking matcher blow up — see the ReDoS tab.',
};

// the largest atom-alphabet length we brute-force live in the panel
function liveLen(atomCount: number): number {
  const budget = 60_000;
  let L = 4;
  while (L < 8 && Math.pow(atomCount, L + 1) <= budget) L++;
  return L;
}

function degreeText(r: AmbiguityReport): string {
  if (r.klass === 'exponential') return '2^Θ(n)';
  if (r.klass === 'polynomial') return r.degreeKnown ? `n^${r.degree}` : 'n^? (degree not computed)';
  if (r.klass === 'finite') return 'Θ(1), ≥ 2';
  return '≤ 1';
}

export function AmbiguityPanel({
  ast,
  regular,
  notice,
  onUseText,
}: {
  ast: RegexNode | null;
  regular: boolean;
  notice: string | null;
  onUseText?: (s: string) => void;
}) {
  const data = useMemo(() => {
    if (!ast || !regular) return null;
    let report: AmbiguityReport;
    try {
      report = analyzeAmbiguity(ast);
    } catch {
      return null;
    }
    if (!report.ok) return { report, graph: null, counts: null, edaGrowth: null };
    let graph = null;
    let enfa: ReturnType<typeof glushkovENFA> | null = null;
    try {
      const pa = buildGlushkov(ast);
      graph = layoutGraph(positionToGraph(pa));
      enfa = glushkovENFA(pa);
    } catch {
      /* graph/enfa optional */
    }
    // live run/word counts over the pattern's symbol atoms
    let counts: null | {
      amb: number[];
      runs: bigint[];
      words: bigint[];
      transferOk: boolean;
      L: number;
      atomLabels: string[];
    } = null;
    if (enfa) {
      try {
        const atoms = symbolAtoms(enfa);
        if (atoms.ok && atoms.reps.length > 0) {
          const L = liveLen(atoms.reps.length);
          const brute = bruteCounts(enfa, atoms.reps, L);
          const transfer = transferRuns(enfa, atoms.reps, L);
          let transferOk = true;
          for (let n = 0; n <= L; n++) if (transfer[n] !== brute.total[n]) transferOk = false;
          counts = { amb: brute.amb, runs: brute.total, words: brute.words, transferOk, L, atomLabels: atoms.labels };
        }
      } catch {
        /* counts optional */
      }
    }
    // how the EDA pump multiplies the run count: runs(prefix·pumpᵏ·suffix)
    let edaGrowth: { k: number; runs: number }[] | null = null;
    if (enfa && report.eda) {
      const { prefix, pump, suffix } = report.eda;
      edaGrowth = [];
      for (let k = 1; k <= 5; k++) {
        const w = prefix + pump.repeat(k) + suffix;
        edaGrowth.push({ k, runs: enumerateRuns(enfa, w, 100000).length });
      }
    }
    return { report, graph, counts, edaGrowth };
  }, [ast, regular]);

  if (!data) {
    return <div className="placeholder">{notice ?? 'Fix the pattern to analyse its ambiguity.'}</div>;
  }

  const { report, graph, counts, edaGrowth } = data;
  if (!report.ok) {
    return <div className="placeholder">{report.reason ?? 'This pattern is too large to analyse.'}</div>;
  }

  // states to light on the graph: the witness for whichever pattern fired
  const highlight = new Set<number>();
  if (report.eda) highlight.add(report.eda.pivot);
  for (const s of report.idaChain) highlight.add(s);
  if (report.ida) {
    highlight.add(report.ida.p);
    highlight.add(report.ida.q);
  }

  const isBad = report.klass === 'exponential';
  const isWarn = report.klass === 'polynomial';

  const edaWord = report.eda ? report.eda.prefix + report.eda.pump.repeat(3) + report.eda.suffix : null;

  return (
    <div className="amb-panel">
      <div className="pane-head">
        <h2>Ambiguity — how many ways can one word be matched?</h2>
        <p>
          Census counts <strong>words</strong>; this counts <strong>runs</strong>. An NFA can accept a word along
          several distinct paths, and its <strong>degree of ambiguity</strong> falls — by the{' '}
          <strong>Weber–Seidl theorem</strong> — into exactly four classes, each decided structurally on the ε-free{' '}
          <strong>Glushkov</strong> automaton: <code>EDA</code> (a state with two distinct same-word cycles, found in
          the squared automaton N×N) ⇒ <em>exponential</em>; <code>IDA</code> (a path <code>(p,p,q) ⇝ (p,q,q)</code> in
          the cubed automaton N×N×N) ⇒ <em>polynomial</em>, of a degree read off the longest IDA chain; neither ⇒{' '}
          <em>finite</em>; and no off-diagonal useful pair at all ⇒ <em>unambiguous</em>.
        </p>
      </div>

      <div className="amb-verdict">
        <div className={`amb-verdict-badge ${isBad ? 'bad' : isWarn ? 'warn' : 'good'}`}>
          <span className="amb-verdict-class">{CLASS_LABEL[report.klass]}</span>
          <span className="amb-verdict-growth">
            runs grow like <code>{degreeText(report)}</code>
          </span>
        </div>
        <p className="muted-note amb-verdict-blurb">{CLASS_BLURB[report.klass]}</p>
      </div>

      <div className="lang-grid">
        <div className="lang-card">
          <span className="lang-key">EDA (doubled cycle)</span>
          <span className={`lang-badge ${report.eda ? 'bad' : 'good'}`}>{report.eda ? 'present ⇒ exponential' : 'absent'}</span>
        </div>
        <div className="lang-card">
          <span className="lang-key">IDA (p→p, p→q, q→q)</span>
          <span className={`lang-badge ${report.ida ? 'warn' : 'good'}`}>
            {report.idaComputed ? (report.ida ? 'present ⇒ polynomial' : 'absent') : 'not computed (large)'}
          </span>
        </div>
        <div className="lang-card">
          <span className="lang-key">degree</span>
          <span className="lang-badge">
            <code>{report.klass === 'exponential' ? '∞' : report.degreeKnown ? report.degree : '?'}</code>
          </span>
        </div>
        <div className="lang-card">
          <span className="lang-key">Glushkov states</span>
          <span className="lang-badge">
            <code>
              {report.usefulCount}/{report.stateCount}
            </code>{' '}
            useful
          </span>
        </div>
      </div>

      {/* Witnesses */}
      {report.ambWitness && report.ambWitness.runs.length >= 2 && (
        <>
          <h3 className="lang-h3">A word matched two ways</h3>
          <p className="muted-note">
            The shortest word the analyser found with more than one accepting run, with the two distinct{' '}
            <strong>position-paths</strong> through the Glushkov automaton (<code>ι</code> = start, each step labelled by
            the position it lands on). Where they diverge is exactly the choice the matcher cannot make deterministically.
          </p>
          <div className="amb-runs">
            <code className="amb-word">
              “{report.ambWitness.word}”
              {onUseText && (
                <button className="dot-btn amb-use" onClick={() => onUseText(report.ambWitness!.word)}>
                  use as test text
                </button>
              )}
            </code>
            <RunPair runs={report.ambWitness.runs} report={report} />
          </div>
        </>
      )}

      {report.eda && (
        <>
          <h3 className="lang-h3">The exponential witness (EDA)</h3>
          <p className="muted-note">
            State <code>{report.eda.pivot}</code> has <strong>two distinct cycles</strong> spelling the same pump word, so{' '}
            <code>prefix · pumpᵏ · suffix</code> has ~<code>2ᵏ</code> accepting runs — the same blow-up a backtracker
            suffers (cross-check it on the <strong>ReDoS</strong> tab).
          </p>
          <div className="amb-eda">
            <span className="amb-piece">
              <span className="amb-piece-k">prefix</span>
              <code>{report.eda.prefix || 'ε'}</code>
            </span>
            <span className="amb-piece amb-pump">
              <span className="amb-piece-k">pump</span>
              <code>{report.eda.pump}</code>
            </span>
            <span className="amb-piece">
              <span className="amb-piece-k">suffix</span>
              <code>{report.eda.suffix || 'ε'}</code>
            </span>
            {edaWord && onUseText && (
              <button className="dot-btn amb-use" onClick={() => onUseText(edaWord)}>
                load prefix·pump³·suffix
              </button>
            )}
          </div>
          {edaGrowth && (
            <div className="amb-growth">
              {edaGrowth.map((d) => (
                <span key={d.k} className="amb-growth-cell">
                  <span className="amb-growth-k">pump×{d.k}</span>
                  <span className="amb-growth-v">{d.runs} runs</span>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {!report.eda && report.ida && (
        <>
          <h3 className="lang-h3">The polynomial witness (IDA)</h3>
          <p className="muted-note">
            Distinct states <code>p={report.ida.p}</code> and <code>q={report.ida.q}</code> admit a single word{' '}
            <code>v=“{report.ida.word}”</code> with paths <code>p→p</code>, <code>p→q</code> and <code>q→q</code> all at
            once. Pumping <code>v</code> lets a run “slip” from <code>p</code> to <code>q</code> at any of n positions —
            that is the linear factor. {report.degreeKnown && report.idaChain.length > 1 && (
              <>
                The longest such chain has {report.idaChain.length} states (
                <code>{report.idaChain.join(' → ')}</code>), giving degree {report.degree}.
              </>
            )}
          </p>
        </>
      )}

      {graph && (
        <>
          <h3 className="lang-h3">The Glushkov automaton</h3>
          <p className="muted-note">
            The ε-free position automaton the analysis runs on (one state per letter occurrence, plus the start{' '}
            <code>ι</code>). Lit states are the witness: {report.eda ? 'the EDA pivot' : report.ida ? 'the IDA chain' : 'none — the machine is unambiguous'}.
          </p>
          <div className="amb-graph">
            <AutomatonGraph layout={graph} accent={isBad ? '#f87171' : isWarn ? '#fbbf24' : '#34d399'} highlight={highlight} />
          </div>
        </>
      )}

      {/* Runs vs words */}
      {counts && (
        <>
          <h3 className="lang-h3">Runs vs. words — the ambiguity gap</h3>
          <p className="muted-note">
            Counted over the pattern's <strong>{counts.atomLabels.length}</strong> symbol{' '}
            {counts.atomLabels.length === 1 ? 'atom' : 'atoms'} (<code>{counts.atomLabels.join(' · ')}</code>).{' '}
            <strong>words</strong> is the Census; <strong>runs</strong> is the total number of accepting paths;{' '}
            <strong>max</strong> is the most runs any single word of that length has — the quantity the four classes
            describe. The gap between runs and words <em>is</em> the ambiguity.
          </p>
          <div className="amb-verify">
            <span className={`lang-badge ${counts.transferOk ? 'good' : 'bad'}`}>
              {counts.transferOk ? 'runs ≡ transfer matrix e₀ᵀBⁿf ✓' : 'runs ≠ transfer matrix ✗'}
            </span>
            <span className="lang-badge good">runs ≡ brute-force enumeration ✓</span>
          </div>
          <div className="count-table census-counts">
            <table>
              <thead>
                <tr>
                  <th>n</th>
                  {counts.amb.map((_, i) => (
                    <th key={i}>{i}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>words</td>
                  {counts.words.map((c, i) => (
                    <td key={i}>{c.toString()}</td>
                  ))}
                </tr>
                <tr className="cum-row">
                  <td>runs</td>
                  {counts.runs.map((c, i) => (
                    <td key={i}>{c.toString()}</td>
                  ))}
                </tr>
                <tr>
                  <td>max</td>
                  {counts.amb.map((c, i) => (
                    <td key={i}>{c}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      <CrossCheck />
    </div>
  );
}

// Two distinct accepting runs, aligned, with the divergence point marked.
function RunPair({ runs, report }: { runs: number[][]; report: AmbiguityReport }) {
  const [r1, r2] = runs;
  let diverge = 0;
  while (diverge < r1.length && diverge < r2.length && r1[diverge] === r2[diverge]) diverge++;
  const label = (s: number) => (s === 0 ? 'ι' : `${s}:${report.positions[s]?.label() ?? ''}`);
  return (
    <div className="amb-runpair">
      {[r1, r2].map((run, ri) => (
        <div key={ri} className="amb-run">
          <span className="amb-run-k">run {ri + 1}</span>
          <span className="amb-run-seq">
            {run.map((s, i) => (
              <code key={i} className={`amb-state${i >= diverge ? ' diverge' : ''}`}>
                {label(s)}
              </code>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function CrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_AMBIGUITY_FUZZ.seed);
  const [patterns, setPatterns] = useState(DEFAULT_AMBIGUITY_FUZZ.patterns);
  const [report, setReport] = useState<AmbiguityFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      setReport(runAmbiguityFuzz({ seed: nextSeed, patterns }));
      setRunning(false);
    }, 0);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check the ambiguity analysis</h3>
      <p className="muted-note">
        A seeded fuzzer draws random regular patterns and, for each, confirms the <strong>exact</strong> total run
        count Rₙ = e₀ᵀBⁿf equals a brute-force enumeration; that an “ambiguous” witness word truly has ≥2 runs; that an
        EDA pump genuinely multiplies the run count; that <code>unambiguous</code> ⇒ runs = words; and the structural
        invariant EDA ⇒ IDA. Any disagreement is a real bug.
      </p>
      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <label className="fuzz-field">
          <span>patterns</span>
          <input
            type="number"
            min={10}
            max={1000}
            value={patterns}
            onChange={(e) => setPatterns(Math.max(10, Math.min(1000, Number(e.target.value) | 0)))}
          />
        </label>
        <button className="fuzz-run" disabled={running} onClick={() => run(seed)}>
          {running ? 'running…' : 'run'}
        </button>
        <button className="fuzz-run secondary" disabled={running} onClick={() => run((Math.random() * 2 ** 31) | 0)}>
          new seed
        </button>
      </div>

      {!report && !running && (
        <div className="placeholder">Press <strong>run</strong> to classify hundreds of random languages and verify each.</div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.failures.length === 0 ? 'ok' : 'bad'}`}>
            {report.failures.length === 0 ? (
              <>
                <span className="fuzz-big">✓ every verdict checks out</span>
                <span className="fuzz-sub">
                  {report.patternsTested.toLocaleString()} random patterns — {report.exactChecks.toLocaleString()} exact
                  Rₙ equalities and {report.witnessChecks.toLocaleString()} direct witness confirmations, all agree.{' '}
                  {report.elapsedMs} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failures.length} failure(s)</span>
                <span className="fuzz-sub">A check disagreed — the trigger pattern is below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="tested" v={report.patternsTested.toLocaleString()} />
            <St k="unambiguous" v={String(report.byClass.unambiguous ?? 0)} />
            <St k="finite" v={String(report.byClass.finite ?? 0)} />
            <St k="polynomial" v={String(report.byClass.polynomial ?? 0)} />
            <St k="exponential" v={String(report.byClass.exponential ?? 0)} />
            <St k="max degree" v={String(report.maxDegree)} />
            <St k="time" v={`${report.elapsedMs} ms`} />
          </div>
          {report.failures.length > 0 && (
            <div className="fuzz-counter">
              <h3>Failures</h3>
              {report.failures.slice(0, 8).map((f, i) => (
                <div key={i} className="fuzz-cx-row">
                  <code className="fuzz-cx-val">/{f.pattern}/</code>
                  <span className="learn-fail-reason">{f.reason}</span>
                </div>
              ))}
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
