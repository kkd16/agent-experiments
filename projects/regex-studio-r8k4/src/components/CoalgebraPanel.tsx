import { useMemo, useState } from 'react';
import { compile } from '../engine/compile';
import { compareDFAs, type Relation as DfaRelation } from '../engine/equivalence';
import { runEquivalence, type EquivReport, type EquivResult } from '../engine/coalgebra';
import { relationByAntichains, decideUniversality } from '../engine/antichain';
import { DEFAULT_VERIFY, runCoalgebraVerify, type VerifyReport } from '../engine/coalgebra-verify';

interface Props {
  patternA: string;
  other: string;
  onOtherChange: (s: string) => void;
  onUsePair: (a: string, b: string) => void;
  noticeA: string | null;
}

// Curated pairs that show the technique off — equivalent-but-different languages,
// and a determinisation bomb where naïve Hopcroft–Karp explodes but congruence
// collapses it. (A, B, blurb.)
const PRESETS: { a: string; b: string; label: string }[] = [
  {
    a: '(a|b)*(a(a|b){6}|b(a|b){6})',
    b: '(a|b)*(a|b){7}',
    label: 'determinisation bomb — equal, 2⁸-state DFA, but congruence needs ~27 pairs (≈9× over naïve, and it doubles with each extra repeat)',
  },
  { a: '(a|b)*', b: '(a*b*)*', label: 'two faces of Σ* — equal, but the proof differs' },
  { a: '(ab)*', b: 'a(ba)*b|', label: '(ab)* vs a(ba)*b ∪ ε — equal' },
  { a: 'a*', b: 'a*a*', label: 'a* vs a*a* — equal (idempotent)' },
  { a: '[a-z]+', b: '[a-z][a-z]*', label: '+ vs ·* — equal' },
  { a: '(a|b)*abb', b: '(a|b)*abb(a|b)*', label: 'subset — left ⊂ right' },
  { a: 'a(a|b)*', b: 'b(a|b)*', label: 'disjoint — they share nothing' },
  { a: '.*', b: 'a*', label: 'universal vs a* — superset, with a witness' },
];

const REL_TEXT: Record<DfaRelation, { title: string; symbol: string; blurb: string }> = {
  equal: { title: 'Equivalent', symbol: 'A = B', blurb: 'Both patterns accept exactly the same language.' },
  subset: { title: 'A ⊂ B', symbol: 'A ⊂ B', blurb: 'Every string A matches, B matches — but not the reverse.' },
  superset: { title: 'A ⊃ B', symbol: 'A ⊃ B', blurb: 'Every string B matches, A matches — but not the reverse.' },
  disjoint: { title: 'Disjoint', symbol: 'A ∩ B = ∅', blurb: 'No string is matched by both patterns.' },
  overlap: { title: 'Overlapping', symbol: 'A ∩ B ≠ ∅', blurb: 'They share strings, yet each also matches what the other rejects.' },
};

