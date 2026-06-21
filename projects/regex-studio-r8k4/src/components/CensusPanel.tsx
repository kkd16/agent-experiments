import { useMemo, useState } from 'react';
import type { DFA } from '../engine/dfa';
import { analyzeCensus, type GrowthClass } from '../engine/census';
import { DEFAULT_CENSUS_FUZZ, runCensusFuzz, type CensusFuzzReport } from '../engine/census-verify';

const MAX_LEN = 14;

const GROWTH_LABEL: Record<GrowthClass, string> = {
  empty: 'empty ∅',
  finite: 'finite',
  polynomial: 'polynomial density',
  exponential: 'exponential density',
};

const GROWTH_BLURB: Record<GrowthClass, string> = {
  empty: 'No words at all.',
  finite: 'Only finitely many words — every loop on a live path is broken.',
  polynomial:
    'Sub-exponentially many words: every cycle in the automaton is a simple loop (no state sits on two distinct cycles), so the count grows like a polynomial. The Perron root is exactly 1.',
  exponential:
    'Exponentially many words: some strongly-connected component branches (a state lies on two distinct cycles), so the count grows like λⁿ for the Perron root λ > 1. ln λ is the language’s topological entropy.',
};

export function CensusPanel({ dfa, notice }: { dfa: DFA | null; notice: string | null }) {
  const info = useMemo(() => (dfa ? analyzeCensus(dfa, { maxLen: MAX_LEN }) : null), [dfa]);

  if (!dfa || !info) {
    return <div className="placeholder">{notice ?? 'Fix the pattern to count its language.'}</div>;
  }

  const verified = info.gfMatchesCounts && info.bruteMatches;

  return (
    <div className="census-panel">
      <div className="pane-head">
        <h2>Census — how many words, and how fast they grow</h2>
        <p>
          A regular language has a <strong>rational generating function</strong>{' '}
          <code>S(x) = Σ sₙxⁿ = P(x)/Q(x)</code> (Chomsky–Schützenberger). Everything here is read off the minimal
          DFA’s <strong>transfer matrix</strong> <code>M</code> (where <code>M[i][j]</code> counts the symbols taking
          state <code>i</code> to <code>j</code>): the exact counts <code>sₙ = uᵀMⁿv</code>, the closed-form generating
          function, and the growth rate <code>λ = limₙ sₙ^(1/n)</code> — the Perron root of <code>M</code>.
        </p>
      </div>

      <div className="lang-grid">
        <div className="lang-card">
          <span className="lang-key">growth</span>
          <span className={`lang-badge ${info.growth === 'exponential' ? 'bad' : 'good'}`}>
            {GROWTH_LABEL[info.growth]}
          </span>
        </div>
        <div className="lang-card">
          <span className="lang-key">growth rate λ</span>
          <span className="lang-badge">
            <code>{info.growth === 'finite' || info.growth === 'empty' ? '—' : info.lambda.toFixed(6)}</code>
          </span>
        </div>
        <div className="lang-card">
          <span className="lang-key">entropy ln λ</span>
          <span className="lang-badge">
            <code>{info.entropy > 0 ? info.entropy.toFixed(6) : '0'}</code>
          </span>
        </div>
        <div className="lang-card">
          <span className="lang-key">size</span>
          <span className="lang-badge">
            {info.finite
              ? info.totalIfFinite != null
                ? `finite (${info.totalIfFinite.toLocaleString()})`
                : 'finite'
              : 'infinite ∞'}
          </span>
        </div>
      </div>

      <p className="muted-note">{GROWTH_BLURB[info.growth]}</p>

      <h3 className="lang-h3">The generating function</h3>
      <p className="muted-note">
        Computed exactly: <code>Q(x) = det(I − xM)</code> from the characteristic polynomial of <code>M</code>
        (Faddeev–LeVerrier), and the numerator from the first counts. The denominator’s coefficients are the linear
        recurrence the counts obey (Cayley–Hamilton).
      </p>
      <div className="census-gf">
        <span className="census-gf-label">S(x) =</span>
        <span className="census-frac">
          <span className="census-num">{info.gf.numeratorStr}</span>
          <span className="census-den">{info.gf.denominatorStr}</span>
        </span>
      </div>
      {info.gf.recurrence.length > 0 && info.growth !== 'finite' && info.growth !== 'empty' && (
        <p className="muted-note census-rec">
          recurrence:&nbsp;
          <code>
            sₙ = {info.gf.recurrence.map((c, i) => `${c >= 0n ? (i === 0 ? '' : '+ ') : '− '}${(c < 0n ? -c : c).toString()}·sₙ₋${i + 1}`).join(' ')}
          </code>
        </p>
      )}

      <div className="census-verify">
        <span className={`lang-badge ${info.gfMatchesCounts ? 'good' : 'bad'}`}>
          {info.gfMatchesCounts ? `P/Q series ≡ counts ✓ (${info.verifyTerms} terms)` : 'GF ≠ counts ✗'}
        </span>
        <span className={`lang-badge ${info.bruteMatches ? 'good' : 'bad'}`}>
          {info.bruteMatches ? 'counts ≡ brute-force enumeration ✓' : 'counts ≠ brute force ✗'}
        </span>
        {verified && <span className="muted-note">— three independent counts agree</span>}
      </div>

      <h3 className="lang-h3">Exact word counts by length</h3>
      <p className="muted-note">
        <strong>structural</strong>: each atomic character class counts as one letter (the combinatorial skeleton).
        {info.weightedDiffers && (
          <>
            {' '}
            <strong>Unicode</strong>: each class weighted by how many code points it holds (the true number of strings).
          </>
        )}
      </p>
      <div className="count-table census-counts">
        <table>
          <thead>
            <tr>
              <th>n</th>
              {info.countsStructural.map((_, i) => (
                <th key={i}>{i}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>structural</td>
              {info.countsStructural.map((c, i) => (
                <td key={i}>{c.toLocaleString()}</td>
              ))}
            </tr>
            {info.weightedDiffers && (
              <tr className="cum-row">
                <td>Unicode</td>
                {info.countsWeighted.map((c, i) => (
                  <td key={i}>{c.toLocaleString()}</td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <CrossCheck />
    </div>
  );
}

function CrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_CENSUS_FUZZ.seed);
  const [patterns, setPatterns] = useState(DEFAULT_CENSUS_FUZZ.patterns);
  const [report, setReport] = useState<CensusFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      setReport(runCensusFuzz({ seed: nextSeed, patterns }));
      setRunning(false);
    }, 0);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check the census</h3>
      <p className="muted-note">
        A seeded fuzzer draws random regular patterns and confirms, for each, that the generating function’s series
        reproduces the transfer-matrix counts <em>and</em> that those match a brute-force enumeration — and that the
        structural growth class agrees with the empirical count ratio. Any disagreement is a real bug.
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
            max={2000}
            value={patterns}
            onChange={(e) => setPatterns(Math.max(10, Math.min(2000, Number(e.target.value) | 0)))}
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
        <div className="placeholder">Press <strong>run</strong> to count hundreds of random languages and verify each.</div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.failures.length === 0 ? 'ok' : 'bad'}`}>
            {report.failures.length === 0 ? (
              <>
                <span className="fuzz-big">✓ every census checks out</span>
                <span className="fuzz-sub">
                  {report.patternsTested.toLocaleString()} random patterns — generating function, transfer matrix and
                  brute force all agree. {report.elapsedMs} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failures.length} failure(s)</span>
                <span className="fuzz-sub">A count disagreed — the trigger pattern is below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="patterns" v={report.patternsTested.toLocaleString()} />
            <St k="finite" v={String(report.byClass.finite ?? 0)} />
            <St k="polynomial" v={String(report.byClass.polynomial ?? 0)} />
            <St k="exponential" v={String(report.byClass.exponential ?? 0)} />
            <St k="max λ" v={report.maxLambda.toFixed(3)} />
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
