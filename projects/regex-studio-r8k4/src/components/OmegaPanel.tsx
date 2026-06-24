import { useEffect, useMemo, useRef, useState } from 'react';
import { compileOmega, type Lasso } from '../engine/omega';
import { nbaToGraph, gbaToGraph, nbaAcceptsLasso } from '../engine/omega/nba';
import { satisfiesLasso, sampleLassos, lassoToString } from '../engine/omega/semantics';
import { runOmegaFuzz, DEFAULT_OMEGA_FUZZ, type OmegaFuzzReport } from '../engine/omega/verify';
import { layoutGraph } from '../engine/layout';
import { toDot, toSvg } from '../engine/export';
import { AutomatonGraph } from './AutomatonGraph';

interface Example {
  name: string;
  src: string;
  note: string;
}

const EXAMPLES: Example[] = [
  { name: 'infinitely often a', src: 'G F a', note: '□◇a — the canonical Büchi shape. The accepting state must recur forever; (b)ᵒ fails, (a)ᵒ and (ab)ᵒ pass.' },
  { name: 'eventually always a', src: 'F G a', note: '◇□a — a tail of pure a. Satisfiable but not valid; its automaton needs a "committed" accepting sink.' },
  { name: 'a until b', src: 'a U b', note: 'a holds at every step until a b occurs — and a b must eventually occur (the Until eventuality = an accepting set).' },
  { name: 'request → response', src: 'G (a -> F b)', note: '□(a → ◇b) — every request a is eventually answered by a b. The classic liveness spec.' },
  { name: 'no two a’s in a row', src: 'G (a -> X ~a)', note: 'Whenever a occurs the next letter is not a — a pure safety property (no accepting eventuality).' },
  { name: 'a and b alternate forever', src: 'G ((a -> X b) & (b -> X a))', note: 'Forces the ω-word into (ab)ᵒ or (ba)ᵒ.' },
  { name: 'strong vs weak next at the end', src: 'F G (a & X a)', note: 'X is the strong next on infinite words — there is always a next position, so X a never "falls off the end".' },
  { name: 'UNSATISFIABLE: □a ∧ ◇¬a', src: 'G a & F ~a', note: 'Always a, yet eventually not-a — a contradiction. The NBA is empty: no lasso, no model.' },
  { name: 'VALID: a ∨ ¬a', src: 'a | ~a', note: 'True at every position of every word — NBA(¬φ) is empty, so φ is valid (an ω-tautology).' },
  { name: 'fair: GF a ∧ GF b', src: 'G F a & G F b', note: 'Both letters occur infinitely often — a generalized-Büchi condition with TWO accepting sets, degeneralized into one.' },
];

const ACCENT = '#22d3ee';
const ACCENT2 = '#a78bfa';

