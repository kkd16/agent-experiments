import { useEffect, useMemo, useRef, useState } from 'react';
import type { DFA } from '../engine/dfa';
import { dfaToGraph } from '../engine/graphdata';
import { layoutGraph } from '../engine/layout';
import { minimizeDFA } from '../engine/minimize';
import { compareDFAs } from '../engine/equivalence';
import { toDot, toSvg } from '../engine/export';
import {
  GALLERY,
  LEND,
  REND,
  construct,
  crossingSequences,
  isSingletonAlphabet,
  liftDFA,
  simulate,
  twoWayToGraph,
  type TwoWayDFA,
} from '../engine/twoway';
import {
  DEFAULT_TWOWAY_FUZZ,
  runTwoWayFuzz,
  type TwoWayFuzzReport,
} from '../engine/twoway-verify';
import { AutomatonGraph } from './AutomatonGraph';

const ACCENT = '#34d399'; // emerald — the studio's first two-way road
const ACCENT2 = '#a78bfa';

export function TwoWayPanel({ dfa, notice }: { dfa: DFA | null; notice: string | null }) {
  const [pick, setPick] = useState(0);
  const machine = GALLERY[pick].machine;
  const [word, setWord] = useState(GALLERY[pick].samples[0] ?? '');

  // ── head animation ────────────────────────────────────────────────────────
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Changing the machine or the word rewinds the animation to the start.
  const changeWord = (w: string) => {
    setWord(w);
    setStep(0);
    setPlaying(false);
  };
  const onPick = (i: number) => {
    setPick(i);
    changeWord(GALLERY[i].samples[0] ?? '');
  };

  const cleanWord = useMemo(
    () => [...word].filter((c) => machine.alphabet.includes(c)).join(''),
    [word, machine],
  );

  const sim = useMemo(() => simulate(machine, cleanWord), [machine, cleanWord]);
  const crossings = useMemo(() => crossingSequences(machine, cleanWord), [machine, cleanWord]);
  const built = useMemo(() => construct(machine), [machine]);
  const minStates = useMemo(() => minimizeDFA(built.dfa).states.length, [built]);

  const machineLayout = useMemo(() => layoutGraph(twoWayToGraph(machine)), [machine]);
  const dfaLayout = useMemo(() => layoutGraph(dfaToGraph(built.dfa)), [built]);

  const timer = useRef<number | null>(null);
  const maxStep = sim.trace.length - 1;

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      setStep((s) => {
        if (s >= maxStep) {
          setPlaying(false);
          return s;
        }
        return s + 1;
      });
    }, 520);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [playing, maxStep]);

  const cur = sim.trace[Math.min(step, maxStep)] ?? { pos: 0, state: machine.start };
  const n = cleanWord.length;
  const cells = [LEND, ...cleanWord.split(''), REND];

  return (
    <div className="twoway-panel deriv-panel">
      <div className="pane-head">
        <h2>Two-way DFA — the head turns around</h2>
        <p>
          Every road so far scans the input <strong>once, left to right</strong>. A <strong>two-way</strong> DFA may
          move its head <strong>both ways</strong> over a tape framed by end-markers <code>⊢ w ⊣</code>, re-reading
          the input as often as it likes. By the <strong>Rabin–Scott / Shepherdson</strong> theorem that buys it{' '}
          <em>no extra power</em> — every 2DFA recognises a regular language — and the proof is a construction you
          can watch: the equivalent one-way DFA reads <code>w</code> once, its state being the{' '}
          <strong>behaviour table</strong> (crossing sequence summary) of the prefix so far. Pick a machine, watch
          the head bounce, then see the one-way DFA it compiles to.
        </p>
      </div>

      {/* gallery picker */}
      <div className="twoway-gallery">
        {GALLERY.map((g, i) => (
          <button
            key={g.machine.name}
            className={`twoway-pick${i === pick ? ' active' : ''}`}
            onClick={() => onPick(i)}
            title={g.machine.note}
          >
            {g.machine.name}
          </button>
        ))}
      </div>
      {machine.note && <p className="muted-note twoway-note">{machine.note}</p>}

      {/* test word + tape */}
      <div className="twoway-input-row">
        <label className="twoway-word">
          <span>tape w =</span>
          <input
            value={word}
            spellCheck={false}
            autoComplete="off"
            placeholder="type over {a,b}…"
            onChange={(e) => changeWord(e.target.value)}
          />
        </label>
        <div className="twoway-samples">
          {GALLERY[pick].samples.map((s, i) => (
            <button key={i} className="twoway-sample" onClick={() => changeWord(s)} title="load sample">
              {s === '' ? 'ε' : s}
            </button>
          ))}
        </div>
      </div>
      {cleanWord !== word && (
        <p className="muted-note twoway-warn">
          input restricted to Σ = {'{' + machine.alphabet.join(', ') + '}'} → running on <code>{cleanWord || 'ε'}</code>
        </p>
      )}

      {/* the tape with the head */}
      <div className="twoway-tape">
        {cells.map((c, i) => (
          <div
            key={i}
            className={`twoway-cell${i === cur.pos ? ' head' : ''}${i === 0 || i === n + 1 ? ' marker' : ''}`}
          >
            <span className="twoway-glyph">{c === '' ? 'ε' : c}</span>
            {i === cur.pos && (
              <span className="twoway-headtag" style={{ color: ACCENT }}>
                ▲ {machine.states[cur.state]}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="twoway-ctl">
        <button onClick={() => setStep((s) => Math.max(0, s - 1))}>◀ step</button>
        <button onClick={() => setPlaying((p) => !p)} disabled={maxStep === 0}>
          {playing ? '⏸ pause' : '▶ play'}
        </button>
        <button onClick={() => setStep((s) => Math.min(maxStep, s + 1))}>step ▶</button>
        <button
          onClick={() => {
            setStep(0);
            setPlaying(false);
          }}
        >
          ⟲ reset
        </button>
        <span className="twoway-stepinfo">
          step {Math.min(step, maxStep)} / {maxStep} · head at cell {cur.pos} · state{' '}
          <strong>{machine.states[cur.state]}</strong>
        </span>
      </div>

      {/* verdict */}
      <div className={`graph-badge twoway-verdict ${sim.accept ? 'ok' : 'bad'}`}>
        {sim.reason === 'accept' && `ACCEPT — reached the accept state in ${sim.steps} steps`}
        {sim.reason === 'reject' && `REJECT — halted in the reject state after ${sim.steps} steps`}
        {sim.reason === 'loop' && `REJECT — the head entered an infinite loop (a repeated configuration), so it rejects`}
      </div>

      {/* crossing sequences */}
      {n > 0 && (
        <div className="twoway-crossblock">
          <h3 className="lang-h3">Crossing sequences</h3>
          <p className="muted-note">
            At each boundary between two cells, the ordered list of states in which the head crosses (→ right, ←
            left). Two inputs sharing a boundary's crossing sequence are interchangeable there — this finite summary
            is exactly what the one-way DFA below remembers.
          </p>
          <div className="twoway-crossings">
            {crossings.map((bc) => (
              <div key={bc.boundary} className="twoway-cross-col">
                <div className="twoway-cross-seq">
                  {bc.crossings.length === 0 ? (
                    <span className="twoway-cross-empty">·</span>
                  ) : (
                    bc.crossings.map((cr, j) => (
                      <span key={j} className={`twoway-cross-st ${cr.dir === 'R' ? 'r' : 'l'}`}>
                        {machine.states[cr.state]}
                        {cr.dir === 'R' ? '→' : '←'}
                      </span>
                    ))
                  )}
                </div>
                <div className="twoway-cross-idx">{bc.boundary}|{bc.boundary + 1}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* the 2DFA graph (head state lit) */}
      <GraphCard
        title="The two-way DFA"
        blurb="Edges are labelled symbol→direction (R right, L left); ⊢ ⊣ are the end-markers, the double ring is the accept state. The lit node is where the head sits in the animation above."
        layout={machineLayout}
        highlight={new Set([cur.state])}
        accent={ACCENT}
        dotInput={() => toDot(twoWayToGraph(machine), 'TwoWayDFA')}
        name="two-way-dfa"
      />

      {/* the constructed one-way DFA */}
      <GraphCard
        title="The equivalent one-way DFA — Shepherdson's construction"
        blurb="Built by the transition-profile method: one state per behaviour table of a prefix. It accepts exactly the same language, scanning left→right once. ⊤ is the shared accept sink."
        layout={dfaLayout}
        accent={ACCENT2}
        dotInput={() => toDot(dfaToGraph(built.dfa), 'OneWayDFA')}
        name="one-way-dfa"
      />

      <div className="twoway-stats">
        <Stat k="two-way states" v={machine.states.length} />
        <Stat k="constructed DFA" v={built.dfa.states.length} />
        <Stat k="minimal DFA" v={minStates} accent />
      </div>
      <p className="muted-note">
        The two-way machine and its one-way image recognise the same language — proven exhaustively by the
        cross-check below. Folding several passes into one direction can cost states (here the minimal one-way DFA
        is often <em>smaller</em> than the multi-pass 2DFA), but for other languages the gap runs the other way:
        2DFAs can be exponentially more succinct than any DFA.
      </p>

      <RoundTrip dfa={dfa} notice={notice} />

      <CrossCheck />
    </div>
  );
}

// ── round-trip: lift the studio's current DFA into a 2DFA and back ──────────

function RoundTrip({ dfa, notice }: { dfa: DFA | null; notice: string | null }) {
  const result = useMemo(() => {
    if (!dfa) return null;
    if (!isSingletonAlphabet(dfa)) return { kind: 'multichar' as const };
    let lifted: TwoWayDFA;
    try {
      lifted = liftDFA(dfa);
    } catch {
      return { kind: 'multichar' as const };
    }
    const back = construct(lifted);
    const rel = compareDFAs(dfa, back.dfa).relation;
    return {
      kind: 'ok' as const,
      lifted,
      backStates: back.dfa.states.length,
      origStates: dfa.states.length,
      equal: rel === 'equal',
      rel,
    };
  }, [dfa]);

  return (
    <>
      <h3 className="lang-h3">Round trip — lift the current pattern’s DFA into a 2DFA, and back</h3>
      <p className="muted-note">
        Any one-way DFA <em>is</em> a two-way DFA that only ever moves right. Lifting the pattern’s minimal DFA into
        such a machine and pushing it back through Shepherdson’s construction must return the same language — the
        easy half of Rabin–Scott meeting the hard half, on one machine.
      </p>
      {notice && <div className="placeholder">{notice}</div>}
      {!notice && !result && <div className="placeholder">Type a regular pattern in the sidebar to lift its DFA.</div>}
      {result?.kind === 'multichar' && (
        <div className="placeholder">
          The current DFA’s alphabet has multi-character classes (e.g. <code>\d</code>, ranges). The lift demo runs
          on single-character alphabets — try a pattern over a small literal alphabet like <code>(a|b)*abb</code>.
        </div>
      )}
      {result?.kind === 'ok' && (
        <>
          <div className={`graph-badge ${result.equal ? 'ok' : 'bad'}`}>
            {result.equal
              ? `DFA → right-only 2DFA → DFA returns an equal language ✓ (compareDFAs = "equal")`
              : `MISMATCH — round trip relation is "${result.rel}" (a construction bug)`}
          </div>
          <div className="twoway-stats">
            <Stat k="original DFA" v={result.origStates} />
            <Stat k="lifted 2DFA" v={result.lifted.states.length} />
            <Stat k="reconstructed DFA" v={result.backStates} accent />
          </div>
        </>
      )}
    </>
  );
}

// ── the seeded cross-check console ──────────────────────────────────────────

function CrossCheck() {
  const [seed, setSeed] = useState(DEFAULT_TWOWAY_FUZZ.seed);
  const [trials, setTrials] = useState(DEFAULT_TWOWAY_FUZZ.trials);
  const [report, setReport] = useState<TwoWayFuzzReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = (nextSeed: number) => {
    setRunning(true);
    setSeed(nextSeed);
    setTimeout(() => {
      setReport(runTwoWayFuzz({ ...DEFAULT_TWOWAY_FUZZ, seed: nextSeed, trials }));
      setRunning(false);
    }, 10);
  };

  return (
    <>
      <h3 className="lang-h3">Cross-check the construction</h3>
      <p className="muted-note">
        A seeded fuzzer draws random two-way DFAs and confronts the constructed one-way DFA with a{' '}
        <strong>trivially-correct oracle</strong> — the real two-way head, run with exact loop detection — on a
        batch of random words: they must agree on every word. It also <strong>round-trips</strong> each machine
        (2DFA → DFA → 2DFA → DFA must stay equal) and re-checks the whole gallery <strong>exhaustively</strong> over
        every word up to a horizon. Any disagreement is a real bug.
      </p>
      <div className="fuzz-controls">
        <label className="fuzz-field">
          <span>seed</span>
          <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) | 0)} />
        </label>
        <label className="fuzz-field">
          <span>machines</span>
          <input
            type="number"
            min={20}
            max={1000}
            value={trials}
            onChange={(e) => setTrials(Math.max(20, Math.min(1000, Number(e.target.value) | 0)))}
          />
        </label>
        <button className="fuzz-run" disabled={running} onClick={() => run(seed)}>
          {running ? 'running…' : 'run'}
        </button>
        <button
          className="fuzz-run secondary"
          disabled={running}
          onClick={() => run((Math.random() * 2 ** 31) | 0)}
        >
          new seed
        </button>
      </div>

      {!report && !running && (
        <div className="placeholder">
          Press <strong>run</strong> to build hundreds of random two-way machines and verify each against the head
          oracle, its round trip, and the exhaustive gallery.
        </div>
      )}

      {report && (
        <>
          <div className={`fuzz-verdict ${report.ok ? 'ok' : 'bad'}`}>
            {report.ok ? (
              <>
                <span className="fuzz-big">✓ every machine’s one-way image is correct</span>
                <span className="fuzz-sub">
                  {report.trials} random machines — {report.differentialChecks.toLocaleString()} oracle checks +{' '}
                  {report.roundTripChecks.toLocaleString()} round trips +{' '}
                  {report.galleryChecks.toLocaleString()} exhaustive gallery checks, all agree.{' '}
                  {report.skipped > 0 ? `${report.skipped} skipped (state-cap blow-up). ` : ''}
                  {report.elapsedMs.toFixed(0)} ms.
                </span>
              </>
            ) : (
              <>
                <span className="fuzz-big">✗ {report.failure?.kind} mismatch</span>
                <span className="fuzz-sub">A constructed DFA disagreed with the oracle — see below.</span>
              </>
            )}
          </div>
          <div className="fuzz-stats">
            <St k="machines" v={String(report.trials)} />
            <St k="differential" v={report.differentialChecks.toLocaleString()} />
            <St k="round trips" v={report.roundTripChecks.toLocaleString()} />
            <St k="gallery" v={report.galleryChecks.toLocaleString()} />
            <St k="skipped" v={String(report.skipped)} />
            <St k="time" v={`${report.elapsedMs.toFixed(0)} ms`} />
          </div>
          {report.failure && (
            <div className="fuzz-counter">
              <h3>Counterexample</h3>
              <div className="fuzz-cx-row">
                <code className="fuzz-cx-val">{report.failure.machine}</code>
                <span className="learn-fail-reason">{report.failure.detail}</span>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ── shared bits ─────────────────────────────────────────────────────────────

function GraphCard({
  title,
  blurb,
  layout,
  highlight,
  accent,
  dotInput,
  name,
}: {
  title: string;
  blurb: string;
  layout: ReturnType<typeof layoutGraph>;
  highlight?: Set<number>;
  accent: string;
  dotInput: () => string;
  name: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyDot = () => {
    try {
      navigator.clipboard?.writeText(dotInput());
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* sandbox */
    }
  };
  const downloadSvg = () => {
    try {
      const blob = new Blob([toSvg(layout, { accent })], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.svg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* sandbox */
    }
  };
  return (
    <div className="graph-pane twoway-graph">
      <div className="pane-head graph-head">
        <div>
          <h3>{title}</h3>
          <p>{blurb}</p>
        </div>
        <div className="graph-head-btns">
          <button className="dot-btn" onClick={downloadSvg}>
            download SVG
          </button>
          <button className="dot-btn" onClick={copyDot}>
            {copied ? 'copied ✓' : 'copy DOT'}
          </button>
        </div>
      </div>
      <AutomatonGraph layout={layout} accent={accent} highlight={highlight} />
    </div>
  );
}

function Stat({ k, v, accent }: { k: string; v: number; accent?: boolean }) {
  return (
    <div className={`twoway-stat${accent ? ' accent' : ''}`}>
      <span className="twoway-stat-v">{v}</span>
      <span className="twoway-stat-k">{k}</span>
    </div>
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
