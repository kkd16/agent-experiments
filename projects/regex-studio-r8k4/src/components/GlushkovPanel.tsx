import { useMemo, useState } from 'react';
import type { Compiled } from '../engine/compile';
import { fromAst } from '../engine/derivatives';
import { buildAntimirovNFA } from '../engine/antimirov';
import {
  buildGlushkov,
  buildGlushkovDFA,
  followTable,
  positionChain,
  positionToGraph,
  thompsonSize,
  GlushkovTooBig,
  type PositionAutomaton,
} from '../engine/glushkov';
import { minimizeDFA } from '../engine/minimize';
import { compareDFAs } from '../engine/equivalence';
import { layoutGraph } from '../engine/layout';
import { toDot, toSvg } from '../engine/export';
import { AutomatonGraph } from './AutomatonGraph';

const ACCENT = '#22d3ee';

export function GlushkovPanel({ compiled, text }: { compiled: Compiled; text: string }) {
  const { ast, features } = compiled;

  const data = useMemo(() => {
    if (!ast || !features?.regular) return null;
    let pa: PositionAutomaton;
    try {
      pa = buildGlushkov(ast);
    } catch (e) {
      if (e instanceof GlushkovTooBig) return { tooBig: true } as const;
      throw e;
    }
    const thompson = thompsonSize(ast);
    // Antimirov state count, for the ε-free size comparison. (Built on the
    // canonical derivative algebra, which desugars + and ? differently, so the
    // counts aren't a strict ≤ — see the note below.)
    const antiNfa = buildAntimirovNFA(fromAst(ast));
    const antimirov = antiNfa.truncated ? null : antiNfa.states.length;
    // The fourth road, verified: determinise the position automaton, minimise it,
    // and confirm it is the *same* canonical machine the other three roads reach.
    let canonical: 'equal' | 'other' | 'na' = 'na';
    if (compiled.minDfa) {
      const min = minimizeDFA(buildGlushkovDFA(pa));
      canonical = compareDFAs(min, compiled.minDfa).relation === 'equal' ? 'equal' : 'other';
    }
    return { tooBig: false as const, pa, thompson, antimirov, canonical };
  }, [ast, features, compiled.minDfa]);

  const layout = useMemo(() => (data && !data.tooBig ? layoutGraph(positionToGraph(data.pa)) : null), [data]);
  const chain = useMemo(() => (data && !data.tooBig ? positionChain(data.pa, text) : null), [data, text]);

  if (!ast || !features?.regular || !data) {
    return (
      <div className="placeholder">
        {compiled.error
          ? 'Fix the pattern first.'
          : "Glushkov's construction is defined for the regular subset — anchors, backreferences and lookaround route to the VM instead."}
      </div>
    );
  }
  if (data.tooBig || !layout) {
    return <div className="placeholder">This pattern linearises to too many positions for the position automaton.</div>;
  }

  const { pa, thompson, antimirov } = data;
  const rows = followTable(pa);
  const shrink = thompson.states > 0 ? (1 - (pa.m + 1) / thompson.states) * 100 : 0;

  return (
    <div className="deriv-panel">
      <div className="pane-head">
        <h2>Glushkov's construction — the position automaton, ε-free and exactly m+1 states</h2>
        <p>
          Give every <em>letter occurrence</em> in the pattern a position <code>1…m</code>, then read four functions
          straight off the syntax tree: <strong>nullable</strong>, <strong>first</strong>, <strong>last</strong> and{' '}
          <strong>follow</strong>. The automaton falls out mechanically — start → every first; <code>p</code> → every{' '}
          <code>q ∈ follow(p)</code>; accept at every <strong>last</strong>. No ε-transitions, and exactly one state per
          letter plus a start state.
        </p>
      </div>

      <div className="deriv-roads">
        <div className="deriv-road">
          <span className="deriv-road-n">{thompson.states}</span>
          <span className="deriv-road-l">Thompson ε-NFA states</span>
          <span className="anti-sub">{thompson.epsilon} ε-edges</span>
        </div>
        <span className="deriv-arrow">→</span>
        <div className="deriv-road accent">
          <span className="deriv-road-n">{pa.m + 1}</span>
          <span className="deriv-road-l">position-automaton states</span>
          <span className="anti-sub">0 ε-edges · m={pa.m} letters + 1</span>
        </div>
        {antimirov !== null && (
          <>
            <span className="deriv-arrow">→</span>
            <div className="deriv-road">
              <span className="deriv-road-n">{antimirov}</span>
              <span className="deriv-road-l">Antimirov (quotient)</span>
              <span className="anti-sub">equation automaton</span>
            </div>
          </>
        )}
      </div>
      <p className="muted-note deriv-note">
        The position automaton is the ε-free middle of the studio's size story: Thompson spends ~two states and a
        handful of ε-edges per operator; Glushkov collapses that to exactly <strong>{pa.m + 1}</strong> states (one per
        letter, plus the start), no ε. Antimirov's equation automaton is then a <em>quotient</em> of this machine —
        merging positions with identical futures. {pa.homogeneous && (
          <>
            And it is <strong className="anti-ok">homogeneous ✓</strong> — every edge entering a state carries that
            state's character class.
          </>
        )}
        {data.canonical === 'equal' && (
          <>
            {' '}
            Determinising <em>this</em> NFA, then minimising, lands on the exact same canonical machine the other three
            roads reach — <strong className="anti-ok">verified equal ✓</strong>.{' '}
            <strong>Four roads, one minimal automaton.</strong>
          </>
        )}
        {shrink > 0 && <> ({Math.round(shrink)}% fewer states than Thompson, with zero ε-edges.)</>}
      </p>

      <GraphCard layout={layout} pa={pa} />

      <h3 className="deriv-h3">first · last · follow</h3>
      <p className="muted-note">
        The whole automaton is encoded by these tables. <span className="gk-tag gk-first">first</span> positions get an
        edge from the start; each row's <span className="gk-tag gk-follow">follow</span> set gives its out-edges;{' '}
        <span className="gk-tag gk-last">last</span> positions are accepting
        {pa.nullableStart && <> (and the start itself accepts, since the pattern is nullable)</>}.
      </p>
      <div className="gk-tablewrap">
        <table className="gk-table">
          <thead>
            <tr>
              <th>pos</th>
              <th>class</th>
              <th>role</th>
              <th>follow →</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.pos}>
                <td className="gk-pos">{row.pos}</td>
                <td className="gk-class">{row.label}</td>
                <td>
                  {row.isFirst && <span className="gk-tag gk-first">first</span>}
                  {row.isLast && <span className="gk-tag gk-last">last</span>}
                  {!row.isFirst && !row.isLast && <span className="gk-tag gk-mid">·</span>}
                </td>
                <td className="gk-follow-cell">
                  {row.follow.length === 0 ? (
                    <span className="gk-empty">∅</span>
                  ) : (
                    row.follow.map((q) => (
                      <span key={q} className="gk-follow-pos">
                        {q}
                      </span>
                    ))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="deriv-h3">Position-set chain on the test text</h3>
      <p className="muted-note">
        The Brzozowski chain carries one residual; the Antimirov chain carries a set of terms. Glushkov carries the set
        of live <em>positions</em> — literally the position automaton's active states as it reads the input. Accept iff
        a live position is a <strong>last</strong> when the input runs out.
      </p>
      <div className="deriv-chain">
        {chain!.steps.map((s, i) => (
          <div key={i} className={`deriv-step${s.dead ? ' dead' : ''}${i === chain!.steps.length - 1 ? ' last' : ''}`}>
            <div className="deriv-step-head">
              <span className="deriv-step-char gk-char">{s.char === null ? 'start' : s.char === ' ' ? '␣' : s.char}</span>
              {s.accept && <span className="deriv-badge nullable">accepting</span>}
              {s.dead && <span className="deriv-badge dead">dead ∅</span>}
            </div>
            {s.dead ? (
              <code className="deriv-expr">∅</code>
            ) : (
              <div className="anti-set">
                <span className="anti-brace">{'{'}</span>
                {s.active.map((p) => (
                  <code key={p} className={`gk-active${pa.last.has(p) ? ' acc' : ''}`}>
                    {p === 0 ? 'ι' : p}
                  </code>
                ))}
                <span className="anti-brace">{'}'}</span>
                <span className="anti-count">{s.active.length} live</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className={`deriv-final ${chain!.accepted ? 'ok' : 'no'}`}>
        {chain!.accepted
          ? 'accepted — a live position is a last ✓'
          : 'rejected — no live position is a last when the input ends'}
      </div>
    </div>
  );
}

function GraphCard({ layout, pa }: { layout: ReturnType<typeof layoutGraph>; pa: PositionAutomaton }) {
  const [copied, setCopied] = useState(false);
  const copyDot = () => {
    try {
      navigator.clipboard?.writeText(toDot(positionToGraph(pa), 'position_automaton'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked (sandbox) — ignore */
    }
  };
  const downloadSvg = () => {
    try {
      const blob = new Blob([toSvg(layout, { accent: ACCENT })], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'position-automaton.svg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      /* sandbox / download blocked — ignore */
    }
  };
  return (
    <div className="graph-pane">
      <div className="pane-head graph-head">
        <div>
          <h2>Position automaton (Glushkov NFA)</h2>
          <p>
            State <code>ι</code> is the start; states <code>1…{pa.m}</code> are the linearised letter positions.
            Double-circled states are accepting (the <strong>last</strong> set). Every edge consumes a character — no
            ε-transitions.
          </p>
        </div>
        <div className="graph-head-btns">
          <button className="dot-btn" onClick={downloadSvg} title="Download this automaton as a standalone SVG">
            download SVG
          </button>
          <button className="dot-btn" onClick={copyDot} title="Copy this automaton as Graphviz DOT">
            {copied ? 'copied ✓' : 'copy DOT'}
          </button>
        </div>
      </div>
      <AutomatonGraph layout={layout} accent={ACCENT} />
    </div>
  );
}
