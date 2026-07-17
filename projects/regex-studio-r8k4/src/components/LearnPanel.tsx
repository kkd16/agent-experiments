import { useMemo, useState } from 'react';
import type { DFA } from '../engine/dfa';
import { learnLStar, type LStarResult } from '../engine/learn';
import { learnKV, type KVResult, type DTSnapshotNode } from '../engine/learn-kv';
import { runLearnRace, type RaceReport } from '../engine/learn-race';
import { runScalingStudy, type ScaleStudy } from '../engine/learn-scaling';
import { rpniLearnFromTarget } from '../engine/rpni';
import { DEFAULT_LEARN_FUZZ, runLearnFuzz, type LearnFuzzReport } from '../engine/learn-verify';
import { dfaToGraph } from '../engine/graphdata';
import { layoutGraph } from '../engine/layout';
import { AutomatonGraph } from './AutomatonGraph';

// The Learn tab. Every other road in the studio starts from the regex you wrote;
// this one hides it and reconstructs the minimal DFA from queries alone. Three
// active learners share one teacher — Angluin's L* (classic and Rivest–Schapire),
// and Kearns–Vazirani's discrimination tree — plus passive RPNI from a sample.

type ActiveKey = 'classic' | 'rs' | 'kv';

const ACTIVE_TABS: { key: ActiveKey; label: string; sub: string }[] = [
  { key: 'classic', label: 'L* — classic', sub: 'table · prefixes → S' },
  { key: 'rs', label: 'L* — Rivest–Schapire', sub: 'table · one suffix → E' },
  { key: 'kv', label: 'Kearns–Vazirani', sub: 'discrimination tree' },
];

