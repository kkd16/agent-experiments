import { useMemo, useState } from 'react';
import type { Compiled } from '../engine/compile';
import { buildDerivDFA, derivativeChain, fromAst } from '../engine/derivatives';
import { minimizeDFA } from '../engine/minimize';
import { dfaToGraph } from '../engine/graphdata';
import { layoutGraph } from '../engine/layout';
import { toDot, toSvg } from '../engine/export';
import { AutomatonGraph } from './AutomatonGraph';

const ACCENT = '#c084fc';

export function DerivativesPanel({ compiled, text }: { compiled: Compiled; text: string }) {
  const { ast, features } = compiled;

  const data = useMemo(() => {
    if (!ast || !features?.regular) return null;
    const d = fromAst(ast);
    const dd = buildDerivDFA(d);
    const min = minimizeDFA(dd);
    return { d, dd, minStates: min.states.length };
  }, [ast, features]);

  const layout = useMemo(() => (data ? layoutGraph(dfaToGraph(data.dd)) : null), [data]);
  const chain = useMemo(() => (data ? derivativeChain(data.d, text) : null), [data, text]);

  if (!ast || !features?.regular || !data || !layout) {
    return (
      <div className="placeholder">
        {compiled.error
          ? 'Fix the pattern first.'
          : 'Brzozowski derivatives are defined for the regular subset — anchors, backreferences and lookaround route to the VM instead.'}
      </div>
    );
  }

  const subsetStates = compiled.dfa?.states.length ?? 0;
  const derivStates = data.dd.states.length;

  return (
    <div className="deriv-panel">
      <div className="pane-head">
        <h2>Brzozowski derivatives — a second road to the DFA</h2>
        <p>
          The derivative of a language by a character <code>c</code> is the set of suffixes that complete a match after{' '}
          <code>c</code>. Derivatives of a <em>regex</em> are again regexes, so deriving once per character and asking
          whether the residual is <em>nullable</em> matches the string — and treating each distinct residual as a state
          builds a DFA <strong>straight from the regex</strong>, with no NFA in between.
        </p>
      </div>

      <div className="deriv-roads">
        <div className="deriv-road">
          <span className="deriv-road-n">{subsetStates}</span>
          <span className="deriv-road-l">subset-construction DFA</span>
        </div>
        <span className="deriv-arrow">vs</span>
        <div className="deriv-road">
          <span className="deriv-road-n">{derivStates}</span>
          <span className="deriv-road-l">derivative DFA</span>
        </div>
        <span className="deriv-arrow">→</span>
        <div className="deriv-road accent">
          <span className="deriv-road-n">{data.minStates}</span>
          <span className="deriv-road-l">both minimise to</span>
        </div>
      </div>
      <p className="muted-note deriv-note">
        Two independent constructions, often different sizes before minimisation, collapsing to the <em>same</em> minimal
        machine — a tidy proof they recognise the same language.
        {data.dd.truncated && ' (derivative search hit its state cap on this pattern.)'}
      </p>

      <GraphCard layout={layout} dd={data.dd} />

      <h3 className="deriv-h3">Derivative chain on the test text</h3>
      <p className="muted-note">
        Each step shows the residual expression after consuming one more character. The string is accepted iff the final
        residual is nullable (matches ε). A dead residual <code>∅</code> rejects immediately.
      </p>
      <div className="deriv-chain">
        {chain!.steps.map((s, i) => (
          <div key={i} className={`deriv-step${s.dead ? ' dead' : ''}${i === chain!.steps.length - 1 ? ' last' : ''}`}>
            <div className="deriv-step-head">
              <span className="deriv-step-char">{s.char === null ? 'start' : s.char === ' ' ? '␣' : s.char}</span>
              {s.nullable && <span className="deriv-badge nullable">nullable</span>}
              {s.dead && <span className="deriv-badge dead">dead ∅</span>}
            </div>
            <code className="deriv-expr">{s.expr}</code>
          </div>
        ))}
      </div>
      <div className={`deriv-final ${chain!.accepted ? 'ok' : 'no'}`}>
        {chain!.accepted ? 'accepted — final residual is nullable ✓' : 'rejected — final residual is not nullable'}
      </div>
    </div>
  );
}

function GraphCard({ layout, dd }: { layout: ReturnType<typeof layoutGraph>; dd: ReturnType<typeof buildDerivDFA> }) {
  const [copied, setCopied] = useState(false);
  const copyDot = () => {
    try {
      navigator.clipboard?.writeText(toDot(dfaToGraph(dd), 'derivative_DFA'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked (sandbox) — ignore */
    }
  };
  const downloadSvg = () => {
    try {
      const svg = toSvg(layout, { accent: ACCENT });
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'derivative-dfa.svg';
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
          <h2>Derivative DFA</h2>
          <p>Each state is a distinct residual expression; the start state is the whole pattern.</p>
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
