import { useMemo, useState } from 'react';
import type { Compiled } from '../engine/compile';
import { toCodePoints } from '../engine/simulate';
import { AutomatonGraph } from './AutomatonGraph';
import { layoutGraph } from '../engine/layout';
import {
  astToTDFA,
  runTDFA,
  simulateTagged,
  tdfaGraph,
  registerRoles,
  slotLabel,
  formatRegOp,
  quickCheckPattern,
  runVerify,
  DEFAULT_VERIFY,
  TdfaUnsupported,
  type TDFA,
  type VerifyReport,
} from '../engine/tags';
import { compileProgram } from '../engine/pike';

interface Props {
  compiled: Compiled;
  text: string;
  onTextChange: (t: string) => void;
}

const GRAPH_CAP = 48; // states beyond this: skip the drawing, keep the stepper
const ACCENT = '#22d3ee';

export function TaggedPanel({ compiled, text, onTextChange }: Props) {
  const { ast, groupCount, features, error } = compiled;

  const built = useMemo(() => {
    if (!ast || error) return null;
    if (features && !features.regular) return { kind: 'scope' as const, reasons: features.reasons };
    try {
      const tdfa = astToTDFA(ast, groupCount, { maxStates: 4000 });
      return { kind: 'ok' as const, tdfa };
    } catch (e) {
      if (e instanceof TdfaUnsupported) return { kind: 'scope' as const, reasons: [e.message] };
      throw e;
    }
  }, [ast, error, features, groupCount]);

  const check = useMemo(() => {
    if (!ast || built?.kind !== 'ok') return null;
    return quickCheckPattern(ast, groupCount);
  }, [ast, groupCount, built]);

  const codes = useMemo(() => toCodePoints(text), [text]);

  const run = useMemo(() => (built?.kind === 'ok' ? runTDFA(built.tdfa, codes) : null), [built, codes]);

  // Per-step register-file snapshots (replayed from the run's ops).
  const snapshots = useMemo(() => {
    if (!built || built.kind !== 'ok' || !run) return [];
    const rf = new Int32Array(built.tdfa.regCount).fill(-1);
    const out: Int32Array[] = [];
    for (const st of run.steps) {
      for (const op of st.ops) {
        if (op.kind === 'set') rf[op.reg] = st.pos;
        else rf[op.dst] = rf[op.src];
      }
      out.push(rf.slice());
    }
    return out;
  }, [built, run]);

  const [stepIdx, setStepIdx] = useState(0);
  const maxStep = Math.max(0, (run?.steps.length ?? 1) - 1);
  const idx = Math.min(stepIdx, maxStep);

  if (!ast || error) {
    return <div className="placeholder">Fix the pattern to build the tagged DFA.</div>;
  }
  if (built?.kind === 'scope') {
    return (
      <div className="tdfa-panel">
        <div className="pike-unsupported">
          <strong>The tagged DFA covers the strictly-regular fragment.</strong>
          <p>This pattern uses: {built.reasons.join(', ')}.</p>
          <p className="muted-note">
            The TDFA is a <em>deterministic</em> automaton driven purely by the input alphabet, so it inherits the same
            frontier as the ordinary DFA road: anchors and word boundaries are position-dependent, and backreferences /
            lookaround leave the regular languages. Those keep their captures on the backtracking VM. Everything the
            DFA/Pike pipeline can represent, the TDFA can capture — deterministically, one edge per character.
          </p>
        </div>
      </div>
    );
  }
  if (!built || built.kind !== 'ok' || !run) {
    return <div className="placeholder">Compiling…</div>;
  }

  const tdfa = built.tdfa;
  const step = run.steps[idx];
  const regFile = snapshots[idx] ?? new Int32Array(tdfa.regCount).fill(-1);
  const currentState = step.toState;
  const writtenRegs = new Set<number>();
  for (const op of step.ops) writtenRegs.add(op.kind === 'set' ? op.reg : op.dst);

  return (
    <div className="tdfa-panel">
      <div className="pane-head">
        <div>
          <h2>Tagged DFA — captures without backtracking</h2>
          <p>
            The Pike bytecode is a <em>tagged NFA</em>: <code>save</code> is a tag, <code>split</code> is priority. We
            determinise it once into a machine that reads one character, follows one edge, and runs a few{' '}
            <strong>register operations</strong> — no threads, no slot-array copies. This is the construction behind
            re2c and Laurikari's thesis; the registers are filled in at run time by executing the ops along the path.
          </p>
        </div>
      </div>

      <div className="tdfa-stats">
        <Stat label="states" value={String(tdfa.states.length)} />
        <Stat label="registers" value={String(tdfa.regCount)} />
        <Stat label="input classes" value={String(tdfa.atoms.length)} />
        <Stat label="capture slots" value={String(tdfa.slotCount)} />
        {check?.ran && (
          <span className={`chip ${check.agreed ? 'chip-yes' : 'chip-no'}`} title="differential check vs the reference thread-list simulator">
            {check.agreed ? `≡ reference · ${check.checks} inputs ✓` : 'mismatch!'}
          </span>
        )}
        {tdfa.truncated && <span className="chip chip-no">truncated — pattern too large</span>}
      </div>

      {/* --- The machine --- */}
      {tdfa.states.length <= GRAPH_CAP ? (
        <div className="tdfa-graph">
          <AutomatonGraph
            layout={layoutGraph(tdfaGraph(tdfa))}
            accent={ACCENT}
            highlight={new Set([currentState])}
            incoming={idx > 0 ? new Set([step.fromState]) : undefined}
            emptyHint="empty machine"
          />
        </div>
      ) : (
        <p className="muted-note">
          {tdfa.states.length} states — too many to draw legibly; the stepper below still runs the machine.
        </p>
      )}

      {/* --- Test input + live capture highlight --- */}
      <textarea
        className="test-input"
        value={text}
        onChange={(e) => {
          onTextChange(e.target.value);
          setStepIdx(0);
        }}
        spellCheck={false}
        rows={2}
        placeholder="Type a whole string to run through the machine…"
      />

      <TextTape codes={codes} cursor={step.pos} match={run.match} groupCount={groupCount} deadAt={run.deadAt} />

      {/* --- Stepper controls --- */}
      <div className="step-controls">
        <button onClick={() => setStepIdx(0)} disabled={idx === 0} title="Reset">⏮</button>
        <button onClick={() => setStepIdx(Math.max(0, idx - 1))} disabled={idx === 0} title="Back">◀</button>
        <input
          type="range"
          min={0}
          max={maxStep}
          value={idx}
          onChange={(e) => setStepIdx(Number(e.target.value))}
          className="step-range"
        />
        <button onClick={() => setStepIdx(Math.min(maxStep, idx + 1))} disabled={idx === maxStep} title="Forward">▶</button>
        <span className="step-caption">
          {idx === 0 ? (
            <>
              start · pos 0 · <code>state s{currentState}</code>
            </>
          ) : (
            <>
              read <code>{glyph(step.code)}</code> → pos {step.pos} · <code>s{step.fromState}→s{step.toState}</code>
            </>
          )}
        </span>
      </div>

      {/* --- Ops executed this step + live register file --- */}
      <div className="tdfa-lower">
        <div className="op-box">
          <div className="op-box-head">register ops this step</div>
          {step.ops.length === 0 ? (
            <p className="muted-note">— none (registers unchanged) —</p>
          ) : (
            <div className="op-list">
              {step.ops.map((op, i) => (
                <span key={i} className={`op-chip ${op.kind === 'set' ? 'op-set' : 'op-copy'}`}>
                  {formatRegOp(op)}
                </span>
              ))}
            </div>
          )}
          {idx === 0 && <p className="muted-note">These initial ops run once before any character is read.</p>}
        </div>

        <RegisterFile tdfa={tdfa} state={currentState} regFile={regFile} written={writtenRegs} />
      </div>

      {/* --- Whole-string capture result --- */}
      <CaptureResult tdfa={tdfa} codes={codes} run={run} groupCount={groupCount} text={text} />

      {/* --- Cross-engine agreement --- */}
      <Agreement compiled={compiled} codes={codes} run={run} />

      {/* --- The verifier --- */}
      <Verifier />

      <p className="muted-note">
        Semantics note: this machine implements the studio's <strong>Thompson / Pike leftmost-greedy</strong> capture
        rule — the same one the Pike VM uses. That deliberately differs from ECMAScript on two points (a group captured
        by an empty iteration; a loop body's inner groups being cleared each iteration), which is why the verifier only
        cross-checks against JS <code>RegExp</code> where the two conventions provably coincide.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="tdfa-stat">
      <span className="tdfa-stat-val">{value}</span>
      <span className="tdfa-stat-label">{label}</span>
    </div>
  );
}

function glyph(code: number | null): string {
  if (code === null) return '∅';
  if (code === 10) return '↵';
  if (code === 32) return '␣';
  return String.fromCodePoint(code);
}

// The input tape: consumed vs remaining, a cursor, and per-group capture colours
// once the whole string matches.
function TextTape({
  codes,
  cursor,
  match,
  groupCount,
  deadAt,
}: {
  codes: number[];
  cursor: number;
  match: { groups: ({ start: number; end: number } | null)[] } | null;
  groupCount: number;
  deadAt: number | null;
}) {
  const capOf = new Int32Array(codes.length).fill(-1);
  if (match) {
    for (let g = 1; g <= groupCount; g++) {
      const s = match.groups[g];
      if (!s) continue;
      for (let i = s.start; i < s.end && i < capOf.length; i++) capOf[i] = g;
    }
  }
  return (
    <div className="tdfa-tape" aria-hidden>
      {codes.length === 0 ? (
        <span className="hl-placeholder">empty input — matches iff the pattern is nullable</span>
      ) : (
        codes.map((c, i) => {
          const g = capOf[i];
          const consumed = i < cursor;
          const dead = deadAt !== null && i >= deadAt;
          return (
            <span
              key={i}
              className={`tape-cell${consumed ? ' tape-consumed' : ''}${dead ? ' tape-dead' : ''}${g >= 0 ? ` tape-cap hue-${(g - 1) % 6}` : ''}`}
            >
              {glyph(c)}
            </span>
          );
        })
      )}
      <span className="tape-caret" style={{ order: cursor }} />
    </div>
  );
}

function RegisterFile({ tdfa, state, regFile, written }: { tdfa: TDFA; state: number; regFile: Int32Array; written: Set<number> }) {
  const roles = registerRoles(tdfa.states[state], tdfa.slotCount);
  // Only show registers that the current state actually uses (keeps it compact).
  const used = [...roles.keys()].sort((a, b) => a - b);
  return (
    <div className="op-box">
      <div className="op-box-head">
        live registers · <code>state s{state}</code>
      </div>
      {used.length === 0 ? (
        <p className="muted-note">— no live capture registers here —</p>
      ) : (
        <div className="reg-file">
          {used.map((r) => {
            const slots = [...(roles.get(r) ?? [])].sort((a, b) => a - b);
            const val = regFile[r];
            return (
              <div key={r} className={`reg-cell${written.has(r) ? ' reg-hot' : ''}`}>
                <span className="reg-id">r{r}</span>
                <span className="reg-val">{val < 0 ? '·' : val}</span>
                <span className="reg-role">{slots.map(slotLabel).join(', ')}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CaptureResult({
  tdfa,
  codes,
  run,
  groupCount,
  text,
}: {
  tdfa: TDFA;
  codes: number[];
  run: ReturnType<typeof runTDFA>;
  groupCount: number;
  text: string;
}) {
  void tdfa;
  const chars = Array.from(text);
  const slice = (a: number, b: number) => chars.slice(a, b).join('') || '∅';
  const m = run.match;
  return (
    <div className="tdfa-result">
      <div className="verdict-row">
        <span className={`chip ${m ? 'chip-yes' : 'chip-no'}`}>{m ? 'whole-string match ✓' : 'no whole-string match'}</span>
        <span className="chip chip-muted">{codes.length} code points</span>
        {groupCount > 0 && <span className="chip chip-muted">{groupCount} group{groupCount === 1 ? '' : 's'}</span>}
      </div>
      {m && (
        <div className="capture-table">
          <table>
            <thead>
              <tr>
                <th>slot</th>
                <th>span</th>
                <th>text</th>
              </tr>
            </thead>
            <tbody>
              {m.groups.map((g, gi) => (
                <tr key={gi}>
                  <td>{gi === 0 ? <strong>whole match</strong> : <span className={`cap-swatch hue-${(gi - 1) % 6}`}>group {gi}</span>}</td>
                  <td><code>{g ? `[${g.start}, ${g.end})` : '—'}</code></td>
                  <td>{g ? <code>{slice(g.start, g.end)}</code> : <span className="cap-none">did not participate</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Show the TDFA capture beside the reference thread-list simulator: they must
// agree on every input, always. (The JS oracle diverges on empty-iteration
// semantics, so it is left to the verifier's safe subset.)
function Agreement({ compiled, codes, run }: { compiled: Compiled; codes: number[]; run: ReturnType<typeof runTDFA> }) {
  const { ast, groupCount } = compiled;
  const ref = useMemo(() => {
    if (!ast) return null;
    try {
      const prog = compileProgram(ast, groupCount);
      return simulateTagged(prog, groupCount, codes);
    } catch {
      return null;
    }
  }, [ast, groupCount, codes]);

  const fmt = (g: ({ start: number; end: number } | null)[] | undefined) =>
    !g ? 'no match' : g.map((s) => (s ? `[${s.start},${s.end})` : '∅')).join(' ');
  const agree = fmt(run.match?.groups) === fmt(ref?.groups);
  return (
    <div className="engine-bar engine-bar-3">
      <div className="engine-stat engine-good">
        <span className="engine-name">Tagged DFA · one edge / char</span>
        <span className="engine-val">{fmt(run.match?.groups)}</span>
      </div>
      <div className="engine-stat">
        <span className="engine-name">reference · thread list</span>
        <span className="engine-val">{fmt(ref?.groups)}</span>
      </div>
      <div className={`engine-stat ${agree ? 'engine-good' : 'engine-hot'}`}>
        <span className="engine-name">agree?</span>
        <span className="engine-val">{agree ? 'identical ✓' : 'DIVERGED'}</span>
      </div>
    </div>
  );
}

function Verifier() {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [running, setRunning] = useState(false);
  const runIt = () => {
    setRunning(true);
    // Defer so the button paints its busy state before the (synchronous) run.
    setTimeout(() => {
      setReport(runVerify(DEFAULT_VERIFY));
      setRunning(false);
    }, 10);
  };
  return (
    <div className="tdfa-verify">
      <div className="op-box-head">Differential verification</div>
      <p className="muted-note">
        Draw {DEFAULT_VERIFY.trials} random capturing patterns × {DEFAULT_VERIFY.stringsPerPattern} inputs from a seeded
        PRNG, and check the TDFA against the reference simulator on every one — plus JS <code>RegExp</code> where the
        semantics coincide. The determinisation theorem, earned rather than asserted.
      </p>
      <button className="verify-btn" onClick={runIt} disabled={running}>
        {running ? 'running…' : 'Run verification'}
      </button>
      {report && (
        <div className={`verify-report ${report.agreed ? 'ok' : 'bad'}`}>
          {report.agreed ? (
            <p>
              ✓ all three engines agreed — <strong>{report.checks.toLocaleString()}</strong> checks over{' '}
              <strong>{report.patterns}</strong> patterns (largest TDFA {report.maxStates} states) in {report.elapsedMs} ms.
            </p>
          ) : (
            <>
              <p>✗ counterexample ({report.counterexample?.which}):</p>
              <pre className="verify-cx">
                {`/${report.counterexample?.pattern}/  on  ${JSON.stringify(report.counterexample?.input)}
  tdfa      ${JSON.stringify(report.counterexample?.tdfa)}
  reference ${JSON.stringify(report.counterexample?.reference)}
  oracle    ${JSON.stringify(report.counterexample?.oracle)}`}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