export function LearnPanel({ dfa, notice }: { dfa: DFA | null; notice: string | null }) {
  const [active, setActive] = useState<ActiveKey>('rs');

  const classic = useMemo(() => (dfa ? learnLStar(dfa, { ceHandling: 'prefixes' }) : null), [dfa]);
  const rs = useMemo(() => (dfa ? learnLStar(dfa, { ceHandling: 'rivest-schapire' }) : null), [dfa]);
  const kv = useMemo(() => (dfa ? learnKV(dfa) : null), [dfa]);
  const race = useMemo(() => (dfa ? runLearnRace(dfa) : null), [dfa]);
  const scaling = useMemo(() => runScalingStudy(), []);
  const rpni = useMemo(() => (dfa ? rpniLearnFromTarget(dfa) : null), [dfa]);

  const shownHyp = active === 'classic' ? classic?.hypothesis : active === 'rs' ? rs?.hypothesis : kv?.hypothesis;
  const learnedLayout = useMemo(
    () => (shownHyp ? layoutGraph(dfaToGraph(shownHyp)) : null),
    [shownHyp],
  );

  if (!dfa || !classic || !rs || !kv) {
    return <div className="placeholder">{notice ?? 'Fix the pattern to learn its language.'}</div>;
  }

  const alphabet = classic.alphabet;

  return (
    <div className="learn-panel">
      <div className="pane-head">
        <h2>Learn the language — no regex, only questions</h2>
        <p>
          Every other tab walks the regex you wrote down to an automaton. Here the pattern is hidden behind an{' '}
          <strong>oracle</strong>, and the learner rebuilds the minimal DFA from scratch. Three <strong>active</strong>{' '}
          learners interrogate a teacher — Angluin's <strong>L*</strong> with the classic and the{' '}
          <strong>Rivest–Schapire</strong> counterexample analysis, and <strong>Kearns–Vazirani</strong>'s{' '}
          discrimination tree — and passive <strong>RPNI</strong> is handed a labelled sample. The teacher is the studio's
          own engine: membership is a walk over the target DFA, equivalence is the product-automaton comparison from the
          Compare tab — which hands back the shortest counterexample for free.
        </p>
      </div>

      <div className="learn-alpha">
        <span className="lang-key">alphabet (atom classes)</span>
        {alphabet.length === 0 ? (
          <code className="example-chip">∅ (only ε)</code>
        ) : (
          alphabet.map((l) => (
            <code key={l.atom} className="example-chip" title={`representative '${String.fromCodePoint(l.rep)}'`}>
              {l.label}
            </code>
          ))
        )}
      </div>

      {/* ---------------- the active-learner picker ---------------- */}
      <h3 className="lang-h3">Active learning — interrogating a teacher</h3>
      <div className="learn-picker" role="tablist">
        {ACTIVE_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={active === t.key}
            className={`learn-pick ${active === t.key ? 'on' : ''}`}
            onClick={() => setActive(t.key)}
          >
            <span className="learn-pick-label">{t.label}</span>
            <span className="learn-pick-sub">{t.sub}</span>
          </button>
        ))}
      </div>

      {active === 'kv' ? (
        <KVView result={kv} layout={learnedLayout} />
      ) : (
        <LStarView result={active === 'classic' ? classic : rs} layout={learnedLayout} />
      )}

      {/* ---------------- the race ---------------- */}
      {race && <RaceBoard report={race} />}

      {/* ---------------- the scaling study ---------------- */}
      {scaling.points.length >= 2 && <ScalingSection study={scaling} />}

      {/* ---------------- RPNI (passive) ---------------- */}
      <h3 className="lang-h3">RPNI — passive learning from labelled data</h3>
      <p className="muted-note">
        No questions allowed: RPNI is handed a fixed bag of labelled strings and merges the states of their prefix-tree
        acceptor, lowest-first, accepting any merge that doesn't make a negative example accepted. A <em>complete</em>{' '}
        sample of every string up to length L is characteristic, so RPNI provably recovers the exact target — here we grow
        L until it does (or the sample gets too big).
      </p>
      {rpni && rpni.dfa ? (
        <>
          <div className="learn-verdicts">
            <span className={`lang-badge ${rpni.exact ? 'good' : 'bad'}`}>
              {rpni.exact ? `recovered the exact ${rpni.targetStates}-state target ✓` : 'sample too small to recover exactly'}
            </span>
          </div>
          <div className="fuzz-stats">
            <St k="sample depth L" v={`≤ ${rpni.maxLen}`} />
            <St k="positive examples" v={rpni.positives.toLocaleString()} />
            <St k="negative examples" v={rpni.negatives.toLocaleString()} />
            <St k="prefix-tree states" v={rpni.ptaStates.toLocaleString()} />
            <St k="after merging" v={String(rpni.learnedStates)} />
            <St k="target states" v={String(rpni.targetStates)} />
          </div>
          {!rpni.exact && rpni.witness && (
            <p className="muted-note">
              Within the length cap the inferred DFA still differs from the target — first disagreement on{' '}
              <code>"{rpni.witness}"</code>. A larger characteristic sample would close the gap (RPNI is correct in the
              limit).
            </p>
          )}
        </>
      ) : (
        <div className="learn-abort">Alphabet too large for a complete sample within the cap.</div>
      )}

      {/* ---------------- the house-style cross-check ---------------- */}
      <CrossCheck />
    </div>
  );
}

