import { useEffect, useMemo, useRef, useState } from 'react';
import type { DFA } from '../engine/dfa';
import {
  inputAlphabet,
  isDeterministic,
  isRealTime,
  outputAlphabet,
  traceRun,
  transduce,
  type FST,
} from '../engine/transducer/fst';
import { GALLERY, type TransducerExample } from '../engine/transducer/gallery';
import { fstToGraph } from '../engine/transducer/graph';
import { compose, identityFromDFA } from '../engine/transducer/rational';
import { determinize, runSubseq } from '../engine/transducer/subseq';
import {
  DEFAULT_TRANSDUCER_FUZZ,
  runTransducerFuzz,
  type TransducerFuzzReport,
} from '../engine/transducer/verify';
import { layoutGraph } from '../engine/layout';
import { AutomatonGraph } from './AutomatonGraph';

const ACCENT = '#34d399';

function St({ k, v }: { k: string; v: string }) {
  return (
    <div className="fuzz-stat">
      <span className="fuzz-stat-v">{v}</span>
      <span className="fuzz-stat-k">{k}</span>
    </div>
  );
}

function OutputSet({ outputs, truncated }: { outputs: string[]; truncated: boolean }) {
  if (outputs.length === 0) return <span className="td-out-empty">∅ — not in the domain</span>;
  return (
    <span className="td-out-set">
      {outputs.map((o, i) => (
        <code key={i} className="td-out-val">
          {o === '' ? 'ε' : o}
        </code>
      ))}
      {truncated && <span className="td-trunc"> …(capped)</span>}
    </span>
  );
}