export function CoalgebraPanel({ patternA, other, onOtherChange, onUsePair, noticeA }: Props) {
  const compiledA = useMemo(() => compile(patternA), [patternA]);
  const compiledB = useMemo(() => compile(other), [other]);
  const nfaA = compiledA.nfa;
  const nfaB = compiledB.nfa;
  const dfaA = compiledA.minDfa;
  const dfaB = compiledB.minDfa;

  const data = useMemo(() => {
    if (!nfaA || !nfaB || !dfaA || !dfaB) return null;
    const equiv = runEquivalence(nfaA, nfaB);
    const rel = relationByAntichains(nfaA, nfaB);
    const oracle = compareDFAs(dfaA, dfaB);
    const uniA = decideUniversality(nfaA);
    const uniB = decideUniversality(nfaB);
    // Triple agreement: the three roads to the verdict all concur.
    const acEqual = rel.relation === 'equal';
    const roadsAgree =
      equiv.hkc.equivalent === acEqual && (oracle.relation === 'equal') === acEqual && rel.relation === oracle.relation;
    return { equiv, rel, oracle, uniA, uniB, roadsAgree };
  }, [nfaA, nfaB, dfaA, dfaB]);

  return (
    <div className="coalg-panel">
      <div className="pane-head">
        <h2>Coalgebra &amp; antichains — equivalence without determinising</h2>
        <p>
          The <strong>Compare</strong> tab decides equivalence by walking the product of the two <em>minimal DFAs</em> —
          it pays for determinisation (worst-case exponential) up front. Here are the two modern roads that skip it:
          language equivalence by <strong>bisimulation up to congruence</strong> (Bonchi&nbsp;&amp;&nbsp;Pous,
          POPL&nbsp;2013) and inclusion/universality by <strong>antichains</strong>
          (De&nbsp;Wulf&nbsp;et&nbsp;al., CAV&nbsp;2006) — both run straight on the ε-NFAs, and both are cross-checked
          against the DFA-product road.
        </p>
      </div>

      <label className="field-label" htmlFor="coalg-b">
        compare against pattern B
      </label>
      <div className={`pattern-box${compiledB.error ? ' has-error' : ''}`}>
        <span className="slash">/</span>
        <input
          id="coalg-b"
          className="pattern-input"
          value={other}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onOtherChange(e.target.value)}
          placeholder="a second regex…"
        />
        <span className="slash">/</span>
      </div>

      <div className="coalg-presets">
        {PRESETS.map((p) => (
          <button key={p.a + p.b} className="coalg-preset" title={p.label} onClick={() => onUsePair(p.a, p.b)}>
            <code>/{p.a}/</code> <span className="coalg-vs">vs</span> <code>/{p.b || 'ε'}/</code>
          </button>
        ))}
      </div>

      {!dfaA && <div className="placeholder">{noticeA ?? 'Pattern A needs a valid regular pattern.'}</div>}
      {dfaA && compiledB.error && (
        <div className="parse-error static">
          Pattern B: {compiledB.error.message} (at index {compiledB.error.index})
        </div>
      )}
      {dfaA && !compiledB.error && !dfaB && (
        <div className="placeholder">
          Pattern B uses non-regular features{compiledB.features ? ` (${compiledB.features.reasons.join(', ')})` : ''} —
          these roads need finite automata.
        </div>
      )}

      {data && (
        <>
          {/* ---- the verdict, three roads agreeing ---- */}
          <div className={`coalg-verdict rel-${data.rel.relation}`}>
            <span className="coalg-symbol">{REL_TEXT[data.rel.relation].symbol}</span>
            <div className="coalg-verdict-text">
              <strong>{REL_TEXT[data.rel.relation].title}</strong>
              <p>{REL_TEXT[data.rel.relation].blurb}</p>
            </div>
            <span className={`coalg-agree ${data.roadsAgree ? 'good' : 'bad'}`}>
              {data.roadsAgree
                ? '✓ HKC · antichains · DFA-product all agree'
                : '✗ roads disagree — this should never happen'}
            </span>
          </div>

          {/* ---- the headline: the up-to closure's pay-off ---- */}
          <h3 className="lang-h3">Bisimulation up to congruence — the pay-off</h3>
          <p className="muted-note">
            All three explore the <em>same</em> determinised powerset lazily; they differ only in how aggressively they
            discharge a new pair as already-implied. Naïve skips an <em>identical</em> pair; <strong>up-to-equivalence</strong>{' '}
            skips one in the equivalence closure of what's proved; <strong>up-to-congruence</strong> also closes under
            union — the strongest, and it shows in how few pairs it must expand.
          </p>
          <ModeBars equiv={data.equiv} />

          {/* ---- the relation R that HKC built ---- */}
          {data.equiv.hkc.equivalent && data.equiv.hkc.relationPairs.length > 0 && (
            <RelationView equiv={data.equiv} />
          )}

          {/* ---- witnesses ---- */}
          <h3 className="lang-h3">Distinguishing words</h3>
          <p className="muted-note">
            When the languages differ, each road returns a concrete <em>witness</em> — the shortest string proving it.
          </p>
          <div className="coalg-witness-grid">
            <WitnessCard label="in A but not B" display={data.rel.inAnotB?.display ?? null} />
            <WitnessCard label="in B but not A" display={data.rel.inBnotA?.display ?? null} />
            <WitnessCard label="in both (A ∩ B)" display={data.rel.inBoth?.display ?? null} />
          </div>

          {/* ---- antichain inclusion stats ---- */}
          <h3 className="lang-h3">Inclusion by antichains</h3>
          <p className="muted-note">
            Each direction searches for a word in one language but not the other over macrostates <code>(q, S)</code>,
            keeping only the ⊑-minimal frontier. The antichain is what determinise-and-complement would have built in
            full.
          </p>
          <div className="coalg-incl">
            <InclusionRow
              label="L(A) ⊆ L(B)"
              included={data.rel.aSubB.included}
              explored={data.rel.aSubB.explored}
              antichain={data.rel.aSubB.antichainSize}
              naive={data.rel.aSubB.naiveExplored}
            />
            <InclusionRow
              label="L(B) ⊆ L(A)"
              included={data.rel.bSubA.included}
              explored={data.rel.bSubA.explored}
              antichain={data.rel.bSubA.antichainSize}
              naive={data.rel.bSubA.naiveExplored}
            />
          </div>

          {/* ---- universality ---- */}
          <h3 className="lang-h3">Universality — is L = Σ* over its own alphabet?</h3>
          <div className="coalg-uni">
            <UniBadge label="A" universal={data.uniA.universal} display={data.uniA.witness?.display ?? null} explored={data.uniA.explored} />
            <UniBadge label="B" universal={data.uniB.universal} display={data.uniB.witness?.display ?? null} explored={data.uniB.explored} />
          </div>
        </>
      )}

      <CrossCheck />
    </div>
  );
}