// ---- L* (classic / Rivest–Schapire) view ----------------------------------
function LStarView({ result, layout }: { result: LStarResult; layout: ReturnType<typeof layoutGraph> | null }) {
  const isRS = result.ceHandling === 'rivest-schapire';
  if (result.aborted) {
    return <div className="learn-abort">{result.log[result.log.length - 1]?.detail ?? 'Learning aborted.'}</div>;
  }
  return (
    <>
      <div className="learn-verdicts">
        <span className={`lang-badge ${result.equivalent ? 'good' : 'bad'}`}>
          {result.equivalent ? 'learned ≡ target ✓' : 'NOT equivalent ✗'}
        </span>
        <span className={`lang-badge ${result.minimal ? 'good' : 'bad'}`}>
          {result.minimal
            ? `minimal: ${result.targetStates} states ✓ (Myhill–Nerode)`
            : `not minimal (${result.canonicalStates} vs ${result.targetStates})`}
        </span>
      </div>

      <p className="muted-note">
        {isRS ? (
          <>
            <strong>Rivest–Schapire (1993).</strong> Instead of dumping every prefix of a counterexample into <em>S</em>,
            it <strong>binary-searches</strong> the counterexample for the single suffix that actually distinguishes two
            states, and adds that one experiment to <em>E</em>. The table grows by exactly one row per counterexample —
            fewer, cheaper membership queries.
          </>
        ) : (
          <>
            <strong>Classic Angluin.</strong> Every counterexample adds <em>all</em> of its prefixes to <em>S</em>, so
            the table (and its query count) can balloon on a long counterexample. Compare its membership tally with
            Rivest–Schapire's in the race below.
          </>
        )}
      </p>

      <div className="fuzz-stats">
        <St k="membership queries" v={result.membershipQueries.toLocaleString()} />
        <St k="equivalence queries" v={String(result.equivalenceQueries)} />
        <St k="conjectures" v={String(result.rounds.length)} />
        <St k="learned states (complete)" v={String(result.distinctRows)} />
        <St k="|S| access strings" v={String(result.finalS)} />
        <St k="|E| experiments" v={String(result.finalE)} />
        {isRS && <St k="suffixes from analysis" v={String(result.suffixesFromCe)} />}
        {isRS && <St k="binary-search probes" v={String(result.ceSearchProbes)} />}
      </div>

      {layout && <LearnedGraph layout={layout} targetStates={result.targetStates} />}

      {result.table && (
        <>
          <h4 className="learn-h4">The observation table at termination</h4>
          <p className="muted-note">
            Rows are access strings (top: <strong>S</strong>; bottom: the one-step boundary <strong>S·Σ</strong>), columns
            are distinguishing experiments <strong>E</strong>. A cell is <code>+</code> if <em>row·experiment</em> is in
            the language. Each <em>distinct row pattern</em> is one state of the learned DFA — the Myhill–Nerode theorem
            made tangible.
          </p>
          <div className="count-table learn-table">
            <table>
              <thead>
                <tr>
                  <th>access \ E</th>
                  {result.table.E.map((e, i) => (
                    <th key={i}>
                      <code>{e}</code>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.table.topRows.map((r, i) => (
                  <tr key={`s${i}`} className="learn-row-s">
                    <td>
                      <code>{r.access}</code>
                    </td>
                    {r.signature.split('').map((b, j) => (
                      <td key={j} className={b === '1' ? 'cell-yes' : 'cell-no'}>
                        {b === '1' ? '+' : '−'}
                      </td>
                    ))}
                  </tr>
                ))}
                {result.table.bottomRows.map((r, i) => (
                  <tr key={`b${i}`} className="learn-row-b">
                    <td>
                      <code>{r.access}</code>
                    </td>
                    {r.signature.split('').map((b, j) => (
                      <td key={j} className={b === '1' ? 'cell-yes' : 'cell-no'}>
                        {b === '1' ? '+' : '−'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Rounds rounds={result.rounds} />
          <Trace log={result.log} />
        </>
      )}
    </>
  );
}

// ---- Kearns–Vazirani view -------------------------------------------------
function KVView({ result, layout }: { result: KVResult; layout: ReturnType<typeof layoutGraph> | null }) {
  if (result.aborted) {
    return <div className="learn-abort">{result.log[result.log.length - 1]?.detail ?? 'Learning aborted.'}</div>;
  }
  return (
    <>
      <div className="learn-verdicts">
        <span className={`lang-badge ${result.equivalent ? 'good' : 'bad'}`}>
          {result.equivalent ? 'learned ≡ target ✓' : 'NOT equivalent ✗'}
        </span>
        <span className={`lang-badge ${result.minimal ? 'good' : 'bad'}`}>
          {result.minimal
            ? `minimal: ${result.targetStates} states ✓ (Myhill–Nerode)`
            : `not minimal (${result.canonicalStates} vs ${result.targetStates})`}
        </span>
      </div>

      <p className="muted-note">
        <strong>Kearns–Vazirani.</strong> No table at all — a binary <strong>discrimination tree</strong>. Every inner
        node is a distinguishing suffix; to classify a word you <em>sift</em> it from the root, asking one membership
        query per node (right on yes, left on no) until you reach a leaf = a state. A counterexample is analysed
        Rivest–Schapire style and <em>splits one leaf in two</em>, so the tree gains exactly one state per round. The tree
        depth is the worst-case number of queries to place any word — which is why KV asks so many fewer membership
        questions than a flat table.
      </p>

      <div className="fuzz-stats">
        <St k="membership queries" v={result.membershipQueries.toLocaleString()} />
        <St k="equivalence queries" v={String(result.equivalenceQueries)} />
        <St k="conjectures" v={String(result.rounds.length)} />
        <St k="states (tree leaves)" v={String(result.leaves)} />
        <St k="tree depth" v={String(result.treeDepth)} />
        <St k="binary-search probes" v={String(result.ceSearchProbes)} />
      </div>

      {layout && <LearnedGraph layout={layout} targetStates={result.targetStates} />}

      {result.tree && (
        <>
          <h4 className="learn-h4">The discrimination tree</h4>
          <p className="muted-note">
            Inner nodes (◇) are distinguishing suffixes; the two branches are the answer to "<em>is this word · suffix in
            the language?</em>" — <span className="dt-branch-key dt-no">−</span> no on the left,{' '}
            <span className="dt-branch-key dt-yes">+</span> yes on the right. Leaves (●) are the learned states, named by an
            access string and coloured by whether that state accepts.
          </p>
          <div className="dt-wrap">
            <DTView node={result.tree} />
          </div>

          <Rounds rounds={result.rounds} />
          <Trace log={result.log} />
        </>
      )}
    </>
  );
}

function DTView({ node }: { node: DTSnapshotNode }) {
  if (node.kind === 'leaf') {
    return (
      <div className={`dt-leaf ${node.accept ? 'acc' : 'rej'}`}>
        <span className="dt-dot">●</span>
        <code>{node.label}</code>
        <span className="dt-leaf-tag">{node.accept ? 'accept' : 'reject'}</span>
      </div>
    );
  }
  return (
    <div className="dt-inner">
      <div className="dt-node">
        <span className="dt-diamond">◇</span> experiment <code>{node.label}</code>
      </div>
      <div className="dt-children">
        <div className="dt-child">
          <span className="dt-branch dt-no">− no</span>
          <DTView node={node.children![0]} />
        </div>
        <div className="dt-child">
          <span className="dt-branch dt-yes">+ yes</span>
          <DTView node={node.children![1]} />
        </div>
      </div>
    </div>
  );
}

// ---- the head-to-head leaderboard -----------------------------------------
function RaceBoard({ report }: { report: RaceReport }) {
  const minMem = Math.min(...report.rows.filter((r) => !r.aborted).map((r) => r.membershipQueries));
  return (
    <>
      <h3 className="lang-h3">The race — same teacher, same target, different cost</h3>
      <p className="muted-note">
        All three active learners ask the <strong>same</strong> two questions and must converge on the studio's minimal{' '}
        <strong>{report.targetStates}-state</strong> DFA. What differs is the <strong>cost</strong>: how many membership
        queries each spends, and how many equivalence rounds it needs. The classic table pays for every counterexample
        prefix; Rivest–Schapire pays for one suffix; Kearns–Vazirani's tree sifts each word in a handful of queries — the
        textbook trade of more equivalence rounds for far fewer membership queries.
      </p>
      <div className="count-table learn-race">
        <table>
          <thead>
            <tr>
              <th>learner</th>
              <th>membership Q</th>
              <th>equivalence Q</th>
              <th>rounds</th>
              <th>states</th>
              <th>structure</th>
              <th>verdict</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <span className="race-name">{r.name}</span>
                  <span className="race-blurb">{r.blurb}</span>
                </td>
                <td className={`race-num ${r.membershipQueries === minMem && !r.aborted ? 'race-best' : ''}`}>
                  {r.membershipQueries.toLocaleString()}
                </td>
                <td className="race-num">{r.equivalenceQueries}</td>
                <td className="race-num">{r.rounds}</td>
                <td className="race-num">{r.learnedStates}</td>
                <td className="race-struct">{r.structure}</td>
                <td>
                  {r.aborted ? (
                    <span className="fuzz-pill err">aborted</span>
                  ) : (
                    <span className={`fuzz-pill ${r.equivalent && r.minimal ? 'yes' : 'no'}`}>
                      {r.equivalent && r.minimal ? 'minimal ✓' : 'wrong ✗'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted-note race-foot">
        {report.agree ? (
          <>
            All three recovered the <strong>same</strong> minimal DFA — three independent roads, one Myhill–Nerode
            machine. The lowest membership tally is highlighted.
          </>
        ) : (
          <>A learner failed to recover the minimal DFA on this language — see the cross-check console for details.</>
        )}
      </p>
    </>
  );
}

// ---- the scaling study (query cost vs an exponentially-growing target) -----
const SERIES = [
  { key: 'classic', name: 'L* classic', color: '#f0a868' },
  { key: 'rs', name: 'L* Rivest–Schapire', color: '#5cc8e6' },
  { key: 'kv', name: 'Kearns–Vazirani', color: '#c084fc' },
] as const;

function ScalingSection({ study }: { study: ScaleStudy }) {
  const pts = study.points;
  const xLabels = pts.map((p) => String(p.targetStates));
  const mem = SERIES.map((s) => ({
    ...s,
    values: pts.map((p) => (s.key === 'classic' ? p.classicMem : s.key === 'rs' ? p.rsMem : p.kvMem)),
  }));
  const eq = SERIES.map((s) => ({
    ...s,
    values: pts.map((p) => (s.key === 'classic' ? p.classicEq : s.key === 'rs' ? p.rsEq : p.kvEq)),
  }));
  return (
    <>
      <h3 className="lang-h3">Scaling — query cost as the target doubles</h3>
      <p className="muted-note">
        The same three learners on a family whose minimal DFA <strong>doubles</strong> at every step:{' '}
        <code>(a|b)*a(a|b){'{k}'}</code> — the words whose <em>(k+1)-th symbol from the end</em> is an <code>a</code>,
        with exactly <strong>2^(k+1)</strong> states. The lesson is the <strong>tradeoff</strong>, honestly: this studio's
        teacher hands back the <em>shortest</em> counterexample, the worst case for Rivest–Schapire's binary search — so
        here classic and RS spend nearly the same <strong>membership</strong> queries, while Kearns–Vazirani asks{' '}
        <strong>one equivalence query per state</strong> (2^(k+1) of them) and pays a little more membership for it. That
        is the mirror image of KV's win on typical/random languages (the aggregate table below) — <em>there is no
        universally cheapest learner</em>; it depends on the language and on which query is the expensive one.
      </p>
      <div className="learn-charts">
        <MiniLineChart title="membership queries" xLabels={xLabels} series={mem} xTitle="minimal-DFA states" />
        <MiniLineChart title="equivalence queries" xLabels={xLabels} series={eq} xTitle="minimal-DFA states" />
      </div>
      <div className="learn-legend">
        {SERIES.map((s) => (
          <span key={s.key} className="learn-legend-item">
            <span className="learn-legend-swatch" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
      {!study.ok && (
        <p className="muted-note learn-fail-reason">A learner failed to recover the minimal DFA on this family.</p>
      )}
    </>
  );
}

function MiniLineChart({
  title,
  xLabels,
  series,
  xTitle,
}: {
  title: string;
  xLabels: string[];
  series: readonly { key: string; name: string; color: string; values: number[] }[];
  xTitle: string;
}) {
  const W = 340;
  const H = 210;
  const padL = 44;
  const padR = 14;
  const padT = 26;
  const padB = 36;
  const n = xLabels.length;
  const maxY = Math.max(1, ...series.flatMap((s) => s.values));
  // A rounded, human tick ceiling.
  const niceMax = niceCeil(maxY);
  const xAt = (i: number) => padL + (n <= 1 ? 0 : (i * (W - padL - padR)) / (n - 1));
  const yAt = (v: number) => padT + (1 - v / niceMax) * (H - padT - padB);
  const ticks = 4;
  return (
    <figure className="learn-chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} vs ${xTitle}`} preserveAspectRatio="xMidYMid meet">
        {/* y gridlines + labels */}
        {Array.from({ length: ticks + 1 }, (_, t) => {
          const v = (niceMax * t) / ticks;
          const y = yAt(v);
          return (
            <g key={t}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} className="chart-grid" />
              <text x={padL - 6} y={y + 3} className="chart-ytick" textAnchor="end">
                {fmt(v)}
              </text>
            </g>
          );
        })}
        {/* x labels */}
        {xLabels.map((lab, i) => (
          <text key={i} x={xAt(i)} y={H - padB + 16} className="chart-xtick" textAnchor="middle">
            {lab}
          </text>
        ))}
        <text x={(padL + W - padR) / 2} y={H - 4} className="chart-axis-title" textAnchor="middle">
          {xTitle}
        </text>
        {/* series */}
        {series.map((s) => (
          <g key={s.key}>
            <polyline
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              points={s.values.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ')}
            />
            {s.values.map((v, i) => (
              <circle key={i} cx={xAt(i)} cy={yAt(v)} r={2.6} fill={s.color} />
            ))}
            {/* end-label */}
            <text
              x={xAt(n - 1) - 2}
              y={yAt(s.values[n - 1]) - 5}
              className="chart-endlab"
              fill={s.color}
              textAnchor="end"
            >
              {s.values[n - 1]}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  );
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}
function fmt(v: number): string {
  if (v >= 1000) return `${Math.round(v / 100) / 10}k`;
  return String(Math.round(v));
}

function LearnedGraph({ layout, targetStates }: { layout: ReturnType<typeof layoutGraph>; targetStates: number }) {
  return (
    <div className="graph-pane learn-graph">
      <div className="pane-head graph-head">
        <div>
          <h2>The reconstructed DFA</h2>
          <p>
            Built only from yes/no answers — never from the regex. It includes the explicit reject sink the minimiser
            usually drops; minimise it and you land on the studio's own {targetStates}-state canonical machine.
          </p>
        </div>
      </div>
      <AutomatonGraph layout={layout} accent="#c084fc" />
    </div>
  );
}

function Rounds({ rounds }: { rounds: LStarResult['rounds'] }) {
  return (
    <>
      <h4 className="learn-h4">Conjectures &amp; counterexamples</h4>
      <div className="learn-rounds">
        {rounds.map((r, i) => (
          <div key={i} className="learn-round">
            <span className="learn-round-n">#{i + 1}</span>
            <span className="learn-round-body">
              conjectured a <strong>{r.hypStates}</strong>-state DFA after {r.membershipSoFar.toLocaleString()} membership
              queries —{' '}
              {r.counterexample === null ? (
                <span className="learn-accept">accepted ✓</span>
              ) : (
                <>
                  rejected, counterexample <code className="learn-cx">"{r.counterexample}"</code>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function Trace({ log }: { log: LStarResult['log'] }) {
  return (
    <details className="learn-trace-wrap">
      <summary>full trace ({log.length} events)</summary>
      <ol className="learn-trace">
        {log.map((e, i) => (
          <li key={i} className={`learn-ev learn-ev-${e.kind}`}>
            <span className="learn-ev-kind">{e.kind}</span> {e.detail}
          </li>
        ))}
      </ol>
    </details>
  );
}

function CrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_LEARN_FUZZ.seed);
  const [patterns, setPatterns] = useState(DEFAULT_LEARN_FUZZ.patterns);
  const [report, setReport] = useState<LearnFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      const r = runLearnFuzz({ seed: nextSeed, patterns, runRpni: true });
      setReport(r);
      setRunning(false);
    }, 0);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check the learners</h3>
      <p className="muted-note">
        A seeded fuzzer draws random regular patterns, compiles each to its minimal DFA, and confirms that{' '}
        <strong>all three active learners</strong> — classic L*, Rivest–Schapire L*, and Kearns–Vazirani — reconstruct a
        DFA that is <strong>equivalent</strong> to the target <strong>and</strong> has exactly the same number of states
        (the studio's own minimal DFA, not just <em>some</em> equivalent machine), that they <strong>agree with one
        another</strong>, and that RPNI recovers it from a complete sample. Any disagreement is a real bug, reported with
        the pattern.
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
        <div className="placeholder">Press <strong>run</strong> to learn hundreds of random languages and verify each.</div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.failures.length === 0 ? 'ok' : 'bad'}`}>
            {report.failures.length === 0 ? (
              <>
                <span className="fuzz-big">✓ every language learned correctly</span>
                <span className="fuzz-sub">
                  {report.patternsTested.toLocaleString()} random patterns × 3 active learners — each recovered the exact
                  minimal DFA and all agreed; RPNI recovered {report.rpniRecovered}/{report.rpniAttempted}.{' '}
                  {report.elapsedMs} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failures.length} failure(s)</span>
                <span className="fuzz-sub">A learner produced a wrong automaton — the trigger pattern is below.</span>
              </>
            )}
          </div>

          <h4 className="learn-h4">Membership queries spent, summed over every learned language</h4>
          <p className="muted-note">
            The same {report.patternsTested.toLocaleString()} languages, three ways. Fewer is better — this is the
            query-complexity claim, measured.
          </p>
          <div className="learn-race learn-race-agg">
            <table>
              <thead>
                <tr>
                  <th>learner</th>
                  <th>membership Q</th>
                  <th>vs classic</th>
                  <th>equivalence Q</th>
                  <th>recovered</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>L* — classic</td>
                  <td className="race-num">{report.classicMembership.toLocaleString()}</td>
                  <td className="race-num">—</td>
                  <td className="race-num">{report.classicEquiv.toLocaleString()}</td>
                  <td className="race-num">{report.patternsTested}/{report.patternsTested}</td>
                </tr>
                <tr>
                  <td>L* — Rivest–Schapire</td>
                  <td className="race-num race-best">{report.rsMembership.toLocaleString()}</td>
                  <td className="race-num">{pct(report.rsMembership, report.classicMembership)}</td>
                  <td className="race-num">{report.rsEquiv.toLocaleString()}</td>
                  <td className="race-num">{report.rsRecovered}/{report.patternsTested}</td>
                </tr>
                <tr>
                  <td>Kearns–Vazirani</td>
                  <td className="race-num race-best">{report.kvMembership.toLocaleString()}</td>
                  <td className="race-num">{pct(report.kvMembership, report.classicMembership)}</td>
                  <td className="race-num">{report.kvEquiv.toLocaleString()}</td>
                  <td className="race-num">{report.kvRecovered}/{report.patternsTested}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="fuzz-stats">
            <St k="patterns" v={report.patternsTested.toLocaleString()} />
            <St k="max DFA states" v={String(report.maxStates)} />
            <St k="max membership Q" v={report.maxMembership.toLocaleString()} />
            <St k="max equivalence Q" v={String(report.maxEquivalence)} />
            <St k="RPNI recovered" v={`${report.rpniRecovered}/${report.rpniAttempted}`} />
            <St k="time" v={`${report.elapsedMs} ms`} />
            <St k="seed" v={String(report.config.seed)} />
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

function pct(part: number, whole: number): string {
  if (whole <= 0) return '—';
  const saved = Math.round((1 - part / whole) * 100);
  return saved >= 0 ? `−${saved}%` : `+${-saved}%`;
}

function St({ k, v }: { k: string; v: string }) {
  return (
    <div className="fuzz-stat">
      <span className="fuzz-stat-v">{v}</span>
      <span className="fuzz-stat-k">{k}</span>
    </div>
  );
}