// A machine + its finals rendered as a graph, with a highlighted state set.
function FSTGraphView({ fst, highlight, title }: { fst: FST; highlight?: Set<number>; title?: string }) {
  const layout = useMemo(() => layoutGraph(fstToGraph(fst)), [fst]);
  const finalOuts = useMemo(
    () => [...fst.finals.entries()].filter(([, o]) => o.some((s) => s !== '')),
    [fst],
  );
  return (
    <div className="graph-pane td-graph">
      {title && (
        <div className="pane-head graph-head">
          <h2>{title}</h2>
        </div>
      )}
      <AutomatonGraph layout={layout} accent={ACCENT} highlight={highlight} />
      {finalOuts.length > 0 && (
        <p className="muted-note td-finals">
          final outputs:{' '}
          {finalOuts.map(([q, outs], i) => (
            <span key={q}>
              {i > 0 && ', '}
              <code>
                {q} ⇒ /{outs.map((o) => (o === '' ? 'ε' : o)).join('|')}
              </code>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

export function TransducerPanel({ dfa, pattern }: { dfa: DFA | null; pattern: string }) {
  const [pick, setPick] = useState(0);
  const ex: TransducerExample = GALLERY[pick];
  const fst = ex.fst;

  const [input, setInput] = useState(ex.examples[0] ?? '');
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  const inAlpha = useMemo(() => inputAlphabet(fst), [fst]);
  const outAlpha = useMemo(() => outputAlphabet(fst), [fst]);
  const realTime = useMemo(() => isRealTime(fst), [fst]);
  const deterministic = useMemo(() => isDeterministic(fst), [fst]);

  // Clean the input to the machine's input alphabet so the tape never wedges.
  const clean = useMemo(() => [...input].filter((c) => inAlpha.includes(c)).join(''), [input, inAlpha]);
  const result = useMemo(() => transduce(fst, clean), [fst, clean]);
  const functionalHere = result.outputs.length <= 1;
  const run = useMemo(() => traceRun(fst, clean), [fst, clean]);

  const stepCount = run ? run.steps.length : 0;
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setStep((s) => {
        if (s >= stepCount) {
          setPlaying(false);
          return s;
        }
        return s + 1;
      });
    }, 650);
    return () => window.clearInterval(id);
  }, [playing, stepCount]);

  const changeExample = (i: number) => {
    setPick(i);
    setInput(GALLERY[i].examples[0] ?? '');
    setStep(0);
    setPlaying(false);
  };

  // Current tape / output state for the animation.
  const consumedReads = run ? run.steps.slice(0, step).filter((s) => s.read !== '').length : 0;
  const emitted = run ? run.steps.slice(0, step).map((s) => s.write).join('') : '';
  const atEnd = run ? step >= stepCount : false;
  const curState = run ? (step < stepCount ? run.steps[step].state : run.end) : fst.start;
  const shownOutput = atEnd && run ? run.output : emitted;

  // Determinisation.
  const det = useMemo(() => determinize(fst), [fst]);
  const detVerify = useMemo(() => {
    if (!det.ok || !det.fst) return null;
    let ok = true;
    const probes = [...ex.examples, ...inAlpha, inAlpha.join('') + inAlpha.join('')];
    for (const w of probes) {
      const ref = transduce(fst, w);
      if (ref.truncated) continue;
      const got = runSubseq(det.fst, w, det.initialOutput ?? '');
      const refOut = ref.outputs.length ? ref.outputs[0] : null;
      if (got !== refOut) ok = false;
    }
    return ok;
  }, [det, fst, ex, inAlpha]);

  return (
    <div className="td-panel deriv-panel">
      <div className="pane-head">
        <h2>Transducers — machines that translate, not just accept</h2>
        <p>
          Every other tab computes a <strong>language</strong> — it says <em>yes</em> or <em>no</em> to a word. A
          finite-state <strong>transducer</strong> computes a <strong>relation</strong>: it reads an input word and{' '}
          <em>emits</em> output words, its edges labelled <code>read : write</code>. This is the machine behind spell-
          checkers, tokenisers and phonology. Pick one, watch it translate, then compose two of them and determinise —
          the rational relations are closed under all of it (Elgot–Mezei), and the twinning property decides which can
          run deterministically (Choffrut).
        </p>
      </div>

      <div className="td-gallery">
        {GALLERY.map((g, i) => (
          <button key={g.id} className={`td-pick${i === pick ? ' active' : ''}`} onClick={() => changeExample(i)}>
            {g.title}
          </button>
        ))}
      </div>

      <p className="muted-note td-blurb">{ex.blurb}</p>
      <div className="td-badges">
        {ex.kind.map((k) => (
          <span key={k} className="example-chip td-kind">
            {k}
          </span>
        ))}
        <span className={`lang-badge ${realTime ? 'good' : 'muted'}`}>{realTime ? 'real-time' : 'has ε-reads'}</span>
        <span className={`lang-badge ${deterministic ? 'good' : 'muted'}`}>
          {deterministic ? 'subsequential (deterministic)' : 'nondeterministic'}
        </span>
      </div>
      <div className="td-alpha">
        <span className="lang-key">input Σ</span>
        {inAlpha.map((c) => (
          <code key={c} className="example-chip">
            {c}
          </code>
        ))}
        <span className="lang-key td-alpha-out">output Γ</span>
        {outAlpha.length === 0 ? (
          <code className="example-chip">ε only</code>
        ) : (
          outAlpha.map((c) => (
            <code key={c} className="example-chip">
              {c}
            </code>
          ))
        )}
      </div>

      {/* --------- run box --------- */}
      <div className="td-runbox">
        <label className="td-inputrow">
          <span>input word</span>
          <input
            value={input}
            onChange={(e) => { setInput(e.target.value); setStep(0); setPlaying(false); }}
            spellCheck={false}
            placeholder="type over Σ"
          />
        </label>
        <div className="td-samples">
          {ex.examples.map((s, i) => (
            <button key={i} className="td-sample" onClick={() => { setInput(s); setStep(0); setPlaying(false); }}>
              {s}
            </button>
          ))}
        </div>
      </div>
      {clean !== input && (
        <p className="muted-note td-warn">
          Ignoring characters outside Σ — running on <code>{clean === '' ? 'ε' : clean}</code>.
        </p>
      )}

      <div className="td-relrow">
        <span className="lang-key">T({clean === '' ? 'ε' : clean}) =</span>
        <OutputSet outputs={result.outputs} truncated={result.truncated} />
        {!functionalHere && <span className="td-rel-note">— a relation: {result.outputs.length} outputs</span>}
      </div>

      {/* --------- animated tape --------- */}
      {run ? (
        <>
          <div className="td-tape-wrap">
            <div className="td-tape-line">
              <span className="td-tape-label">in</span>
              <div className="td-tape">
                {[...clean].map((c, i) => (
                  <span key={i} className={`td-cell${i < consumedReads ? ' consumed' : ''}${i === consumedReads && !atEnd ? ' head' : ''}`}>
                    {c}
                  </span>
                ))}
                {clean === '' && <span className="td-cell marker">ε</span>}
              </div>
            </div>
            <div className="td-tape-line">
              <span className="td-tape-label">out</span>
              <div className="td-tape td-tape-out">
                {shownOutput === '' ? (
                  <span className="td-cell marker">ε</span>
                ) : (
                  [...shownOutput].map((c, i) => (
                    <span key={i} className="td-cell emitted">
                      {c}
                    </span>
                  ))
                )}
                {atEnd && run.finalOut !== '' && <span className="td-final-flush" title="final output flushed">⇥ {run.finalOut}</span>}
              </div>
            </div>
          </div>
          <div className="td-ctl">
            <button className="twoway-btn" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
              ‹ back
            </button>
            <button className="twoway-btn primary" onClick={() => setPlaying((p) => !p)} disabled={stepCount === 0}>
              {playing ? '⏸ pause' : '▶ play'}
            </button>
            <button className="twoway-btn" onClick={() => setStep((s) => Math.min(stepCount, s + 1))} disabled={atEnd}>
              step ›
            </button>
            <input
              type="range"
              min={0}
              max={stepCount}
              value={step}
              onChange={(e) => { setStep(Number(e.target.value)); setPlaying(false); }}
              className="td-slider"
            />
            <span className="td-stepinfo">
              step {step}/{stepCount} · state {curState}
              {run.steps[step] && run.steps[step].read !== '' && (
                <> · read <code>{run.steps[step].read}</code> → write <code>{run.steps[step].write || 'ε'}</code></>
              )}
            </span>
          </div>
        </>
      ) : (
        <p className="muted-note td-warn">No accepting run — <code>{clean === '' ? 'ε' : clean}</code> is not in this transducer's domain.</p>
      )}

      <FSTGraphView fst={fst} highlight={new Set([curState])} />

      {/* --------- determinisation --------- */}
      <h3 className="lang-h3">Determinise → a subsequential machine</h3>
      <p className="muted-note">
        A subsequential transducer reads deterministically and emits output greedily as it goes, flushing a final string
        at the end. The construction is subset-construction with an output delay: each deterministic state is a set of{' '}
        <em>(state, pending-output)</em> pairs, and at every step it emits the <strong>longest common prefix</strong> of
        the pending outputs, carrying the rest forward. It works iff the transducer has the <strong>twinning property</strong>.
      </p>
      {det.ok && det.fst ? (
        <>
          <div className="learn-verdicts">
            <span className="lang-badge good">subsequentialised: {det.states} states ✓</span>
            {detVerify !== null && (
              <span className={`lang-badge ${detVerify ? 'good' : 'bad'}`}>
                {detVerify ? 'computes the same function ✓' : 'MISMATCH ✗'}
              </span>
            )}
            {det.initialOutput ? <span className="lang-badge muted">initial output “{det.initialOutput}”</span> : null}
          </div>
          <FSTGraphView fst={det.fst} title="The determinised (subsequential) transducer" />
        </>
      ) : (
        <div className={`graph-badge ${det.twinningFails ? 'bad' : ''} td-twinfail`}>
          <span className="fuzz-big">{det.twinningFails ? '✗ not subsequentialisable' : 'cannot determinise'}</span>
          <span className="fuzz-sub">{det.reason}</span>
        </div>
      )}

      <ComposeSection />
      <IdentityBridge dfa={dfa} pattern={pattern} />
      <CrossCheck />
    </div>
  );
}

// --------------------------------------------------------------------------
// Composition: pick two machines, feed one's output into the other.
// --------------------------------------------------------------------------
function ComposeSection() {
  const [ai, setAi] = useState(GALLERY.findIndex((g) => g.id === 'rot13'));
  const [bi, setBi] = useState(GALLERY.findIndex((g) => g.id === 'rot13'));
  const [x, setX] = useState('hello');
  const A = GALLERY[ai].fst;
  const B = GALLERY[bi].fst;
  const comp = useMemo(() => compose(A, B), [A, B]);
  const aOut = useMemo(() => transduce(A, [...x].filter((c) => inputAlphabet(A).includes(c)).join('')), [A, x]);
  const cleanX = [...x].filter((c) => inputAlphabet(A).includes(c)).join('');
  const compOut = useMemo(() => transduce(comp, cleanX), [comp, cleanX]);

  // Cross-check compose ≡ run-through on the sample.
  const refThrough = useMemo(() => {
    const set = new Set<string>();
    for (const y of aOut.outputs) for (const z of transduce(B, y).outputs) set.add(z);
    return [...set].sort();
  }, [aOut, B]);
  const agree = JSON.stringify(refThrough) === JSON.stringify(compOut.outputs);

  return (
    <>
      <h3 className="lang-h3">Compose — chain two transducers into a pipeline</h3>
      <p className="muted-note">
        Composition <code>A ; B</code> feeds A's output straight into B's input, producing one machine for the whole
        pipeline: <code>{'{ (x, z) : ∃y, (x,y)∈A and (y,z)∈B }'}</code>. It is the deep closure property — the reason
        transducers <em>chain</em>. ROT13 ∘ ROT13 collapses to the identity.
      </p>
      <div className="td-compose-ctl">
        <label className="fuzz-field">
          <span>A</span>
          <select value={ai} onChange={(e) => setAi(Number(e.target.value))}>
            {GALLERY.map((g, i) => <option key={g.id} value={i}>{g.title}</option>)}
          </select>
        </label>
        <span className="td-compose-op">;</span>
        <label className="fuzz-field">
          <span>B</span>
          <select value={bi} onChange={(e) => setBi(Number(e.target.value))}>
            {GALLERY.map((g, i) => <option key={g.id} value={i}>{g.title}</option>)}
          </select>
        </label>
        <label className="fuzz-field td-compose-x">
          <span>input x</span>
          <input value={x} onChange={(e) => setX(e.target.value)} spellCheck={false} />
        </label>
      </div>
      <div className="td-compose-flow">
        <div className="td-flow-step">
          <span className="lang-key">x</span>
          <code>{cleanX === '' ? 'ε' : cleanX}</code>
        </div>
        <span className="td-flow-arrow">— A →</span>
        <div className="td-flow-step">
          <span className="lang-key">A(x)</span>
          <OutputSet outputs={aOut.outputs} truncated={aOut.truncated} />
        </div>
        <span className="td-flow-arrow">— B →</span>
        <div className="td-flow-step">
          <span className="lang-key">(A;B)(x)</span>
          <OutputSet outputs={compOut.outputs} truncated={compOut.truncated} />
        </div>
      </div>
      <div className={`graph-badge ${agree ? 'ok' : 'bad'} td-compose-badge`}>
        {agree
          ? '✓ composed machine agrees with running A then B, by construction'
          : '✗ composition disagrees with the run-through (report this!)'}
      </div>
      <FSTGraphView fst={comp} title={`A ; B — ${comp.states} states`} />
    </>
  );
}

// --------------------------------------------------------------------------
// The bridge: the regex you typed, as an identity transducer.
// --------------------------------------------------------------------------
function IdentityBridge({ dfa, pattern }: { dfa: DFA | null; pattern: string }) {
  const built = useMemo(() => (dfa ? identityFromDFA(dfa) : null), [dfa]);
  const [w, setW] = useState('');
  const cleanW = built ? [...w].filter((c) => built.alphabet.includes(c)).join('') : '';
  const out = useMemo(() => (built ? transduce(built.fst, cleanW) : null), [built, cleanW]);
  return (
    <>
      <h3 className="lang-h3">The bridge — your regex, as a transducer</h3>
      <p className="muted-note">
        The whole studio compiles a regex to an automaton that <em>accepts</em> a language. Here that same language
        becomes the <strong>identity transduction</strong> — echo the word if it is in <code>/{pattern}/</code>, reject
        it otherwise. It ties the transducer world back to every other tab.
      </p>
      {built ? (
        <>
          <div className="td-runbox">
            <label className="td-inputrow">
              <span>word over Σ</span>
              <input value={w} onChange={(e) => setW(e.target.value)} spellCheck={false} placeholder={built.alphabet.join('')} />
            </label>
          </div>
          {out && (
            <div className="td-relrow">
              <span className="lang-key">identity({cleanW === '' ? 'ε' : cleanW}) =</span>
              <OutputSet outputs={out.outputs} truncated={out.truncated} />
              <span className="td-rel-note">
                {out.outputs.length ? '— in the language, echoed' : '— not in the language, rejected'}
              </span>
            </div>
          )}
          <FSTGraphView fst={built.fst} title={`identity(/${pattern}/) — ${built.fst.states} states`} />
        </>
      ) : (
        <div className="placeholder">Fix the pattern above to build its identity transducer.</div>
      )}
    </>
  );
}

// --------------------------------------------------------------------------
// The house cross-check.
// --------------------------------------------------------------------------
function CrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_TRANSDUCER_FUZZ.seed);
  const [cases, setCases] = useState(DEFAULT_TRANSDUCER_FUZZ.cases);
  const [report, setReport] = useState<TransducerFuzzReport | null>(null);
  const [running, setRunning] = useState(false);
  const timer = useRef<number | null>(null);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setReport(runTransducerFuzz({ seed: nextSeed, cases }));
      setRunning(false);
    }, 0);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check the transducer engine</h3>
      <p className="muted-note">
        A seeded fuzzer draws random transducers and confronts every construction against a brute-force reference
        computed straight from the relation semantics: union / concatenation / star match the reference relation over
        all splits and partitions; <strong>composition</strong> equals running A then B by hand over every input;{' '}
        <strong>determinisation</strong> of a functional machine computes the same function and is deterministic (and the
        non-subsequentialisable machine is correctly rejected); and <strong>identity(L)</strong> echoes exactly a
        compiled regex's language. Any disagreement is a real bug, reported with the offending machines.
      </p>
      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <label className="fuzz-field">
          <span>cases</span>
          <input
            type="number"
            min={20}
            max={2000}
            value={cases}
            onChange={(e) => setCases(Math.max(20, Math.min(2000, Number(e.target.value) | 0)))}
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
        <div className="placeholder">Press <strong>run</strong> to fuzz thousands of transducer constructions.</div>
      )}
      {report && (
        <>
          <div className={`fuzz-verdict ${report.failures.length === 0 ? 'ok' : 'bad'}`}>
            {report.failures.length === 0 ? (
              <>
                <span className="fuzz-big">✓ every construction verified</span>
                <span className="fuzz-sub">
                  {report.checks.toLocaleString()} differential checks over {report.casesTested.toLocaleString()} random
                  cases — union, concat, star, compose, determinise and identity all matched the brute-force reference.{' '}
                  {report.elapsedMs} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failures.length} failure(s)</span>
                <span className="fuzz-sub">A construction disagreed with the reference — details below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="total checks" v={report.checks.toLocaleString()} />
            <St k="union" v={report.breakdown.union.toLocaleString()} />
            <St k="concat" v={report.breakdown.concat.toLocaleString()} />
            <St k="star" v={report.breakdown.star.toLocaleString()} />
            <St k="compose" v={report.breakdown.compose.toLocaleString()} />
            <St k="determinise" v={report.breakdown.determinize.toLocaleString()} />
            <St k="identity" v={report.breakdown.identity.toLocaleString()} />
            <St k="time" v={`${report.elapsedMs} ms`} />
            <St k="seed" v={String(report.config.seed)} />
          </div>
          {report.failures.length > 0 && (
            <div className="fuzz-counter">
              <h3>Failures</h3>
              {report.failures.slice(0, 8).map((f, i) => (
                <div key={i} className="fuzz-cx-row">
                  <code className="fuzz-cx-val">{f.kind}</code>
                  <span className="learn-fail-reason">{f.detail.split('\n')[0]}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