// --- The three-mode bar chart ----------------------------------------------

function ModeBars({ equiv }: { equiv: EquivReport }) {
  const rows: { name: string; r: EquivResult; tip: string }[] = [
    { name: 'naïve HK', r: equiv.naive, tip: 'skip only an identical pair already processed' },
    { name: 'up-to-equivalence', r: equiv.hk, tip: 'skip pairs in the equivalence closure of R' },
    { name: 'up-to-congruence (HKC)', r: equiv.hkc, tip: 'skip pairs in the congruence closure of R (closed under ∪)' },
  ];
  const max = Math.max(1, ...rows.map((row) => row.r.processed + row.r.skipped));
  const naive = Math.max(1, equiv.naive.processed);
  return (
    <div className="coalg-bars">
      {rows.map((row) => {
        const win = naive / Math.max(1, row.r.processed);
        return (
          <div className="coalg-bar-row" key={row.name} title={row.tip}>
            <span className="coalg-bar-name">{row.name}</span>
            <div className="coalg-bar-track">
              <div className="coalg-bar-proc" style={{ width: `${(row.r.processed / max) * 100}%` }}>
                <span className="coalg-bar-num">{row.r.processed}</span>
              </div>
              <div className="coalg-bar-skip" style={{ width: `${(row.r.skipped / max) * 100}%` }} />
            </div>
            <span className="coalg-bar-win">{row.r.budgetHit ? 'budget hit' : `${win.toFixed(2)}×`}</span>
          </div>
        );
      })}
      <div className="coalg-bar-legend">
        <span><i className="swatch proc" /> pairs expanded</span>
        <span><i className="swatch skip" /> pairs discharged by the up-to closure</span>
        <span className="muted-note">× = naïve ÷ this mode's expansions · {equiv.atomCount} alphabet classes</span>
      </div>
    </div>
  );
}

// --- The bisimulation relation R --------------------------------------------