export function OmegaPanel({ source, onSourceChange }: { source: string; onSourceChange: (s: string) => void }) {
  const [alphabetStr, setAlphabetStr] = useState('a,b');
  const alphabet = useMemo(() => {
    const xs = alphabetStr.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
    return [...new Set(xs)];
  }, [alphabetStr]);

  const compiled = useMemo(
    () => (alphabet.length > 0 ? compileOmega(source, alphabet) : null),
    [source, alphabet],
  );

  const nbaLayout = useMemo(() => (compiled?.nba ? layoutGraph(nbaToGraph(compiled.nba)) : null), [compiled]);
  const gbaLayout = useMemo(() => (compiled?.gba ? layoutGraph(gbaToGraph(compiled.gba)) : null), [compiled]);

  // truth table — oracle vs NBA over a spread of short lassos
  const truth = useMemo(() => {
    if (!compiled?.nba || !compiled.ltl) return null;
    const ws = sampleLassos(alphabet, 30);
    let agree = true;
    const rows = ws.map((w) => {
      const oracle = satisfiesLasso(compiled.ltl!, w);
      const auto = nbaAcceptsLasso(compiled.nba!, w.u, w.v);
      if (oracle !== auto) agree = false;
      return { label: lassoToString(w), oracle, auto };
    });
    return { rows, agree };
  }, [compiled, alphabet]);

  return (
    <div className="omega-panel deriv-panel">
      <div className="pane-head">
        <h2>LTL ⇒ Büchi — crossing into the infinite</h2>
        <p>
          The whole studio so far lives on <strong>finite</strong> words. This tab crosses into the{' '}
          <strong>ω-regular</strong> world — infinite traces, model checking, the{' '}
          <strong>automata-theoretic approach</strong> (Vardi–Wolper). Write a{' '}
          <strong>linear-temporal-logic</strong> spec and watch the <strong>Büchi automaton</strong> it denotes get
          built by the classic <strong>Gerth–Peled–Vardi–Wolper</strong> on-the-fly tableau, then decided the only
          way ω-words allow: a <em>reachable accepting cycle</em>, whose witness is a <strong>lasso</strong>{' '}
          <code>u·(v)ᵒ</code>. It is the infinite-word sibling of the Logic tab — <code>LTL = FO[&lt;]</code> (Kamp)
          and ω-regular <code>= S1S</code> (Büchi), one level up.
        </p>
      </div>

      <div className="logic-modes">
        <label className="logic-alpha">
          <span>Σ =</span>
          <input value={alphabetStr} spellCheck={false} onChange={(e) => setAlphabetStr(e.target.value)} />
        </label>
        <span className="muted-note omega-opnote">
          operators: <code>X F G</code> · <code>U R W M</code> · <code>~ &amp; | -&gt; &lt;-&gt;</code> · a proposition is a letter of Σ
        </span>
      </div>

      <div className={`pattern-box logic-input${compiled?.error ? ' has-error' : ''}`}>
        <input
          className="pattern-input"
          value={source}
          spellCheck={false}
          autoComplete="off"
          placeholder="G F a"
          onChange={(e) => onSourceChange(e.target.value)}
        />
      </div>

      {compiled?.error && (
        <div className="parse-error logic-err">
          <span className="err-msg">
            {compiled.error.message} (at index {compiled.error.index})
          </span>
        </div>
      )}
      {compiled?.buildError && !compiled.error && (
        <div className="logic-buildwarn">
          <strong>Could not build the automaton:</strong> {compiled.buildError}. LTL → Büchi is worst-case
          exponential; try a smaller formula.
        </div>
      )}
      {compiled && compiled.offAlphabet.length > 0 && !compiled.error && (
        <p className="muted-note omega-warn">
          note: <code>{compiled.offAlphabet.join(', ')}</code>{' '}
          {compiled.offAlphabet.length === 1 ? 'is' : 'are'} not in Σ, so that proposition can never hold — add it
          to Σ above if you meant it as a letter.
        </p>
      )}

      {compiled && !compiled.error && !compiled.buildError && compiled.ltl && (
        <>
          {/* the verdict */}
          <Verdict compiled={compiled} alphabet={alphabet} />

          {/* the lasso witness */}
          {compiled.sat?.satisfiable && compiled.sat.witness && compiled.nba && (
            <LassoView
              key={compiled.sat.witness.stem.join('') + '|' + compiled.sat.witness.loop.join('')}
              lasso={compiled.sat.witness}
              layout={nbaLayout}
            />
          )}

          {/* the automata */}
          {nbaLayout && compiled.nba && (
            <GraphCard
              title="The Büchi automaton (NBA) — degeneralized"
              blurb="A single accepting set (double ring). Accepted iff some run visits an accepting state infinitely often; an edge is labelled by the letter it consumes. ι marks the initial state(s)."
              layout={nbaLayout}
              dotInput={() => toDot(nbaToGraph(compiled.nba!), 'NBA')}
              accent={ACCENT}
              name="buchi-nba"
            />
          )}
          {gbaLayout && compiled.gba && compiled.trace && compiled.trace.acceptSets > 1 && (
            <GraphCard
              title={`The generalized Büchi automaton (GBA) — ${compiled.trace.acceptSets} accepting sets`}
              blurb="Straight off the GPVW tableau, before degeneralization: one accepting set per Until-subformula, each to be visited infinitely often. The double ring marks states in EVERY set."
              layout={gbaLayout}
              dotInput={() => toDot(gbaToGraph(compiled.gba!), 'GBA')}
              accent={ACCENT2}
              name="buchi-gba"
            />
          )}

          {/* construction trace */}
          {compiled.trace && (
            <>
              <h3 className="lang-h3">Construction — the tableau, then the counter</h3>
              <div className="omega-trace">
                <TraceCell k="NNF closure" v={compiled.trace.closure} note="distinct subformulas" />
                <TraceCell k="GBA states" v={compiled.trace.gbaStates} note="GPVW tableau nodes" />
                <TraceCell k="accepting sets" v={compiled.trace.acceptSets} note="one per Until (= k)" />
                <TraceCell k="NBA states" v={compiled.trace.nbaStates} note="after degeneralizing ×k" />
              </div>
              {compiled.coreText && (
                <p className="muted-note">
                  negation-normal form: <code className="logic-fo">{compiled.coreText}</code>
                </p>
              )}
            </>
          )}

          {/* truth table */}
          {truth && (
            <>
              <h3 className="lang-h3">Truth table — the oracle vs the Büchi automaton</h3>
              <p className="muted-note">
                A spread of ultimately-periodic words <code>u·(v)ᵒ</code>, each decided two independent ways: the
                brute-force LTL semantics (fixpoints over the lasso's positions) and a product run of the compiled
                NBA. They must agree on every lasso.
              </p>
              <div className={`graph-badge ${truth.agree ? 'ok' : 'bad'}`}>
                {truth.agree ? 'oracle ≡ automaton on every sampled lasso ✓' : 'DISAGREEMENT — a construction bug'}
              </div>
              <div className="logic-truth omega-truth">
                {truth.rows.map((r) => (
                  <span key={r.label} className={`logic-cell ${r.auto ? 'acc' : 'rej'}`} title={r.auto ? 'in L(φ)' : 'rejected'}>
                    {r.label}
                  </span>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* examples */}
      <h3 className="lang-h3">Examples</h3>
      <ul className="logic-examples">
        {EXAMPLES.map((ex) => (
          <li key={ex.name}>
            <button className="example" onClick={() => onSourceChange(ex.src)} title={ex.note}>
              <span className="ex-name">{ex.name}</span>
              <code className="ex-pat">{ex.src}</code>
            </button>
          </li>
        ))}
      </ul>

      <CrossCheck />
    </div>
  );
}

function Verdict({ compiled, alphabet }: { compiled: NonNullable<ReturnType<typeof compileOmega>>; alphabet: string[] }) {
  const sat = compiled.sat;
  const valid = compiled.valid;
  return (
    <div className="omega-verdict-row">
      <div className={`omega-verdict ${sat?.satisfiable ? 'good' : 'bad'}`}>
        <span className="omega-verdict-k">satisfiable?</span>
        <span className="omega-verdict-v">
          {sat?.satisfiable ? 'SAT — a model exists' : 'UNSAT — no ω-word satisfies it'}
        </span>
        <span className="omega-verdict-sub">
          {sat?.satisfiable ? 'L(NBA(φ)) ≠ ∅ — a reachable accepting cycle' : 'L(NBA(φ)) = ∅ — no accepting cycle'}
        </span>
      </div>
      <div className={`omega-verdict ${valid ? (valid.valid ? 'good' : 'warn') : 'muted'}`}>
        <span className="omega-verdict-k">valid?</span>
        <span className="omega-verdict-v">
          {!valid ? '— (¬φ too large)' : valid.valid ? 'VALID — an ω-tautology' : 'not valid — a counterexample exists'}
        </span>
        <span className="omega-verdict-sub">
          {!valid ? 'the negation blew up' : valid.valid ? 'L(NBA(¬φ)) = ∅' : 'a word makes φ fail (below)'}
        </span>
      </div>
      <div className="omega-verdict muted">
        <span className="omega-verdict-k">Σ</span>
        <span className="omega-verdict-v">{'{' + alphabet.join(', ') + '}'}</span>
        <span className="omega-verdict-sub">one letter per position</span>
      </div>
    </div>
  );
}

function LassoView({ lasso, layout }: { lasso: Lasso; layout: ReturnType<typeof layoutGraph> | null }) {
  // the run: stem states (ending just before the loop anchor), then the loop cycle
  const stemPrefix = lasso.stemStates.slice(0, -1);
  const loopCycle = lasso.loopStates;
  const runStates = [...stemPrefix, ...loopCycle];
  const runLetters = [...lasso.stem, ...lasso.loop];
  const period = loopCycle.length;
  const stemLen = stemPrefix.length;

  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => setStep((s) => s + 1), 650);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [playing]);

  // active index into the *unrolled* run: stem positions, then loop positions cycling
  const activeIdx = step < stemLen ? step : stemLen + ((step - stemLen) % period);
  const activeState = runStates[activeIdx];
  const highlight = new Set<number>([activeState]);

  return (
    <div className="omega-lasso">
      <div className="omega-lasso-head">
        <h3>Model lasso — <code>{lassoToString({ u: lasso.stem, v: lasso.loop })}</code></h3>
        <div className="omega-lasso-ctl">
          <button onClick={() => setStep((s) => Math.max(0, s - 1))}>◀</button>
          <button onClick={() => setPlaying((p) => !p)}>{playing ? '⏸ pause' : '▶ play'}</button>
          <button onClick={() => setStep((s) => s + 1)}>▶</button>
          <button onClick={() => { setStep(0); setPlaying(false); }}>⟲</button>
        </div>
      </div>
      <p className="muted-note">
        An ultimately-periodic witness: read the stem <strong>u</strong> once, then repeat the loop{' '}
        <strong>v</strong> forever. The accepting state on the loop is visited infinitely often — that is exactly
        Büchi acceptance. Step through the run; the lit state is where the automaton sits.
      </p>
      <div className="omega-ribbon">
        {runLetters.map((c, i) => (
          <span
            key={i}
            className={`omega-letter${i < stemLen ? ' stem' : ' loop'}${i === activeIdx ? ' active' : ''}`}
            title={i < stemLen ? 'stem u' : 'loop v (repeats)'}
          >
            {c}
          </span>
        ))}
        <span className="omega-letter loopmark" title="…and the loop repeats forever">(v)ᵒ ↻</span>
      </div>
      {layout && (
        <div className="graph-pane omega-lasso-graph">
          <AutomatonGraph layout={layout} accent={ACCENT} highlight={highlight} />
        </div>
      )}
    </div>
  );
}

function GraphCard({
  title,
  blurb,
  layout,
  dotInput,
  accent,
  name,
}: {
  title: string;
  blurb: string;
  layout: ReturnType<typeof layoutGraph>;
  dotInput: () => string;
  accent: string;
  name: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyDot = () => {
    try { navigator.clipboard?.writeText(dotInput()); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* sandbox */ }
  };
  const downloadSvg = () => {
    try {
      const blob = new Blob([toSvg(layout, { accent })], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${name}.svg`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { /* sandbox */ }
  };
  return (
    <div className="graph-pane omega-graph">
      <div className="pane-head graph-head">
        <div>
          <h3>{title}</h3>
          <p>{blurb}</p>
        </div>
        <div className="graph-head-btns">
          <button className="dot-btn" onClick={downloadSvg}>download SVG</button>
          <button className="dot-btn" onClick={copyDot}>{copied ? 'copied ✓' : 'copy DOT'}</button>
        </div>
      </div>
      <AutomatonGraph layout={layout} accent={accent} />
    </div>
  );
}

function TraceCell({ k, v, note }: { k: string; v: number; note: string }) {
  return (
    <div className="omega-trace-cell">
      <span className="omega-trace-v">{v}</span>
      <span className="omega-trace-k">{k}</span>
      <span className="omega-trace-note">{note}</span>
    </div>
  );
}

function CrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_OMEGA_FUZZ.seed);
  const [trials, setTrials] = useState(DEFAULT_OMEGA_FUZZ.trials);
  const [report, setReport] = useState<OmegaFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      setReport(runOmegaFuzz({ ...DEFAULT_OMEGA_FUZZ, seed: nextSeed, trials }));
      setRunning(false);
    }, 10);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check the construction</h3>
      <p className="muted-note">
        A seeded fuzzer draws random LTL formulas, builds each one's NBA, and on a batch of random lassos{' '}
        <code>u·(v)ᵒ</code> checks (1) the automaton's acceptance against the brute-force oracle, and (2) the deep{' '}
        <strong>complement-duality</strong> — for every lasso EXACTLY ONE of NBA(φ), NBA(¬φ) accepts (the two
        ω-languages partition Σᵒ, so this tests Büchi closure under complement). Any disagreement is a real bug.
      </p>
      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <label className="fuzz-field">
          <span>formulas</span>
          <input
            type="number"
            min={10}
            max={400}
            value={trials}
            onChange={(e) => setTrials(Math.max(10, Math.min(400, Number(e.target.value) | 0)))}
          />
        </label>
        <button className="fuzz-run" disabled={running} onClick={() => run(seed)}>{running ? 'running…' : 'run'}</button>
        <button className="fuzz-run secondary" disabled={running} onClick={() => run((Math.random() * 2 ** 31) | 0)}>new seed</button>
      </div>

      {!report && !running && (
        <div className="placeholder">Press <strong>run</strong> to build hundreds of random Büchi automata and verify each against the oracle and its own complement.</div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.ok ? 'ok' : 'bad'}`}>
            {report.ok ? (
              <>
                <span className="fuzz-big">✓ every formula's automaton is correct</span>
                <span className="fuzz-sub">
                  {report.trials} LTL formulas — {report.membershipChecks.toLocaleString()} oracle checks +{' '}
                  {report.dualityChecks.toLocaleString()} complement-duality checks, all agree.{' '}
                  {report.skipped > 0 ? `${report.skipped} skipped (state-cap blow-up). ` : ''}
                  {report.elapsedMs.toFixed(0)} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failure?.kind} mismatch</span>
                <span className="fuzz-sub">A compiled automaton disagreed — see below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="formulas" v={String(report.trials)} />
            <St k="oracle" v={report.membershipChecks.toLocaleString()} />
            <St k="duality" v={report.dualityChecks.toLocaleString()} />
            <St k="skipped" v={String(report.skipped)} />
            <St k="time" v={`${report.elapsedMs.toFixed(0)} ms`} />
          </div>
          {report.failure && (
            <div className="fuzz-counter">
              <h3>Counterexample</h3>
              <div className="fuzz-cx-row">
                <code className="fuzz-cx-val">{report.failure.formula}</code>
                <span className="learn-fail-reason">{report.failure.detail}</span>
              </div>
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
