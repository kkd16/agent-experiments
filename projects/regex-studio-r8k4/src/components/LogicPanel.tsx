import { useMemo, useState } from 'react';
import { compileLogic, acceptsLoweredDFA, type LogicMode } from '../engine/logic';
import { languageUpTo } from '../engine/logic/semantics';
import { bitDfaToGraph } from '../engine/logic/lower';
import { runLogicFuzz, DEFAULT_LOGIC_FUZZ, type LogicFuzzReport } from '../engine/logic/verify';
import { dfaToGraph } from '../engine/graphdata';
import { layoutGraph } from '../engine/layout';
import { toDot, toSvg } from '../engine/export';
import { AutomatonGraph } from './AutomatonGraph';
import { analyzeCensus } from '../engine/census';
import { analyzeLanguage } from '../engine/language';
import { buildSyntacticMonoid, greenRelations, monoidProperties } from '../engine/monoid';
import { varietyLadder } from '../engine/variety';

interface Example {
  name: string;
  src: string;
  note: string;
}

const MSO_EXAMPLES: Example[] = [
  { name: 'contains an a', src: 'exists x. Qa(x)', note: 'The simplest existential — some position carries an a.' },
  {
    name: 'every a is immediately followed by a b',
    src: 'forall x. (Qa(x) -> exists y. (S(x,y) & Qb(y)))',
    note: 'Successor S(x,y) and a guarded existential — first-order, so the language is star-free.',
  },
  {
    name: 'a∗b∗ — no b before an a',
    src: 'forall x. forall y. ((x < y & Qb(x)) -> Qb(y))',
    note: 'Two universal variables. Star-free (piecewise-testable, in fact).',
  },
  {
    name: 'some a strictly before some b',
    src: 'exists x. exists y. (x < y & Qa(x) & Qb(y))',
    note: 'The order relation < relates two existentials.',
  },
  {
    name: 'the first letter is an a',
    src: 'exists x. ((~ exists w. w < x) & Qa(x))',
    note: '"first(x)" is defined as ¬∃w. w<x — there is no logical constant for it.',
  },
  {
    name: 'EVEN LENGTH (genuinely second-order)',
    src:
      'exists X. ( (forall x. ((~ exists w. w < x) -> ~ x in X)) & (forall x. forall y. (S(x,y) -> (x in X <-> ~ y in X))) & (forall x. ((~ exists z. x < z) -> x in X)) )',
    note: 'A set X that toggles along successor and must contain the last position. Needs a SECOND-ORDER quantifier — and comes back NOT star-free: the group ℤ/2. This is FO ⊊ MSO, shown.',
  },
];

const LTLF_EXAMPLES: Example[] = [
  { name: 'eventually a b', src: 'F b', note: '◇b — some position from now on is a b.' },
  { name: 'globally: a → next b', src: 'G (a -> X b)', note: '□(a → ◯b). Every a has a b right after it (strong next, so a final a fails).' },
  { name: 'a until b', src: 'a U b', note: 'a holds at every step until a b occurs (and a b must occur).' },
  { name: 'globally a', src: 'G a', note: '□a — every position is an a.' },
  { name: 'a, and eventually b', src: 'a & F b', note: 'Starts with a and a b appears somewhere.' },
  { name: 'no two a’s in a row', src: 'G (a -> X (~a))', note: 'Whenever an a occurs, the next letter (if any) is not an a.' },
];

const ACCENT = '#a78bfa';

