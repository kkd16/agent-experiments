import { useMemo, useState } from 'react';
import { compilePresburger, PRESBURGER_EXAMPLES } from '../engine/presburger';
import { acceptsTuple, enumerateSolutions, presburgerDfaToGraph, lowerSingleTrackToDFA } from '../engine/presburger/automata';
import { evalFormula } from '../engine/presburger/semantics';
import { runPresburgerFuzz, DEFAULT_PRESBURGER_FUZZ, type PresburgerFuzzReport } from '../engine/presburger/verify';
import { layoutGraph } from '../engine/layout';
import { minimizeDFA } from '../engine/minimize';
import { dfaToRegex } from '../engine/synthesize';
import { toDot, toSvg } from '../engine/export';
import { AutomatonGraph } from './AutomatonGraph';

const ACCENT = '#38bdf8';

// Choose a box radius N so the tuple grid stays small: (N+1)^k ≲ 64.
function boxRadius(k: number): number {
  if (k <= 0) return 0;
  if (k === 1) return 24;
  if (k === 2) return 7;
  return 3;
}

export function PresburgerPanel({
  source,
  onSourceChange,
}: {
  source: string;
  onSourceChange: (s: string) => void;
}) {
  const compiled = useMemo(() => compilePresburger(source), [source]);

  const graph = useMemo(() => {
    if (!compiled.automaton) return null;
    return presburgerDfaToGraph(compiled.automaton);
  }, [compiled]);
  const layout = useMemo(() => (graph ? layoutGraph(graph) : null), [graph]);

  // The tuple grid: every tuple in a box, the automaton's verdict, and — when
  // the formula is quantifier-free — the exact arithmetic oracle beside it.
  const grid = useMemo(() => {
    if (!compiled.automaton || !compiled.formula || compiled.sentence) return null;
    const vars = compiled.free;
    const N = boxRadius(vars.length);
    const rows: { label: string; auto: boolean; oracle: boolean | null }[] = [];
    const odo = new Array<number>(vars.length).fill(0);
    let agree = true;
    let count = 0;
    for (;;) {
      const env: Record<string, number> = {};
      for (let i = 0; i < vars.length; i++) env[vars[i]] = odo[i];
      const auto = acceptsTuple(compiled.automaton, env);
      const oracle = compiled.quantifierFree ? evalFormula(compiled.formula, env, 0) : null;
      if (oracle !== null && oracle !== auto) agree = false;
      rows.push({ label: vars.map((v) => `${v}=${env[v]}`).join(' '), auto, oracle });
      count++;
      if (count > 200) break;
      let i = 0;
      for (; i < vars.length; i++) {
        odo[i]++;
        if (odo[i] <= N) break;
        odo[i] = 0;
      }
      if (i === vars.length) break;
    }
    return { rows, agree, N, vars };
  }, [compiled]);

  const solutions = useMemo(() => {
    if (!compiled.automaton || compiled.sentence || compiled.free.length === 0) return null;
    return enumerateSolutions(compiled.automaton, { maxValue: 64, limit: 24 });
  }, [compiled]);

  // For a one-variable formula: lower to the studio DFA over {0,1} and read the
  // set of binary encodings back as a regular expression (DFA→regex).
  const numberRegex = useMemo(() => {
    if (!compiled.automaton || compiled.free.length !== 1) return null;
    try {
      const dfa = minimizeDFA(lowerSingleTrackToDFA(compiled.automaton));
      const syn = dfaToRegex(dfa);
      return { regex: syn.regex, empty: syn.empty, variable: compiled.free[0] };
    } catch {
      return null;
    }
  }, [compiled]);

  return (
    <div className="logic-panel deriv-panel">
      <div className="pane-head">
        <h2>Presburger ⇒ Automaton — arithmetic as a machine</h2>
        <p>
          The <strong>Logic</strong> tab compiled a <em>string</em> logic into an automaton over word positions.
          This one compiles <em>number theory</em>. By <strong>Büchi–Bruyère–Villemaire</strong> the first-order
          theory of <code>⟨ℕ, +, &lt;⟩</code> is decidable because every formula translates to a finite automaton over
          the <strong>binary digits</strong> of its variables — one <em>track</em> per variable, read
          least-significant-digit first. Write a linear-arithmetic formula and watch its automaton get{' '}
          <em>built</em>: <code>+</code> becomes a ripple-carry adder, <code>∃</code> becomes projection, and a whole{' '}
          <em>sentence</em> collapses to a single <strong>true / false</strong> — Presburger's decision procedure,
          live.
        </p>
      </div>

      <div className={`pattern-box logic-input${compiled.error ? ' has-error' : ''}`}>
        <input
          className="pattern-input"
          value={source}
          spellCheck={false}
          autoComplete="off"
          placeholder="exists y. x = y + y"
          onChange={(e) => onSourceChange(e.target.value)}
        />
      </div>

      <p className="muted-note">
        Terms are linear: <code>2*x + 3*y − 1</code> (or <code>2x</code>). Atoms: <code>t = t</code>{' '}
        <code>t &lt; t</code> <code>t &lt;= t</code> <code>t &gt; t</code> <code>t &gt;= t</code> <code>t != t</code>,
        and congruences <code>t = r (mod m)</code>. Connectives <code>~ &amp; | -&gt; &lt;-&gt;</code>; quantifiers{' '}
        <code>exists x.</code> <code>forall x.</code> over ℕ. Unicode <code>∃ ∀ ¬ ∧ ∨ → ↔ ≤ ≥ ≠ ≡</code> all work.
      </p>

      {compiled.error && (
        <div className="parse-error logic-err">
          <span className="err-msg">
            {compiled.error.message} (at index {compiled.error.index})
          </span>
        </div>
      )}
      {compiled.buildError && !compiled.error && (
        <div className="logic-buildwarn">
          <strong>Could not build the automaton:</strong> {compiled.buildError}.{' '}
          {compiled.buildError.includes('blew up') && (
            <>Presburger's automata can grow fast — large coefficients or moduli mean many carry / residue states. Try smaller numbers.</>
          )}
        </div>
      )}

      {!compiled.error && (
        <div className="logic-status">
          <span className={`lang-badge ${compiled.sentence ? 'good' : ''}`}>
            {compiled.sentence ? 'sentence (closed)' : `free: ${compiled.free.join(', ')}`}
          </span>
          <span className={`lang-badge ${compiled.quantifierFree ? 'good' : ''}`}>
            {compiled.quantifierFree ? 'quantifier-free' : 'quantified'}
          </span>
          {compiled.automaton && <span className="lang-badge">automaton: {compiled.automaton.n} states</span>}
          {compiled.maxStates > (compiled.automaton?.n ?? 0) && (
            <span className="lang-badge" title="largest intermediate machine before minimisation">
              blow-up high-water: {compiled.maxStates}
            </span>
          )}
          {compiled.formulaText && (
            <span className="lang-badge" title="the parsed, canonicalised formula">
              <code className="logic-fo">{compiled.formulaText}</code>
            </span>
          )}
        </div>
      )}

      {/* the sentence verdict */}
      {compiled.sentence && compiled.sentenceValue !== null && (
        <div className={`pres-verdict ${compiled.sentenceValue ? 'yes' : 'no'}`}>
          <span className="pres-verdict-big">{compiled.sentenceValue ? 'TRUE over ℕ' : 'FALSE over ℕ'}</span>
          <span className="pres-verdict-sub">
            A Presburger <em>sentence</em> has no free variables, so its automaton is over the empty alphabet — it
            either accepts (the statement holds for the naturals) or is empty (it does not). <strong>Decided</strong>{' '}
            by the automaton, not asserted.
          </span>
        </div>
      )}

      {/* the automaton */}
      {layout && graph && (
        <div className="graph-pane logic-graph">
          <div className="pane-head graph-head">
            <div>
              <h3>The digit automaton — over {'{0,1}'}<sup>{compiled.free.length || 0}</sup></h3>
              <p>
                {compiled.free.length === 0
                  ? 'A sentence leaves an automaton over a single (empty) column — its non-emptiness is the truth value.'
                  : 'Each edge is a digit column read least-significant-first; the label shows each variable’s current bit (e.g. x1 y0). A run spells the binary encodings of a satisfying tuple.'}
              </p>
            </div>
            <div className="graph-head-btns">
              <button className="dot-btn" onClick={() => downloadSvg(layout, 'presburger-automaton')}>
                download SVG
              </button>
              <button className="dot-btn" onClick={() => copyText(toDot(graph, 'presburger'))}>
                copy DOT
              </button>
            </div>
          </div>
          <AutomatonGraph layout={layout} accent={ACCENT} />
        </div>
      )}

      {/* solutions decoded from the automaton */}
      {solutions && solutions.rows.length > 0 && (
        <>
          <h3 className="lang-h3">Solutions — decoded straight from the automaton</h3>
          <p className="muted-note">
            The smallest tuples <code>({compiled.free.join(', ')})</code> the automaton accepts (values ≤ 64). This is
            the automaton <em>read back</em> — the tuples whose binary encodings it spells — not a separate search.
          </p>
          <div className="pres-solutions">
            {solutions.rows.map((r, i) => (
              <code key={i} className="pres-sol">
                ({r.tuple.join(', ')})
              </code>
            ))}
            {solutions.truncated && <span className="pres-sol more">…</span>}
          </div>
        </>
      )}
      {solutions && solutions.rows.length === 0 && (
        <p className="muted-note">The automaton accepts <strong>no</strong> tuples in range — the relation is empty (unsatisfiable).</p>
      )}

      {/* a one-variable number set, read back as a regex */}
      {numberRegex && !numberRegex.empty && (
        <>
          <h3 className="lang-h3">The number set, read back as a regular expression</h3>
          <p className="muted-note">
            Lowered into the studio's <em>own</em> DFA over <code>{'{0,1}'}</code> and run through DFA→regex (state
            elimination): the set of <strong>least-significant-digit-first</strong> binary encodings of{' '}
            <code>{'{'} {numberRegex.variable} : φ {'}'}</code>. This closes the loop with the studio's very first
            example — “binary multiples of three” — now <em>derived</em> from the arithmetic instead of hand-written.
          </p>
          <div className="pres-regex">
            <code>{numberRegex.regex}</code>
          </div>
        </>
      )}

      {/* the tuple grid: automaton vs the exact oracle */}
      {grid && grid.rows.length > 0 && (
        <>
          <h3 className="lang-h3">
            {compiled.quantifierFree ? 'The oracle vs the compiled automaton' : 'The relation, tuple by tuple'}
          </h3>
          <p className="muted-note">
            {compiled.quantifierFree ? (
              <>
                Every tuple in <code>[0,{grid.N}]</code> evaluated two independent ways — the arithmetic oracle
                (integers, computed directly) and a run of the compiled digit-automaton. For a quantifier-free formula
                the oracle is <strong>exact</strong>, so they must agree everywhere.
              </>
            ) : (
              <>
                Every tuple in <code>[0,{grid.N}]</code>, coloured by the compiled automaton's verdict. (The direct
                oracle is only exact without quantifiers, so it is omitted here; the automaton is the decision
                procedure.)
              </>
            )}
          </p>
          {compiled.quantifierFree && (
            <div className={`graph-badge ${grid.agree ? 'ok' : 'bad'}`}>
              {grid.agree ? 'oracle ≡ automaton on every tuple ✓' : 'DISAGREEMENT — a compiler bug'}
            </div>
          )}
          <div className="logic-truth">
            {grid.rows.map((r, i) => (
              <span key={i} className={`logic-cell ${r.auto ? 'acc' : 'rej'}`} title={r.auto ? 'satisfies' : 'does not satisfy'}>
                {r.label}
              </span>
            ))}
          </div>
        </>
      )}

      {/* the construction trace */}
      {compiled.trace.length > 0 && (
        <>
          <h3 className="lang-h3">Construction trace — watch the state count</h3>
          <p className="muted-note">
            Each connective and quantifier in post-order, with the resulting machine's size after minimisation (and,
            for a quantifier, the determinisation blow-up <em>before</em> it).
          </p>
          <div className="logic-trace">
            {compiled.trace.map((s, i) => (
              <div key={i} className="logic-trace-row">
                <code className="logic-op">{s.op}</code>
                <span className="logic-trace-detail">{s.detail}</span>
                <span className="logic-trace-size">
                  {s.raw && s.raw !== s.states ? (
                    <>
                      <span className="logic-raw">{s.raw}</span> → {s.states}
                    </>
                  ) : (
                    s.states
                  )}{' '}
                  states
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* examples */}
      <h3 className="lang-h3">Examples</h3>
      <ul className="logic-examples">
        {PRESBURGER_EXAMPLES.map((ex) => (
          <li key={ex.name}>
            <button className="example" onClick={() => onSourceChange(ex.src)} title={ex.note}>
              <span className="ex-name">{ex.name}</span>
              <code className="ex-pat">{ex.src.length > 64 ? ex.src.slice(0, 64) + '…' : ex.src}</code>
            </button>
          </li>
        ))}
      </ul>

      <CrossCheck />
    </div>
  );
}

function copyText(text: string) {
  try {
    navigator.clipboard?.writeText(text);
  } catch {
    /* sandbox */
  }
}

function downloadSvg(layout: ReturnType<typeof layoutGraph>, name: string) {
  try {
    const blob = new Blob([toSvg(layout, { accent: ACCENT })], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* sandbox */
  }
}

function CrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_PRESBURGER_FUZZ.seed);
  const [trials, setTrials] = useState(DEFAULT_PRESBURGER_FUZZ.trials);
  const [report, setReport] = useState<PresburgerFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      setReport(runPresburgerFuzz({ ...DEFAULT_PRESBURGER_FUZZ, seed: nextSeed, trials }));
      setRunning(false);
    }, 10);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check the compiler</h3>
      <p className="muted-note">
        A seeded fuzzer draws random linear-arithmetic formulas and checks the compiler four <strong>exact</strong>{' '}
        ways: a quantifier-free automaton must match the arithmetic oracle on every tuple in a box; <code>∀x.φ</code>{' '}
        and <code>¬∃x¬φ</code> must compile to the <em>same language</em>; every oracle witness must be accepted by
        the projected <code>∃x.φ</code>; and a battery of textbook Presburger identities must hold. Any disagreement is
        a real bug.
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
            max={500}
            value={trials}
            onChange={(e) => setTrials(Math.max(10, Math.min(500, Number(e.target.value) | 0)))}
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
        <div className="placeholder">Press <strong>run</strong> to compile hundreds of random formulas and verify each against the oracle and its own algebra.</div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.ok ? 'ok' : 'bad'}`}>
            {report.ok ? (
              <>
                <span className="fuzz-big">✓ every formula compiles correctly</span>
                <span className="fuzz-sub">
                  {report.trials} formulas — {report.membershipChecks.toLocaleString()} exact oracle checks,{' '}
                  {report.dualityChecks.toLocaleString()} ∀≡¬∃¬ duality checks, {report.witnessChecks.toLocaleString()}{' '}
                  witness checks, {report.identityChecks} identity checks, all agree. {report.elapsedMs.toFixed(0)} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failure?.kind} mismatch</span>
                <span className="fuzz-sub">A compiled automaton disagreed with the ground truth — see below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="formulas" v={String(report.trials)} />
            <St k="oracle" v={report.membershipChecks.toLocaleString()} />
            <St k="duality" v={report.dualityChecks.toLocaleString()} />
            <St k="witness" v={report.witnessChecks.toLocaleString()} />
            <St k="identity" v={String(report.identityChecks)} />
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