function RelationView({ equiv }: { equiv: EquivReport }) {
  const [open, setOpen] = useState(false);
  const pairs = equiv.hkc.relationPairs;
  const fmt = (ids: number[], isB: boolean) =>
    '{' + ids.map((i) => (isB ? i - equiv.offsetB : i)).join(',') + '}';
  return (
    <div className="coalg-relation">
      <button className="coalg-rel-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} the bisimulation up to congruence R — {pairs.length} pair{pairs.length === 1 ? '' : 's'}{' '}
        proves equivalence
      </button>
      {open && (
        <div className="coalg-rel-body">
          <p className="muted-note">
            Each row is a pair of subsets <code>(X, Y)</code> the algorithm related — X of A's NFA states, Y of B's.
            Every other reachable pair was discharged for free by the congruence closure of these.
          </p>
          <table className="coalg-rel-table">
            <thead>
              <tr>
                <th>#</th>
                <th>X (A-states)</th>
                <th>Y (B-states)</th>
                <th>accepts?</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((p, i) => (
                <tr key={i}>
                  <td className="coalg-rel-idx">{i}</td>
                  <td><code>{fmt(p.x, false)}</code></td>
                  <td><code>{fmt(p.y, true)}</code></td>
                  <td>{p.accept ? '✓' : '·'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WitnessCard({ label, display }: { label: string; display: string | null }) {
  return (
    <div className="witness-card">
      <span className="witness-label">{label}</span>
      {display ? <code className="witness-text">{display}</code> : <span className="witness-none">— none —</span>}
    </div>
  );
}

function InclusionRow({
  label,
  included,
  explored,
  antichain,
  naive,
}: {
  label: string;
  included: boolean;
  explored: number;
  antichain: number;
  naive: number | null;
}) {
  const win = naive != null && explored > 0 ? naive / explored : null;
  return (
    <div className="coalg-incl-row">
      <span className="coalg-incl-label"><code>{label}</code></span>
      <span className={`lang-badge ${included ? 'good' : 'bad'}`}>{included ? 'holds ✓' : 'fails ✗'}</span>
      <span className="coalg-incl-stat">{explored} macrostates · antichain ≤ {antichain}</span>
      {win != null && <span className="coalg-incl-win">vs {naive} full → {win.toFixed(1)}×</span>}
    </div>
  );
}

function UniBadge({
  label,
  universal,
  display,
  explored,
}: {
  label: string;
  universal: boolean;
  display: string | null;
  explored: number;
}) {
  return (
    <div className="coalg-uni-card">
      <span className="coalg-uni-key">{label}</span>
      <span className={`lang-badge ${universal ? 'good' : 'bad'}`}>{universal ? 'universal — accepts every string ✓' : 'not universal'}</span>
      {!universal && display && (
        <span className="coalg-uni-cx">
          rejects <code className="witness-text">{display}</code>
        </span>
      )}
      <span className="muted-note">{explored} macrostates</span>
    </div>
  );
}

// --- The differential cross-check (thousands of random pairs) ----------------

function CrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_VERIFY.seed);
  const [pairs, setPairs] = useState(DEFAULT_VERIFY.pairs);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      const r = runCoalgebraVerify({ seed: nextSeed, pairs });
      setReport(r);
      setRunning(false);
    }, 0);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check both roads against the DFA product</h3>
      <p className="muted-note">
        A seeded fuzzer draws random pattern <strong>pairs</strong> and confirms, from independent code paths, that the
        three HKC modes agree with each other and with <code>compareDFAs</code> on equivalence; that the antichain
        inclusion reconstructs the same five-way relation; that antichain universality matches the DFA oracle; and that
        HKC never expands more pairs than naïve. Any mismatch is a real bug, reported with the pair.
      </p>
      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <label className="fuzz-field">
          <span>pairs</span>
          <input
            type="number"
            min={50}
            max={20000}
            value={pairs}
            onChange={(e) => setPairs(Math.max(50, Math.min(20000, Number(e.target.value) | 0)))}
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
        <div className="placeholder">Press <strong>run</strong> to decide thousands of random pairs three ways and verify each.</div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.ok ? 'ok' : 'bad'}`}>
            {report.ok ? (
              <>
                <span className="fuzz-big">✓ every pair decided identically by all three roads</span>
                <span className="fuzz-sub">
                  {report.pairs.toLocaleString()} regular pairs · {report.equivalenceChecks.toLocaleString()} equivalence
                  + {report.relationChecks.toLocaleString()} relation + {report.universalityChecks.toLocaleString()}{' '}
                  universality checks. {report.elapsedMs} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.mismatches.length} mismatch(es)</span>
                <span className="fuzz-sub">A road disagreed — the trigger pair is below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="pairs" v={report.pairs.toLocaleString()} />
            <St k="Σ naïve expansions" v={report.totalNaive.toLocaleString()} />
            <St k="Σ up-to-equiv" v={report.totalHk.toLocaleString()} />
            <St k="Σ congruence" v={report.totalHkc.toLocaleString()} />
            <St k="best congruence win" v={`${report.bestRatio.toFixed(2)}×`} />
            <St k="time" v={`${report.elapsedMs} ms`} />
            <St k="seed" v={String(report.config.seed)} />
          </div>
          {report.bestRatioPattern && (
            <p className="muted-note">
              biggest win this run: <code>/{report.bestRatioPattern.a}/</code> vs{' '}
              <code>/{report.bestRatioPattern.b || 'ε'}/</code> — naïve expanded{' '}
              <strong>{report.bestRatioPattern.naive}</strong> pairs, congruence only{' '}
              <strong>{report.bestRatioPattern.hkc}</strong>.
            </p>
          )}
          {report.mismatches.length > 0 && (
            <div className="fuzz-counter">
              <h3>Mismatches</h3>
              {report.mismatches.slice(0, 8).map((m, i) => (
                <div key={i} className="fuzz-cx-row">
                  <code className="fuzz-cx-val">/{m.patternA}/ vs /{m.patternB || 'ε'}/</code>
                  <span className="learn-fail-reason">{m.detail}</span>
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