export function LogicPanel({
  source,
  onSourceChange,
  mode,
  onModeChange,
}: {
  source: string;
  onSourceChange: (s: string) => void;
  mode: LogicMode;
  onModeChange: (m: LogicMode) => void;
}) {
  const [alphabetStr, setAlphabetStr] = useState('a,b');
  const alphabet = useMemo(() => {
    const xs = alphabetStr
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return [...new Set(xs)];
  }, [alphabetStr]);

  const compiled = useMemo(
    () => (alphabet.length > 0 ? compileLogic(source, alphabet, mode) : null),
    [source, alphabet, mode],
  );

  const variety = useMemo(() => {
    if (!compiled?.dfa) return null;
    try {
      const m = buildSyntacticMonoid(compiled.dfa);
      if (m.truncated) return null;
      const green = greenRelations(m);
      const props = green ? monoidProperties(m, green) : null;
      const ladder = green && props ? varietyLadder(m, green, props) : null;
      return ladder && props ? { ladder, props } : null;
    } catch {
      return null;
    }
  }, [compiled]);

  const census = useMemo(() => (compiled?.dfa ? analyzeCensus(compiled.dfa, { maxLen: 12 }) : null), [compiled]);
  const lang = useMemo(() => (compiled?.dfa ? analyzeLanguage(compiled.dfa, { maxLen: 12, examples: 8 }) : null), [compiled]);

  // Truth table: oracle vs lowered DFA over short words.
  const truth = useMemo(() => {
    if (!compiled?.dfa || !compiled.formula) return null;
    const sigma = alphabet.length;
    let maxLen = 5;
    while (maxLen > 1 && (Math.pow(sigma, maxLen + 1) - 1) / (sigma - 1 || 1) > 90) maxLen--;
    const words = languageUpTo(compiled.formula, alphabet, maxLen);
    let agree = true;
    const rows = words.map((w) => {
      const auto = acceptsLoweredDFA(compiled.dfa!, w.indices, alphabet);
      if (auto !== w.accept) agree = false;
      return { word: w.word, oracle: w.accept, auto };
    });
    return { rows, agree, maxLen };
  }, [compiled, alphabet]);

  const examples = mode === 'mso' ? MSO_EXAMPLES : LTLF_EXAMPLES;

  const graph = useMemo(() => {
    if (!compiled) return null;
    if (compiled.dfa) return { input: dfaToGraph(compiled.dfa), sentence: true };
    if (compiled.bit) return { input: bitDfaToGraph(compiled.bit, alphabet), sentence: false };
    return null;
  }, [compiled, alphabet]);
  const layout = useMemo(() => (graph ? layoutGraph(graph.input) : null), [graph]);

  const starFreeExpected = compiled?.firstOrder ?? false;
  const isStarFree = variety?.props.aperiodic ?? false;

  return (
    <div className="logic-panel deriv-panel">
      <div className="pane-head">
        <h2>Logic ⇒ Automaton — the converse of the whole studio</h2>
        <p>
          Every other tab compiles a <em>regex</em> down to an automaton. This one runs the opposite direction —
          the <strong>Büchi–Elgot–Trakhtenbrot theorem</strong>: a language is regular <strong>iff</strong> it is
          defined by a sentence of <strong>monadic second-order logic</strong> <code>MSO[&lt;]</code> over word
          positions. Write a formula and watch the automaton get <em>built</em>, atom by atom, by structural
          recursion (∧ = product, ¬ = complement, ∃ = projection + determinisation). By{' '}
          <strong>McNaughton–Papert</strong> a <em>first-order</em> formula must compile to a{' '}
          <strong>star-free</strong> language — checked live against the studio's own syntactic-monoid engine.
        </p>
      </div>

      <div className="logic-modes">
        <button className={`tab${mode === 'mso' ? ' active' : ''}`} onClick={() => onModeChange('mso')}>
          MSO[&lt;]
        </button>
        <button className={`tab${mode === 'ltlf' ? ' active' : ''}`} onClick={() => onModeChange('ltlf')}>
          LTLf (temporal)
        </button>
        <label className="logic-alpha">
          <span>Σ =</span>
          <input value={alphabetStr} spellCheck={false} onChange={(e) => setAlphabetStr(e.target.value)} />
        </label>
      </div>

      <div className={`pattern-box logic-input${compiled?.error ? ' has-error' : ''}`}>
        <input
          className="pattern-input"
          value={source}
          spellCheck={false}
          autoComplete="off"
          placeholder={mode === 'mso' ? 'exists x. Qa(x)' : 'G (a -> X b)'}
          onChange={(e) => onSourceChange(e.target.value)}
        />
      </div>

      {mode === 'ltlf' && (
        <p className="muted-note">
          LTLf operators: <code>X</code> (next) <code>F</code> (eventually) <code>G</code> (globally) <code>U</code>{' '}
          (until) <code>R</code> (release), with <code>~ &amp; | -&gt; &lt;-&gt;</code>. A proposition is a letter of
          Σ. Each is desugared to <code>FO[&lt;]</code> (Kamp's theorem) and compiled by the same pipeline.
        </p>
      )}
      {mode === 'mso' && (
        <p className="muted-note">
          Atoms: <code>Qa(x)</code> (position x carries a), <code>x&lt;y</code> <code>x&lt;=y</code> <code>x=y</code>,{' '}
          <code>S(x,y)</code> (y = x+1), <code>x in X</code>. Lowercase = position variables, uppercase = set
          variables. Quantifiers <code>exists/forall</code>; the variable's case picks first- vs second-order.
        </p>
      )}

      {compiled?.error && (
        <div className="parse-error logic-err">
          <span className="err-msg">
            {compiled.error.message} (at index {compiled.error.index})
          </span>
        </div>
      )}
      {compiled?.buildError && !compiled.error && (
        <div className="logic-buildwarn">
          <strong>Could not build the automaton:</strong> {compiled.buildError}.{' '}
          {compiled.buildError.includes('blew up') && (
            <>This is the <em>non-elementary</em> cost of MSO — each ¬ before a ∃ can square the state count. Try a smaller formula.</>
          )}
        </div>
      )}

      {compiled && !compiled.error && (
        <>
          <div className="logic-status">
            <span className={`lang-badge ${compiled.sentence ? 'good' : ''}`}>
              {compiled.sentence ? 'sentence (closed)' : `free: ${[...compiled.free.fo, ...compiled.free.so].join(', ')}`}
            </span>
            <span className={`lang-badge ${compiled.firstOrder ? 'good' : 'bad'}`}>
              {compiled.firstOrder ? 'first-order (FO[<])' : 'second-order (MSO ∖ FO)'}
            </span>
            {compiled.bit && <span className="lang-badge">automaton: {compiled.bit.n} states</span>}
            {compiled.maxStates > (compiled.bit?.n ?? 0) && (
              <span className="lang-badge" title="largest intermediate machine before minimisation">
                blow-up high-water: {compiled.maxStates}
              </span>
            )}
          </div>

          {mode === 'ltlf' && compiled.ltlText && (
            <p className="muted-note">
              <strong>LTLf:</strong> <code>{compiled.ltlText}</code> &nbsp;⟿&nbsp; <strong>FO[&lt;]:</strong>{' '}
              <code className="logic-fo">{compiled.formulaText}</code>
            </p>
          )}
        </>
      )}

      {/* the variety bridge */}
      {compiled?.dfa && (
        <div className="logic-bridge">
          {starFreeExpected ? (
            <div className={`graph-badge ${isStarFree ? 'ok' : 'bad'}`}>
              {isStarFree
                ? 'FO[<] ⇒ star-free ✓ — McNaughton–Papert, verified by the syntactic monoid (aperiodic)'
                : 'FO but NOT star-free — this should never happen (McNaughton–Papert violated!)'}
            </div>
          ) : variety ? (
            <div className={`graph-badge ${isStarFree ? 'ok' : 'warn'}`}>
              {isStarFree
                ? 'second-order, yet the language is still star-free (the set quantifier was inessential)'
                : `genuinely beyond FO — the language is NOT star-free${variety.ladder.group ? ` (the syntactic group is ${variety.ladder.group.name})` : ''}. FO ⊊ MSO, shown.`}
            </div>
          ) : null}
          {variety && (
            <p className="muted-note">
              tightest variety: <strong>{tightestName(variety.ladder.tightestId)}</strong>
              {variety.ladder.group && variety.ladder.isGroupLanguage && (
                <> · syntactic group <code>{variety.ladder.group.name}</code></>
              )}
            </p>
          )}
        </div>
      )}

      {/* the automaton */}
      {layout && graph && (
        <div className="graph-pane logic-graph">
          <div className="pane-head graph-head">
            <div>
              <h3>{graph.sentence ? 'The automaton — over Σ, the language defined' : 'The automaton — over Σ × {0,1}^(free vars)'}</h3>
              <p>
                {graph.sentence
                  ? 'A sentence leaves an automaton over just Σ — lowered into the studio DFA and minimised, so it flows into every other tab.'
                  : 'With free variables the alphabet is the product Σ × bits; each edge shows the letter and the per-track bit pattern (x̄ = bit off).'}
              </p>
            </div>
            {graph.sentence && (
              <div className="graph-head-btns">
                <button className="dot-btn" onClick={() => downloadSvg(layout, 'logic-automaton')}>
                  download SVG
                </button>
                <button className="dot-btn" onClick={() => copyText(toDot(graph.input, 'logic'))}>
                  copy DOT
                </button>
              </div>
            )}
          </div>
          <AutomatonGraph layout={layout} accent={ACCENT} />
        </div>
      )}

      {/* language stats */}
      {compiled?.dfa && census && lang && (
        <>
          <h3 className="lang-h3">The language</h3>
          <div className="lang-grid">
            <div className="lang-card">
              <span className="lang-key">empty?</span>
              <span className={`lang-badge ${lang.empty ? 'bad' : 'good'}`}>{lang.empty ? 'empty ∅' : 'non-empty'}</span>
            </div>
            <div className="lang-card">
              <span className="lang-key">size</span>
              <span className="lang-badge">{lang.finite ? 'finite' : 'infinite ∞'}</span>
            </div>
            <div className="lang-card">
              <span className="lang-key">growth λ</span>
              <span className="lang-badge">
                <code>{census.growth === 'finite' || census.growth === 'empty' ? '—' : census.lambda.toFixed(4)}</code>
              </span>
            </div>
            <div className="lang-card">
              <span className="lang-key">shortest member</span>
              <span className="lang-badge">
                <code>{lang.shortest ? lang.shortest.display : '—'}</code>
              </span>
            </div>
          </div>
          {!lang.empty && lang.examples.length > 0 && (
            <p className="muted-note">
              first members: {lang.examples.map((e) => (e === '' ? 'ε' : e)).map((e) => `“${e}”`).join(', ')}
            </p>
          )}
        </>
      )}

      {/* truth table */}
      {truth && compiled?.dfa && (
        <>
          <h3 className="lang-h3">Truth table — the oracle vs the compiled automaton</h3>
          <p className="muted-note">
            Every word up to length {truth.maxLen} evaluated two independent ways: the brute-force MSO semantics
            (quantifiers interpreted literally over positions &amp; position-subsets) and a run of the compiled DFA.
            They must agree on every word.
          </p>
          <div className={`graph-badge ${truth.agree ? 'ok' : 'bad'}`}>
            {truth.agree ? 'oracle ≡ automaton on every word ✓' : 'DISAGREEMENT — a compiler bug'}
          </div>
          <div className="logic-truth">
            {truth.rows.map((r) => (
              <span key={r.word} className={`logic-cell ${r.auto ? 'acc' : 'rej'}`} title={r.auto ? 'in the language' : 'rejected'}>
                {r.word === '' ? 'ε' : r.word}
              </span>
            ))}
          </div>
        </>
      )}

      {/* the construction trace (blow-up) */}
      {compiled && compiled.trace.length > 0 && (
        <>
          <h3 className="lang-h3">Construction trace — watch the state count</h3>
          <p className="muted-note">
            Each connective and quantifier in post-order, with the resulting machine's size after minimisation (and,
            for a quantifier, the determinisation blow-up <em>before</em> it). The high-water mark is the cost MSO is
            famous for.
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
        {examples.map((ex) => (
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

function tightestName(id: string): string {
  switch (id) {
    case 'trivial':
      return 'trivial (∅ or Σ*)';
    case 'pt':
      return 'piecewise-testable (J-trivial, Simon)';
    case 'da':
      return 'DA · FO²[<]';
    case 'sf':
      return 'star-free · FO[<] · counter-free';
    default:
      return 'regular';
  }
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
  const [seed, setSeed] = useState(DEFAULT_LOGIC_FUZZ.seed);
  const [trials, setTrials] = useState(DEFAULT_LOGIC_FUZZ.trials);
  const [report, setReport] = useState<LogicFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      setReport(runLogicFuzz({ ...DEFAULT_LOGIC_FUZZ, seed: nextSeed, trials }));
      setRunning(false);
    }, 10);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check the compiler</h3>
      <p className="muted-note">
        A seeded fuzzer draws random FO and MSO sentences, compiles each to a DFA, and confronts it with the
        brute-force oracle on <strong>every</strong> word up to length {DEFAULT_LOGIC_FUZZ.maxLen}; it also checks the
        ∀ ≡ ¬∃¬ duality (negation-normal form compiles to the same language) and that every first-order sentence comes
        back star-free. Any disagreement is a real bug.
      </p>
      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <label className="fuzz-field">
          <span>sentences</span>
          <input
            type="number"
            min={10}
            max={400}
            value={trials}
            onChange={(e) => setTrials(Math.max(10, Math.min(400, Number(e.target.value) | 0)))}
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
        <div className="placeholder">Press <strong>run</strong> to compile hundreds of random formulas and verify each against the oracle.</div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.ok ? 'ok' : 'bad'}`}>
            {report.ok ? (
              <>
                <span className="fuzz-big">✓ every formula compiles correctly</span>
                <span className="fuzz-sub">
                  {report.trials} sentences ({report.foSentences} FO · {report.msoSentences} MSO) —{' '}
                  {report.membershipChecks.toLocaleString()} membership checks against the oracle,{' '}
                  {report.dualityChecks.toLocaleString()} duality checks, {report.bridgeChecks.toLocaleString()}{' '}
                  star-free bridge checks, all agree. {report.elapsedMs.toFixed(0)} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failure?.kind} mismatch</span>
                <span className="fuzz-sub">A compiled automaton disagreed with the oracle — see below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="sentences" v={String(report.trials)} />
            <St k="membership" v={report.membershipChecks.toLocaleString()} />
            <St k="duality" v={report.dualityChecks.toLocaleString()} />
            <St k="bridge" v={report.bridgeChecks.toLocaleString()} />
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
